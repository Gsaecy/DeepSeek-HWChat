import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTaskQueue, userTextOfTaskRequest } from '../agent/taskQueue';
import { AgentTaskTreeState } from '../core/types';

/**
 * 小任务边界上的「新消息重判」。
 *
 * 用户原话：「对话框 agent 正在运行，新消息进来，agent 需要执行完小任务后，先读取新消息，
 * 如果新消息和正在运行的任务相关，就合并，不管新消息和正在执行的消息之间间隔了多少条
 * 消息，都要先停下来判断一下再继续。」
 *
 * 原来的行为：相关与否只在**发消息那一刻**判一次（判据只有分支标题），判成「排队」就
 * 一直压到整条分支结束 —— 期间这条消息既不会被读，也不会被重新考虑。
 *
 * 这里锁的是新契约：
 *  1. `pendingReview()` 会把**所有**还没在本分支判断过的排队消息都交出来，
 *     跟它离正在执行的那条隔了多少条消息无关；
 *  2. 判为 `related` → 立刻并进当前分支（节点变 `merged`，请求进 `related` 队列，
 *     下一次 `take()` 就交给 agent）；
 *  3. 判为 `queued` → 仍独立，但记下「本分支已判过」，同一条分支上不再重复打扰；
 *  4. 换了分支（`take()` 取走排队任务）之后再判——分支变了，判断依据也变了。
 */

const noop = (): void => undefined;

async function settle(): Promise<void> {
  await new Promise((done) => { setTimeout(done, 0); });
}

/** 建一条正在跑的分支，并按顺序排进若干条消息（全部先判成排队）。 */
async function queueWith(texts: string[]): Promise<{ queue: AgentTaskQueue; nodeIds: string[] }> {
  const queue = new AgentTaskQueue('灵动岛区域增加邮箱与订阅折叠展开');
  const nodeIds: string[] = [];
  for (const [index, text] of texts.entries()) {
    const node = queue.enqueue(
      text,
      { role: 'user', content: text },
      async () => ({ relation: 'queued' }),
      noop,
      { userMessageId: `user-${index}`, assistantMessageId: `assistant-${index}` },
    );
    nodeIds.push(node.id);
  }
  await settle();
  await queue.awaitRouting();
  return { queue, nodeIds };
}

test('边界重判：所有未判过的排队消息都会被扫到，与间隔多少条无关', async () => {
  const { queue, nodeIds } = await queueWith([
    '第一条：灵动岛待办折叠',
    '第二条：给设置页加搜索框',        // 与正在跑的分支完全无关
    '第三条：邮件列表支持滚轮',
  ]);
  await settle();
  const pending = queue.pendingReview();
  assert.equal(pending.length, 3, '三条都要被交出来，不能只看最近一条');
  assert.deepEqual(pending.map((task) => task.nodeId), nodeIds, '顺序仍是发送顺序');
  // 交出来的是「还没执行」的那份原文，不带任务树前缀
  assert.equal(userTextOfTaskRequest(pending[0]!.request), '第一条：灵动岛待办折叠');
});

test('边界重判：判为相关 → 当场并入当前分支，节点变「已合并」并立刻交给 agent', async () => {
  const { queue, nodeIds } = await queueWith(['灵动岛的待办和书签也需要分别能折叠']);
  await queue.resolveReview(nodeIds[0]!, 'related');

  const node = queue.state().nodes.find((candidate) => candidate.id === nodeIds[0]);
  assert.equal(node?.status, 'merged', '任务树要显示成已合并');
  assert.equal(node?.relation, 'related');
  assert.equal(node?.parentId, queue.activeNodeId(), '挂在正在跑的那条分支下面');

  // 下一次 take() 就应该把它交给 agent（配的是「立即重新评估当前分支」那段说明）
  const [update] = await queue.take('replan', noop);
  assert.ok(update, '合并后的消息要在本分支内立刻被读到');
  assert.equal(update!.relation, 'related');
  assert.match(String(update!.request.content), /相关指导/);
  assert.match(String(update!.request.content), /待办和书签/);
});

