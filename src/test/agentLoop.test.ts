import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentRunner,
  MAX_IDENTICAL_TOOL_CALLS,
  MAX_TOOL_CALLS_PER_ROUND,
  ToolLoopGuard,
} from '../agent/agentRunner';
import { OperationCancelledError } from '../agent/transientErrors';
import { AGENT_STEP_SAFETY_CAP, DEFAULT_AGENT_MAX_STEPS } from '../core/agentLimits';
import { ChatRequestMessage, ChatSettings, ToolExecutionResult } from '../core/types';

/**
 * Agent 循环保护的回归测试。
 *
 * 现场：`agentMaxSteps` 的旧语义是「0 = 不限制」，而会话存档里可以长期保留 0。
 * 于是一个卡住的模型循环能一直请求、一直调工具，把 CPU 与进程表一起打满。
 * 这里逐条锁住：默认有限、绝对值有上限、重复调用会被拦、取消后不再发起调用。
 */

const baseSettings: ChatSettings = {
  apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid', models: ['deepseek-chat'], requestHeaders: {} }],
  activeApiProfileId: 'default',
  baseUrl: 'https://example.invalid', model: 'deepseek-chat', temperature: 0, maxTokens: 0,
  systemPrompt: '', sendOnEnter: true, historyRetentionDays: 30, taskCacheRetentionHours: 24,
  cacheBudgetMB: 100, cleanupIntervalMinutes: 10, maxMessagesInContext: 20, requestHeaders: {},
  requestTimeoutSeconds: 30, defaultMode: 'agent', agentMaxSteps: 4, reasoningEffort: 'default',
  permissionPreset: 'review', fileReadPolicy: 'allow', fileWritePolicy: 'ask', commandPolicy: 'ask',
  dangerousCommandPolicy: 'ask', sensitiveFilePolicy: 'deny', maxReadBytes: 512_000,
  maxToolOutputBytes: 200_000, maxCommandSeconds: 120, auditRetentionDays: 30, language: 'auto',
};

function endlessClient(callFor: (round: number) => { name: string; args: string }) {
  let round = 0;
  return {
    get rounds() {
      return round;
    },
    async streamChat() {
      round += 1;
      const call = callFor(round);
      return {
        content: '',
        reasoning: '',
        toolCalls: [{ id: `call_${round}`, type: 'function' as const, function: { name: call.name, arguments: call.args } }],
      };
    },
  };
}

function countingTools() {
  const calls: string[] = [];
  return {
    calls,
    definitions: () => [],
    async execute(call: { function: { name: string; arguments: string } }): Promise<ToolExecutionResult> {
      calls.push(call.function.arguments);
      return { status: 'success', summary: 'ok', content: 'ok', approval: 'not-required' };
    },
  };
}

async function runAgent(options: {
  client: unknown;
  tools: unknown;
  steps: number;
  signal?: AbortSignal;
  messages?: ChatRequestMessage[];
}) {
  const runner = new AgentRunner(options.client as never, options.tools as never);
  return runner.run({
    settings: { ...baseSettings, agentMaxSteps: options.steps },
    messages: options.messages ?? [{ role: 'user', content: 'go' }],
    mode: 'agent',
    signal: options.signal ?? new AbortController().signal,
    conversationId: 'loop-test',
    callbacks: { onDelta: () => undefined, onToolsChanged: () => undefined, requestApproval: async () => true },
  });
}

test('agent loop: a finite step budget stops an endless tool loop and keeps the results', async () => {
  const client = endlessClient((round) => ({ name: 'read_file', args: `{"path":"${round}.txt"}` }));
  const tools = countingTools();

  const result = await runAgent({ client, tools, steps: 3 });

  assert.equal(tools.calls.length, 3);
  assert.equal(client.rounds, 3);
  assert.equal(result.stoppedByStepLimit, true);
  assert.equal(result.stopReason, 'stepLimit');
  assert.equal(result.tools.length, 3, '已执行的步骤必须保留下来，供用户接着看/接着做');
  assert.match(result.content, /3 步执行上限|3-step limit/);
  assert.match(result.content, /继续|continue/);
});

