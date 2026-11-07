/*
 * 语义检索（向量索引）的守护。
 *
 * 用户原话（2026-11-07）：直接选择「向量索引」——用来补词面匹配够不着的同义说法
 * （「悬浮条」vs「胶囊」这一对没有任何共同片段）。
 *
 * 事实前提（已实测，不是假设）：
 *  - DeepSeek 文档里没有 embeddings 条目，`/embeddings` 也没有对应说明 → 没有向量接口；
 *  - 用户已有的智谱（/api/paas/v4/embeddings）与 Minimax（/v1/embeddings）都有
 *    OpenAI 兼容的向量接口（裸请求分别返回 401 与业务错误，说明路由存在）。
 *
 * 所以做成**通用 OpenAI 兼容 embedder**，并且有四条硬要求：
 *   1. 必须是显式开启（默认关闭）：索引会把对话片段发给该服务商；
 *   2. 绝不能拖住对话：未配置 / 没 Key / 请求失败 → 静默退回词面检索；
 *   3. 索引增量 + 省钱：内容哈希没变不重算，每轮最多补 24 条；
 *   4. 换模型整份索引作废（不同语义空间的向量不能混用）。
 *
 * 用法：node test/check-semantic-recall.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

const read = (path) => readFileSync(path, 'utf8');
const PANEL = read('src/views/chatPanel.ts');
const CORE = read('src/core/embeddings.ts');
const CLIENT = read('src/providers/embeddingsClient.ts');
const STORAGE = read('src/core/storage.ts');
const SETTINGS = read('src/core/settings.ts');
const PACKAGE = read('package.json');
const I18N = read('src/core/i18n.ts');

/* ── 1. 必须显式开启 ─────────────────────────────────────────────── */
check(
  '向量配置默认关闭：没选配置档或没填模型就不启用',
  /export function embeddingConfigFrom\(settings: ChatSettings\)/.test(CLIENT)
    && /if \(!model \|\| !profileId\) return undefined;/.test(CLIENT),
);
check(
  '设置项已声明（配置档 / 模型 / 地址覆盖）',
  ['hwchat.embeddingProfileId', 'hwchat.embeddingModel', 'hwchat.embeddingBaseUrl'].every((key) => PACKAGE.includes(key)),
);
check(
  '设置页有对应控件与文案',
  /id="embeddingProfileId"/.test(read('src/views/settingsPanel.ts'))
    && /settings\.embeddingProfile\.hint/.test(I18N)
    && /settings\.embeddingModel\.hint/.test(I18N),
);
check(
  '地址可按服务商覆盖（智谱 coding ≠ paas）',
  /export function embeddingsEndpoint/.test(CLIENT) && /向量接口地址（可选）/.test(I18N) && /paas\/v4/.test(I18N),
);

/* ── 1b. 能不能直接复用聊天配置档：靠探针判断，不让用户猜 ────────── */
const PROBE = read('src/providers/embeddingsProbe.ts');
check(
  '探针按候选模型逐个真实试一次',
  /export async function probeEmbeddingCapability/.test(PROBE) && /for \(const model of candidates\)/.test(PROBE),
);
check(
  '候选里包含 holysheep 的 deepseek-embed-v4 与智谱 embedding-3',
  /'deepseek-embed-v4'/.test(PROBE) && /'embedding-3'/.test(PROBE),
);
check(
  '404 与 401 给出不同结论（缺接口 vs 密钥不对）',
  /没有向量接口/.test(PROBE) && /密钥不被向量接口接受/.test(PROBE),
);
check(
  'HTTP 200 但业务报错也继续试下一个',
  /parsed\.base_resp\?\.status_msg \|\| parsed\.error\?\.message/.test(PROBE),
);
check(
  '设置页有「检测」按钮并会回填可用模型',
  /id="probeEmbeddingButton"/.test(read('src/views/settingsPanel.ts'))
    && /probeEmbeddings/.test(read('media/settings.js'))
    && /fields\.embeddingModel\.value = result\.model/.test(read('media/settings.js')),
);

check(
  '请求体带 encoding_format: float（holysheep 示例要求）',
  /encoding_format: 'float'/.test(CLIENT) && /encoding_format: 'float'/.test(PROBE),
);
check(
  '429 / 5xx 等待后重试一次（限流不白丢一批）',
  /EMBEDDING_RETRIES = 1/.test(CLIENT) && /response\.status === 429 \|\| response\.status >= 500/.test(CLIENT),
);

