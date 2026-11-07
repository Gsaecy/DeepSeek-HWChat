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
import { hasImageParts, isTextOnlyContentRejection, stripImageParts } from './visionFallback';
import { sanitizeJsonStrings } from '../core/textSafety';
import { fetchWithNetworkRetry, type RetryEvent } from './netDiagnostics';
import { fetchViaProxy, type ResponseLike } from './proxyFetch';

export interface VisionFallbackEvent {
  model: string;
  dropped: number;
  /** `known` = 之前学过；`rejected` = 这次被服务端拒绝后学会的。 */
  reason: 'known' | 'rejected';
}

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

/**
 * 请求体的最终编码：先清掉孤立代理项，再序列化。
 *
 * 真实故障（用户 2026-11-07，连报两次）：
 *
 *     请求失败：接口请求失败（400）：Failed to parse the request body as JSON:
 *     messages[0].content: lone leading surrogate in hex escape at line 1 column 39266
 *
 * 一个 emoji 在 UTF-16 里占两个码元，任何 `slice(0, N)` 截断都可能把它切成半个；
 * `JSON.stringify` 会把那半个写成 `\ud83d`，服务端解析 JSON 直接 400 —— 而这个 400
 * 与「网络连不上」在界面上长得一样，用户完全无从判断。
 *
 * 上游的截断点已经全部改成 `safeSlice`（见 `src/core/textSafety.ts`）。这里再做一次
 * **出站兜底**：无论哪一处漏了，都不能把坏字符发出去 —— 丢掉半个字符，远好过整轮失败。
 * 只在真的发现坏字符时才多走一遍 walk，正常路径没有额外开销。
 */
function encodeRequestBody(body: Record<string, unknown>): { text: string; repaired: boolean } {
  const sanitized = sanitizeJsonStrings(body);
  return { text: JSON.stringify(sanitized), repaired: sanitized !== body };
}

/**
 * 「我们自己把请求掐了」——不是网络故障，是等太久。
 *
 * 真实故障（用户 2026-11-07，输出面板原话）：
 *
 *     [net] 请求失败 …｜网络失败（ABORT_ERR）：经代理请求失败：ABORT_ERR / 网络错误
 *
 * 那一刻既没有断网也没有服务报错：是我们自己的「120 秒没收到任何字节」判定触发了
 * abort，而这个 abort 经代理层包装后变成一个 code 为 ABORT_ERR 的网络错误，于是被
 * 报成「网络失败」。用户看到的「经常连不上」，很多时候其实是这一类。
 *
 * 这个类型把「等了多久、请求体多大、卡在哪一阶段」带出来，界面才能说清该改什么
 * （调大超时 / 给该域名直连 / 换代理）。
 */
export class StreamStalledError extends Error {
  constructor(
    readonly phase: 'awaiting-response' | 'mid-stream',
    readonly seconds: number,
    readonly payloadBytes: number,
    readonly proxied: boolean,
  ) {
    // 文案里保留「超时」二字：日志与旧断言都靠它认出这是等待超限，而不是连接失败。
    super(phase === 'mid-stream'
      ? `等待 ${seconds} 秒没有收到新数据（空闲超时 / stalled:mid-stream）`
      : `等待 ${seconds} 秒没有收到响应（空闲超时 / stalled:awaiting-response）`);
    this.name = 'StreamStalledError';
  }
}

/** 超过这个体积就记一行：它决定「首字节等待」有多容易被判成超时。 */
const LARGE_PAYLOAD_CHARS = 512 * 1024;

