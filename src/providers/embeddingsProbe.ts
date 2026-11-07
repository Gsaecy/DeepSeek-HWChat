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

/** 常见 OpenAI 兼容向量模型名，按「最可能命中」排序。 */
export const EMBEDDING_MODEL_CANDIDATES: readonly string[] = [
  'embedding-3',            // 智谱
  'deepseek-embed-v4',      // holysheep
  'text-embedding-3-small', // OpenAI
  'text-embedding-3-large',
  'embo-01',                // Minimax
  'bge-m3',
  'text-embedding-v3',      // 阿里云百炼
];

export interface ProbeAttempt {
  model: string;
  ok: boolean;
  /** 成功时是向量维度；失败时是错误摘要。 */
  detail: string;
  status?: number;
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
}

export type ProbeFetch = (input: string, init: RequestInit) => Promise<Response>;

interface OpenAiEmbeddingBody {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string };
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
        // 用的是真实协议里最小的请求：一个词、只要 float 向量。
        // 与正式请求保持同一形状：`encoding_format: float`（holysheep 的示例带它）。
        body: JSON.stringify({ model, input: 'ping', encoding_format: 'float' }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        attempts.push({ model, ok: false, status: response.status, detail: summarizeError(raw) || `HTTP ${response.status}` });
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
        attempts.push({ model, ok: false, status: response.status, detail: businessError });
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
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ model, ok: false, detail: message === 'This operation was aborted' ? '请求超时' : message.slice(0, 200) });
    } finally {
      clearTimeout(timer);
    }
  }

  const notFound = attempts.every((item) => item.status === 404);
  const unauthorized = attempts.every((item) => item.status === 401 || item.status === 403);
  const summary = notFound
    ? '这个配置档没有向量接口（全部 404）。请另外配一个支持 /embeddings 的服务（例如智谱 /api/paas/v4、Minimax /v1、holysheep /v1），再在这里选它。'
    : unauthorized
      ? '这个配置档的密钥不被向量接口接受（401/403）。确认该密钥对该服务商有效，或换一个配置档。'
      : `没能成功：${attempts.at(-1)?.detail ?? '未知错误'}。若该服务商确实提供向量接口，请把「向量接口地址」填成它的 base（例如 https://api.holysheep.cn/v1）。`;
  return { usable: false, attempts, summary };
}

function summarizeError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as OpenAiEmbeddingBody;
    return parsed.error?.message || parsed.base_resp?.status_msg || '';
  } catch {
    return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
  }
}
