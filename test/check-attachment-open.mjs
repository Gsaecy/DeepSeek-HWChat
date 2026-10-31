/*
 * 校验「点击附件在编辑器里查看」这条链路真的接上了。
 *
 * 为什么不能只做静态断言：最容易出错的地方是「删除按钮在同一个容器里」——
 * 静态 grep 只能证明写了一句 `closest('button')`，证明不了点删除时不会顺带
 * 把附件打开。所以这里把 chat.js 里真正的 makeAttachmentOpenable 切出来，
 * 用最小 DOM 跑一遍点击。
 *
 * 用法：node test/check-attachment-open.mjs
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

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_CSS = readFileSync('media/chat.css', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const TYPES = readFileSync('src/core/types.ts', 'utf8');
const EXTENSION = readFileSync('src/extension.ts', 'utf8');

/** 最小 DOM：够 makeAttachmentOpenable 用即可（含 closest 的祖先遍历语义）。 */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.title = '';
    this.tabIndex = -1;
    this.attrs = {};
    this.classes = new Set();
    this.listeners = new Map();
    this.parent = null;
  }

  get classList() {
    return { add: (name) => this.classes.add(name), contains: (name) => this.classes.has(name) };
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  append(...nodes) { for (const node of nodes) { if (node) { node.parent = this; } } }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  closest(selector) {
    const wanted = String(selector).toUpperCase();
    let node = this;
    while (node) {
      if (node.tagName === wanted) return node;
      node = node.parent;
    }
    return null;
  }

  fire(type, event = {}) {
    const target = event.target ?? this;
    const payload = { preventDefault: () => {}, ...event, target };
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
  }
}

/** 从 chat.js 切出附件打开那一段（attachmentOpenPayload → renderMessageAttachments 之前）。 */
function extractOpenBlock(source) {
  const start = source.indexOf('function attachmentOpenPayload(');
  const next = source.indexOf('function renderToolExecutions(');
  if (start < 0 || next <= start) throw new Error('没找到 chat.js 里的附件打开代码');
  // 往前吃掉紧挨着的注释块，往后收住 renderMessageAttachments 与 makeAttachmentOpenable。
  return source.slice(start, next);
}

