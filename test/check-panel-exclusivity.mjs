// 面板互斥展开的真实验证：
// 从 media/chat.js 里原样抽出渲染与锁逻辑，配一个最小 DOM 跑一遍用户描述的操作序列，
// 断言「同一时刻只展开一个面板」「收起后还原」「锁住时点了不开」。
//
// 为什么不用 jsdom：项目没有 DOM 测试依赖，而这个检查只需要 <details>/<summary> 的
// open 状态、classList 与点事件，最小实现足够，且不引入新依赖。
//
// 运行：node test/check-panel-exclusivity.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CHAT_JS = readFileSync('media/chat.js', 'utf8');

/**
 * 从 chat.js 源码里取出 `const NAME = 表达式;` 的数值。
 * 胶囊常量的唯一来源是 media/chat.js，本文件不再复制一份：
 * 复制会让「测试通过」和「实际尺寸变了」同时成立，等于没守住。
 */
function numberConst(name) {
  const match = CHAT_JS.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!match) throw new Error(`media/chat.js 里找不到 ${name}`);
  return Function(`'use strict'; return (${match[1]});`)();
}

/* ── 最小 DOM ────────────────────────────────────────────────── */

class ClassList {
  constructor(node) { this.node = node; this.set = new Set(); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
}

class StubNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = '';
    this.hidden = false;
    this.open = false;
    this.clientWidth = 800;
    this.style = {
      setProperty: (name, value) => { this.style[name] = value; },
      backgroundColor: '',
    };
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(value) {
    this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = []; for (const node of nodes) this.appendChild(node); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  /** 模拟一次用户点击：先跑监听器（可能 preventDefault），再执行 <details> 的默认切换。 */
  click() {
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    const handler = this.listeners.get('click');
    if (handler) handler(event);
    if (prevented) return;
    const details = this.closest('DETAILS');
    if (details) details.open = !details.open;
  }
  closest(tagName) {
    let node = this;
    while (node) {
      if (node.tagName === String(tagName).toUpperCase()) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    const want = String(selector).toUpperCase();
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName === want) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  scrollIntoView() {}
}

const document = { createElement: (tag) => new StubNode(tag) };

/* ── 抽取 chat.js 里的函数源码 ───────────────────────────────── */

/** 数大括号取出一段代码（从给定起点行开始）。 */
function extractBlock(sourceText, needle) {
  let start = sourceText.indexOf(needle);
  if (start < 0) throw new Error(`chat.js 里找不到代码块：${needle}`);
  // needle 可能带着前导换行，先跳过它，否则第一「行」是空行、大括号计数会立刻归零。
  while (start < sourceText.length && (sourceText[start] === '\n' || sourceText[start] === '\r')) start += 1;
  const lines = sourceText.slice(start).split('\n');
  const body = [];
  let depth = 0;
  for (const line of lines) {
    body.push(line);
    for (const char of line) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    if (depth <= 0) break;
  }
  return body.join('\n');
}

/** 按「两空格缩进的顶层函数」切段：这些函数在文件里都是 2 空格缩进的声明。 */
function extract(name) {
  return extractBlock(CHAT_JS, `\n  function ${name}(`).replace(/^\n/, '');
}

const todoPanelState = (() => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/todo-panel-state.js', 'utf8'), sandbox);
  return sandbox.HWChatTodoPanelState;
})();

/* ── 建面板 ──────────────────────────────────────────────────── */

function panel(id, classes) {
  const details = new StubNode('details');
  details.className = classes;
  details.hidden = true;
  const summary = new StubNode('summary');
  const list = new StubNode(id === 'todoPanel' ? 'ol' : 'ol');
  details.append(summary, list);
  details.list = list;
  details.summary = summary;
  return details;
}

const elements = {
  taskTree: panel('taskTree', 'task-tree'),
  todoPanel: panel('todoPanel', 'todo-panel'),
  todoArchivePanel: panel('todoArchivePanel', 'todo-panel archived'),
  todoArchiveBar: (() => { const bar = new StubNode('div'); bar.hidden = true; return bar; })(),
  todoSummary: { textContent: '' },
  todoArchiveSummary: { textContent: '' },
  // 顶栏「继续执行 / 取消任务」：renderTodos 会调 syncTodoSummaryActions 设置显隐，
  // 这两个按钮的具体行为由 test/check-todo-actions.mjs 单独验证，这里只要有节点可写即可。
  todoSummaryActions: (() => { const node = new StubNode('span'); node.hidden = true; return node; })(),
  resumeTodosButton: (() => { const node = new StubNode('button'); node.hidden = true; return node; })(),
  cancelTodosButton: (() => { const node = new StubNode('button'); node.hidden = true; return node; })(),
  toast: { textContent: '', dataset: {}, hidden: true },
};
elements.todoList = elements.todoPanel.list;
elements.todoArchiveList = elements.todoArchivePanel.list;

const state = {
  todos: [],
  todoArchives: [],
  expandedArchiveId: null,
  archiveRestore: null,
  todosInterrupted: false,
  todoSignature: '',
};

const toasts = [];
const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
const showToast = (text) => { toasts.push(text); };
const formatTime = (value) => new Date(value).toISOString().slice(11, 16);
/**
 * 图标桩：真实实现见 media/ui-icons.js，它的 DOM 构造由 test/check-icons-dom.mjs 单独验证。
 * 这里只关心「清单状态有没有挂上图标」，所以返回一个带 data-icon 的占位节点。
 */
const iconNode = (name) => { const node = new StubNode('span'); node.className = 'ui-icon'; node.dataset.icon = name; return node; };

/* ── 把抽出来的函数装进同一个作用域 ─────────────────────────── */

const source = [
  'textElement',
  'renderTodoItems',
  'isArchiveFocused',
  'syncPanelLock',
  'collapsePeers',
  'enterArchiveFocus',
  'exitArchiveFocus',
  'togglePanel',
  'renderTodos',
  'syncTodoSummaryActions',
  'renderArchivePanel',
  'renderTodoArchives',
  'layoutTodoArchives',
].map(extract).join('\n\n')
  // 标题栏监听也原样抽出来：这三行是「锁住时点了不开」的唯一入口，必须一起验证。
  + '\n\n'
  + extractBlock(CHAT_JS, "  for (const key of ['taskTree', 'todoPanel', 'todoArchivePanel']) {");

const factory = new Function(
  'elements', 'state', 'document', 'todoPanelState', 't', 'showToast', 'formatTime', 'iconNode',
  `const CAPSULE_BASE_HEIGHT = ${numberConst('CAPSULE_BASE_HEIGHT')};
   const CAPSULE_MIN_HEIGHT = ${numberConst('CAPSULE_MIN_HEIGHT')};
   const CAPSULE_RATIO = ${numberConst('CAPSULE_RATIO')};
   let lastCapsuleBarWidth = 0;
   ${source}
   return { renderTodos, renderArchivePanel, renderTodoArchives, togglePanel, enterArchiveFocus, exitArchiveFocus, state };`,
);

const ui = factory(elements, state, document, todoPanelState, t, showToast, formatTime, iconNode);

/* ── 断言 ────────────────────────────────────────────────────── */

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`✓ ${label}`); return; }
  failures += 1;
  console.log(`✗ ${label} — ${detail}`);
}

