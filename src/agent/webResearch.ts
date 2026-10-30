/**
 * 「互联网参考」的网络工具实现（真正发请求的那一层）。
 *
 * 为什么单独成文件：`toolExecutor.ts` 已经很大，而且这里要处理超时、大小上限、
 * 重定向、UA、错误归类这些与「工具协议」无关的细节，单独放好读也好测。
 *
 * 后端选择是**实测**出来的，不是猜的（2026-10-30）：
 *  - `https://api.github.com/search/repositories` → 200，返回真实仓库（星数/描述/许可证），
 *    正好对应用户说的「搜索网络上的任务相关的项目」；
 *  - `https://raw.githubusercontent.com/...` → 200，可直接读到 README / 源码原文；
 *  - Bing 的 `format=rss` → 200，可解析，但结果会被本地化带偏（中文查询尤其明显），
 *    所以只当「找关键词的线索」，并在输出里明确标注它是线索；
 *  - `html.duckduckgo.com/html/` 与 `lite.duckduckgo.com` → **202 反爬挑战页**，
 *    解析不出结果。所以不做搜索引擎结果页抓取。
 */

import {
  checkFetchableUrl,
  formatHits,
  parseFeedItems,
  parseGitHubRepos,
  ResearchHit,
} from '../core/research';
import { extractReadableContent } from './webExtract';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
/** 单页最多取回的字节数（防一个巨型页面把上下文烧穿）。 */
const MAX_BYTES = 2_000_000;
/** 交给模型的正文上限。 */
const MAX_TEXT_CHARS = 20_000;

export interface WebFetchOutcome {
  ok: boolean;
  /** 给用户看的一行摘要（工具卡片标题）。 */
  summary: string;
  /** 给模型的正文。 */
  content: string;
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - MAX_BYTES))));
      break;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

function describeHttpError(status: number): string {
  if (status === 401 || status === 403) return `HTTP ${status}（可能需要登录或触发了限流）`;
  if (status === 404) return 'HTTP 404（地址不存在，检查 URL 是否拼错）';
  if (status === 429) return 'HTTP 429（请求过于频繁，稍后再试或换一个来源）';
  if (status >= 500) return `HTTP ${status}（对方服务器错误）`;
  return `HTTP ${status}`;
}

/**
 * 取一个 URL 并转成可读文本。
 *
 * 内容类型决定怎么处理：HTML → 去标签正文；JSON / 纯文本 / Markdown → 原样（截断）。
 */
