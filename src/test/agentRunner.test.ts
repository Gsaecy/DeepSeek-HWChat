import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRunner } from '../agent/agentRunner';
import { ChatRequestMessage, ChatSettings, ToolExecutionResult } from '../core/types';

const settings: ChatSettings = {
  internetReference: false,
  apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid', models: ['deepseek-chat'], requestHeaders: {} }],
  activeApiProfileId: 'default',
  baseUrl: 'https://example.invalid', model: 'deepseek-chat', temperature: 0, maxTokens: 0,
  systemPrompt: '', sendOnEnter: true, historyRetentionDays: 30, taskCacheRetentionHours: 24,
  cacheBudgetMB: 100, cleanupIntervalMinutes: 10, maxMessagesInContext: 20, requestHeaders: {},
  requestTimeoutSeconds: 30, proxy: '', defaultMode: 'agent', agentMaxSteps: 4, reasoningEffort: 'default', permissionPreset: 'review', fileReadPolicy: 'allow',
  fileWritePolicy: 'ask', commandPolicy: 'ask', dangerousCommandPolicy: 'ask',
  sensitiveFilePolicy: 'deny', maxReadBytes: 512_000, maxToolOutputBytes: 200_000,
  maxCommandSeconds: 120, auditRetentionDays: 30, language: 'auto',
};

test('runs a tool call and feeds its result back before the final answer', async () => {
  const requests: ChatRequestMessage[][] = [];
  let round = 0;
  const client = {
    async streamChat(_settings: ChatSettings, messages: ChatRequestMessage[], options: { onDelta: (delta: { content?: string }) => unknown }) {
      requests.push(structuredClone(messages));
      round += 1;
      if (round === 1) {
        return {
          content: '', reasoning: 'need file', usage: undefined, finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }],
        };
      }
      await options.onDelta({ content: '已读取并完成分析。' });
      return { content: '已读取并完成分析。', reasoning: '', usage: undefined, finishReason: 'stop', toolCalls: [] };
    },
  };
  const toolResult: ToolExecutionResult = {
    status: 'success', summary: '读取 src/a.ts（12 B）', content: 'export const a = 1;', approval: 'not-required',
  };
  const tools = {
    definitions: () => [{ type: 'function' as const, function: { name: 'read_file', description: 'read', parameters: {} } }],
    execute: async () => toolResult,
  };
  const snapshots: number[] = [];
  const runner = new AgentRunner(client as never, tools as never);
  const result = await runner.run({
    settings,
    messages: [{ role: 'user', content: '读取文件' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'conversation-1',
    callbacks: {
      onDelta: () => undefined,
      onToolsChanged: (executions) => { snapshots.push(executions.length); },
      requestApproval: async () => true,
    },
  });

  assert.equal(result.content, '已读取并完成分析。');
  assert.equal(result.tools[0]?.status, 'success');
  assert.ok(snapshots.length >= 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.at(-1)?.role, 'tool');
  assert.match(String(requests[1]?.at(-1)?.content ?? ''), /export const a/);
});

