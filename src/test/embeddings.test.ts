import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contentHash,
  cosineSimilarity,
  decodeVector,
  embeddingInput,
  encodeVector,
  mergeEmbeddingRecords,
  rankBySimilarity,
  reusableRecords,
} from '../core/embeddings';
import { chunk, embeddingsEndpoint, embedTexts } from '../providers/embeddingsClient';

/**
 * 语义检索（向量索引）。
 *
 * 用户 2026-11-07 的选择：「向量索引」——解决词面匹配够不着的同义说法
 * （「悬浮条」vs「胶囊」）。DeepSeek 没有 embeddings（已实测），所以走
 * 通用的 OpenAI 兼容接口（智谱 / Minimax 都有）。
 */

test('向量编解码：Float32 往返不失真（base64 比 JSON 小得多）', () => {
  const values = [0.1, -0.25, 3.5, 0, -1];
  const text = encodeVector(values);
  const back = decodeVector(text);
  assert.equal(back.length, values.length);
  values.forEach((value, index) => assert.ok(Math.abs(back[index]! - value) < 1e-6));
  assert.ok(text.length < JSON.stringify(values).length * 2, 'base64 不该比 JSON 还大');
});

test('向量解码：坏数据返回空向量而不是崩', () => {
  assert.equal(decodeVector('').length, 0);
  assert.equal(decodeVector('not-base64!!').length, 0);
  assert.equal(decodeVector(Buffer.from([1, 2, 3]).toString('base64')).length, 0, '长度不是 4 的倍数');
});

test('余弦相似度：同向 1、反向 -1、正交 0、零向量 0', () => {
  assert.ok(Math.abs(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([2, 0])) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([-1, 0])) + 1) < 1e-6);
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  assert.equal(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1])), 0);
});

test('余弦相似度：维度不一致返回 0（换模型不该给出假高分）', () => {
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])), 0);
});

test('排序：取最相似的前 N 条，低于阈值丢弃', () => {
  const records = [
    { messageId: 'a', hash: 'h', vector: encodeVector([1, 0]), dim: 2, createdAt: 1 },
    { messageId: 'b', hash: 'h', vector: encodeVector([0.8, 0.2]), dim: 2, createdAt: 2 },
    { messageId: 'c', hash: 'h', vector: encodeVector([0, 1]), dim: 2, createdAt: 3 },
  ];
  const ranked = rankBySimilarity([1, 0], records, { limit: 2, minScore: 0.9 });
  assert.deepEqual(ranked.map((item) => item.record.messageId), ['a', 'b']);
  assert.ok(ranked[0]!.score >= ranked[1]!.score);
  assert.deepEqual(rankBySimilarity([0, 1], records, { limit: 5, minScore: 0.99 }).map((item) => item.record.messageId), ['c']);
});

test('索引合并：按 messageId 覆盖，且按上限保留最近的', () => {
  const make = (id: string, createdAt: number) => ({ messageId: id, hash: id, vector: encodeVector([1]), dim: 1, createdAt });
  const merged = mergeEmbeddingRecords([make('a', 1), make('b', 2)], [make('b', 3), make('c', 4)], 10);
  assert.deepEqual(merged.map((item) => item.messageId), ['a', 'b', 'c']);
  assert.equal(merged.find((item) => item.messageId === 'b')!.createdAt, 3, '同一条以新向量为准');
  const capped = mergeEmbeddingRecords([make('a', 1), make('b', 2), make('c', 3)], [], 2);
  assert.deepEqual(capped.map((item) => item.messageId), ['b', 'c']);
});

test('换模型后旧索引作废（不能混用不同语义空间）', () => {
  const index = { version: 1 as const, model: 'embedding-3', records: [{ messageId: 'a', hash: 'h', vector: encodeVector([1, 0]), dim: 2, createdAt: 1 }] };
  assert.equal(reusableRecords(index, 'embedding-3').length, 1);
  assert.equal(reusableRecords(index, 'embo-01').length, 0);
  assert.equal(reusableRecords(undefined, 'embedding-3').length, 0);
});

