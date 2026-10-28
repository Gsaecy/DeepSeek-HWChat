/*
 * 校验「正文里的文件引用」这条链路真的接上了。
 *
 * 为什么不能只做静态断言：最要紧的几条语义都是**运行时**的——
 *   - 正文里裸写的路径要显示成完整绝对路径（用户要在 VS Code 之外找文件）；
 *   - 反引号里的引用要显示成短的相对路径；
 *   - 右键要弹菜单、点菜单第一项要发出 revealFile；
 *   - 版本号、网址这类东西不能长出菜单来。
 * 这些都没法靠 grep 证明。所以这里把 chat.js 里真正的那段切出来，
 * 配一个最小 DOM 跑一遍。
 *
 * 用法：node test/check-file-reference-dom.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let checks = 0;
let failures = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_CSS = readFileSync('media/chat.css', 'utf8');
const ICONS = readFileSync('media/ui-icons.js', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const TYPES = readFileSync('src/core/types.ts', 'utf8');

/* ── 1. 接线：少任何一处，功能都会静默失效 ───────────────── */

check('扩展在 HTML 里加载了 file-reference.js', /const fileRefScript = mediaUri\(webview, this\.extensionUri, 'file-reference\.js'\)/.test(PANEL));
check('脚本标签排在 chat.js 之前', PANEL.indexOf('src="${fileRefScript}"') > 0 && PANEL.indexOf('src="${fileRefScript}"') < PANEL.indexOf('src="${script}"'));
check('消息协议里有 revealFile', /\| \{ type: 'revealFile'/.test(PANEL) && /case 'revealFile':/.test(PANEL));
check('消息协议里有 openFileReference', /\| \{ type: 'openFileReference'/.test(PANEL) && /case 'openFileReference':/.test(PANEL));
check('用官方命令 revealFileInOS（三平台都是「打开文件管理器并选中」）', PANEL.includes("executeCommand('revealFileInOS', uri)"));
check('状态里下发了工作区根与项目根', /fileRoots: \{/.test(PANEL) && /preferred: this\.projectRootFor\(conversation\)/.test(PANEL));
check('平台判断只有一处（revealTargetFor）', PANEL.includes('revealTargetFor(process.platform)'));
check('类型里声明了 fileRoots / fileTarget', TYPES.includes('fileRoots: { roots: string[]; preferred?: string }') && TYPES.includes("fileTarget: 'finder' | 'explorer' | 'fileManager'"));
check('chat.js 从状态里读回 fileRoots', /state\.fileRoots = nextRoots;/.test(CHAT_JS) && CHAT_JS.includes('incoming.fileRoots'));
check('行内渲染走 appendPlainText（裸路径）与 fileReferenceNode（反引号）',
  CHAT_JS.includes('if (index > cursor) appendPlainText(parent, value.slice(cursor, index));')
  && CHAT_JS.includes('if (cursor < value.length) appendPlainText(parent, value.slice(cursor));')
  && CHAT_JS.includes('fileReferenceNode(codeText, { compact: true, allowSpaces: true })'));
check('右键菜单挂在 contextmenu 上', CHAT_JS.includes("addEventListener('contextmenu'"));
check('样式有悬停位移与降级动效', CHAT_CSS.includes('.file-ref:hover') && CHAT_CSS.includes('transform: translateY(-1px)') && CHAT_CSS.includes('prefers-reduced-motion'));
check('图标集里有 file / folder / copy', /\bfile: \{/.test(ICONS) && /\bfolder: \{/.test(ICONS) && /\bcopy: \{/.test(ICONS));
check('图标集里有 tree（「在资源管理器视图中显示」用，不能和 folder 撞形状）', /\btree: \{/.test(ICONS) && ICONS.includes("d=\"M4.2 3.4v9.2\""));
check('消息协议里有 revealFileInExplorer', /\| \{ type: 'revealFileInExplorer'/.test(PANEL) && /case 'revealFileInExplorer':/.test(PANEL));
check('用官方命令 revealInExplorer（在 VS Code 资源管理器里定位）', PANEL.includes("executeCommand('revealInExplorer', uri)"));
check('定位后把资源管理器视图调出来（否则选中了也看不见）', PANEL.includes("executeCommand('workbench.view.explorer')"));
check('工作区外的文件先拦一道（revealInExplorer 对它静默无效）',
  PANEL.includes('isInsideWorkspace(uri.fsPath, roots)') && PANEL.includes("tt('error.fileRefOutsideWorkspace')"));
check('「在系统中显示」与「在资源管理器视图中显示」是两条独立消息', CHAT_JS.includes("post('revealFile', fileReferencePayload(reference))") && CHAT_JS.includes("post('revealFileInExplorer', fileReferencePayload(reference))"));
check('消息协议里有 verifyFileReferences（渲染后回问真实文件）',
  /\| \{ type: 'verifyFileReferences'; requestId: string; items: FileReferenceQuery\[\] \}/.test(PANEL) && /case 'verifyFileReferences':/.test(PANEL));
check('扩展侧按「候选存在性」判定，不靠猜', PANEL.includes('chooseReferenceMatch') && PANEL.includes('exists: (candidate) => existsSync(candidate)'));
check('裸文件名合并成一次搜索（经统一搜索调度层与批量核实模块）',
  PANEL.includes('resolveFileReferences(') && PANEL.includes('searchWorkspace(')
  && readFileSync('src/agent/fileReferenceBatch.ts', 'utf8').includes('filenameSearchName'));
/*
 * 这条盯的是一处差点写错的地方：排除列表里原本有 `out`，
 * 而 `extension.js` 的真实位置就是 `out/extension.js` —— 排掉它，
 * 这条主用例就永远只能降级，功能等于没修。
 */
check('按文件名搜索用 minimal 排除档，不排除构建产物目录（`extension.js` 就在 out 里）',
  PANEL.includes("exclude: 'minimal'") && !PANEL.includes('{node_modules,.git,out'));
check('同名多份只认唯一命中（猜错文件比不给引用更糟）', /unique\.size !== 1/.test(readFileSync('src/agent/fileReferenceResolve.ts', 'utf8')));
check('核实结论回给界面', /case 'fileReferencesVerified': applyFileReferenceVerification\(message\); break;/.test(CHAT_JS));
check('判不出来就降级成普通文本', CHAT_JS.includes('function demoteFileReference(') && CHAT_JS.includes('function upgradeFileReference('));

/* ── 1b. 「文件标签后面的文字会跳动」的接线 ─────────────────────
   流式输出每 70ms 会把正在增长的那一段重排一遍，标签跟着重造。只要重造出来的
   标签和上一帧长得不一样，后面的文字就会被推来推去。这两条保证「长一个样」。 */
check('核实结论按「首选根 + 路径」缓存', CHAT_JS.includes('const fileReferenceResolution = new Map()') && CHAT_JS.includes('function rememberReferenceResolution('));
check('应答先落缓存再动 DOM', /rememberReferenceResolution\(entry\.reference, absolute\);\s*\n\s*if \(absolute\) upgradeFileReference/.test(CHAT_JS));
check('重建标签时直接套用已核实结论（不再晚一拍改短变长）', /const known = cachedReferenceResolution\(reference\)/.test(CHAT_JS) && /buildFileReferenceNode\(entry, known\)/.test(CHAT_JS));
/* 标签宽度不再来回变，靠的是「同一颗标签只有一个算法」：
   首次渲染、沿用缓存结论的重建、核实后的原地更新，三处都调 fileReferenceLabel()，
   所以只要结论相同，算出来的标签就一模一样（而不是各自拼一遍短/长两种写法）。 */
check('标签文字只有一个计算处', /function fileReferenceLabel\(entry\)/.test(CHAT_JS));
check('首次渲染走 fileReferenceLabel', /const label = fileReferenceLabel\(entry\);/.test(CHAT_JS));
check('核实后的原地更新也走同一个函数', /function upgradeFileReference[\s\S]{0,700}?entry\.labelNode\.textContent = fileReferenceLabel\(entry\);/.test(CHAT_JS));
check('没有任何地方自己拼标签（避免第三套写法）',
  (CHAT_JS.match(/labelNode\.textContent =/g) || []).length === 1);
check('工作区根变化时缓存整份作废', CHAT_JS.includes('fileReferenceResolution.clear()') && CHAT_JS.includes('fileRootsSignature'));
check('纯文字续写走原地追加（不重造段落里的标签）', CHAT_JS.includes('canAppendPlainText(appended, lastBlock.node, tailNode)') && CHAT_JS.includes("globalThis.HWChatInlineAppend"));
check('占位文案不参与增量（否则正文会接在「正在继续处理…」后面）', CHAT_JS.includes('if (flow.placeholder) return false;'));

/* ── 2. 最小 DOM ─────────────────────────────────────────── */

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attrs = {};
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.tabIndex = -1;
    this.type = '';
    this.style = {};
    this.parent = null;
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parent = this;
      this.children.push(node);
    }
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((item) => item !== handler));
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  /**
   * 降级时要把引用节点换成普通文本节点。
   *
   * 真实的 DOM 有 `replaceWith`，这个最小实现只提供 `replaceChild`，
   * 顺带验证了 chat.js 里的降级代码在两种写法下都能工作。
   */
  replaceChild(next, current) {
    const index = this.children.indexOf(current);
    if (index < 0) return;
    next.parent = this;
    this.children[index] = next;
    current.parent = null;
  }
  getBoundingClientRect() { return { width: 180, height: 96, left: 0, top: 0 }; }
  fire(type, event = {}) {
    const payload = { preventDefault: () => {}, stopPropagation: () => {}, clientX: 40, clientY: 40, ...event };
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
  }
}

const posted = [];
const documentListeners = new Map();
const fakeDocument = {
  body: new FakeElement('body'),
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  addEventListener: (type, handler) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(handler);
  },
  removeEventListener: (type, handler) => {
    const list = documentListeners.get(type) || [];
    documentListeners.set(type, list.filter((item) => item !== handler));
  },
};
const fakeWindow = {
  innerWidth: 900,
  innerHeight: 700,
  addEventListener: () => {},
  removeEventListener: () => {},
};

/** 真正的 media/file-reference.js，跑在自己的沙箱里。 */
function loadFileRef() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/file-reference.js', 'utf8'), sandbox);
  return sandbox.HWChatFileRef;
}

/** 把 chat.js 里「文件引用的渲染与右键菜单」整段切出来。 */
function extractBlock(source) {
  const start = source.indexOf('function fileReferenceContext(');
  const end = source.indexOf('/** 行内格式：');
  if (start < 0 || end <= start) throw new Error('没找到 chat.js 里的文件引用代码');
  return source.slice(start, end);
}

const ROOT = '/Users/guohongyu/AI projects/DeepSeek-HWChat';

/**
 * 用真实的段落代码造一套可调用的函数。
 *
 * `fileTarget` 换成参数是为了在同一套代码上验 macOS 与 Windows 的菜单文案——
 * 用户明确要求「macOS 打开 Finder、Windows 打开资源管理器」。
 */
function buildHarness(fileTarget) {
  const labels = {
    'chat.fileRefTarget.finder': 'Finder',
    'chat.fileRefTarget.explorer': '资源管理器',
    'chat.fileRefTarget.fileManager': '文件管理器',
    'chat.fileRefReveal': `在{target}中显示`,
    'chat.fileRefRevealInExplorer': '在资源管理器视图中显示',
    'chat.fileRefOpenEditor': '在编辑器中打开',
    'chat.fileRefCopyPath': '复制完整路径',
    'chat.fileRefHint': '左键在编辑器中打开，右键在{target}中显示',
  };
  const t = (key, vars) => {
    const template = labels[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
  };
  const textElement = (tag, className, text) => {
    const node = new FakeElement(tag);
    if (className) node.className = className;
    node.textContent = text === undefined ? '' : String(text);
    return node;
  };
  const iconNode = (name) => {
    const wrapper = new FakeElement('span');
    wrapper.className = 'ui-icon';
    wrapper.attrs['data-icon'] = name;
    return wrapper;
  };
  const post = (type, payload = {}) => posted.push({ type, ...payload });
  const requestClipboardWrite = (text, button, idle) => posted.push({ type: 'copyText-internal', text, button, idle });
  const state = { fileRoots: { roots: [ROOT], preferred: ROOT }, fileTarget };

  const factory = new Function(
    'fileRef', 'state', 't', 'iconNode', 'textElement', 'post', 'requestClipboardWrite', 'document', 'window',
    `${extractBlock(CHAT_JS)}
     return { fileReferenceNode, appendPlainText, openFileReferenceMenu, closeFileReferenceMenu, fileTargetLabel, flushFileReferenceCheck, applyFileReferenceVerification };`,
  );
  return factory(loadFileRef(), state, t, iconNode, textElement, post, requestClipboardWrite, fakeDocument, fakeWindow);
}

/** 递归收集所有 span.file-ref 节点。 */
function collectRefs(node, out = []) {
  if (node && typeof node === 'object') {
    if (typeof node.className === 'string' && node.className.split(/\s+/).includes('file-ref')) out.push(node);
    for (const child of node.children ?? []) collectRefs(child, out);
  }
  return out;
}

function labelOf(chip) {
  const label = (chip.children ?? []).find((child) => child.className === 'file-ref-label');
  return label ? label.textContent : '';
}

/** 把父节点的子节点还原成字符串，用来确认「非引用部分原样保留」。 */
function textOf(node) {
  if (node.nodeType === 3) return node.textContent;
  return (node.children ?? []).map((child) => textOf(child)).join('');
}

/* ── 3. 行为：裸路径显示完整路径 ─────────────────────────── */

{
  const harness = buildHarness('finder');
  const parent = new FakeElement('p');
  harness.appendPlainText(parent, '改动在 src/core/ids.ts 与 v0.2.4 两个地方');
  const refs = collectRefs(parent);
  check('正文里裸写的路径渲染成文件引用', refs.length === 1, `实际 ${refs.length} 个`);
  check('裸写路径显示**完整绝对路径**（没写引用格式时的要求）',
    refs.length === 1 && labelOf(refs[0]) === `${ROOT}/src/core/ids.ts`,
    refs.length === 1 ? labelOf(refs[0]) : '');
  check('版本号 v0.2.4 不会被当成文件', !refs.some((chip) => labelOf(chip).includes('0.2.4')));
  check('非路径文字原样保留', textOf(parent).includes('改动在 ') && textOf(parent).includes('两个地方'));
}

/* ── 4. 行为：引用格式显示相对路径 + 行号 ────────────────── */

{
  const harness = buildHarness('finder');
  const parent = new FakeElement('p');
  const chip = harness.fileReferenceNode('media/chat.js:745', { compact: true, allowSpaces: true });
  check('反引号里的路径渲染成文件引用', Boolean(chip));
  parent.append(chip);
  check('写了引用格式时显示相对路径 + 行号', labelOf(chip) === 'media/chat.js:745', labelOf(chip));
  check('悬停提示里带完整绝对路径', String(chip.title).includes(`${ROOT}/media/chat.js`), String(chip.title));
  check('悬停提示里说明右键能做什么', String(chip.title).includes('右键在')) ;
}

/* ── 5. 行为：左键打开、右键弹菜单 ───────────────────────── */

{
  const harness = buildHarness('finder');
  const chip = harness.fileReferenceNode('src/a.ts:12', { compact: true });
  posted.length = 0;
  chip.fire('click');
  const open = posted.find((item) => item.type === 'openFileReference');
  check('左键点引用 → openFileReference', Boolean(open));
  check('打开时带上绝对路径', open && open.path === `${ROOT}/src/a.ts`, open && open.path);
  check('打开时带上行号', open && open.line === 12, open ? String(open.line) : '');

  posted.length = 0;
  chip.fire('contextmenu');
  const menu = fakeDocument.body.children.find((child) => child.className === 'file-ref-menu');
  check('右键弹出菜单', Boolean(menu));
  const items = (menu?.children ?? []).map((item) => (item.children ?? []).map((child) => child.textContent).join(''));
  check('菜单有四项：在 Finder 中显示 / 在资源管理器视图中显示 / 打开 / 复制路径',
    items.length === 4
      && items[0].includes('在Finder中显示')
      && items[1].includes('在资源管理器视图中显示')
      && items[2].includes('在编辑器中打开')
      && items[3].includes('复制完整路径'),
    JSON.stringify(items));
  const explorerItem = (menu?.children ?? [])[1];
  check('「在资源管理器视图中显示」用 tree 图标（与 folder 区分）',
    explorerItem?.children?.[0]?.attrs?.['data-icon'] === 'tree',
    JSON.stringify(explorerItem?.children?.[0]?.attrs));

  posted.length = 0;
  menu.children[0].fire('click');
  const reveal = posted.find((item) => item.type === 'revealFile');
  check('点「在 Finder 中显示」 → revealFile', Boolean(reveal));
  check('revealFile 带绝对路径与行号', reveal && reveal.path === `${ROOT}/src/a.ts` && reveal.line === 12);
  check('点第一项不会误发「在资源管理器视图中显示」', !posted.some((item) => item.type === 'revealFileInExplorer'));

  posted.length = 0;
  chip.fire('contextmenu');
  const menu2 = fakeDocument.body.children.find((child) => child.className === 'file-ref-menu');
  menu2.children[1].fire('click');
  const inExplorer = posted.find((item) => item.type === 'revealFileInExplorer');
  check('点「在资源管理器视图中显示」 → revealFileInExplorer', Boolean(inExplorer), JSON.stringify(posted));
  check('revealFileInExplorer 带绝对路径与行号', inExplorer && inExplorer.path === `${ROOT}/src/a.ts` && inExplorer.line === 12);
  check('点第二项不会误发「在系统中显示」', !posted.some((item) => item.type === 'revealFile'));
  check('菜单点完自己收起来', !fakeDocument.body.children.some((child) => child.className === 'file-ref-menu'));
}

/* ── 6. Windows 上叫「资源管理器」───────────────────────── */

{
  const harness = buildHarness('explorer');
  const chip = harness.fileReferenceNode('src/a.ts', { compact: true });
  chip.fire('contextmenu');
  const menu = fakeDocument.body.children.find((child) => child.className === 'file-ref-menu');
  const labelOfItem = (index) => {
    const item = (menu?.children ?? [])[index];
    return (item?.children ?? []).map((child) => child.textContent).join('');
  };
  const osLabel = labelOfItem(0);
  const vscodeLabel = labelOfItem(1);
  check('Windows 平台第一项写成「在资源管理器中显示」', osLabel.includes('在资源管理器中显示'), osLabel);
  /*
   * 这条是这次改措辞的直接理由：Windows 上系统文件管理器也叫「资源管理器」，
   * 两项若都叫「在资源管理器中显示」，用户无法判断哪个是打开系统窗口、
   * 哪个是定位 VS Code 侧边栏。所以第二项采用 VS Code 自己的措辞。
   */
  check('Windows 上两条菜单文案必须能区分（不能都叫「在资源管理器中显示」）',
    osLabel !== vscodeLabel && vscodeLabel.includes('视图'),
    JSON.stringify([osLabel, vscodeLabel]));
  harness.closeFileReferenceMenu();
}

/* ── 7. 核实：判不出来的引用降级成普通文本 ─────────────── */

/*
 * 这一节盯的是真实缺陷：模型正文里裸写的 `extension.js` 只是**裸文件名**，
 * 原来「有扩展名就当文件、直接拼到项目根上」，于是它变成了一个指向
 * `<根>/extension.js` 的引用，点开报「文件不存在」。
 * 现在渲染后会回问扩展侧，判不出来就还原成原文。
 */
{
  const harness = buildHarness('finder');
  const parent = new FakeElement('p');
  harness.appendPlainText(parent, '另外中文在 extension.js 里被 transcode 了');
  const refs = collectRefs(parent);
  check('裸文件名先按引用渲染（等扩展核实）', refs.length === 1, `实际 ${refs.length} 个`);

  harness.flushFileReferenceCheck();
  const request = posted.filter((item) => item.type === 'verifyFileReferences').pop();
  check('渲染完发出一条核实请求（不是每个引用各发一条）', Boolean(request), JSON.stringify(posted.map((item) => item.type)));
  check('请求里带的是**正文原始写法**与项目根',
    request?.items?.[0]?.path === 'extension.js' && request?.items?.[0]?.root === ROOT,
    JSON.stringify(request?.items));

  posted.length = 0;
  harness.applyFileReferenceVerification({ requestId: request.requestId, resolved: [null] });
  check('核实不到 → 引用消失（不再是可点标签）', collectRefs(parent).length === 0);
  check('降级后原文一字不差地保留',
    textOf(parent).includes('extension.js') && textOf(parent).includes('被 transcode 了'),
    textOf(parent));
}

/* ── 8. 核实到另一个文件：标签与点击目标一起换 ─────────── */

{
  const harness = buildHarness('finder');
  const parent = new FakeElement('p');
  harness.appendPlainText(parent, '中文在 extension.js 里被转义了');
  const chip = collectRefs(parent)[0];
  check('核实前标签是按项目根猜的完整路径', labelOf(chip) === `${ROOT}/extension.js`, labelOf(chip));

  harness.flushFileReferenceCheck();
  const request = posted.filter((item) => item.type === 'verifyFileReferences').pop();
  harness.applyFileReferenceVerification({ requestId: request.requestId, resolved: [`${ROOT}/out/extension.js`] });
  check('核实到 `out/extension.js` 后标签换成真实路径',
    labelOf(chip) === `${ROOT}/out/extension.js`, labelOf(chip));
  check('悬停提示也同步换成真实路径', String(chip.title).includes(`${ROOT}/out/extension.js`), String(chip.title));

  posted.length = 0;
  chip.fire('click');
  const open = posted.find((item) => item.type === 'openFileReference');
  check('点开的是核实过的真实路径（不是猜的那个）',
    open?.path === `${ROOT}/out/extension.js`, open?.path);
}

/* ── 9. 反引号引用同样走核实，且保持短的相对写法 ────────── */

{
  const harness = buildHarness('finder');
  const chip = harness.fileReferenceNode('extension.js', { compact: true, allowSpaces: true });
  check('反引号里的裸文件名先渲染成引用', Boolean(chip));
  harness.flushFileReferenceCheck();
  const request = posted.filter((item) => item.type === 'verifyFileReferences').pop();
  harness.applyFileReferenceVerification({ requestId: request.requestId, resolved: [`${ROOT}/out/extension.js`] });
  check('引用格式下仍显示相对路径（不显示整条绝对路径）',
    labelOf(chip) === 'out/extension.js', labelOf(chip));
}

/* ── 10. 退化：没有工作区根时不造假引用 ─────────────────── */
{
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/file-reference.js', 'utf8'), sandbox);
  const fileRef = sandbox.HWChatFileRef;
  check('没有工作区根时相对路径解析为 null（不瞎拼绝对路径）', fileRef.resolveReference(fileRef.parseReference('src/a.ts'), {}) === null);
}

console.log(`\n${checks - failures}/${checks} 通过`);
process.exit(failures ? 1 : 0);
