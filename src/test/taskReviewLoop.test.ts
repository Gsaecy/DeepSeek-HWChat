import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRunner } from '../agent/agentRunner';
import { AgentTaskQueue } from '../agent/taskQueue';
import { reviewQueuedTasks } from '../agent/taskReview';
import { ChatRequestMessage, ChatSettings, ToolExecutionResult } from '../core/types';

/**
 * 端到端：**运行中新消息是否真的在小任务边界被读到**。
 *
 * 这是用户报的那条需求的落地验证 —— 原话：
 * 「对话框 agent 正在运行，新消息进来，agent 需要执行完小任务后，先读取新消息，
 *   如果新消息和正在运行的任务相关，就合并，不管新消息和正在执行的消息之间间隔了
 *   多少条消息，都要先停下来判断一下再继续。」
 *
 * 测试复刻的正是线上那一幕：任务树 3 个节点（一条已完成、一条执行中、一条排队），
 * 排队的这条跟正在执行的那条之间还隔着别的内容。断言的不是「队列里状态对不对」，
 * 而是**模型下一轮收到的 messages 里真的出现了这条消息**，并且带的是「立即重新评估
 * 当前分支」的说明（也就是合并语义，而不是另起一个分支）。
 */

const settings: ChatSettings = {
  internetReference: false,
  apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid', models: ['deepseek-chat'], requestHeaders: {} }],
  activeApiProfileId: 'default',
  baseUrl: 'https://example.invalid', model: 'deepseek-chat', temperature: 0, maxTokens: 0,
  systemPrompt: '', sendOnEnter: true, historyRetentionDays: 30, taskCacheRetentionHours: 24,
  cacheBudgetMB: 100, cleanupIntervalMinutes: 10, maxMessagesInContext: 20, requestHeaders: {},
  requestTimeoutSeconds: 30, defaultMode: 'agent', agentMaxSteps: 12, reasoningEffort: 'default', permissionPreset: 'review',
  fileReadPolicy: 'allow', fileWritePolicy: 'ask', commandPolicy: 'ask', dangerousCommandPolicy: 'ask',
  sensitiveFilePolicy: 'deny', maxReadBytes: 512_000, maxToolOutputBytes: 200_000,
  maxCommandSeconds: 120, auditRetentionDays: 30, language: 'auto',
};

const toolResult: ToolExecutionResult = {
  status: 'success', summary: '写入 src/island.ts（128 B）', content: 'ok', approval: 'not-required',
};

async function settle(): Promise<void> {
  await new Promise((done) => { setTimeout(done, 0); });
}

