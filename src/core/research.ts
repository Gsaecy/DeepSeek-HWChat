/**
 * 「互联网参考」的纯逻辑层（不 import vscode，方便单测）。
 *
 * 现场需求（用户原话）：「ai 容易自己瞎写，增加一个功能，就是『互联网参考』，
 * 开启后，agent 执行任务时候，需要先搜索网络上的任务相关的项目，对现在的任务
 * 进行优化后再执行。」
 *
 * 三条设计约束，都是踩过坑之后定下来的：
 *
 * 1. **必须有真正的网络能力才叫得响**。只写一句「请先上网搜索」而工具里没有取网页
 *    的通道，模型只会装模作样地写「根据我的经验」——比不加还糟。所以配套提供
 *    `fetch_url` / `search_web` / `search_github_repos` 三个工具（见 agent/webResearch.ts）。
 *
 * 2. **搜索结果是线索，不是依据**。这与作者级技能 `search-before-acting` 的规则一致：
 *    社区问答、博客只用来「想到关键词、找到官方文档的路径」，结论必须落在
 *    能读到原文的一级源（官方文档 / 规范 / 参考实现源码）上，并且要给 URL。
 *
 * 3. **搜不到就说搜不到**。这条是给模型的硬规矩：宁可说「没找到权威方案，这是 2-3 个
 *    候选与代价」，也不许把猜的东西包装成调研结论。
 */

/** 一条检索结果（网页或仓库），字段刻意保持扁平，便于模型直接引用。 */
export interface ResearchHit {
  title: string;
  url: string;
  /** 摘要 / 描述，可能为空。**它是线索，不是结论**。 */
  snippet: string;
  /** 仓库专有：星数，用作「成熟度」的粗略信号。 */
  stars?: number;
  language?: string;
  license?: string;
  updatedAt?: string;
}

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'metadata.google.internal']);

/**
 * 这个 URL 能不能取。
 *
 * 只允许 http/https，并且拒绝回环、内网、链路本地地址与带凭据的 URL。
 * 理由不是「防坏人」，而是防**误伤**：模型在「找资料」时会顺手拼出
 * `http://localhost:3000`（它以为在探测项目）或内网地址，那既取不到东西，
 * 还会把开发服务器的日志刷满。
 */
export function checkFetchableUrl(raw: string): { ok: true; url: string } | { ok: false; reason: 'scheme' | 'host' | 'credentials' | 'invalid' } {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'invalid' };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'credentials' };
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateHost(host)) return { ok: false, reason: 'host' };
  return { ok: true, url: parsed.toString() };
}

