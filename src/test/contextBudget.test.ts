import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_OVER_RATIO,
  CONTEXT_WARN_RATIO,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  contextLoad,
  estimateTokens,
} from '../core/contextBudget';

test('字节换算成 tokens（4:1）', () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(4000), 1000);
  assert.equal(estimateTokens(-10), 0);
  assert.equal(estimateTokens(Number.NaN), 0);
});

test('三档：正常 / 该提醒 / 该开新对话', () => {
  const budget = 100_000;
  assert.equal(contextLoad(10_000, budget).level, 'ok');
  assert.equal(contextLoad(budget * CONTEXT_WARN_RATIO, budget).level, 'warn');
  assert.equal(contextLoad(budget * CONTEXT_OVER_RATIO, budget).level, 'over');
  // 边界：刚好 70% 算提醒，刚好 90% 算该换。
  assert.equal(contextLoad(70_000, budget).level, 'warn');
  assert.equal(contextLoad(90_000, budget).level, 'over');
});

test('百分比超过 100 也照实报（不夹到 100，界面才知道超了多少）', () => {
  const load = contextLoad(250_000, 100_000);
  assert.equal(load.percent, 250);
  assert.equal(load.level, 'over');
});

test('脏输入不会算出 NaN 或负百分比', () => {
  for (const [tokens, budget] of [[Number.NaN, 1000], [-5, 1000], [10, 0], [10, Number.NaN]] as const) {
    const load = contextLoad(tokens, budget);
    assert.ok(Number.isFinite(load.percent), `${tokens}/${budget}`);
    assert.ok(load.percent >= 0, `${tokens}/${budget}`);
    assert.ok(load.budget > 0, `${tokens}/${budget}`);
  }
  assert.equal(contextLoad(1_000, 0).budget, DEFAULT_CONTEXT_TOKEN_BUDGET);
});

test('空对话是 0%，不会误报提醒', () => {
  const load = contextLoad(0);
  assert.equal(load.percent, 0);
  assert.equal(load.level, 'ok');
});
