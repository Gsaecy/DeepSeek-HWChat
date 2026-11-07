/**
 * 「这个配置档能不能直接算向量？」的探针。
 *
 * 用户的要求（2026-11-07）：
 *
 *      hwchat 配置模型的 API 能通用 embeddings 接口吗？能就直接调用，
 *      不能就让用户另外配置
 *
 * 已实测的事实：
 *  - DeepSeek 官方文档里**没有** embeddings 条目（`/guides/embeddings` 回落到首页），
 *    所以拿 DeepSeek 的聊天配置档算向量是不行的；
 *  - 智谱（`/api/paas/v4/embeddings`）、Minimax（`/v1/embeddings`）、
 *    holysheep（`/v1/embeddings`，模型 `deepseek-embed-v4`）都用同一套
 *    OpenAI 兼容协议 —— 只要配置档的 baseUrl 同时服务 `/embeddings`，就能**直接复用**。
 *
 * 所以这里不再让用户猜：给一个探针，按候选模型逐个试一次（`input: "ping"`），
 * 第一个成功的就是「可以直接调用」的证据；全失败就明确告诉用户需要另外配置，
 * 并把该服务商的原始错误带上（是 404 还是 401 完全不同）。
 */

/** 不知道是哪家服务商时的兜底候选，按「最可能命中」排序。 */
export const EMBEDDING_MODEL_CANDIDATES: readonly string[] = [
  'embedding-3',            // 智谱
  'deepseek-embed-v4',      // holysheep
  'text-embedding-3-small', // OpenAI
  'text-embedding-3-large',
  'embo-01',                // Minimax
  'bge-m3',
  'text-embedding-v3',      // 阿里云百炼
];

/**
 * 按服务商收敛候选模型。
 *
 * 为什么要收敛（2026-11-07 用户实测反馈「智谱测试失败」）：
 * 原来不管地址是哪家，都把 7 个模型名挨个试一遍。结果用户填的是智谱
 * `embedding-3`，屏幕上却显示 **最后试的那个阿里云模型** 的报错
 * 「模型不存在，请检查模型代码」—— 一句话把最有用的信息盖掉了。
 *
 * 所以我们既要知道「这是哪家」（别乱试别人的模型），也要把「你自己填的
 * 那个模型」的结论优先说出来。
 */
const PROVIDER_MODELS: ReadonlyArray<{ match: RegExp; models: readonly string[] }> = [
  // 智谱官方 OpenAPI 的 model 枚举只有这两个（已核对 docs.bigmodel.cn）。
  { match: /(^|\.)bigmodel\.cn$|(^|\.)z\.ai$/i, models: ['embedding-3', 'embedding-2'] },
  { match: /(^|\.)minimax(i)?\.(cn|io|com)$/i, models: ['embo-01'] },
  { match: /(^|\.)holysheep\.cn$/i, models: ['deepseek-embed-v4'] },
  { match: /(^|\.)openai\.com$/i, models: ['text-embedding-3-small', 'text-embedding-3-large'] },
  { match: /dashscope|aliyuncs/i, models: ['text-embedding-v3', 'text-embedding-v4'] },
  { match: /siliconflow/i, models: ['bge-m3'] },
  // DeepSeek 官方没有 embeddings（已核对文档）：别拿别人的模型名去打它，只会得到噪音。
  { match: /(^|\.)deepseek\.com$/i, models: [] },
];

/**
 * 「该试哪些模型名」：用户自己填的永远排第一，其余按服务商补齐。
 *
 * 未填模型时也能工作 —— 只要地址认得出是哪家，就用该家的模型名去试。
 */
export function embeddingCandidatesFor(baseUrl: string, typed?: string): string[] {
  const host = hostOf(baseUrl);
  const typedModel = String(typed ?? '').trim();
  const provider = PROVIDER_MODELS.find((entry) => entry.match.test(host));
  const fallback = provider ? provider.models : EMBEDDING_MODEL_CANDIDATES;
  return [...new Set([typedModel, ...fallback].filter(Boolean))];
}

function hostOf(url: string): string {
  try {
    return new URL(String(url ?? '').trim()).host.toLowerCase();
  } catch {
    return '';
  }
}

export interface ProbeAttempt {
  model: string;
  ok: boolean;
  /** 成功时是向量维度；失败时是错误摘要。 */
  detail: string;
  status?: number;
  /** 服务商的业务错误码（智谱 1211=模型不存在、1213=未开通、1214=参数非法）。 */
  code?: string;
}