test('端到端：排队消息在下一轮就被合并读入（不等整条分支结束）', async () => {
  const queue = new AgentTaskQueue('半透明的背景玻璃显示成 Wise 风格渐变颜色的半透明');
  const requests: ChatRequestMessage[][] = [];

  let round = 0;
  const client = {
    async streamChat(_settings: ChatSettings, messages: ChatRequestMessage[]) {
      requests.push(structuredClone(messages));
      round += 1;
      if (round === 1) {
        // 第 1 轮跑到一半，用户又发来一条（真实场景：分支还在跑，新消息进来）
        queue.enqueue(
          '灵动岛的待办和书签，也需要分别能折叠和鼠标滚动显示',
          { role: 'user', content: '灵动岛的待办和书签，也需要分别能折叠和鼠标滚动显示' },
          async () => ({ relation: 'queued' }),
          () => undefined,
          { userMessageId: 'u-2', assistantMessageId: 'a-2' },
        );
      }
      // 前 3 轮都在做同一个分支的工具活（模拟「小任务」一个接一个）
      if (round <= 3) {
        return {
          content: '', reasoning: '', usage: undefined, finishReason: 'tool_calls',
          toolCalls: [{ id: `call_${round}`, type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"src/island.ts","content":"x"}' } }],
        };
      }
      return { content: '完成。', reasoning: '', usage: undefined, finishReason: 'stop', toolCalls: [] };
    },
  };
  const tools = {
    definitions: () => [{ type: 'function' as const, function: { name: 'write_file', description: 'write', parameters: {} } }],
    execute: async () => toolResult,
  };

  const runner = new AgentRunner(client as never, tools as never);
  const runPromise = runner.run({
    settings,
    messages: [{ role: 'user', content: '把灵动岛背景玻璃做成 Wise 风格渐变' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'conversation-review',
    takeTaskUpdate: async (phase) => {
      // 与生产一致：每个小任务边界（replan）先重判排队消息，再取任务
      if (phase === 'replan') {
        await reviewQueuedTasks(queue, {
          classify: async (_current, incoming) => (incoming.includes('待办') ? 'related' : 'queued'),
          liveContext: () => 'Task list: 1/4 completed.\nWorking on: 背景玻璃渐变',
          onChange: () => undefined,
        });
      }
      return queue.take(phase, () => undefined);
    },
    callbacks: { onDelta: () => undefined, onToolsChanged: () => undefined, requestApproval: async () => true },
  });

  await runPromise;

  // 断言 1：它没有等到分支结束 —— 第 1 轮发来的消息，在第 2 轮（下一个边界）模型就收到了它。
  // （若只在分支结束时才处理，它最早也要等到最后一轮才出现。）
  const mergedRound = requests.findIndex((messages) =>
    messages.some((message) => typeof message.content === 'string' && message.content.includes('待办和书签')));
  assert.equal(mergedRound, 1, `应在下一个边界被读到，实际在第 ${mergedRound + 1} 轮（共 ${requests.length} 轮）`);
  assert.ok(requests.length > 2, '分支还没结束就该读到，否则这条断言没有意义');

  // 断言 2：带的是「合并进当前分支」的说明，而不是「前一个分支已完成」的独立分支说明
  const mergedMessage = requests[mergedRound]!.find((message) =>
    typeof message.content === 'string' && message.content.includes('待办和书签'));
  assert.match(String(mergedMessage!.content), /相关指导/, '合并语义');
  assert.doesNotMatch(String(mergedMessage!.content), /前一个分支已经完成/, '不能当成独立分支');

  // 断言 3：任务树里它已经不再排队
  const node = queue.state().nodes.find((candidate) => candidate.status === 'merged');
  assert.ok(node, '任务树应显示成已合并');
});

test('端到端：判为独立的消息不会被塞进当前分支', async () => {
  const queue = new AgentTaskQueue('给灵动岛加邮箱折叠');
  const requests: ChatRequestMessage[][] = [];
  let round = 0;
  const client = {
    async streamChat(_settings: ChatSettings, messages: ChatRequestMessage[]) {
      requests.push(structuredClone(messages));
      round += 1;
      if (round === 1) {
        queue.enqueue('重做整个设置页的数据层', { role: 'user', content: '重做整个设置页的数据层' }, async () => ({ relation: 'queued' }), () => undefined);
      }
      if (round <= 4) {
        return {
          content: '', reasoning: '', usage: undefined, finishReason: 'tool_calls',
          toolCalls: [{ id: `call_${round}`, type: 'function' as const, function: { name: 'write_file', arguments: '{}' } }],
        };
      }
      return { content: '完成。', reasoning: '', usage: undefined, finishReason: 'stop', toolCalls: [] };
    },
  };
  const tools = {
    definitions: () => [{ type: 'function' as const, function: { name: 'write_file', description: 'w', parameters: {} } }],
    execute: async () => toolResult,
  };
  const runner = new AgentRunner(client as never, tools as never);
  const runPromise = runner.run({
    settings,
    messages: [{ role: 'user', content: '给灵动岛加邮箱折叠' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'conversation-review-2',
    takeTaskUpdate: async (phase) => {
      if (phase === 'replan') {
        await reviewQueuedTasks(queue, {
          classify: async () => 'queued',
          liveContext: () => '',
          onChange: () => undefined,
        });
      }
      return queue.take(phase, () => undefined);
    },
    callbacks: { onDelta: () => undefined, onToolsChanged: () => undefined, requestApproval: async () => true },
  });
  await runPromise;

  const leaked = requests.some((messages) =>
    messages.some((message) => typeof message.content === 'string' && message.content.includes('设置页的数据层')));
  assert.equal(leaked, false, '独立任务不该出现在当前分支的上下文里');
});