export class DeepSeekClient {
  /**
   * 图片被降级时的通知（界面上用它弹一条说明）。
   *
   * 用客户端级回调而不是每次请求都传：降级是**模型能力**层面的结论，
   * 与具体哪一轮无关，而且它在重试路径里被触发 —— 那条路径拿不到单次 options。
   */
  onVisionFallback?: (event: VisionFallbackEvent) => void;

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
    /*
     * 直连名单（`proxyBypassHosts`，默认 `api.deepseek.com`）。
     *
     * 用户 2026-11-07 的要求：「给 DeepSeek 直连，但是不要影响 GitHub 提交拉取等连接」。
     * 经代理上传几 MB 请求体时，代理缓冲会把「首字节」拖到 120 秒以外，被我们自己的
     * 空闲判定掐掉（日志里表现为 `ABORT_ERR`）。DeepSeek 在国内可直连，所以默认放行它；
     * 网页检索、图片下载等仍走代理。
     *
     * 只影响 **HWChat 自己发出的请求**：`git push/pull` 等子进程走自己的代理配置
     * （环境变量 / git config），完全不受这一项影响。
     */
    const bypass = (settings.proxyBypassHosts ?? ['api.deepseek.com']).map((item) => item.toLowerCase());
    const bypassed = (input: string): boolean => {
      let host = '';
      try { host = new URL(input).hostname.toLowerCase(); } catch { return false; }
      return bypass.some((item) => host === item || host.endsWith(`.${item}`));
    };
    return (input: string, init: RequestInit) => {
      if (bypassed(input)) {
        this.logNetwork(`[net] ${input.split('?')[0]} 在直连名单里，跳过代理`);
        return fetch(input, init) as unknown as Promise<ResponseLike>;
      }
      return fetchViaProxy(input, {
        method: init.method,
        headers: init.headers instanceof Headers ? init.headers : undefined,
        body: typeof init.body === 'string' ? init.body : undefined,
        signal: init.signal ?? undefined,
      }, proxy, settings.requestTimeoutSeconds * 1000);
    };
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
  /** 统一的请求体编码入口（含孤立代理项兜底与体积日志）。 */
  private encodeBody(body: Record<string, unknown>, endpoint: string): string {
    const { text, repaired } = encodeRequestBody(body);
    if (repaired) {
      this.logNetwork(`[payload] ${endpoint.split('?')[0]} 请求体里有半个 emoji（孤立代理项），已按 UTF-16 边界修正后发送`);
    }
    /*
     * 体积只记一行，且只在异常大时记：它直接决定上传耗时与「120 秒没有字节」的概率，
     * 出问题时最先要看的就是这个数字。
     */
    if (text.length > LARGE_PAYLOAD_CHARS) {
      this.logNetwork(`[payload] 请求体 ${(text.length / 1024 / 1024).toFixed(2)} MB（${body.messages ? (body.messages as unknown[]).length : 0} 条消息）：体积越大，经代理上传与首字节等待越容易超时`);
    }
    return text;
  }

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

  /**
   * 已知不支持图片输入的「配置档 + 模型」。
   *
   * 学到之后，后续请求**一开始**就不发图片部分 —— 否则用户每次带图提问都要
   * 先吃一个 400、再靠重试兜回来，界面上看起来就是"老是失败"。
   * 键包含模型名：换一个支持视觉的模型应当立刻恢复。
   */
  private readonly textOnlyModels = new Set<string>();

  private textOnlyKey(settings: ChatSettings): string {
    return `${settings.activeApiProfileId}\u0000${settings.model}`;
  }

