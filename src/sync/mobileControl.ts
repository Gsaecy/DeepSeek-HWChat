/**
 * 手机遥控：进门凭证、状态打包、手机页面。
 *
 * 这里只放**纯逻辑**（不 import vscode、不碰网络），网络那层在 `lanSync.ts`，
 * 这样校验规则和页面都能在 Node 里直接测。
 *
 * 为什么手机端要单独一套凭证：局域网同步用的是「每个请求都带配对码」，
 * 那是机器对机器的用法；浏览器地址栏、历史记录、截图都会留下痕迹，
 * 所以手机走「一次性 6 位码 → 12 小时会话 Cookie」，码可以随时重发、作废。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SyncGroupMessage, SyncPeer } from './lanProtocol';

export const MOBILE_PATH = '/m';
export const MOBILE_COOKIE = 'plaitcode_m';
/** 6 位码的有效期：够你从电脑走到手机输完，又不至于长期贴在屏幕上。 */
export const MOBILE_CODE_TTL_MS = 10 * 60_000;
/** 会话有效期：一天一换，不用每次进页面都输码。 */
export const MOBILE_SESSION_TTL_MS = 12 * 60 * 60_000;
/** 同一来源连续输错这么多次就锁一段时间。 */
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;

export interface MobileApprovalView {
  id: string;
  title: string;
  summary: string;
  detail: string;
  /** `dangerous` 是删库、`curl | sh` 那类：手机上会单独标红。 */
  risk: 'read' | 'write' | 'command' | 'dangerous';
  at: number;
}

export interface MobileStatePayload {
  device: string;
  role: 'off' | 'hub' | 'peer';
  peers: SyncPeer[];
  messages: SyncGroupMessage[];
  openQuestion?: { requirementId: string; body: string };
  approvals: MobileApprovalView[];
  canApprove: boolean;
}

/** 6 位数字码 → 会话令牌。 */
export class MobileGate {
  private code = '';
  private codeExpires = 0;
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 生成（或沿用）当前 6 位码，电脑端显示这个码 / 用它拼二维码。 */
  issueCode(): { code: string; expiresAt: number } {
    if (!this.code || this.now() >= this.codeExpires) {
      this.code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
      this.codeExpires = this.now() + MOBILE_CODE_TTL_MS;
    }
    return { code: this.code, expiresAt: this.codeExpires };
  }

  currentCode(): { code: string; expiresAt: number } {
    return this.code ? { code: this.code, expiresAt: this.codeExpires } : this.issueCode();
  }

  /** 换一张新码（旧码立刻作废）。用户担心码泄露时点一下就行。 */
  rotate(): { code: string; expiresAt: number } {
    this.code = '';
    this.codeExpires = 0;
    return this.issueCode();
  }

  /**
   * 用 6 位码换会话令牌。
   *
   * 输错要计数：有人在同一 WiFi 上穷举六位数的话，最多试五次就被锁五分钟，
   * 穷举一百万种可能得花几年。
   */
  redeem(input: string, client = ''): { ok: true; token: string; expiresAt: number } | { ok: false; error: string } {
    const locked = this.lockUntil(client);
    if (locked > this.now()) return { ok: false, error: '试错太多次，请等几分钟再试。' };
    const current = this.currentCode();
    if (this.now() >= current.expiresAt) {
      this.issueCode();
      return { ok: false, error: '验证码已过期，请让电脑上重新显示。' };
    }
    const expected = Buffer.from(current.code, 'utf8');
    const actual = Buffer.from(String(input ?? '').replace(/\D/g, '').slice(0, 6).padEnd(expected.length, '\0'), 'utf8');
    const match = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!match) {
      this.fail(client);
      return { ok: false, error: '验证码不对，请看电脑上「手机遥控」窗口里的 6 位数字。' };
    }
    this.failures.delete(client);
    // 一个码只用一次：换完就失效，别人再看到这张码也进不来。
    this.code = '';
    const token = randomBytes(24).toString('hex');
    const expiresAt = this.now() + MOBILE_SESSION_TTL_MS;
    this.sessions.set(token, expiresAt);
    return { ok: true, token, expiresAt };
  }

  /** 会话是否还有效（顺手清掉过期的）。 */
  authorize(token: string | undefined): boolean {
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (this.now() >= expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  lockUntil(client: string): number {
    return this.failures.get(client)?.until ?? 0;
  }

  private fail(client: string): void {
    const entry = this.failures.get(client) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.count = 0;
      entry.until = this.now() + LOCK_MS;
    }
    this.failures.set(client, entry);
  }
}

/** 浏览器 Cookie 头 → 键值对。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    result[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

/**
 * 会话 Cookie。
 *
 * `HttpOnly` 防页面脚本偷；`SameSite=Strict` 防别的网站拿用户的浏览器发请求。
 * 局域网是明文 HTTP，所以这里没有 `Secure` —— 手机上会看到「不安全」，
 * 这是局域网直连的真实代价，走隧道时才有 HTTPS。
 */
