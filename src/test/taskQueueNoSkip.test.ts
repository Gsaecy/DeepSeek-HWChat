/**
 * 「不许插队 / 不许跳过未执行的消息」。
 *
 * 用户原话（2026-11-05）：
 *
 *     发的多个消息，如果合并执行的消息中间还有消息，会被跳过。
 *     让 agent 不要跳过未执行的消息，除非用户自己删除，不然需要根据状态之下，
 *     只要对话框还有未执行的消息都需要继续执行，包括执行中断、暂停等，
 *     继续后需要读取未执行清单，继续执行。
 *
 * 两个真实缺陷：
 *  1. **插队**：M1 被判成「独立任务」要等分支结束，而后发的 M2 被判成「相关」立刻
 *     被读走 —— 顺序颠倒；分支一旦结束得早，M1 就被跳过。
 *  2. **收尾丢弃**：运行结束时 `finish()` 把还在队列里的节点记成完成/取消，那种消息
 *     再也不会执行，界面上也看不出它其实一次都没跑过。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTaskQueue } from '../agent/taskQueue';

const noop = () => {};

function enqueue(queue: AgentTaskQueue, text: string, relation: 'related' | 'queued', id = text) {
  queue.enqueue(text, { role: 'user', content: text }, async () => ({ relation }), noop, {
    userMessageId: `user-${id}`,
    assistantMessageId: `assistant-${id}`,
  });
}

// ── 1. 不许插队 ────────────────────────────────────────────────────────
test('后发的「相关」消息不能越过先发的「独立」消息', async () => {
  const queue = new AgentTaskQueue('修登录刷新');
  enqueue(queue, '独立任务：新增支付页', 'queued', 'a');
  // 等分类落定（enqueue 内部是串行链）
  await queue.awaitRouting();
  enqueue(queue, '相关指导：顺便把按钮改成蓝色', 'related', 'b');
  await queue.awaitRouting();

  const state = queue.state();
  const related = state.nodes.find((node) => node.userMessageId === 'user-b');
  assert.equal(related?.status, 'queued', '前面还有没执行的独立消息时，后面的消息只能排队');

  // 边界重判也不能把它提到前面
  const outcomes = queue.pendingReview().map((task) => task.nodeId);
  assert.deepEqual(outcomes.length, 2, '两条都还在队列里等待');
  const result = await queue.resolveReview(outcomes[1]!, 'related');
  assert.equal(result, 'kept', '更早那条还没执行，这条即使「相关」也只能继续排队');
});

test('没有更早的独立消息时，「相关」照常合并进当前分支', async () => {
  const queue = new AgentTaskQueue('修登录刷新');
  enqueue(queue, '相关指导：按钮改成蓝色', 'related', 'only');
  await queue.awaitRouting();
  const taken = await queue.take('replan', noop);
  assert.equal(taken.length, 1);
  assert.equal(taken[0]?.relation, 'related');
});

test('独立消息被执行之后，后面的「相关」消息可以恢复合并', async () => {
  const queue = new AgentTaskQueue('修登录刷新');
  enqueue(queue, '独立任务 A', 'queued', 'a');
  await queue.awaitRouting();
  const first = await queue.take('complete', noop);
  assert.equal(first[0]?.relation, 'queued');

  enqueue(queue, '相关指导 B', 'related', 'b');
  await queue.awaitRouting();
  const second = await queue.take('replan', noop);
  assert.equal(second[0]?.relation, 'related', '前面的独立消息已经执行，它可以合并了');
});

// ── 2. 收尾不丢消息 ────────────────────────────────────────────────────
test('运行结束时还没执行的消息原样交还，且不被记成完成/取消', async () => {
  const queue = new AgentTaskQueue('修登录刷新');
  enqueue(queue, '第一条', 'queued', 'a');
  enqueue(queue, '第二条', 'queued', 'b');
  await queue.awaitRouting();

  await queue.finish('complete', noop);

  const retained = queue.retainedTasks();
  assert.deepEqual(retained.map((task) => task.userMessageId), ['user-a', 'user-b'], '按发送顺序交还');
  const state = queue.state();
  for (const id of ['user-a', 'user-b']) {
    const node = state.nodes.find((candidate) => candidate.userMessageId === id);
    assert.equal(node?.status, 'queued', '不能记成完成');
    assert.equal(node?.pending, true, '仍然显示「未执行」');
  }
});

test('被停止 / 报错时同样保留未执行的消息', async () => {
  for (const status of ['cancelled', 'error'] as const) {
    const queue = new AgentTaskQueue('任务');
    enqueue(queue, '还没做的事', 'queued', 'x');
    await queue.awaitRouting();
    await queue.finish(status, noop);
    assert.equal(queue.retainedTasks().length, 1, status);
    assert.equal(queue.state().nodes.find((node) => node.userMessageId === 'user-x')?.status, 'queued', status);
  }
});

test('取走执行的不会留在清单里（不重复执行）', async () => {
  const queue = new AgentTaskQueue('任务');
  enqueue(queue, 'A', 'queued', 'a');
  enqueue(queue, 'B', 'queued', 'b');
  await queue.awaitRouting();
  await queue.take('complete', noop);
  assert.deepEqual(queue.retainedTasks().map((task) => task.userMessageId), ['user-b']);
});

// ── 3. 续跑：清单原样放回队列 ──────────────────────────────────────────
test('续跑把未执行清单放回队列，保持顺序且排在新排队消息前面', async () => {
  const queue = new AgentTaskQueue('继续');
  const seeded = queue.seedPending([
    { title: '第一条', request: { role: 'user', content: '第一条' }, binding: { userMessageId: 'user-1', assistantMessageId: 'assistant-1' } },
    { title: '第二条', request: { role: 'user', content: '第二条' }, binding: { userMessageId: 'user-2', assistantMessageId: 'assistant-2' } },
  ]);
  assert.equal(seeded.length, 2);
  enqueue(queue, '这次新发的', 'queued', 'new');
  await queue.awaitRouting();

  const order: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const taken = await queue.take('complete', noop);
    if (!taken.length) break;
    order.push(taken[0]!.userMessageId ?? '');
  }
  assert.deepEqual(order, ['user-1', 'user-2', 'user-new'], '先来先做');
});

test('续跑放回的消息不会被边界重判成「合并」（它本来就不是新消息）', async () => {
  const queue = new AgentTaskQueue('继续');
  queue.seedPending([
    { title: '旧的一条', request: { role: 'user', content: '旧的一条' }, binding: { userMessageId: 'user-old' } },
  ]);
  assert.deepEqual(queue.pendingReview(), [], '放回来的不算「待重判」');
  const taken = await queue.take('complete', noop);
  assert.equal(taken[0]?.relation, 'queued');
  assert.match(String(taken[0]?.request.content), /任务树分支：排队任务/);
});

test('空清单不产生任何节点', () => {
  const queue = new AgentTaskQueue('继续');
  assert.deepEqual(queue.seedPending([]), []);
  assert.equal(queue.pendingTaskCount(), 0);
});
