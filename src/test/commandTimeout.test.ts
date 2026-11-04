/**
 * 命令超时：请求值被上限截断时必须说清楚。
 *
 * 现场（用户 2026-11-04）：
 *
 *     {"command":"cd \"…/Personal Workstation OS\" && cargo check … | tail -40", "timeoutSeconds": 900}
 *     → 超时（120 秒）·（无输出）
 *
 * 模型要 900 秒，设置 `hwchat.maxCommandSeconds` 是 120 秒，静默截断后结果里
 * 既没说是被截断、也没说可以调大或换后台跑 —— 只能再猜一次。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveTimeoutSeconds,
  timeoutAdvice,
  timeoutClampNotice,
  timeoutClampSummary,
} from '../agent/commandTimeout';
import { t as translate } from '../core/i18n';

const t = (key: string, values?: Record<string, string | number>): string =>
  `${key}${values ? `(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : ''}`;
const deps = { t, settingKey: 'hwchat.maxCommandSeconds', maxSeconds: 900 };

test('用户那次：要求 900、上限 120 → 生效 120 且标记为被截断', () => {
  const plan = effectiveTimeoutSeconds(900, 120);
  assert.deepEqual(plan, { requested: 900, effective: 120, clamped: true });
  assert.match(String(timeoutClampSummary(plan, t)), /requested=900,effective=120/);
  assert.match(String(timeoutClampNotice(plan, deps)), /requested=900,effective=120,setting=hwchat\.maxCommandSeconds/);
});

test('没传或没超上限时不产生任何提示', () => {
  const plan = effectiveTimeoutSeconds(undefined, 120);
  assert.deepEqual(plan, { requested: 120, effective: 120, clamped: false });
  assert.equal(timeoutClampNotice(plan, deps), undefined);
  assert.equal(timeoutClampSummary(plan, t), '');

  const under = effectiveTimeoutSeconds(60, 120);
  assert.equal(under.clamped, false);
  assert.equal(timeoutClampNotice(under, deps), undefined);
});

test('下限 5 秒、上限按设置；非法值退回上限', () => {
  assert.deepEqual(effectiveTimeoutSeconds(1, 120), { requested: 1, effective: 5, clamped: false });
  assert.deepEqual(effectiveTimeoutSeconds(120, 900), { requested: 120, effective: 120, clamped: false });
  assert.equal(effectiveTimeoutSeconds(Number.NaN, 120).effective, 120);
  assert.equal(effectiveTimeoutSeconds(900, Number.NaN).effective, 120, '设置坏了也退回默认 120');
});

test('上限本身被设置放大时，请求 900 完全生效（用户调过设置的情况）', () => {
  assert.deepEqual(effectiveTimeoutSeconds(900, 900), { requested: 900, effective: 900, clamped: false });
});

test('超时建议点名两个真实坑：| tail 缓冲、「等一会儿再重试」', () => {
  // 用真实词表：这条建议是给模型看的，渲染出来必须真的说清这三件事。
  const real = { t: (key: string, values?: Record<string, string | number>) => translate('zh', key, values), settingKey: 'hwchat.maxCommandSeconds', maxSeconds: 900 };
  const advice = timeoutAdvice(effectiveTimeoutSeconds(900, 120), real);
  assert.match(advice, /hwchat\.maxCommandSeconds/);
  assert.match(advice, /\| tail/, '必须点名 | tail 会缓冲输出');
  assert.match(advice, /background/);
  assert.match(advice, /tail -n 60/);
  assert.match(advice, /重试一定同样超时/);
  assert.match(advice, /120 秒/, '要写出生效值');

  const en = { t: (key: string, values?: Record<string, string | number>) => translate('en', key, values), settingKey: 'hwchat.maxCommandSeconds', maxSeconds: 900 };
  const english = timeoutAdvice(effectiveTimeoutSeconds(900, 120), en);
  assert.match(english, /\| tail/);
  assert.match(english, /hwchat\.maxCommandSeconds/);

  const notice = timeoutClampNotice(effectiveTimeoutSeconds(900, 120), real);
  assert.match(String(notice), /你要求 900 秒/);
  assert.match(String(notice), /只有 120 秒/);
});
