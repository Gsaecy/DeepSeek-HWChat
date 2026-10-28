/**
 * 步数预算与思考深度分档的单元测试。
 *
 * 现场：工具条上要提供四档步数（24 / 68 / 120 / 无限制）与四档思考深度
 * （低 / 中 / 高 / 最大）。这两套档位一旦「界面能选、运行时按别的值跑」，
 * 用户会得到比不提供选项更糟的体验：显示无限制却停在 24 步、选了「中」
 * 却按「高」发送。这里逐条锁住归一化与换算规则。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_MAX_STEPS_UNLIMITED,
  AGENT_STEP_PRESETS,
  AGENT_STEP_SAFETY_CAP,
  DEFAULT_AGENT_MAX_STEPS,
  agentStepBudget,
  isUnlimitedSteps,
  normalizeAgentMaxSteps,
} from '../core/agentLimits';
import { isReasoningEffort, resolveConversationControls } from '../core/conversationControls';
import { normalizeReasoningEffort } from '../core/settings';

test('步数预设就是四档：24 / 68 / 120 / 无限制（0）', () => {
  assert.deepEqual([...AGENT_STEP_PRESETS], [24, 68, 120, 0]);
  assert.equal(AGENT_MAX_STEPS_UNLIMITED, 0);
  // 四档互不重复，且都在安全范围里（0 之外都 ≤ 上限）。
  assert.equal(new Set(AGENT_STEP_PRESETS).size, AGENT_STEP_PRESETS.length);
  for (const steps of AGENT_STEP_PRESETS) {
    assert.ok(steps === 0 || steps <= AGENT_STEP_SAFETY_CAP, `${steps} 超过上限`);
  }
});

test('默认预算仍是 24 步', () => {
  assert.equal(DEFAULT_AGENT_MAX_STEPS, 24);
  assert.equal(normalizeAgentMaxSteps(undefined), 24);
  assert.equal(normalizeAgentMaxSteps(null), 24);
  assert.equal(normalizeAgentMaxSteps(''), 24);
  assert.equal(normalizeAgentMaxSteps('abc'), 24);
});

test('0 是「无限制」，负数 / 非数字才是脏值', () => {
  assert.equal(normalizeAgentMaxSteps(0), AGENT_MAX_STEPS_UNLIMITED);
  assert.equal(isUnlimitedSteps(0), true);
  assert.equal(isUnlimitedSteps(24), false);
  assert.equal(normalizeAgentMaxSteps(-1), DEFAULT_AGENT_MAX_STEPS);
  assert.equal(normalizeAgentMaxSteps(-0.5), DEFAULT_AGENT_MAX_STEPS);
  // 数字字符串按数字读（settings.json 里手写成 "40" 也能用），空串不算 0。
  assert.equal(normalizeAgentMaxSteps('40'), 40);
  assert.equal(normalizeAgentMaxSteps('0'), AGENT_MAX_STEPS_UNLIMITED);
  assert.equal(normalizeAgentMaxSteps(true), DEFAULT_AGENT_MAX_STEPS);
});

test('有限预算取整并夹到安全上限', () => {
  assert.equal(normalizeAgentMaxSteps(24), 24);
  assert.equal(normalizeAgentMaxSteps(68), 68);
  assert.equal(normalizeAgentMaxSteps(120), 120);
  assert.equal(normalizeAgentMaxSteps(68.9), 68);
  assert.equal(normalizeAgentMaxSteps(10_000), AGENT_STEP_SAFETY_CAP);
});

test('循环预算：无限制换算成 Infinity，有限预算保持原值', () => {
  assert.equal(agentStepBudget(0), Number.POSITIVE_INFINITY);
  assert.equal(agentStepBudget(24), 24);
  assert.equal(agentStepBudget(undefined), DEFAULT_AGENT_MAX_STEPS);
  // 无限制也必须挡住脏值：负数不能变成 Infinity。
  assert.equal(agentStepBudget(-1), DEFAULT_AGENT_MAX_STEPS);
});

test('思考深度四档都能通过归一化与对话控制校验', () => {
  for (const effort of ['low', 'medium', 'high', 'max'] as const) {
    assert.equal(normalizeReasoningEffort(effort), effort);
    assert.equal(isReasoningEffort(effort), true);
  }
  // 旧值仍可用：'default' = 不发送参数，'none' = 关闭思考（本轮界面不再提供）。
  assert.equal(normalizeReasoningEffort('default'), 'default');
  assert.equal(normalizeReasoningEffort('none'), 'none');
  assert.equal(normalizeReasoningEffort('ultra'), 'default');
});

test('对话控制继承「无限制」而不是把它当脏值丢掉', () => {
  const defaults = { permissionPreset: 'askAll' as const, agentMaxSteps: 24, reasoningEffort: 'high' as const };
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: 0 }).agentMaxSteps, 0);
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: 68 }).agentMaxSteps, 68);
  assert.equal(resolveConversationControls(defaults, { agentMaxSteps: -3 }).agentMaxSteps, 24);
  // 新对话默认：每次询问 + 24 步 + 高。
  const fresh = resolveConversationControls(defaults, {});
  assert.deepEqual(fresh, { permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'high' });
});