export async function fetchUrl(rawUrl: string, maxChars = MAX_TEXT_CHARS): Promise<WebFetchOutcome> {
  const checked = checkFetchableUrl(rawUrl);
  if (!checked.ok) {
    const reason = checked.reason === 'scheme'
      ? '只支持 http / https 链接'
      : checked.reason === 'host'
        ? '这个地址是本机或内网地址，取不到外部资料'
        : checked.reason === 'credentials'
          ? 'URL 里不能带用户名密码'
          : '这不是一个合法的 URL';
    return { ok: false, summary: '链接不可用', content: `无法读取 ${rawUrl}：${reason}。请换一个公开可访问的地址。` };
  }
  try {
    const response = await request(checked.url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' } }, FETCH_TIMEOUT_MS);
    if (!response.ok) {
      return { ok: false, summary: describeHttpError(response.status), content: `读取 ${checked.url} 失败：${describeHttpError(response.status)}。` };
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const body = await readCapped(response);
    const finalUrl = response.url || checked.url;
    /*
     * HTML 交给正文抽取（defuddle → Markdown），其余类型原样返回。
     *
     * 为什么 HTML 要专门抽取：整页文字里混着导航/侧栏/页脚，作为「参考」的输入
     * 既浪费上下文又容易让模型把导航当正文。抽取失败会回退成整页文本（见
     * `extractReadableContent`），所以这里不需要自己判断「抽得好不好」。
     */
    const extracted = contentType.includes('html')
      ? await extractReadableContent(body, finalUrl, maxChars)
      : null;
    const text = extracted ? extracted.text : body.trim().slice(0, maxChars);
    const title = extracted?.title
      ?? text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 80)
      ?? finalUrl;
    return {
      ok: true,
      summary: `已读取 ${title}`,
      content: [
        `来源：${finalUrl}`,
        contentType ? `类型：${contentType.split(';')[0]}` : '',
        extracted ? `正文抽取：${extracted.via === 'defuddle' ? 'Markdown（已去掉导航/侧栏等噪声）' : '整页文本（未能识别正文，已回退）'}` : '',
        '',
        text || '（这个页面没有可读文本，可能是纯前端渲染的页面；换一个来源试试）',
      ].filter((line) => line !== '').join('\n'),
    };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? `超时（${FETCH_TIMEOUT_MS / 1000} 秒）`
      : error instanceof Error ? error.message : String(error);
    return { ok: false, summary: '读取失败', content: `读取 ${checked.url} 失败：${message}。` };
  }
}

/** 通用网页检索：Bing 的 RSS 输出（可解析、无需抓页面）。 */
export async function searchWeb(query: string, limit = 8): Promise<WebFetchOutcome> {
  const text = String(query ?? '').trim();
  if (!text) return { ok: false, summary: '查询为空', content: 'query 不能为空。' };
  const url = `https://www.bing.com/search?q=${encodeURIComponent(text)}&format=rss&count=${Math.min(Math.max(limit, 1), 20)}`;
  try {
    const response = await request(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5' } }, SEARCH_TIMEOUT_MS);
    if (!response.ok) {
      return { ok: false, summary: describeHttpError(response.status), content: `检索失败：${describeHttpError(response.status)}。改用 search_github_repos 或直接 fetch_url 官方文档。` };
    }
    const hits = parseFeedItems(await readCapped(response), limit);
    return {
      ok: hits.length > 0,
      summary: hits.length ? `网页检索：${hits.length} 条线索` : '网页检索没有结果',
      content: hits.length
        ? `${formatHits(hits, `网页检索「${text}」`)}\n\n提示：这些是**线索**。要下结论，请用 fetch_url 读官方文档或参考实现的原文。`
        : `网页检索「${text}」没有返回结果。换个说法（含英文技术词）再试，或直接用 search_github_repos 找成熟项目。`,
    };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? '超时' : error instanceof Error ? error.message : String(error);
    return { ok: false, summary: '检索失败', content: `网页检索失败：${message}。改用 search_github_repos 或直接 fetch_url。` };
  }
}

/** 找成熟项目：GitHub 仓库搜索（按星数排序）。 */
export async function searchGitHubRepos(query: string, options: { language?: string; sort?: string; limit?: number } = {}): Promise<WebFetchOutcome> {
  const text = String(query ?? '').trim();
  if (!text) return { ok: false, summary: '查询为空', content: 'query 不能为空。' };
  const limit = Math.min(Math.max(options.limit ?? 6, 1), 20);
  const qualifiers = [text];
  if (options.language?.trim()) qualifiers.push(`language:${options.language.trim()}`);
  const sort = options.sort === 'updated' || options.sort === 'best-match' ? options.sort : 'stars';
  const sortParam = sort === 'best-match' ? '' : `&sort=${sort}&order=desc`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(qualifiers.join(' '))}${sortParam}&per_page=${limit}`;
  try {
    const response = await request(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    }, SEARCH_TIMEOUT_MS);
    if (!response.ok) {
      return { ok: false, summary: describeHttpError(response.status), content: `GitHub 检索失败：${describeHttpError(response.status)}。` };
    }
    const parsed = JSON.parse(await readCapped(response)) as unknown;
    const hits: ResearchHit[] = parseGitHubRepos(parsed, limit);
    const total = (parsed as { total_count?: unknown })?.total_count;
    return {
      ok: hits.length > 0,
      summary: hits.length ? `相关项目：${hits.length} 个` : '没有匹配的项目',
      content: hits.length
        ? [
          `${formatHits(hits, `GitHub 上与本任务相关的成熟项目（按${sort === 'updated' ? '最近更新' : '星数'}排序，共 ${typeof total === 'number' ? total : '?'} 个匹配）`)}`,
          '',
          '下一步：挑 1-2 个最贴近的，用 fetch_url 读它的 README（把 /blob/main/ 换成 raw.githubusercontent.com，或直接取仓库主页）看它实际的架构与取舍，再决定借什么。',
        ].join('\n')
        : `GitHub 上没有匹配「${qualifiers.join(' ')}」的项目。放宽关键词（去掉过细的限定词）再试。`,
    };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? '超时' : error instanceof Error ? error.message : String(error);
    return { ok: false, summary: '检索失败', content: `GitHub 检索失败：${message}。` };
  }
}
