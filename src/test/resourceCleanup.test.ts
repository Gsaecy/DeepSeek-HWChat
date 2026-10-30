import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive, sleepUntil } from './support/processHelpers';
import { AuditLog } from '../agent/auditLog';
import { CommandQueueFullError, CommandScheduler } from '../agent/commandScheduler';
import { SearchResourceBusyError, SearchScheduler } from '../agent/searchScheduler';
import { ToolExecutor, spawnCommand } from '../agent/toolExecutor';
import {
  OperationCancelledError,
  describeTransientResourceError,
  isTransientResourceError,
  withTransientRetry,
} from '../agent/transientErrors';
import { ChatSettings } from '../core/types';
import { setWorkspaceRoots } from './support/vscodeMock';

/**
 * 资源回收的回归测试。
 *
 * 三条真实故障：取消后命令继续跑满自己的超时；EAGAIN 被当成普通错误立刻重试；
 * 扩展停用后子进程还活着。这里验证的都是「进程真的没了」，不是日志文字。
 */

let workspaceRoot: string;
let auditPath: string;

before(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'hwchat-resource-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  auditPath = join(workspaceRoot, 'audit.jsonl');
  setWorkspaceRoots([workspaceRoot]);
});

after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    internetReference: false,
    apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid', models: ['deepseek-chat'], requestHeaders: {} }],
    activeApiProfileId: 'default', baseUrl: 'https://example.invalid', model: 'deepseek-chat',
    temperature: 0, maxTokens: 0, systemPrompt: '', sendOnEnter: true, historyRetentionDays: 30,
    taskCacheRetentionHours: 24, cacheBudgetMB: 100, cleanupIntervalMinutes: 10, maxMessagesInContext: 20,
    requestHeaders: {}, requestTimeoutSeconds: 30, defaultMode: 'agent', agentMaxSteps: 24,
    reasoningEffort: 'default', permissionPreset: 'review', fileReadPolicy: 'allow',
    fileWritePolicy: 'allow', commandPolicy: 'allow', dangerousCommandPolicy: 'ask',
    sensitiveFilePolicy: 'deny', maxReadBytes: 512_000, maxToolOutputBytes: 200_000,
    maxCommandSeconds: 120, auditRetentionDays: 30, language: 'auto',
    ...overrides,
  };
}

test('spawn: an already-aborted signal never starts a process', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    spawnCommand('echo should-not-run', process.cwd(), 10, 10_000, undefined, { signal: controller.signal }),
    OperationCancelledError,
  );
});

test('spawn: cancelling kills the whole process group and settles promptly', async () => {
  const controller = new AbortController();
  let pid: number | undefined;
  const startedAt = Date.now();
  const pending = spawnCommand('sleep 30', process.cwd(), 60, 10_000, undefined, {
    signal: controller.signal,
    onSpawn: (child) => {
      pid = child.pid;
    },
  });
  await sleepUntil(() => pid !== undefined, 2_000);
  controller.abort();
  const result = await pending;

  assert.equal(result.cancelled, true);
  assert.ok(Date.now() - startedAt < 10_000, '取消必须在秒级结算，不能等满超时');
  assert.ok(pid !== undefined);
  const dead = await sleepUntil(() => !isProcessAlive(pid!), 3_000);
  assert.equal(dead, true, `取消后 shell 进程 ${pid} 仍在运行`);
});

test('commands: concurrency and queue capacity are bounded, and queued work can be cancelled', async () => {
  const scheduler = new CommandScheduler(1, 1);
  let running = 0;
  let peak = 0;
  const started: string[] = [];
  const gate = (() => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  })();

  const first = scheduler.run(undefined, async () => {
    running += 1;
    peak = Math.max(peak, running);
    started.push('first');
    await gate.promise;
    running -= 1;
    return 'first';
  });
  const second = scheduler.run(undefined, async () => {
    started.push('second');
    return 'second';
  });
  await assert.rejects(
    scheduler.run(undefined, async () => 'overflow'),
    CommandQueueFullError,
  );
  assert.equal(scheduler.stats().queued, 1);
  assert.equal(scheduler.stats().rejected, 1);

  gate.release();
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.equal(peak, 1);
  assert.deepEqual(started, ['first', 'second']);
});