  /** 这个「配置档 + 模型」是不是已知不吃图片（诊断与测试用）。 */
  isTextOnlyModel(settings: ChatSettings): boolean {
    return this.textOnlyModels.has(this.textOnlyKey(settings));
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
    /*
     * 已知这个模型不吃图片：**先**降级再发，不等服务端报错。
     * 首次遇到时会在下面的 400 分支里学会并重试一次。
     */
    let outgoing = messages;
    let droppedImages = 0;
    if (this.textOnlyModels.has(this.textOnlyKey(settings))) {
      const stripped = stripImageParts(messages, tt('api.visionUnsupportedNote'));
      outgoing = stripped.messages;
      droppedImages = stripped.dropped;
      if (droppedImages) {
        this.onVisionFallback?.({
          model: settings.model,
          dropped: droppedImages,
          reason: 'known',
        });
      }
    }
    const body: Record<string, unknown> = {
      model: settings.model,
      messages: outgoing,
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
      /*
       * `stalledByUs`：这次 abort 是**我们自己**的空闲判定触发的，不是用户取消，
       * 也不是网络故障。区分开之后，界面才能给出可执行的建议（调大超时 / 直连 / 换代理），
       * 而不是笼统一句「请求失败」。
       */
      let stalledByUs = false;
      const requestText = this.encodeBody(body, endpoint);
      try {
        response = await withDeadline(
          fetchWithNetworkRetry(endpoint, {
            method: 'POST',
            headers,
            body: requestText,
            signal: current.signal,
          }, {
            signal: current.signal,
            onRetry: (event) => this.reportRetry(endpoint, event),
          }, transport),
          idleMs,
          timeoutMessage,
          () => { stalledByUs = true; current.abort(); },
        );
      } catch (error) {
        if (stalledByUs && !options.signal?.aborted) {
          throw new StreamStalledError('awaiting-response', Math.round(idleMs / 1000), requestText.length, Boolean(settings.proxy?.trim()));
        }
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
      /*
       * 「content.type 只允许 text」：这次请求形状整个不被接受，改参数没用，重发也没用。
       * 去掉图片部分再发一次 —— 与 `removeRejectedReasoningControl` 同一个思路：
       * 把服务端的拒绝当成可以自我修正的信号，并把结论记下来供后续请求使用。
       */
      if (response.status === 400
        && isTextOnlyContentRejection(detail, hasImageParts(outgoing as Array<{ content: unknown }>))) {
        const stripped = stripImageParts(outgoing as Array<{ content: unknown }>, tt('api.visionUnsupportedNote'));
        if (stripped.dropped > 0) {
          this.textOnlyModels.add(this.textOnlyKey(settings));
          body.messages = stripped.messages;
          outgoing = stripped.messages as typeof outgoing;
          droppedImages += stripped.dropped;
          this.onVisionFallback?.({ model: settings.model, dropped: stripped.dropped, reason: 'rejected' });
          this.logNetwork(`[vision] ${settings.model} 不接受图片输入，已去掉 ${stripped.dropped} 张图重发（之后不再附带）`);
          continue;
        }
      }
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
            body: this.encodeBody(body, endpoint),
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
      // 404 几乎只有一个原因：这个接口地址下根本没有出图端点。
      // 单独说清楚，比「接口请求失败（404）」有用得多 —— 用户下一步该换配置档，而不是重试。
      if (response.status === 404) {
        throw new Error(tt('api.imageEndpointMissing', { endpoint, detail }));
      }
      throw new Error(tt('api.requestFailed', { status: response.status, detail }));
    }

    const picked = pickGeneratedImage(payload);
    if (!picked) throw new Error(tt('api.imageNoData'));
    if (picked.dataBase64) {
      return { dataBase64: picked.dataBase64, mimeType: picked.mimeType, model };
    }
    // 只有 URL：在扩展侧下载（这样代理/证书/超时都沿用同一条通道）。
    const downloaded = await this.downloadImage(settings, picked.url!, { signal: options.signal, mimeType: picked.mimeType });
    return { dataBase64: downloaded.dataBase64, mimeType: downloaded.mimeType, model };
  }

  /**
   * 探测「这个接口地址下到底有没有出图端点」——**不花钱**。
   *
   * 做法：发一个**空 body** 的 POST。OpenAI 兼容实现会先校验参数，于是
   *   - 端点存在 → 400 / 422（缺 model / 缺 prompt）；
   *   - 端点不存在 → 404；
   *   - Key 不对 → 401。
   * 三种结果已经足够回答「我该填什么」。真正生成一张图要花钱，所以探针不生成。
   */
  async probeImageEndpoint(settings: ChatSettings): Promise<{
    endpoint: string;
    exists: boolean;
    status?: number;
    detail?: string;
  }> {
    const endpoint = buildImagesEndpoint(settings.baseUrl);
    const apiKey = await this.getApiKey(settings.activeApiProfileId);
    let response: ResponseLike;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(20_000, Math.max(5_000, settings.requestTimeoutSeconds * 1000)));
      try {
        response = await this.transport(settings)(endpoint, {
          method: 'POST',
          headers: new Headers({
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...sanitizeHeaders(settings.requestHeaders),
          }),
          body: '{}',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return { endpoint, exists: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const detail = response.ok ? '' : await readError(response, apiKey ?? '');
    // 200 说明对方对空 body 也照单全收（少见），那当然算端点存在。
    return { endpoint, exists: response.status !== 404, status: response.status, detail };
  }

  /**
   * 由**扩展**取回一张远程图片，返回 base64。
   *
   * 为什么不让 webview 自己去取（用户 2026-11-04 的决定：保持严格）：
   * 那样等于告诉外部主机「有人正在看这条对话」，还会带上 webview 自身的来源信息。
   * 走这里之后，请求使用用户配置的代理、扩展自己的身份、有明确的超时与体积上限，
   * 面板的 CSP 就可以继续保持 `img-src ${webview.cspSource} data:`。
   *
   * 明文 http 一律不取（本机回环除外）：这台机器上其余远程请求都要求 HTTPS，
   * 没有理由让一条图片地址绕过同一条底线。
   */
  async downloadImage(
    settings: ChatSettings,
    url: string,
    options: { signal?: AbortSignal; mimeType?: string; maxBytes?: number } = {},
  ): Promise<{ dataBase64: string; mimeType: string }> {
    const target = new URL(url);
    assertSecureUrl(target);
    const timeoutMs = Math.max(30_000, settings.requestTimeoutSeconds * 1000);
    const timeoutMessage = tt('api.imageTimeout', { seconds: Math.round(timeoutMs / 1000) });
    const transport = this.transport(settings);
    const controller = new AbortController();
    const signal = mergeAbortSignals(options.signal, controller.signal);
    let response: ResponseLike;
    try {
      response = await withDeadline(
        transport(url, { method: 'GET', signal }),
        timeoutMs,
        timeoutMessage,
        () => controller.abort(),
      );
    } catch (error) {
      if (options.signal?.aborted) throw new RequestCancelledError();
      if (isAbortError(error) || (error instanceof Error && error.message === timeoutMessage)) {
        throw new Error(timeoutMessage);
      }
      throw new Error(tt('api.connectFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
    if (!response.ok) throw new Error(tt('api.imageDownloadFailed', { status: response.status }));
    const contentType = response.headers?.get('content-type') ?? '';
    const declared = (contentType.split(';')[0] ?? '').trim().toLowerCase();
    // 服务端常常回 `application/octet-stream`：这种「不认识的类型」按 URL 扩展名兜底，
    // 总比让整张图因为一个错误的 content-type 被拒要好。
    const mimeType = declared.startsWith('image/') ? declared : (options.mimeType || declared || 'image/png');
    const bytes = Buffer.from(await readBodyCapped(response, options.maxBytes ?? GENERATED_IMAGE_MAX_BYTES));
    if (!bytes.byteLength) throw new Error(tt('api.imageNoData'));
    return { dataBase64: bytes.toString('base64'), mimeType };
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
export const GENERATED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 正文远程图更保守：一屏可能出现好几张，别把内存撑爆。 */
export const REMOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

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
  /** 本次「没有数据」是不是我们自己的空闲判定触发的（区别于连接被断开）。 */
  let stalledMidStream = false;
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
        ? await withDeadline(reader.read(), idleMs, timeoutMessage, () => {
          // 流中途没有数据：同样是我们自己的空闲判定，要能和「连接被断开」分开报。
          stalledMidStream = true;
          void reader.cancel().catch(() => undefined);
        })
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
  } catch (error) {
    /*
     * 流停在半路：把我们自己的空闲判定和真正的连接断开分开。
     *
     * 旧实现把这种情况一律报成「网络失败（ABORT_ERR）」，于是用户无法判断是
     * 「模型还在想」还是「代理断了」—— 前者只要调大超时就好，后者才需要查代理。
     */
    if (stalledMidStream && !signal?.aborted) {
      throw new StreamStalledError('mid-stream', Math.round(idleMs / 1000), 0, false);
    }
    throw error;
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