test('agent loop: agentMaxSteps = 0 is "unlimited" and keeps going past the default budget', async () => {
  const client = endlessClient((round) => ({ name: 'read_file', args: `{"path":"${round}.txt"}` }));
  const tools = countingTools();

  // 「无限制」= 循环只在模型不再调用工具时结束。这里让它跑 30 轮（> 默认 24）后停下。
  let rounds = 0;
  const stoppingClient = {
    async streamChat() {
      rounds += 1;
      if (rounds > 30) return { content: 'done', reasoning: '', toolCalls: [] };
      return {
        content: '',
        reasoning: '',
        toolCalls: [{ id: `call_${rounds}`, type: 'function' as const, function: { name: 'read_file', arguments: `{"path":"${rounds}.txt"}` } }],
      };
    },
  };

  const result = await runAgent({ client: stoppingClient, tools, steps: 0 });

  assert.equal(tools.calls.length, 30, '无限制不能被默认 24 步截断');
  assert.equal(result.stoppedByStepLimit, false);
  assert.equal(result.stopReason, 'complete');
});

test('agent loop: a dirty step value still falls back to the default budget', async () => {
  const client = endlessClient((round) => ({ name: 'read_file', args: `{"path":"${round}.txt"}` }));
  const tools = countingTools();

  // -1 不是「无限制」（0 才是），负数按脏值处理，回落到默认预算。
  const result = await runAgent({ client, tools, steps: -1 });

  assert.equal(tools.calls.length, DEFAULT_AGENT_MAX_STEPS);
  assert.equal(result.stoppedByStepLimit, true);
});

test('agent loop: an oversized value from an old conversation cannot pass the absolute cap', async () => {
  const client = endlessClient((round) => ({ name: 'read_file', args: `{"path":"${round}.txt"}` }));
  const tools = countingTools();

  const result = await runAgent({ client, tools, steps: 10_000 });

  assert.equal(tools.calls.length, AGENT_STEP_SAFETY_CAP);
  assert.equal(result.stoppedByStepLimit, true);
});

test('agent loop: the same tool call three times in a row is blocked before it runs', async () => {
  const client = endlessClient(() => ({ name: 'search_files', args: '{"query":"TODO"}' }));
  const tools = countingTools();

  const result = await runAgent({ client, tools, steps: 50 });

  assert.equal(tools.calls.length, MAX_IDENTICAL_TOOL_CALLS - 1, '第三次相同调用必须被拦下，不再真正执行');
  assert.equal(result.stopReason, 'loopDetected');
  assert.equal(result.stoppedByStepLimit, false);
  assert.equal(result.tools.length, MAX_IDENTICAL_TOOL_CALLS, '被拦下的那一步也要出现在步骤列表里');
  assert.equal(result.tools.at(-1)?.status, 'denied');
  assert.match(result.content, new RegExp(`${MAX_IDENTICAL_TOOL_CALLS} 次完全相同|${MAX_IDENTICAL_TOOL_CALLS} identical`));
});

test('agent loop: a run that keeps making progress is not affected by the loop guard', async () => {
  const client = endlessClient((round) => (round % 2 === 0
    ? { name: 'read_file', args: `{"path":"a${round}.txt"}` }
    : { name: 'read_file', args: `{"path":"b${round}.txt"}` }));
  const tools = countingTools();

  const result = await runAgent({ client, tools, steps: 8 });

  assert.equal(result.stopReason, 'stepLimit');
  assert.equal(tools.calls.length, 8);
});

test('agent loop: cancelling stops any further tool call in the same round', async () => {
  const controller = new AbortController();
  let round = 0;
  const client = {
    async streamChat() {
      round += 1;
      return {
        content: '',
        reasoning: '',
        toolCalls: [1, 2, 3].map((index) => ({
          id: `r${round}_${index}`,
          type: 'function' as const,
          function: { name: 'read_file', arguments: `{"path":"${index}.txt"}` },
        })),
      };
    },
  };
  let executed = 0;
  const tools = {
    definitions: () => [],
    async execute(): Promise<ToolExecutionResult> {
      executed += 1;
      controller.abort();
      return { status: 'success', summary: 'ok', content: 'ok', approval: 'not-required' };
    },
  };

  await assert.rejects(runAgent({ client, tools, steps: 20, signal: controller.signal }), OperationCancelledError);
  assert.equal(executed, 1, '取消后同一轮里剩下的工具调用一个都不能再执行');
  assert.equal(round, 1);
});

