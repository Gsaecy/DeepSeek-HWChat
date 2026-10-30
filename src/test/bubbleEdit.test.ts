import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * 排队消息在**消息气泡**里编辑。
 *
 * 现场需求：任务树一行只显示一条标题，长内容根本看不清；要改的是「已经发出、
 * 但 agent 还没执行」的那条消息，应该去气泡里改（气泡有整条消息的宽度），
 * 保存后任务树那一行同步更新。
 *
 * 这里钉住三件事：
 *  1. 编辑入口只出现在「排队中（pending）的用户消息」上；
 *  2. 任务树对排队节点只保留「删除」，不再给单行编辑框；
 *  3. 保存走 `editTaskMessage`，由后端改队列 + 存档并回推任务树。
 */

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_CSS = readFileSync('media/chat.css', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

/** 把 chat.js 里真实的函数原样取出来跑（不复制一份逻辑）。 */
function extractFunction(name: string): string {
  const start = CHAT_JS.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `media/chat.js 里找不到 ${name}`);
  // 先跳过参数表：默认值里也可能有 `{}`（例如 `options = {}`），不能拿它当函数体。
  let index = CHAT_JS.indexOf('(', start);
  let parens = 0;
  for (; index < CHAT_JS.length; index += 1) {
    if (CHAT_JS[index] === '(') parens += 1;
    else if (CHAT_JS[index] === ')') { parens -= 1; if (parens === 0) break; }
  }
  let depth = 0;
  const from = CHAT_JS.indexOf('{', index);
  index = from;
  for (; index < CHAT_JS.length; index += 1) {
    if (CHAT_JS[index] === '{') depth += 1;
    else if (CHAT_JS[index] === '}') { depth -= 1; if (depth === 0) break; }
  }
  assert.ok(index > from, `${name} 的花括号没闭合`);
  return CHAT_JS.slice(start, index + 1);
}

function loadHelpers(): {
  taskNodeForMessage: (nodes: unknown[], messageId: string) => { id?: string } | null;
  pendingTaskForBubble: (nodes: unknown[], messageId: string) => { id?: string } | null;
  pendingBubbleMessageIds: (nodes: unknown[]) => string[];
} {
  const code = [extractFunction('taskNodeForMessage'), extractFunction('pendingTaskForBubble'), extractFunction('pendingBubbleMessageIds')].join('\n');
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${code}\nglobalThis.__api = { taskNodeForMessage, pendingTaskForBubble, pendingBubbleMessageIds };`,
    sandbox,
  );
  return sandbox.__api as never;
}

interface StubNode {
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  type: string;
  children: StubNode[];
  listeners: Record<string, ((event: unknown) => void)[]>;
  append(...nodes: StubNode[]): void;
  addEventListener(type: string, handler: (event: unknown) => void): void;
}

/** 跑真实的 taskNodeActions，看它给不同状态造出哪些按钮。 */
function loadTaskNodeActions(): (node: Record<string, unknown>) => StubNode | null {
  const make = (tagName: string): StubNode => ({
    tagName,
    className: '',
    textContent: '',
    title: '',
    type: '',
    children: [],
    listeners: {},
    append(...nodes: StubNode[]) { this.children.push(...nodes); },
    addEventListener(type: string, handler: (event: unknown) => void) { (this.listeners[type] ||= []).push(handler); },
  });
  const sandbox: Record<string, unknown> = {
    document: { createElement: (tag: string) => make(tag) },
    textElement: (tag: string, className: string, text: string) => {
      const node = make(tag);
      node.className = className;
      node.textContent = text;
      return node;
    },
    t: (key: string) => key,
    post: () => undefined,
    beginResendEdit: () => undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction('taskNodeActions')}\nglobalThis.__actions = taskNodeActions;`, sandbox);
  return sandbox.__actions as never;
}

const node = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'task-1',
  title: '改一下登录页',
  status: 'queued',
  relation: 'queued',
  userMessageId: 'msg-1',
  pending: true,
  ...overrides,
});

test('气泡编辑：排队中的消息能按 userMessageId 找回它的任务节点', () => {
  const { pendingTaskForBubble } = loadHelpers();
  const found = pendingTaskForBubble([node()], 'msg-1');
  assert.equal(found?.id, 'task-1');
});

test('气泡编辑：已经执行过的消息不再算「可原地改」', () => {
  const { taskNodeForMessage, pendingTaskForBubble } = loadHelpers();
  const executed = [node({ pending: false, status: 'complete' })];
  assert.equal(pendingTaskForBubble(executed, 'msg-1'), null, '执行过就不能再顺手改历史');
  assert.equal(taskNodeForMessage(executed, 'msg-1')?.id, 'task-1', '节点本身还在，保存时仍能定位');
});

