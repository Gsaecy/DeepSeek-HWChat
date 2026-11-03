import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ToolExecutor, type ToolApprovalRequest, type ToolExecutionScope } from '../agent/toolExecutor';
import { AuditLog } from '../agent/auditLog';
import { ChatSettings, PermissionPreset, ToolCall, ToolExecutionResult } from '../core/types';
import { PERMISSION_PRESET_PROFILES } from '../core/permissions';
import { setWorkspaceRoots } from './support/vscodeMock';

/**
 * git 闸门的端到端用例。
 *
 * 真实故障（2026-11-03，用户原话：「hwchat是不是会拦截拉去克隆仓库到本地，
 * 现在即使弹窗点击确认了，还是运行拉取失败」，随后要求「请放开git权限，
 * 不要影响git正常功能」）：
 *
 * 1. 中文「克隆」不在授权词表里（只有英文 `clone`），所以 `git clone` 被
 *    「本次对话中用户没有要求 git 写操作」拒绝 —— 而这道闸门是在**用户点了
 *    确认之后**才执行的，于是「点了确认还是失败」。
 * 2. `clone` / `init` 还要过「上一级没有 git 仓库」「项目根没绑定」两道检查，
 *    而这两条对「创建一个新仓库」本身自相矛盾。
 *
 * 这些用真实 git 仓库跑，因为只有「命令真的执行了」才算放开。
 */

const execFileAsync = promisify(execFile);

let base: string;
let repo: string;
let origin: string;
let executor: ToolExecutor;

function settings(preset: PermissionPreset): ChatSettings {
  const profile = PERMISSION_PRESET_PROFILES[preset];
  return {
    internetReference: false,
    apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid/v1', models: ['deepseek-chat'], requestHeaders: {} }],
    activeApiProfileId: 'default',
    baseUrl: 'https://example.invalid/v1',
    model: 'deepseek-chat',
    temperature: 0,
    maxTokens: 0,
    systemPrompt: '',
    sendOnEnter: true,
    historyRetentionDays: 30,
    taskCacheRetentionHours: 24,
    cacheBudgetMB: 100,
    cleanupIntervalMinutes: 10,
    maxMessagesInContext: 20,
    requestHeaders: {},
    requestTimeoutSeconds: 30, proxy: '',
    defaultMode: 'agent',
    agentMaxSteps: 0,
    reasoningEffort: 'default',
    permissionPreset: preset,
    maxReadBytes: 512_000,
    maxToolOutputBytes: 200_000,
    maxCommandSeconds: 60,
    auditRetentionDays: 30,
    language: 'auto',
    ...profile,
  } as ChatSettings;
}

function call(command: string, cwd?: string): ToolCall {
  return {
    id: `call-${Math.random().toString(36).slice(2)}`,
    type: 'function',
    function: {
      name: 'run_command',
      arguments: JSON.stringify(cwd ? { command, cwd } : { command }),
    },
  };
}

async function run(
  command: string,
  options: { preset?: PermissionPreset; approve?: boolean; scope?: ToolExecutionScope; cwd?: string } = {},
): Promise<{ result: ToolExecutionResult; approvals: ToolApprovalRequest[] }> {
  const approvals: ToolApprovalRequest[] = [];
  const result = await executor.execute(
    call(command, options.cwd),
    'agent',
    settings(options.preset ?? 'autopilot'),
    async (request) => {
      approvals.push(request);
      return options.approve ?? true;
    },
    'conv-1',
    options.scope,
  );
  return { result, approvals };
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'hwchat-gitgate-'));
  repo = join(base, 'Demo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'README.md'), '# demo\n', 'utf8');
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await execFileAsync('git', ['add', '-A'], { cwd: repo });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  // 本地 bare 仓库当「远端」：克隆全程离线，测试不依赖网络。
  origin = join(repo, 'origin.git');
  await execFileAsync('git', ['clone', '-q', '--bare', repo, origin]);
  setWorkspaceRoots([repo]);
  executor = new ToolExecutor(new AuditLog(join(base, 'audit.jsonl')), () => true);
});

