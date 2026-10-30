import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutor, type ToolApprovalRequest } from '../agent/toolExecutor';
import { AuditLog } from '../agent/auditLog';
import { ChatSettings, PermissionPreset, ToolCall, ToolExecutionResult } from '../core/types';
import { PERMISSION_PRESET_PROFILES } from '../core/permissions';
import { setWorkspaceRoots } from './support/vscodeMock';
import { getInvokeToolCalls, resetInvokeToolCalls, setLmTools } from './support/vscodeMock';
import { VscodeToolBridge } from '../agent/vscodeTools';

/**
 * 这些用例来自真实会话里出现过的工具调用故障，而不是凭空构造：
 * 1. glob 带根目录名前缀时静默返回 0 条结果（日志里连续踩了两次）；
 * 2. list_directory 不传 path 时静默只列第一个根目录，把调用方带偏；
 * 3. 命令里出现 `..` 一律拒绝，即使解析后仍在工作区内；
 * 4. 权限预设 / 硬边界 / 敏感文件 / 审计此前完全没有测试覆盖。
 */

let workspaceRoot: string;
let rootA: string;
let rootB: string;
let trusted = true;
let auditPath: string;
let executor: ToolExecutor;

before(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'hwchat-tools-'));
  rootA = join(workspaceRoot, 'Safevault_android');
  rootB = join(workspaceRoot, 'DeepSeek-HWChat');
  await mkdir(join(rootA, 'src'), { recursive: true });
  await mkdir(join(rootB, 'src', 'agent'), { recursive: true });
  await mkdir(join(rootB, 'src', 'views'), { recursive: true });
  await mkdir(join(rootB, 'sandbox'), { recursive: true });
  await writeFile(join(rootA, 'src', 'index.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(rootB, 'src', 'agent', 'commandPaths.ts'), 'export const b = 2;\n', 'utf8');
  await writeFile(join(rootB, 'src', 'views', 'webview.ts'), 'export const c = 3;\n', 'utf8');
  await writeFile(join(rootB, 'package.json'), '{"name":"hwchat"}\n', 'utf8');
  await writeFile(join(rootB, '.env'), 'SECRET_TOKEN=abcdef123456\n', 'utf8');
  // 二进制文件：用于验证搜索遇到它时跳过而不是整次失败。
  await writeFile(join(rootB, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
  auditPath = join(workspaceRoot, 'audit.jsonl');
  setWorkspaceRoots([rootA, rootB]);
  executor = new ToolExecutor(new AuditLog(auditPath), () => trusted);
});

after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function settings(permissionPreset: PermissionPreset, overrides: Partial<ChatSettings> = {}): ChatSettings {
  // 生产代码在 readSettings() 里把预设展开成具体策略；测试也必须照做，
  // 否则执行器读到的 fileReadPolicy 等字段与真实运行时不一致。
  const profile = PERMISSION_PRESET_PROFILES[permissionPreset];
  const resolvedPolicies = profile
    ? {
        fileReadPolicy: profile.fileReadPolicy,
        fileWritePolicy: profile.fileWritePolicy,
        commandPolicy: profile.commandPolicy,
        dangerousCommandPolicy: profile.dangerousCommandPolicy,
        sensitiveFilePolicy: profile.sensitiveFilePolicy,
      }
    : {};
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
    requestTimeoutSeconds: 30,
    defaultMode: 'agent',
    agentMaxSteps: 0,
    reasoningEffort: 'default',
    permissionPreset,
    fileReadPolicy: 'allow',
    fileWritePolicy: 'allow',
    commandPolicy: 'allow',
    dangerousCommandPolicy: 'ask',
    sensitiveFilePolicy: 'deny',
    maxReadBytes: 512_000,
    maxToolOutputBytes: 200_000,
    maxCommandSeconds: 120,
    auditRetentionDays: 30,
    language: 'auto',
    ...resolvedPolicies,
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function recorder(decision: boolean | ((request: ToolApprovalRequest) => boolean) = true) {
  const seen: ToolApprovalRequest[] = [];
  const requestApproval = async (request: ToolApprovalRequest): Promise<boolean> => {
    seen.push(request);
    return typeof decision === 'function' ? decision(request) : decision;
  };
  return { requestApproval, seen };
}

async function run(
  name: string,
  args: Record<string, unknown>,
  options: { preset?: PermissionPreset; mode?: 'chat' | 'agent' | 'plan'; approve?: boolean } = {},
): Promise<{ result: ToolExecutionResult; requests: ToolApprovalRequest[] }> {
  const recorded = recorder(options.approve ?? true);
  const result = await executor.execute(
    call(name, args),
    options.mode ?? 'agent',
    settings(options.preset ?? 'review'),
    recorded.requestApproval,
  );
  return { result, requests: recorded.seen };
}

// ── 1. glob 的根目录名前缀约定必须与 path 参数一致 ─────────────────────────
test('list_files 支持根目录名前缀，和 path 参数的约定保持一致', async () => {
  const { result } = await run('list_files', { glob: 'DeepSeek-HWChat/src/**/*.ts' });
  const files = result.content.split('\n').filter(Boolean);
  assert.equal(result.status, 'success');
  assert.equal(files.length, 2, `应找到 2 个文件，实际：${JSON.stringify(files)}`);
  for (const file of files) assert.ok(file.startsWith('DeepSeek-HWChat/'), file);
});

test('search_files 支持根目录名前缀，而不是静默返回 0 处匹配', async () => {
  const { result } = await run('search_files', { glob: 'DeepSeek-HWChat/src/**/*.ts', query: 'export const' });
  assert.equal(result.status, 'success');
  assert.doesNotMatch(result.summary, /找到 0 处/, `实际摘要：${result.summary}`);
});

test('不带前缀的 glob 仍然覆盖所有工作区根目录', async () => {
  const { result } = await run('list_files', { glob: 'src/**/*.ts' });
  const files = result.content.split('\n').filter(Boolean);
  assert.equal(files.length, 3, `应跨根找到 3 个文件，实际：${JSON.stringify(files)}`);
});

test('search_files 遇到二进制文件时跳过它，而不是整次搜索失败', async () => {
  const { result } = await run('search_files', { glob: 'DeepSeek-HWChat/**/*', query: 'export const' });
  assert.equal(result.status, 'success', `${result.status} / ${result.content}`);
  assert.match(result.summary, /找到 [1-9]/);
});

// ── 2. list_directory 在多根工作区不能静默偏向第一个根 ────────────────────
test('list_directory 不传 path 时列出所有工作区根目录，而不是只列第一个', async () => {
  const { result } = await run('list_directory', {});
  assert.equal(result.status, 'success');
  assert.match(result.content, /Safevault_android/);
  assert.match(result.content, /DeepSeek-HWChat/);
});

// ── 3. 命令里的 `..` 应按 cwd 解析后判界，而不是一律拒绝 ─────────────────
test('命令中使用 .. 但解析后仍在工作区内时应允许', async () => {
  const { result } = await run('run_command', {
    command: 'cat ../package.json',
    cwd: 'DeepSeek-HWChat/src',
  });
  assert.equal(result.status, 'success', `实际：${result.status} / ${result.summary}`);
  assert.match(result.content, /hwchat/);
});

test('命令中使用 .. 且解析后越界时应拒绝', async () => {
  const { result } = await run('run_command', {
    command: 'cat ../../../../etc/passwd',
    cwd: 'DeepSeek-HWChat/src',
  });
  assert.notEqual(result.status, 'success');
});

test('命令引用工作区外的绝对路径应拒绝', async () => {
  const { result } = await run('run_command', { command: 'cat /etc/hosts' });
  assert.notEqual(result.status, 'success');
});

// ── 4. 权限预设矩阵：执行器层的真实拦截 ──────────────────────────────────
test('review 预设：读取与写入工作区文件自动放行', async () => {
  const read = await run('read_file', { path: 'DeepSeek-HWChat/package.json' });
  assert.equal(read.result.status, 'success');
  assert.equal(read.requests.length, 0);

  const write = await run('write_file', { path: 'DeepSeek-HWChat/tmp-review.txt', content: 'x' });
  assert.equal(write.result.status, 'success');
  assert.equal(write.requests.length, 0);
});

test('askAll 预设：读取也要逐次确认，拒绝后不执行', async () => {
  const { result, requests } = await run('read_file', { path: 'DeepSeek-HWChat/package.json' }, { preset: 'askAll', approve: false });
  assert.equal(requests.length, 1);
  assert.equal(result.status, 'denied');
});

test('review 预设：危险命令逐次确认，拒绝后不执行', async () => {
  const { result, requests } = await run('run_command', { command: 'chmod 777 ./sandbox', cwd: 'DeepSeek-HWChat' }, { approve: false });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.detail, /严重风险命令/);
  assert.equal(result.status, 'denied');
});

test('askAll 预设：危险命令直接拒绝，不弹确认', async () => {
  const { result, requests } = await run('run_command', { command: 'chmod 777 ./sandbox', cwd: 'DeepSeek-HWChat' }, { preset: 'askAll' });
  assert.equal(requests.length, 0);
  assert.equal(result.status, 'denied');
});

test('autopilot 预设：危险命令自动执行，不再确认', async () => {
  const { result, requests } = await run('run_command', { command: 'chmod 777 ./sandbox', cwd: 'DeepSeek-HWChat' }, { preset: 'autopilot' });
  assert.equal(requests.length, 0, 'autopilot 不应再询问');
  assert.equal(result.status, 'success', `${result.status} / ${result.summary}`);
});

// ── 5. 敏感文件 ──────────────────────────────────────────────────────────
test('review 预设：敏感文件直接拒绝，且不泄漏内容', async () => {
  const { result } = await run('read_file', { path: 'DeepSeek-HWChat/.env' });
  assert.equal(result.status, 'denied');
  assert.doesNotMatch(result.content, /abcdef123456/);
});

test('完全访问预设：敏感文件逐次确认，拒绝后读不到', async () => {
  const denied = await run('read_file', { path: 'DeepSeek-HWChat/.env' }, { preset: 'full', approve: false });
  assert.equal(denied.requests.length, 1);
  assert.equal(denied.result.status, 'denied');

  const allowed = await run('read_file', { path: 'DeepSeek-HWChat/.env' }, { preset: 'full', approve: true });
  assert.equal(allowed.result.status, 'success');
});

test('敏感文件内容在工具输出里被脱敏', async () => {
  const { result } = await run('read_file', { path: 'DeepSeek-HWChat/.env' }, { preset: 'full', approve: true });
  assert.doesNotMatch(result.content, /abcdef123456/);
});

// ── 6. 硬边界 ────────────────────────────────────────────────────────────
test('规划模式禁止写入，即使预设是 autopilot', async () => {
  const { result } = await run('write_file', { path: 'DeepSeek-HWChat/plan.txt', content: 'x' }, { preset: 'autopilot', mode: 'plan' });
  assert.equal(result.status, 'denied');
});

test('未受信任工作区禁止写入与执行命令', async () => {
  trusted = false;
  try {
    const write = await run('write_file', { path: 'DeepSeek-HWChat/untrusted.txt', content: 'x' }, { preset: 'autopilot' });
    assert.equal(write.result.status, 'denied');

    const command = await run('run_command', { command: 'pwd' }, { preset: 'autopilot' });
    assert.equal(command.result.status, 'denied');
  } finally {
    trusted = true;
  }
});

test('未知工具被拒绝，而不是静默忽略', async () => {
  const { result } = await run('manage_todo_list', { items: [] });
  assert.equal(result.status, 'denied');
  assert.match(result.content, /未被允许/);
});

// ── 7. 审计日志 ──────────────────────────────────────────────────────────
test('被拒绝的调用会写入审计记录，且敏感值被脱敏', async () => {
  await run('read_file', { path: 'DeepSeek-HWChat/.env' });
  const raw = await readFile(auditPath, 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { tool: string; status: string; summary: string });
  const denied = lines.filter((line) => line.tool === 'read_file' && line.status === 'denied');
  assert.ok(denied.length > 0, `审计里没有 denied 记录：${raw.slice(0, 400)}`);
  assert.ok(lines.every((line) => !/abcdef123456/.test(line.summary)));
});

// ── 8. 外部（VS Code 桥接）工具的权限路径 ────────────────────────────────
async function runExternal(
  risk: 'read' | 'write' | 'command',
  options: {
    preset?: PermissionPreset;
    mode?: 'chat' | 'agent' | 'plan';
    approve?: boolean;
    delegateApproval?: boolean;
    forceApproval?: boolean;
    overrides?: Partial<ChatSettings>;
  } = {},
): Promise<{ result: ToolExecutionResult; requests: ToolApprovalRequest[] }> {
  const recorded = recorder(options.approve ?? true);
  const result = await executor.executeExternal(
    call(`external_${risk}`, {}),
    options.mode ?? 'agent',
    settings(options.preset ?? 'review', options.overrides),
    risk,
    recorded.requestApproval,
    '外部工具调用',
    '详情',
    async () => ({ status: 'success', summary: '外部执行成功', content: 'ok', approval: 'not-required' }),
    { delegateApproval: options.delegateApproval, forceApproval: options.forceApproval },
  );
  return { result, requests: recorded.seen };
}

test('外部工具：规划模式只允许只读', async () => {
  const read = await runExternal('read', { mode: 'plan', preset: 'autopilot' });
  assert.equal(read.result.status, 'success');

  const write = await runExternal('write', { mode: 'plan', preset: 'autopilot' });
  assert.equal(write.result.status, 'denied');
});

test('外部工具：未受信任工作区禁止写入与命令，读取仍可用', async () => {
  trusted = false;
  try {
    assert.equal((await runExternal('read', { preset: 'autopilot' })).result.status, 'success');
    assert.equal((await runExternal('write', { preset: 'autopilot' })).result.status, 'denied');
    assert.equal((await runExternal('command', { preset: 'autopilot' })).result.status, 'denied');
  } finally {
    trusted = true;
  }
});

test('外部工具：写入策略为禁止时不执行，也不弹确认', async () => {
  // 自定义档位已移除，但执行器的 deny 分支仍必须被覆盖：
  // 这里直接在 settings 上构造 fileWritePolicy='deny' 来验证该分支不会弹出审批。
  const { result, requests } = await runExternal('write', {
    preset: 'review',
    overrides: { fileWritePolicy: 'deny' },
  });
  assert.equal(result.status, 'denied');
  assert.equal(requests.length, 0);
});

test('外部工具：delegateApproval 交给 VS Code 自己确认，HWChat 不叠加弹窗', async () => {
  const { result, requests } = await runExternal('write', { delegateApproval: true, overrides: { fileWritePolicy: 'ask' } });
  assert.equal(requests.length, 0);
  assert.equal(result.status, 'success');
});

test('外部工具：forceApproval 在审阅预设下强制确认，在 autopilot 下不确认', async () => {
  const review = await runExternal('read', { forceApproval: true, approve: false });
  assert.equal(review.requests.length, 1);
  assert.equal(review.result.status, 'denied');

  const autopilot = await runExternal('read', { forceApproval: true, preset: 'autopilot' });
  assert.equal(autopilot.requests.length, 0);
});

// ── 3. 多根工作区：全局上限不能把靠后的根目录整个吞掉 ────────────────────
// 真实故障：`search_files` 不带 glob 时只扫到 200 个文件，全部来自第一个根，
// 用户的项目根根本没被搜过，工具却回答“没有匹配”。
test('list_files 不传 glob 时覆盖所有根目录，而不是把名额全花在第一个根上', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hwchat-starve-'));
  const first = join(scratch, 'RootFirst');
  const second = join(scratch, 'RootSecond');
  try {
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await Promise.all(Array.from({ length: 420 }, (_, index) =>
      writeFile(join(first, `f${index}.txt`), 'x', 'utf8')));
    await writeFile(join(second, 'only-in-second.txt'), 'x', 'utf8');
    setWorkspaceRoots([first, second]);
    const scoped = new ToolExecutor(new AuditLog(join(scratch, 'audit.jsonl')), () => true);
    const result = await scoped.execute(
      call('list_files', { glob: '**/*' }),
      'agent',
      settings('review'),
      recorder(true).requestApproval,
    );
    assert.equal(result.status, 'success');
    assert.match(result.content, /only-in-second\.txt/, '第二个根的文件被全局上限吞掉了');
    assert.match(result.summary, /已达上限/, '截断时必须如实告知，不能假装结果完整');
  } finally {
    setWorkspaceRoots([rootA, rootB]);
    await rm(scratch, { recursive: true, force: true });
  }
});

// 真实故障（本次会话实测）：18 个根的工作区里点名第 17 个根 `DeepSeek-HWChat/**`，
// 工具回答「找到 0 个文件（已达上限）」。根因是根名分支只传了字符串 glob，多根工作区里
// findFiles 会搜遍所有根、共享同一个上限，前 16 个根把名额吃光，过滤后剩 0。
// 注意：文件确实存在，工具却回答“没有”，比报错更糟——调用方会误判项目里没这个文件。
test('根目录名前缀的 glob 必须限定在该根内查询，不能被前面的根挤成 0 个文件', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hwchat-scoped-glob-'));
  const first = join(scratch, 'Safevault_android');
  const second = join(scratch, 'DeepSeek-HWChat');
  try {
    await mkdir(join(first, 'src'), { recursive: true });
    await mkdir(join(second, 'src'), { recursive: true });
    // 第一个根的文件数超过 ROOT_FILE_LIMIT（1000），旧实现会把名额全部花光。
    await Promise.all(Array.from({ length: 1_050 }, (_, index) =>
      writeFile(join(first, 'src', `f${index}.ts`), 'x', 'utf8')));
    await writeFile(join(second, 'src', 'webview.ts'), 'export const c = 3;\n', 'utf8');
    setWorkspaceRoots([first, second]);
    const scoped = new ToolExecutor(new AuditLog(join(scratch, 'audit.jsonl')), () => true);
    const result = await scoped.execute(
      call('list_files', { glob: 'DeepSeek-HWChat/**' }),
      'agent',
      settings('review'),
      recorder(true).requestApproval,
    );
    assert.equal(result.status, 'success');
    assert.match(result.content, /webview\.ts/, `目标根的文件被前面的根挤掉了：${result.summary}`);
    assert.equal(result.summary, '找到 1 个文件', `找到文件时不应声称已达上限：${result.summary}`);
  } finally {
    setWorkspaceRoots([rootA, rootB]);
    await rm(scratch, { recursive: true, force: true });
  }
});

