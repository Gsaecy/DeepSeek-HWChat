/**
 * 「按任务类型指定首选工具」。
 *
 * 三个真实故障（同一天）：
 *  1. 「先给我预览一下效果」→ 模型用 `run_in_terminal` 起服务器（该工具在 HWChat 里
 *     永远调不通）→ 三轮失败停机；
 *  2. 「优化图片，生成新图片发给我」→ 模型去 `npx` 装 mermaid-cli（超时 2 分钟）；
 *  3. 「提交/推送」→ 换着写法撞 git 闸门。
 *
 * 这三类的执行路径是固定的，所以改成宿主指定：判定任务类型 → 收窄工具清单 →
 * 注入执行约定 → 执行期硬拒走错的工具。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blockedToolReason,
  detectPlaybooks,
  detectTestCommand,
  hasWriteIntent,
  narrowToolNames,
  type ToolPlaybook,
} from '../agent/toolPlaybooks';
import { ChatSettings } from '../core/types';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner } from '../agent/agentRunner';
import { AuditLog } from '../agent/auditLog';
import { ToolExecutor } from '../agent/toolExecutor';
import { DeepSeekClient } from '../providers/deepseekClient';
import { setWorkspaceRoots } from './support/vscodeMock';

const looksLikeImage = (text: string) => /(?:画|生成).{0,6}(?:图|图片|海报|插画)/.test(text);

test('识别「本地预览」的常见说法', () => {
  for (const text of [
    '先给我预览一下效果',
    '预览一下首页',
    '启动本地服务器看看',
    '起个静态服务',
    '打开 http://127.0.0.1:8791/ 看看',
    '跑起来看看效果',
  ]) {
    const kinds = detectPlaybooks(text, { looksLikeImage }).map((item) => item.kind);
    assert.ok(kinds.includes('web-preview'), `应识别为预览：${text}`);
  }
});

test('「预览图片」不算网页预览（那是要图）', () => {
  const kinds = detectPlaybooks('预览一下这张图片', { looksLikeImage }).map((item) => item.kind);
  assert.equal(kinds.includes('web-preview'), false);
});

test('识别「要图」并给出 generate_image', () => {
  const playbooks = detectPlaybooks('优化图片，生成新图片发给我', { looksLikeImage });
  const image = playbooks.find((item) => item.kind === 'image-generation');
  assert.ok(image, '应命中 image-generation');
  assert.deepEqual(image?.preferred, ['generate_image']);
  assert.match(image.directive, /mermaid-cli/, '要明确禁止去装渲染器');
});

test('识别 git 写操作；「不要提交」不算', () => {
  assert.ok(detectPlaybooks('把改动提交并推送', { looksLikeImage }).some((item) => item.kind === 'git-write'));
  assert.equal(detectPlaybooks('先不要提交', { looksLikeImage }).length, 0);
});

test('写意图判定：能区分「预览」与「预览并修改」', () => {
  assert.equal(hasWriteIntent('先给我预览一下效果'), false);
  assert.equal(hasWriteIntent('预览效果顺便把标题改大一点'), true);
  assert.equal(hasWriteIntent('别改代码，只预览'), false);
  assert.equal(hasWriteIntent('只读看看'), false);
  assert.equal(hasWriteIntent('fix the login bug'), true);
});

const ALL = [
  'read_file', 'list_directory', 'write_file', 'replace_in_file', 'delete_file', 'run_command',
  'open_web_preview', 'open_text_preview', 'update_todos', 'ask_user_choice', 'load_skill',
  'generate_image', 'search_web', 'run_in_terminal',
];

function preview(): ToolPlaybook {
  return detectPlaybooks('先给我预览一下效果', { looksLikeImage })[0]!;
}

test('收窄：纯预览时会拿走写工具，但只读与元工具永远保留', () => {
  const kept = narrowToolNames(ALL, [preview()], false);
  assert.ok(kept.includes('run_command'), '首选工具必须在');
  assert.ok(kept.includes('open_web_preview'));
  assert.ok(kept.includes('read_file'), '只读工具必须保留 —— 预览前也要能看代码');
  assert.ok(kept.includes('update_todos'));
  assert.equal(kept.includes('write_file'), false, '纯预览不该能改文件');
  assert.equal(kept.includes('delete_file'), false);
});

test('收窄：用户要改东西时不动工具清单（「预览并修改」必须能改）', () => {
  const kept = narrowToolNames(ALL, [preview()], true);
  assert.deepEqual(kept, ALL, '有写意图时不做写侧收窄');
});

test('收窄：没命中任务类型时不收窄', () => {
  assert.deepEqual(narrowToolNames(ALL, [], false), ALL);
});

test('收窄：白名单配错导致一个都不剩时放弃收窄（不能让模型无工具可用）', () => {
  const bogus: ToolPlaybook = { ...preview(), allowed: ['nonexistent_tool'], preferred: ['nonexistent_tool'] };
  const kept = narrowToolNames(['run_command'], [bogus], false);
  assert.deepEqual(kept, ['run_command'], '宁可放弃收窄，也不能给空清单');
});

test('执行期硬拒：不在允许范围内的工具一律被拒，并指出首选工具', () => {
  // 判据与收窄同源：纯预览时 write_file 既不在清单里，硬调也要被拒。
  const reason = blockedToolReason('write_file', [preview()], false);
  assert.ok(reason, '纯预览时硬调 write_file 必须被拒');
  assert.match(reason!, /run_command/, '必须告诉模型该用哪个');
  assert.match(reason!, /web-preview/);

  for (const allowed of ['run_command', 'open_web_preview', 'read_file', 'update_todos', 'get_diagnostics']) {
    assert.equal(blockedToolReason(allowed, [preview()], false), undefined, `${allowed} 应放行`);
  }
});

test('执行期硬拒：有写意图时不按写侧规则拦（与收窄同一套豁免）', () => {
  assert.equal(blockedToolReason('write_file', [preview()], true), undefined, '要改东西时必须放行写工具');
  assert.equal(blockedToolReason('delete_file', [preview()], true), undefined);
  // 没有命中任务类型时一律放行
  assert.equal(blockedToolReason('write_file', [], false), undefined);
});

test('执行期硬拒：显式 blocked 的文案更具体', () => {
  const explicit: ToolPlaybook = { ...preview(), blocked: ['run_in_terminal'] };
  const reason = blockedToolReason('run_in_terminal', [explicit], false);
  assert.ok(reason);
  assert.match(reason!, /不该用 run_in_terminal/);
});

test('指令必须写清「工具名 + 参数形状 + 顺序 + 禁用项」', () => {
  const directive = preview().directive;
  assert.match(directive, /run_command/);
  assert.match(directive, /background/);
  assert.match(directive, /open_web_preview/);
  assert.match(directive, /127\.0\.0\.1/);
  assert.match(directive, /禁止/);
  assert.match(directive, /run_in_terminal/);
});

test('runner 真的按清单裁剪（三路来源一起裁，不是只在提示词里说）', async () => {
  setWorkspaceRoots([process.cwd()]);

  const sent: string[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function: { name: string } }> };
    sent.push((body.tools ?? []).map((tool) => tool.function.name));
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  const executor = new ToolExecutor(new AuditLog(join(tmpdir(), `hwchat-playbook-${Date.now()}.jsonl`)), () => true);
  const runner = new AgentRunner(new DeepSeekClient(async () => 'k'), executor);
  const extraTools = [
    { type: 'function', function: { name: 'open_web_preview', description: 'p', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'update_todos', description: 't', parameters: { type: 'object', properties: {} } } },
  ] as never;
  const callbacks = {
    onDelta: async () => undefined, onToolsChanged: async () => undefined,
    onTaskUpdate: async () => undefined, requestApproval: async () => true,
  } as never;
  const settings: ChatSettings = {
    apiProfiles: [{ id: 'default', name: 'T', baseUrl: 'https://example.invalid/v1', models: ['m'], requestHeaders: {} }],
    activeApiProfileId: 'default', baseUrl: 'https://example.invalid/v1', model: 'm',
    temperature: 0, maxTokens: 0, systemPrompt: '', sendOnEnter: true, historyRetentionDays: 30,
    taskCacheRetentionHours: 24, cacheBudgetMB: 100, cleanupIntervalMinutes: 10, maxMessagesInContext: 20,
    requestHeaders: {}, requestTimeoutSeconds: 30, proxy: '', defaultMode: 'agent', agentMaxSteps: 1,
    reasoningEffort: 'default', permissionPreset: 'full', internetReference: false,
    fileReadPolicy: 'allow', fileWritePolicy: 'allow', commandPolicy: 'allow',
    dangerousCommandPolicy: 'allow', sensitiveFilePolicy: 'allow',
    maxReadBytes: 512000, maxToolOutputBytes: 200000, maxCommandSeconds: 5, auditRetentionDays: 30, language: 'zh',
  };
  const base = {
    settings, messages: [{ role: 'user' as const, content: 'hi' }], mode: 'agent' as const,
    signal: new AbortController().signal, extraTools, callbacks,
  };
  try {
    await runner.run({ ...base, conversationId: 'p1' });
    await runner.run({ ...base, conversationId: 'p2', toolAllowList: ['run_command', 'open_web_preview', 'update_todos'] });
  } finally {
    globalThis.fetch = originalFetch;
    executor.dispose();
  }

  assert.ok((sent[0]?.length ?? 0) > 5, '不限制时应该是完整清单');
  assert.deepEqual(
    [...(sent[1] ?? [])].sort(),
    ['open_web_preview', 'run_command', 'update_todos'],
    '带清单时必须只下发清单里的（原生 / 桥接 / 额外三路一起裁）',
  );
});

/* ── 新增的三类任务 + 测试命令探测 + 路径替代建议 ─────────────────── */

