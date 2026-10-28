import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatPanel } from '../views/chatPanel';

/**
 * 「点继续执行，清单卡住不动」的回归测试。
 *
 * 故障链：`update_todos` 的返回值是 `role: 'tool'` 消息，`requestMessages()` 会跳过
 * 所有 tool 消息；清单又只存在对话摘要的 `todos` 字段里。于是续跑那一轮模型只收到
 * 一句「继续执行清单里未完成的条目」，却看不到清单本身，只能猜或者从头再来。
 *
 * 这里不 mock 那句提示词，而是真的走一遍 `requestMessages()`，断言清单以带状态的
 * 结构化形式进了 system 消息。
 */

interface RequestMessage {
  role: string;
  content: string;
}

/** 只实现 `requestMessages()` 真正用到的那几个成员。 */
function fakePanel(conversation: Record<string, unknown>, stored: Record<string, unknown>[] = []): {
  requestMessages: (resumed?: boolean) => Promise<RequestMessage[]>;
} {
  const storage = {
    getContextMessages: async () => (stored.length ? stored : [
      { id: 'u1', role: 'user', content: '继续执行当前任务清单里未完成的条目。', consumedByAssistantId: 'a1' },
      { id: 'a1', role: 'assistant', content: '好，接着做。', status: 'complete' },
      // 真实运行时清单就在这里，但下面的循环会把它过滤掉——这正是故障来源。
      { id: 't1', role: 'tool', content: '<task_list>8. [ ] 同步文档</task_list>' },
    ]),
    getConversation: async () => conversation,
  };
  const skills = {
    sharedActiveIds: () => [],
    onDidChangeSharedState: { event: () => ({ dispose() { /* noop */ } }) },
  };
  const panel = new ChatPanel(
    {} as never, {} as never, storage as never, {} as never, {} as never,
    skills as never, {} as never, {} as never,
  );
  const call = panel as unknown as {
    requestMessages: (id: string, settings: unknown, mode: string, skillPrompt: string, resumed?: boolean) => Promise<RequestMessage[]>;
  };
  return {
    requestMessages: (resumed = false) =>
      call.requestMessages('c1', { maxMessagesInContext: 40, systemPrompt: '', permissionPreset: 'ask' }, 'agent', '', resumed),
  };
}

const EIGHT = [
  '验证托盘特性可离线编译',
  '实现单实例锁',
  '实现系统托盘',
  '启动器分组',
  '侧边栏宽度可调',
  '补冒烟与单测',
  '跑完整门禁',
  '同步文档',
];

const sixDone = EIGHT.map((content, index) => ({
  content,
  status: index < 6 ? 'completed' as const : 'pending' as const,
}));

test('requestMessages：续跑时把带状态的清单注入 system 消息', async () => {
  const panel = fakePanel({ id: 'c1', todos: sixDone, todosIncomplete: true });
  const [system] = await panel.requestMessages(true);
  assert.equal(system?.role, 'system');

  const content = system!.content;
  assert.match(content, /<task_list>/, 'system 消息里必须有清单块');
  assert.match(content, /6\. \[x\] 补冒烟与单测/, '已完成项要标 [x]，模型才不会重做');
  assert.match(content, /7\. \[ \] 跑完整门禁/, '未完成项要标 [ ]');
  assert.match(content, /Next item to work on: #7/, '必须明确指出下一条，而不是让模型自己找');
  assert.match(content, /跑完整门禁/, '下一条要带内容，不能只给编号');
  assert.match(content, /2 of 8 item\(s\) are not finished/, '未完成计数要按未完成项算');
});

test('requestMessages：续跑标记让文案说明「这是被中断后接着做」', async () => {
  const interrupted = await fakePanel({ id: 'c1', todos: sixDone }).requestMessages(true);
  const plain = await fakePanel({ id: 'c1', todos: sixDone }).requestMessages(false);
  assert.match(interrupted[0]!.content, /interrupted before it finished/);
  assert.doesNotMatch(plain[0]!.content, /interrupted before it finished/);
  assert.match(plain[0]!.content, /still in progress/, '非续跑也照样注入（否则清单同样看不见）');
});

test('requestMessages：清单全完成时不注入，也不会注入空数组指令', async () => {
  const done = EIGHT.map((content) => ({ content, status: 'completed' as const }));
  const [system] = await fakePanel({ id: 'c1', todos: done }).requestMessages(true);
  assert.equal(system!.content.includes('<task_list>'), false);
});

test('requestMessages：没有清单的普通对话不受影响', async () => {
  const [system] = await fakePanel({ id: 'c1' }).requestMessages(false);
  assert.equal(system!.content.includes('<task_list>'), false);
  assert.match(system!.content, /You are HWChat/);
});

test('requestMessages：清单进 system，tool 消息仍被过滤', async () => {
  const messages = await fakePanel({ id: 'c1', todos: sixDone }).requestMessages(true);
  assert.equal(messages.some((message) => message.role === 'tool'), false, 'tool 消息不能进请求');
  assert.equal(messages.filter((message) => message.role === 'system').length, 1, '只能有一条 system 消息');
});
