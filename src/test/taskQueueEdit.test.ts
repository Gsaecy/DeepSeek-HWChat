import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTaskQueue, withPlainText } from '../agent/taskQueue';
import { AgentTaskTreeState } from '../core/types';

/**
 * 排队消息的编辑与撤回。
 *
 * 用户要求：排队中的消息能改、能删；改完在原消息上生效（任务树里的排队内容同步变）；
 * 已经被 agent 取走执行的不能再删，但改过的内容可以再发一次。
 *
 * 关键在于「还没被执行」这条边界是靠**队列是否还持有它**判断的 —— 只要 `take()`
 * 把它取走，`editPending` / `removePending` 就必须一律返回 false。
 */

const noop = (): void => undefined;

function queueWithQueued(text = '新增支付结果页面'): {
  queue: AgentTaskQueue;
  nodeId: string;
  states: AgentTaskTreeState[];
} {
  const queue = new AgentTaskQueue('修复登录刷新并发问题');
  const states: AgentTaskTreeState[] = [];
  const onChange = (state: AgentTaskTreeState): void => { states.push(state); };
  const node = queue.enqueue(
    text,
    { role: 'user', content: text },
    async () => ({ relation: 'queued' }),
    onChange,
    { userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
  );
  return { queue, nodeId: node.id, states };
}

/** 等分类跑完（enqueue 里是链在 routingTail 上的异步任务）。 */
const settle = (): Promise<void> => new Promise((done) => { setTimeout(done, 0); });

test('排队节点在 state 里标成 pending 并带上 userMessageId', async () => {
  const { queue, nodeId } = queueWithQueued();
  await settle();
  const node = queue.state().nodes.find((candidate) => candidate.id === nodeId);
  assert.equal(node?.pending, true, '还没被执行 → 可编辑、可删除');
  assert.equal(node?.userMessageId, 'user-1', '界面要靠它读回原话、删除对应的存档消息');
});

test('editPending：改完直接影响下一轮真正读到的 request', async () => {
  const { queue, nodeId } = queueWithQueued('新增支付结果页面');
  await settle();
  const applied = await queue.editPending(nodeId, '新增退款结果页面，复用支付页组件', noop);
  assert.equal(applied, true);
  const taken = await queue.take('complete', noop);
  assert.equal(taken.length, 1);
  const content = String(taken[0]?.request.content);
  assert.match(content, /新增退款结果页面/, 'agent 读到的必须是改过之后的内容');
  assert.doesNotMatch(content, /新增支付结果页面/, '旧内容不能残留');
});

test('editPending：任务树里的排队内容同步变化', async () => {
  const { queue, nodeId } = queueWithQueued('很长的旧标题，会被 shortTitle 截断成短标题');
  await settle();
  await queue.editPending(nodeId, '新标题', noop);
  const node = queue.state().nodes.find((candidate) => candidate.id === nodeId);
  assert.equal(node?.title, '新标题', '排队分支显示的文字要跟着改');
  assert.equal(node?.pending, true, '编辑不会让它提前变成已执行');
});

test('editPending：已被 take() 取走执行后返回 false', async () => {
  const { queue, nodeId } = queueWithQueued();
  await settle();
  await queue.take('complete', noop);
  const applied = await queue.editPending(nodeId, '改个内容', noop);
  assert.equal(applied, false, '历史已发生，不能再原地改 —— 调用方应改为重新发一条');
  const node = queue.state().nodes.find((candidate) => candidate.id === nodeId);
  assert.equal(node?.pending, false);
  assert.equal(node?.userMessageId, 'user-1', '执行过的节点仍要能找回原消息，编辑后重发要用它当初值');
});

test('执行中的节点：状态是 active 且 pending=false —— 界面据此不给编辑入口', async () => {
  // 现场缺陷：任务树给「执行中」的节点也放了编辑按钮。agent 已经把 request 读走，
  // editPending 必然返回 false，于是保存走的是「把改过的内容当新消息再发一遍」，
  // 同一件事被排队做第二次。这里锁住界面的判定依据：active 节点绝不能被当成可编辑。
  const { queue, nodeId } = queueWithQueued();
  await settle();
  const taken = await queue.take('complete', noop);
  assert.equal(taken.length, 1, '这条被 agent 取走执行');
  const node = queue.state().nodes.find((candidate) => candidate.id === nodeId);
  assert.equal(node?.status, 'active', '正在执行');
  assert.equal(node?.pending, false, '队列不再持有它 → 不能原地改，界面不该给编辑入口');
  assert.equal(await queue.editPending(nodeId, '改个内容', noop), false, '后端也确认改不了');
});

test('editPending：空内容不接受', async () => {
  const { queue, nodeId } = queueWithQueued('原始内容');
  await settle();
  assert.equal(await queue.editPending(nodeId, '   ', noop), false);
  const taken = await queue.take('complete', noop);
  assert.match(String(taken[0]?.request.content), /原始内容/, '空提交不能把原话清掉');
});

test('removePending：撤掉排队项，节点标成 cancelled 而不是消失', async () => {
  const { queue, nodeId } = queueWithQueued();
  await settle();
  const removed = await queue.removePending(nodeId, noop);
  assert.equal(removed, true);
  const state = queue.state();
  const node = state.nodes.find((candidate) => candidate.id === nodeId);
  assert.equal(node?.status, 'cancelled', '任务树是时间线，撤销要留痕');
  assert.equal(node?.pending, false);
  assert.equal(state.nodes.length, 2, '节点本身不删掉');
  const taken = await queue.take('complete', noop);
  assert.equal(taken.length, 0, '撤掉的任务不能再被取走执行');
});

test('removePending：已被执行的消息不能删', async () => {
  const { queue, nodeId } = queueWithQueued();
  await settle();
  await queue.take('complete', noop);
  assert.equal(await queue.removePending(nodeId, noop), false);
});

test('removePending：只撤那一条，别的排队任务照常执行', async () => {
  const queue = new AgentTaskQueue('主线任务');
  const onChange = (): void => undefined;
  const first = queue.enqueue('排第一条', { role: 'user', content: '排第一条' }, async () => ({ relation: 'queued' }), onChange, { userMessageId: 'u1' });
  const second = queue.enqueue('排第二条', { role: 'user', content: '排第二条' }, async () => ({ relation: 'queued' }), onChange, { userMessageId: 'u2' });
  await settle();
  await settle();
  assert.equal(await queue.removePending(first.id, onChange), true);
  const taken = await queue.take('complete', onChange);
  assert.equal(taken.length, 1);
  assert.equal(taken[0]?.nodeId, second.id, '撤掉第一条之后应当轮到第二条');
  assert.match(String(taken[0]?.request.content), /排第二条/);
});

test('withPlainText：换掉文字但保留附件', () => {
  const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAA' } };
  const request = { role: 'user' as const, content: [{ type: 'text' as const, text: '旧文字' }, image] };
  const next = withPlainText(request, '新文字');
  assert.deepEqual(next.content, [{ type: 'text', text: '新文字' }, image], '附件不能被编辑顺手丢掉');

  const plain = withPlainText({ role: 'user', content: '旧文字' }, '新文字');
  assert.equal(plain.content, '新文字', '纯文本 request 直接替换');
});

test('刚发出、还在分类的消息也可以改（不用等分类回来）', async () => {
  const queue = new AgentTaskQueue('主线');
  const states: AgentTaskTreeState[] = [];
  const node = queue.enqueue(
    '刚发出去的话',
    { role: 'user', content: '刚发出去的话' },
    async () => { await new Promise((done) => { setTimeout(done, 5); }); return { relation: 'queued' }; },
    (state) => { states.push(state); },
    { userMessageId: 'u-early' },
  );
  // 分类还没回来：routing 状态就该给出编辑入口，而不是等一两秒。
  const routing = queue.state().nodes.find((candidate) => candidate.id === node.id);
  assert.equal(routing?.status, 'routing');
  assert.equal(routing?.pending, true, 'routing 也是「还没被执行」');
  assert.equal(routing?.userMessageId, 'u-early');

  // editPending 会先等分类落定，再改对应的那一条。
  const applied = await queue.editPending(node.id, '改过的话', noop);
  assert.equal(applied, true);
  const taken = await queue.take('complete', noop);
  assert.match(String(taken[0]?.request.content), /改过的话/);
});
