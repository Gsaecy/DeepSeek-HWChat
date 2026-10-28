import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AuditLog } from '../agent/auditLog';
import { ToolExecutor } from '../agent/toolExecutor';
import {
  DEFAULT_SEARCH_EXCLUDED_DIRS,
  invalidateWorkspaceSearch,
  searchWorkspace,
  simpleDirectoryName,
  workspaceSearchExclude,
  workspaceSearchStats,
} from '../agent/workspaceSearch';
import { ChatSettings, ToolExecutionResult } from '../core/types';
import { getReceivedSearchTokens, resetReceivedSearchTokens, setConfiguration, setFindFilesGate, setFolderConfiguration, setWorkspaceRoots } from './support/vscodeMock';

/**
 * 工作区搜索的端到端约束：
 * 默认排除依赖/构建/缓存目录、相同搜索合并、写文件后缓存立刻失效、
 * 取消后不再搜索。每条都直接看「结果里有什么」和「真实搜索了几次」。
 */

let workspaceRoot: string;
let root: string;
let auditPath: string;
let executor: ToolExecutor;

before(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'hwchat-search-'));
  root = join(workspaceRoot, 'project');
  const files: Array<[string, string]> = [
    ['src/a.ts', 'export const NEEDLE = 1;\n'],
    ['src/nested/b.ts', '// nothing here\n'],
    ['node_modules/dep/index.js', 'const NEEDLE = "dep";\n'],
    ['dist/bundle.js', 'NEEDLE\n'],
    ['build/out.js', 'NEEDLE\n'],
    ['out/extension.js', 'NEEDLE\n'],
    ['coverage/report.js', 'NEEDLE\n'],
    ['.next/cache.js', 'NEEDLE\n'],
    ['.turbo/log', 'NEEDLE\n'],
    ['.venv/lib.py', 'NEEDLE = 1\n'],
    ['venv/lib.py', 'NEEDLE = 1\n'],
    ['__pycache__/mod.py', 'NEEDLE = 1\n'],
    ['DerivedData/x.swift', 'let NEEDLE = 1\n'],
    ['.cache/x', 'NEEDLE\n'],
    ['src/custom-skip/skip.ts', 'export const NEEDLE = 2;\n'],
  ];
  for (const [path, content] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  auditPath = join(workspaceRoot, 'audit.jsonl');
  setWorkspaceRoots([root]);
  setConfiguration({});
  executor = new ToolExecutor(new AuditLog(auditPath), () => true);
});

