import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTaskQueue, TaskRelation } from '../agent/taskQueue';
import { reviewQueuedTasks } from '../agent/taskReview';

/**
 * 边界重判的**编排**（谁被判、按什么顺序、失败怎么办、停止怎么办）。
 *
 * 队列自身的记账契约在 `taskQueueReview.test.ts`；这里盯的是最容易出错的调度层：
 * 判错一次就得回滚、判失败不能假装判过、停止后不能继续发请求。
 */

async function settle(): Promise<void> {
  await new Promise((done) => { setTimeout(done, 0); });
}

async function queueWith(texts: string[]): Promise<{ queue: AgentTaskQueue; nodeIds: string[] }> {
  const queue = new AgentTaskQueue('灵动岛区域增加邮箱与订阅折叠展开');
  const nodeIds: string[] = [];
  for (const [index, text] of texts.entries()) {
    const node = queue.enqueue(
      text,
      { role: 'user', content: text },
      async () => ({ relation: 'queued' }),
      () => undefined,
      { userMessageId: `user-${index}`, assistantMessageId: `assistant-${index}` },
    );
    nodeIds.push(node.id);
  }
  await settle();
  await queue.awaitRouting();
  return { queue, nodeIds };
}

test('编排：按发送顺序逐条判，间隔多少条都判得到', async () => {
  const { queue } = await queueWith(['甲：待办折叠', '乙：设置页搜索框', '丙：邮件列表滚轮']);
  const judged: string[] = [];
  const outcome = await reviewQueuedTasks(queue, {
    classify: async (_current, incoming) => { judged.push(incoming); return 'queued'; },
    liveContext: () => 'Task list: 2/9 completed.',
    onChange: () => undefined,
  });
  assert.deepEqual(judged, ['甲：待办折叠', '乙：设置页搜索框', '丙：邮件列表滚轮']);
  assert.equal(outcome.kept.length, 3);
  assert.equal(outcome.merged.length, 0);
});

test('编排：判为相关就合并，并且下一轮 take 立刻把它交给 agent', async () => {
  const { queue, nodeIds } = await queueWith(['待办与书签分别可折叠', '无关的设置页']);
  const outcome = await reviewQueuedTasks(queue, {
    classify: async (_current, incoming) => (incoming.includes('书签') ? 'related' : 'queued'),
    liveContext: () => '',
    onChange: () => undefined,
  });
  assert.deepEqual(outcome.merged, [nodeIds[0]]);
  assert.deepEqual(outcome.kept, [nodeIds[1]]);
  const [update] = await queue.take('replan', () => undefined);
  assert.equal(update?.nodeId, nodeIds[0], '合并的那条要在本分支内被读到');
});

test('编排：把「现在在做什么」交给判定（只看标题会判错）', async () => {
  const { queue } = await queueWith(['邮件列表支持滚轮']);
  let seenContext = '';
  let seenCurrent = '';
  await reviewQueuedTasks(queue, {
    classify: async (current, _incoming, live) => { seenCurrent = current; seenContext = live; return 'related'; },
    liveContext: () => 'Task list: 3/9 completed.\nWorking on: 邮件列表分页',
    onChange: () => undefined,
  });
  assert.match(seenCurrent, /灵动岛区域/);
  assert.match(seenContext, /Working on: 邮件列表分页/, '实时进度必须进判定上下文');
});

test('编排：判定失败不记账 —— 下个边界还要再判一次（不能静默当成已处理）', async () => {
  const { queue } = await queueWith(['这条判定会失败']);
  let attempts = 0;
  const failing = {
    classify: async (): Promise<TaskRelation> => { attempts += 1; throw new Error('network down'); },
    liveContext: () => '',
    onChange: () => undefined,
  };
  const first = await reviewQueuedTasks(queue, failing);
  assert.equal(attempts, 1);
  assert.equal(first.kept.length, 0, '失败不算「判过」');
  assert.equal(queue.pendingReview().length, 1, '仍然待判');

  const second = await reviewQueuedTasks(queue, {
    classify: async () => { attempts += 1; return 'related'; },
    liveContext: () => '',
    onChange: () => undefined,
  });
  assert.equal(attempts, 2, '下个边界会重试');
  assert.equal(second.merged.length, 1, '重试成功就合并');
});