test('does not retain full write-file content in collapsible execution history', async () => {
  let round = 0;
  const secretContent = `export const API_KEY = "sk-${'a'.repeat(24)}";`;
  const client = {
    async streamChat(_settings: ChatSettings, _messages: ChatRequestMessage[], options: { onDelta: (delta: { content?: string }) => unknown }) {
      round += 1;
      if (round === 1) {
        return {
          content: '', reasoning: '', usage: undefined, finishReason: 'tool_calls',
          toolCalls: [{
            id: 'call_write', type: 'function' as const,
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/config.ts', content: secretContent }) },
          }],
        };
      }
      await options.onDelta({ content: '完成。' });
      return { content: '完成。', reasoning: '', usage: undefined, finishReason: 'stop', toolCalls: [] };
    },
  };
  const tools = {
    definitions: () => [{ type: 'function' as const, function: { name: 'write_file', description: 'write', parameters: {} } }],
    execute: async () => ({
      status: 'success', summary: '创建 src/config.ts', content: '文件已写入。', approval: 'approved', changedFiles: ['src/config.ts'],
    } satisfies ToolExecutionResult),
  };
  const runner = new AgentRunner(client as never, tools as never);
  const result = await runner.run({
    settings,
    messages: [{ role: 'user', content: '创建配置' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'conversation-2',
    callbacks: { onDelta: () => undefined, onToolsChanged: () => undefined, requestApproval: async () => true },
  });

  assert.match(result.tools[0]?.input ?? '', /正文未写入历史/);
  assert.doesNotMatch(result.tools[0]?.input ?? '', /export const|sk-/);
});

test('sums token usage across agent tool rounds', async () => {
  let round = 0;
  const client = {
    async streamChat() {
      round += 1;
      if (round === 1) {
        return {
          content: '', reasoning: '', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
          toolCalls: [{ id: 'call_1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a"}' } }],
        };
      }
      return { content: 'done', reasoning: '', usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 }, toolCalls: [] };
    },
  };
  const tools = {
    definitions: () => [],
    execute: async () => ({ status: 'success', summary: 'read', content: 'ok', approval: 'not-required' }),
  };
  const runner = new AgentRunner(client as never, tools as never);
  const result = await runner.run({
    settings, messages: [{ role: 'user', content: 'go' }], mode: 'agent',
    signal: new AbortController().signal, conversationId: 'tokens',
    callbacks: { onDelta: () => undefined, onToolsChanged: () => undefined, requestApproval: async () => true },
  });
  assert.deepEqual(result.usage, { promptTokens: 30, completionTokens: 6, totalTokens: 36 });
});

test('executes a routed skill tool and reports the skill used', async () => {
  let round = 0;
  let normalToolCalls = 0;
  const usedSkills: string[] = [];
  const client = {
    async streamChat(_settings: ChatSettings, messages: ChatRequestMessage[]) {
      round += 1;
      if (round === 1) {
        return {
          content: '', reasoning: '', usage: { totalTokens: 8 },
          toolCalls: [{
            id: 'call_skill', type: 'function' as const,
            function: { name: 'load_skill', arguments: '{"id":"skill-1"}' },
          }],
        };
      }
      assert.equal(messages.at(-1)?.role, 'tool');
      assert.match(String(messages.at(-1)?.content ?? ''), /Skill instructions/);
      return { content: 'done', reasoning: '', usage: { totalTokens: 5 }, toolCalls: [] };
    },
  };
  const tools = {
    definitions: () => [],
    execute: async () => {
      normalToolCalls += 1;
      return { status: 'error', summary: 'unexpected', content: '', approval: 'not-required' } satisfies ToolExecutionResult;
    },
  };
  const runner = new AgentRunner(client as never, tools as never);
  const result = await runner.run({
    settings, messages: [{ role: 'user', content: 'use the skill' }], mode: 'agent',
    signal: new AbortController().signal, conversationId: 'skills',
    extraTools: [{
      type: 'function',
      function: { name: 'load_skill', description: 'load', parameters: { type: 'object' } },
    }],
    executeExtraTool: async (call) => {
      if (call.function.name !== 'load_skill') return undefined;
      return {
        result: {
          status: 'success', summary: '加载 Skill：Test Skill', content: 'Skill instructions', approval: 'not-required',
        },
        skill: { id: 'skill-1', name: 'Test Skill', source: 'copilot', relativePath: '~/.copilot/skills/test/SKILL.md' },
      };
    },
    callbacks: {
      onDelta: () => undefined,
      onToolsChanged: () => undefined,
      onSkillUsed: (skill) => { usedSkills.push(skill.name); },
      requestApproval: async () => true,
    },
  });

  assert.equal(normalToolCalls, 0);
  assert.deepEqual(usedSkills, ['Test Skill']);
  assert.equal(result.tools[0]?.summary, '加载 Skill：Test Skill');
  assert.equal(result.usage?.totalTokens, 13);
});