test('commands: a queued command cancelled before its turn never runs', async () => {
  const scheduler = new CommandScheduler(1, 4);
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = scheduler.run(undefined, async () => {
    started.push('first');
    await gate;
    return 'first';
  });
  const controller = new AbortController();
  const cancelled = scheduler.run(controller.signal, async () => {
    started.push('never');
    return 'never';
  });
  controller.abort();
  await assert.rejects(cancelled, OperationCancelledError);
  release();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, ['first']);
});

test('tool executor: aborting a running command stops it and reports cancellation', async () => {
  const executor = new ToolExecutor(new AuditLog(auditPath), () => true);
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = executor.execute(
    { id: 'cancel-command', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'sleep 30', timeoutSeconds: 60 }) } },
    'agent',
    settings(),
    async () => true,
    'conversation-cancel',
    { signal: controller.signal, projectRoot: workspaceRoot },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  controller.abort();
  const result = await pending;
  executor.dispose();

  assert.ok(Date.now() - startedAt < 10_000, '取消后必须马上返回');
  assert.match(`${result.summary}${result.content}`, /取消|cancel/i);
});

test('tool executor: dispose kills commands that are still running', async () => {
  const executor = new ToolExecutor(new AuditLog(auditPath), () => true);
  const pending = executor.execute(
    { id: 'dispose-command', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'sleep 30', timeoutSeconds: 60 }) } },
    'agent',
    settings(),
    async () => true,
    'conversation-dispose',
    { projectRoot: workspaceRoot },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const before = executor.resourceStats();
  assert.equal(before.children >= 1, true, '运行中的命令必须被登记，否则停用扩展时无从回收');
  executor.dispose();
  await pending;
});

test('transient errors: only real resource exhaustion is treated as retryable', () => {
  const eagain = new Error('spawn /Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/rg EAGAIN');
  assert.equal(describeTransientResourceError(eagain)?.code, 'EAGAIN');
  assert.equal(isTransientResourceError(eagain), true);

  const coded = new Error('boom') as Error & { code: string };
  coded.code = 'EMFILE';
  assert.equal(describeTransientResourceError(coded)?.code, 'EMFILE');

  assert.equal(isTransientResourceError(new Error('ENOENT: no such file or directory')), false);
  assert.equal(isTransientResourceError(new Error('Invalid glob pattern')), false);
  assert.equal(isTransientResourceError(undefined), false);
});

test('transient retry: bounded attempts, and cancellation wins over retrying', async () => {
  let attempts = 0;
  const error = Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
  await assert.rejects(
    withTransientRetry(async () => {
      attempts += 1;
      throw error;
    }, { delaysMs: [1, 1, 1] }),
    /EAGAIN/,
  );
  assert.equal(attempts, 4, '首次 + 3 次重试');

  const controller = new AbortController();
  let cancelledAttempts = 0;
  await assert.rejects(
    withTransientRetry(async () => {
      cancelledAttempts += 1;
      controller.abort();
      throw error;
    }, { delaysMs: [1, 1, 1], signal: controller.signal }),
    OperationCancelledError,
  );
  assert.equal(cancelledAttempts, 1, '取消之后不得再重试');
});

test('search resource exhaustion surfaces as an actionable error, not an infinite retry', async () => {
  // 直接用调度器验证「错误类型是否正确映射」，避免依赖真实 rg 的进程表状态。
  const scheduler = new SearchScheduler<{ q: string }, string>({
    retryDelaysMs: [1, 1, 1],
    pressureCooldownMs: 0,
    async run() {
      throw Object.assign(new Error('spawn rg EAGAIN'), { code: 'EAGAIN' });
    },
  });
  await assert.rejects(scheduler.run({ q: 'x' }, 'x'), (error: unknown) => {
    assert.ok(error instanceof SearchResourceBusyError);
    assert.equal(error.resourceCode, 'EAGAIN');
    assert.equal(error.attempts, 4);
    return true;
  });
});