test('文本哈希：同内容同哈希，改一个字就变', () => {
  assert.equal(contentHash('把胶囊挪到顶部栏'), contentHash('把胶囊挪到顶部栏'));
  assert.notEqual(contentHash('把胶囊挪到顶部栏'), contentHash('把胶囊挪到顶部栏 '));
});

test('向量输入：压空白、截长度，且不切开 emoji', () => {
  assert.equal(embeddingInput('  a\n\n\n\n b  '), 'a\n\nb');
  const long = `${'字'.repeat(1_999)}😀${'尾'.repeat(100)}`;
  const input = embeddingInput(long, 2_000);
  assert.ok(input.length <= 2_000);
  const last = input.charCodeAt(input.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), '结尾不能是半个代理项');
});

test('接口地址：coding 端点要能单独覆盖成 paas', () => {
  assert.equal(embeddingsEndpoint('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/embeddings');
  assert.equal(embeddingsEndpoint('https://open.bigmodel.cn/api/paas/v4/'), 'https://open.bigmodel.cn/api/paas/v4/embeddings');
  assert.equal(embeddingsEndpoint('https://x.test/v1/embeddings'), 'https://x.test/v1/embeddings');
});

test('批量请求：一批 8 条，顺序与入参一致', async () => {
  const bodies: unknown[] = [];
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    bodies.push(body);
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ embedding: [index + 1, 2] })) }), { status: 200 });
  };
  const vectors = await embedTexts(
    { baseUrl: 'https://x.test/v1', model: 'm' },
    'key',
    ['a', 'b', 'c'],
    { fetchImpl: fetchImpl as never },
  );
  assert.deepEqual(vectors, [[1, 2], [2, 2], [3, 2]]);
  assert.equal(chunk([1, 2, 3, 4, 5, 6, 7, 8, 9]).length, 2);
});

test('批量请求：HTTP 失败 → 明确报错（调用方据此退回词面检索）', async () => {
  const fetchImpl = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 });
  await assert.rejects(
    embedTexts({ baseUrl: 'https://x.test/v1', model: 'm' }, 'key', ['a'], { fetchImpl: fetchImpl as never }),
    /401/,
  );
});

test('批量请求：条数不符必须报错（否则索引会错位）', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
  await assert.rejects(
    embedTexts({ baseUrl: 'https://x.test/v1', model: 'm' }, 'key', ['a', 'b'], { fetchImpl: fetchImpl as never }),
    /条数不符/,
  );
});

test('批量请求：Minimax 的 base_resp 业务错误也要认（HTTP 200 但失败）', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ base_resp: { status_msg: 'login fail' } }), { status: 200 });
  await assert.rejects(
    embedTexts({ baseUrl: 'https://x.test/v1', model: 'm' }, 'key', ['a'], { fetchImpl: fetchImpl as never }),
    /login fail/,
  );
});

test('批量请求：没有 Key 直接报错，不发请求', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response('{}', { status: 200 }); };
  await assert.rejects(embedTexts({ baseUrl: 'https://x.test/v1', model: 'm' }, '  ', ['a'], { fetchImpl: fetchImpl as never }));
  assert.equal(called, false);
});

/* ── 「能不能直接调用」探针 ───────────────────────────────────────── */

import { EMBEDDING_MODEL_CANDIDATES, embeddingCandidatesFor, probeEmbeddingCapability } from '../providers/embeddingsProbe';

