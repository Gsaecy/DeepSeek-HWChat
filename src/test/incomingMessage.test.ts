import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { INCOMING_MESSAGE_SPECS, SETTINGS_INCOMING_MESSAGE_SPECS, validateIncomingMessage, validateSettingsIncomingMessage } from '../core/incomingMessage';

const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const SETTINGS_PANEL = readFileSync('src/views/settingsPanel.ts', 'utf8');

/**
 * 从 `chatPanel.ts` 的联合类型里抽出所有 `type: 'xxx'`。
 *
 * 规格表是**运行时**的一份，联合类型是编译期的一份；不这么对拍，
 * 以后加一条消息忘了登记，宿主会静默丢掉它 —— 表现成「点了没反应」，
 * 最难查的一类故障。
 */
function unionTypes(): string[] {
  const start = PANEL.indexOf('type IncomingMessage =');
  assert.ok(start > 0, 'chatPanel.ts 里必须仍有 IncomingMessage 联合类型');
  const end = PANEL.indexOf("| { type: 'exportConversation' };", start);
  assert.ok(end > start, '联合类型必须仍以 exportConversation 结尾（改结尾要同步本测试）');
  const block = PANEL.slice(start, end + 40);
  return [...block.matchAll(/type: '([A-Za-z]+)'/g)].map((match) => match[1]!);
}

test('规格表与联合类型逐条对拍，谁都不能多、不能少', () => {
  const declared = unionTypes();
  assert.ok(declared.length >= 50, `联合类型应仍有 50+ 条消息，实际 ${declared.length}`);
  const missing = declared.filter((type) => !Object.hasOwn(INCOMING_MESSAGE_SPECS, type));
  const extra = Object.keys(INCOMING_MESSAGE_SPECS).filter((type) => !declared.includes(type));
  assert.deepEqual(missing, [], `联合类型里有、规格表里漏登记：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `规格表里有、联合类型里已删除：${extra.join(', ')}`);
});

test('宿主读到的每个入站消息入口都必须先校验', () => {
  // 只有一处入口：onDidReceiveMessage。校验必须在那条回调里，不能散落到各分支。
  const index = PANEL.indexOf('.onDidReceiveMessage(');
  assert.ok(index > 0, '面板必须仍用 onDidReceiveMessage 收消息');
  const snippet = PANEL.slice(index, index + 900);
  assert.match(snippet, /validateIncomingMessage\(/, '入口必须先过运行时校验');
  assert.match(snippet, /if \(!verdict\.ok\)/, '校验失败必须整条丢弃');
});

test('非对象 / 数组 / 缺类型一律拒绝', () => {
  for (const raw of [null, undefined, 42, 'send', [], true]) {
    assert.equal(validateIncomingMessage(raw).ok, false, `${String(raw)} 不该通过`);
  }
  assert.equal(validateIncomingMessage({}).ok, false);
  assert.equal(validateIncomingMessage({ type: '' }).ok, false);
  assert.equal(validateIncomingMessage({ type: 123 }).ok, false);
});

test('未登记的类型被拒绝，而不是静默放过', () => {
  const verdict = validateIncomingMessage({ type: 'runArbitraryCommand' });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /unknown message type/);
});

test('原型链上的方法名不会被当成已登记类型', () => {
  for (const type of ['toString', 'valueOf', 'hasOwnProperty', 'constructor']) {
    assert.equal(validateIncomingMessage({ type }).ok, false, `${type} 不该通过`);
  }
});

test('__proto__ / prototype / constructor 作为键一律拒绝', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const payload = JSON.parse(`{"type":"stop","${key}":{"polluted":true}}`);
    const verdict = validateIncomingMessage(payload);
    assert.equal(verdict.ok, false, `${key} 不该通过`);
    assert.match((verdict as { reason: string }).reason, /forbidden key/);
  }
});

test('类型对、形状错的消息被拒绝（这是 webview 被注入后的典型形态）', () => {
  const cases: unknown[] = [
    // 布尔位传字符串：旧代码 `Boolean(message.pinned)` 会把它当 true。
    { type: 'togglePin', id: 'c1', pinned: 'false' },
    // 必填缺失。
    { type: 'deleteConversation' },
    // 数组位传 null：宿主 `.map` 直接抛白屏。
    { type: 'attachClipboardFiles', files: null },
    // 数组里混进对象。
    { type: 'send', text: 'hi', skillIds: [1, 2] },
    // 枚举越界。
    { type: 'setMode', mode: 'god-mode' },
    { type: 'setPermissionPreset', permissionPreset: 'everything' },
    { type: 'setReasoningEffort', reasoningEffort: 'infinite' },
    // NaN 不是合法的数字字段。
    { type: 'setAgentMaxSteps', agentMaxSteps: Number.NaN },
    { type: 'removeAttachment', index: Number.POSITIVE_INFINITY },
    // 对象位传数组。
    { type: 'layoutReport', report: [] },
    // body 不是对象。
    { type: 'requestImageData', requestId: 'r1', src: 42 },
  ];
  for (const payload of cases) {
    assert.equal(validateIncomingMessage(payload).ok, false, `${JSON.stringify(payload)} 不该通过`);
  }
});

test('正常消息全部放行，且可选字段缺失不影响', () => {
  const good: unknown[] = [
    { type: 'ready' },
    { type: 'newChat' },
    { type: 'send', text: 'hi' },
    { type: 'send', text: 'hi', mode: 'agent', skillIds: ['a', 'b'], permissionPreset: 'review', agentMaxSteps: 8, reasoningEffort: 'high' },
    { type: 'approvalResponse', requestId: 'approval-1', allow: true },
    { type: 'decisionResponse', requestId: 'decision-1', chosenIndex: 0 },
    { type: 'renameConversation', title: '新标题' },
    { type: 'renameConversation', id: 'c1', title: '新标题' },
    { type: 'openAttachment', path: '/tmp/a.png' },
    { type: 'copyText', text: 'x' },
    { type: 'attachClipboardFiles', files: [] },
    { type: 'verifyFileReferences', requestId: 'r', items: [] },
    { type: 'exportConversation' },
  ];
  for (const payload of good) {
    assert.equal(validateIncomingMessage(payload).ok, true, `${JSON.stringify(payload)} 应当放行`);
  }
});

test('JSON 往返后的合法消息仍通过（webview 实际走的就是结构化克隆）', () => {
  const payload = { type: 'revealFile', path: '/tmp/a.ts', line: 12 };
  assert.equal(validateIncomingMessage(JSON.parse(JSON.stringify(payload))).ok, true);
});

/**
 * 设置页那一侧：`save` 会带着明文 API Key 进来，`clearLocalData` 会删存档，
 * 所以同一套形状校验必须也装在设置页上。
 */
function settingsUnionTypes(): string[] {
  const start = SETTINGS_PANEL.indexOf('type IncomingMessage =');
  assert.ok(start > 0, 'settingsPanel.ts 里必须仍有 IncomingMessage 联合类型');
  const end = SETTINGS_PANEL.indexOf("| { type: 'openNativeSettings' };", start);
  assert.ok(end > start, '设置页联合类型必须仍以 openNativeSettings 结尾（改结尾要同步本测试）');
  return [...SETTINGS_PANEL.slice(start, end + 40).matchAll(/type: '([A-Za-z]+)'/g)].map((match) => match[1]!);
}

test('设置页：规格表与联合类型逐条对拍', () => {
  const declared = settingsUnionTypes();
  assert.ok(declared.length >= 10, `设置页应仍有 10+ 条消息，实际 ${declared.length}`);
  const missing = declared.filter((type) => !Object.hasOwn(SETTINGS_INCOMING_MESSAGE_SPECS, type));
  const extra = Object.keys(SETTINGS_INCOMING_MESSAGE_SPECS).filter((type) => !declared.includes(type));
  assert.deepEqual(missing, [], `联合类型里有、规格表里漏登记：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `规格表里有、联合类型里已删除：${extra.join(', ')}`);
});

