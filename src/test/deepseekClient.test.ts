import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSettings } from '../core/types';
import { buildEndpoint, DeepSeekClient } from '../providers/deepseekClient';

const settings: ChatSettings = {
  apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid/v1', models: ['deepseek-chat'], requestHeaders: {} }],
  activeApiProfileId: 'default',
  baseUrl: 'https://example.invalid/v1',
  model: 'deepseek-chat',
  temperature: 0,
  maxTokens: 0,
  systemPrompt: '',
  sendOnEnter: true,
  historyRetentionDays: 30,
  taskCacheRetentionHours: 24,
  cacheBudgetMB: 100,
  cleanupIntervalMinutes: 10,
  maxMessagesInContext: 20,
  requestHeaders: {},
  requestTimeoutSeconds: 30,
  defaultMode: 'agent',
  agentMaxSteps: 12,
  permissionPreset: 'review',
  fileReadPolicy: 'allow',
  fileWritePolicy: 'ask',
  commandPolicy: 'ask',
  allowSensitiveFiles: false,
  allowDangerousCommands: false,
  maxReadBytes: 512_000,
  maxToolOutputBytes: 200_000,
  maxCommandSeconds: 120,
  auditRetentionDays: 30,
};

test('streams and assembles fragmented native tool calls', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const encoder = new TextEncoder();
    const frames = [
      'data: {"choices":[{"delta":{"reasoning_content":"inspect "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_","arguments":"{\\"path\\":\\"src/"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"main.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    return new Response(new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  try {
    const client = new DeepSeekClient(async () => 'test-key');
    const result = await client.streamChat(settings, [{ role: 'user', content: 'inspect' }], {
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }],
      onDelta: () => undefined,
    });
    assert.equal(result.reasoning, 'inspect ');
    assert.deepEqual(result.toolCalls, [{
      id: 'call_1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"src/main.ts"}' },
    }]);
    assert.equal(requestBody?.tool_choice, 'auto');
    assert.equal(Array.isArray(requestBody?.tools), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects plaintext remote endpoints but permits localhost development', () => {
  assert.throws(() => buildEndpoint('http://api.example.com/v1'), /必须使用 HTTPS/);
  assert.equal(buildEndpoint('http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions');
});

test('derives total token usage when a compatible API omits total_tokens', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  try {
    const client = new DeepSeekClient(async () => 'test-key');
    const result = await client.streamChat(settings, [{ role: 'user', content: 'hello' }], { onDelta: () => undefined });
    assert.deepEqual(result.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
