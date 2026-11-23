/**
 * 「手机遥控」窗口：电脑上显示二维码 + 6 位码，手机扫一下就能指挥。
 *
 * 为什么单独一个窗口而不是塞进设置页：用户要**一边看手机一边看电脑**，
 * 二维码得够大、够清楚；设置页里那一栏放不下，也不该逼着人滚动去找。
 */

import * as vscode from 'vscode';
import type { LanSyncService } from '../sync/lanSync';
import { qrSvg } from '../sync/qr';

export class MobilePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: LanSyncService,
    private readonly callbacks: {
      /** 换一张新码（旧码立刻作废）。 */
      rotate: () => string;
      /** 允许 / 禁止在手机上批准工具授权。 */
      setApprove: (value: boolean) => Promise<void>;
      getApprove: () => boolean;
    },
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      await this.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'plaitcode.mobileControl',
      '手机遥控',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    this.panel = panel;
    panel.webview.html = this.html();
    this.disposables.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      void (async () => {
        const record = (message ?? {}) as { type?: unknown; value?: unknown };
        if (record.type === 'ready') await this.refresh();
        if (record.type === 'rotate') {
          const code = this.callbacks.rotate();
          await this.refresh();
          await this.post({ type: 'toast', text: `新验证码：${code}` });
        }
        if (record.type === 'approve') {
          await this.callbacks.setApprove(record.value === true);
          await this.refresh();
        }
        if (record.type === 'copy') {
          await vscode.env.clipboard.writeText(this.service.mobileUrlWithCode());
          await this.post({ type: 'toast', text: '带验证码的地址已复制，可以直接发到手机。' });
        }
        if (record.type === 'open') {
          await vscode.env.openExternal(vscode.Uri.parse(this.service.mobileUrl()));
        }
      })();
    }));
    panel.onDidDispose(() => { this.panel = undefined; }, null, this.disposables);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    const info = this.service.mobileInfo();
    await this.post({
      type: 'state',
      enabled: info.enabled,
      url: info.url,
      code: info.code,
      expiresAt: info.expiresAt,
      qr: info.enabled ? qrSvg(info.qrText, { module: 7 }) : '',
      approve: this.callbacks.getApprove(),
      pending: this.service.pendingApprovalCount(),
      addresses: info.addresses.filter((item) => item !== info.url),
    });
  }

  private post(message: unknown): Thenable<boolean> | undefined {
    return this.panel?.webview.postMessage(message);
  }

  private html(): string {
    const nonce = [...Array(32)].map(() => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;`;
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --muted: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border, rgba(128,128,128,.25)); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .wrap { max-width: 520px; margin: 0 auto; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .lead { color: var(--muted); font-size: 12.5px; margin: 0 0 20px; }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 20px; text-align: center; }
  #qr { display: inline-block; line-height: 0; background: #fff; padding: 10px; border-radius: 10px; }
  #qr svg { display: block; }
  .code { font-size: 30px; letter-spacing: 8px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 14px 0 2px; }
  .ttl { color: var(--muted); font-size: 12px; }
  .url { margin-top: 14px; font-size: 12px; color: var(--muted); word-break: break-all; }
  .row { display: flex; gap: 10px; margin-top: 18px; }
  button { flex: 1; padding: 8px 12px; border-radius: 7px; cursor: pointer; font-size: 12.5px;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; }
  button.ghost { color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.16)); }
  button:hover { filter: brightness(1.08); }
  .toggle { display: flex; align-items: center; gap: 10px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 12.5px; }
  .toggle input { width: 16px; height: 16px; }
  .warn { color: var(--vscode-editorWarning-foreground, #d7a600); font-size: 11.5px; margin-top: 6px; }
  .off { padding: 20px; border: 1px dashed var(--line); border-radius: 10px; color: var(--muted); font-size: 12.5px; }
  .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); padding: 8px 14px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 12px; opacity: 0; transition: opacity .2s; }
  .toast.on { opacity: 1; }
</style></head>
<body><div class="wrap">
  <h1>手机遥控</h1>
  <p class="lead">手机和这台电脑连同一个 WiFi，扫下面的码就能进团队群：发需求、回答追问、看进度。不用装 App，也不用登录任何账号。</p>
  <div id="body"><div class="off">手机遥控未开启。</div></div>
  <div class="toast" id="toast"></div>
</div>
<script nonce="${nonce}">
(function () {
  var api = acquireVsCodeApi();
  var body = document.getElementById('body');
  var toast = document.getElementById('toast');
  var expiresAt = 0;
  var timer = null;

  function say(text) {
    toast.textContent = text;
    toast.className = 'toast on';
    setTimeout(function () { toast.className = 'toast'; }, 2600);
  }

  function tick() {
    var node = document.getElementById('ttl');
    if (!node) return;
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    var m = Math.floor(left / 60);
    var s = left % 60;
    node.textContent = left > 0 ? '验证码 ' + m + ':' + ('0' + s).slice(-2) + ' 后失效' : '验证码已失效，点「换一张」';
  }

  function render(state) {
    if (!state.enabled) {
      body.innerHTML = '<div class="off">手机遥控未开启。请在设置里打开「协作 → 手机遥控」。</div>';
      return;
    }
    expiresAt = state.expiresAt;
    body.innerHTML = '';
    var card = document.createElement('div');
    card.className = 'card';
    var qr = document.createElement('div');
    qr.id = 'qr';
    qr.innerHTML = state.qr || '';
    card.appendChild(qr);
    var code = document.createElement('div');
    code.className = 'code';
    code.textContent = state.code;
    card.appendChild(code);
    var ttl = document.createElement('div');
    ttl.className = 'ttl';
    ttl.id = 'ttl';
    card.appendChild(ttl);
    var url = document.createElement('div');
    url.className = 'url';
    url.textContent = state.url;
    card.appendChild(url);
    (state.addresses || []).forEach(function (item) {
      var alt = document.createElement('div');
      alt.className = 'url';
      alt.textContent = '手机打不开就试：' + item;
      card.appendChild(alt);
    });
    var row = document.createElement('div');
    row.className = 'row';
    var copy = document.createElement('button');
    copy.className = 'ghost';
    copy.textContent = '复制带码地址';
    copy.onclick = function () { api.postMessage({ type: 'copy' }); };
    var rotate = document.createElement('button');
    rotate.className = 'ghost';
    rotate.textContent = '换一张';
    rotate.onclick = function () { api.postMessage({ type: 'rotate' }); };
    row.appendChild(copy);
    row.appendChild(rotate);
    card.appendChild(row);
    body.appendChild(card);

    var toggle = document.createElement('label');
    toggle.className = 'toggle';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!state.approve;
    box.onchange = function () { api.postMessage({ type: 'approve', value: box.checked }); };
    var text = document.createElement('span');
    text.textContent = '允许在手机上批准工具授权（命令、写文件）';
    toggle.appendChild(box);
    toggle.appendChild(text);
    body.appendChild(toggle);
    if (state.approve) {
      var warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = '开着的时候，手机等于拿着这台电脑的遥控器：任何拿到这把手机的人都能点「允许」。';
      body.appendChild(warn);
    }
    if (state.pending) say('有 ' + state.pending + ' 个授权在等处理');
    tick();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000);
  }

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    if (message.type === 'state') render(message);
    if (message.type === 'toast') say(message.text || '');
  });
  api.postMessage({ type: 'ready' });
})();
</script>
</body></html>`;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.panel?.dispose();
    this.panel = undefined;
  }
}
