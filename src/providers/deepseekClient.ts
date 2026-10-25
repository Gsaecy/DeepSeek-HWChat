import {
  ChatRequestMessage,
  ChatSettings,
  StreamDelta,
  ToolCall,
  ToolDefinition,
  UsageInfo,
} from '../core/types';

export interface StreamChatOptions {
  signal?: AbortSignal;
  apiKey?: string;
  onDelta: (delta: StreamDelta) => void | Promise<void>;
  tools?: ToolDefinition[];
}

export interface StreamChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage?: UsageInfo;
  finishReason?: string;
}

export interface ListModelsOptions {
  signal?: AbortSignal;
  apiKey?: string;
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

interface OpenAIErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

export class DeepSeekClient {
  constructor(private readonly getApiKey: (profileId: string) => Thenable<string | undefined> | Promise<string | undefined>) {}

  async streamChat(
    settings: ChatSettings,
    messages: ChatRequestMessage[],
    options: StreamChatOptions,
  ): Promise<StreamChatResult> {
    const apiKey = options.apiKey?.trim() || await this.getApiKey(settings.activeApiProfileId);
    if (!apiKey?.trim()) {
      throw new Error('尚未配置 API Key。请打开设置完成配置。');
    }

    const endpoint = buildEndpoint(settings.baseUrl);
    const body: Record<string, unknown> = {
      model: settings.model,
      messages,
      temperature: settings.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (settings.maxTokens > 0) {
      body.max_tokens = settings.maxTokens;
    }
    if (settings.reasoningEffort !== 'default') {
      const isDeepSeek = new URL(endpoint).hostname === 'api.deepseek.com';
      if (isDeepSeek) {
        body.thinking = { type: settings.reasoningEffort === 'none' ? 'disabled' : 'enabled' };
        if (settings.reasoningEffort !== 'none') body.reasoning_effort = settings.reasoningEffort;
      } else {
        body.reasoning_effort = settings.reasoningEffort === 'max' ? 'high' : settings.reasoningEffort;
      }
    }
    if (options.tools?.length) {
      body.tools = options.tools;
      body.tool_choice = 'auto';
    }

    const headers = new Headers({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...sanitizeHeaders(settings.requestHeaders),
    });
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), settings.requestTimeoutSeconds * 1000);
    const signal = mergeAbortSignals(options.signal, timeout.signal);

    let response: Response;
    while (true) {
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (isAbortError(error) && options.signal?.aborted) {
          throw new RequestCancelledError();
        }
        if (isAbortError(error)) {
          throw new Error(`请求超时（${settings.requestTimeoutSeconds} 秒）。`);
        }
        throw new Error(`无法连接到接口：${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok) break;
      const detail = await readError(response, apiKey);
      if (response.status === 400 && removeRejectedReasoningControl(body, detail)) continue;
      clearTimeout(timer);
      throw new Error(`接口请求失败（${response.status}）：${detail}`);
    }
    if (!response.body) {
      clearTimeout(timer);
      throw new Error('接口没有返回可读取的数据流。');
    }

    try {
      return await parseSse(response.body, options.onDelta, signal);
    } catch (error) {
      if (options.signal?.aborted) {
        throw new RequestCancelledError();
      }
      if (timeout.signal.aborted || isAbortError(error)) {
        throw new Error(`请求超时（${settings.requestTimeoutSeconds} 秒）。`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(settings: ChatSettings, options: ListModelsOptions = {}): Promise<string[]> {
    const apiKey = options.apiKey?.trim() || await this.getApiKey(settings.activeApiProfileId);
    if (!apiKey?.trim()) {
      throw new Error('尚未配置 API Key，无法获取模型列表。');
    }
    const endpoint = buildModelsEndpoint(settings.baseUrl);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), settings.requestTimeoutSeconds * 1000);
    const signal = mergeAbortSignals(options.signal, timeout.signal);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers: new Headers({
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...sanitizeHeaders(settings.requestHeaders),
        }),
        signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (isAbortError(error) && options.signal?.aborted) throw new RequestCancelledError();
      if (isAbortError(error)) throw new Error(`获取模型列表超时（${settings.requestTimeoutSeconds} 秒）。`);
      throw new Error(`无法获取模型列表：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (!response.ok) {
        throw new Error(`获取模型列表失败（${response.status}）：${await readError(response, apiKey)}`);
      }
      const payload = await response.json() as unknown;
      const models = parseModelIds(payload);
      if (!models.length) {
        throw new Error('接口返回成功，但没有发现可用模型。');
      }
      return models;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class RequestCancelledError extends Error {
  constructor() {
    super('请求已停止。');
    this.name = 'RequestCancelledError';
  }
}

export function buildEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return 'https://api.deepseek.com/chat/completions';
  }
  const endpoint = normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
  const url = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('为保护 API Key，远程模型接口必须使用 HTTPS；本机 localhost 可使用 HTTP。');
  }
  return endpoint;
}

export function buildModelsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
  const url = new URL(normalized);
  assertSecureUrl(url);
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) {
    url.pathname = `${path.slice(0, -'/chat/completions'.length)}/models`;
  } else if (path.endsWith('/responses')) {
    url.pathname = `${path.slice(0, -'/responses'.length)}/models`;
  } else {
    url.pathname = `${path}/models`;
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function assertSecureUrl(url: URL): void {
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('为保护 API Key，远程模型接口必须使用 HTTPS；本机 localhost 可使用 HTTP。');
  }
}

