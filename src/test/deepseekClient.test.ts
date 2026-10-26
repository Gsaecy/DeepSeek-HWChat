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
  reasoningEffort: 'default',
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

test('discovers model ids while preserving provider display names', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: {
      models: [
        { id: 'deepseek-flash', display_name: 'DeepSeek V4.1 Flash' },
        { model: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'deepseek-flash', name: 'duplicate fallback' },
      ],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

  try {
    const client = new DeepSeekClient(async () => 'test-key');
    const models = await client.listModels(settings);
    assert.deepEqual(models, [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoningSupport: 'unknown' },
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', reasoningSupport: 'unknown' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('filters retired models and exposes provider reasoning capabilities', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [
      { id: 'retired-model', status: 'retired' },
      { id: 'disabled-model', available: false },
      { id: 'fixed-thinker', supports_reasoning: true, reasoning_efforts: ['high'] },
      { id: 'flex-thinker', supports_thinking: true, supported_reasoning_efforts: ['low', 'high', 'max'] },
      { id: 'plain-model', supports_reasoning: false },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

  try {
    const client = new DeepSeekClient(async () => 'test-key');
    const models = await client.listModels(settings);
    assert.deepEqual(models, [
      { id: 'fixed-thinker', name: 'fixed-thinker', reasoningSupport: 'fixed', reasoningEfforts: ['high'] },
      { id: 'flex-thinker', name: 'flex-thinker', reasoningSupport: 'configurable', reasoningEfforts: ['low', 'high', 'max'] },
      { id: 'plain-model', name: 'plain-model', reasoningSupport: 'unsupported' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('retries without an unsupported reasoning control', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'Unknown parameter: reasoning_effort' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  try {
    const client = new DeepSeekClient(async () => 'test-key');
    const result = await client.streamChat({
      ...settings,
      baseUrl: 'https://api.deepseek.com',
      reasoningEffort: 'high',
    }, [{ role: 'user', content: 'hello' }], { onDelta: () => undefined });
    assert.equal(result.content, 'ok');
    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies[0]?.thinking, { type: 'enabled' });
    assert.equal(requestBodies[0]?.reasoning_effort, 'high');
    assert.deepEqual(requestBodies[1]?.thinking, { type: 'enabled' });
    assert.equal('reasoning_effort' in requestBodies[1]!, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
