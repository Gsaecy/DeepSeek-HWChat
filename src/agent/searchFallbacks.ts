/**
 * 检索「放宽关键词」与「后备来源」的纯函数部分。
 *
 * 现场（用户 2026-11-05/06）：
 *
 *     search_github_repos {"query":"macOS screen recorder ScreenCaptureKit SCStream AVAssetWriter"}
 *     → GitHub 上没有匹配「…」的项目。放宽关键词（去掉过细的限定词）再试。
 *
 *     search_web {"query":"ScreenCaptureKit SCStream screen recording Swift tutorial"}
 *     → 网页检索「…」没有返回结果。
 *
 * 两条都**不是查询写错了**：
 *  1. GitHub 仓库搜索对多个词是 **AND** 语义，六个词全中才算匹配 —— 实测这条查询
 *     `total_count: 0`；而 `ScreenCaptureKit AVAssetWriter` 有 1 个、
 *     `ScreenCaptureKit` 有 780 个。也就是说**放宽一次就有结果**，只是没人去放宽。
 *  2. `search_web` 的后端是 Bing 的 `format=rss`：实测 HTTP 200，但 channel 里
 *     **一个 `<item>` 都没有**（这个口子已经不返回结果了）。于是它对任何查询都说
 *     「没有结果」—— 工具是坏的，不是查询没命中。
 *
 * 所以这里做两件纯函数：把查询按「特异性」逐步放宽，以及定义一组**实测可用**的
 * 后备来源（StackOverflow / HN Algolia 都无需 API key，且对技术问题命中最准）。
 */

/** 一个候选查询及其来源说明（写进结果里，让模型知道放宽到了什么程度）。 */
export interface QueryAttempt {
  query: string;
  /** 人读的标签：`完整关键词` / `按特异性取前 3 个词` / `仅最特征的 1 个词`。 */
  label: string;
}

/**
 * 词的特异性打分：越像「API 名 / 专有名词」越靠前。
 *
 * 判据都是静态可验的，不看语料：
 *  - 中间有大写或数字（`ScreenCaptureKit`、`AVAssetWriter`、`SCStream`、`mp4`）→ 强信号；
 *  - 全大写缩写（`API`、`HDR`）→ 弱一点；
 *  - 罕见分隔符（下划线、点、斜杠）→ 说明是标识符或路径；
 *  - 纯小写常见词（`screen`、`recorder`、`tutorial`）→ 最后。
 */
export function tokenSpecificity(token: string): number {
  const value = token.replace(/^[^\w\u4e00-\u9fff]+|[^\w\u4e00-\u9fff]+$/g, '');
  if (!value) return 0;
  let score = 0;
  // 词中间出现大写 / 数字：API 名或标识符（`ScreenCaptureKit`、`mp4`、`libx264`）。
  if (/[A-Z]/.test(value.slice(1)) || /\d/.test(value)) score += 6;
  // 全大写缩写。
  if (/^[A-Z]{2,}$/.test(value)) score += 5;
  // 标识符特征：下划线、点、斜杠、连字符。
  if (/[_.\-/]/.test(value)) score += 4;
  // 长度：越长的词通常越具体（`tutorial` > `a`）。
  score += Math.min(3, Math.max(0, Math.floor(value.length / 5)));
  return score;
}