test('探针：配置档的地址能算向量 → 判定可直接调用，并给出模型与维度', async () => {
  const asked: string[] = [];
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    asked.push(body.model);
    if (body.model === 'deepseek-embed-v4') {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
    }
    return new Response('{"error":{"message":"model not found"}}', { status: 404 });
  };
  const result = await probeEmbeddingCapability({
    endpoint: 'https://api.holysheep.cn/v1/embeddings',
    apiKey: 'k',
    candidates: ['deepseek-embed-v4', ...EMBEDDING_MODEL_CANDIDATES],
    fetchImpl: fetchImpl as never,
  });
  assert.equal(result.usable, true);
  assert.equal(result.model, 'deepseek-embed-v4');
  assert.equal(result.dim, 3);
  assert.deepEqual(asked, ['deepseek-embed-v4'], '第一个候选就成功，不该继续试');
});

test('探针：全部 404 → 明确说「这个配置档没有向量接口」', async () => {
  const fetchImpl = async () => new Response('{}', { status: 404 });
  const result = await probeEmbeddingCapability({
    endpoint: 'https://api.deepseek.com/embeddings',
    apiKey: 'k',
    candidates: ['embedding-3'],
    fetchImpl: fetchImpl as never,
  });
  assert.equal(result.usable, false);
  assert.match(result.summary, /没有向量接口/);
});

test('探针：401 → 说的是「密钥不被接受」，不是「没有接口」', async () => {
  const fetchImpl = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 });
  const result = await probeEmbeddingCapability({
    endpoint: 'https://x.test/v1/embeddings',
    apiKey: 'k',
    candidates: ['embedding-3'],
    fetchImpl: fetchImpl as never,
  });
  assert.equal(result.usable, false);
  assert.match(result.summary, /密钥/);
});

test('探针：HTTP 200 但业务报错（Minimax base_resp）→ 继续试下一个候选', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ base_resp: { status_msg: 'login fail' } }), { status: 200 });
    return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 });
  };
  const result = await probeEmbeddingCapability({
    endpoint: 'https://api.minimax.cn/v1/embeddings',
    apiKey: 'k',
    candidates: ['wrong-model', 'embo-01'],
    fetchImpl: fetchImpl as never,
  });
  assert.equal(result.usable, true);
  assert.equal(result.model, 'embo-01');
  assert.equal(result.attempts.length, 2);
});

test('探针：智谱报「模型不存在」时，说的是你填的那个模型，不是最后一个候选', async () => {
  // 复现用户 2026-11-07 的现场：智谱返回 1211「模型不存在，请检查模型代码」。
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: { code: '1211', message: '模型不存在，请检查模型代码' } }),
    { status: 400 },
  );
  const result = await probeEmbeddingCapability({
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
    apiKey: 'k',
    candidates: ['embedding-3', 'embedding-2'],
    fetchImpl: fetchImpl as never,
  });
  assert.equal(result.usable, false);
  assert.match(result.summary, /embedding-3/, '必须点名用户填的模型');
  assert.match(result.summary, /模型名不对/);
  assert.match(result.summary, /地址和密钥都通过了/, '不是 401/404，就该说清是模型名的问题');
  assert.equal(result.lines.length, 2, '每个候选一行');
  assert.match(result.lines[0] ?? '', /^✗ embedding-3：/);
  assert.match(result.lines[0] ?? '', /1211/, '业务码要带上，1211/1213/1214 含义完全不同');
});

test('探针：智谱各类错误码分别说清（1212 选错模型类型 / 1222 没有接口 / 1315 套餐 Key）', async () => {
  const run = async (code: string, message: string, status = 400) => probeEmbeddingCapability({
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
    apiKey: 'k',
    candidates: ['glm-5.3'],
    fetchImpl: (async () => new Response(JSON.stringify({ error: { code, message } }), { status })) as never,
  });

  const wrongMethod = await run('1212', '当前模型不支持 `embeddings` 调用方式');
  assert.equal(wrongMethod.usable, false);
  assert.match(wrongMethod.summary, /不支持 embeddings 调用/);

  const noEndpoint = await run('1222', 'API `embeddings` 不存在');
  assert.match(noEndpoint.summary, /没有向量接口/, '智谱用 1222 而不是 404 表达「没有这个 API」');

  const planKey = await run('1315', '该 API Key 仅限企业编程套餐场景使用，请到官网更换对应产品类型的 API Key', 429);
  assert.match(planKey.summary, /密钥的类型不对/);
  assert.match(planKey.summary, /按量计费/, '要告诉他换成按量计费的 Key');
});

