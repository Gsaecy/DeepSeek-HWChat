/*
 * 校验「输出图片」在**渲染层**真的能显示出来。
 *
 * 为什么不能只靠单测：单测覆盖的是 provider 的请求/解析与 storage 的落盘，而用户看到的
 * 是 chat.js 造出来的 DOM。这里把 chat.js 里几个纯渲染函数原样切出来，配上最小 DOM
 * 沙箱跑一遍，断言：
 *   1. 地址白名单只放行 `data:image` 位图与 webview 资源（远程 http(s) 一律不放）；
 *   2. 行内图片与独占一行的图片都能生成 `<img>`，被拒的地址退回**原样文字**而不是破图；
 *   3. 落成文件的附件用 `webviewSrc` 当 `src`（缩略图只是退路）；
 *   4. CSS 里这两类图片都有尺寸上限（1024px 的生成图不该把一问一答挤走）。
 *
 * 用法：node test/check-image-output.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let checks = 0;
let failures = 0;
function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}`);
}

const source = readFileSync(new URL('../media/chat.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../media/chat.css', import.meta.url), 'utf8');
const CHAT_JS = source;

/** 按「起点标记 → 终点标记」切一段源码；切不到就让脚本失败，避免静默通过。 */
function slice(startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    failures += 1;
    console.log(`✗ 切不出 ${label} 的源码（chat.js 结构变了，脚本要跟着改）`);
    return '';
  }
  return source.slice(start, end);
}

const imageFunctions = [
  slice('  function imageSourceAllowed(src) {', '  function appendInline(parent, value) {', 'imageSourceAllowed / inlineImageNode'),
  slice('  function appendInline(parent, value) {', '  function renderAttachments() {', 'appendInline'),
  slice('  function appendPlainText(parent, text) {', '  /**\n   * markdown 图片的地址白名单', 'appendPlainText'),
  slice('  function appendRichText(container, text, streaming = false) {', '\n  /**', 'appendRichText'),
  slice('  function renderMessageAttachments(attachments) {', '  /**\n   * 让已经发出去的附件可以', 'renderMessageAttachments'),
  'function textElement(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; return node; }',
].join('\n');

/** 最小 DOM：只需要 append / appendChild / classList / textContent 与若干个属性。 */
function makeDocument() {
  function node(tag) {
    const classes = new Set();
    return {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      src: '',
      alt: '',
      title: '',
      href: '',
      type: '',
      draggable: true,
      children: [],
      classList: {
        add(...names) { for (const name of names) classes.add(name); },
        contains(name) { return classes.has(name); },
      },
      append(...nodes) { this.children.push(...nodes); },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener() {},
      setAttribute(name, value) { this[name] = value; },
    };
  }
  return {
    createElement: (tag) => node(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [], tagName: '#text', append(...nodes) { this.children.push(...nodes); } }),
  };
}

const context = vm.createContext({
  document: makeDocument(),
  t: (key) => key,
  post: () => undefined,
  fileRef: null,
  fileReferenceNode: () => null,
  codeMeta: { collectFenceBlock: () => null },
  streamRepair: null,
  calloutMeta: null,
  isTableStart: () => false,
  isListLine: () => false,
  appendList: () => ({ nextIndex: 0, node: null }),
  appendTable: () => ({ nextIndex: 0, node: null }),
  makeAttachmentOpenable: () => undefined,
  makeAttachmentDraggable: () => undefined,
  attachmentOpenPayload: (attachment) => ({ id: attachment?.id, label: attachment?.label }),
  console,
});
vm.runInContext(`${imageFunctions}\nglobalThis.__api = { imageSourceAllowed, inlineImageNode, appendInline, appendRichText, renderMessageAttachments };`, context);
const api = context.__api;

/** 深度收集节点树里所有指定 tagName 的节点。 */
function collect(node, tag, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.tagName === tag) out.push(node);
  for (const child of node.children || []) collect(child, tag, out);
  return out;
}

function textOf(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.tagName === '#text') return node.textContent;
  let value = node.textContent || '';
  for (const child of node.children || []) value += textOf(child);
  return value;
}