test('编排：同一条消息在本分支只判一次（不会每一步都问一遍）', async () => {
  const { queue } = await queueWith(['只该判一次']);
  let calls = 0;
  const classify = async (): Promise<TaskRelation> => { calls += 1; return 'queued'; };
  await reviewQueuedTasks(queue, { classify, liveContext: () => '', onChange: () => undefined });
  await reviewQueuedTasks(queue, { classify, liveContext: () => '', onChange: () => undefined });
  await reviewQueuedTasks(queue, { classify, liveContext: () => '', onChange: () => undefined });
  assert.equal(calls, 1, '重复边界不该重复花分类的钱');
});

test('编排：停止后不再发判定请求', async () => {
  const { queue } = await queueWith(['甲', '乙', '丙']);
  const controller = new AbortController();
  let calls = 0;
  const outcome = await reviewQueuedTasks(queue, {
    classify: async () => {
      calls += 1;
      controller.abort();       // 第一次判定期间用户点了停止
      return 'queued';
    },
    liveContext: () => '',
    onChange: () => undefined,
    signal: controller.signal,
  });
  assert.equal(calls, 1, '停止后剩下的不该再问');
  assert.equal(outcome.merged.length + outcome.kept.length, 0);
  assert.equal(queue.pendingReview().length, 3, '都没被判过，恢复后还能再判');
});

test('编排：没有排队消息时不调判定、不调上下文（零开销）', async () => {
  const queue = new AgentTaskQueue('主任务');
  let classifyCalls = 0;
  let contextCalls = 0;
  await reviewQueuedTasks(queue, {
    classify: async () => { classifyCalls += 1; return 'queued'; },
    liveContext: () => { contextCalls += 1; return ''; },
    onChange: () => undefined,
  });
  assert.equal(classifyCalls, 0);
  assert.equal(contextCalls, 0);
});

test('编排：判定期间被撤单的那条不会被误合并', async () => {
  const { queue, nodeIds } = await queueWith(['会被撤掉']);
  const outcome = await reviewQueuedTasks(queue, {
    classify: async () => {
      await queue.removePending(nodeIds[0]!, () => undefined);   // 判定途中用户删除
      return 'related';
    },
    liveContext: () => '',
    onChange: () => undefined,
  });
  assert.equal(outcome.merged.length, 0);
  assert.equal(queue.state().nodes.find((node) => node.id === nodeIds[0])?.status, 'cancelled');
});

/* ── 暂停点：判成独立的也要让模型读一遍（用户 2026-11-18） ───────────────── */

test('暂停点：判成独立的消息也交给模型分析，但它仍然留在队列里没被执行', async () => {
  const { queue, nodeIds } = await queueWith(['登录页少了最小化/最大化/关闭按钮']);
  const outcome = await reviewQueuedTasks(queue, {
    classify: async () => 'queued',
    liveContext: () => 'Task list: 2/5 completed.',
    onChange: () => undefined,
    deliverAnalysis: true,
  });

  assert.deepEqual(outcome.kept, [nodeIds[0]], '分类结论不变：它仍然是排队任务');
  assert.equal(outcome.analysis.length, 1);
  const [analysis] = outcome.analysis;
  assert.equal(analysis?.analysis, true, '面板据此不切换回复气泡');
  assert.equal(analysis?.nodeId, nodeIds[0]);
  assert.match(String(analysis?.request.content), /暂停时的综合分析/);
  assert.match(String(analysis?.request.content), /现在不要开始做/);
  assert.match(String(analysis?.request.content), /登录页少了最小化/, '用户原话要一字不差地带给模型');

  assert.equal(queue.pendingTaskCount(), 1, '分析不等于执行：它还在队列里等下一轮');
  const pending = queue.state().nodes.find((node) => node.id === nodeIds[0]);
  assert.equal(pending?.status, 'queued');
  assert.equal(pending?.pending, true);
  assert.equal(pending?.editing, false);
});

test('暂停点之外（普通边界）不重复把独立消息塞给模型', async () => {
  const { queue } = await queueWith(['无关的设置页']);
  const outcome = await reviewQueuedTasks(queue, {
    classify: async () => 'queued',
    liveContext: () => '',
    onChange: () => undefined,
  });
  assert.equal(outcome.analysis.length, 0, '没有暂停就不额外喂一遍，避免每一步都多花一次上下文');
});
