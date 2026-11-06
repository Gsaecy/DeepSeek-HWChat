/**
 * 检索放宽与多来源合并。
 *
 * 现场（用户 2026-11-05/06，两条连着）：
 *
 *     search_github_repos {"query":"macOS screen recorder ScreenCaptureKit SCStream AVAssetWriter"}
 *     → GitHub 上没有匹配「…」的项目。
 *     search_web {"query":"ScreenCaptureKit SCStream screen recording Swift tutorial"}
 *     → 网页检索「…」没有返回结果。
 *
 * 实测：GitHub 这条查询 `total_count: 0`（六词 AND），但 `ScreenCaptureKit AVAssetWriter`
 * 有 1 个、`ScreenCaptureKit` 有 780 个；Bing 的 `format=rss` 返回 200 却一条 `<item>` 都没有，
 * 而 Stack Overflow / HN Algolia 两个无 key 来源都能命中同一主题。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeEntities,
  KEYLESS_SOURCES,
  mergeHits,
  relaxedQueries,
  tokenSpecificity,
} from '../agent/searchFallbacks';

const USER_QUERY = 'macOS screen recorder ScreenCaptureKit SCStream AVAssetWriter';

test('API 名比普通英文词更「特征」', () => {
  assert.ok(tokenSpecificity('ScreenCaptureKit') > tokenSpecificity('screen'));
  assert.ok(tokenSpecificity('AVAssetWriter') > tokenSpecificity('recorder'));
  assert.ok(tokenSpecificity('mp4') > tokenSpecificity('video'));
});

test('放宽列表：第一个永远是原文', () => {
  const attempts = relaxedQueries(USER_QUERY);
  assert.equal(attempts[0]?.query, USER_QUERY);
  assert.equal(attempts[0]?.label, '完整关键词');
});

test('放宽列表优先保留最像 API 的词', () => {
  const attempts = relaxedQueries(USER_QUERY);
  const three = attempts.find((attempt) => attempt.label.includes('前 3 个词'));
  assert.ok(three, JSON.stringify(attempts));
  for (const api of ['ScreenCaptureKit', 'AVAssetWriter']) {
    assert.ok(three!.query.includes(api), `放宽后应保留 ${api}：${three!.query}`);
  }
  assert.ok(!three!.query.includes('tutorial'), '普通词应被先丢掉');
});

test('放宽列表逐级收缩且不重复', () => {
  const attempts = relaxedQueries(USER_QUERY);
  const queries = attempts.map((attempt) => attempt.query);
  assert.equal(new Set(queries).size, queries.length, '不能有重复候选');
  assert.ok(attempts.length >= 2 && attempts.length <= 4, String(attempts.length));
});

test('单词查询没有可放宽的余地', () => {
  assert.deepEqual(relaxedQueries('ScreenCaptureKit').map((attempt) => attempt.query), ['ScreenCaptureKit']);
});

test('空查询不产生候选', () => {
  assert.deepEqual(relaxedQueries('   '), []);
});

test('合并命中：按 URL 去重且保留首次出现的顺序', () => {
  const merged = mergeHits([
    [{ url: 'https://a/1', title: 'A1' }, { url: 'https://b/2', title: 'B2' }],
    [{ url: 'https://b/2/', title: 'B2 dup' }, { url: 'https://c/3', title: 'C3' }],
  ], 10);
  assert.deepEqual(merged.map((hit) => hit.url), ['https://a/1', 'https://b/2', 'https://c/3']);
});

test('合并命中遵守上限', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ url: `https://x/${index}` }));
  assert.equal(mergeHits([many], 3).length, 3);
});

test('Stack Overflow 解析：标题解实体、保留链接与标签', () => {
  const source = KEYLESS_SOURCES.find((item) => item.id === 'stackoverflow')!;
  const body = JSON.stringify({
    items: [{
      title: 'Unable to record screen &amp; audio with ScreenCaptureKit',
      link: 'https://stackoverflow.com/questions/1',
      tags: ['swift', 'screencapturekit'],
      score: 7,
    }],
  });
  const hits = source.parse(body, 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.title, 'Unable to record screen & audio with ScreenCaptureKit');
  assert.match(hits[0]!.snippet, /screencapturekit/);
});

test('HN 解析：没有外链时退回讨论页', () => {
  const source = KEYLESS_SOURCES.find((item) => item.id === 'hn')!;
  const body = JSON.stringify({ hits: [{ title: 'Show HN: ScreenCaptureKit-rs', objectID: '123', points: 42 }] });
  const hits = source.parse(body, 5);
  assert.equal(hits[0]?.url, 'https://news.ycombinator.com/item?id=123');
  assert.match(hits[0]!.snippet, /42 points/);
});

test('来源解析对坏 JSON 不抛错（返回空）', () => {
  for (const source of KEYLESS_SOURCES) {
    assert.deepEqual(source.parse('<html>not json</html>', 5), [], source.id);
  }
});

test('两个来源都构造出真实可用的地址', () => {
  for (const source of KEYLESS_SOURCES) {
    const url = source.url('ScreenCaptureKit AVAssetWriter', 6);
    assert.ok(url && /^https:\/\//.test(url), source.id);
    assert.ok(!/\s/.test(url!), `${source.id} 的 URL 必须编码：${url}`);
  }
});

test('实体解码覆盖问答标题里常见的那几个', () => {
  assert.equal(decodeEntities('a &quot;b&quot; &amp; c &#39;d&#39; &lt;e&gt;'), `a "b" & c 'd' <e>`);
});