after(async () => {
  setWorkspaceRoots([]);
  await rm(base, { recursive: true, force: true });
});

test('git clone：用户没开口、也没有确认卡片，照样能克隆（review 预设自动执行）', async () => {
  const target = join(repo, 'cloned');
  // 用相对路径：绝对路径必须落在工作区内，而路径隔离对工作区外是硬边界（不该放松）。
  const { result, approvals } = await run('git clone origin.git cloned', {
    preset: 'review',
    scope: { gitWriteAllowed: false },
  });
  assert.equal(approvals.length, 0, 'review 预设不该弹窗');
  assert.ok(existsSync(join(target, '.git')), `克隆应真的落盘；实际输出：${result.content}`);
  assert.notEqual(result.status, 'denied', result.content);
});

test('git init：在普通目录里初始化新仓库不被「上一级没有仓库」拦住', async () => {
  const fresh = join(base, 'Fresh');
  await mkdir(fresh, { recursive: true });
  setWorkspaceRoots([repo, fresh]);
  const { result } = await run('git init', {
    preset: 'review',
    scope: { gitWriteAllowed: false, projectRoot: fresh },
  });
  assert.ok(existsSync(join(fresh, '.git')), `git init 应真的落盘；实际输出：${result.content}`);
});

test('git commit：用户点了确认就不再被「没有要求 git 写操作」否决', async () => {
  // 关键回归：确认卡片在闸门之前，旧实现里点确认也白点。
  const { result, approvals } = await run('git commit --allow-empty -m "approved by user"', {
    preset: 'askAll',
    approve: true,
    scope: { gitWriteAllowed: false, projectRoot: repo },
  });
  assert.equal(approvals.length, 1, 'askAll 必须先弹一次确认');
  assert.notEqual(result.status, 'denied', `点了确认不该被拒：${result.content}`);
  assert.ok(!/没有要求提交或推送|did not ask/i.test(result.content), result.content);
});

test('git commit：用户拒绝确认时仍然不执行', async () => {
  const before = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })).stdout.trim();
  const { result } = await run('git commit --allow-empty -m "should not run"', {
    preset: 'askAll',
    approve: false,
    scope: { gitWriteAllowed: false, projectRoot: repo },
  });
  const after = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })).stdout.trim();
  assert.equal(result.status, 'denied');
  assert.equal(after, before, '拒绝确认后不应产生新提交');
});

test('git commit：自动执行（无人确认）且用户没要求时仍然拒绝', async () => {
  const before = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })).stdout.trim();
  const { result, approvals } = await run('git commit --allow-empty -m "model decided"', {
    preset: 'review',
    scope: { gitWriteAllowed: false, projectRoot: repo },
  });
  const after = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })).stdout.trim();
  assert.equal(approvals.length, 0, 'review 预设不弹窗');
  assert.equal(result.status, 'denied');
  assert.equal(after, before, '未授权时不应产生新提交');
});

test('git push：用户没要求时仍然拒绝（推送不改初衷）', async () => {
  const { result } = await run('git push origin main', {
    preset: 'autopilot',
    scope: { gitWriteAllowed: false, projectRoot: repo },
  });
  assert.equal(result.status, 'denied');
});

test('单根工作区未绑定项目：git 写操作不再要求先绑项目', async () => {
  setWorkspaceRoots([repo]);
  const { result } = await run('git commit --allow-empty -m "single root"', {
    preset: 'review',
    scope: { gitWriteAllowed: true },
  });
  assert.notEqual(result.status, 'denied', `单根工作区不该要求绑定项目：${result.content}`);
});

test('多根工作区未绑定项目且没有显式 cwd：仍然拒绝，避免提交错项目', async () => {
  const other = join(base, 'Other');
  await mkdir(other, { recursive: true });
  setWorkspaceRoots([repo, other]);
  try {
    const { result } = await run('git commit --allow-empty -m "ambiguous root"', {
      preset: 'review',
      scope: { gitWriteAllowed: true },
    });
    assert.equal(result.status, 'denied');
    assert.match(result.content, /项目|project/i);
  } finally {
    setWorkspaceRoots([repo]);
  }
});
