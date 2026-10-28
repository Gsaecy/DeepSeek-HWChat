// 流式输出「只重画变化的那一条消息」的真实验证。
//
// 现场故障：助手输出时整块内容一闪一闪地跳动。根因是每个 delta（70ms 一次）都走
// renderMessages()，而它先把 messageList 清空再重建全部 N 条消息，于是每个 tick
// 都在做 O(N) 销毁 + 重建：光标 blink 动画反复从头开始、<details> 反复重造、
// 整个列表高度先塌到 0 再涨回去。现在改成只替换那一条 <article>。
//
// 验证方式：从 media/chat.js 原样抽出 patchMessage / scheduleMessagePatch /
// runPendingMessageRender / captureDetailOverrides / restoreDetailOverrides，
// 配一个最小假 DOM 跑真实逻辑，断言「别的消息节点对象没被换掉」这类只有跑起来
// 才看得出的性质。
//
// 运行：node test/check-stream-patch.mjs
import { readFileSync } from 'node:fs';

const CHAT_JS = readFileSync('media/chat.js', 'utf8');

/* ── 最小假 DOM ───────────────────────────────────────────────
   只实现被测代码真正用到的部分：children / append / replaceWith /
   replaceChildren / querySelector(All) / closest / dataset。
   用了没支持的选择器就直接抛错 —— 不让「假 DOM 悄悄返回空」掩盖真实行为。 */

class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = '';
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.open = false;
    this.hidden = false;
  }

  append(...nodes) {
    for (const node of nodes) { node.parentNode = this; this.children.push(node); }
    return this;
  }

  replaceChildren() {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.replaceChildrenCalls += 1;
  }

  replaceWith(next) {
    const siblings = this.parentNode?.children;
    if (!siblings) throw new Error('replaceWith: 节点没有父节点');
    const index = siblings.indexOf(this);
    if (index < 0) throw new Error('replaceWith: 自己不在父节点的 children 里');
    next.parentNode = this.parentNode;
    siblings[index] = next;
    this.parentNode = null;
  }

  closest(selector) {
    if (selector !== '[data-message-id]') throw new Error(`假 DOM 不支持 closest：${selector}`);
    let node = this;
    while (node) {
      if (node.dataset?.messageId) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => { for (const child of node.children) { found.push(child); walk(child); } };
    walk(this);
    if (selector === '.stream-cursor') return found.filter((node) => node.className === 'stream-cursor');
    if (selector === 'details[data-detail-key]') {
      return found.filter((node) => node.tagName === 'DETAILS' && node.dataset.detailKey);
    }
    throw new Error(`假 DOM 不支持的选择器：${selector}`);
  }
}

/* ── 抽取源码 ─────────────────────────────────────────────────── */

/** 数大括号取出一段函数源码（与 check-project-badge.mjs 同一套做法）。 */
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

const patchSource = extractBlock(CHAT_JS, '\n  function patchMessage(').replace(/^\n/, '');
const scheduleSource = extractBlock(CHAT_JS, '\n  function scheduleMessagePatch(').replace(/^\n/, '');
const runPendingSource = extractBlock(CHAT_JS, '\n  function runPendingMessageRender(').replace(/^\n/, '');
const captureSource = extractBlock(CHAT_JS, '\n  function captureDetailOverrides(').replace(/^\n/, '');
const restoreSource = extractBlock(CHAT_JS, '\n  function restoreDetailOverrides(').replace(/^\n/, '');

/* ── 装配被测代码 ─────────────────────────────────────────────── */

const messageList = new FakeNode('div');
messageList.replaceChildrenCalls = 0;
const messageViewport = new FakeNode('div');
messageViewport.scrollTop = 0;
messageViewport.scrollHeight = 1000;

const elements = { messageList, messageViewport };
const state = { messages: [], autoFollow: true, renderingMessages: false, renderTimer: null };

const calls = { renderMessages: 0, deferMessageRender: 0, updateScrollToBottom: 0, rendered: [] };

