/*
 * 校验「危险 / 重要」提醒块真的会被渲染成对应结构，且配色只落在该落的地方。
 *
 * 为什么不能只靠单测：单元测试覆盖的是 media/callout-meta.js 的解析（哪些内容算提醒），
 * 而用户最终看到的是 chat.js 造出来的 DOM + chat.css 的配色。三处任何一处脱节，
 * 症状都不是报错，而是「红色标题没出现」或「普通引用也变红了」——只能靠人眼睛发现。
 * 所以这里把 chat.js 里造节点的代码原样切出来跑，并直接读 CSS 断言选择器与取值。
 *
 * 用法：node test/check-callout-dom.mjs
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

/** 最小 DOM 节点：够 calloutNode / iconNode 用即可（含 dataset）。 */
function makeNode(tag) {
  const classes = new Set();
  return {
    tagName: tag,
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      contains(name) { return classes.has(name); },
    },
    append(...nodes) { this.children.push(...nodes); },
  };
}

/**
 * 从 chat.js 里切出「图标 + 提醒块」那段顶层代码。
 *
 * 起点是 uiIcons 常量，终点是 calloutNode 的闭合花括号（下一个函数 flattenEmojiIcons 之前）。
 * 这段代码不依赖 IIFE 里的其它状态，只用到 document / DOMParser / t / GLYPH_FALLBACK，
 * 所以能配最小沙箱单独跑。
 */
function extractCalloutBlock(source) {
  const start = source.indexOf('const uiIcons = globalThis.HWChatIcons || null;');
  const nextFunction = source.indexOf('function flattenEmojiIcons(root)');
  if (start < 0 || nextFunction <= start) throw new Error('没找到 chat.js 里的图标 / 提醒块代码');
  const region = source.slice(start, nextFunction);
  // 往回收到 calloutNode 自己的闭合花括号，避免把下一个函数的注释切进来（注释不闭合会解析失败）。
  const end = region.lastIndexOf('\n  }');
  if (end < 0) throw new Error('没找到 calloutNode 的结尾');
  return region.slice(0, end + 4);
}

/** 加载纯解析模块。 */
function loadCalloutMeta() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/callout-meta.js', 'utf8'), sandbox);
  return sandbox.HWChatCalloutMeta;
}

/**
 * 在沙箱里跑 chat.js 的那段代码。
 *
 * t 用桩实现：只关心「没有标题时是否取了默认文案」，不关心具体语言的措辞。
 */
function loadCalloutNode(iconsModule) {
  const source = readFileSync('media/chat.js', 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.HWChatIcons = iconsModule;
  sandbox.HWChatCalloutMeta = loadCalloutMeta();
  sandbox.document = {
    createElement: (tag) => makeNode(tag),
    importNode: (node) => ({ tagName: node.tagName, imported: true }),
  };
  sandbox.DOMParser = class {
    parseFromString(markup) {
      const match = String(markup).match(/^<([a-zA-Z]+)/);
      return { documentElement: { tagName: match ? match[1] : 'parsererror' } };
    }
  };
  sandbox.t = (key) => ({ 'chat.calloutDanger': '危险', 'chat.calloutImportant': '重要' }[key] || key);
  vm.createContext(sandbox);
  vm.runInContext(`${extractCalloutBlock(source)}\nglobalThis.__calloutNode = calloutNode;`, sandbox);
  return sandbox.__calloutNode;
}

function loadIcons() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/ui-icons.js', 'utf8'), sandbox);
  return sandbox.HWChatIcons;
}

const icons = loadIcons();
const calloutNode = loadCalloutNode(icons);

/** 造好一个提醒块节点后跑一次正文回调，模拟 appendRichText 的递归调用。 */
function render(plan) {
  let bodyRendered = false;
  const node = calloutNode(plan, (body) => {
    bodyRendered = true;
    body.append(makeNode('p'));
  });
  return { node, bodyRendered };
}

// ① 危险：结构正确，标题与图标都在 head 里。
{
  const { node, bodyRendered } = render({ tone: 'danger', title: '会删掉数据', body: '说明' });
  check('危险 → 容器类是 message-callout', node.className === 'message-callout');
  check('危险 → data-tone="danger"（CSS 靠它选中红色标题）', node.dataset.tone === 'danger');
  const [head, body] = node.children;
  check('危险 → 先 head 后 body', head && head.className === 'callout-head' && body && body.className === 'callout-body');
  const [icon, title] = head.children;
  check('危险 → head 里是图标 + 标题', head.children.length === 2 && title.className === 'callout-title');
  check('危险 → 图标带 callout-icon 类', icon.classList.contains('callout-icon'));
  check('危险 → 图标真的产出了 svg（不是文字退路）', icon.children[0] && icon.children[0].tagName === 'svg');
  check('危险 → 标题用解析出来的文字', title.textContent === '会删掉数据');
  check('危险 → 正文回调被调用', bodyRendered && body.children.length === 1);
}

