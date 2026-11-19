import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchUrl } from '../agent/webResearch';

/**
 * `fetch_url` 的失败分类。
 *
 * 真实故障（2026-11-19）：模型连着猜了四个 learn.microsoft.com 的文档路径，全部 404，
 * 每轮只拿到「检查 URL 是否拼错」，它唯一能做的就是再猜一个 —— 三轮之后整轮任务
 * 被判「连续 3 轮工具调用全部失败」停机。404 是服务器给出的**确定答案**，
 * 既不是环境故障，也不该让 agent 停下。
 */

const safeResolve = async () => ({ ok: true } as const);
const status = (code: number) => new Response('', { status: code });

test('404：标记为确定答案，并明确要求改用检索而不是继续猜路径', async () => {
  const result = await fetchUrl('https://learn.microsoft.com/en-us/windows/apps/publish/unpublish-app', 2000, {
    resolveHost: safeResolve,
    fetchImpl: (async () => status(404)) as never,
  });
  assert.equal(result.ok, false);
  assert.equal(result.decisive, true);
  assert.match(result.content, /search_web/, '要给下一步，而不是只让模型再猜');
  assert.match(result.content, /不要再凭印象猜/);
  assert.match(result.content, /learn\.microsoft\.com/, '文档站要额外说明路径猜不中');
});

test('403 / 410 同样是确定答案（重试同样的地址没有意义）', async () => {
  for (const code of [403, 410, 400]) {
    const result = await fetchUrl('https://example.com/x', 2000, {
      resolveHost: safeResolve,
      fetchImpl: (async () => status(code)) as never,
    });
    assert.equal(result.decisive, true, `HTTP ${code} 不该计入失败连击`);
  }
});

test('500 / 429 / 408 仍算环境故障（稍后确实可能成功）', async () => {
  for (const code of [500, 503, 429, 408]) {
    const result = await fetchUrl('https://example.com/x', 2000, {
      resolveHost: safeResolve,
      fetchImpl: (async () => status(code)) as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.decisive, undefined, `HTTP ${code} 应保持为可选重试的环境错误`);
  }
});

test('正常页面不受影响（多出的字段只是可选的）', async () => {
  const result = await fetchUrl('https://example.com/ok', 2000, {
    resolveHost: safeResolve,
    fetchImpl: (async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })) as never,
  });
  assert.equal(result.ok, true);
  assert.equal(result.decisive, undefined);
  assert.match(result.content, /hello/);
});