function loadOpenBlock() {
  const calls = [];
  const sandbox = {
    Element: FakeElement,
    post: (type, payload) => calls.push({ type, payload }),
    t: (key) => (key === 'chat.openAttachmentHint' ? '点击在编辑器中查看' : key),
    document: { createElement: (tag) => new FakeElement(tag) },
    textElement: (tag, className, text) => {
      const node = new FakeElement(tag);
      if (className) node.classes.add(className);
      node.text = text;
      return node;
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${extractOpenBlock(CHAT_JS)}\nthis.__api = { attachmentOpenPayload, makeAttachmentOpenable, renderMessageAttachments };`, sandbox);
  return { api: sandbox.__api, calls };
}

const { api, calls } = loadOpenBlock();

// —— 真实点击行为 ——
{
  const figure = new FakeElement('figure');
  api.makeAttachmentOpenable(figure, { id: 'att-1', label: 'screenshot.png', path: 'assets/screenshot.png', kind: 'image' });
  check('附件被标记为可点击（role=button 且可聚焦）', figure.attrs.role === 'button' && figure.tabIndex === 0);
  check('提示里写明了点击后用处在编辑器查看', figure.title.includes('点击在编辑器中查看'));
  check('提示里保留了原路径，便于确认是哪个文件', figure.title.includes('assets/screenshot.png'));

  figure.fire('click', { target: figure });
  check('点击附件会发出 openAttachment 请求', calls.length === 1 && calls[0].type === 'openAttachment');
  check('请求里带上 id 供扩展取回完整内容', calls[0]?.payload?.id === 'att-1');
  check('请求里带上 path，供有原文件时直接打开', calls[0]?.payload?.path === 'assets/screenshot.png');
}

// —— 删除按钮不能顺带打开附件（最容易回归的一条）——
{
  calls.length = 0;
  const chip = new FakeElement('div');
  const remove = new FakeElement('button');
  remove.parent = chip;
  api.makeAttachmentOpenable(chip, { id: 'att-2', label: 'a.txt' });

  chip.fire('click', { target: remove });
  check('点容器内的删除按钮不会打开附件', calls.length === 0);
  chip.fire('click', { target: chip });
  check('点容器本身仍然能打开附件', calls.length === 1 && calls[0].payload.id === 'att-2');
}

// —— 键盘可达 ——
{
  calls.length = 0;
  const chip = new FakeElement('span');
  api.makeAttachmentOpenable(chip, { id: 'att-3', label: 'b.txt' });
  chip.fire('keydown', { key: 'Enter' });
  check('回车可以打开附件（键盘可达）', calls.length === 1 && calls[0].payload.id === 'att-3');
  chip.fire('keydown', { key: 'Tab' });
  check('其他按键不会误触发', calls.length === 1);
}

// —— 没有 id 时退化为只传 path ——
{
  calls.length = 0;
  const chip = new FakeElement('span');
  api.makeAttachmentOpenable(chip, { label: 'src/a.ts', path: 'src/a.ts' });
  chip.fire('click', { target: chip });
  check('没有 id 时按 path 回传，仍可打开', calls.length === 1 && calls[0].payload.id === undefined && calls[0].payload.path === 'src/a.ts');
}

// —— 两处渲染都接上了 ——
// 图片卡片多传一个「焦点目标」：键盘焦点必须落在 <img> 上，不能落在外层 <figure> ——
// figure 里还有「添加到输入框」按钮，给容器加 role=button 就成了按钮里套按钮
// （独立审核 2026-10-31 发现，见 check-attachment-keyboard.mjs 的真机验证）。
check(
  '已发送消息里的图片和文件都接了点击',
  /function renderMessageAttachments[\s\S]*?makeAttachmentOpenable\(figure, attachment, image\)[\s\S]*?makeAttachmentOpenable\(chip, attachment\)/.test(CHAT_JS),
);
check(
  '待发送附件（发送前核对）也接了点击',
  /makeAttachmentOpenable\(chip, attachment\);\s*\n\s*\}/.test(CHAT_JS) || CHAT_JS.includes('createElement(\'div\'); chip.className = `attachment-chip'),
);
check('待发送附件列表确实调用了 makeAttachmentOpenable', (CHAT_JS.match(/makeAttachmentOpenable\(/g) ?? []).length >= 4);

// —— 扩展侧协议 ——
check('IncomingMessage 里有 openAttachment', /\{ type: 'openAttachment'; id\?: string; path\?: string \}/.test(PANEL));
check('面板确实处理 openAttachment', PANEL.includes("case 'openAttachment':"));
check('打开动作走统一的决策函数', PANEL.includes('planAttachmentOpen(attachment)'));
check('图片派生副本写在扩展 storage，而不是用户工作区', PANEL.includes("vscode.Uri.joinPath(this.attachmentStorageUri, 'attachment-cache')"));
check('ChatPanel 拿到了 globalStorageUri', EXTENSION.includes('context.extensionUri,\n    context.globalStorageUri,'));
check('MessageContext 带有 id 字段', /interface MessageContext \{[\s\S]*?\bid\?: string;/.test(TYPES));
check('webview 侧的附件精简副本带上了 id', /\'id\' \| \'label\'/.test(TYPES));

// —— 同一附件反复渲染不会丢 id ——
check('id 写回源对象，避免每次重绘都新增一条索引', PANEL.includes('context.id ??= `att-'));
check('附件索引有内存上限，避免历史图片常驻', PANEL.includes('ATTACHMENT_INDEX_CHAR_LIMIT'));

// —— 侧边栏运行状态：蓝色文字 ——
check('侧边栏把运行状态单独成节点', CHAT_JS.includes("textElement('span', 'conversation-status running'"));
check('运行状态只包住状态词，不含时间戳', !CHAT_JS.includes('statusPrefix'));
check('运行状态用强调色（蓝）而不是正文灰', /\.conversation-status\.running\s*\{\s*color:\s*var\(--accent\)/.test(CHAT_CSS));
check('可点击附件有悬停/聚焦提示样式', CHAT_CSS.includes('.attachment-openable') && CHAT_CSS.includes('cursor: pointer'));

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) process.exit(1);