export interface ProbeResult {
  /** 能否直接复用这个配置档的密钥与地址。 */
  usable: boolean;
  /** 可用的模型名（usable 时有值）。 */
  model?: string;
  /** 向量维度（usable 时有值）。 */
  dim?: number;
  attempts: ProbeAttempt[];
  /** 给用户看的一句话结论。 */
  summary: string;
  /** 每个候选一行的明细，界面直接按行显示。 */
  lines: string[];
}

export type ProbeFetch = (input: string, init: RequestInit) => Promise<Response>;

interface OpenAiEmbeddingBody {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string; code?: string };
  base_resp?: { status_msg?: string };
}

/**
 * 逐个候选模型试一次。
 *
 * 顺序很关键：把用户**已经填的**模型放第一位（他可能知道确切名字），
 * 其余候选只用来兜底。每个候选都发一次真实请求，所以只在用户点「检测」时调用，
 * 不进任何热路径。
 */
export async function probeEmbeddingCapability(options: {
  endpoint: string;
  apiKey: string;
  candidates?: readonly string[];
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const attempts: ProbeAttempt[] = [];
  const candidates = [...new Set((options.candidates ?? []).map((item) => item.trim()).filter(Boolean))];
  if (!candidates.length) {
    return {
      usable: false,
      attempts,
      summary: '没有可尝试的模型名：先填一个向量模型（例如 embedding-3 或 deepseek-embed-v4），再点检测。',
      lines: [],
    };
  }
  const doFetch = options.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));
  const timeoutMs = Math.max(3_000, options.timeoutMs ?? 12_000);

  for (const model of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(options.endpoint, {
        method: 'POST',
        headers: new Headers({
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        }),
        // 只用协议里最小的请求：一个词。
        // **不发 `encoding_format`**：OpenAI 规范里它默认就是 float，而智谱官方
        // OpenAPI 的 schema 只有 model / input / dimensions —— 多发一个它不认识的
        // 字段只会换来一个更难懂的报错（用户 2026-11-07 实测踩到）。
        body: JSON.stringify({ model, input: 'ping' }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        const failure = parseFailure(raw);
        attempts.push({
          model,
          ok: false,
          status: response.status,
          code: failure.code,
          detail: failure.message || `HTTP ${response.status}`,
        });
        continue;
      }
      let parsed: OpenAiEmbeddingBody;
      try {
        parsed = JSON.parse(raw) as OpenAiEmbeddingBody;
      } catch {
        attempts.push({ model, ok: false, status: response.status, detail: '返回的不是 JSON' });
        continue;
      }
      const businessError = parsed.base_resp?.status_msg || parsed.error?.message;
      if (businessError) {
        attempts.push({ model, ok: false, status: response.status, code: parsed.error?.code, detail: businessError });
        continue;
      }
      const vector = parsed.data?.[0]?.embedding ?? [];
      if (!vector.length) {
        attempts.push({ model, ok: false, status: response.status, detail: '返回了空向量' });
        continue;
      }
      attempts.push({ model, ok: true, detail: `${vector.length} 维` });
      return {
        usable: true,
        model,
        dim: vector.length,
        attempts,
        summary: `可以直接调用：这个配置档的密钥与地址就能算向量（模型 ${model}，${vector.length} 维）。`,
        lines: attemptLines(attempts),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ model, ok: false, detail: message === 'This operation was aborted' ? '请求超时' : message.slice(0, 200) });
    } finally {
      clearTimeout(timer);
    }
  }

  return { usable: false, attempts, summary: failureSummary(attempts), lines: attemptLines(attempts) };
}

/** 每个候选一行：一眼看出是「模型名不对」还是「密钥不对」。 */
export function attemptLines(attempts: readonly ProbeAttempt[]): string[] {
  return attempts.map((item) => {
    const status = item.status && !item.ok ? `（HTTP ${item.status}${item.code ? ` / ${item.code}` : ''}）` : '';
    return `${item.ok ? '✓' : '✗'} ${item.model}：${item.detail}${status}`;
  });
}

/**
 * 一句结论 + 逐条明细。
 *
 * 关键：结论按 **attempts[0]**（用户自己填的模型）说话。原来的实现取
 * `attempts.at(-1)`，于是智谱用户看到的是最后一个候选（阿里云 text-embedding-v3）
 * 的「模型不存在」—— 既不是他填的模型，也没说清到底哪里错。
 *
 * 分类依据是智谱官方错误码表（docs.bigmodel.cn/cn/api/api-code）：
 * 1211 模型不存在、1212 该模型不支持这个调用方式、1213 缺参数、1214 参数非法、
 * 1222 API 不存在、1315 该 Key 仅限编程套餐。这几类要分开说，否则用户只能瞎试。
 */
