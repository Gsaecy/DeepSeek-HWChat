import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/** media/toast-timing.js 暴露的接口。 */
interface ToastTiming {
  toastDurationMs: (text: unknown, tone?: string) => number;
  readingUnits: (text: unknown) => number;
  MIN_MS: Record<string, number>;
  MAX_MS: number;
}

/**
 * 在 Node 里跑 webview 的纯函数脚本（和 calloutMeta / todo-panel-state 的做法一致）。
 *
 * 为什么要单独测这个函数：用户反馈「弹了一次但消失太快，没看清」。这类问题
 * 不可能靠人盯着界面判断「4.2 秒到底够不够」—— 只能把时长算成数字，然后钉住它。
 */
function loadToastTiming(): ToastTiming {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/toast-timing.js', 'utf8'), sandbox);
  const api = sandbox.HWChatToastTiming as ToastTiming | undefined;
  assert.ok(api, 'media/toast-timing.js 必须挂载 HWChatToastTiming');
  return api;
}

/** 真实的中文停滞提醒文案（对应 i18n 的 agent.commandStalled，seconds=30、timeout=55）。 */
const STALL_ZH = '有命令已 30 秒没有输出，可能卡在等待密码或确认。HWChat 无法替你输入，可在该步骤上点停止；到达 55 秒上限会自动终止。';

test('长警告必须读得完：中文停滞提醒远长于原来的 4.2 秒', () => {
  const api = loadToastTiming();
  const ms = api.toastDurationMs(STALL_ZH, 'warning');
  // 原来一律 4200ms，用户读不完。这条钉住「至少翻倍」。
  assert.ok(ms > 4200 * 2, `长警告应在 8.4 秒以上，实际 ${ms}ms`);
  assert.ok(ms >= 8000 && ms <= 12000, `长警告应落在 8–12 秒，实际 ${ms}ms`);
});

test('短提示维持原样：不会因为改造而变长', () => {
  const api = loadToastTiming();
  // 改动前短提示就是 4200ms；现在应是 neutral 下限 4000ms，体感不变。
  assert.equal(api.toastDurationMs('标题已保存', 'neutral'), 4000);
  assert.equal(api.toastDurationMs('Title saved', 'neutral'), 4000);
});

test('语气只抬下限：warning / error 比 neutral 更长', () => {
  const api = loadToastTiming();
  const text = '注意'; // 极短，长度不构成影响，只看下限
  assert.equal(api.toastDurationMs(text, 'neutral'), 4000);
  assert.equal(api.toastDurationMs(text, 'warning'), 6000);
  assert.equal(api.toastDurationMs(text, 'error'), 7000);
  // 未知语气按 neutral 处理，不能返回 NaN 或 0（那会让提示一闪而过或永不消失）。
  assert.equal(api.toastDurationMs(text, 'bogus'), 4000);
  assert.equal(api.toastDurationMs(text, undefined), 4000);
});

test('时长随文字量单调增长', () => {
  const api = loadToastTiming();
  let last = 0;
  for (const count of [10, 30, 60, 90]) {
    const ms = api.toastDurationMs('字'.repeat(count), 'warning');
    assert.ok(ms >= last, `${count} 字不应短于更短的文本（${ms} < ${last}）`);
    last = ms;
  }
  // 90 个汉字必须明显比 10 个长，否则等于没跟长度挂钩。
  assert.ok(last > api.toastDurationMs('字'.repeat(10), 'warning'));
});

test('封顶 20 秒：再长就不该用 toast 表达', () => {
  const api = loadToastTiming();
  assert.equal(api.toastDurationMs('字'.repeat(500), 'error'), 20000);
  assert.equal(api.toastDurationMs('x'.repeat(5000), 'warning'), 20000);
});

test('阅读单位：中文一字算一，拉丁按 0.4 折算', () => {
  const api = loadToastTiming();
  assert.equal(api.readingUnits('三个字'), 3);
  assert.equal(api.readingUnits('中文三字'), 4); // 这四个字都算，别把样本长度数错
  assert.equal(api.readingUnits('abcde'), 2); // 5 * 0.4
  assert.equal(api.readingUnits(''), 0);
  // 空值不能抛异常，也不能算成非零（会被当成"很长"而卡住 20 秒）。
  assert.equal(api.readingUnits(null), 0);
  assert.equal(api.readingUnits(undefined), 0);
});

test('英文长警告不会因为字符数多而失控', () => {
  const api = loadToastTiming();
  const en = 'A command has produced no output for 30s and may be waiting for a password or confirmation. HWChat cannot type it for you; stop it from that step if needed. It will be terminated automatically at the 55s limit.';
  const ms = api.toastDurationMs(en, 'warning');
  // 按字符折算后应落在 10–20 秒，而不是按「210 个字符 / 6」算出的 35 秒。
  assert.ok(ms >= 10000 && ms <= 20000, `英文长警告应落在 10–20 秒，实际 ${ms}ms`);
  assert.ok(ms < 20000, '不应顶到上限');
});
