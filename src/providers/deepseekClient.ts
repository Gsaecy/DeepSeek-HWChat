import {
  ChatRequestMessage,
  ChatSettings,
  ReasoningEffort,
  StreamDelta,
  ToolCall,
  ToolDefinition,
  UsageInfo,
} from '../core/types';
import { tt } from '../core/i18n';
import { fetchWithNetworkRetry, type RetryEvent } from './netDiagnostics';
import { fetchViaProxy, type ResponseLike } from './proxyFetch';

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

export interface GenerateImageOptions {
  prompt: string;
  /** 例如 1024x1024。服务端不认识时会在校验阶段被丢掉（见 ALLOWED_IMAGE_SIZES）。 */
  size?: string;
  /** 覆盖配置档里的出图模型（一般不用给）。 */
  model?: string;
  signal?: AbortSignal;
  apiKey?: string;
}

export interface GeneratedImage {
  dataBase64: string;
  mimeType: string;
  /** 实际使用的模型名，写进工具结果让用户知道花了哪个模型的钱。 */
  model: string;
}

export interface ListModelsOptions {
  signal?: AbortSignal;
  apiKey?: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  reasoningSupport?: 'unsupported' | 'fixed' | 'configurable' | 'unknown';
  reasoningEfforts?: ReasoningEffort[];
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
  constructor(
    private readonly getApiKey: (profileId: string) => Thenable<string | undefined> | Promise<string | undefined>,
    /**
     * 网络事件日志口（写 HWChat 输出面板）。
     *
     * 以前连接失败在日志里没有留下任何痕迹 —— 用户报「fetch failed」时，面板里只有
     * 权限预设与清理记录，完全看不出是 DNS、代理还是证书。现在每次重试与最终失败
     * 都会记一行（只有主机名与错误码，不含请求正文与凭据）。
     */
    private readonly logNetwork: (line: string) => void = () => undefined,
  ) {}

  /**
   * 按设置挑选传输方式：配了代理就走 CONNECT 隧道，否则直连。
   *
   * 为什么必须自己实现代理：Node 的 `fetch` 读不到 `HTTPS_PROXY`，VS Code 的
   * `http.proxy` 也不覆盖扩展（官方文档明确写了 extensions 暂时不享受代理支持）。
   * 详见 providers/proxyFetch.ts 顶部。
   */
  private transport(settings: ChatSettings): (input: string, init: RequestInit) => Promise<ResponseLike> {
    const proxy = settings.proxy?.trim();
    if (!proxy) {
      return ((input: string, init: RequestInit) => fetch(input, init)) as (input: string, init: RequestInit) => Promise<ResponseLike>;
    }
    return (input: string, init: RequestInit) => fetchViaProxy(input, {
      method: init.method,
      headers: init.headers instanceof Headers ? init.headers : undefined,
      body: typeof init.body === 'string' ? init.body : undefined,
      signal: init.signal ?? undefined,
    }, proxy, settings.requestTimeoutSeconds * 1000);
  }

  /** 把一次重试写进输出面板（主机名 + 错误码 + 等待时长，不含正文与凭据）。 */
  private reportRetry(endpoint: string, event: RetryEvent): void {
    const host = (() => {
      try { return new URL(endpoint).hostname; } catch { return endpoint; }
    })();
    this.logNetwork(
      `[net] ${host} 第 ${event.attempt}/${event.maxAttempts} 次失败（${event.stage}/${event.code}），`
      + `${event.waitMs}ms 后重试：${event.detail.replace(/\n/g, ' / ')}`,
    );
  }

  /** 服务端过载导致的重试也写一行，和网络错误的重试分开标注。 */
  private reportStatusRetry(endpoint: string, status: number, attempt: number, waitMs: number, detail: string): void {
    const host = (() => {
      try { return new URL(endpoint).hostname; } catch { return endpoint; }
    })();
    this.logNetwork(
      `[net] ${host} 第 ${attempt}/${TRANSIENT_STATUS_ATTEMPTS - 1} 次重试（http/${status}），`
      + `${waitMs}ms 后再发：${detail.replace(/\n/g, ' / ').slice(0, 160)}`,
    );
  }