function snapshot() {
  return {
    taskTree: elements.taskTree.open,
    todoPanel: elements.todoPanel.open,
    archivePanel: elements.todoArchivePanel.open && !elements.todoArchivePanel.hidden,
    active: elements.todoArchiveBar.children
      .filter((capsule) => capsule.classList.contains('active'))
      .map((capsule) => capsule.dataset.archiveId),
    locked: elements.taskTree.classList.contains('panel-locked') && elements.todoPanel.classList.contains('panel-locked'),
  };
}

function seed({ todos = [], archives = [] } = {}) {
  state.todos = todos;
  state.todoArchives = archives;
  state.expandedArchiveId = null;
  state.archiveRestore = null;
  state.todoSignature = '';
  elements.taskTree.hidden = false;
  elements.taskTree.open = true;
  elements.todoPanel.hidden = false;
  elements.todoPanel.open = true;
  elements.todoArchivePanel.hidden = true;
  elements.todoArchivePanel.open = false;
  ui.renderTodoArchives();
}

const archive = (id, at) => ({
  id,
  createdAt: at,
  color: '#7cbef0',
  completed: 2,
  total: 2,
  todos: [{ content: `${id}-1`, status: 'completed' }, { content: `${id}-2`, status: 'completed' }],
});
const todos = (count) => Array.from({ length: count }, (_, index) => ({ content: `步骤 ${index + 1}`, status: index === 0 ? 'in_progress' : 'pending' }));

// 场景 1：起始状态（用户手动开着任务树和任务清单）
seed({ todos: todos(3), archives: [archive('a', 1), archive('b', 2), archive('c', 3)] });
ui.renderTodos();
let view = snapshot();
check('起始：任务树与任务清单都展开', view.taskTree && view.todoPanel, JSON.stringify(view));
check('起始：没有胶囊处于展开态', view.active.length === 0, JSON.stringify(view.active));

