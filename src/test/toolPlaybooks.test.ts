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

test('执行期硬拒：blocked 里点名的工具会被拒，并指出首选工具', () => {
  const withBlocked: ToolPlaybook = { ...preview(), blocked: ['run_in_terminal'] };
  const reason = blockedToolReason('run_in_terminal', [withBlocked], false);
  assert.ok(reason);
  assert.match(reason!, /run_command/, '必须告诉模型该用哪个');
  assert.equal(blockedToolReason('run_command', [withBlocked], false), undefined, '首选工具不能被拦');
  // 有写意图时不按写侧规则拦（与收窄同一套口径）
  assert.equal(blockedToolReason('run_in_terminal', [{ ...withBlocked, narrowWrites: true }], true), undefined);
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