test('边界重判：判为独立 → 继续留在排队里，本分支不再重复判它', async () => {
  const { queue, nodeIds } = await queueWith(['给设置页加搜索框']);
  await queue.resolveReview(nodeIds[0]!, 'queued');

  const node = queue.state().nodes.find((candidate) => candidate.id === nodeIds[0]);
  assert.equal(node?.status, 'queued', 'independent 仍然是排队');
  assert.equal(queue.pendingReview().length, 0, '本分支已经判过，不再打扰');

  // 分支还没跑完，不能提前把它交给 agent
  const updates = await queue.take('replan', noop);
  assert.equal(updates.length, 0, 'replan 阶段不取排队任务');
});

test('边界重判：换到下一个分支后会重新判一次（依据变了）', async () => {
  const { queue, nodeIds } = await queueWith(['第一件事', '第二件事']);
  await queue.resolveReview(nodeIds[0]!, 'queued');
  await queue.resolveReview(nodeIds[1]!, 'queued');
  assert.equal(queue.pendingReview().length, 0);

  // 第一条分支结束 → 取走第二条分支，此时 current 变了
  const [next] = await queue.take('complete', noop);
  assert.equal(next?.nodeId, nodeIds[0]);
  assert.equal(queue.activeNodeId(), nodeIds[0]);

  const pending = queue.pendingReview();
  assert.deepEqual(pending.map((task) => task.nodeId), [nodeIds[1]], '新的分支要把剩下的重新判一次');
});

test('边界重判：正在被编辑的消息先不判，等用户改完再判', async () => {
  const { queue, nodeIds } = await queueWith(['正在编辑的这条', '另一条']);
  await queue.holdForEdit(nodeIds[0]!);
  const pending = queue.pendingReview();
  assert.deepEqual(pending.map((task) => task.nodeId), [nodeIds[1]], '编辑中的那条要用改后的文本再判');
  queue.releaseEdit(nodeIds[0]!);
  assert.equal(queue.pendingReview().length, 2);
});

test('边界重判：被撤单/已取走的消息不会被当成待判（幂等、不报错）', async () => {
  const { queue, nodeIds } = await queueWith(['会被撤掉的一条']);
  await queue.removePending(nodeIds[0]!, noop);
  assert.equal(queue.pendingReview().length, 0);
  const result = await queue.resolveReview(nodeIds[0]!, 'related');
  assert.equal(result, 'kept', '已经不在队列里的不能再被「合并」');
});

test('续跑作用域：只有根分支算续跑，切到排队分支后不再沿用', async () => {
  const queue = new AgentTaskQueue('继续执行暂停的清单', { resumeScope: true });
  assert.equal(queue.isResumeScope(), true);
  const node = queue.enqueue('另一件事', { role: 'user', content: '另一件事' }, async () => ({ relation: 'queued' }), noop);
  await settle();
  await queue.take('complete', noop);
  assert.equal(queue.activeNodeId(), node.id);
  assert.equal(queue.isResumeScope(), false, '续跑语义只对根节点成立');
});

/** 收尾：状态里没有悬空的 pending 标记（`related` 与 `queued` 两套队列都要一致）。 */
test('状态一致：合并后的节点不再出现在排队计数里', async () => {
  const queue = new AgentTaskQueue('主任务');
  const states: AgentTaskTreeState[] = [];
  const node = queue.enqueue('要合并的', { role: 'user', content: '要合并的' }, async () => ({ relation: 'queued' }), noop);
  await settle();
  await queue.resolveReview(node.id, 'related', (state) => { states.push(state); });
  const last = states.at(-1)!;
  assert.equal(last.nodes.filter((candidate) => candidate.status === 'queued').length, 0);
  assert.equal(last.nodes.filter((candidate) => candidate.status === 'merged').length, 1);
});