  /** 最终失败也记一行，方便事后对时间线。 */
  private logFailure(endpoint: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logNetwork(`[net] 请求失败 ${endpoint.split('?')[0]}｜${message.replace(/\n/g, ' / ')}`);
  }

  async streamChat(
    settings: ChatSettings,
    messages: ChatRequestMessage[],
    options: StreamChatOptions,
  ): Promise<StreamChatResult> {
    const apiKey = options.apiKey?.trim() || await this.getApiKey(settings.activeApiProfileId);
    if (!apiKey?.trim()) {
      throw new Error(tt('api.noKey'));
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
        /*
         * 按 DeepSeek 官方 Chat Completions 文档：
         * - `thinking.type` 是思考模式的开关（enabled / disabled，默认 enabled）；
         * - `reasoning_effort` 取 `none | low | high | max`，同时明确接受
         *   `minimal`（→ low）与 `medium` / `xhigh`（→ high）作为兼容值。
         * 所以四档（低/中/高/最大）原样发出去即可，服务端自己折算，
         * 这里**不要**再私自把 medium 折成 high 或把 max 折成 high。
         */
        body.thinking = { type: settings.reasoningEffort === 'none' ? 'disabled' : 'enabled' };
        body.reasoning_effort = settings.reasoningEffort;
      } else {
        // OpenAI 兼容接口的 reasoning_effort 通常只有 minimal/low/medium/high，
        // 没有 max 这一档：把「最大」折成它的最高档 high，其余原样透传。
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
    const idleMs = Math.max(1, settings.requestTimeoutSeconds) * 1000;
    const timeoutMessage = tt('api.timeout', { seconds: settings.requestTimeoutSeconds });

    /*
     * 每次尝试都用**新的** AbortController：一旦某次超时把它 abort 了，这条控制器
     * 的 signal 就永久是 aborted，重试会立刻又抛一次超时。用户取消的那一路始终合并进来。
     */
    const newAttempt = (): { signal: AbortSignal; abort: () => void } => {
      const controller = new AbortController();
      return { signal: mergeAbortSignals(options.signal, controller.signal), abort: () => controller.abort() };
    };

    let response: ResponseLike;
    let statusAttempt = 0;
    const transport = this.transport(settings);
    while (true) {
      const current = newAttempt();
      try {
        response = await withDeadline(
          fetchWithNetworkRetry(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: current.signal,
          }, {
            signal: current.signal,
            onRetry: (event) => this.reportRetry(endpoint, event),
          }, transport),
          idleMs,
          timeoutMessage,
          current.abort,
        );
      } catch (error) {
        if (isAbortError(error) && options.signal?.aborted) {
          throw new RequestCancelledError();
        }
        if (isAbortError(error) || (error instanceof Error && error.message === timeoutMessage)) {
          throw new Error(timeoutMessage);
        }
        this.logFailure(endpoint, error);
        throw new Error(tt('api.connectFailed', { error: error instanceof Error ? error.message : String(error) }));
      }
      if (response.ok) break;
      const detail = await readError(response, apiKey);
      if (response.status === 400 && removeRejectedReasoningControl(body, detail)) continue;
      statusAttempt += 1;
      // 服务端过载（503 / 429 / 5xx）：请求没被处理，等一下重发既安全也必要。
      if (shouldRetryStatus(response.status) && statusAttempt < TRANSIENT_STATUS_ATTEMPTS && !options.signal?.aborted) {
        const waitMs = transientRetryDelayMs(statusAttempt, response.headers?.get('retry-after'));
        this.reportStatusRetry(endpoint, response.status, statusAttempt, waitMs, detail);
        await sleepMs(waitMs, options.signal).catch(() => { throw new RequestCancelledError(); });
        continue;
      }
      throw new Error(tt('api.requestFailed', {
        status: response.status,
        // 重试用尽仍然过载：告诉用户这是**临时**状态，别以为是自己配置或代码坏了。
        detail: shouldRetryStatus(response.status) ? `${detail}${tt('api.transientHint')}` : detail,
      }));
    }
    if (!response.body) {
      throw new Error(tt('api.noStream'));
    }

    /*
     * 流式阶段没有总时长上限：每收到一段数据重新计时（见 `withDeadline` 的说明）。
     * 于是「模型慢慢写」不会失败，「连接真的死了」仍然在 N 秒后被判超时。
     */
    try {
      return await parseSse(response.body, options.onDelta, options.signal, idleMs, timeoutMessage);
    } catch (error) {
      if (options.signal?.aborted) {
        throw new RequestCancelledError();
      }
      throw error;
    }
  }