/** 记录 rAF 回调，由测试显式 flush —— 这样才能断言「替换发生在 rAF 之前/之后」。 */
let frameQueue = [];
/** 记录 setTimeout 回调，同上。 */
let timerQueue = [];

/** 稳定的 renderMessage 替身：只造出被测代码会碰的结构。 */
function renderMessage(message) {
  calls.rendered.push(message.id);
  const article = new FakeNode('article');
  article.dataset.messageId = message.id;
  const body = new FakeNode('div');
  article.append(body);
  if (message.hasDetails) {
    const details = new FakeNode('details');
    details.dataset.detailKey = 'reasoning';
    details.dataset.defaultOpen = '0';
    details.open = false;
    body.append(details);
  }
  if (message.status === 'streaming') {
    const cursor = new FakeNode('span');
    cursor.className = 'stream-cursor';
    body.append(cursor);
  }
  return article;
}

const ctx = {
  state,
  elements,
  renderMessage,
  renderMessages: () => { calls.renderMessages += 1; },
  deferMessageRender: () => { calls.deferMessageRender += 1; },
  updateScrollToBottom: () => { calls.updateScrollToBottom += 1; },
  hasSelection: () => false,
  requestAnimationFrame: (callback) => { frameQueue.push(callback); },
  setTimeout: (callback) => { timerQueue.push(callback); return timerQueue.length; },
};

const factory = new Function('ctx', `
  "use strict";
  // 指向 ctx 的薄包装：测试中途换掉 ctx.hasSelection 也能立刻生效。
  const renderMessages = (...args) => ctx.renderMessages(...args);
  const deferMessageRender = (...args) => ctx.deferMessageRender(...args);
  const updateScrollToBottom = (...args) => ctx.updateScrollToBottom(...args);
  const hasMessageSelection = (...args) => ctx.hasSelection(...args);
  const renderMessage = (...args) => ctx.renderMessage(...args);
  const requestAnimationFrame = (callback) => ctx.requestAnimationFrame(callback);
  const setTimeout = (callback, delay) => ctx.setTimeout(callback, delay);
  const state = ctx.state;
  const elements = ctx.elements;
  // 下面三个是 chat.js 模块级的 let，这里按同样形状重建。
  let selectingMessageText = false;
  let interactingWithMessages = false;
  let deferredMessageRenderMode = null;
  let pendingPatchId = null;
  ${captureSource}
  ${restoreSource}
  ${patchSource}
  ${scheduleSource}
  ${runPendingSource}
  return {
    patchMessage,
    scheduleMessagePatch,
    setSelection(value) { selectingMessageText = value; },
    setInteracting(value) { interactingWithMessages = value; },
    peekPendingPatchId() { return pendingPatchId; },
  };
`);

const ui = factory(ctx);

/* ── 断言 ─────────────────────────────────────────────────────── */

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`✓ ${label}`); return; }
  failures += 1;
  console.log(`✗ ${label} — ${detail}`);
}

function flushFrames() {
  const queue = frameQueue;
  frameQueue = [];
  for (const callback of queue) callback();
}

function flushTimers() {
  const queue = timerQueue;
  timerQueue = [];
  for (const callback of queue) callback();
}

/** 把「用户/扩展侧刚推了一条消息」的状态与 DOM 对齐（等价于一次整段重建）。 */
function seed(messages) {
  state.messages = messages.map((message) => ({ ...message }));
  messageList.replaceChildren();
  for (const message of state.messages) messageList.append(renderMessage(message));
  calls.rendered = [];
  // 基线：整段重建一次，计数留在这里，供后面的断言比对「这一 tick 有没有再清空」。
  seed.replaceChildrenBaseline = messageList.replaceChildrenCalls;
}

const baseMessages = () => [
  { id: 'm1', role: 'user', status: 'complete', content: '你好' },
  { id: 'm2', role: 'assistant', status: 'streaming', content: '', hasDetails: true },
];