// ① 白名单
check('data:image/png 放行', api.imageSourceAllowed('data:image/png;base64,iVBORw0KGgo=') === true);
check('data:image/jpeg 放行', api.imageSourceAllowed('data:image/jpeg;base64,/9j/4AAQ') === true);
check('data:image/webp 放行', api.imageSourceAllowed('data:image/webp;base64,UklGRg==') === true);
check('data:image/svg+xml 不放行', api.imageSourceAllowed('data:image/svg+xml;base64,PHN2Zz4=') === false);
check('data:text/html 不放行', api.imageSourceAllowed('data:text/html;base64,PHNjcmlwdD4=') === false);
// 用户 2026-11-04 明确要求放宽 CSP：远程 https 图片现在可以直接显示。
check('远程 https 图片放行（CSP 已带 https:）', api.imageSourceAllowed('https://example.com/a.png') === true);
check('远程 https 带查询串也放行', api.imageSourceAllowed('https://cdn.example.com/a.png?v=2&w=800') === true);
// 明文 http 仍然拒绝：会把「正在看这条对话」暴露给中间人，与项目其余远程请求口径一致。
check('明文 http 图片不放行', api.imageSourceAllowed('http://example.com/a.png') === false);
check('javascript: 不放行', api.imageSourceAllowed('javascript:alert(1)') === false);
check('webview 资源地址放行（`+` 形式）', api.imageSourceAllowed('https://file+.vscode-resource.vscode-cdn.net/a.png') === true);
// 真实事故 2026-11-04：`asWebviewUri().toString()` 实际输出的是 `%2B` 形式，
// 而白名单只认 `+` —— 面板自己生成的地址被自己拒掉，图片永远只是文字。
check('webview 资源地址放行（`%2B` 形式，asWebviewUri 的真实输出）',
  api.imageSourceAllowed('https://file%2B.vscode-resource.vscode-cdn.net/a.png') === true);
check('webview 资源地址放行（小写 `%2b`）',
  api.imageSourceAllowed('https://file%2b.vscode-resource.vscode-cdn.net/a.png') === true);
check('网页版 `<guid>.vscode-cdn.net` 放行',
  api.imageSourceAllowed('https://abc123def.vscode-cdn.net/a.png') === true);
// 放宽 CSP 之后，任何 https 主机都放行 —— 这是**明知**的取舍（外部主机能看到
// 「有人正在看这条对话」）。用一条显式断言把这个事实钉住，避免以后有人以为它是漏洞。
check('任何 https 主机都放行（这是放宽 CSP 的既定取舍）',
  api.imageSourceAllowed('https://evil.file%2B.vscode-cdn.net.attacker.com/a.png') === true);
check('vscode-resource: 放行', api.imageSourceAllowed('vscode-resource://file/a.png') === true);
check('空地址不放行', api.imageSourceAllowed('  ') === false);

// ② 行内图片
{
  const parent = { tagName: 'P', children: [], append(...nodes) { this.children.push(...nodes); } };
  api.appendInline(parent, '看图 ![猫](data:image/png;base64,iVBORw0KGgo=) 结束');
  const images = collect(parent, 'IMG');
  check('行内 data 图片渲染成 img', images.length === 1);
  check('行内图片用 message-inline-image 类', images[0]?.className === 'message-inline-image');
  check('行内图片 src 指向同一份数据', images[0]?.src === 'data:image/png;base64,iVBORw0KGgo=');
  check('行内图片保留 alt', images[0]?.alt === '猫');
  check('周围文字没有丢', textOf(parent).includes('看图') && textOf(parent).includes('结束'));
}
{
  const parent = { tagName: 'P', children: [], append(...nodes) { this.children.push(...nodes); } };
  api.appendInline(parent, '![x](https://example.com/a.png)');
  check('远程 https 图片生成 img', collect(parent, 'IMG').length === 1);
  check('远程图片 src 原样保留', collect(parent, 'IMG')[0]?.src === 'https://example.com/a.png');
}

// ③ 独占一行的图片
{
  const container = { tagName: 'DIV', children: [], append(...nodes) { this.children.push(...nodes); } };
  api.appendRichText(container, '# 标题\n\n![雨里的猫](data:image/png;base64,iVBORw0KGgo=)\n\n后面的话');
  const images = collect(container, 'IMG');
  check('独占一行的图片渲染成 img', images.length === 1);
  check('块级图片用 message-block-image 类', images[0]?.className === 'message-block-image');
  check('块级图片按 lazy 加载', images[0]?.loading === 'lazy');
  check('alt 变成了图注', collect(container, 'FIGCAPTION').some((node) => textOf(node) === '雨里的猫'));
  check('图片后面的段落照常渲染', collect(container, 'P').some((node) => textOf(node).includes('后面的话')));
}
{
  const container = { tagName: 'DIV', children: [], append(...nodes) { this.children.push(...nodes); } };
  api.appendRichText(container, '![x](http://insecure.example.com/x.png)');
  check('非白名单地址（明文 http）不生成块级图片', collect(container, 'IMG').length === 0);
}