  /**
   * 调 OpenAI 兼容的 `POST /images/generations` 生成图片。
   *
   * 为什么单独一条通道而不是复用 streamChat：出图接口是**一次性 JSON**（没有 SSE），
   * 而且很慢（10–60 秒才吐第一个字节），超时语义与聊天完全不同 —— 聊天的超时是
   * 「多久没有数据」，出图只能是「整次调用最多等多久」。
   *
   * 为什么不发 `response_format`：`gpt-image-1` **不接受**这个参数（会 400），而
   * `dall-e-*` 默认返回临时 URL。所以这里两种都收：有 `b64_json` 直接用，只有 `url`
   * 就在扩展侧下载（走同一个代理与同一套网络诊断），绝不让 webview 去取远程图片 ——
   * CSP 里 `img-src` 只允许 `data:` 与本地资源，这既是技术限制也是隐私选择。
   */
  async generateImage(settings: ChatSettings, options: GenerateImageOptions): Promise<GeneratedImage> {
    const apiKey = options.apiKey?.trim() || await this.getApiKey(settings.activeApiProfileId);
    if (!apiKey?.trim()) throw new Error(tt('api.noKey'));
    const model = String(options.model ?? settings.imageModel ?? '').trim();
    if (!model) throw new Error(tt('api.imageNoModel'));
    const prompt = options.prompt.trim();
    if (!prompt) throw new Error(tt('api.imageEmptyPrompt'));

    const endpoint = buildImagesEndpoint(settings.baseUrl);
    const body: Record<string, unknown> = { model, prompt, n: 1 };
    const size = normalizeImageSize(options.size);
    if (size) body.size = size;

    // 出图没有中间数据可等，所以给一个不短于 90 秒的总时限：用户设置的 120 秒仍然生效，
    // 但把它调到 20 秒（为了聊天更敏感）不该让一次正常出图必然失败。
    const timeoutMs = Math.max(90_000, settings.requestTimeoutSeconds * 1000);
    const timeoutMessage = tt('api.imageTimeout', { seconds: Math.round(timeoutMs / 1000) });
    let attempt = 0;
    let payload: unknown;
    const transport = this.transport(settings);
    while (true) {
      const controller = new AbortController();
      const signal = mergeAbortSignals(options.signal, controller.signal);
      let response: ResponseLike;
      try {
        response = await withDeadline(
          fetchWithNetworkRetry(endpoint, {
            method: 'POST',
            headers: new Headers({
              Accept: 'application/json',
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              ...sanitizeHeaders(settings.requestHeaders),
            }),
            body: JSON.stringify(body),
            signal,
          }, {
            signal,
            onRetry: (event) => this.reportRetry(endpoint, event),
          }, transport),
          timeoutMs,
          timeoutMessage,
          () => controller.abort(),
        );
      } catch (error) {
        if (isAbortError(error) && options.signal?.aborted) throw new RequestCancelledError();
        if (isAbortError(error) || (error instanceof Error && error.message === timeoutMessage)) {
          throw new Error(timeoutMessage);
        }
        this.logFailure(endpoint, error);
        throw new Error(tt('api.connectFailed', { error: error instanceof Error ? error.message : String(error) }));
      }
      if (response.ok) {
        payload = await response.json();
        break;
      }
      const detail = await readError(response, apiKey);
      attempt += 1;
      if (shouldRetryStatus(response.status) && attempt < TRANSIENT_STATUS_ATTEMPTS && !options.signal?.aborted) {
        const waitMs = transientRetryDelayMs(attempt, response.headers?.get('retry-after'));
        this.reportStatusRetry(endpoint, response.status, attempt, waitMs, detail);
        await sleepMs(waitMs, options.signal).catch(() => { throw new RequestCancelledError(); });
        continue;
      }
      throw new Error(tt('api.requestFailed', { status: response.status, detail }));
    }

    const picked = pickGeneratedImage(payload);
    if (!picked) throw new Error(tt('api.imageNoData'));
    if (picked.dataBase64) {
      return { dataBase64: picked.dataBase64, mimeType: picked.mimeType, model };
    }
    // 只有 URL：在扩展侧下载（这样代理/证书/超时都沿用同一条通道）。
    // 明文 http 的地址一律不取：这台机器上的其余请求都要求 HTTPS（本机回环除外），
    // 没有理由让一个服务端返回的 URL 绕过同一条底线。
    assertSecureUrl(new URL(picked.url!));
    const download = await withDeadline(
      transport(picked.url!, { method: 'GET', signal: options.signal ?? new AbortController().signal }),
      timeoutMs,
      timeoutMessage,
    );
    if (!download.ok) throw new Error(tt('api.imageDownloadFailed', { status: download.status }));
    const contentType = download.headers?.get('content-type') ?? '';
    const mimeType = (contentType.split(';')[0] ?? '').trim() || picked.mimeType;
    const bytes = Buffer.from(await readBodyCapped(download, MAX_GENERATED_IMAGE_BYTES));
    return { dataBase64: bytes.toString('base64'), mimeType, model };
  }