// 真实故障（本次会话实测）：`search_files` 不传 glob 搜索 `scrollToBottomButton`，
// 该字符串明明存在，工具却回答「找到 0 处匹配」，并自报「只扫描了前 1500 个文件」。
// 根因：逐根查询已经修好，但合并后的列表是「第一个根的全部 → 第二个根的全部」，
// 1500 的扫描预算在最靠前的根就用光了，第 17 个根从未被读到。
test('search_files 不传 glob 时扫描预算要分摊到所有根，不能在第 17 个根之前耗尽', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hwchat-search-starve-'));
  // 每个根各自被 PER_ROOT_FILE_LIMIT（400）封顶，所以单靠一个噪音根凑不满
  // SEARCH_FILE_BUDGET（1500）。真实工作区是 18 个根，必须按「多个噪音根 + 目标根在最后」构造。
  const noisyNames = ['Safevault_android', 'Safevault_iOS', 'Safevault_macOS', 'Safevault_windows'];
  const noisyRoots = noisyNames.map((name) => join(scratch, name));
  const targetRoot = join(scratch, 'DeepSeek-HWChat');
  try {
    for (const root of noisyRoots) {
      await mkdir(root, { recursive: true });
      await Promise.all(Array.from({ length: 420 }, (_, index) =>
        writeFile(join(root, `f${index}.txt`), 'nothing to see here\n', 'utf8')));
    }
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, 'target.ts'), 'const scrollToBottomButton = 1;\n', 'utf8');
    setWorkspaceRoots([...noisyRoots, targetRoot]);
    const scoped = new ToolExecutor(new AuditLog(join(scratch, 'audit.jsonl')), () => true);
    const result = await scoped.execute(
      call('search_files', { query: 'scrollToBottomButton' }),
      'agent',
      settings('review'),
      recorder(true).requestApproval,
    );
    assert.equal(result.status, 'success');
    assert.match(result.content, /target\.ts/, `最后一个根从未被扫描：${result.summary} / ${result.content.slice(0, 200)}`);
  } finally {
    setWorkspaceRoots([rootA, rootB]);
    await rm(scratch, { recursive: true, force: true });
  }
});