function parseModelIds(payload: unknown): string[] {
  const object = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(object?.data)
      ? object.data
      : Array.isArray(object?.models)
        ? object.models
        : [];
  const ids = candidates
    .map((candidate) => {
      if (typeof candidate === 'string') return candidate;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return '';
      const item = candidate as Record<string, unknown>;
      return [item.id, item.name, item.model].find((value): value is string => typeof value === 'string') ?? '';
    })
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right)).slice(0, 500);
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!key || key.toLowerCase() === 'authorization' || typeof value !== 'string') {
      continue;
    }
    result[key] = value;
  }
  return result;
}

async function readError(response: Response, apiKey: string): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) {
    return response.statusText || '未知错误';
  }
  try {
    const payload = JSON.parse(text) as OpenAIErrorResponse;
    return redactSecret(payload.error?.message ?? text.slice(0, 500), apiKey);
  } catch {
    return redactSecret(text.replace(/\s+/g, ' ').trim().slice(0, 500), apiKey);
  }
}

function redactSecret(value: string, secret: string): string {
  const redacted = secret ? value.split(secret).join('[REDACTED]') : value;
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]');
}

function removeRejectedReasoningControl(body: Record<string, unknown>, detail: string): boolean {
  const normalized = detail.toLocaleLowerCase();
  const mentionsThinking = normalized.includes('thinking');
  const mentionsEffort = normalized.includes('reasoning_effort') || normalized.includes('reasoning effort');
  if ('reasoning_effort' in body && (mentionsEffort || !mentionsThinking)) {
    delete body.reasoning_effort;
    return true;
  }
  if ('thinking' in body && (mentionsThinking || !('reasoning_effort' in body))) {
    delete body.thinking;
    return true;
  }
  return false;
}

async function parseSse(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: StreamDelta) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<StreamChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const result: StreamChatResult = { content: '', reasoning: '', toolCalls: [] };
  try {
    while (true) {
      if (signal?.aborted) {
        throw new RequestCancelledError();
      }
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (await consumeFrame(frame, onDelta, result)) {
          return result;
        }
      }
      if (done) {
        if (buffer.trim()) {
          await consumeFrame(buffer, onDelta, result);
        }
        return result;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function consumeFrame(
  frame: string,
  onDelta: (delta: StreamDelta) => void | Promise<void>,
  result: StreamChatResult,
): Promise<boolean> {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data) {
    return false;
  }
  if (data === '[DONE]') {
    return true;
  }
  let payload: OpenAIChunk;
  try {
    payload = JSON.parse(data) as OpenAIChunk;
  } catch {
    return false;
  }
  const choice = payload.choices?.[0]?.delta;
  const usage = normalizeUsage(payload.usage);
  const toolCalls = mergeToolCallDeltas(result.toolCalls, choice?.tool_calls);
  const delta: StreamDelta = {
    content: choice?.content ?? undefined,
    reasoning: choice?.reasoning_content ?? choice?.reasoning ?? undefined,
    usage,
    toolCalls,
  };
  result.content += delta.content ?? '';
  result.reasoning += delta.reasoning ?? '';
  result.usage = delta.usage ?? result.usage;
  result.finishReason = payload.choices?.[0]?.finish_reason ?? result.finishReason;
  if (delta.content || delta.reasoning || delta.usage || delta.toolCalls?.length) {
    await onDelta(delta);
  }
  return false;
}

function mergeToolCallDeltas(
  target: ToolCall[],
  deltas: NonNullable<NonNullable<OpenAIChunk['choices']>[number]['delta']>['tool_calls'],
): ToolCall[] | undefined {
  if (!deltas?.length) {
    return undefined;
  }
  const changed: ToolCall[] = [];
  for (const delta of deltas) {
    const index = Math.max(0, delta.index);
    const current = target[index] ?? {
      id: delta.id ?? `tool_${index}`,
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.function.name += delta.function.name;
    if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
    target[index] = current;
    changed.push({
      ...current,
      function: { ...current.function },
    });
  }
  return changed;
}

function normalizeUsage(usage: OpenAIChunk['usage']): UsageInfo | undefined {
  if (!usage) {
    return undefined;
  }
  const totalTokens = usage.total_tokens
    ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) || undefined);
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens,
  };
}

function mergeAbortSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (!first) {
    return second;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) {
    controller.abort();
  } else {
    first.addEventListener('abort', abort, { once: true });
    second.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'RequestCancelledError');
}
