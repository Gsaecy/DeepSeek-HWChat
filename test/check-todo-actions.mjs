// 顶栏「继续执行 / 取消任务」的真实验证。
//
// 从 media/chat.js 里原样抽出 syncTodoSummaryActions 与 bindSummaryAction，配最小 DOM 跑一遍；
// 再静态核对模板、CSS 与 i18n 文案宽度。
//
// 为什么要管宽度：状态区定宽是为了「清单标题不被状态文字顶着跑」。
// 只要有人把某条状态文案改长一点，定宽就会把它挤成省略号——而这个错误在截图上极难发现，
// 所以这里直接量：把中英文最长的一条按 9px 字号算出来，必须放得下。
//
// 运行：node test/check-todo-actions.mjs
import { readFileSync } from 'node:fs';

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_CSS = readFileSync('media/chat.css', 'utf8');
const PANEL_TS = readFileSync('src/views/chatPanel.ts', 'utf8');
const I18N_TS = readFileSync('src/core/i18n.ts', 'utf8');

/* ── 最小 DOM ────────────────────────────────────────────────── */

class StubNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  /** 触发一次点击，返回 event 上被调用过的方法，用于检查 preventDefault/stopPropagation。 */
  click() {
    const event = {
      prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    for (const handler of this.listeners.get('click') || []) handler(event);
    return event;
  }
}

const elements = {
  todoSummaryActions: new StubNode('span'),
  resumeTodosButton: new StubNode('button'),
  cancelTodosButton: new StubNode('button'),
};

const posted = [];
const post = (type, payload = {}) => { posted.push({ type, ...payload }); };
const t = (key) => key;

/* ── 抽取 chat.js 里的函数源码 ───────────────────────────────── */

function extractBlock(sourceText, needle) {
  let start = sourceText.indexOf(needle);
  if (start < 0) throw new Error(`chat.js 里找不到代码块：${needle}`);
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

const syncSource = extractBlock(CHAT_JS, '\n  function syncTodoSummaryActions(');
// bindSummaryAction 是箭头函数（`const bindSummaryAction = (id, type) => {`），单独抽取。
const bindSource = extractBlock(CHAT_JS, '\n  const bindSummaryAction = ');
const bindCalls = (CHAT_JS.match(/bindSummaryAction\((?:'|")[^)]*(?:'|")\)/g) || [])
  .filter((call) => call.startsWith('bindSummaryAction('));

if (bindCalls.length !== 2) throw new Error(`期望 2 处 bindSummaryAction 调用，实际 ${bindCalls.length}`);

const factory = new Function(
  'elements', 'post',
  `${syncSource}\n${bindSource}\n${bindCalls.join('\n')}
   return { syncTodoSummaryActions };`,
);
const ui = factory(elements, post);

/* ── 断言 ────────────────────────────────────────────────────── */

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`✓ ${label}`); return; }
  failures += 1;
  console.log(`✗ ${label} — ${detail}`);
}

/* 1. 显隐：只在可继续时出现，且整块一起显隐。 */
elements.todoSummaryActions.hidden = true;
elements.resumeTodosButton.hidden = true;
elements.cancelTodosButton.hidden = true;

ui.syncTodoSummaryActions(true);
check('可继续：动作区显示', elements.todoSummaryActions.hidden === false, '动作区仍隐藏');
check('可继续：继续执行按钮显示', elements.resumeTodosButton.hidden === false, '按钮仍隐藏');
check('可继续：取消任务按钮显示', elements.cancelTodosButton.hidden === false, '按钮仍隐藏');

ui.syncTodoSummaryActions(false);
check('不可继续：动作区整块隐藏', elements.todoSummaryActions.hidden === true, '动作区仍显示');
check('不可继续：继续执行按钮隐藏', elements.resumeTodosButton.hidden === true, '按钮仍显示');
check('不可继续：取消任务按钮隐藏', elements.cancelTodosButton.hidden === true, '按钮仍显示');

/* 2. 点击：发对应消息，且不触发 <summary> 折叠。 */
posted.length = 0;
const resumeEvent = elements.resumeTodosButton.click();
check('点继续执行：发出 resumeTodos', posted.length === 1 && posted[0].type === 'resumeTodos', JSON.stringify(posted));
check('点继续执行：阻止默认行为（不折叠面板）', resumeEvent.prevented === true, '未调用 preventDefault');
check('点继续执行：阻止冒泡到 summary', resumeEvent.stopped === true, '未调用 stopPropagation');

posted.length = 0;
const cancelEvent = elements.cancelTodosButton.click();
check('点取消任务：发出 cancelTodos', posted.length === 1 && posted[0].type === 'cancelTodos', JSON.stringify(posted));
check('点取消任务：阻止默认行为（不折叠面板）', cancelEvent.prevented === true, '未调用 preventDefault');
check('点取消任务：阻止冒泡到 summary', cancelEvent.stopped === true, '未调用 stopPropagation');

/* 3. 模板结构：两个按钮在任务清单的 <summary> 里，任务树的 <summary> 里没有动作。 */
const todoPanelLine = PANEL_TS.split('\n').find((line) => line.includes('id="todoSummaryActions"')) || '';
check('模板：两个按钮都在任务清单 summary 内', todoPanelLine.includes('<summary>') && todoPanelLine.includes('resumeTodosButton') && todoPanelLine.includes('cancelTodosButton'), '按钮不在 summary 内或缺失');
check('模板：按钮是 type="button"（不触发提交）', (todoPanelLine.match(/type="button"/g) || []).length === 2, '缺 type="button"');

const taskTreeLine = PANEL_TS.split('\n').find((line) => line.includes('id="taskTreeSummary"')) || '';
check('模板：任务树顶栏没有这两个按钮', !taskTreeLine.includes('resumeTodosButton') && !taskTreeLine.includes('cancelTodosButton'), '任务树里混入了动作按钮');
check('模板：任务树顶栏只有标题 + 状态', taskTreeLine.includes('panel-summary-title') && taskTreeLine.includes('taskTreeSummary'), '任务树顶栏结构异常');

/* 4. 后端：两个消息都被接住；取消走「清空不归档」。 */
check('后端：resumeTodos 消息已接', /case 'resumeTodos':/.test(PANEL_TS), '缺少 case');
check('后端：cancelTodos 消息已接', /case 'cancelTodos':/.test(PANEL_TS), '缺少 case');
check('后端：取消用 clearedTodoState（清空不归档）', /clearedTodoState\(\)/.test(PANEL_TS), '没有用 clearedTodoState');
check('后端：取消落库前先等运行退出', /waitForRunToLeave\(/.test(PANEL_TS), '缺少 waitForRunToLeave');
check('后端：继续执行复用 send()（不另开执行通道）', /todo\.resumeInstruction/.test(PANEL_TS), '没有复用 send()');
check('后端：继续执行前先撤掉中断标记', /todosInterrupted: null, todosIncomplete: null/.test(PANEL_TS), '没有清中断标记');
// 撤掉标记之后如果这一轮压根没跑起来（权限同意被拒 / 发送被挡住），结算不会发生，
// 标记也不会有人补回来——按钮就此永久消失。这条断言守住那个兜底。
check(
  '后端：没跑起来时恢复「可继续」（不会永久失去按钮）',
  /todosInterrupted: true, todosIncomplete: null,?\s*\}\);/.test(PANEL_TS) && /const unfinished = /.test(PANEL_TS),
  '缺少「这一轮没跑起来就恢复中断标记」的兜底',
);

/* 5. CSS：状态区定宽不收缩、动作区贴最右、标题左对齐。 */
function cssRule(selector) {
  const match = CHAT_CSS.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return match ? match[2] : '';
}
const stateRule = cssRule('.panel-summary-state');
const actionsRule = cssRule('.panel-summary-actions');
const titleRule = cssRule('.panel-summary-title');
check('CSS：状态区 flex 是 0 0（不涨不缩）', /flex:\s*0\s+0\s+132px/.test(stateRule), stateRule.trim());
check('CSS：状态区宽度 132px', /width:\s*132px/.test(stateRule), stateRule.trim());
check('CSS：状态区文字左对齐', /text-align:\s*left/.test(stateRule), stateRule.trim());
check('CSS：动作区贴最右（margin-left: auto）', /margin-left:\s*auto/.test(actionsRule), actionsRule.trim());
check('CSS：动作区内左对齐', /justify-content:\s*flex-start/.test(actionsRule), actionsRule.trim());
check('CSS：标题左对齐', /text-align:\s*left/.test(titleRule), titleRule.trim());

/* 6. 宽度实算：中英文最长一条状态文案必须放得下 132px。 */
const em = 9; // .todo-panel > summary small 的 font-size
function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (code === 32) return em * 0.28;
  if (ch === '·') return em * 0.34;
  if (ch === '/' || ch === ':') return em * 0.3;
  if (ch === ',' || ch === '.') return em * 0.28;
  if (ch === '，' || ch === '、') return em;
  if (code < 128) return em * 0.56;
  return em;
}
const textWidth = (value) => [...value].reduce((sum, ch) => sum + charWidth(ch), 0);

