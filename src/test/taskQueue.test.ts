import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTaskQueue, fallbackTaskRelation } from '../agent/taskQueue';

test('merges related guidance before starting queued task branches', async () => {
  const queue = new AgentTaskQueue('修复登录刷新并发问题');
  const states: string[][] = [];
  const onChange = (state: ReturnType<AgentTaskQueue['state']>) => {
    states.push(state.nodes.map((node) => node.status));
  };

  queue.enqueue(
    '不要改登录接口，改为共享刷新任务',
    { role: 'user', content: '不要改登录接口，改为共享刷新任务' },
    async () => ({ relation: 'related', usage: { totalTokens: 3 } }),
    onChange,
    { userMessageId: 'user-related', assistantMessageId: 'assistant-related' },
  );
  const related = await queue.take('replan', onChange);
  assert.equal(related.length, 1);
  assert.match(String(related[0]?.request.content), /任务树更新：相关指导/);
  assert.match(String(related[0]?.request.content), /共享刷新任务/);
  assert.equal(related[0]?.userMessageId, 'user-related');
  assert.equal(related[0]?.assistantMessageId, 'assistant-related');

  queue.enqueue(
    '新增一个支付结果页面',
    { role: 'user', content: '新增一个支付结果页面' },
    async () => ({ relation: 'queued', usage: { totalTokens: 5 } }),
    onChange,
  );
  assert.deepEqual(await queue.take('replan', onChange), []);
  const queued = await queue.take('complete', onChange);
  assert.equal(queued.length, 1);
  assert.match(String(queued[0]?.request.content), /任务树分支：排队任务/);
  assert.match(String(queued[0]?.request.content), /支付结果页面/);
  assert.equal(queue.state().nodes.find((node) => node.id === queue.state().currentNodeId)?.status, 'active');
  assert.equal(queue.classifierUsage()?.totalTokens, 8);
  assert.ok(states.some((statuses) => statuses.includes('merged')));
  assert.ok(states.some((statuses) => statuses.includes('queued')));
});

test('uses a conservative local fallback when relation classification fails', () => {
  assert.equal(fallbackTaskRelation('修改 src/auth.ts 登录刷新', '继续调整 auth.ts 的错误处理'), 'related');
  assert.equal(fallbackTaskRelation('修改 src/auth.ts 登录刷新', '新增支付结果页面'), 'queued');
});
