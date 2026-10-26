import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRunner } from '../agent/agentRunner';
import { ChatRequestMessage, ChatSettings, ToolExecutionResult } from '../core/types';

const settings: ChatSettings = {
  apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid', models: ['deepseek-chat'], requestHeaders: {} }],
  activeApiProfileId: 'default',
  baseUrl: 'https://example.invalid', model: 'deepseek-chat', temperature: 0, maxTokens: 0,
  systemPrompt: '', sendOnEnter: true, historyRetentionDays: 30, taskCacheRetentionHours: 24,
  cacheBudgetMB: 100, cleanupIntervalMinutes: 10, maxMessagesInContext: 20, requestHeaders: {},
  requestTimeoutSeconds: 30, defaultMode: 'agent', agentMaxSteps: 4, reasoningEffort: 'default', permissionPreset: 'review', fileReadPolicy: 'allow',
  fileWritePolicy: 'ask', commandPolicy: 'ask', allowSensitiveFiles: false,
  allowDangerousCommands: false, maxReadBytes: 512_000, maxToolOutputBytes: 200_000,
  maxCommandSeconds: 120, auditRetentionDays: 30,
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

test('allows more than twelve agent rounds when the step limit is unlimited', async () => {
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

  assert.equal(executed, 13);
  assert.equal(round, 14);
  assert.equal(result.stoppedByStepLimit, false);
  assert.match(result.content, /完成全部步骤/);
});