/**
 * 「按了停止，后台还在跑」的两个来源，逐条锁死。
 *
 * 旧实现：先 SIGTERM、1 秒后才 SIGKILL，结算还要等 close 或 4.5 秒硬兜底。
 * 于是忽略 SIGTERM 的进程能活 1 秒以上，界面在那段时间里还显示「运行中」。
 */
test('spawn: 取消是立即 SIGKILL，不给忽略 SIGTERM 的进程留活口', async () => {
  const controller = new AbortController();
  let pid: number | undefined;
  // `trap '' TERM` 让 shell 忽略 SIGTERM 并继续 sleep：旧实现下它会活满 1 秒。
  // 用 SIGKILL 才能杀掉它，正好验证「立即 SIGKILL」这条语义。
  const pending = spawnCommand(
    `sh -c 'trap "" TERM; sleep 30'`,
    process.cwd(),
    60,
    10_000,
    undefined,
    { signal: controller.signal, onSpawn: (child) => { pid = child.pid; } },
  );
  await sleepUntil(() => pid !== undefined, 2_000);
  const abortedAt = Date.now();
  controller.abort();
  const result = await pending;
  const settledMs = Date.now() - abortedAt;

  assert.equal(result.cancelled, true);
  assert.ok(settledMs < 500, `取消必须在毫秒级结算，实际 ${settledMs}ms（旧实现要等 close 或 4.5s）`);
  assert.ok(pid !== undefined);
  const dead = await sleepUntil(() => !isProcessAlive(pid!), 1_000, 10);
  assert.equal(dead, true, `忽略 SIGTERM 的进程 ${pid} 必须被立即 SIGKILL`);
});

test('tool executor: 停止某一次运行会同步杀光它拉起的全部进程', async () => {
  const executor = new ToolExecutor(new AuditLog(auditPath), () => true);
  const controller = new AbortController();
  const pending = executor.execute(
    { id: 'kill-run', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'sleep 30', timeoutSeconds: 60 }) } },
    'agent',
    settings({ permissionPreset: 'autopilot' }),
    async () => true,
    'conversation-kill-run',
    { signal: controller.signal, projectRoot: workspaceRoot },
  );
  try {
    const started = await sleepUntil(() => executor.resourceStats().children > 0, 3_000, 10);
    assert.equal(started, true, '命令没有真正拉起进程，测试前提不成立');

    // 这就是「停止」按钮做的事：同步杀，不等任何异步路径。
    const killed = executor.killRunProcesses(controller.signal);
    assert.ok(killed >= 1, '必须同步杀掉这次运行的子进程');
    assert.equal(executor.resourceStats().children, 0, '杀完后不应再有登记的存活子进程');

    controller.abort();
    await pending.catch(() => undefined);
  } finally {
    executor.dispose();
  }
});

test('tool executor: 杀某一次运行不影响另一次运行的进程', async () => {
  const executor = new ToolExecutor(new AuditLog(auditPath), () => true);
  const stopA = new AbortController();
  const keepB = new AbortController();
  const run = (id: string, signal: AbortSignal) => executor.execute(
    { id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'sleep 30', timeoutSeconds: 60 }) } },
    'agent',
    settings({ permissionPreset: 'autopilot' }),
    async () => true,
    `conversation-${id}`,
    { signal, projectRoot: workspaceRoot },
  );
  try {
    const a = run('a', stopA.signal);
    const b = run('b', keepB.signal);
    const both = await sleepUntil(() => executor.resourceStats().children >= 2, 4_000, 10);
    assert.equal(both, true, '两条命令都应拉起进程');

    const killed = executor.killRunProcesses(stopA.signal);
    assert.equal(killed, 1, '只应杀掉 A 的进程');
    assert.equal(executor.resourceStats().children, 1, 'B 的进程必须还在（后台对话不能被连带停掉）');

    stopA.abort();
    keepB.abort();
    await Promise.allSettled([a, b]);
  } finally {
    executor.dispose();
  }
});