// 真实缺陷（本次会话实测）：`hwchat_vscode_copilot_readFile` 传 /etc/hosts 直接返回了
// 工作区外的文件内容，`copilot_listDirectory` 传 /etc 列出了整个系统目录。原生 read_file
// 被锁在工作区内，桥接通道却完全绕过路径隔离——等于同一套产品里有一扇没上锁的后门。
// 这两条用例断言：越界参数必须在调用 VS Code 之前被拒绝，而不是靠 VS Code 自己兜。
test('桥接工具：越界路径在调用前被拒绝，根本不会触发 VS Code 工具', async () => {
  setLmTools([{ name: 'copilot_readFile', description: '读取文件', inputSchema: {}, tags: [] }]);
  resetInvokeToolCalls();
  const bridge = new VscodeToolBridge(executor);
  const id = bridge
    .definitions()
    .map((item) => item.function.name)
    .find((name) => name.includes('copilot_readFile'));
  assert.ok(id, '应登记 copilot_readFile 桥接工具');

  const recorded = recorder(true);
  const outcome = await bridge.execute(
    call(id, { filePath: '/etc/hosts' }),
    'agent',
    settings('autopilot'),
    recorded.requestApproval,
    'conversation-1',
  );

  assert.equal(outcome?.result.status, 'denied', `实际：${outcome?.result.status} / ${outcome?.result.summary}`);
  assert.match(String(outcome?.result.summary), /路径隔离/, `摘要：${outcome?.result.summary}`);
  assert.equal(getInvokeToolCalls().length, 0, '越界参数不应到达 VS Code 工具');
});

test('桥接工具：工作区内的路径照常放行', async () => {
  setLmTools([{ name: 'copilot_readFile', description: '读取文件', inputSchema: {}, tags: [] }]);
  resetInvokeToolCalls();
  const bridge = new VscodeToolBridge(executor);
  const id = bridge
    .definitions()
    .map((item) => item.function.name)
    .find((name) => name.includes('copilot_readFile'));
  assert.ok(id);

  const recorded = recorder(true);
  const outcome = await bridge.execute(
    call(id, { filePath: 'DeepSeek-HWChat/package.json' }),
    'agent',
    settings('autopilot'),
    recorded.requestApproval,
    'conversation-2',
  );

  assert.equal(outcome?.result.status, 'success', `实际：${outcome?.result.status} / ${outcome?.result.summary}`);
  assert.equal(getInvokeToolCalls().length, 1, '工作区内路径应正常调用一次');
});