test('气泡编辑：不是这条消息的节点不会被误认', () => {
  const { pendingTaskForBubble } = loadHelpers();
  const other = [node({ id: 'task-9', userMessageId: 'msg-9' })];
  assert.equal(pendingTaskForBubble(other, 'msg-1'), null);
  assert.equal(pendingTaskForBubble([], 'msg-1'), null);
  assert.equal(pendingTaskForBubble(null as never, 'msg-1'), null);
  assert.equal(pendingTaskForBubble([node({ userMessageId: undefined })], undefined as never), null);
});

test('气泡编辑：排队集合只收 pending 且有消息 id 的节点，顺序稳定', () => {
  const { pendingBubbleMessageIds } = loadHelpers();
  const nodes = [
    node({ id: 'b', userMessageId: 'msg-b' }),
    node({ id: 'a', userMessageId: 'msg-a' }),
    node({ id: 'c', userMessageId: 'msg-c', pending: false }),
    node({ id: 'd', userMessageId: undefined }),
  ];
  assert.deepEqual([...pendingBubbleMessageIds(nodes)], ['msg-a', 'msg-b'], '排序后比较，避免每次重画');
  assert.deepEqual([...pendingBubbleMessageIds(null as never)], []);
});

test('任务树：排队节点只给删除，不再出现单行编辑', () => {
  const actions = loadTaskNodeActions()(node());
  assert.ok(actions, '排队节点应该有操作');
  const labels = actions.children.map((child) => child.textContent);
  assert.deepEqual(labels, ['taskQueue.remove'], '编辑入口已经移到消息气泡，任务树这里只留删除');
  assert.equal(actions.children[0]?.title, 'taskQueue.removeHint');
});

test('任务树：执行中的节点不给任何编辑入口（这就是「为什么执行中还能编辑」的修复）', () => {
  // 现场：任务树里一个标着「执行中」的节点还能点开编辑框，保存后实际是把内容当新消息
  // 再发一遍 —— 同一件事被排队做第二次。agent 已经把 request 读走，改它没有任何意义。
  for (const status of ['active', 'routing', 'merged', 'cancelled', 'error']) {
    assert.equal(
      loadTaskNodeActions()(node({ pending: false, status })),
      null,
      `${status} 状态不该出现行内操作`,
    );
  }
});

test('任务树：已完成的节点仍是「编辑后重发」，但编辑框开在气泡里', () => {
  const actions = loadTaskNodeActions()(node({ pending: false, status: 'complete' }));
  assert.deepEqual(actions?.children.map((child) => child.textContent), ['taskQueue.edit']);
  assert.equal(actions?.children[0]?.title, 'taskQueue.editExecutedHint', '这里说的是「重发」，不是原地改');
  assert.match(CHAT_JS, /edit\.addEventListener\('click', \(event\) => \{ event\.stopPropagation\(\); beginResendEdit\(node\); \}\)/, '点它要打开气泡编辑');
});

test('任务树：没有消息 id 的节点不给任何操作（无从定位那条消息）', () => {
  assert.equal(loadTaskNodeActions()(node({ userMessageId: undefined })), null);
});

test('任务树里不再有行内编辑框（只有一行，看不全长内容）', () => {
  for (const gone of ['editingTaskId', 'editingTaskDraft', 'taskEditBox', 'beginTaskEdit', 'commitTaskEdit', 'cancelTaskEdit', 'task-node-edit']) {
    assert.equal(CHAT_JS.includes(gone), false, `chat.js 里还有 ${gone}`);
    assert.equal(CHAT_CSS.includes(gone), false, `chat.css 里还有 ${gone}`);
  }
});