test('设置页：入口先校验，且两个面板都补齐了 CSP', () => {
  const index = SETTINGS_PANEL.indexOf('.onDidReceiveMessage(');
  assert.ok(index > 0);
  const snippet = SETTINGS_PANEL.slice(index, index + 900);
  assert.match(snippet, /validateSettingsIncomingMessage\(/);
  assert.match(snippet, /if \(!verdict\.ok\)/);
  for (const [name, source] of [['对话面板', PANEL], ['设置页', SETTINGS_PANEL]] as const) {
    assert.match(source, /base-uri 'none'; form-action 'none'/, `${name} 的 CSP 必须补齐这两条`);
  }
});

test('设置页：明文 Key 的形状不对就整条丢弃', () => {
  const bad: unknown[] = [
    // 有 `save` 却没有 settings。
    { type: 'save' },
    // settings 传数组。
    { type: 'save', settings: [] },
    // apiKeys 不是「字符串 → 字符串」。
    { type: 'save', settings: {}, apiKeys: { default: 123 } },
    { type: 'save', settings: {}, apiKeys: ['sk-1'] },
    { type: 'save', settings: {}, clearApiKeyIds: 'default' },
    { type: 'save', settings: {}, clearEmbeddingKeyIds: [1] },
    { type: 'probeEmbeddings', settings: {}, apiKeys: null, embeddingApiKey: 42 },
    { type: 'test', settings: 'oops' },
    // 未登记的类型一样拒绝。
    { type: 'setBaseUrl', url: 'https://evil.example' },
  ];
  for (const payload of bad) {
    assert.equal(validateSettingsIncomingMessage(payload).ok, false, `${JSON.stringify(payload)} 不该通过`);
  }
  const good: unknown[] = [
    { type: 'ready' },
    { type: 'save', settings: {}, apiKeys: { default: 'sk-1' } },
    { type: 'save', settings: { model: 'x' }, clearApiKeyIds: ['default'] },
    { type: 'probeEmbeddings', settings: {}, embeddingApiKey: 'sk-e' },
    { type: 'clearLocalData' },
    { type: 'openNativeSettings' },
  ];
  for (const payload of good) {
    assert.equal(validateSettingsIncomingMessage(payload).ok, true, `${JSON.stringify(payload)} 应当放行`);
  }
});

test('两份规格表互不串用（对话面板不接受设置页消息，反之亦然）', () => {
  assert.equal(validateIncomingMessage({ type: 'save', settings: {} }).ok, false);
  assert.equal(validateIncomingMessage({ type: 'clearLocalData' }).ok, false);
  assert.equal(validateSettingsIncomingMessage({ type: 'approvalResponse', requestId: 'a', allow: true }).ok, false);
  assert.equal(validateSettingsIncomingMessage({ type: 'attachClipboardFiles', files: [] }).ok, false);
});