function i18nValue(key, lang) {
  const pattern = new RegExp(`'${key.replace(/[.]/g, '\\.')}':\\s*\\{\\s*zh:\\s*'([^']*)',\\s*en:\\s*'([^']*)'`);
  const match = I18N_TS.match(pattern);
  if (!match) throw new Error(`i18n 里找不到 ${key}`);
  return lang === 'zh' ? match[1] : match[2];
}

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
const candidates = [
  `${fill(i18nValue('todo.progress', 'zh'), { done: 0, total: 6 })} · ${i18nValue('todo.interrupted', 'zh')}`,
  `${fill(i18nValue('todo.progress', 'zh'), { done: 0, total: 6 })} · ${i18nValue('todo.incomplete', 'zh')}`,
  `${fill(i18nValue('todo.progress', 'en'), { done: 0, total: 6 })} · ${i18nValue('todo.interrupted', 'en')}`,
  `${fill(i18nValue('todo.progress', 'en'), { done: 0, total: 6 })} · ${i18nValue('todo.incomplete', 'en')}`,
  fill(i18nValue('chat.nodeCountWithQueue', 'zh'), { count: 12, queued: 3 }),
  fill(i18nValue('chat.nodeCountWithQueue', 'en'), { count: 12, queued: 3 }),
  fill(i18nValue('todo.archive.summary', 'zh'), { time: '12:34', done: 6, total: 6 }),
  fill(i18nValue('todo.archive.summary', 'en'), { time: '12:34', done: 6, total: 6 }),
];
const widest = candidates
  .map((text) => ({ text, width: Math.ceil(textWidth(text)) }))
  .sort((a, b) => b.width - a.width)[0];
check(
  `宽度：最长状态文案放得下（${widest.width}px ≤ 132px）`,
  widest.width <= 132,
  `「${widest.text}」需要 ${widest.width}px，超过 132px 会被截断`,
);
check('宽度：中英文都覆盖到', candidates.length === 8, `只有 ${candidates.length} 条样本`);

/* ── 结果 ────────────────────────────────────────────────────── */

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
