// 输入框草稿隔离的真实验证。
//
// 回归的 bug：在 A 对话里敲了半句没发，切到 B，那半句原样躺在 B 的输入框里，
// 顺手一回车就发到了错的对话。
//
// 这里不是另写一份逻辑来测逻辑——那样改坏了 chat.js 脚本照样全绿。
// 做法是从 media/chat.js 里原样抽出 `case 'state': { ... }` 整个代码块，
// 连同 draftKey / saveDraft / restoreDraft 三个真函数，配最小 state + 输入框跑一遍，
// 所以跑的就是 webview 里真正执行的那段代码。
//
// 运行：node test/check-draft-isolation.mjs
import { readFileSync } from 'node:fs';

const CHAT_JS_PATH = process.env.HWCHAT_CHAT_JS || 'media/chat.js';
const CHAT_JS = readFileSync(CHAT_JS_PATH, 'utf8');

/* ── 抽取 chat.js 里的真实函数源码 ─────────────────────────── */

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

const draftKeySource = extractBlock(CHAT_JS, '\n  function draftKey(');
const saveDraftSource = extractBlock(CHAT_JS, '\n  function saveDraft(');
const restoreDraftSource = extractBlock(CHAT_JS, '\n  function restoreDraft(');
const submitSource = extractBlock(CHAT_JS, '\n  function submit(');
// `case 'state'` 里会调用步数归一函数（0 不再表示「不限制」），必须一起抽出来，
// 否则这段真代码在桩环境里会以 ReferenceError 直接崩掉。
const normalizeStepValueSource = extractBlock(CHAT_JS, '\n  function normalizeStepValue(');

// `case 'state': { ... }` 去掉前缀 `case 'state': ` 就是一段合法块语句；
// 收尾的 `break;` 在函数体里非法，必须去掉（已核对：块内只有这一处 break）。
const stateCaseBlock = extractBlock(CHAT_JS, "case 'state': {")
  .replace(/^case 'state':\s*/, '')
  .replace(/\bbreak;/g, '');

/* ── 断言 ────────────────────────────────────────────────────── */

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`✓ ${label}`); return; }
  failures += 1;
  console.log(`✗ ${label} — ${detail}`);
}

/* ── 用真实代码块搭一个可反复触发的"收到 state 消息"动作 ──────── */

const elements = { promptInput: { value: '', style: {}, disabled: false }, modelInput: { value: '' } };
const setStreaming = () => {};
const renderAll = () => {};
const finishTitleEdit = () => {};

function makeStateMessage(conversationId, extra = {}) {
  return {
    type: 'state',
    state: {
      conversations: [],
      archivedConversations: [],
      conversation: conversationId ? { id: conversationId, title: conversationId } : null,
      messages: [],
      hasMore: false,
      settings: {},
      modelOptionsByProfile: {},
      skills: [],
      selectedSkillIds: [],
      mode: 'agent',
      project: { name: null, bound: false },
      todoArchives: [],
      todos: [],
      runningConversationIds: [],
      pendingApprovals: [],
      ...extra,
    },
  };
}

// 每次调用都新建一个 state，避免测试之间互相污染；但元素是共享的（就像真实面板）。
function receiveState(state, message) {
  const run = new Function(
    'state', 'elements', 'message', 'setStreaming', 'renderAll', 'finishTitleEdit',
    `${draftKeySource}\n${saveDraftSource}\n${restoreDraftSource}\n${normalizeStepValueSource}\nconst autoResize = () => {};\n${stateCaseBlock}`,
  );
  run(state, elements, message, setStreaming, renderAll, finishTitleEdit);
}

function freshState(conversationId) {
  return { conversation: conversationId ? { id: conversationId, title: conversationId } : null, drafts: {} };
}

