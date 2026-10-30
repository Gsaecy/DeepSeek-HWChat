import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutor, toolAccessError, isResearchTool } from '../agent/toolExecutor';
import { AuditLog } from '../agent/auditLog';
import { ChatSettings, ToolCall } from '../core/types';
import { PERMISSION_PRESET_PROFILES } from '../core/permissions';
import { setWorkspaceRoots } from './support/vscodeMock';

/**
 * 「下发给模型的工具」与「执行时的准入」必须一致。
 *
 * 真实故障（用户实测）：打开「互联网参考」后模型调 `search_web`，收到的却是
 * `工具 search_web 未被允许。` —— `definitions()` 里加了三个联网工具，而
 * `checkAccess()` 里还留着一份手抄的白名单，于是工具**发了出去却永远执行不了**。
 * 更糟的是这种失败长得像「模型乱调工具」，很难想到是白名单漏了。
 *
 * 所以这里不测「某个工具好用」，而是测那条**不变量**：
 * 凡是 `definitions()` 会下发的名字，都必须能通过 `toolAccessError()`。
 * 以后再加工具，忘了加白名单，这条测试会立刻红。
 */

let workspaceRoot: string;
let executor: ToolExecutor;
let settings: ChatSettings;

before(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'hwchat-tool-access-'));
  await mkdir(join(workspaceRoot, 'proj'), { recursive: true });
  setWorkspaceRoots([join(workspaceRoot, 'proj')]);
  executor = new ToolExecutor(new AuditLog(join(workspaceRoot, 'audit.jsonl')), () => true);
  const profile = PERMISSION_PRESET_PROFILES.review;
  settings = {
    internetReference: true,
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
    requestTimeoutSeconds: 30,
    defaultMode: 'agent',
    agentMaxSteps: 0,
    reasoningEffort: 'default',
    permissionPreset: 'review',
    ...profile,
    maxReadBytes: 512_000,
    maxToolOutputBytes: 200_000,
    maxCommandSeconds: 120,
    auditRetentionDays: 30,
    language: 'auto',
  };
});

after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('不变量：凡是下发给模型的工具，都必须能通过执行准入', () => {
  for (const internetReference of [true, false]) {
    const names = executor.definitions('agent', { internetReference }).map((tool) => tool.function.name);
    assert.ok(names.length > 0);
    for (const name of names) {
      const reason = toolAccessError(name, { internetReference });
      assert.equal(
        reason,
        undefined,
        `「${name}」会被下发（internetReference=${internetReference}）却在执行时被拒：${reason}`,
      );
    }
  }
});

test('不变量：联网工具只在开关打开时下发，且打开时三个都在', () => {
  const off = executor.definitions('agent', { internetReference: false }).map((tool) => tool.function.name);
  const on = executor.definitions('agent', { internetReference: true }).map((tool) => tool.function.name);
  for (const name of ['search_github_repos', 'search_web', 'fetch_url']) {
    assert.equal(off.includes(name), false, `${name} 不该在开关关闭时下发`);
    assert.equal(on.includes(name), true, `${name} 必须在开关打开时下发`);
    assert.equal(isResearchTool(name), true);
  }
  // 开关只影响这三个，不能顺手把别的工具也关掉
  assert.equal(on.length, off.length + 3);
  for (const name of off) assert.ok(on.includes(name), `${name} 不该因为开关而消失`);
});

test('开关关着时拒绝联网工具，但要说清是「开关没开」而不是「工具非法」', () => {
  for (const name of ['search_github_repos', 'search_web', 'fetch_url']) {
    const reason = toolAccessError(name, { internetReference: false });
    assert.ok(reason, `${name} 在开关关闭时必须被拒`);
    assert.match(reason!, /互联网参考/);
    assert.match(reason!, /search_web|search_github_repos|fetch_url/);
    assert.equal(/未被允许/.test(reason!), false, '不能复用「未被允许」，那句话会让人以为工具坏了');
  }
});

test('模型凭空编出来的工具名仍然拒绝（白名单没被放宽成什么都放行）', () => {
  for (const name of ['delete_repository', 'exec', 'web_search', 'Search_Web', '']) {
    assert.match(toolAccessError(name, { internetReference: true }) ?? '', /未被允许/, `${name} 不该被放行`);
  }
});

test('端到端：开关打开时 fetch_url 真的走到读取逻辑（不再是「未被允许」）', async () => {
  const result = await executor.execute(
    call('fetch_url', { url: 'https://hwchat-does-not-exist.invalid/page' }),
    'agent',
    settings,
    async () => true,
  );
  // `.invalid` 永远解析不到，所以这里必定是网络失败——但它必须发生在**读取阶段**，
  // 说明已经过了访问检查与审批。若又回「未被允许」，就是白名单又漏了。
  assert.equal(/未被允许/.test(result.content), false, `又被准入挡下了：${result.content}`);
  assert.equal(/未被允许/.test(result.summary), false);
  assert.match(result.content, /hwchat-does-not-exist\.invalid|超时|失败/);
});

test('端到端：开关打开时 fetch_url 仍拒本机与内网地址', async () => {
  const result = await executor.execute(
    call('fetch_url', { url: 'http://127.0.0.1:8080/admin' }),
    'agent',
    settings,
    async () => true,
  );
  assert.equal(/未被允许/.test(result.content), false, '内网拒绝不该伪装成「未被允许」');
  assert.match(result.content, /本机|内网|不可用/);
});

test('端到端：开关关着时联网工具被拒，且不发起任何请求', async () => {
  let approvals = 0;
  const result = await executor.execute(
    call('search_web', { query: 'anything' }),
    'agent',
    { ...settings, internetReference: false },
    async () => { approvals += 1; return true; },
  );
  assert.match(result.content, /互联网参考/);
  assert.equal(approvals, 0, '被拒的调用不该弹审批');
});

test('联网工具不再逐次要审批：一次调研十几次调用不该十几次弹窗', async () => {
  for (const name of ['search_github_repos', 'search_web', 'fetch_url']) {
    let approvals = 0;
    // askAll 档位（读文件都要问）也不该因为这些调用弹窗；用内网地址让它秒失败，
    // 避免测试真的去访问外网。
    const strict = { ...settings, ...PERMISSION_PRESET_PROFILES.askAll, permissionPreset: 'askAll' as const };
    const result = await executor.execute(
      call(name, name === 'fetch_url' ? { url: 'http://10.0.0.1/secret' } : { query: '' }),
      'agent',
      strict,
      async () => { approvals += 1; return true; },
    );
    assert.equal(/未被允许/.test(result.content), false, `${name} 被准入挡下了`);
    assert.equal(approvals, 0, `${name} 不该逐次弹审批（开关本身就是授权）`);
  }
});