test('探针：地址认得出是哪家时，不去试别人家的模型名', async () => {
  const asked: string[] = [];
  const fetchImpl = async (_url: string, init: RequestInit) => {
    asked.push((JSON.parse(String(init.body)) as { model: string }).model);
    return new Response('{"error":{"message":"模型不存在"}}', { status: 400 });
  };
  await probeEmbeddingCapability({
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
    apiKey: 'k',
    candidates: embeddingCandidatesFor('https://open.bigmodel.cn/api/paas/v4', 'embedding-3'),
    fetchImpl: fetchImpl as never,
  });
  assert.deepEqual(asked, ['embedding-3', 'embedding-2'], '智谱官方枚举只有这两个');
});

test('探针：DeepSeek 官方没有向量接口，不拿别人的模型名去打它', () => {
  assert.deepEqual(embeddingCandidatesFor('https://api.deepseek.com', 'deepseek-chat'), ['deepseek-chat']);
  assert.deepEqual(embeddingCandidatesFor('https://api.deepseek.com', ''), []);
});

test('探针：认不出的地址仍用通用候选兜底，且用户填的排第一', () => {
  const candidates = embeddingCandidatesFor('https://some-relay.example.com/v1', 'my-embed');
  assert.equal(candidates[0], 'my-embed');
  assert.ok(candidates.includes('embedding-3'));
  assert.equal(new Set(candidates).size, candidates.length, '不许重复');
});

test('探针：没有候选模型时给出可照做的提示', async () => {
  const result = await probeEmbeddingCapability({ endpoint: 'https://x.test/v1/embeddings', apiKey: 'k', candidates: [] });
  assert.equal(result.usable, false);
  assert.match(result.summary, /向量模型/);
});

test('请求体不带 encoding_format（默认就是 float；智谱的 schema 里没有这个字段）', async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
  };
  await embedTexts({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'embedding-3' }, 'k', ['x'], { fetchImpl: fetchImpl as never });
  assert.equal('encoding_format' in body, false, '多带服务商不认识的字段只会换来更难懂的报错');
  assert.equal(body.model, 'embedding-3');
  assert.deepEqual(body.input, ['x']);
});

test('服务商回 base64 向量时也能解析（格式差异不该让整批作废）', async () => {
  const base64 = encodeVector([0.5, -0.25, 0.125]);
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ embedding: base64 }] }), { status: 200 });
  const vectors = await embedTexts({ baseUrl: 'https://x.test/v1', model: 'm' }, 'k', ['x'], { fetchImpl: fetchImpl as never });
  assert.deepEqual(vectors, [[0.5, -0.25, 0.125]]);
});

test('429 限流：后台索引会等待后重试一次（不白丢一批）', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 429 });
    return new Response(JSON.stringify({ data: [{ embedding: [0.5, 0.5] }] }), { status: 200 });
  };
  const vectors = await embedTexts({ baseUrl: 'https://api.holysheep.cn/v1', model: 'deepseek-embed-v4' }, 'k', ['x'], { fetchImpl: fetchImpl as never });
  assert.deepEqual(vectors, [[0.5, 0.5]]);
  assert.equal(calls, 2);
});

test('429 重试一次仍失败 → 明确报错，由调用方静默退回关键词', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 429 });
  };
  await assert.rejects(
    embedTexts({ baseUrl: 'https://api.holysheep.cn/v1', model: 'deepseek-embed-v4' }, 'k', ['x'], { fetchImpl: fetchImpl as never }),
    /429/,
  );
  assert.equal(calls, 2, '只重试一次，不放大压力');
});