  async listModels(settings: ChatSettings, options: ListModelsOptions = {}): Promise<DiscoveredModel[]> {
    const apiKey = options.apiKey?.trim() || await this.getApiKey(settings.activeApiProfileId);
    if (!apiKey?.trim()) {
      throw new Error(tt('api.noKeyForModels'));
    }
    const endpoint = buildModelsEndpoint(settings.baseUrl);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), settings.requestTimeoutSeconds * 1000);
    const signal = mergeAbortSignals(options.signal, timeout.signal);
    let response: ResponseLike;
    try {
      response = await fetchWithNetworkRetry(endpoint, {
        method: 'GET',
        headers: new Headers({
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...sanitizeHeaders(settings.requestHeaders),
        }),
        signal,
      }, {
        signal,
        // 模型列表是幂等 GET，重试更安全，所以多给一次机会。
        attempts: 4,
        onRetry: (event) => this.reportRetry(endpoint, event),
      }, this.transport(settings));
    } catch (error) {
      clearTimeout(timer);
      if (isAbortError(error) && options.signal?.aborted) throw new RequestCancelledError();
      if (isAbortError(error)) throw new Error(tt('api.modelListTimeout', { seconds: settings.requestTimeoutSeconds }));
      this.logFailure(endpoint, error);
      throw new Error(tt('api.modelListFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
    try {
      if (!response.ok) {
        throw new Error(tt('api.modelListStatus', { status: response.status, detail: await readError(response, apiKey) }));
      }
      const payload = await response.json() as unknown;
      const models = parseModels(payload);
      if (!models.length) {
        throw new Error(tt('api.noModels'));
      }
      return models;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class RequestCancelledError extends Error {
  constructor() {
    super(tt('api.cancelled'));
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
    throw new Error(tt('api.httpsRequired'));
  }
  return endpoint;
}

/**
 * 出图端点。
 *
 * `baseUrl` 允许写成 `https://host`、`https://host/v1`，也允许直接写到
 * `/images/generations`（有些网关的聊天与出图不在同一个前缀下）。与聊天端点一样，
 * 远程必须是 HTTPS；只有本机回环允许明文。
 */
export function buildImagesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error(tt('api.imageBaseUrlMissing'));
  const endpoint = normalized.endsWith('/images/generations') ? normalized : `${normalized}/images/generations`;
  const url = new URL(endpoint);
  assertSecureUrl(url);
  return endpoint;
}

/** 单张生成图片的字节上限（base64 之后约 27 MB）。超过就报错，不把内存撑爆。 */
export const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 允许透传给服务端的尺寸。
 *
 * 只列 OpenAI 图像接口真实接受过的取值；不在名单里的一律**丢弃**而不是原样透传 ——
 * 一个 `size: "大图"` 会让整次请求 400，而用户其实只是没说尺寸。
 */
const ALLOWED_IMAGE_SIZES = new Set(['256x256', '512x512', '1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792', 'auto']);

export function normalizeImageSize(value: string | undefined): string | undefined {
  const size = String(value ?? '').trim().toLowerCase();
  return ALLOWED_IMAGE_SIZES.has(size) ? size : undefined;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
};

function mimeFromUrl(url: string): string {
  const clean = url.split('?')[0] ?? '';
  const extension = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? 'image/png';
}

/**
 * 从出图响应里挑出第一张图。
 *
 * 三种真实形状都认：OpenAI 的 `{ data: [{ b64_json | url }] }`、部分网关的
 * `{ images: [{ b64_json }] }`、以及直接把 base64 字符串放在 `{ image }` 里的实现。
 * 认不出来就返回 undefined，由调用方报「没有返回图片」，不猜。
 */
export function pickGeneratedImage(payload: unknown): { dataBase64?: string; url?: string; mimeType: string } | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.images) ? record.images : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const base64 = typeof entry.b64_json === 'string' ? entry.b64_json.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    const mimeType = typeof entry.mime_type === 'string' && entry.mime_type.trim()
      ? entry.mime_type.trim()
      : url ? mimeFromUrl(url) : 'image/png';
    if (base64) return { dataBase64: base64, mimeType };
    if (url) return { url, mimeType };
  }
  if (typeof record.image === 'string' && record.image.trim()) {
    return { dataBase64: record.image.trim(), mimeType: 'image/png' };
  }
  return undefined;
}

