import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONVERSATION_MODES,
  isConversationMode,
  modeLabel,
  modePromptInstruction,
  resolveActiveMode,
  resolveConversationMode,
} from '../core/modes';

test('模式：只认界面下拉里的三个值', () => {
  assert.deepEqual([...CONVERSATION_MODES], ['agent', 'plan', 'chat']);
  for (const mode of CONVERSATION_MODES) {
    assert.equal(isConversationMode(mode), true);
  }
  for (const value of ['Agent', 'PLAN', 'ask', '', ' agent', null, undefined, 0, {}, ['plan']]) {
    assert.equal(isConversationMode(value), false);
  }
});

test('模式：非法值回落到调用方给的默认值，默认值也非法时回落 agent', () => {
  assert.equal(resolveConversationMode('plan'), 'plan');
  assert.equal(resolveConversationMode('chat'), 'chat');
  assert.equal(resolveConversationMode(undefined, 'plan'), 'plan');
  assert.equal(resolveConversationMode('ask', 'chat'), 'chat');
  assert.equal(resolveConversationMode(null, 'nope' as never), 'agent');
});

test('模式：显示名与界面下拉完全一致', () => {
  assert.equal(modeLabel('agent'), 'Agent');
  assert.equal(modeLabel('plan'), 'Plan');
  assert.equal(modeLabel('chat'), 'Chat');
  assert.equal(modeLabel('weird' as never), 'Agent');
});

test('模式：提示词写清当前模式，并声明以本轮为准', () => {
  for (const [mode, label] of [['agent', 'Agent'], ['plan', 'Plan'], ['chat', 'Chat']] as const) {
    const prompt = modePromptInstruction(mode);
    assert.match(prompt, new RegExp(`Current HWChat mode: ${label}`));
    // 历史消息可能是在别的模式下发的，必须明确「以本轮为准」，否则模型会沿用旧假设。
    assert.match(prompt, /authoritative for the current turn/);
  }
});

test('模式：三种模式的工具边界互不相同', () => {
  const agent = modePromptInstruction('agent');
  const plan = modePromptInstruction('plan');
  const chat = modePromptInstruction('chat');
  assert.match(agent, /Use workspace tools/);
  assert.match(plan, /only read-only tools/);
  assert.match(plan, /Do not edit files/);
  assert.match(chat, /Do not call workspace tools/);
  assert.notEqual(agent, plan);
  assert.notEqual(plan, chat);
});

test('模式：非法模式按 Agent 生成提示词，不会退化成「没有模式说明」', () => {
  const prompt = modePromptInstruction('unknown' as never);
  assert.match(prompt, /Current HWChat mode: Agent/);
});

test('生效模式：存档 > 草稿选择 > 设置默认值 > agent', () => {
  // 已落库对话以自己的存档为准，草稿与设置都不该覆盖它。
  assert.equal(resolveActiveMode({ conversationMode: 'plan', draftOverride: 'chat', defaultMode: 'chat' }), 'plan');
  // 新对话：用户在工具条里选过就用它，哪怕设置里写的是别的。
  assert.equal(resolveActiveMode({ draftOverride: 'chat', defaultMode: 'agent' }), 'chat');
  // 新对话、没手动选过：跟随设置里的默认模式（这就是此前被忽略的那条）。
  assert.equal(resolveActiveMode({ defaultMode: 'plan' }), 'plan');
  // 全都没有：agent。
  assert.equal(resolveActiveMode({}), 'agent');
  // 非法值逐层回退，不能把脏值当模式用。
  assert.equal(resolveActiveMode({ conversationMode: 'PLAN', draftOverride: 'nope', defaultMode: 'chat' }), 'chat');
  assert.equal(resolveActiveMode({ conversationMode: '', draftOverride: null, defaultMode: undefined }), 'agent');
});