function failureSummary(attempts: readonly ProbeAttempt[]): string {
  const primary = attempts[0];
  if (!primary) return '没能成功：没有任何请求被发出。';
  const detail = `\n本次试过：\n${attemptLines(attempts).join('\n')}`;
  const kinds = attempts.map(failureKindOf);
  if (kinds.every((kind) => kind === 'no-endpoint')) {
    return `这个配置档没有向量接口（全部 404）。请另外配一个支持 /embeddings 的服务（例如智谱 /api/paas/v4、Minimax /v1、holysheep /v1），再在这里选它。${detail}`;
  }
  if (kinds.every((kind) => kind === 'auth')) {
    return `这个配置档的密钥不被向量接口接受（401/403）。确认该密钥对该服务商有效，或换一个配置档。${detail}`;
  }
  switch (failureKindOf(primary)) {
    case 'model-missing':
      return `地址和密钥都通过了，只是模型名不对：${primary.model} → ${primary.detail}。请按该服务商的模型列表填（智谱是 embedding-3 / embedding-2，Minimax 是 embo-01，holysheep 是 deepseek-embed-v4）。${detail}`;
    case 'wrong-method':
      return `地址和密钥都通过了，但 ${primary.model} 不支持 embeddings 调用：${primary.detail}。这个位置要填**向量模型**，不是聊天模型。${detail}`;
    case 'param':
      return `地址和密钥都通过了，请求参数却被拒绝：${primary.model} → ${primary.detail}。${detail}`;
    case 'key-scope':
      return `密钥的类型不对：${primary.detail}。这个 Key 属于订阅/编程套餐，只能用于对应产品；请到服务商控制台换成「按量计费」的 API Key。${detail}`;
    case 'quota':
      return `服务商那边限流或额度不够了：${primary.detail}。稍后重试，或到控制台确认余额与额度。${detail}`;
    default:
      return `没能成功：${primary.model} → ${primary.detail}。若该服务商确实提供向量接口，请把「向量接口地址」填成它的 base（例如 https://api.holysheep.cn/v1）。${detail}`;
  }
}

type FailureKind = 'no-endpoint' | 'auth' | 'model-missing' | 'wrong-method' | 'param' | 'key-scope' | 'quota' | 'unknown';

/** 把一次失败归到「用户下一步该做什么」的一类里。 */
function failureKindOf(attempt: ProbeAttempt): FailureKind {
  const code = attempt.code ?? '';
  if (attempt.status === 404 || code === '1221' || code === '1222') return 'no-endpoint';
  if (attempt.status === 401 || attempt.status === 403 || /^100[0-9]$/.test(code) || code === '1220') return 'auth';
  if (code === '1211' || isModelMissing(attempt.detail)) return 'model-missing';
  if (code === '1212') return 'wrong-method';
  if (code === '1213' || code === '1214' || isParameterError(attempt.detail)) return 'param';
  // 1309/1311/1315：订阅套餐到期、套餐没开这个模型、编程套餐专属 Key —— 都不是换个模型名能解决的。
  if (code === '1309' || code === '1311' || code === '1315') return 'key-scope';
  if (attempt.status === 429 || code === '1113' || /^13(0[2-8]|1\d)$/.test(code)) return 'quota';
  return 'unknown';
}

/** 「模型不存在」的各种说法（智谱 1211、OpenAI、通用英文措辞）。 */
function isModelMissing(detail: string): boolean {
  return /模型不存在|模型.{0,6}不存在|无此模型|model\s+(?:is\s+)?(?:not\s+found|not\s+exist|does\s+not\s+exist|doesn't\s+exist)|unknown\s+model|invalid\s+model|no\s+such\s+model|unsupported\s+model/i.test(detail);
}

/** 参数类错误：说明模型存在，只是请求形状不对。 */
function isParameterError(detail: string): boolean {
  return /参数非法|参数错误|invalid\s+(?:request|parameter|param)|invalid_request_error|参数.{0,4}(不对|错误)|bad\s+request/i.test(detail);
}

/** 从错误响应里抠出「服务商自己的话」和业务码。 */
function parseFailure(raw: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(raw) as OpenAiEmbeddingBody;
    const message = parsed.error?.message || parsed.base_resp?.status_msg || '';
    const code = parsed.error?.code;
    if (message) return { message, code: code && code !== 'undefined' ? String(code) : undefined };
  } catch {
    /* 不是 JSON：退回原文 */
  }
  return { message: raw.replace(/\s+/g, ' ').trim().slice(0, 160) };
}