// 清单状态的图形：执行中是三个跳动点，其它状态挂 SVG 图标（形状定义见 media/ui-icons.js）。
// 这里只验证「挂上了图标节点」，图标的几何规格由 src/test/uiIcons.test.ts 覆盖。
const inProgressStatus = elements.todoList.children[0].children[2];
const pendingStatus = elements.todoList.children[1].children[2];
check(
  '清单状态：执行中仍是三个跳动点',
  inProgressStatus.children.length === 3 && inProgressStatus.children.every((node) => node.tagName === 'I'),
  inProgressStatus.children.map((node) => node.tagName).join(','),
);
check(
  '清单状态：待办挂的是图标节点而不是文字字符',
  pendingStatus.children.length === 1 && pendingStatus.children[0].className === 'ui-icon' && pendingStatus.children[0].dataset.icon === 'ring',
  pendingStatus.children[0] && `${pendingStatus.children[0].className}/${pendingStatus.children[0].dataset.icon}`,
);

// 场景 2：点开第 2 颗胶囊 —— 另外两个必须被收起并锁住
elements.todoArchiveBar.children[1].click();
view = snapshot();
check('点开胶囊：归档清单展开', view.archivePanel, JSON.stringify(view));
check('点开胶囊：任务树被收起', view.taskTree === false, JSON.stringify(view));
check('点开胶囊：当前任务清单被收起', view.todoPanel === false, JSON.stringify(view));
check('点开胶囊：只有一个胶囊是 active', view.active.length === 1 && view.active[0] === 'b', JSON.stringify(view.active));
check('点开胶囊：任务树与任务清单被锁定', view.locked, JSON.stringify(view));

// 场景 3：聚焦期间点任务树/任务清单标题栏 —— 不能展开
elements.taskTree.summary.click();
elements.todoPanel.summary.click();
view = snapshot();
check('锁住时点任务树：不展开', view.taskTree === false, JSON.stringify(view));
check('锁住时点任务清单：不展开', view.todoPanel === false, JSON.stringify(view));
check('锁住时点击给了提示，而不是静默无反应', toasts.length === 2, `toast ${toasts.length} 次`);

// 场景 4：聚焦期间来了一份新清单 —— 也不能把清单顶开
state.todos = todos(4);
ui.renderTodos();
view = snapshot();
check('聚焦期间新清单到达：清单仍保持收起', view.todoPanel === false, JSON.stringify(view));

// 场景 5：点同一颗胶囊 —— 收起并解锁，并还原进入前的状态
elements.todoArchiveBar.children[1].click();
view = snapshot();
check('再点同一颗：归档清单收起', view.archivePanel === false, JSON.stringify(view));
check('再点同一颗：没有胶囊是 active', view.active.length === 0, JSON.stringify(view.active));
check('再点同一颗：解锁', view.locked === false, JSON.stringify(view));
check('再点同一颗：任务树恢复展开（进入前的状态）', view.taskTree === true, JSON.stringify(view));
check('再点同一颗：任务清单恢复展开', view.todoPanel === true, JSON.stringify(view));

// 场景 6：点另一颗胶囊 —— 直接换过去，仍然只有一个面板展开
elements.todoArchiveBar.children[0].click();
elements.todoArchiveBar.children[2].click();
view = snapshot();
check('连点两颗不同胶囊：仍然只有一个胶囊展开', view.active.length === 1 && view.active[0] === 'c', JSON.stringify(view.active));
check('连点两颗不同胶囊：只有归档面板展开', view.archivePanel && !view.taskTree && !view.todoPanel, JSON.stringify(view));

// 场景 7：点归档面板自己的标题栏 —— 收起并解锁（用户描述的另一条路径）
elements.todoArchivePanel.summary.click();
view = snapshot();
check('点归档面板标题栏：收起并解锁', view.archivePanel === false && view.locked === false, JSON.stringify(view));
check('点归档面板标题栏：任务树与任务清单恢复', view.taskTree && view.todoPanel, JSON.stringify(view));

// 场景 8：进入前都收着的情况 —— 退出后也不该把面板顶开
seed({ todos: todos(2), archives: [archive('a', 1)] });
elements.taskTree.open = false;
elements.todoPanel.open = false;
elements.todoArchiveBar.children[0].click();
elements.todoArchiveBar.children[0].click();
view = snapshot();
check('进入前都收着：退出后仍是收着', view.taskTree === false && view.todoPanel === false, JSON.stringify(view));

// 场景 9：归档被清空（切对话/删档）—— 必须解锁，不能把面板锁死
seed({ todos: todos(2), archives: [archive('a', 1)] });
elements.todoArchiveBar.children[0].click();
state.todoArchives = [];
ui.renderTodoArchives();
view = snapshot();
check('归档消失：自动退出聚焦并解锁', view.locked === false && view.archivePanel === false, JSON.stringify(view));

console.log(failures ? `\n${failures} 项不满足` : '\n全部通过：同一时刻只展开一个面板、收起后还原、锁住时点了不开');
process.exitCode = failures ? 1 : 0;