/** 回环 / 内网 / 链路本地 / 单标签主机名（不含点）都算私有。 */
export function isPrivateHost(host: string): boolean {
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // 没有点的主机名（如 `intranet`、`mybox`）走的是内网解析，一律拒绝。
  return !host.includes('.');
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

export function decodeEntities(text: string): string {
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-zA-Z#0-9x]+);/g, (match, name: string) => ENTITIES[name] ?? match);
}

function safeCodePoint(code: number): string {
  // 0xD800–0xDFFF 是代理区：单独出现不是一个合法字符（`String.fromCodePoint` 不会报错，
  // 但会产生孤立的半个字符，输出会乱码），直接丢掉。
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * 去标签并解码实体。
 *
 * 顺序很重要：RSS 里的 `description` 经常是把 HTML **转义**过再塞进来的
 * （`&lt;b&gt;正文&lt;/b&gt;`）。先剥标签会把转义文本放过去，解码之后才冒出 `<b>`；
 * 所以这里先解码、再剥标签，两轮就能同时处理「真标签」与「转义标签」。
 */
export function stripTags(html: string): string {
  const decoded = decodeEntities(String(html ?? ''));
  return decodeEntities(decoded.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * HTML → 可读纯文本。
 *
 * 只要「能读懂」而不是「还原排版」：去掉脚本与样式，块级标签换成换行，
 * 再压缩空白。表格与代码块保留内容（它们是文档里最值钱的部分）。
 * 目的很明确 —— 让模型读到**原文**，而不是搜索摘要。
 */
export function htmlToText(html: string, maxChars = 20_000): string {
  let text = String(html ?? '');
  /*
   * <pre> 里的缩进与空行是内容本身（代码、目录树），不能被后面的「压缩空白」吃掉。
   * 做法：先把它抽成占位符，主体按普通 HTML 处理，最后原样放回。
   */
  const blocks: string[] = [];
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const body = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '');
    blocks.push(`\n${body}\n`);
    return `\n\u0000PRE${blocks.length - 1}\u0000\n`;
  });
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|svg|iframe|object|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dd|dt|figure|header|footer|nav|main)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(td|th)>/gi, '\t');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  const restored = text.replace(/\u0000PRE(\d+)\u0000/g, (_match, index: string) => blocks[Number(index)] ?? '');
  const trimmed = restored.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n…（内容过长，已截断到 ${maxChars} 字符）`;
}

/** RSS / Atom 里的 `<item>` / `<entry>`（Bing 的 `format=rss` 走这条）。 */
export function parseFeedItems(xml: string, limit = 8): ResearchHit[] {
  const hits: ResearchHit[] = [];
  const blocks = String(xml ?? '').match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    if (hits.length >= limit) break;
    const title = firstTag(block, 'title');
    const link = firstLink(block);
    if (!link) continue;
    hits.push({ title: title || link, url: link, snippet: firstTag(block, 'description') || firstTag(block, 'summary') });
  }
  return hits;
}

function firstTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  const raw = match[1] ?? '';
  const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (cdata ? cdata[1] ?? '' : stripTags(raw)).replace(/\s+/g, ' ').trim();
}

function firstLink(block: string): string {
  const plain = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (plain && plain[1]) {
    const cdata = plain[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    const value = (cdata ? cdata[1] ?? '' : plain[1]).trim();
    if (/^https?:\/\//i.test(value)) return value;
  }
  const attr = block.match(/<link\b[^>]*href="([^"]+)"/i);
  return attr ? decodeEntities(attr[1] ?? '').trim() : '';
}

interface GitHubRepoJson {
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  stargazers_count?: unknown;
  language?: unknown;
  license?: { spdx_id?: unknown } | null;
  pushed_at?: unknown;
  topics?: unknown;
}

/** GitHub `/search/repositories` 的 JSON → 统一的检索结果。 */
export function parseGitHubRepos(json: unknown, limit = 6): ResearchHit[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const hits: ResearchHit[] = [];
  for (const raw of items.slice(0, limit)) {
    const repo = raw as GitHubRepoJson;
    const fullName = typeof repo.full_name === 'string' ? repo.full_name : '';
    const url = typeof repo.html_url === 'string' ? repo.html_url : '';
    if (!url) continue;
    const license = repo.license && typeof repo.license.spdx_id === 'string' ? repo.license.spdx_id : '';
    const topics = Array.isArray(repo.topics) ? repo.topics.filter((item): item is string => typeof item === 'string').slice(0, 6) : [];
    const description = typeof repo.description === 'string' ? repo.description : '';
    hits.push({
      title: fullName || url,
      url,
      snippet: [description, topics.length ? `topics: ${topics.join(', ')}` : ''].filter(Boolean).join(' · '),
      stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : undefined,
      language: typeof repo.language === 'string' ? repo.language : undefined,
      license: license && license !== 'NOASSERTION' ? license : undefined,
      updatedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at.slice(0, 10) : undefined,
    });
  }
  return hits;
}

/** 把检索结果排成模型好读的清单。 */
export function formatHits(hits: ResearchHit[], label: string): string {
  if (!hits.length) return `${label}: 0 条结果。`;
  const lines = hits.map((hit, index) => {
    const meta = [
      typeof hit.stars === 'number' ? `${hit.stars} ★` : '',
      hit.language ?? '',
      hit.license ? `license: ${hit.license}` : '',
      hit.updatedAt ? `updated ${hit.updatedAt}` : '',
    ].filter(Boolean).join(' · ');
    return [
      `${index + 1}. ${hit.title}`,
      `   ${hit.url}`,
      meta ? `   ${meta}` : '',
      hit.snippet ? `   ${hit.snippet}` : '',
    ].filter(Boolean).join('\n');
  });
  return [`${label}: ${hits.length} 条（摘要只是线索，结论必须读原文）`, ...lines].join('\n');
}

/**
 * 「互联网参考」开启时注入的系统提示词。
 *
 * 写成硬性阶段（调研 → 对齐计划 → 执行），因为「先上网查一下」这种软要求
 * 在真实会话里会被模型跳过：它只要觉得「我知道怎么做」就直接开写了。
 */
export const INTERNET_REFERENCE_PROMPT = [
  'INTERNET REFERENCE IS ON for this conversation. The user turned it on because unverified guesses from memory have been wrong before. Research first, then act.',
  'Phase 1 — research (mandatory, before the first write_file / replace_in_file / run_command that changes something):',
  '  1. Search for related, mature projects and official documentation. Use search_github_repos for prior art (sort by stars, filter by language) and search_web for the concept; use several different query phrasings, including the English technical terms.',
  '  2. Read at least one primary source end to end with fetch_url — official docs, a specification, or a reference implementation. Search snippets and blog posts are only leads for finding that primary source; never treat a snippet as evidence.',
  '  3. Write down what you found before writing code: for each source, its URL, one sentence of conclusion, and how this project differs (version, platform, constraints). Note the gaps where no source covers us.',
  'Phase 2 — align the plan: call update_todos and let the research change it. The first item is the research itself; adjust, reorder, or replace the remaining items so they follow what you learned instead of your first guess.',
  'Phase 3 — implement, following the sources you read. When your approach differs from a source, say why in one sentence.',
  'Hard rules:',
  '  - Never state a technical conclusion without the URL you got it from. If you did not read a source, do not cite it.',
  '  - Do not copy code from a source without checking its license and whether its version and premises match this project.',
  '  - If the search finds nothing usable, say so plainly ("I did not find an authoritative solution") and list 2-3 candidate approaches with their costs, then ask the user to choose — or run the smallest possible experiment. Never disguise a guess as research.',
  '  - Keep the research proportional: for a tiny edit, one focused search and one source is enough; do not spend the whole turn searching.',
].join('\n');

/**
 * 把「互联网参考」拼进系统提示词。
 *
 * 关闭时返回原文，保证关闭状态与以前**逐字节相同**（用户没开这个功能，
 * 提示词就不该有任何变化）。
 */
export function withInternetReference(systemPrompt: string, enabled: boolean): string {
  if (!enabled) return systemPrompt;
  const base = systemPrompt.trimEnd();
  return base ? `${base}\n\n${INTERNET_REFERENCE_PROMPT}` : INTERNET_REFERENCE_PROMPT;
}