/* 1. 一次流式 tick：只有那一条被换掉，别的消息节点对象原封不动。 */
seed(baseMessages());
const untouched = messageList.children[0];
const firstStreamingArticle = messageList.children[1];
const cursorBefore = firstStreamingArticle.querySelector('.stream-cursor');
const detailsBefore = firstStreamingArticle.querySelectorAll('details[data-detail-key]')[0];
// 用户把「思考过程」点开了 —— 重建后必须还是展开的。
detailsBefore.open = true;

state.messages[1].content += '第一段输出';
ui.scheduleMessagePatch('m2');
check('调度器：攒着等 70ms 才画，不立即动 DOM', messageList.children[1] === firstStreamingArticle, '还没到点就换了节点');
flushTimers();

check('流式 tick：只重画变化的那一条', calls.rendered.length === 1 && calls.rendered[0] === 'm2', `重画了 ${JSON.stringify(calls.rendered)}`);
check('流式 tick：别的消息节点对象没被换掉', messageList.children[0] === untouched, '未变的消息也被重建了');
check('流式 tick：走的不是整段重建', calls.renderMessages === 0 && messageList.replaceChildrenCalls === seed.replaceChildrenBaseline, `renderMessages=${calls.renderMessages}, replaceChildren 增量=${messageList.replaceChildrenCalls - seed.replaceChildrenBaseline}`);
check('流式 tick：变化的那条确实被替换', messageList.children[1] !== firstStreamingArticle, '节点没换，内容不会更新');
check('光标节点被复用（blink 动画不重启）', messageList.children[1].querySelector('.stream-cursor') === cursorBefore, '光标是新造的');

const detailsAfter = messageList.children[1].querySelectorAll('details[data-detail-key]')[0];
check('展开状态被保留（用户点开的思考过程不会自己收起）', detailsAfter.open === true, '展开状态丢了');
check('未展开的思考过程不会被强行打开', messageList.children[0].querySelectorAll('details[data-detail-key]').length === 0, '用户消息被塞了 details');

/* 2. 滚动：用户翻上去看历史时，位置一点不动。 */
flushFrames();
state.autoFollow = false;
messageViewport.scrollTop = 480;
state.messages[1].content += '又一段';
ui.scheduleMessagePatch('m2');
flushTimers();
flushFrames();
check('用户翻上去看历史：滚动位置不动', messageViewport.scrollTop === 480, `scrollTop=${messageViewport.scrollTop}`);

/* 3. 滚动：跟着底部时贴底。 */
state.autoFollow = true;
messageViewport.scrollTop = 10;
messageViewport.scrollHeight = 1200;
state.messages[1].content += '再一段';
ui.scheduleMessagePatch('m2');
flushTimers();
flushFrames();
check('跟着底部：滚动到最新内容', messageViewport.scrollTop === 1200, `scrollTop=${messageViewport.scrollTop}`);

/* 4. DOM 与 state 顺序对不上时必须退回整段重建，不能按索引换错那一条。 */
seed(baseMessages());
messageList.children[1].dataset.messageId = 'stale';
const beforeFallback = calls.renderMessages;
state.messages[1].content += '结构变了';
messageList.children[1].dataset.messageId = 'something-else';
ui.scheduleMessagePatch('m2');
flushTimers();
check('结构对不上：退回整段重建', calls.renderMessages === beforeFallback + 1, `renderMessages=${calls.renderMessages}`);

/* 5. 用户正在选字：这一轮不碰 DOM（否则选区会丢），改成推迟到交互结束。 */
seed(baseMessages());
const beforeSelection = calls.renderMessages;
const beforeDefer = calls.deferMessageRender;
ctx.hasSelection = () => true;
state.messages[1].content += '选字中';
ui.scheduleMessagePatch('m2');
flushTimers();
check('正在选字：不重画，推迟到交互结束', calls.renderMessages === beforeSelection && calls.deferMessageRender === beforeDefer + 1, `renderMessages=${calls.renderMessages}, defer=${calls.deferMessageRender}`);
ctx.hasSelection = () => false;

