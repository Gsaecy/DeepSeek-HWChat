import assert from 'node:assert/strict';
import test from 'node:test';
import { STALL_CEILING_SECONDS, stallExtended, stallIdleSeconds } from '../core/requestBudget';

test('小请求几乎不改变用户设置，也不打「已放宽」的提示', () => {
  // 3 KB ≈ 750 tokens，预填 1 秒 —— 多这 1 秒没有意义，也不该提示用户。
  const seconds = stallIdleSeconds(3_000, 120);
  assert.ok(seconds >= 120 && seconds <= 122, `实际 ${seconds}`);
  assert.equal(stallExtended(3_000, 120), false);
});

test('1.03M tokens 的请求会被放宽到上限（真实故障的规模）', () => {
  // 1.03M tokens ≈ 4.1M 字符。旧实现固定 120 秒 → 必被判「卡住」（用户 2026-11-09）。
  const chars = 4_120_000;
  const seconds = stallIdleSeconds(chars, 120);
  assert.equal(seconds, STALL_CEILING_SECONDS);
  assert.ok(seconds > 120, '大请求的沉默时间必须放宽，否则 prefill 期间就会被误杀');
  assert.equal(stallExtended(chars, 120), true);
});

test('放宽随请求体单调增长，且永远不超过上限', () => {
  const sizes = [0, 10_000, 100_000, 1_000_000, 4_000_000, 40_000_000];
  let previous = 0;
  for (const chars of sizes) {
    const seconds = stallIdleSeconds(chars, 120);
    assert.ok(seconds >= previous, `请求越大允许的沉默不能变短：${chars}`);
    assert.ok(seconds <= STALL_CEILING_SECONDS, `不能超过上限：${chars} → ${seconds}`);
    previous = seconds;
  }
});

test('用户自己把超时调大时以他为准（下限仍然是设置值）', () => {
  assert.equal(stallIdleSeconds(0, 300), 300);
  assert.ok(stallIdleSeconds(4_000_000, 300) >= 300);
});

test('脏输入不会算出负数或 NaN', () => {
  assert.equal(stallIdleSeconds(Number.NaN, 120), 120);
  assert.equal(stallIdleSeconds(-5, 120), 120);
  assert.equal(stallIdleSeconds(0, Number.NaN), 120);
  assert.ok(Number.isFinite(stallIdleSeconds(1_000, Number.NaN)));
  // 设置成 0 时兜底成 1 秒下限，而不是 0（0 会让 withDeadline 立刻触发）。
  assert.ok(stallIdleSeconds(1_000, 0) >= 1);
});