/** 中文查询不需要拆词：直接按空白切，中文片段本身就会拿高分（长度）。 */
function tokensOf(text: string): string[] {
  return text.split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

/**
 * 逐步放宽的查询列表：**第一个总是原文**，后面按特异性从高到低收缩。
 *
 * 只产生「至少两个词」的收缩版本以外的最后一级（单字），因为单字查询在仓库搜索里
 * 噪声太大；`minTokens` 控制下限。返回值去重（原文与收缩结果可能相同）。
 */
export function relaxedQueries(text: string, options: { minTokens?: number } = {}): QueryAttempt[] {
  const full = text.replace(/\s+/g, ' ').trim();
  if (!full) return [];
  const minTokens = Math.max(1, options.minTokens ?? 2);
  const tokens = tokensOf(full);
  const attempts: QueryAttempt[] = [{ query: full, label: '完整关键词' }];
  if (tokens.length <= 1) return attempts;

  // 按特异性排序，但**同分保持原顺序**（稳定排序），这样结果可复现。
  const ranked = tokens
    .map((token, index) => ({ token, index, score: tokenSpecificity(token) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.token);

  for (let take = Math.min(3, ranked.length - 1); take >= minTokens; take -= 1) {
    const query = ranked.slice(0, take).join(' ');
    if (attempts.some((attempt) => attempt.query === query)) continue;
    attempts.push({ query, label: `按特征取前 ${take} 个词` });
  }
  return attempts;
}

/** 一种后备检索来源。 */
export interface SearchSource {
  id: string;
  label: string;
  /** 构造请求地址；返回 `undefined` 表示这个来源对这条查询不适用。 */
  url(query: string, limit: number): string | undefined;
  /** 解析响应文本为命中列表。 */
  parse(body: string, limit: number): Array<{ title: string; url: string; snippet: string }>;
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * 实测可用的无 key 来源（2026-11-06 逐条验过）：
 *  - StackOverflow：`api.stackexchange.com/2.3/search/advanced` → 200，命中
 *    「Unable to record screen and system audio … ScreenCaptureKit」「Recorded video looks blurry …
 *    using ScreenCaptureKit」—— 正是「怎么用 SCStream + AVAssetWriter 录屏」要的答案。
 *  - HN Algolia：`hn.algolia.com/api/v1/search` → 200，命中
 *    「Apple contributes to OBS to support screen capture using ScreenCaptureKit」
 *    「Show HN: ScreenCaptureKit-rs …」—— 用来找成熟实现与讨论。
 * 两个都无需注册、无需 key，且对技术关键词命中最准；不放进来源反而只能回「没结果」。
 */
export const KEYLESS_SOURCES: readonly SearchSource[] = [
  {
    id: 'stackoverflow',
    label: 'Stack Overflow',
    url: (query, limit) => `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${Math.min(Math.max(limit, 1), 20)}&filter=default`,
    parse: (body, limit) => {
      const parsed = safeJson(body) as { items?: Array<{ title?: unknown; link?: unknown; tags?: unknown; score?: unknown }> } | undefined;
      const items = Array.isArray(parsed?.items) ? parsed!.items! : [];
      return items.slice(0, limit).flatMap((item) => {
        const url = typeof item.link === 'string' ? item.link : '';
        if (!url) return [];
        const title = decodeEntities(typeof item.title === 'string' ? item.title : url);
        const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [];
        const score = typeof item.score === 'number' ? item.score : undefined;
        return [{ title, url, snippet: [tags.length ? `tags: ${tags.join(', ')}` : '', score === undefined ? '' : `score ${score}`].filter(Boolean).join(' · ') }];
      });
    },
  },
  {
    id: 'hn',
    label: 'Hacker News',
    url: (query, limit) => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${Math.min(Math.max(limit, 1), 20)}`,
    parse: (body, limit) => {
      const parsed = safeJson(body) as { hits?: Array<{ title?: unknown; story_title?: unknown; url?: unknown; objectID?: unknown; points?: unknown; num_comments?: unknown }> } | undefined;
      const hits = Array.isArray(parsed?.hits) ? parsed!.hits! : [];
      return hits.slice(0, limit).flatMap((hit) => {
        const title = typeof hit.title === 'string' ? hit.title : typeof hit.story_title === 'string' ? hit.story_title : '';
        const external = typeof hit.url === 'string' ? hit.url : '';
        const objectID = typeof hit.objectID === 'string' ? hit.objectID : '';
        const url = external || (objectID ? `https://news.ycombinator.com/item?id=${objectID}` : '');
        if (!title || !url) return [];
        const meta = [
          typeof hit.points === 'number' ? `${hit.points} points` : '',
          typeof hit.num_comments === 'number' ? `${hit.num_comments} comments` : '',
        ].filter(Boolean).join(' · ');
        return [{ title, url, snippet: meta }];
      });
    },
  },
];

/**
 * 一个来源要依次尝试的查询。
 *
 * HN Algolia 与 GitHub 一样是**多词 AND** 语义：实测 `ScreenCaptureKit AVAssetWriter`
 * 0 条，而 `ScreenCaptureKit` 有 16 条。所以每个来源都先试原查询，空了再用最放宽的
 * 那一档（只保留最特征的一个 / 两个词）——每条来源最多两次请求，不会失控。
 */
export function sourceQueries(text: string): string[] {
  const attempts = relaxedQueries(text, { minTokens: 1 });
  if (!attempts.length) return [];
  const full = attempts[0]!.query;
  const relaxed = attempts[attempts.length - 1]!.query;
  return relaxed && relaxed !== full ? [full, relaxed] : [full];
}

/**
 * 合并多个来源的命中：按 URL 去重，保留首次出现的顺序。
 *
 * 去重不是为了省字符，而是为了避免同一个 StackOverflow 帖子在三个来源里各出现一次，
 * 让模型误以为「有很多资料」。
 */
export function mergeHits<T extends { url: string }>(lists: ReadonlyArray<readonly T[]>, limit: number): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const list of lists) {
    for (const hit of list) {
      const key = hit.url.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

/** 把 HTML 实体解成字符（StackOverflow 的标题里全是 `&quot;`）。 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}