/** 读响应体，超过上限立刻中止（不把一张 200 MB 的图拉进内存）。 */
async function readBodyCapped(response: ResponseLike, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.text(), 'binary');
    if (buffer.byteLength > limit) throw new Error(tt('api.imageTooLarge', { limit: Math.round(limit / 1024 / 1024) }));
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(tt('api.imageTooLarge', { limit: Math.round(limit / 1024 / 1024) }));
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
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
    throw new Error(tt('api.httpsRequired'));
  }
}

export function parseModels(payload: unknown): DiscoveredModel[] {
  const candidates = modelCandidates(payload);
  const models = candidates
    .map((candidate) => {
      if (typeof candidate === 'string') return { id: candidate, name: candidate };
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
      const item = candidate as Record<string, unknown>;
      if (isUnavailableModel(item)) return undefined;
      const id = [item.id, item.model, item.model_id, item.modelId, item.slug, item.name]
        .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        ?.trim() ?? '';
      if (!id) return undefined;
      const name = [item.display_name, item.displayName, item.label, item.title, item.name]
        .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        ?.trim() ?? id;
      return { id, name, ...reasoningCapability(item) };
    })
    .filter((value): value is DiscoveredModel => Boolean(value));
  const unique = new Map<string, DiscoveredModel>();
  for (const model of models) {
    const existing = unique.get(model.id);
    if (!existing || existing.name === existing.id) unique.set(model.id, model);
  }
  return [...unique.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, 500);
}

function isUnavailableModel(item: Record<string, unknown>): boolean {
  if (booleanField(item, ['available', 'is_available', 'isAvailable', 'enabled', 'active']) === false) return true;
  if (booleanField(item, ['retired', 'is_retired', 'isRetired', 'deprecated', 'disabled', 'deleted', 'archived']) === true) return true;
  const lifecycle = stringField(item, ['status', 'state', 'lifecycle', 'availability']).toLocaleLowerCase().replace(/[\s-]+/g, '_');
  if (['retired', 'deprecated', 'disabled', 'inactive', 'unavailable', 'deleted', 'archived', 'end_of_life', 'eol'].includes(lifecycle)) return true;
  const retiredAt = stringField(item, ['retired_at', 'retiredAt', 'deprecation_date', 'deprecationDate']);
  if (retiredAt) {
    const timestamp = Date.parse(retiredAt);
    if (Number.isFinite(timestamp) && timestamp <= Date.now()) return true;
  }
  return false;
}

