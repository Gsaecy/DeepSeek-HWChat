import assert from 'node:assert/strict';
import test from 'node:test';
import { controlChangeScope, isReasoningEffort, resolveConversationControls } from '../core/conversationControls';
import { AGENT_STEP_SAFETY_CAP, DEFAULT_AGENT_MAX_STEPS } from '../core/agentLimits';

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

test('controls: step limits treat 0 as "unlimited" and still reject dirty values', () => {
  // 0 是工具条上的第四档「无限制」，是显式选择，必须原样保留。
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: 0 }).agentMaxSteps, 0);
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: 12.9 }).agentMaxSteps, 12);
  // 脏数据（字符串 / 负数）仍然回落到默认值，而不是变成「无限步」。
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: '99' as unknown }).agentMaxSteps, 40);
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: -1 }).agentMaxSteps, 40);
  // 默认值本身是负数 / 非法时，落到硬默认 24，而不是 0。
  assert.equal(resolveConversationControls({ ...defaults, agentMaxSteps: -1 }, {}).agentMaxSteps, DEFAULT_AGENT_MAX_STEPS);
  // 全局默认值就是「无限制」时，新对话继承它。
  assert.equal(resolveConversationControls({ ...defaults, agentMaxSteps: 0 }, {}).agentMaxSteps, 0);
  // 超过绝对上限的存档值被夹到上限。
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: 10_000 }).agentMaxSteps, AGENT_STEP_SAFETY_CAP);
});

test('controls: invalid reasoning falls back to the configured default, not to "default"', () => {
  assert.equal(resolveConversationControls(defaults, { reasoningEffort: 'ultra' }).reasoningEffort, 'high');
  assert.equal(resolveConversationControls(defaults, { reasoningEffort: 'none' }).reasoningEffort, 'none');
  assert.equal(resolveConversationControls(defaults, { reasoningEffort: 'default' }).reasoningEffort, 'default');
});

test('controls: isReasoningEffort accepts exactly the six supported values', () => {
  // 四档深度（low/medium/high/max）+ 两个旧值（default = 不发送参数，none = 关闭思考）。
  for (const value of ['default', 'none', 'low', 'medium', 'high', 'max']) {
    assert.ok(isReasoningEffort(value), `${value} 应当合法`);
  }
  for (const value of ['ultra', '', undefined, null, 3]) {
    assert.equal(isReasoningEffort(value), false);
  }
});

/**
 * 运行中改「最大步骤 / 思考深度」的生效范围。
 *
 * 与权限预设同一套语义：正在跑的这轮用运行开始时的设置快照，所以新值只对
 * 下一次发送生效。以前这两个下拉在运行中直接被禁用，用户只能等这一轮跑完。
 */
test('controlChangeScope：没有运行中的任务时立刻生效', () => {
  assert.equal(controlChangeScope({ runningValue: undefined, requested: 24 }), 'immediate');
});

test('controlChangeScope：运行中改成别的值 → 只对下一次发送生效', () => {
  assert.equal(controlChangeScope({ runningValue: 24, requested: 68 }), 'next-send-only');
  assert.equal(controlChangeScope({ runningValue: 'default', requested: 'high' }), 'next-send-only');
});

test('controlChangeScope：选回和当前运行相同的值 → 不需要提示「下一次生效」', () => {
  assert.equal(controlChangeScope({ runningValue: 24, requested: 24 }), 'immediate');
  assert.equal(controlChangeScope({ runningValue: 'high', requested: 'high' }), 'immediate');
});
