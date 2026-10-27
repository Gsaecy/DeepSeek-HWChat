import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * 「需要你做的」清单格式的两层保障。
 *
 * 回归的故障：模型把待办写成 `1. [ ] **动作**`，界面就把方括号原样显示出来。
 * 用户改过用户级 skill、也提醒过几轮，方括号照旧 —— 因为这条规则
 * 从来没有进过 HWChat 自己的系统提示词。
 *
 * 所以这里同时钉住两件事：
 * 1. 提示词里有硬规则（管「别写」）。
 * 2. 渲染层能剥掉有序列表的复选框标记（管「写了也不显示」）。
 */

interface FollowUpFormat {
  stripCheckboxMarker: (text: unknown) => string;
  listItemText: (marker: unknown, text: unknown) => string;
}

function loadFollowUpFormat(): FollowUpFormat {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/follow-up-format.js', 'utf8'), sandbox);
  const loaded = sandbox.HWChatFollowUpFormat as FollowUpFormat | undefined;
  assert.ok(loaded, 'media/follow-up-format.js 应挂载 HWChatFollowUpFormat');
  return loaded;
}

const format = loadFollowUpFormat();

test('剥掉截图里那种「数字 + 方括号」的标记', () => {
  // 用户截图里的原样：1. [ ] **先确认重载过没有**
  assert.equal(format.listItemText('1.', '[ ] **先确认重载过没有**'), '**先确认重载过没有**');
  assert.equal(format.listItemText('2)', '[x] **跑一次 sleep 200**'), '**跑一次 sleep 200**');
  // 没有空格、只有一个空格的写法都要认。
  assert.equal(format.stripCheckboxMarker('[] **动作**'), '**动作**');
  assert.equal(format.stripCheckboxMarker('[X] **动作**'), '**动作**');
});

test('不动真正的任务列表（无序列表保持原样）', () => {
  // GFM 的 `- [ ]` 是有意义的任务列表，剥掉会丢信息。
  assert.equal(format.listItemText('-', '[ ] 修复登录'), '[ ] 修复登录');
  assert.equal(format.listItemText('*', '[x] 已完成'), '[x] 已完成');
  assert.equal(format.listItemText('+', '[ ] 待办'), '[ ] 待办');
});

test('没有标记的正文一个字都不改', () => {
  assert.equal(format.stripCheckboxMarker('**动作**'), '**动作**');
  assert.equal(format.stripCheckboxMarker('先确认再决定'), '先确认再决定');
  // `[x]foo` 没有空白分隔，属于正文而不是标记，不能吃掉。
  assert.equal(format.stripCheckboxMarker('[x]foo'), '[x]foo');
  // 数组下标之类的写法不能被误伤。
  assert.equal(format.stripCheckboxMarker('arr[ ] 是空数组'), 'arr[ ] 是空数组');
});

test('异常输入不抛错', () => {
  assert.equal(format.stripCheckboxMarker(undefined), '');
  assert.equal(format.stripCheckboxMarker(null), '');
  assert.equal(format.stripCheckboxMarker(42), '');
  assert.equal(format.listItemText(undefined, '[ ] 动作'), '[ ] 动作');
  assert.equal(format.listItemText('1.', undefined), '');
});

test('提示词里有禁写复选框的硬规则', () => {
  const prompt = readFileSync('src/agent/followUpPrompt.ts', 'utf8');
  assert.match(prompt, /需要你做的/, '要写明收尾小节的标题');
  assert.match(prompt, /1\. \*\*动作\*\*/, '要给出正确写法');
  assert.match(prompt, /Never prefix an item with a checkbox marker/, '要明确禁止复选框标记');
});

test('提示词接进了系统提示词且排在历史摘要之前', () => {
  const panel = readFileSync('src/views/chatPanel.ts', 'utf8');
  assert.match(panel, /import \{ FOLLOW_UP_PROMPT \} from '\.\.\/agent\/followUpPrompt';/);
  const body = panel.slice(panel.indexOf('private agentSystemPrompt('));
  const promptAt = body.indexOf('FOLLOW_UP_PROMPT,');
  const historyAt = body.indexOf('historyPrompt,');
  assert.ok(promptAt > 0, '系统提示词要包含 FOLLOW_UP_PROMPT');
  assert.ok(historyAt > promptAt, '要排在对话历史摘要之前，不能被历史挤掉');
});

test('渲染模块注入在 chat.js 之前', () => {
  const panel = readFileSync('src/views/chatPanel.ts', 'utf8');
  const injected = panel.indexOf("src=\"${followUpFormatScript}\"");
  const chat = panel.indexOf("src=\"${script}\"");
  assert.ok(injected > 0, '页面要注入 follow-up-format.js');
  assert.ok(chat > injected, '注入必须早于 chat.js，否则加载时读不到模块');
});