function reasoningCapability(item: Record<string, unknown>): Pick<DiscoveredModel, 'reasoningSupport' | 'reasoningEfforts'> {
  const efforts = reasoningEfforts(item);
  // 只有 default_level、没给 supported_levels 时，仍可确定「服务端支持思考」，
  // 档位按 DeepSeek 文档的取值补齐，避免又把能力判成 unknown。
  if (!efforts.length && objectField(item, ['effort'])?.default_level) {
    return { reasoningSupport: 'configurable', reasoningEfforts: ['none', 'low', 'high', 'max'] };
  }
  const explicit = booleanField(item, [
    'supports_reasoning', 'supportsReasoning', 'reasoning_supported', 'reasoningSupported',
    'supports_thinking', 'supportsThinking', 'thinking_supported', 'thinkingSupported',
  ]);
  if (explicit === false) return { reasoningSupport: 'unsupported' };
  const capabilities = item.capabilities;
  if (Array.isArray(capabilities)) {
    const normalized = capabilities.map((value) => String(value).toLocaleLowerCase());
    if (normalized.some((value) => value.includes('reasoning') || value.includes('thinking'))) {
      return { reasoningSupport: efforts.length > 1 ? 'configurable' : 'fixed', reasoningEfforts: efforts.length ? efforts : undefined };
    }
  } else if (capabilities && typeof capabilities === 'object') {
    const capabilityObject = capabilities as Record<string, unknown>;
    const value = capabilityObject.reasoning ?? capabilityObject.thinking;
    if (value === false) return { reasoningSupport: 'unsupported' };
    if (value === true || (value && typeof value === 'object')) {
      return { reasoningSupport: efforts.length > 1 ? 'configurable' : 'fixed', reasoningEfforts: efforts.length ? efforts : undefined };
    }
  }
  const mode = stringField(item, ['reasoning_mode', 'reasoningMode', 'thinking_mode', 'thinkingMode']).toLocaleLowerCase();
  if (['none', 'disabled', 'unsupported'].includes(mode)) return { reasoningSupport: 'unsupported' };
  if (['fixed', 'always', 'always_on', 'required'].includes(mode)) return { reasoningSupport: 'fixed', reasoningEfforts: efforts.length ? efforts : undefined };
  if (efforts.length > 1 || ['configurable', 'optional', 'hybrid'].includes(mode)) {
    return { reasoningSupport: 'configurable', reasoningEfforts: efforts.length ? efforts : ['low', 'medium', 'high', 'max'] };
  }
  if (efforts.length === 1) return { reasoningSupport: 'fixed', reasoningEfforts: efforts };
  if (explicit === true) return { reasoningSupport: 'fixed' };
  return { reasoningSupport: 'unknown' };
}

function reasoningEfforts(item: Record<string, unknown>): ReasoningEffort[] {
  /*
   * DeepSeek 官方 `/models` 把档位放在**嵌套对象**里：
   *   effort: { supported_levels: ["low","high","max"], default_level: "high" }
   * 只认扁平数组（reasoning_efforts / thinking_levels …）时这里读不到任何值，
   * 能力随后被判成 unknown，界面就把「思考深度」灰成「能力未知」。
   */
  const effort = objectField(item, ['effort', 'thinking', 'reasoning']);
  const candidates = [
    item.reasoning_efforts,
    item.reasoningEfforts,
    item.supported_reasoning_efforts,
    item.supportedReasoningEfforts,
    item.thinking_levels,
    item.thinkingLevels,
    effort?.supported_levels,
    effort?.supportedLevels,
    effort?.levels,
    objectField(item, ['capabilities', 'api_capabilities'])?.reasoning_efforts,
  ].find(Array.isArray) as unknown[] | undefined;
  if (!candidates) return [];
  const normalized = candidates
    .map((value) => String(value).toLocaleLowerCase())
    // 各家 /models 元数据用的别名：off/disabled = 关闭，minimal = 低，
    // xhigh / extra-high = 最高。别名落到我们的四档上，界面才不会出现认不出的值。
    .map((value): ReasoningEffort | undefined => {
      if (value === 'off' || value === 'disabled') return 'none';
      if (value === 'minimal') return 'low';
      if (value === 'xhigh' || value === 'extra-high' || value === 'extra_high') return 'max';
      return ['default', 'none', 'low', 'medium', 'high', 'max'].includes(value) ? value as ReasoningEffort : undefined;
    })
    .filter((value): value is ReasoningEffort => Boolean(value));
  return [...new Set(normalized)];
}

function objectField(item: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = item[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function booleanField(item: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof item[key] === 'boolean') return item[key] as boolean;
  }
  return undefined;
}

function stringField(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof item[key] === 'string') return String(item[key]).trim();
  }
  return '';
}