test('agent loop: too many calls in one round are summarised instead of all executed', async () => {
  let round = 0;
  const client = {
    async streamChat() {
      round += 1;
      if (round > 1) return { content: 'done', reasoning: '', toolCalls: [] };
      return {
        content: '',
        reasoning: '',
        toolCalls: Array.from({ length: MAX_TOOL_CALLS_PER_ROUND + 3 }, (_, index) => ({
          id: `many_${index}`,
          type: 'function' as const,
          function: { name: 'read_file', arguments: `{"path":"${index}.txt"}` },
        })),
      };
    },
  };
  const tools = countingTools();

  const result = await runAgent({ client, tools, steps: 10 });

  assert.equal(tools.calls.length, MAX_TOOL_CALLS_PER_ROUND);
  assert.equal(result.stopReason, 'toolBudget');
  const skipped = result.tools.filter((item) => item.status === 'denied');
  assert.equal(skipped.length, 3, '超出的调用必须有对应的 tool 结果，否则历史消息序列非法');
});

test('agent loop: consecutive failing rounds stop the automatic retry', async () => {
  const client = endlessClient((round) => ({ name: 'read_file', args: `{"path":"${round}.txt"}` }));
  const tools = {
    definitions: () => [],
    async execute(): Promise<ToolExecutionResult> {
      return { status: 'error', summary: 'failed', content: 'ENOENT', approval: 'not-required' };
    },
  };

  const result = await runAgent({ client, tools, steps: 50 });

  assert.equal(result.stopReason, 'noProgress');
  assert.equal(client.rounds, 3);
  assert.match(result.content, /全部失败|all failed/);
});

test('loop guard: argument key order does not hide a duplicate call', () => {
  const guard = new ToolLoopGuard();
  const first = guard.observe({ id: '1', type: 'function', function: { name: 'search_files', arguments: '{"query":"a","glob":"b"}' } });
  const second = guard.observe({ id: '2', type: 'function', function: { name: 'search_files', arguments: '{"glob":"b","query":"a"}' } });
  const third = guard.observe({ id: '3', type: 'function', function: { name: 'search_files', arguments: '{"query":"a","glob":"b"}' } });
  assert.equal(first.blocked, false);
  assert.equal(second.count, 2);
  assert.equal(third.blocked, true);
});

test('agent loop: a stall hint updates the view only and never counts as a state change', async () => {
  // 命令卡住时每 10 秒刷一次「无输出 N 秒」。旧实现把它当成工具状态变化，
  // 走的是 `onToolsChanged`——调用方每次都要落盘整条消息并让首页缓存失效
  // （实测 2.29ms + 2ms，一条卡几分钟的命令白写十几次盘）。
  // 现在走 `onToolHint`：只推界面。这条用例锁死「提示永远不冒充状态变化」。
  const client = endlessClient(() => ({ name: 'run_command', args: '{"command":"npm test"}' }));
  const stateChanges: Array<Array<{ stallHint?: string }>> = [];
  const hints: string[] = [];
  const tools = {
    definitions: () => [],
    async execute(
      _call: unknown,
      _mode: unknown,
      _settings: unknown,
      _approve: unknown,
      _conversationId: unknown,
      scope: { onCommandProgress?: (progress: { phase: string; idleSeconds: number; timeoutSeconds: number }) => void },
    ): Promise<ToolExecutionResult> {
      scope.onCommandProgress?.({ phase: 'stall', idleSeconds: 30, timeoutSeconds: 120 });
      scope.onCommandProgress?.({ phase: 'stall', idleSeconds: 40, timeoutSeconds: 120 });
      scope.onCommandProgress?.({ phase: 'timeout', idleSeconds: 50, timeoutSeconds: 120 });
      return { status: 'success', summary: 'ok', content: 'ok', approval: 'not-required' };
    },
  };

  const runner = new AgentRunner(client as never, tools as never);
  await runner.run({
    settings: { ...baseSettings, agentMaxSteps: 3 },
    messages: [{ role: 'user', content: 'go' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'hint-test',
    callbacks: {
      onDelta: () => undefined,
      onToolsChanged: (snapshot) => { stateChanges.push(snapshot); },
      onToolHint: (snapshot) => { hints.push(snapshot.at(-1)?.stallHint ?? ''); },
      requestApproval: async () => true,
    },
  });

  assert.ok(hints.length > 0 && hints.length % 3 === 0, `每次工具调用应产生 3 次提示，实际 ${hints.length}`);
  assert.match(hints[0] ?? '', /30|无输出/);
  // 关键不变量：走落盘通道的快照里**永远不能出现**只在界面上停留的停滞提示。
  // 只要它出现了，恢复后的历史里就会留着「无输出 30 秒」这种早已过期的文字。
  const leaked = stateChanges.flat().filter((tool) => tool.stallHint !== undefined);
  assert.deepEqual(leaked, [], '停滞提示绝不能进入落盘通道');
  assert.ok(stateChanges.length <= hints.length, `状态变化次数(${stateChanges.length})不应随提示次数增长`);
});
