import assert from 'node:assert/strict';
import test from 'node:test';
import { isReasoningEffort, resolveConversationControls } from '../core/conversationControls';

const defaults = {
  permissionPreset: 'review' as const,
  agentMaxSteps: 40,
  reasoningEffort: 'high' as const,
};

test('controls: a conversation without overrides inherits the global defaults', () => {
  assert.deepEqual(resolveConversationControls(defaults), {
    permissionPreset: 'review',
    agentMaxSteps: 40,
    reasoningEffort: 'high',
  });
  assert.deepEqual(resolveConversationControls(defaults, {}), {
    permissionPreset: 'review',
    agentMaxSteps: 40,
    reasoningEffort: 'high',
  });
});

test('controls: conversation values win over global defaults (no cross-conversation pollution)', () => {
  const controls = resolveConversationControls(defaults, {
    permissionPreset: 'full',
    agentMaxSteps: 8,
    reasoningEffort: 'max',
  });
  assert.deepEqual(controls, { permissionPreset: 'full', agentMaxSteps: 8, reasoningEffort: 'max' });
  // 全局默认值本身不受影响：这是「互不污染」的关键断言。
  assert.equal(defaults.permissionPreset, 'review');
  assert.equal(defaults.agentMaxSteps, 40);
  assert.equal(defaults.reasoningEffort, 'high');
});

test('controls: an invalid preset falls back instead of creating a third state', () => {
  assert.equal(resolveConversationControls(defaults, { permissionPreset: 'custom' }).permissionPreset, 'review');
  assert.equal(resolveConversationControls(defaults, { permissionPreset: 1 }).permissionPreset, 'review');
});

test('controls: step limits keep 0 (unlimited) and reject garbage', () => {
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: 0 }).agentMaxSteps, 0);
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: 12.9 }).agentMaxSteps, 12);
  // 脏数据（字符串 / 负数）回落到默认值，而不是变成「无限步」。
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: '99' as unknown }).agentMaxSteps, 40);
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: -1 }).agentMaxSteps, 0);
});

test('controls: invalid reasoning falls back to the configured default, not to "default"', () => {
  assert.equal(resolveConversationControls(defaults, { reasoningEffort: 'ultra' }).reasoningEffort, 'high');
  assert.equal(resolveConversationControls(defaults, { reasoningEffort: 'none' }).reasoningEffort, 'none');
  assert.equal(resolveConversationControls(defaults, { reasoningEffort: 'default' }).reasoningEffort, 'default');
});

test('controls: isReasoningEffort accepts exactly the five supported values', () => {
  for (const value of ['default', 'none', 'low', 'high', 'max']) {
    assert.ok(isReasoningEffort(value), `${value} 应当合法`);
  }
  for (const value of ['medium', '', undefined, null, 3]) {
    assert.equal(isReasoningEffort(value), false);
  }
});
