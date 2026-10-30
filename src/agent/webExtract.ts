/**
 * 网页正文抽取：用成熟的爬虫/正文提取库，而不是自己用正则剥标签。
 *
 * 为什么换掉手写实现（用户要求「爬虫功能，参考 GitHub 上高 star 的爬虫开源项目」）：
 * 手写的 `htmlToText()` 只做「去标签 + 解实体」，拿到的是一整页文字 —— 导航、侧栏、
 * 页脚、cookie 提示全在里面。作为「互联网参考」的输入，这些噪声既浪费上下文，
 * 又会让模型把导航文字当成正文。实测同一页（MDN `overflow-anchor`）：
 * 原始 HTML 327KB，手写实现留下整页文字，而 defuddle 抽出 4KB 干净的 Markdown。
 *
 * 选型（2026-10-30 实测 GitHub + npm 真实数据）：
 *  - **defuddle** — 9.8k★、MIT、v0.19.6、最近仍在更新，「Get the main content of any
 *    page as Markdown」，`defuddle/node` 直接吃 HTML 字符串（不需要额外 DOM 依赖）；
 *  - 备选 `@mozilla/readability`（11.5k★、Apache-2.0）需要配 `linkedom`（ISC）才能跑，
 *    两者合计体积更大，且只给 `textContent`（丢掉标题层级 / 链接 / 表格结构）；
 *  - 备选 `html-to-text`（MIT）不做正文提取，噪声问题依旧。
 * 体积代价（实测打包后）：`defuddle/node` +1.3MB。用户明确选了「要正文质量」，
 * 所以接受这个代价；许可证合规见仓库根的 `THIRD-PARTY-NOTICES.md`（由
 * `scripts/third-party-notices.mjs` 按**实际打进包**的依赖自动生成）。
 *
 * 抽取失败或结果过短时**回退**到手写的 `htmlToText()`：有些页面是纯前端渲染的空壳，
 * 正文提取会得到几乎空的 Markdown，那时宁可给模型一整页文字，也不要给空内容。
 */

import { Defuddle } from 'defuddle/node';
import { htmlToText } from '../core/research';

/** 少于这么多字符就认为「正文抽取没抽到东西」，回退到整页文本。 */
export const MIN_EXTRACTED_CHARS = 200;

export type ExtractSource = 'defuddle' | 'text-fallback';

export interface ExtractResult {
  text: string;
  via: ExtractSource;
  /** 页面标题（defuddle 能给出时）。 */
  title?: string;
}

/** 只做截断，不改变内容形态（Markdown 的标题/链接/代码块都保留）。 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…（内容过长，已截断到 ${maxChars} 字符）`;
}

/**
 * 从 HTML 里抽正文并转成 Markdown。
 *
 * 提供 `url` 是因为正文提取会用到它（相对链接补全、按站点规则选正文容器）；
 * 拿不到时也能工作，只是相对链接可能保持原样。
 */
export async function extractReadableContent(html: string, url: string, maxChars: number): Promise<ExtractResult> {
  try {
    const result = await Defuddle(html, url, { markdown: true });
    const markdown = String(result.content || '').trim();
    if (markdown.length >= MIN_EXTRACTED_CHARS) {
      const title = typeof result.title === 'string' ? result.title.trim() : '';
      return { text: truncate(markdown, maxChars), via: 'defuddle', title: title || undefined };
    }
  } catch {
    // 抽取库对畸形 HTML 抛错是正常的：静默回退，不让「参考」功能因为一个坏页面整体失败。
  }
  return { text: htmlToText(html, maxChars), via: 'text-fallback' };
}
