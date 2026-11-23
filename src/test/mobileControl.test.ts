import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOBILE_CODE_TTL_MS,
  MOBILE_SESSION_TTL_MS,
  MobileGate,
  escapeHtml,
  mobileCookie,
  parseCookies,
  renderMobilePage,
} from '../sync/mobileControl';

/** 手机遥控的「谁能进门」全部在这几个函数里，所以规则要一条条钉住。 */

function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
  };
}

test('手机进门：六位码换到会话令牌，且一个码只能用一次', () => {
  const time = clock();
  const gate = new MobileGate(time.now);
  const { code } = gate.currentCode();
  assert.match(code, /^\d{6}$/);

  const first = gate.redeem(code, '192.168.1.20');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(gate.authorize(first.token), true);

  // 同一张码再换一次：必须失败（否则旁观者拍下屏幕就能重放）
  const second = gate.redeem(code, '192.168.1.21');
  assert.equal(second.ok, false);
});

test('手机进门：输错五次锁五分钟，锁着时正确码也进不去', () => {
  const time = clock();
  const gate = new MobileGate(time.now);
  const { code } = gate.currentCode();

  for (let index = 0; index < 5; index += 1) {
    const result = gate.redeem('000000' === code ? '111111' : '000000', '10.0.0.9');
    assert.equal(result.ok, false);
  }
  const locked = gate.redeem(code, '10.0.0.9');
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.match(locked.error, /等几分钟/);

  // 换个来源不受影响，过了锁定期也能继续
  time.advance(5 * 60_000 + 1);
  const afterLock = gate.redeem(gate.currentCode().code, '10.0.0.9');
  assert.equal(afterLock.ok, true);
});

test('手机进门：验证码会过期，会话也会到期', () => {
  const time = clock();
  const gate = new MobileGate(time.now);
  const { code } = gate.currentCode();
  time.advance(MOBILE_CODE_TTL_MS + 1);
  const expired = gate.redeem(code, 'a');
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.match(expired.error, /已过期/);

  const fresh = gate.currentCode().code;
  const session = gate.redeem(fresh, 'a');
  assert.equal(session.ok, true);
  if (!session.ok) return;
  time.advance(MOBILE_SESSION_TTL_MS + 1);
  assert.equal(gate.authorize(session.token), false);
});

test('手机进门：换新码会让旧码立刻作废', () => {
  const gate = new MobileGate(clock().now);
  const old = gate.currentCode().code;
  const rotated = gate.rotate();
  assert.notEqual(rotated.code, old);
  assert.equal(gate.redeem(old, 'x').ok, false);
  assert.equal(gate.redeem(rotated.code, 'x').ok, true);
});

test('会话 Cookie 带 HttpOnly 与 SameSite=Strict，且能被解析回来', () => {
  const header = mobileCookie('abc123', 3600);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\//);
  const parsed = parseCookies(`other=1; ${header.split(';')[0]}`);
  assert.equal(parsed.plaitcode_m, 'abc123');
});

test('手机页面：未登录只给验证码表单，登录后给输入框，设备名被转义', () => {
  const guest = renderMobilePage({ device: 'PC', authed: false, canApprove: true });
  assert.match(guest, /id="login"/);
  assert.doesNotMatch(guest, /id="main"/);
  assert.match(guest, /inputmode="numeric"/);

  const inside = renderMobilePage({ device: 'PC', authed: true, canApprove: true });
  assert.match(inside, /id="main"/);
  assert.match(inside, /id="input"/);
  assert.match(inside, /var canApprove = true/);
  assert.doesNotMatch(inside, /id="login"/);

  const sneaky = renderMobilePage({ device: '<img src=x onerror=alert(1)>', authed: false, canApprove: false });
  assert.doesNotMatch(sneaky, /<img src=x/);
  assert.match(sneaky, /&lt;img src=x/);
});

test('转义：五个 HTML 元字符都处理', () => {
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});
