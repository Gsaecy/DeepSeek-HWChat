import assert from 'node:assert/strict';
import test from 'node:test';
import { TASK_INSTRUCTION_PREFIXES, userTextOfTaskRequest, withoutTaskInstruction, AgentTaskQueue, fallbackTaskRelation } from '../agent/taskQueue';

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

test('续跑语义只作用在续跑根分支，换到排队分支后自动失效', async () => {
  const flags: boolean[] = [];
  const onChange = () => {};
  const queue = new AgentTaskQueue('附件点击打开；运行中显示蓝色', { resumeScope: true });

  queue.enqueue(
    '将侧边栏的运行状态改成蓝色',
    { role: 'user', content: '将侧边栏的运行状态改成蓝色' },
    async (_current, _incoming, resumeScope) => {
      flags.push(resumeScope);
      return { relation: 'queued' };
    },
    onChange,
  );
  // 续跑根节点上比较新需求：必须告知分类器「当前是续跑清单，不是单一交付物」。
  assert.equal((await queue.take('complete', onChange)).length, 1);
  assert.deepEqual(flags, [true]);

  queue.enqueue(
    '再加一个导出按钮',
    { role: 'user', content: '再加一个导出按钮' },
    async (_current, _incoming, resumeScope) => {
      flags.push(resumeScope);
      return { relation: 'queued' };
    },
    onChange,
  );
  await queue.take('complete', onChange);
  // 已经离开续跑分支：不能再让旧清单的语义影响后续任务。
  assert.deepEqual(flags, [true, false]);
});

test('普通队列从不声明续跑语义', async () => {
  const flags: boolean[] = [];
  const queue = new AgentTaskQueue('修复登录刷新并发问题');
  queue.enqueue(
    '新增支付结果页面',
    { role: 'user', content: '新增支付结果页面' },
    async (_current, _incoming, resumeScope) => {
      flags.push(resumeScope);
      return { relation: 'queued' };
    },
    () => {},
  );
  await queue.take('complete', () => {});
  assert.deepEqual(flags, [false]);
});

/**
 * 任务树给用户消息加的前缀不该影响权限判定。
 *
 * 守卫判断「用户有没有要求提交」时必须只看用户原话；这些前缀是我们自己拼的说明文字。
 */
test('withoutTaskInstruction：剥掉任务树前缀，只留用户原话', () => {
  assert.equal(withoutTaskInstruction(`${TASK_INSTRUCTION_PREFIXES.related}提交`), '提交');
  assert.equal(withoutTaskInstruction(`${TASK_INSTRUCTION_PREFIXES.queued}推送这两处`), '推送这两处');
  assert.equal(withoutTaskInstruction('提交'), '提交', '没有前缀时原样返回');
});

test('userTextOfTaskRequest：从请求里取出用户原话（含多段文本）', () => {
  const request = { role: 'user' as const, content: `${TASK_INSTRUCTION_PREFIXES.related}提交` };
  assert.equal(userTextOfTaskRequest(request), '提交');
  const parts = { role: 'user' as const, content: [
    { type: 'text' as const, text: TASK_INSTRUCTION_PREFIXES.queued },
    { type: 'text' as const, text: '提交改动' },
  ] };
  assert.equal(userTextOfTaskRequest(parts), '提交改动');
});