// ② 重要：同一套结构，tone 不同（配色由 CSS 按 tone 分开）。
{
  const { node } = render({ tone: 'important', title: '先备份', body: '' });
  check('重要 → data-tone="important"', node.dataset.tone === 'important');
  check('重要 → 标题照原样', node.children[0].children[1].textContent === '先备份');
  // 只有标题没有正文时不该留下一个空的正文容器（会多出一段空白）。
  check('重要 → 无正文时不生成 body 容器', node.children.length === 1);
}

// ③ 没写标题：用文案表的默认名，不能出现「图标下面空一片」。
{
  const danger = render({ tone: 'danger', title: '', body: '' }).node;
  const important = render({ tone: 'important', title: '', body: '' }).node;
  check('无标题 → 危险取默认文案', danger.children[0].children[1].textContent === '危险');
  check('无标题 → 重要取默认文案', important.children[0].children[1].textContent === '重要');
}

// ④ 接线：chat.js 必须真的在引用块分支里调用解析器和 calloutNode，且保留普通引用退路。
{
  const source = readFileSync('media/chat.js', 'utf8');
  check('接线 → 读全局 HWChatCalloutMeta', source.includes('const calloutMeta = globalThis.HWChatCalloutMeta || null;'));
  check('接线 → 引用块分支里调用 parseCallout', source.includes('calloutMeta.parseCallout(quoted)'));
  // 正文块统一走 push(node, startLine) 以便流式增量更新按块定位，所以只钉住「调用了 calloutNode」。
  check('接线 → 解析成功时走 calloutNode', source.includes('calloutNode(callout'));
  // 「其他的显示不变」靠这一行保证：解析不出来还要能落到原来的 blockquote。
  check('接线 → 解析失败仍走普通 blockquote', source.includes("const node = document.createElement('blockquote');"));
  check('接线 → 缺少脚本时退化不抛错', source.includes('calloutMeta ? calloutMeta.parseCallout(quoted) : null'));
  check('退路 → warn 图标有文字回退字符', source.includes("warn: '⚠'"));
}

// ⑤ 配色：三档差异必须只落在「标题红 / 图标亮黄 / 图标橘黄」上。
{
  const css = readFileSync('media/chat.css', 'utf8');
  check('配色 → 危险图标是亮黄色', /--callout-danger-icon:\s*#ffcc00/i.test(css));
  check('配色 → 危险标题取 --danger（红色）', /\.message-callout\[data-tone="danger"\]\s*\.callout-title\s*\{[^}]*color:\s*var\(--danger\)/i.test(css));
  check('配色 → 危险图标取亮黄变量', /\.message-callout\[data-tone="danger"\]\s*\.callout-icon\s*\{[^}]*color:\s*var\(--callout-danger-icon\)/i.test(css));
  check('配色 → 重要图标取橘黄变量', /\.message-callout\[data-tone="important"\]\s*\.callout-icon\s*\{[^}]*color:\s*var\(--callout-important-icon\)/i.test(css));
  // 重要级别的标题必须保持原色：这一条是需求里的「标题不变色」。
  const importantTitle = css.match(/\.message-callout\[data-tone="important"\]\s*\.callout-title\s*\{([^}]*)\}/i);
  check('配色 → 重要标题不变色（inherit）', Boolean(importantTitle) && /color:\s*inherit/i.test(importantTitle[1]));
  check('配色 → 重要标题没有被染红', Boolean(importantTitle) && !/--danger/.test(importantTitle[1]));
  // 提醒块本身沿用引用块的引用线，不额外涂底：分量来自红色标题，不是整块铺红。
  const box = css.match(/\.message-callout\s*\{([^}]*)\}/i);
  check('配色 → 提醒块不额外铺底色', Boolean(box) && !/background/i.test(box[1]));
}

// ⑥ 注入顺序：callout-meta.js 必须在 chat.js 之前，否则启动时读不到、永远走退化路径。
{
  const panel = readFileSync('src/views/chatPanel.ts', 'utf8');
  check('注入 → 引用了 callout-meta.js', panel.includes("'callout-meta.js'"));
  const calloutAt = panel.indexOf('src="${calloutScript}"');
  const chatAt = panel.indexOf('src="${script}"');
  check('注入 → 在 chat.js 之前加载', calloutAt > 0 && chatAt > 0 && calloutAt < chatAt);
}

// ⑦ 文案：默认标题必须有中英文，缺了会显示成键名。
{
  const i18n = readFileSync('src/core/i18n.ts', 'utf8');
  check('文案 → 有 chat.calloutDanger', i18n.includes("'chat.calloutDanger'"));
  check('文案 → 有 chat.calloutImportant', i18n.includes("'chat.calloutImportant'"));
}

console.log(failures ? `\n${failures} 项失败 / 共 ${checks} 项` : `\n全部通过（${checks} 项）`);
process.exit(failures ? 1 : 0);