/* 1. 核心回归：A 里没发出去的半句话，不能跟到 B 的输入框里。 */
{
  const state = freshState('A');
  elements.promptInput.value = '这是 A 里还没发出去的话';

  receiveState(state, makeStateMessage('B'));
  check('切到 B：输入框被清空，A 的草稿没有跟过来', elements.promptInput.value === '', `实际是「${elements.promptInput.value}」`);
  check('切到 B：A 的草稿被存进了 A 的草稿槽', state.drafts.A === '这是 A 里还没发出去的话', JSON.stringify(state.drafts));
  check('切到 B：B 自己没有草稿', state.drafts.B === undefined, JSON.stringify(state.drafts));

  /* 2. 切回 A：草稿应该还在，而不是被"清空"成永久丢失。 */
  receiveState(state, makeStateMessage('A'));
  check('切回 A：草稿恢复', elements.promptInput.value === '这是 A 里还没发出去的话', `实际是「${elements.promptInput.value}」`);
}

/* 3. 同一个对话的普通 state 刷新不能动输入框——否则每敲一个字被推送一次就清空了。 */
{
  const state = freshState('A');
  elements.promptInput.value = '正在输入中';
  receiveState(state, makeStateMessage('A'));
  check('同一对话刷新 state：输入框内容保持不变', elements.promptInput.value === '正在输入中', `实际是「${elements.promptInput.value}」`);
  check('同一对话刷新 state：不会把内容存成草稿', state.drafts.A === undefined, JSON.stringify(state.drafts));
}

/* 4. 新建对话：A 的草稿留在 A，新对话的输入框是空的。 */
{
  const state = freshState('A');
  elements.promptInput.value = 'A 的草稿';
  receiveState(state, makeStateMessage(null));
  check('新建对话：输入框为空', elements.promptInput.value === '', `实际是「${elements.promptInput.value}」`);
  check('新建对话：A 的草稿仍保留', state.drafts.A === 'A 的草稿', JSON.stringify(state.drafts));

  /* 5. 新建对话里也敲半句，再去别的对话、再回来，应该恢复到新建对话自己的草稿。 */
  elements.promptInput.value = '新对话里的草稿';
  receiveState(state, makeStateMessage('B'));
  check('离开新对话：新对话的草稿存进 draft 槽', state.drafts.draft === '新对话里的草稿', JSON.stringify(state.drafts));
  receiveState(state, makeStateMessage(null));
  check('回到新建对话：恢复它自己的草稿', elements.promptInput.value === '新对话里的草稿', `实际是「${elements.promptInput.value}」`);
}

/* 6. saveDraft 的语义：输入框清空后调用，应当把草稿槽删掉而不是留空串。 */
{
  const state = freshState('A');
  // 直接借 draftKey/saveDraft 跑一次（同样是 chat.js 里的真函数）。
  const runSave = new Function('state', 'elements', `${draftKeySource}\n${saveDraftSource}\nreturn { saveDraft };`);
  const { saveDraft } = runSave(state, elements);

  elements.promptInput.value = '有内容';
  saveDraft('A');
  check('发送前：草稿写入', state.drafts.A === '有内容', JSON.stringify(state.drafts));

  elements.promptInput.value = '';
  saveDraft('A');
  check('发送后（输入框已清空）：草稿槽被删除，不会残留空串', state.drafts.A === undefined, JSON.stringify(state.drafts));
}

/* ── 静态核对：接线没有漏 ────────────────────────────────────── */

check('state 对象里有 drafts 槽', /drafts:\s*\{\s*\}/.test(CHAT_JS), 'chat.js 的 state 里找不到 drafts: {}');
check('submit 清空输入框后同步清掉草稿', /elements\.promptInput\.value = '';\s*saveDraft\(/.test(submitSource), 'submit() 里没有 saveDraft');
check('state 分支在切换时恢复了草稿', /restoreDraft\(incoming\.conversation\?\.id\)/.test(stateCaseBlock), "case 'state' 里没有 restoreDraft");
check('state 分支在切换时保存了旧草稿', /saveDraft\(previousConversationId\)/.test(stateCaseBlock), "case 'state' 里没有 saveDraft(previousConversationId)");
check("'draft' 消息也写进草稿槽", /case 'draft': [^\n]*saveDraft\(/.test(CHAT_JS), "'draft' 分支没有 saveDraft");

/* ── 结果 ────────────────────────────────────────────────────── */

console.log('');
if (failures) {
  console.log(`✗ ${failures} 项断言失败`);
  process.exit(1);
}
console.log('全部通过：草稿按对话隔离，切换不再串内容');