/* ── 2. 绝不能拖住对话 ───────────────────────────────────────────── */
check(
  '语义检索失败一律退回词面结果（不抛给上层）',
  /const semantic = await this\.semanticRecall\([^)]*\)\.catch\(\(\) => \[\]\);/.test(PANEL),
);
check(
  '没有 Key / 没有索引时直接返回',
  /if \(!apiKey\?\.trim\(\)\) return \[\];/.test(PANEL) && /if \(!records\.length\) return \[\];/.test(PANEL),
);
check(
  '查询向量请求有超时，且不参与重试风暴',
  /timeoutMs: 15_000/.test(PANEL) && /setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/.test(CLIENT),
);
check(
  '后台索引是 fire-and-forget，失败只记日志',
  /private scheduleEmbeddingIndex\(conversationId: string\): void/.test(PANEL)
    && /语义索引失败（不影响对话）/.test(PANEL),
);
check(
  '运行结束才触发索引（不在发送路径上）',
  /this\.scheduleEmbeddingIndex\(conversationId\);/.test(PANEL)
    && !/scheduleEmbeddingIndex\(conversationId\);\s*\n\s*const requestMessages/.test(PANEL),
);

/* ── 3. 省钱与正确性 ─────────────────────────────────────────────── */
check(
  '内容哈希没变就不重算',
  /record\.hash !== contentHash\(message\.content\)/.test(PANEL) && /export function contentHash/.test(CORE),
);
check(
  '每轮最多补 24 条、每批 8 条',
  /limit: 24/.test(PANEL) && /EMBEDDING_BATCH_SIZE = 8/.test(CLIENT),
);
check(
  '索引有上限，按最近裁剪',
  /EMBEDDING_INDEX_LIMIT = 600/.test(CORE) && /merged\.slice\(merged\.length - limit\)/.test(CORE),
);
check(
  '换模型整份索引作废',
  /if \(index\.model !== model\) return \[\];/.test(CORE),
);
check(
  '索引随对话目录存放（删除/回收站一起走）',
  /private embeddingPath\(conversationId: string\)/.test(STORAGE) && /'embeddings\.json'/.test(STORAGE),
);

/* ── 4. 与词面结果合并不互相顶掉 ─────────────────────────────────── */
check(
  '语义命中与词面命中按 messageId 去重后合并',
  /const seen = new Set\(\(window\.recall \?\? \[\]\)\.map\(\(hit\) => hit\.messageId\)\);/.test(PANEL),
);
check(
  '合并后仍受上限约束',
  /\]\.slice\(0, 6\);/.test(PANEL),
);
check(
  '命中的旧消息也能标出「可展开」',
  /hasMessageDetail\(conversationId, message\.id\)/.test(PANEL) && /async hasMessageDetail/.test(STORAGE),
);

/* ── 5. 真实计算：余弦能分开同义与无关 ───────────────────────────── */
buildSync({
  entryPoints: ['src/core/embeddings.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/check/embeddings.cjs',
  logLevel: 'silent',
});
const require = createRequire(import.meta.url);
const { encodeVector, rankBySimilarity, cosineSimilarity, mergeEmbeddingRecords } = require(resolve('out/check/embeddings.cjs'));

// 用两个正交方向模拟「胶囊语境」与「数据库语境」。
const capsule = [0.9, 0.1, 0];
const db = [0.1, 0, 0.9];
check(
  '语义排序：同语境的排在前，无关的被阈值挡掉',
  JSON.stringify(rankBySimilarity(capsule, [
    { messageId: 'capsule-old', hash: 'h', vector: encodeVector(capsule), dim: 3, createdAt: 1 },
    { messageId: 'db-old', hash: 'h', vector: encodeVector(db), dim: 3, createdAt: 2 },
  ], { limit: 2, minScore: 0.5 }).map((item) => item.record.messageId)) === JSON.stringify(['capsule-old']),
);
check(
  '归一化向量点积 = 余弦（服务端归一化与否都不影响）',
  Math.abs(cosineSimilarity(Float32Array.from([3, 4]), Float32Array.from([6, 8])) - 1) < 1e-6,
);
check(
  '索引合并去重后不重复累加',
  mergeEmbeddingRecords(
    [{ messageId: 'a', hash: 'h', vector: encodeVector(capsule), dim: 3, createdAt: 1 }],
    [{ messageId: 'a', hash: 'h2', vector: encodeVector(db), dim: 3, createdAt: 5 }],
  ).length === 1,
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('语义检索还有缺口（默认关闭 / 不阻塞 / 省钱 / 合并不打架）。');
  process.exitCode = 1;
} else {
  console.log('向量索引：默认关闭、失败不影响对话、按哈希省钱、与关键词结果并存。');
}