test('replans after related runtime guidance and skips stale pending tool calls', async () => {
  const requests: ChatRequestMessage[][] = [];
  let round = 0;
  let executed = 0;
  let replanChecks = 0;
  const client = {
    async streamChat(_settings: ChatSettings, messages: ChatRequestMessage[], options: { onDelta: (delta: { content?: string }) => unknown }) {
      requests.push(structuredClone(messages));
      round += 1;
      if (round === 1) {
        return {
          content: '', reasoning: '', toolCalls: [
            { id: 'call_1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
            { id: 'call_2', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"src/a.ts","content":"old plan"}' } },
          ],
        };
      }
      await options.onDelta({ content: '已按新要求重新规划并完成。' });
      return { content: '已按新要求重新规划并完成。', reasoning: '', toolCalls: [] };
    },
  };
  const tools = {
    definitions: () => [],
    execute: async () => {
      executed += 1;
      return { status: 'success', summary: '读取完成', content: 'file', approval: 'not-required' } satisfies ToolExecutionResult;
    },
  };
  const runner = new AgentRunner(client as never, tools as never);
  const result = await runner.run({
    settings,
    messages: [{ role: 'user', content: '先检查并修改文件' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'runtime-guidance',
    takeTaskUpdate: async (phase) => {
      if (phase !== 'replan') return [];
      replanChecks += 1;
      return replanChecks === 2
        ? [{
          nodeId: 'task-update',
          relation: 'related' as const,
          request: { role: 'user' as const, content: '[任务树更新：相关指导]\n不要按旧方案写入，改用新方案。' },
        }]
        : [];
    },
    callbacks: { onDelta: () => undefined, onToolsChanged: () => undefined, requestApproval: async () => true },
  });

  assert.equal(executed, 1);
  assert.equal(result.tools.length, 2);
  assert.equal(result.tools[1]?.status, 'denied');
  assert.match(result.tools[1]?.summary ?? '', /跳过/);
  assert.ok(requests[1]?.some((message) => message.role === 'user' && String(message.content).includes('新方案')));
  assert.match(result.content, /重新规划并完成/);
});

test('0 no longer means unlimited: it falls back to the default finite budget', async () => {
  let round = 0;
  let executed = 0;
  const client = {
    async streamChat(_settings: ChatSettings, _messages: ChatRequestMessage[], options: { onDelta: (delta: { content?: string }) => unknown }) {
      round += 1;
      if (round <= 13) {
        return {
          content: '', reasoning: '',
          toolCalls: [{ id: `call_${round}`, type: 'function' as const, function: { name: 'read_file', arguments: `{"path":"${round}.txt"}` } }],
        };
      }
      await options.onDelta({ content: '完成全部步骤。' });
      return { content: '完成全部步骤。', reasoning: '', toolCalls: [] };
    },
  };
  const tools = {
    definitions: () => [],
    execute: async () => {
      executed += 1;
      return { status: 'success', summary: '读取完成', content: 'ok', approval: 'not-required' } satisfies ToolExecutionResult;
    },
  };
  const runner = new AgentRunner(client as never, tools as never);
  const result = await runner.run({
    settings: { ...settings, agentMaxSteps: 0 },
    messages: [{ role: 'user', content: '完成长任务' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'unlimited',
    callbacks: { onDelta: () => undefined, onToolsChanged: () => undefined, requestApproval: async () => true },
  });

  // 13 轮 < 默认 24 步：照常完成，证明有限预算不会误伤正常任务。
  assert.equal(executed, 13);
  assert.equal(round, 14);
  assert.equal(result.stoppedByStepLimit, false);
  assert.equal(result.stopReason, 'complete');
  assert.match(result.content, /完成全部步骤/);
});

test('puts a paragraph break between each round of narration so long runs stay readable', async () => {
  const streamed: string[] = [];
  let round = 0;
  const client = {
    async streamChat(_settings: ChatSettings, _messages: ChatRequestMessage[], options: { onDelta: (delta: { content?: string }) => unknown }) {
      round += 1;
      if (round <= 2) {
        const narration = round === 1 ? '先读配置文件。' : '再核对权限设置。';
        await options.onDelta({ content: narration });
        return {
          content: narration, reasoning: '', usage: undefined, finishReason: 'tool_calls',
          toolCalls: [{ id: `call_${round}`, type: 'function' as const, function: { name: 'read_file', arguments: `{"path":"src/${round}.ts"}` } }],
        };
      }
      await options.onDelta({ content: '结论如下。' });
      return { content: '结论如下。', reasoning: '', usage: undefined, finishReason: 'stop', toolCalls: [] };
    },
  };
  const tools = {
    definitions: () => [],
    execute: async () => ({ status: 'success', summary: '读取完成', content: 'ok', approval: 'not-required' }) satisfies ToolExecutionResult,
  };
  const runner = new AgentRunner(client as never, tools as never);
  const result = await runner.run({
    settings,
    messages: [{ role: 'user', content: '分析项目' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'narration',
    callbacks: {
      onDelta: (delta) => { if (delta.content) streamed.push(delta.content); },
      onToolsChanged: () => undefined,
      requestApproval: async () => true,
    },
  });

  // 三轮叙述各自独立成段，不会首尾相接挤成一行。
  assert.equal(result.content, '先读配置文件。\n\n再核对权限设置。\n\n结论如下。');
  // 界面流式收到的内容与存档内容完全一致，否则刷新后排版会变。
  assert.equal(streamed.join(''), result.content);
});

test('does not stack extra blank lines when the model already ended with one', async () => {
  let round = 0;
  const client = {
    async streamChat(_settings: ChatSettings, _messages: ChatRequestMessage[], options: { onDelta: (delta: { content?: string }) => unknown }) {
      round += 1;
      if (round === 1) {
        await options.onDelta({ content: '先读配置文件。\n' });
        return {
          content: '先读配置文件。\n', reasoning: '', usage: undefined, finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_a', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }],
        };
      }
      await options.onDelta({ content: '结论如下。' });
      return { content: '结论如下。', reasoning: '', usage: undefined, finishReason: 'stop', toolCalls: [] };
    },
  };
  const tools = {
    definitions: () => [],
    execute: async () => ({ status: 'success', summary: '读取完成', content: 'ok', approval: 'not-required' }) satisfies ToolExecutionResult,
  };
  const runner = new AgentRunner(client as never, tools as never);
  const result = await runner.run({
    settings,
    messages: [{ role: 'user', content: '分析项目' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'narration-existing-break',
    callbacks: { onDelta: () => undefined, onToolsChanged: () => undefined, requestApproval: async () => true },
  });

  assert.equal(result.content, '先读配置文件。\n\n结论如下。');
});

/* ── 运行中途的线索也要能自动回查 ─────────────────────────────────── */

test('工具失败时把自动回查结果并进 tool 结果（不新增对话角色）', async () => {
  const calls: Array<{ name: string; errorText: string }> = [];
  /** 第二轮实际收到的消息：用来断言回查片段确实进了 tool 结果。 */
  let secondRound: ChatRequestMessage[] = [];
  let rounds = 0;
  const client = {
    async streamChat(_settings: ChatSettings, messages: ChatRequestMessage[]) {
      rounds += 1;
      if (rounds === 2) secondRound = structuredClone(messages);
      if (rounds === 1) {
        return {
          content: '', reasoning: '', usage: undefined, finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"x"}' } }],
        };
      }
      return { content: '按旧记录修好了。', reasoning: '', toolCalls: [], usage: undefined, finishReason: 'stop' };
    },
  };
  const tools = {
    definitions: () => [],
    isWorkspaceTrusted: () => true,
    execute: async () => ({
      status: 'error',
      summary: '读文件失败',
      content: 'ENOENT: no such file or directory, open x',
      approval: 'not-required',
    }),
  };
  const runner = new AgentRunner(client as never, tools as never);
  await runner.run({
    settings,
    messages: [{ role: 'user', content: '修一下' }],
    mode: 'agent',
    signal: new AbortController().signal,
    conversationId: 'c1',
    callbacks: {
      onDelta: () => undefined,
      onToolsChanged: () => undefined,
      onTaskUpdate: () => undefined,
    } as never,
    recallForFailure: async (name: string, errorText: string) => {
      calls.push({ name, errorText });
      return '<auto_recall>\n- user: 以前这个文件在 web/assets/x\n</auto_recall>';
    },
  });

  assert.equal(calls.length, 1, '失败时应当回查一次');
  assert.equal(calls[0]!.name, 'read_file');
  assert.match(calls[0]!.errorText, /ENOENT/);
  const toolMessage = secondRound.find((message) => message.role === 'tool');
  assert.ok(toolMessage, '第二轮应当能看到工具结果');
  const content = String(toolMessage.content);
  assert.match(content, /ENOENT/, '原始报错要留着');
  assert.match(content, /<auto_recall>/, '回查片段要并进同一个 tool 结果');
  assert.equal(secondRound.filter((message) => message.role === 'system').length, 0, '不要在运行中途插 system 消息');
});

/* ── 请求体总预算：超预算时从最旧的工具输出开始折（方案 A） ─────────────── */
import { pruneToolPayloads, requestBytes } from '../agent/agentRunner';

function toolMessage(index: number, bytes: number): { role: 'tool'; tool_call_id: string; name: string; content: string } {
  return {
    role: 'tool',
    tool_call_id: `call-${index}`,
    name: 'read_file',
    content: JSON.stringify({
      status: 'success',
      summary: `读取第 ${index} 个文件`,
      result: 'x'.repeat(bytes),
      changedFiles: [`file-${index}.ts`],
    }),
  };
}

test('按条数折：只保留最近 keep 条原文', () => {
  const messages = [0, 1, 2, 3, 4].map((index) => toolMessage(index, 100)) as never[];
  const folded = pruneToolPayloads(messages);
  assert.equal(folded, 2, '5 条保留 3 条 → 折 2 条');
  assert.match(String(messages[0]!.content), /"folded":true/);
  assert.doesNotMatch(String(messages[4]!.content), /"folded":true/);
});

test('超预算时从最旧的继续折，直到装得下', () => {
  // 5 条 × 20KB；按条数只折 2 条仍剩 60KB，预算 30KB 时必须继续折。
  const messages = [0, 1, 2, 3, 4].map((index) => toolMessage(index, 20_000)) as never[];
  const budget = 30_000;
  assert.ok(requestBytes(messages) > budget, '构造的请求体必须一开始就超预算');
  pruneToolPayloads(messages, 3, budget);
  assert.ok(requestBytes(messages) <= budget, `折完必须装得下，实际 ${requestBytes(messages)}`);
  // 最新那条永远保留原文：它是模型下一步要用的。
  assert.doesNotMatch(String(messages[4]!.content), /"folded":true/, '最新一条不能被折');
});

test('已经装得下时一条都不多折', () => {
  const messages = [0, 1, 2, 3].map((index) => toolMessage(index, 100)) as never[];
  const before = requestBytes(messages);
  pruneToolPayloads(messages, 4, before);
  assert.equal(requestBytes(messages), before, '预算够时不该动任何东西');
});

test('折叠保留结论与改动文件（不丢可用的信息）', () => {
  const messages = [toolMessage(0, 500), toolMessage(1, 500), toolMessage(2, 500), toolMessage(3, 500)] as never[];
  pruneToolPayloads(messages, 1);
  const first = JSON.parse(String(messages[0]!.content)) as Record<string, unknown>;
  assert.equal(first.changedFiles?.[0] ?? (first.changedFiles as string[])[0], 'file-0.ts');
  assert.match(String(first.summary), /读取第 0 个文件/);
  assert.equal(first.folded, true);
});