after(async () => {
  executor.dispose();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
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

async function runTool(
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<ToolExecutionResult> {
  return executor.execute(
    { id: `call-${name}-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    'agent',
    settings(),
    async () => true,
    'conversation-search',
    { projectRoot: root, signal: options.signal },
  );
}

test('search_files excludes dependency, build and cache directories by default', async () => {
  const result = await runTool('search_files', { query: 'NEEDLE' });
  assert.equal(result.status, 'success');
  assert.match(result.content, /src\/a\.ts/);
  assert.match(result.content, /src\/custom-skip\/skip\.ts/);
  for (const excluded of DEFAULT_SEARCH_EXCLUDED_DIRS) {
    assert.doesNotMatch(result.content, new RegExp(`${excluded.replace('.', '\\.')}/`), `${excluded} 不应出现在搜索结果里`);
  }
});

test('list_files carries the same default exclusions', async () => {
  const result = await runTool('list_files', { glob: '**/*' });
  const paths = result.content.split('\n');
  assert.ok(paths.some((path) => path.endsWith('src/a.ts')));
  for (const excluded of DEFAULT_SEARCH_EXCLUDED_DIRS) {
    assert.equal(paths.some((path) => path.startsWith(`${excluded}/`)), false, `${excluded} 不应出现在文件列表里`);
  }
});

test('the minimal exclude profile still sees build output (bare filename lookup)', async () => {
  invalidateWorkspaceSearch();
  // 正文里的裸文件名 `extension.js` 真实位置就是 `out/extension.js`：
  // 这类查询必须能看见构建目录，否则文件引用只能降级成普通文本。
  const result = await searchWorkspace({ include: '**/extension.js', limit: 50, exclude: 'minimal' });
  assert.ok(result.outcome.files.some((uri) => uri.fsPath.endsWith('out/extension.js')));

  invalidateWorkspaceSearch();
  const defaultProfile = await searchWorkspace({ include: '**/extension.js', limit: 50 });
  assert.equal(defaultProfile.outcome.files.length, 0, '默认档不扫构建目录');
});

test('a folder-level hwchat.searchExclude entry is honoured (resource scope)', async () => {
  setFolderConfiguration(root, { 'hwchat.searchExclude': ['custom-skip'] });
  invalidateWorkspaceSearch();
  try {
    const result = await runTool('search_files', { query: 'NEEDLE' });
    assert.doesNotMatch(result.content, /custom-skip/);
  } finally {
    setFolderConfiguration(root, {});
    invalidateWorkspaceSearch();
  }
});

test('a per-project hwchat.searchExclude entry is honoured', async () => {
  setConfiguration({ 'hwchat.searchExclude': ['custom-skip'] });
  invalidateWorkspaceSearch();
  try {
    const result = await runTool('search_files', { query: 'NEEDLE' });
    assert.doesNotMatch(result.content, /custom-skip/);
  } finally {
    setConfiguration({});
    invalidateWorkspaceSearch();
  }
});

test('files.exclude 的目录名会并入搜索排除（官方 exclude 语义：自定义 exclude 会替换默认）', async () => {
  // 权威依据：vscode.d.ts 的 findFiles(exclude) 注释写明，传了自定义 exclude 之后
  // 「default file-excludes（即 files.exclude）」不再生效。我们必须自己合并，
  // 否则用户在 files.exclude 里排掉的目录反而会被扫。
  await mkdir(join(root, 'vendor', 'pkg'), { recursive: true });
  await writeFile(join(root, 'vendor', 'pkg', 'heavy.ts'), 'export const NEEDLE_VENDOR = 1;\n', 'utf8');
  await mkdir(join(root, 'logs'), { recursive: true });
  await writeFile(join(root, 'logs', 'debug.log'), 'NEEDLE_LOG\n', 'utf8');

  setConfiguration({ 'files.exclude': { '**/vendor/**': true, '**/*.log': true } });
  invalidateWorkspaceSearch();
  try {
    const exclude = workspaceSearchExclude();
    assert.match(exclude, /vendor/, 'files.exclude 里的目录名要并进排除列表');
    // `**/*.log` 不是目录名，无法塞进 `**/{...}/**`：明确不合并（宁可少排除也不错排）。
    assert.doesNotMatch(exclude, /\*\.log/);

    const listed = await runTool('list_files', { glob: '**/*.ts' });
    assert.doesNotMatch(listed.content, /vendor/, 'files.exclude 里的目录不应出现在文件列表');
  } finally {
    setConfiguration({});
    invalidateWorkspaceSearch();
  }
});

test('simpleDirectoryName 只接受「单段目录名」写法', () => {
  assert.equal(simpleDirectoryName('**/node_modules/**'), 'node_modules');
  assert.equal(simpleDirectoryName('node_modules'), 'node_modules');
  assert.equal(simpleDirectoryName('**/out'), 'out');
  assert.equal(simpleDirectoryName('Pods/'), 'Pods');
  assert.equal(simpleDirectoryName('**/*.log'), undefined);
  assert.equal(simpleDirectoryName('**/foo[0-9]'), undefined);
  assert.equal(simpleDirectoryName('**/a/b/**'), undefined);
  assert.equal(simpleDirectoryName(''), undefined);
});

test('identical searches are merged instead of launching one search each', async () => {
  invalidateWorkspaceSearch();
  const before = workspaceSearchStats()?.completed ?? 0;
  const results = await Promise.all(Array.from({ length: 5 }, () => searchWorkspace({ include: '**/a.ts', limit: 100 })));
  const afterCount = workspaceSearchStats()?.completed ?? 0;

  assert.equal(afterCount - before, 1, '五次相同搜索只应真正执行一次');
  for (const result of results) assert.match(result.outcome.files[0]?.fsPath ?? '', /a\.ts$/);
});

test('writing a file invalidates the cached file list immediately', async () => {
  invalidateWorkspaceSearch();
  const first = await runTool('search_files', { query: 'UNIQUETOKEN' });
  assert.match(first.content, /没有匹配|No matches/);

  const written = await runTool('write_file', { path: 'src/brand-new.ts', content: 'export const UNIQUETOKEN = 1;\n' });
  assert.equal(written.status, 'success');

  const second = await runTool('search_files', { query: 'UNIQUETOKEN' });
  assert.match(second.content, /src\/brand-new\.ts/, '写文件后必须立刻能搜到新内容，不能返回过期缓存');
});

test('repeating the same query scans once; a write forces a fresh scan', async () => {
  invalidateWorkspaceSearch();
  const before = executor.resourceStats();

  await runTool('search_files', { query: 'CACHETOKEN' });
  const repeated = await runTool('search_files', { query: 'CACHETOKEN' });
  const mid = executor.resourceStats();
  assert.equal(mid.contentSearches - before.contentSearches, 1, '第二次相同查询只应命中缓存');
  assert.equal(mid.contentSearchCacheHits - before.contentSearchCacheHits, 1);
  assert.match(repeated.content, /没有匹配|No matches/);

  await runTool('write_file', { path: 'src/cache-probe.ts', content: 'export const CACHETOKEN = 1;\n' });
  const fresh = await runTool('search_files', { query: 'CACHETOKEN' });
  const after = executor.resourceStats();
  assert.equal(after.contentSearches - mid.contentSearches, 1, '写入后必须重新扫描');
  assert.match(fresh.content, /src\/cache-probe\.ts/, '写入后必须能搜到新内容');
});

test('取消会真的传给搜索引 token（官方 findFiles 第 4 个参数）', async () => {
  // 权威依据：vscode.d.ts 里 findFiles(include, exclude?, maxResults?, token?)
  // 的注释是 "A token that can be used to signal cancellation to the underlying
  // search engine"。旧实现只传 3 个参数，点停止后 ripgrep 仍会把工作区扫完。
  invalidateWorkspaceSearch();
  resetReceivedSearchTokens();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setFindFilesGate(() => gate);
  try {
    const controller = new AbortController();
    const pending = searchWorkspace({ include: '**/*.ts', limit: 200 }, { signal: controller.signal });
    // 等到 findFiles 真的收到 token（搜索已开始），再取消：这样断言的是「进行中的搜索」。
    for (let attempt = 0; attempt < 100 && !getReceivedSearchTokens().length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const tokens = getReceivedSearchTokens();
    assert.ok(tokens.length >= 1, 'findFiles 必须收到 token（否则取消无法到达搜索引擎）');
    assert.equal(tokens[0]!.isCancellationRequested, false, '搜索进行中时 token 不应是已取消状态');

    controller.abort();
    assert.equal(tokens[0]!.isCancellationRequested, true, '取消必须传到搜索引擎的 token 上');
    release();
    await pending.catch(() => undefined);
  } finally {
    setFindFilesGate(undefined);
  }
});

test('an already-cancelled signal performs no search at all', async () => {
  invalidateWorkspaceSearch();
  const before = workspaceSearchStats()?.completed ?? 0;
  const controller = new AbortController();
  controller.abort();
  const result = await runTool('search_files', { query: 'NEEDLE' }, { signal: controller.signal });
  const afterCount = workspaceSearchStats()?.completed ?? 0;

  assert.equal(afterCount, before, '取消后不得再启动搜索');
  assert.match(`${result.summary}${result.content}`, /取消|cancel/i);
});

test('cancelling mid-search stops scanning further files', async () => {
  // 造一批大文件，让扫描有足够长的窗口；取消后必须很快返回。
  const bulk = join(root, 'src', 'bulk');
  await mkdir(bulk, { recursive: true });
  const filler = 'x'.repeat(60_000);
  for (let index = 0; index < 150; index += 1) {
    await writeFile(join(bulk, `f${index}.ts`), `${filler}\nNEEDLE_${index}\n`, 'utf8');
  }
  invalidateWorkspaceSearch();
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = runTool('search_files', { query: 'NEEDLE' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const result = await pending;
  assert.ok(Date.now() - startedAt < 5_000);
  assert.match(`${result.summary}${result.content}`, /取消|cancel|NEEDLE/);
});

test('diagnostics record queue depth and retry counters for every tool call', async () => {
  const events: Array<Record<string, unknown>> = [];
  const diagnosing = new ToolExecutor(
    new AuditLog(join(workspaceRoot, 'audit-diag.jsonl')),
    () => true,
    (event) => events.push(event as unknown as Record<string, unknown>),
  );
  try {
    await diagnosing.execute(
      { id: 'call-diag', type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ glob: '**/*.ts' }) } },
      'agent',
      settings(),
      async () => true,
      'conversation-diag',
      { projectRoot: root },
    );
  } finally {
    diagnosing.dispose();
  }

  assert.equal(events.length, 1, '每次工具调用都应产生一条结构化诊断');
  const event = events[0]!;
  // 排查 EAGAIN / CPU 打满时需要的字段必须齐全（键存在即视为已记录，值为 0 也算）。
  for (const key of ['turnId', 'toolCallId', 'toolName', 'operation', 'durationMs', 'activeSearches', 'pendingSearches', 'searchRetries', 'searchRejected', 'activeCommands', 'queuedCommands', 'resultCount', 'truncated', 'cancelled']) {
    assert.ok(key in event, `诊断缺少字段 ${key}`);
  }
  assert.equal(event.toolName, 'list_files');
  // 诊断里绝不能出现命令正文或文件内容。
  assert.doesNotMatch(JSON.stringify(event), /export const|NEEDLE/);
});
