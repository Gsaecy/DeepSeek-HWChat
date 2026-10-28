import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTaskQueue } from '../agent/taskQueue';
import { AgentTaskTreeState } from '../core/types';

/**
 * 端到端：编辑一条排队消息之后，agent 真正读到的是什么。
 *
 * 这是用户要求的核心语义 ——「agent 读取前修改直接在原消息上生效（任务树排队内容也同步变化）」。
 * 单测只断言队列 API 的返回值不够，必须走一遍 `take()`（agent 取任务的唯一入口），
 * 确认它拿到的 request 已经是新内容，而任务树显示的也同步换了。
 */

const noop = (): void => undefined;
const settle = (): Promise<void> => new Promise((done) => { setTimeout(done, 0); });

test('编辑排队消息后：take() 拿到新内容，任务树标题同步，旧内容完全消失', async () => {
  const queue = new AgentTaskQueue('主线：修登录并发');
  const states: AgentTaskTreeState[] = [];
  const onChange = (state: AgentTaskTreeState): void => { states.push(state); };
  const node = queue.enqueue(
    '更新 README 使用说明',
    { role: 'user', content: '更新 README 使用说明' },
    async () => ({ relation: 'queued' }),
    onChange,
    { userMessageId: 'u-readme', assistantMessageId: 'a-readme' },
  );
  await settle();

  const applied = await queue.editPending(node.id, '更新 README 与 CHANGELOG，补上托盘一节', onChange);
  assert.equal(applied, true, '还在排队 → 原地改');

  const treeBeforeTake = queue.state();
  const shown = treeBeforeTake.nodes.find((candidate) => candidate.id === node.id);
  assert.equal(shown?.title, '更新 README 与 CHANGELOG，补上托盘一节', '任务树排队内容要同步变');
  assert.equal(shown?.pending, true, '改完仍在排队，不是已执行');

  const taken = await queue.take('complete', onChange);
  assert.equal(taken.length, 1);
  const content = String(taken[0]?.request.content);
  assert.match(content, /更新 README 与 CHANGELOG/, 'agent 读到的是改过之后的内容');
  assert.doesNotMatch(content, /使用说明/, '旧内容不能残留');
  assert.match(content, /任务树分支：排队任务/, '任务树前缀仍在，编辑只换用户那句话');
  assert.equal(taken[0]?.userMessageId, 'u-readme', '消息绑定不变：存档里改的是同一条消息');
});

test('编辑已执行的排队消息：队列拒绝原地改，但内容仍可作为新任务再入队', async () => {
  const queue = new AgentTaskQueue('主线');
  const node = queue.enqueue(
    '更新 README',
    { role: 'user', content: '更新 README' },
    async () => ({ relation: 'queued' }),
    noop,
    { userMessageId: 'u1' },
  );
  await settle();
  await queue.take('complete', noop);

  assert.equal(await queue.editPending(node.id, '改过的内容', noop), false, '已执行 → 不能改写历史');

  // 用户的要求：改过的内容可以再发一次。
  const resent = queue.enqueue(
    '改过的内容',
    { role: 'user', content: '改过的内容' },
    async () => ({ relation: 'queued' }),
    noop,
    { userMessageId: 'u2' },
  );
  await settle();
  const taken = await queue.take('complete', noop);
  assert.equal(taken.length, 1);
  assert.equal(taken[0]?.nodeId, resent.id, '重新发出的是新任务');
  assert.match(String(taken[0]?.request.content), /改过的内容/);
  const original = queue.state().nodes.find((candidate) => candidate.id === node.id);
  assert.equal(original?.status, 'complete', '原来那条保持原样');
});

test('撤回排队消息后：agent 不会再执行它，任务树留一条 cancelled 记录', async () => {
  const queue = new AgentTaskQueue('主线');
  const doomed = queue.enqueue('要撤回的', { role: 'user', content: '要撤回的' }, async () => ({ relation: 'queued' }), noop, { userMessageId: 'u-doomed' });
  const kept = queue.enqueue('要保留的', { role: 'user', content: '要保留的' }, async () => ({ relation: 'queued' }), noop, { userMessageId: 'u-kept' });
  await settle();
  await settle();

  assert.equal(await queue.removePending(doomed.id, noop), true);
  const taken = await queue.take('complete', noop);
  assert.equal(taken.length, 1);
  assert.equal(taken[0]?.nodeId, kept.id, '被撤回的那条不会再被取走');

  const state = queue.state();
  const gone = state.nodes.find((candidate) => candidate.id === doomed.id);
  assert.equal(gone?.status, 'cancelled');
  assert.equal(gone?.pending, false, '撤回之后不再可编辑/可删除');
  assert.equal(gone?.userMessageId, 'u-doomed', '仍能找回那条消息，界面可以据此移除它');
});