test('气泡：执行状态徽标挂在每条用户消息上，编辑按钮只在「还没执行」时出现', () => {
  assert.match(CHAT_JS, /if \(message\.role === 'user'\) \{\s*const execution = renderExecutionRow\(message\);/, '每条用户消息都要画状态徽标');
  assert.match(CHAT_JS, /const node = status === 'pending' \? pendingTaskForBubble\(state\.taskTree\?\.nodes, message\.id\) : null;/, '只有 pending 才找队列节点');
  assert.match(CHAT_JS, /if \(node\) \{/, '没节点（运行已结束）就不给编辑按钮');
});

test('浮层：保存发的是 editTaskMessage（后端负责改队列 + 存档 + 回推任务树）', () => {
  assert.match(CHAT_JS, /post\('editTaskMessage', \{ nodeId, text \}\)/);
  const save = extractFunction('saveMessageEditor');
  assert.match(save, /editingBubbleTaskId/, '节点 id 在打开浮层时就记下，任务树变化后仍能保存');
  assert.match(save, /closeMessageEditor\(\)/, '先关浮层再等后端回推');
  assert.doesNotMatch(save, /storage|fetch|invoke/, '界面层不自己改存档');
  // 打开浮层要先挂闸门，agent 才会停下来等
  const open = extractFunction('openMessageEditor');
  assert.match(open, /post\('beginEditTaskMessage'/, '打开编辑框要通知后端挂闸门');
  assert.match(extractFunction('closeMessageEditor'), /post\('cancelEditTaskMessage'/, '取消要放行闸门');
});

test('浮层：编辑框在消息列表之外，重绘碰不到它', () => {
  // 关键结构：浮层是独立 DOM（#messageEditor），不在 #messageList 里，
  // 所以流式重排消息列表时它不会跟着被销毁重建。
  const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
  const listStart = PANEL.indexOf('id="messageList"');
  const editorAt = PANEL.indexOf('id="messageEditor"');
  assert.ok(listStart > 0 && editorAt > 0, '两处结构都要在模板里');
  assert.ok(editorAt > listStart, '浮层必须排在消息列表之后（独立层级）');
  assert.match(PANEL, /id="messageEditor"[^>]*class="message-editor"/);
  // 渲染消息列表的函数不允许碰浮层。
  // 只看代码（注释里提到 `#messageEditor` 是解释，不算「动了浮层」）。
  assert.equal(/elements\.messageEditor/.test(extractFunction('renderMessages')), false, '重绘不能动浮层');
  assert.equal(/elements\.messageEditor/.test(extractFunction('renderMessage')), false, '单条重绘也不能动浮层');
  // 停止渲染的守卫已不再需要：浮层在列表之外。
  assert.equal(/editingBubbleMessageId && !options\.force/.test(CHAT_JS), false, '旧的「编辑中暂停重绘」守卫应已移除');
});

test('气泡：排队状态变化时只重画受影响的那几条', () => {
  assert.match(CHAT_JS, /const wasPending = pendingBubbleMessageIds\(state\.taskTree\?\.nodes\);/);
  assert.match(CHAT_JS, /if \(wasPending\.join\(','\) !== nowPending\.join\(','\)\)/);
  assert.match(CHAT_JS, /if \(id !== editingBubbleMessageId\) patchMessage\(id\);/);
});

test('气泡：切对话、删消息都会收起编辑框（避免把草稿存错地方）', () => {
  assert.match(CHAT_JS, /if \(editingBubbleMessageId && previousConversationId !== message\.state\?\.conversation\?\.id\)/);
  assert.match(CHAT_JS, /if \(editingBubbleMessageId && gone\.has\(editingBubbleMessageId\)\)/);
});

test('气泡：编辑框样式存在，且高度受控（再长也不会把对话顶出视野）', () => {
  for (const selector of ['.message-execution', '.message-execution-badge', '.message-execution-edit', '.message-editor', '.message-editor-panel', '.message-editor-input', '.message-editor-foot']) {
    assert.ok(CHAT_CSS.includes(selector), `chat.css 缺少 ${selector}`);
  }
  assert.match(CHAT_CSS, /max-height:\s*420px/, '编辑框要封顶，超出后自己滚');
  assert.match(extractFunction('growMessageEditor'), /MESSAGE_EDIT_MAX_HEIGHT/);
});

test('文案：中英文都补齐（编辑入口、未执行标记、快捷键提示）', () => {
  for (const key of ['chat.execution.pending', 'chat.execution.running', 'chat.execution.done', 'chat.execution.skipped', 'chat.editMessage', 'chat.editMessageHint', 'chat.editMessageKeys', 'chat.editResend', 'chat.editResendHint', 'taskQueue.editInBubble']) {
    const from = I18N.indexOf(`'${key}':`);
    assert.ok(from >= 0, `i18n 缺少 ${key}`);
    // 值可能跨行（长文案排成 zh / en 两行），取到下一个键之前为止。
    const rest = I18N.slice(from + key.length);
    const next = rest.search(/\n\s*'[a-zA-Z]+\.[a-zA-Z.]*':/);
    const block = next >= 0 ? rest.slice(0, next) : rest.slice(0, 400);
    assert.ok(block.includes('zh:') && block.includes('en:'), `${key} 需要同时有中英文`);
  }
  // 单行编辑的旧提示已经没有入口，不该继续留在文案表里。
  assert.equal(I18N.includes("'taskQueue.editHint'"), false, '排队节点的单行编辑已移除');
  assert.equal(I18N.includes("'chat.pendingBadge'"), false, '旧的单一状态文案已被四态取代');
});
