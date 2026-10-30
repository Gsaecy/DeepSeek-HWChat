import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import packageJson from '../../package.json';

export function nonce(): string {
  return randomBytes(18).toString('base64');
}

/**
 * 媒体资源地址带上扩展版本号：升级后 HTML、CSS、JS 一定来自同一个构建，
 * 避免 webview 命中旧缓存导致样式与结构版本错配（例如旧结构遇上新样式）。
 */
export function mediaUri(webview: vscode.Webview, extensionUri: vscode.Uri, file: string): vscode.Uri {
  const uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  return uri.with({ query: `v=${packageJson.version}` });
}

export function icon(name: IconName): string {
  const paths: Record<IconName, string> = {
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3v-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3h4v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.6 1h.1v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    send: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    // 实心方块：停止按钮以危险色高亮时，描边图标会被底色吃掉，实心才看得清。
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    attach: '<path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.5-9.5a4 4 0 0 1 5.7 5.7l-9.6 9.5a2 2 0 1 1-2.8-2.8l8.9-8.9"/>',
    archive: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1zM10 12h4"/>',
    export: '<path d="M12 15V4"/><path d="m8 8 4-4 4 4"/><path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    skills: '<path d="M12 2 9.5 7 4 7.8l4 4-1 5.7 5-2.7 5 2.7-1-5.7 4-4L14.5 7 12 2Z"/>',
    restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    // 圆环圆心必须正好在 (12,12)：加载态跑 spin，旋转绕的是 svg 盒子中心（.icon 17px），
    // 圆心偏一格，画出来就是绕着盒子中心甩而不是原地转。
    // 构造直接取 history 的镜像（旋转方向相反）：环 r=9、圆心 (12,12)，第二段路径的直角
    // 折点落在**弧的末端** (21,8)，那才是箭头的基准点。此前那版把折点画在弧的**起点**
    // (20.46,8.92) 上，横画还从 x=15.96 一路穿进环内，看着像箭头挂在转圈的尾巴上。
    // 墨迹 19.8×19.8、中心 (12,12)，与 history 完全对齐。几何由 test/check-icon-geometry.mjs
    // 断言（含「箭头必须接在弧末端、不能接在弧起点」），改这里先跑它。
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m5 12 7 7 7-7"/>',
    /*
     * 互联网参考（地球 + 经线）。关闭时是灰描边，开启时由 CSS 换成强调色实心底。
     * 24 格网格，墨迹 18×18、中心 (12,12)，与其它工具栏图标同尺寸。
     */
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>',
  };
  // data-icon 供 CSS 做光学尺寸修正：同一个 24 格网格里，回形针、麦克风的墨迹约占 19~20 格，
  // 发送箭头只有 14 格、停止方块只有 12 格；图标框一样大时后两者看起来明显偏小。
  return `<svg class="icon" data-icon="${name}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

type IconName = 'history' | 'plus' | 'settings' | 'send' | 'stop' | 'attach' | 'archive' | 'export' | 'skills' | 'restore' | 'shield' | 'refresh' | 'mic' | 'arrowDown' | 'globe';