export function mobileCookie(token: string, maxAgeSeconds: number): string {
  const base = `${MOBILE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
  return base;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 手机页面：一个文件装完，没有外部资源，断网也能打开（只是看不到新消息）。 */
export function renderMobilePage(options: { device: string; authed: boolean; canApprove: boolean }): string {
  const device = escapeHtml(options.device);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>PlaitCode · ${device}</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1e222b; --line: #2a2f3a;
    --text: #e5e7eb; --muted: #9aa3b2; --brand: #4c9aff; --warn: #f0b429; --ok: #34d399; --bad: #f87171;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  body { display: flex; flex-direction: column; }
  header { padding: 12px 14px; background: var(--panel); border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 8px; position: sticky; top: 0; z-index: 5; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  header .dot.on { background: var(--ok); box-shadow: 0 0 0 3px rgba(52,211,153,.15); }
  header .name { font-weight: 600; font-size: 15px; }
  header .role { margin-left: auto; font-size: 12px; color: var(--muted); }
  main { flex: 1; overflow-y: auto; padding: 12px 12px 20px; -webkit-overflow-scrolling: touch; }
  .banner { margin: 0 0 12px; padding: 10px 12px; border-radius: 12px; font-size: 14px;
    background: rgba(240,180,41,.12); border: 1px solid rgba(240,180,41,.45); color: #f7d68a; }
  .banner b { display: block; margin-bottom: 4px; color: var(--warn); }
  .msg { display: flex; margin-bottom: 12px; }
  .msg.user { justify-content: flex-end; }
  .bubble { max-width: 86%; padding: 9px 12px; border-radius: 14px; background: var(--panel2);
    border: 1px solid var(--line); white-space: pre-wrap; word-break: break-word; font-size: 15px; }
  .msg.user .bubble { background: #1d3a5f; border-color: #2a4f7d; }
  .meta { font-size: 11px; color: var(--muted); margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
  .msg.user .meta { justify-content: flex-end; }
  .tag { padding: 1px 6px; border-radius: 6px; font-size: 11px; border: 1px solid var(--line); color: var(--muted); }
  .tag.question { color: var(--warn); border-color: rgba(240,180,41,.5); }
  .tag.result { color: var(--ok); border-color: rgba(52,211,153,.5); }
  .tag.requirement { color: var(--brand); border-color: rgba(76,154,255,.5); }
  .approval { border: 1px solid rgba(248,113,113,.5); background: rgba(248,113,113,.08);
    border-radius: 12px; padding: 10px 12px; margin-bottom: 12px; }
  .approval.safe { border-color: var(--line); background: var(--panel2); }
  .approval .title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .approval .detail { font-size: 12px; color: var(--muted); white-space: pre-wrap; word-break: break-word;
    max-height: 7.5em; overflow: hidden; margin-bottom: 8px; }
  .row { display: flex; gap: 8px; }
  button { flex: 1; padding: 10px; border-radius: 10px; font-size: 15px; border: 1px solid var(--line);
    background: var(--panel2); color: var(--text); font-weight: 600; }
  button.primary { background: var(--brand); border-color: var(--brand); color: #06121f; }
  button.danger { background: transparent; border-color: rgba(248,113,113,.6); color: var(--bad); }
  button:disabled { opacity: .5; }
  footer { padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: var(--panel);
    border-top: 1px solid var(--line); display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; resize: none; min-height: 42px; max-height: 120px; padding: 10px 12px; border-radius: 12px;
    background: var(--panel2); color: var(--text); border: 1px solid var(--line); font: inherit; font-size: 15px; }
  footer button { flex: 0 0 68px; padding: 10px 0; }
  .empty { color: var(--muted); text-align: center; font-size: 14px; padding: 40px 20px; }
  form.login { padding: 28px 18px; }
  form.login h1 { font-size: 18px; margin: 0 0 6px; }
  form.login p { color: var(--muted); font-size: 14px; margin: 0 0 22px; }
  input.code { width: 100%; padding: 14px; border-radius: 12px; background: var(--panel2); color: var(--text);
    border: 1px solid var(--line); font-size: 28px; letter-spacing: 8px; text-align: center; font-variant-numeric: tabular-nums; }
  form.login button { width: 100%; margin-top: 14px; padding: 13px; }
  .err { color: var(--bad); font-size: 13px; min-height: 20px; margin-top: 10px; text-align: center; }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <span class="name">PlaitCode · ${device}</span>
  <span class="role" id="role"></span>
</header>
${options.authed ? '<main id="main"><div class="empty">正在连接…</div></main><footer><textarea id="input" rows="1" placeholder="以甲方身份说一句话（Enter 发送）"></textarea><button class="primary" id="send">发送</button></footer>' : `<main><form class="login" id="login">
  <h1>连接到这台电脑</h1>
  <p>在电脑上打开「PlaitCode：手机遥控」，把那里的 6 位数字填进来。也可以直接扫那张二维码。</p>
  <input class="code" id="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="000000">
  <button class="primary" type="submit">进入团队群</button>
  <div class="err" id="err"></div>
</form></main>`}
<script>
(function () {
  var authed = ${options.authed ? 'true' : 'false'};
  var canApprove = ${options.canApprove ? 'true' : 'false'};
  var PHASES = { requirement: '需求', analysis: '解析', question: '追问', answer: '回复', confirm: '确认', progress: '进度', result: '结果' };

  if (!authed) {
    var params = new URLSearchParams(location.search);
    var preset = params.get('c');
    var input = document.getElementById('code');
    if (preset && /^[0-9]{6}$/.test(preset)) {
      input.value = preset;
      history.replaceState(null, '', location.pathname);
      login(preset);
    }
    document.getElementById('login').addEventListener('submit', function (event) {
      event.preventDefault();
      login(input.value);
    });
    return;
  }

  var main = document.getElementById('main');
  var input = document.getElementById('input');
  var send = document.getElementById('send');
  var signature = '';
  var busy = false;

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plaitcode-mobile': '1' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(function (response) { return response.json().catch(function () { return {}; }); });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function timeOf(at) {
    var date = new Date(at);
    return ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2);
  }

  function render(state) {
    document.getElementById('dot').className = 'dot' + (state.role === 'off' ? '' : ' on');
    document.getElementById('role').textContent = state.role === 'hub' ? '主机' : state.role === 'peer' ? '已连接' : '单机';
    document.title = 'PlaitCode · ' + state.device;

    var scroll = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
    var next = JSON.stringify([state.messages, state.approvals, state.openQuestion]);
    if (next === signature) return;
    signature = next;

    main.innerHTML = '';
    if (state.openQuestion) {
      var banner = el('div', 'banner');
      banner.appendChild(el('b', null, '乙方在等你回答'));
      banner.appendChild(el('span', null, state.openQuestion.body));
      main.appendChild(banner);
    }
    (state.approvals || []).forEach(function (approval) {
      var card = el('div', 'approval' + (approval.risk === 'dangerous' || approval.risk === 'command' ? '' : ' safe'));
      card.appendChild(el('div', 'title', approval.title));
      card.appendChild(el('div', 'detail', approval.summary + (approval.detail ? '\n' + approval.detail : '')));
      if (canApprove) {
        var row = el('div', 'row');
        var deny = el('button', 'danger', '拒绝');
        var allow = el('button', 'primary', '允许这次');
        deny.onclick = function () { decide(approval.id, false, row); };
        allow.onclick = function () { decide(approval.id, true, row); };
        row.appendChild(deny);
        row.appendChild(allow);
        card.appendChild(row);
      } else {
        card.appendChild(el('div', 'detail', '这段需要在电脑上确认。'));
      }
      main.appendChild(card);
    });
    (state.messages || []).forEach(function (message) {
      var mine = message.author === 'user';
      var wrap = el('div', 'msg' + (mine ? ' user' : ''));
      var bubble = el('div', 'bubble');
      var meta = el('div', 'meta');
      meta.appendChild(el('span', 'tag ' + message.phase, PHASES[message.phase] || message.phase));
      meta.appendChild(el('span', null, (mine ? '你' : (message.from && message.from.name) || '乙方') + ' · ' + timeOf(message.at)));
      bubble.appendChild(meta);
      bubble.appendChild(el('div', null, message.body));
      wrap.appendChild(bubble);
      main.appendChild(wrap);
    });
    if (!main.childNodes.length) main.appendChild(el('div', 'empty', '还没有发言。说一句话，两台设备的乙方都会收到。'));
    if (scroll) main.scrollTop = main.scrollHeight;
  }

  function decide(id, allow, row) {
    Array.prototype.forEach.call(row.children, function (node) { node.disabled = true; });
    post('/m/approve', { id: id, allow: allow }).then(function (result) {
      if (!result.ok) {
        Array.prototype.forEach.call(row.children, function (node) { node.disabled = false; });
        alert(result.error || '操作没成功，请在电脑上处理。');
      }
    }).catch(function () {
      Array.prototype.forEach.call(row.children, function (node) { node.disabled = false; });
    });
  }

  function refresh() {
    if (busy) return;
    busy = true;
    fetch('/m/state', { credentials: 'same-origin' })
      .then(function (response) {
        if (response.status === 401) { location.reload(); return undefined; }
        return response.json();
      })
      .then(function (state) { if (state && state.device) render(state); })
      .catch(function () { document.getElementById('dot').className = 'dot'; })
      .finally(function () { busy = false; });
  }

  function submit() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    send.disabled = true;
    post('/m/send', { text: text }).then(function (result) {
      if (!result.ok) {
        input.value = text;
        alert(result.error || '没发出去，请重试。');
      }
      signature = '';
      refresh();
    }).catch(function () {
      input.value = text;
      alert('网络没连上。');
    }).finally(function () {
      send.disabled = false;
      input.focus();
    });
  }

  send.addEventListener('click', submit);
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  setInterval(refresh, 2500);
  refresh();

  function login(code) {
    var err = document.getElementById('err');
    err.textContent = '';
    post('/m/login', { code: code }).then(function (result) {
      if (result.ok) { location.replace('/m'); return; }
      err.textContent = result.error || '验证码不对。';
    }).catch(function () { err.textContent = '连不上这台电脑。'; });
  }
})();
</script>
</body>
</html>`;
}