test('识别「跑测试」，并用探测到的真实命令（不让模型猜 npm test）', () => {
  for (const text of ['跑一下测试', '运行全部测试', '重跑单测', 'run the tests', 'pytest 一下']) {
    const kinds = detectPlaybooks(text, { looksLikeImage }).map((item) => item.kind);
    assert.ok(kinds.includes('test-run'), `应识别为跑测试：${text}`);
  }
  const detected = detectPlaybooks('跑一下测试', {
    looksLikeImage,
    testCommand: { command: 'pnpm test', source: 'package.json scripts.test' },
  }).find((item) => item.kind === 'test-run');
  assert.match(detected!.directive, /pnpm test/, '探测到就必须写进指令');
  assert.match(detected!.directive, /直接/);

  const unknown = detectPlaybooks('跑一下测试', { looksLikeImage }).find((item) => item.kind === 'test-run');
  assert.match(unknown!.directive, /未探测到测试命令/, '没探测到时要让它先读清单确认');
  assert.match(unknown!.directive, /不要猜/);
});

test('detectTestCommand：六种工程类型各认一条', () => {
  const probe = (files: Record<string, string>) => ({
    exists: (path: string) => path in files,
    readText: (path: string) => files[path],
  });

  assert.deepEqual(
    detectTestCommand(probe({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })),
    { command: 'npm test', source: 'package.json scripts.test' },
  );
  // 锁文件决定入口：pnpm 项目跑 npm test 会得到"测试全部失败"的假结果
  assert.equal(detectTestCommand(probe({ 'package.json': '{"scripts":{"test":"x"}}', 'pnpm-lock.yaml': '' }))?.command, 'pnpm test');
  assert.equal(detectTestCommand(probe({ 'package.json': '{"scripts":{"test":"x"}}', 'yarn.lock': '' }))?.command, 'yarn test');
  assert.equal(detectTestCommand(probe({ 'go.mod': '' }))?.command, 'go test ./...');
  assert.equal(detectTestCommand(probe({ 'Cargo.toml': '' }))?.command, 'cargo test');
  assert.equal(detectTestCommand(probe({ 'pyproject.toml': '[tool.pytest.ini_options]' }))?.command, 'python3 -m pytest -q');
  assert.equal(detectTestCommand(probe({ Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n' }))?.command, 'make test');
  // 没有任何测试配置 → undefined（指令会退回「先探测」）
  assert.equal(detectTestCommand(probe({ 'README.md': '# hi' })), undefined);
  // package.json 没有 scripts.test 时不要瞎猜
  assert.equal(detectTestCommand(probe({ 'package.json': '{"scripts":{"build":"x"}}' })), undefined);
});

test('识别「发布」时只给发布指令，不再叠加 git 指令（避免两条打架）', () => {
  const kinds = detectPlaybooks('发布成 0.5.0 并推送', { looksLikeImage }).map((item) => item.kind);
  assert.ok(kinds.includes('release'));
  assert.equal(kinds.includes('git-write'), false, '发布包含 git，但规矩更严，只保留 release');
  const release = detectPlaybooks('发布成 0.5.0', { looksLikeImage })[0]!;
  assert.match(release.directive, /ask_user_choice|先问/, '版本号必须先确认');
  assert.match(release.directive, /npm version/, '要明确禁止 npm version 自己改文件');
});

test('识别「敏感配置」，首选读模板而不是真 .env', () => {
  for (const text of ['读一下 .env 看配置', '检查 API key 配置', '这个 token 在哪配']) {
    const kinds = detectPlaybooks(text, { looksLikeImage }).map((item) => item.kind);
    assert.ok(kinds.includes('sensitive-config'), `应识别为敏感配置：${text}`);
  }
  const playbook = detectPlaybooks('读一下 .env', { looksLikeImage }).find((item) => item.kind === 'sensitive-config')!;
  assert.deepEqual(playbook.preferred, ['read_file', 'search_files']);
  assert.match(playbook.directive, /\.env\.example/);
  assert.match(playbook.directive, /不要\*\*用 `run_command`/, '必须禁止 cat .env');
});

test('写意图统一关闭收窄（跑测试失败就修 / 读配置再加变量 都要能写）', () => {
  for (const [text, writeText] of [
    ['跑一下测试', '跑一下测试，失败就修好'],
    ['读一下 .env', '读一下 .env 再加一个变量'],
    ['先给我预览一下效果', '预览效果顺便把标题改大'],
  ]) {
    const readOnly = detectPlaybooks(text, { looksLikeImage });
    const withWrite = detectPlaybooks(writeText, { looksLikeImage });
    const names = ['read_file', 'write_file', 'delete_file', 'run_command'];
    assert.equal(hasWriteIntent(text), false, `${text} 不该算写意图`);
    assert.equal(hasWriteIntent(writeText), true, `${writeText} 应算写意图`);
    assert.equal(narrowToolNames(names, readOnly, false).includes('write_file'), false, `${text} 应拿走写工具`);
    assert.deepEqual(narrowToolNames(names, withWrite, true), names, `${writeText} 必须保留写工具`);
  }
});

test('六类任务都在守护范围内，没有遗漏的「会被拒」路径', () => {
  // 这一条不是验证某个行为，而是钉住"审计过的清单"：新增一类就必须同时更新这里，
  // 否则审计表会和实现脱节（上一版就出过 blocked 名单为空却声称硬拒的事）。
  const kinds = new Set<string>();
  for (const text of ['先给我预览一下效果', '生成一张海报', '提交并推送', '跑一下测试', '发布成 0.5.0', '读一下 .env']) {
    for (const playbook of detectPlaybooks(text, { looksLikeImage })) kinds.add(playbook.kind);
  }
  assert.deepEqual([...kinds].sort(), [
    'git-write', 'image-generation', 'release', 'sensitive-config', 'test-run', 'web-preview',
  ]);
});
