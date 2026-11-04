/**
 * `run_command` 的后台模式，与「桥接工具调不通」的处理。
 *
 * 现场（用户 2026-11-04）：让 agent「先给我预览一下效果」，它先用桥接工具
 * `run_in_terminal` 起静态服务器 → 返回
 * `Invocation context must be provided for this tool`；接着两次写日志都被路径隔离
 * 拦下 → 凑满 3 轮失败 → 整轮停机，用户看到「经常调用 vs code 工具失败」。
 *
 * 两个真问题：
 *  1. `run_in_terminal` 的实现要求 `toolSpecificData` + `context`，而 `lm.invokeTool`
 *     的公开参数里没有这两项 —— 在 HWChat 里**永远**调不通，不该继续下发；
 *  2. 原生 `run_command` 没有「常驻」概念，静态服务器只能跑满超时。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuditLog } from '../agent/auditLog';
import { isMissingChatContextError, missingChatContextNotice, needsChatContext } from '../agent/bridgedTools';
import { ToolExecutor } from '../agent/toolExecutor';
import { ChatSettings } from '../core/types';
import { setWorkspaceRoots } from './support/vscodeMock';

const settings: ChatSettings = {
  apiProfiles: [{ id: 'default', name: 'T', baseUrl: 'https://example.invalid/v1', models: ['m'], requestHeaders: {} }],
  activeApiProfileId: 'default', baseUrl: 'https://example.invalid/v1', model: 'm',
  temperature: 0, maxTokens: 0, systemPrompt: '', sendOnEnter: true, historyRetentionDays: 30,
  taskCacheRetentionHours: 24, cacheBudgetMB: 100, cleanupIntervalMinutes: 10, maxMessagesInContext: 20,
  requestHeaders: {}, requestTimeoutSeconds: 30, proxy: '', defaultMode: 'agent', agentMaxSteps: 24,
  reasoningEffort: 'default', permissionPreset: 'full', internetReference: false,
  fileReadPolicy: 'allow', fileWritePolicy: 'allow', commandPolicy: 'allow',
  dangerousCommandPolicy: 'allow', sensitiveFilePolicy: 'allow',
  maxReadBytes: 512_000, maxToolOutputBytes: 200_000, maxCommandSeconds: 5, auditRetentionDays: 30, language: 'zh',
};

function makeExecutor(): ToolExecutor {
  return new ToolExecutor(new AuditLog(join(tmpdir(), `hwchat-bg-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)), () => true);
}

function commandCall(command: string, extra: Record<string, unknown> = {}) {
  return {
    id: `call-${Math.random().toString(36).slice(2)}`,
    type: 'function' as const,
    function: { name: 'run_command', arguments: JSON.stringify({ command, cwd: process.cwd(), ...extra }) },
  };
}

/** 这个端口现在能不能连上（拿到 HTTP 200 / 任一响应都算「有人监听」）。 */
function canConnect(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(timeoutMs, () => { request.destroy(); resolve(false); });
  });
}

test('后台模式：起真实静态服务器、立刻返回、端口真的可连、停止后释放', async () => {
  setWorkspaceRoots([process.cwd()]);
  const executor = makeExecutor();
  const port = 18792;
  try {
    const startedAt = Date.now();
    const result = await executor.execute(
      commandCall(`python3 -m http.server ${port} --bind 127.0.0.1`, { background: true }) as never,
      'agent', settings, async () => true, 'conv-bg',
    );
    const elapsed = Date.now() - startedAt;
    assert.equal(result.status, 'success', result.content);
    assert.ok(elapsed < 5_000, `必须立刻返回而不是等命令结束，实测 ${elapsed}ms`);
    assert.match(result.content, /bg-\d+/, '要给出后台 id，模型才能让它停');

    const running = executor.listBackground();
    assert.equal(running.length, 1, '必须登记在册，否则取消/退出时收不掉，会留下占端口的孤儿');
    assert.equal(await canConnect(port), true, '服务器必须真的起来了');

    assert.equal(executor.stopBackground(running[0]!.id), true);
    // 给进程一点时间退出。
    for (let i = 0; i < 20 && await canConnect(port, 400); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(await canConnect(port, 600), false, '停止后端口必须释放');
    assert.deepEqual(executor.listBackground(), []);
  } finally {
    executor.dispose();
  }
});

test('后台模式：命令起不来时把输出带回来，而不是谎报「已启动」', async () => {
  setWorkspaceRoots([process.cwd()]);
  const executor = makeExecutor();
  try {
    // 端口占用是最常见的「起不来」原因：先占一个，再用同一端口起服务器。
    const blocker = http.createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => blocker.listen(18793, '127.0.0.1', () => resolve()));
    try {
      const result = await executor.execute(
        commandCall('python3 -m http.server 18793 --bind 127.0.0.1', { background: true }) as never,
        'agent', settings, async () => true, 'conv-bg-fail',
      );
      assert.equal(result.status, 'error', '起不来就必须报错');
      assert.match(result.content, /Address already in use|already in use|errno/i, `要把真实原因带回来：${result.content}`);
      assert.deepEqual(executor.listBackground(), [], '已经退出的进程不该留在登记表里');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  } finally {
    executor.dispose();
  }
});

test('桥接工具「缺少 chat 调用上下文」是可识别的确定性失败', () => {
  // 这两句是 VS Code Workbench 里 run_in_terminal 的 invoke 真实抛出的。
  assert.equal(isMissingChatContextError('Invocation context must be provided for this tool'), true);
  assert.equal(isMissingChatContextError('toolSpecificData must be provided for this tool'), true);
  for (const other of ['fetch failed', 'EPERM', '用户取消了这次工具调用']) {
    assert.equal(isMissingChatContextError(other), false, `不该误判：${other}`);
  }
});

test('已知调不通的桥接工具不下发；运行期学到的同样不下发', () => {
  assert.equal(needsChatContext('run_in_terminal'), true);
  assert.equal(needsChatContext('copilot_readFile'), false);
  assert.equal(needsChatContext('some_future_tool'), false);
  // 运行期学到的（撞过上下文错误）也要被挡住
  assert.equal(needsChatContext('some_future_tool', new Set(['some_future_tool'])), true);
});

test('给模型的说明必须包含「为什么不行 / 别再试 / 用什么代替」', () => {
  const notice = missingChatContextNotice('run_in_terminal');
  assert.match(notice, /toolSpecificData/, '要说清缺的是上下文');
  assert.match(notice, /不是权限、路径或参数格式的问题/, '否则模型会以为是参数问题去改写法');
  assert.match(notice, /不要重试/);
  assert.match(notice, /run_command/, '必须给出替代方案');
  assert.match(notice, /open_web_preview/);
});
