/*
 * 校验 media/chat.js 里「把图标变成 DOM」的那段代码真的能产出 SVG。
 *
 * 为什么单独跑一遍：单元测试只覆盖了 ui-icons.js 的形状定义，而真正决定用户看到什么的
 * 是 chat.js 里的 iconNode（DOMParser → importNode → append）和它的文字退路。
 * 那段代码在 IIFE 里、又依赖 DOM，所以这里把它原样切出来，配一个最小 DOM 跑。
 *
 * 用法：node test/check-icons-dom.mjs
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

/** 最小 DOM 节点：够 iconNode / flattenEmojiIcons 用即可。 */
function makeNode(tag) {
  const classes = new Set();
  return {
    tagName: tag,
    className: '',
    textContent: '',
    children: [],
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      contains(name) { return classes.has(name); },
    },
    append(...nodes) { this.children.push(...nodes); },
  };
}

/** 从 chat.js 里切出图标相关的那段（两个连续的顶层声明之间）。 */
function extractIconBlock(source) {
  const start = source.indexOf('const uiIcons = globalThis.HWChatIcons || null;');
  const end = source.indexOf('const elements = Object.fromEntries([');
  if (start < 0 || end < 0 || end <= start) throw new Error('没找到 chat.js 里的图标代码块');
  return source.slice(start, end);
}

function loadChatIconBlock(iconsModule) {
  const source = readFileSync('media/chat.js', 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.HWChatIcons = iconsModule;
  sandbox.document = {
    createElement: (tag) => makeNode(tag),
    // importNode 只做「克隆」，测试只关心拿到的是不是一个 svg 节点。
    importNode: (node) => ({ tagName: node.tagName, imported: true }),
  };
  sandbox.DOMParser = class {
    parseFromString(markup) {
      const match = String(markup).match(/^<([a-zA-Z]+)/);
      return { documentElement: { tagName: match ? match[1] : 'parsererror' } };
    }
  };
  vm.createContext(sandbox);
  // 代码块里是函数声明，跑完要主动取回来。
  vm.runInContext(`${extractIconBlock(source)}\nglobalThis.__iconNode = iconNode;`, sandbox);
  return { iconNode: sandbox.__iconNode, sandbox };
}

function loadIcons() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/ui-icons.js', 'utf8'), sandbox);
  return sandbox.HWChatIcons;
}

const icons = loadIcons();
const { iconNode } = loadChatIconBlock(icons);

// ① 正常路径：每个图标名都要变成 <svg>，而不是退化成文字。
for (const name of icons.names()) {
  const node = iconNode(name);
  const svg = node.children[0];
  check(
    `${name} → 产出 svg 节点（不是文字退路）`,
    node.className === 'ui-icon' && node.children.length === 1 && svg && svg.tagName === 'svg' && svg.imported === true,
  );
  check(`${name} → 不写文字内容`, node.textContent === '');
}

// ② 文字退路：图标脚本没加载成功时，徽标不能变成空白。
{
  const { iconNode: withoutIcons } = loadChatIconBlock(null);
  const node = withoutIcons('check');
  check('图标脚本缺失 → 退化成文字 ✓', node.children.length === 0 && node.textContent === '✓');
}

// ③ 未知图标名：不该抛错，也不该产出 svg。
{
  const node = iconNode('doesNotExist');
  check('未知图标名 → 不抛错且不产出 svg', node.children.length === 0);
}

// ④ 解析失败（解析器给出 parsererror）：必须走文字退路，不能让整段渲染炸掉。
{
  const source = readFileSync('media/chat.js', 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.HWChatIcons = icons;
  sandbox.document = { createElement: (tag) => makeNode(tag), importNode: (n) => n };
  sandbox.DOMParser = class {
    parseFromString() { return { documentElement: { tagName: 'parsererror' } }; }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractIconBlock(source)}\nglobalThis.__iconNode = iconNode;`, sandbox);
  const node = sandbox.__iconNode('check');
  check('解析器报错 → 退化成文字 ✓', node.children.length === 0 && node.textContent === '✓');
}

// ⑤ 正文 emoji → 扁平图标：映射表每一对都要指向真实存在的图标。
for (const emoji of icons.emojiKeys()) {
  const name = icons.emojiName(emoji);
  check(`emoji ${emoji} → ${name}（图标存在）`, Boolean(name) && icons.has(name));
}
check('变体选择符被归一化（⚠️ 与 ⚠ 同一条）', icons.emojiName('⚠\uFE0F') === icons.emojiName('⚠'));
check('未登记的 emoji 返回空（保留原字符）', icons.emojiName('🎉') === '');

// ⑥ flattenEmojiIcons 的实际行为：正文里的 emoji 换掉，代码块里的保留。
{
  const source = readFileSync('media/chat.js', 'utf8');
  const textNode = (value, parentTag) => ({
    nodeType: 3,
    nodeValue: value,
    parentElement: { tagName: parentTag },
    replaced: null,
    parentNode: { replaceChild(fragment, self) { self.replaced = fragment; } },
  });
  const plain = textNode('完成 🔔 看一下', 'P');
  const warned = textNode('注意 \u26A0\uFE0F 这里', 'P');
  const inCode = textNode('echo 🔔', 'CODE');
  const inPre = textNode('🔔', 'PRE');
  const all = [plain, warned, inCode, inPre];
  let cursor = 0;
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.HWChatIcons = icons;
  sandbox.NodeFilter = { SHOW_TEXT: 4 };
  sandbox.document = {
    createElement: (tag) => makeNode(tag),
    createTextNode: (value) => ({ textContent: value, plain: true }),
    createDocumentFragment: () => ({ children: [], append(...nodes) { this.children.push(...nodes); } }),
    createTreeWalker: () => {
      let current = null;
      return {
        get currentNode() { return current; },
        nextNode() { current = cursor < all.length ? all[cursor++] : null; return current; },
      };
    },
  };
  sandbox.DOMParser = class {
    parseFromString(markup) {
      const match = String(markup).match(/^<([a-zA-Z]+)/);
      return { documentElement: { tagName: match ? match[1] : 'parsererror' } };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractIconBlock(source)}\nglobalThis.__flatten = flattenEmojiIcons;`, sandbox);
  sandbox.__flatten({});

  const replacedIcons = (node) => (node.replaced ? node.replaced.children.filter((child) => !child.plain) : []);
  check('正文 emoji 被换成图标节点', replacedIcons(plain).length === 1);
  check('中文文字原样保留为文本', plain.replaced.children.some((child) => child.plain && child.textContent.includes('完成')));
  check('带变体选择符的 ⚠️ 也能换', replacedIcons(warned).length === 1);
  check('代码块里的 emoji 不动（<code>）', inCode.replaced === null);
  check('代码块里的 emoji 不动（<pre>）', inPre.replaced === null);
}

// ⑦ 只对助手输出生效：用户输入不被改写。
{
  const source = readFileSync('media/chat.js', 'utf8');
  check('renderMessage 里按角色判断', /if \(message\.role !== 'user'\) flattenEmojiIcons\(body\);/.test(source));
}

console.log(`\n${checks - failures}/${checks} 项通过`);
process.exit(failures === 0 ? 0 : 1);
