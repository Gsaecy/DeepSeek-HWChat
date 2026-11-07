import type { ChatSettings } from '../core/types';
import { embeddingInput } from '../core/embeddings';

/**
 * OpenAI 兼容的向量接口客户端。
 *
 * 为什么单独一个客户端：DeepSeek 没有 embeddings（已实测），而用户已有的智谱与
 * Minimax 都有 `/embeddings`。所以这里只认「协议」不认「厂商」：
 *
 *     POST {baseUrl}/embeddings
 *     { "model": "...", "input": ["...", "..."] }
 *     → { "data": [{ "embedding": [0.01, …] }, …] }
 *
 * 三个必须注意的点：
 *  1. **绝不能拖住对话**：向量化是「后台索引」，失败只能是少一点检索能力，
 *     不能影响正在进行的这一轮。所以调用方拿到的是 Promise，且这里自带超时。
 *  2. **批量**：`input` 是数组，一次最多 8 条；逐条请求既慢又贵。
 *  3. **代理**：与聊天共用同一个直连名单 —— 向量接口通常也在国内可直连，
 *     而经代理上传几十 KB 反复请求更容易抖。
 */

export interface EmbeddingRequestSettings {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  requestHeaders?: Record<string, string>;
}

export type EmbeddingFetch = (input: string, init: RequestInit) => Promise<Response>;

/** 队列里一次最多几条：太少浪费往返，太多容易触发服务端的单请求上限。 */
export const EMBEDDING_BATCH_SIZE = 8;

/** 从 settings 里解析出「向量接口」的配置；没配就返回 undefined（功能关闭）。 */
export function embeddingConfigFrom(settings: ChatSettings): { profileId: string; model: string; baseUrl?: string } | undefined {
  const model = String(settings.embeddingModel ?? '').trim();
  const profileId = String(settings.embeddingProfileId ?? '').trim();
  if (!model || !profileId) return undefined;
  const baseUrl = String(settings.embeddingBaseUrl ?? '').trim();
  return { profileId, model, baseUrl: baseUrl || undefined };
}

/**
 * 拼出 `/embeddings` 地址。
 *
 * 坑：智谱的「编码」配置档 baseUrl 是 `…/api/coding/paas/v4`，而向量接口在
 * `…/api/paas/v4/embeddings` —— 直接用配置档的 baseUrl 会 404。所以允许
 * `embeddingBaseUrl` 单独覆盖；没填时才用配置档的地址。
 */
export function embeddingsEndpoint(baseUrl: string): string {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('向量接口地址为空');
  if (/\/embeddings$/i.test(trimmed)) return trimmed;
  return `${trimmed}/embeddings`;
}

/** 服务端返回体的最小形状（只认用得到的字段）。 */
interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string; code?: string };
  base_resp?: { status_msg?: string };
}

/**
 * 批量取向量。返回的顺序与入参一致；任何一条缺失都整体失败，
 * 免得索引里出现「有记录没向量」的错位。
 */
export async function embedTexts(
  config: EmbeddingRequestSettings,
  apiKey: string,
  inputs: readonly string[],
  options: { fetchImpl?: EmbeddingFetch; signal?: AbortSignal } = {},
): Promise<number[][]> {
  const texts = inputs.map((text) => embeddingInput(text)).filter(Boolean);
  if (!texts.length) return [];
  if (!apiKey.trim()) throw new Error('向量接口缺少 API Key');
  const doFetch = options.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));
  const endpoint = embeddingsEndpoint(config.baseUrl);
  const timeoutMs = Math.max(5_000, config.timeoutMs ?? 20_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal
    ? (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
      ? (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([options.signal, controller.signal])
      : controller.signal
    : controller.signal;
  try {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: new Headers({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...sanitizeHeaders(config.requestHeaders),
      }),
      body: JSON.stringify({ model: config.model, input: texts }),
      signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`向量接口请求失败（${response.status}）：${raw.slice(0, 300)}`);
    }
    let parsed: EmbeddingResponse;
    try {
      parsed = JSON.parse(raw) as EmbeddingResponse;
    } catch {
      throw new Error(`向量接口返回的不是 JSON：${raw.slice(0, 200)}`);
    }
    // Minimax 用 `base_resp.status_code` 表达业务错误（HTTP 200 也可能是失败）。
    const businessError = parsed.base_resp?.status_msg;
    if (businessError) throw new Error(`向量接口返回错误：${businessError}`);
    if (parsed.error?.message) throw new Error(`向量接口返回错误：${parsed.error.message}`);
    const vectors = (parsed.data ?? []).map((item) => item.embedding ?? []);
    if (vectors.length !== texts.length) {
      throw new Error(`向量接口返回条数不符：期望 ${texts.length}，实际 ${vectors.length}`);
    }
    if (vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)) {
      throw new Error('向量接口返回了空向量');
    }
    return vectors;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    // 请求头里不许自带 Authorization：密钥只由这里注入，避免配置把 key 写进明文文件。
    if (/^authorization$/i.test(key.trim())) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/** 把数组切成固定大小的批。 */
export function chunk<T>(items: readonly T[], size = EMBEDDING_BATCH_SIZE): T[][] {
  const step = Math.max(1, size);
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += step) out.push(items.slice(index, index + step));
  return out;
}
