/**
 * 语义检索的纯计算内核：向量编码、余弦相似度、索引裁剪。
 *
 * 背景（用户 2026-11-07 的要求）：现有检索是**词面**匹配 —— 用户说「悬浮条」，
 * 记录里写的是「胶囊」，两边一个共同片段都没有，永远搜不到。这类同义/近义
 * 只能靠向量相似度解决。用户明确选择了「向量索引」。
 *
 * 事实核对（已实测）：DeepSeek **没有** embeddings 接口（文档里没有该项，
 * 也没有对应路由说明）；用户已有的智谱（`/api/paas/v4/embeddings`）与
 * Minimax（`/v1/embeddings`）都有 OpenAI 兼容的向量接口。所以这里做成
 * **通用 OpenAI 兼容 embedder**，不绑定某一家。
 *
 * 本模块不 import vscode、不联网，便于单测与守护脚本直接跑。
 */

/** 索引里的一条：一条消息的向量。 */
export interface EmbeddingRecord {
  messageId: string;
  /** 内容的短哈希：内容没变就不重新请求向量（省钱）。 */
  hash: string;
  /** base64 编码的 Float32Array。 */
  vector: string;
  /** 维度，用于校验；换模型会导致维度变化。 */
  dim: number;
  createdAt: number;
}

export interface EmbeddingIndex {
  version: 1;
  /** 产生这些向量的模型名。换模型时整份索引重建，不能混用。 */
  model: string;
  records: EmbeddingRecord[];
}

/** 一段文本的稳定哈希（FNV-1a，够用且无需依赖）。 */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** `number[]` → base64（Float32）。比 JSON 数组小 3–4 倍。 */
export function encodeVector(values: readonly number[]): string {
  const array = Float32Array.from(values);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
}

/** base64 → `Float32Array`；长度不是 4 的倍数时返回空向量（坏数据不该让检索崩）。 */
export function decodeVector(text: string): Float32Array {
  if (!text) return new Float32Array(0);
  try {
    const buffer = Buffer.from(text, 'base64');
    if (!buffer.byteLength || buffer.byteLength % 4 !== 0) return new Float32Array(0);
    // 复制一份，避免 Buffer 底层 ArrayBuffer 的偏移问题。
    return new Float32Array(buffer.byteLength / 4).map((_, index) => buffer.readFloatLE(index * 4));
  } catch {
    return new Float32Array(0);
  }
}

/**
 * 余弦相似度。
 *
 * 归一化向量时理论上可以直接点积，但实际服务返回的向量不保证已归一化
 * （有的归一化、有的不归一化），所以这里老实算模长。零向量返回 0。
 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export interface ScoredRecord {
  record: EmbeddingRecord;
  score: number;
}

/** 按相似度取前 N 条；低于阈值的直接丢掉（错证据比没有证据更糟）。 */
export function rankBySimilarity(
  query: readonly number[] | Float32Array,
  records: readonly EmbeddingRecord[],
  options: { limit?: number; minScore?: number } = {},
): ScoredRecord[] {
  const limit = Math.max(1, options.limit ?? 4);
  const minScore = options.minScore ?? 0.35;
  const queryVector = query instanceof Float32Array ? query : Float32Array.from(query);
  if (!queryVector.length) return [];
  const scored: ScoredRecord[] = [];
  for (const record of records) {
    const vector = decodeVector(record.vector);
    if (!vector.length) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (score >= minScore) scored.push({ record, score });
  }
  return scored
    .sort((left, right) => right.score - left.score || right.record.createdAt - left.record.createdAt)
    .slice(0, limit);
}

/** 索引上限：再多也没意义（旧消息本来也会被任务记忆覆盖）。 */
export const EMBEDDING_INDEX_LIMIT = 600;

/**
 * 合并新向量：按 messageId 覆盖，保留最近的 `limit` 条。
 *
 * 为什么按最近裁剪而不是按相似度：索引是「长期记忆的检索入口」，最近的内容
 * 更可能被问到；而真正久远的关键结论已经在任务树里了。
 */
export function mergeEmbeddingRecords(
  existing: readonly EmbeddingRecord[],
  added: readonly EmbeddingRecord[],
  limit = EMBEDDING_INDEX_LIMIT,
): EmbeddingRecord[] {
  const byId = new Map<string, EmbeddingRecord>();
  for (const record of existing) byId.set(record.messageId, record);
  for (const record of added) byId.set(record.messageId, record);
  const merged = [...byId.values()].sort((left, right) => left.createdAt - right.createdAt);
  return merged.length <= limit ? merged : merged.slice(merged.length - limit);
}

/** 换模型后旧向量作废：维度/语义空间不同，混用会得到错误的高分。 */
export function reusableRecords(index: EmbeddingIndex | undefined, model: string): EmbeddingRecord[] {
  if (!index || index.version !== 1) return [];
  if (index.model !== model) return [];
  return index.records.filter((record) => Boolean(record.vector) && record.dim > 0);
}

/**
 * 送去向量化的文本：去掉控制字符、压掉空行、截到上限。
 *
 * 截断用 `clipText`（不切 emoji）—— 每个请求都要 JSON.stringify，半个代理项
 * 会让整次调用 400，和聊天请求是同一个坑。
 */
export function embeddingInput(text: string, limit = 2_000): string {
  const flat = String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    // 行尾空白与行首缩进在语义上没意义，但会让同一段话产生不同向量。
    .split('\n').map((line) => line.trim()).join('\n')
    .trim();
  return flat.length <= limit ? flat : `${safeClip(flat, limit)}`;
}

/** 内部小包装，避免为了一个截断再引一次模块命名冲突。 */
function safeClip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = limit;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