/* 6. 同一条消息的多个 delta 合成一次重画。 */
seed(baseMessages());
calls.rendered = [];
state.messages[1].content += 'a';
ui.scheduleMessagePatch('m2');
state.messages[1].content += 'b';
ui.scheduleMessagePatch('m2');
state.messages[1].content += 'c';
ui.scheduleMessagePatch('m2');
check('多个 delta 只排一次定时器', timerQueue.length === 1, `排了 ${timerQueue.length} 次`);
flushTimers();
check('多个 delta 只重画一次', calls.rendered.length === 1, `重画了 ${calls.rendered.length} 次`);

/* 7. 消息 id 不存在时不能静默当成功（否则调用方会跳过整段重建）。 */
seed(baseMessages());
const beforeUnknown = calls.renderMessages;
const ok = ui.patchMessage('不存在的消息');
flushTimers();
check('找不到消息：patchMessage 返回 false', ok === false, '返回了 true');
check('找不到消息：不留下半截状态', calls.renderMessages === beforeUnknown, '意外触发了整段重建');

/* 8. 重画量的量级差：长对话里这是「闪不闪」的直接来源。 */
const longConversation = Array.from({ length: 40 }, (_, index) => ({
  id: `m${index}`, role: index % 2 ? 'assistant' : 'user', status: 'complete', content: '正文',
}));
longConversation[39].status = 'streaming';
seed(longConversation);
calls.rendered = [];
const TICKS = 20;
for (let tick = 0; tick < TICKS; tick += 1) {
  state.messages[39].content += '一';
  ui.scheduleMessagePatch('m39');
  flushTimers();
  flushFrames();
}
check(
  `40 条消息跑 ${TICKS} 个 tick：只重画 ${TICKS} 次`,
  calls.rendered.length === TICKS,
  `重画了 ${calls.rendered.length} 次（整段重建会是 ${TICKS * longConversation.length} 次）`,
);
check('20 个 tick 里除了最后一条，别的从没被重画', calls.rendered.every((id) => id === 'm39'), `混进了 ${JSON.stringify([...new Set(calls.rendered)])}`);

/* ── 源码级断言：接线与「不许再退回整段重建」 ─────────────────── */

const deltaCases = (CHAT_JS.match(/case 'streamDelta'[\s\S]*?break; \}/g) || []).join('\n')
  + (CHAT_JS.match(/case 'toolExecutions'[\s\S]*?break; \}/g) || []).join('\n')
  + (CHAT_JS.match(/case 'skillUsage'[\s\S]*?break; \}/g) || []).join('\n');
check('接线：三种流式消息都走 scheduleMessagePatch', (deltaCases.match(/scheduleMessagePatch\(message\.messageId\)/g) || []).length === 3, '有的分支还在走整段重建');
check('接线：整段重建的调度函数已彻底移除', !/scheduleMessageRender/.test(CHAT_JS), '还留着旧的 scheduleMessageRender');
check('接线：整段重建会清掉待办的局部更新', /pendingPatchId = null;\n\s+const viewport = elements\.messageViewport;/.test(CHAT_JS), 'renderMessages 没有清 pendingPatchId');
check('接线：messageComplete 先清待办再整段重建', /pendingPatchId = null; const index = state\.messages\.findIndex/.test(CHAT_JS), 'messageComplete 没清待办');
check('接线：局部替换用 replaceWith，不是 replaceChildren', /current\.replaceWith\(next\)/.test(patchSource), '没找到就地替换');
check('接线：局部替换不做整段清空', !/replaceChildren\(\)/.test(patchSource), 'patchMessage 里出现了 replaceChildren');
check('接线：<details> 快照支持局部作用域', /function captureDetailOverrides\(root = elements\.messageList\)/.test(CHAT_JS) && /function restoreDetailOverrides\(overrides, root = elements\.messageList\)/.test(CHAT_JS), '两个快照函数还没接受 root');

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
