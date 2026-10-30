import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AgentTaskQueue, EDIT_HOLD_TIMEOUT_MS } from '../agent/taskQueue';
import { AgentTaskTreeState } from '../core/types';

/**
 * 悬浮编辑框 + 「agent 等用户改完再继续」。
 *
 * 现场需求（用户原话）：
 *   「点击编辑后显示编辑界面在新的层级显示…不被 agent 运行输出内容影响…
 *     编辑结束之前，如果 agent 刚好运行到这个正在编辑的消息，会暂停等待，
 *     修改完，编辑框消失，才会读取更新后的消息内容继续执行。」
 *
 * 这里守的是**后端**那一半：`take()` 是 agent 循环里唯一「取下一条任务」的入口，
 * 在它前面挂一道闸门，效果就是整轮停下来等人；保存后读到的必须是新内容。
 */

const noop = (): void => undefined;
const settle = (): Promise<void> => new Promise((done) => { setTimeout(done, 0); });

function queued(text = '改一下登录页'): { queue: AgentTaskQueue; nodeId: string; states: AgentTaskTreeState[] } {
  const queue = new AgentTaskQueue('修复登录刷新并发问题');
  const states: AgentTaskTreeState[] = [];
  const node = queue.enqueue(
    text,
    { role: 'user', content: text },
    async () => ({ relation: 'queued' }),
    (state) => { states.push(state); },
    { userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
  );
  return { queue, nodeId: node.id, states };
}

test('编辑闸门：take() 在用户改完之前不会把这条任务交出去', async () => {
  const { queue, nodeId } = queued('原始内容');
  await settle();
  queue.holdForEdit(nodeId);

  let taken = false;
  const pending = queue.take('complete', noop).then((updates) => { taken = true; return updates; });
  await new Promise((done) => { setTimeout(done, 120); });
  assert.equal(taken, false, 'agent 必须停在这里等用户改完');

  // 用户保存（队列里的 request 已被 editPending 换成新内容）
  await queue.editPending(nodeId, '改过的新内容', noop);
  queue.releaseEdit(nodeId);
  const updates = await pending;
  assert.equal(taken, true);
  assert.match(String(updates[0]?.request.content), /改过的新内容/, '放行后读到的是更新后的内容');
});

test('编辑闸门：取消编辑也放行，内容保持原样', async () => {
  const { queue, nodeId } = queued('原始内容');
  await settle();
  queue.holdForEdit(nodeId);
  const pending = queue.take('complete', noop);
  await new Promise((done) => { setTimeout(done, 80); });
  queue.releaseEdit(nodeId); // 取消编辑
  const updates = await pending;
  assert.match(String(updates[0]?.request.content), /原始内容/, '取消后按原内容执行');
});

test('编辑闸门：state 会暴露 editing / waitingForEdit，界面据此提示', async () => {
  const { queue, nodeId } = queued();
  await settle();
  queue.holdForEdit(nodeId);
  let node = queue.state().nodes.find((item) => item.id === nodeId);
  assert.equal(node?.editing, true, '打开编辑框即标记 editing');

  const pending = queue.take('complete', noop);
  await new Promise((done) => { setTimeout(done, 120); });
  node = queue.state().nodes.find((item) => item.id === nodeId);
  assert.equal(node?.waitingForEdit, true, 'agent 真到了这条才标记 waitingForEdit');
  queue.releaseEdit(nodeId);
  await pending;
  node = queue.state().nodes.find((item) => item.id === nodeId);
  assert.equal(node?.editing, false);
  assert.equal(node?.waitingForEdit, false);
});

test('编辑闸门：只等队首那一条，后面的任务不会因为它被跳过', async () => {
  const queue = new AgentTaskQueue('根任务');
  const first = queue.enqueue('第一条', { role: 'user', content: '第一条' }, async () => ({ relation: 'queued' }), noop, { userMessageId: 'u1' });
  const second = queue.enqueue('第二条', { role: 'user', content: '第二条' }, async () => ({ relation: 'queued' }), noop, { userMessageId: 'u2' });
  await settle();
  // 编辑第二条：它还没排到队首，不该阻塞 agent 取第一条。
  queue.holdForEdit(second.id);
  const updates = await queue.take('complete', noop);
  assert.equal(updates[0]?.nodeId, first.id, '先取第一条，顺序不乱');
  queue.releaseEdit(second.id);
});

test('编辑闸门：holdForEdit 幂等，重复调用不会续命', async () => {
  const { queue, nodeId } = queued();
  await settle();
  queue.holdForEdit(nodeId);
  queue.holdForEdit(nodeId);
  queue.holdForEdit(nodeId);
  queue.releaseEdit(nodeId);
  const updates = await queue.take('complete', noop);
  assert.equal(updates.length, 1, '一次释放就能放行，说明只挂了一道闸门');
});

test('编辑闸门：运行结束（finish）会释放全部闸门，不会留下挂起的 take()', async () => {
  const { queue, nodeId } = queued();
  await settle();
  queue.holdForEdit(nodeId);
  const pending = queue.take('complete', noop);
  await new Promise((done) => { setTimeout(done, 60); });
  await queue.finish('cancelled', noop);
  const updates = await pending;
  assert.equal(updates.length, 0, '运行结束后 take() 不该再交出任务');
});

test('编辑闸门：有超时上限，用户把编辑框开着不该卡死整轮', () => {
  // 5 分钟：够慢慢改一段话，又不至于让任务永远挂着。
  assert.equal(EDIT_HOLD_TIMEOUT_MS, 5 * 60_000);
  const queue = readFileSync('src/agent/taskQueue.ts', 'utf8');
  assert.match(queue, /setTimeout\(\(\) => \{[\s\S]{0,240}this\.releaseEdit/, '超时要自动放行');
});

test('接线：面板在打开/保存/取消/撤回时都会动闸门', () => {
  const panel = readFileSync('src/views/chatPanel.ts', 'utf8');
  assert.match(panel, /holdForEdit\(nodeId/, '打开编辑框要挂闸门');
  assert.match(panel, /run\.taskQueue\.releaseEdit\(nodeId\);\s*\n\s*this\.callbacks\.onHistoryChanged\(\);/, '保存后要放行');
  assert.match(panel, /private cancelEditTaskMessage[\s\S]{0,300}releaseEdit\(nodeId/, '取消要放行');
  assert.match(panel, /撤回前先放行闸门/, '撤回也要放行');
});

test('前端：浮层打开先挂闸门，保存/取消都要关浮层并放行', () => {
  const js = readFileSync('media/chat.js', 'utf8');
  const open = js.slice(js.indexOf('function openMessageEditor('), js.indexOf('function growMessageEditor('));
  assert.match(open, /post\('beginEditTaskMessage'/, '打开浮层要先挂闸门');
  assert.match(open, /editor\.hidden = false/, '浮层要显示');
  const close = js.slice(js.indexOf('function closeMessageEditor('), js.indexOf('function saveMessageEditor('));
  assert.match(close, /post\('cancelEditTaskMessage'/, '取消要放行闸门');
  assert.match(close, /editor\.hidden = true/, '要收起浮层');
  // 保存顺序：先关浮层（=放行），再发编辑请求 —— 后端拿到新内容后 agent 立即继续。
  const save = js.slice(js.indexOf('function saveMessageEditor('), js.indexOf('function isLongUserMessage('));
  assert.ok(save.indexOf('closeMessageEditor()') < save.indexOf("post('editTaskMessage'"), '保存要先关浮层再提交');
});

test('前端：点击不灵敏的兜底 —— pointerdown 记消息 id，pointerup 直接打开（不赌原生 click）', () => {
  const js = readFileSync('media/chat.js', 'utf8');
  assert.match(js, /elements\.messageList\.addEventListener\('pointerdown'/, '要在消息列表上记落点');
  assert.match(js, /dataset\.editMessage/, '按钮带稳定消息标识');
  const up = js.slice(js.indexOf('let pressedEditTarget = null;'), js.indexOf("elements.messageEditorInput.addEventListener('input'"));
  /*
   * 这里曾经断言「节点还在就交给原生 click」，而那条规则本身就是 bug：
   * 松手时按钮确实还在，但同一个 pointerup 里后面的监听器会立刻重排列表把按钮换掉，
   * 浏览器随即**不派发 click**（实测 mouseup 落到空白处），点击就彻底丢了。
   * 现在以 pointerup 为准：落点在按钮矩形内、或指针下当前就是同一条消息的编辑按钮，
   * 就直接打开；随后补发的 click 由 editClickConsumed 吞掉。
   */
  assert.doesNotMatch(up, /isConnected/, '不能再靠「节点还在」推断浏览器会派发 click');
  assert.match(up, /pressed\.messageId/, '要按稳定消息 id 找回');
  assert.match(up, /insideRecorded/, '落点在按下时的矩形内算点中');
  assert.match(up, /elementFromPoint/, '按钮被流式内容推走时，落点下是同一条消息的按钮也算点中');
  assert.match(up, /editClickConsumed = \{ messageId: pressed\.messageId/, '指针路径处理过就记账，供 click 去重');
  assert.match(up, /openMessageEditor\(message, node \|\| \{ id: nodeId \}\)/, '兜底要能打开浮层（任务树没有时按 id 兜住）');
});