function modelCandidates(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const object = payload as Record<string, unknown>;
  for (const key of ['data', 'models', 'items']) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  const data = object.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const models = (data as Record<string, unknown>).models;
    if (Array.isArray(models)) return models;
  }
  return [];
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

/**
 * 给一个 promise 加截止时间；超时就调用 `onTimeout`（用于真正中止底层请求）并 reject。
 *
 * 为什么需要它：`requestTimeoutSeconds` 以前是**整条请求**的总时长上限 —— 定时器
 * 只设一次，一到点就 abort。流式回复的总时长与「网络有没有卡住」无关，长回答 +
 * 工具循环本来就可能超过两分钟，于是哪怕每个 token 都在到达，第 120 秒照样被掐断，
 * 用户看到的是「请求超时（120 秒）」，而执行过程里 8 个步骤其实都跑完了
 * （2026-11-03 实测复现：1 秒超时 + 每 200ms 一帧的流，第 1.006 秒就抛超时）。
 *
 * 现在它只用来表达「多久没动静」，每一段数据都会重新计时。
 */
function withDeadline<T>(work: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 先 reject 再中止底层请求：`reader.cancel()` 会让挂起的 read() 立刻以
      // `{done:true}` 兑现（实测），如果先 cancel，race 会先看到「流正常结束」，
      // 超时被吞掉、调用方以为成功。
      reject(new Error(message));
      onTimeout?.();
    }, ms);
  });
  // `race` 会给两边都挂上处理函数，所以被放弃的那个 promise 之后 reject 不会变成
  // unhandled rejection。
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 服务端「现在很忙」的状态码。
 *
 * 真实故障（同一份用户报告的第二条）：`503 Service is too busy ... (request_id: …)`。
 * 这类响应意味着请求**没有被处理**，重试既安全又必要；而旧实现只在 `fetch` 自己抛错时
 * 重试（那时候连响应头都没拿到），拿到 503 就直接把整轮判失败。
 */
const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
/** 状态码重试的总尝试次数（含第一次）。400 → 1200 → 3600，最多多等 5.2 秒。 */
export const TRANSIENT_STATUS_ATTEMPTS = 4;

export function shouldRetryStatus(status: number): boolean {
  return TRANSIENT_STATUS.has(status);
}

/**
 * 第 `attempt` 次重试前等多久。
 *
 * 指数退避 400 / 1200 / 3600 ms；服务端给了 `Retry-After`（秒数或 HTTP 日期）就听它的，
 * 但上限 10 秒 —— 否则一个「Retry-After: 3600」会把界面冻住一小时。
 * 不加随机抖动：这几档在毫秒级，抖动对单客户端没有收益，却会让重试时序不可复现。
 */
export function transientRetryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
  const retryAfter = parseRetryAfter(retryAfterHeader);
  if (retryAfter !== undefined) return Math.min(10_000, retryAfter);
  return Math.min(8_000, 400 * (3 ** Math.max(0, attempt - 1)));
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new Error('aborted'));
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(new Error('aborted'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

async function readError(response: ResponseLike, apiKey: string): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) {
    return response.statusText || tt('api.unknownError');
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
  /** 「多久没收到数据就判超时」；0 表示不限制。见 `withDeadline`。 */
  idleMs = 0,
  timeoutMessage = '',
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
      /*
       * 每一段数据都给一个新的截止时间 —— 这就是「空闲超时」。
       *
       * 不能只依赖 AbortController：真实 fetch 的响应流确实会因 abort 让 read() 抛错，
       * 但测试桩、以及某些代理实现里流的取消并不会传下来，于是「卡住」会变成永久挂起
       * （实测：一条不再产出数据又不关流的响应，旧实现等到测试进程结束都没返回）。
       * 这里直接给 read() 设上限，超时同时取消 reader，连接不会留在那里。
       */
      const chunk = idleMs > 0
        ? await withDeadline(reader.read(), idleMs, timeoutMessage, () => { void reader.cancel().catch(() => undefined); })
        : await reader.read();
      const { done, value } = chunk;
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
    // 超时那一刻我们取消了 reader：此时可能还有挂起的 read，`releaseLock()` 会抛
    // TypeError 并把真正的超时错误盖掉，所以吞掉它 —— 锁随流一起释放，没有泄漏。
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
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