// ④ 落成文件的附件
{
  const row = api.renderMessageAttachments([{ kind: 'image', label: '生成的图片', path: '/tmp/a.png', webviewSrc: 'https://file+.vscode-resource.vscode-cdn.net/a.png' }]);
  const images = collect(row, 'IMG');
  check('没有缩略图时也能显示（用 webviewSrc）', images.length === 1);
  check('webviewSrc 优先于缩略图', images[0]?.src === 'https://file+.vscode-resource.vscode-cdn.net/a.png');
}
{
  const row = api.renderMessageAttachments([{
    kind: 'image',
    label: '旧附件',
    thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    webviewSrc: 'https://file+.vscode-resource.vscode-cdn.net/old.png',
  }]);
  check('两者都有时仍用 webviewSrc（不搬 base64）', collect(row, 'IMG')[0]?.src.includes('vscode-cdn.net') === true);
}
{
  const row = api.renderMessageAttachments([{ kind: 'image', label: '没有地址的图片' }]);
  check('完全没有地址时退回文件条目，不造破图', collect(row, 'IMG').length === 0 && textOf(row).includes('没有地址的图片'));
}

// ⑤ CSS 尺寸上限
check('.message-block-image 有 max-height', /\.message-block-image\s*\{[^}]*max-height:[^;]*;/.test(css));
check('.message-block-image 宽度不溢出', /\.message-block-image\s*\{[^}]*max-width:\s*100%/.test(css));
check('.message-inline-image 有 max-height', /\.message-inline-image\s*\{[^}]*max-height:[^;]*;/.test(css));
check('图注样式存在', /\.message-image-figure figcaption\s*\{/.test(css));

/* ── 图片能力的可发现性（真实事故 2026-11-04）─────────────────────────── */
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const REQUEST = readFileSync('src/agent/imageRequest.ts', 'utf8');
const CLIENT = readFileSync('src/providers/deepseekClient.ts', 'utf8');

check('系统提示词里带上图片能力（有/没有两种说法）',
  /imageCapabilityPrompt\(imageModel/.test(PANEL)
  && /this\.agentSystemPrompt\(mode, settings\.systemPrompt, skillPrompt, historyPrompt, settings\.imageModel\)/.test(PANEL),
  '不告诉模型「这个档位不能出图」，它就会自己去装渲染器（实测 npx 超时 2 分钟）');
check('没配图片模型时禁止去装渲染器',
  /mermaid-cli/.test(REQUEST) && /不要为了满足这种请求去安装/.test(REQUEST),
  '这是那次事故的直接教训');
check('要图却没配图片模型时弹出确定性提示',
  /looksLikeImageRequest\(content\)/.test(PANEL) && /notice\.imageModelMissing/.test(PANEL),
  '不能指望模型自觉告知；用户看到的必须是「去设置里填」而不是两分钟超时');
check('出图端点 404 有专门解释（换配置档，而不是重试）',
  /api\.imageEndpointMissing/.test(CLIENT) && /response\.status === 404/.test(CLIENT),
  '「接口请求失败（404）」无法指导下一步');
check('回复里只提到本地图片路径时，自动补成可见的图片',
  /return embedMentionedImages\(rewriteMarkdownImagePaths\(rehosted, toWebviewUri\), toWebviewUri\);/.test(PANEL)
  && /rehostWebviewImageUrls\(content, toWebviewUri\)/.test(PANEL),
  '那次 agent 生成了 architecture.svg 并写进了正文，但只写成反引号路径，对话里什么都没显示');

/* ── 远程图片（用户 2026-11-04 明确要求放宽 CSP）─────────────────────── */
check('CSP 的 img-src 允许远程 https',
  /img-src \$\{webview\.cspSource\} data: https:/.test(PANEL),
  '不放宽的话，远程图片一定被 CSP 拦成破图 —— 这一条必须与白名单同步修改');
check('白名单与 CSP 口径一致（https 放行 / http 拒绝）',
  /if \(\/\^https:\\\/\\\/\[\^\\s\]\+\$\/i\.test\(value\)\) return true;/.test(CHAT_JS),
  '只放宽 CSP 不改白名单，图片仍然只是文字');
check('加载失败给出可读说明而不是破图图标',
  /message-image-fallback/.test(CHAT_JS) && /chat\.imageLoadFailed/.test(CHAT_JS),
  '远程图会 404 / 需要鉴权，碎图框既不说明原因也不给地址');
check('失败替身的文案键真实存在',
  /'chat\.imageLoadFailed'/.test(readFileSync('src/core/i18n.ts', 'utf8')),
  'i18n 里没有这个键，界面上会直接显示键名');

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) process.exitCode = 1;
