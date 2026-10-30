import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  AGENT_STEP_PRESETS,
  MAX_TOOL_CALLS_PER_RUN,
  agentStepBudget,
} from '../core/agentLimits';

/**
 * 单次运行的工具调用总数：**不设限**。
 *
 * 现场需求（2026-10-30）：用户已经选了「无限制」，跑到第 200 个工具调用时仍被
 * 「工具调用次数已达安全上限」打断一次；按档位放宽到 1000 之后仍然会在长任务里
 * 再断一次。原话：「执行次数多了，每次运行命令都弹窗，很麻烦，请所有循环轮数
 * 情况下，将单次运行工具调用总数都设置为不限制。」
 *
 * 所以这里的契约是：**任何步数档位都不再有运行总量闸门**，循环只在
 * 「模型不再调用工具 / 单轮节流 / 死循环守卫 / 连续无进展 / 用户停止」时结束。
 */

const RUNNER = readFileSync('src/agent/agentRunner.ts', 'utf8');
const LIMITS = readFileSync('src/core/agentLimits.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

test('运行总量：常量就是不限制（不是某个更大的数字）', () => {
  assert.equal(MAX_TOOL_CALLS_PER_RUN, Number.POSITIVE_INFINITY);
  assert.equal(Number.isFinite(MAX_TOOL_CALLS_PER_RUN), false, '要真的是无穷，不是「更大的有限值」');
});

test('运行总量：四个档位全都不限制（24 / 68 / 120 / 无限制）', () => {
  assert.deepEqual([...AGENT_STEP_PRESETS], [24, 68, 120, 0], '档位本身不变');
  // 轮数预算仍然分档：有限档位有自己的步数上限，无限制档位才是 Infinity。
  assert.equal(agentStepBudget(24), 24);
  assert.equal(agentStepBudget(68), 68);
  assert.equal(agentStepBudget(120), 120);
  assert.equal(agentStepBudget(0), Number.POSITIVE_INFINITY);
  // 但工具调用总量对所有档位都没有闸门 —— 常量只有一份，不随档位变化。
  assert.equal(LIMITS.includes('toolCallBudgetForSteps'), false, '按档位分配运行总量的函数已经移除');
});

test('运行总量：循环里没有「累计调用数 >= 上限」这类判断', () => {
  assert.equal(/totalToolCalls/.test(RUNNER), false, '累计计数器已经删掉，不能留下半截');
  assert.equal(/maxToolCalls/.test(RUNNER), false, '不能再有运行总量变量');
  assert.equal(/stopReason = 'toolBudget'/.test(RUNNER), false, '不能再因为调用次数停下');
  assert.equal(/'toolBudget'/.test(RUNNER), false, 'stopReason 联合类型里也不该再有这一项');
  assert.equal(/agent\.toolCallBudget/.test(RUNNER), false, '对应的提示文案已经不存在');
  assert.equal(I18N.includes("'agent.toolCallBudget'"), false, '文案表里也要清掉，避免留一个永远不显示的键');
});

test('运行总量：旧的两档常量不再对外导出（避免被误当成仍然生效）', () => {
  assert.equal(LIMITS.includes('MAX_TOOL_CALLS_PER_RUN_UNLIMITED'), false);
  const settings = readFileSync('src/core/settings.ts', 'utf8');
  assert.equal(settings.includes('MAX_TOOL_CALLS_PER_RUN_UNLIMITED'), false);
  assert.equal(settings.includes('toolCallBudgetForSteps'), false);
});

test('单轮节流还在：一次吐几十个调用仍然只执行 12 个', () => {
  assert.match(RUNNER, /export const MAX_TOOL_CALLS_PER_ROUND = 12;/);
  assert.match(RUNNER, /round\.toolCalls\.slice\(0, MAX_TOOL_CALLS_PER_ROUND\)/);
  assert.match(RUNNER, /round\.toolCalls\.slice\(MAX_TOOL_CALLS_PER_ROUND\)/);
});

test('单轮超限不再中断整次运行：只跳过并继续下一轮', () => {
  const from = RUNNER.indexOf('for (const skippedCall of overflow)');
  assert.ok(from > 0, '找不到 overflow 处理段');
  const block = RUNNER.slice(from, RUNNER.indexOf('consecutiveFailedRounds = roundFailed', from));
  assert.match(block, /agent\.toolBudgetSkipped/, '要给每个被跳过的调用写一条 tool 结果（否则历史非法）');
  assert.match(block, /if \(stopAfterRound\) break;/, '只有死循环/取消这类才结束');
  assert.equal(/overflow\.length \|\| stopAfterRound/.test(block), false, '不能再因为 overflow 就结束整次运行');
});

test('剩下的闸门仍在（不限制 ≠ 没有守卫）', () => {
  assert.match(RUNNER, /MAX_IDENTICAL_TOOL_CALLS = 3/, '同一调用连续 3 次仍判定死循环');
  assert.match(RUNNER, /MAX_FAILED_ROUNDS_WITHOUT_PROGRESS = 3/, '连续 3 轮全失败仍会停');
  assert.match(RUNNER, /this\.assertRunning\(options\.signal\)/, '停止按钮仍然优先');
});

test('文案：单轮跳过要说清是「本轮」而不是「本次运行」', () => {
  const line = I18N.split('\n').find((row) => row.includes("'agent.toolBudgetSkipped':"));
  assert.ok(line, '找不到 agent.toolBudgetSkipped');
  assert.match(line, /本轮/, '中文要说清是本轮');
  assert.match(line, /下一轮可继续/, '要告诉模型/用户下一步还能跑');
  assert.match(line, /this round/, '英文同样');
});
