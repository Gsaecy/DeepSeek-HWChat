/**
 * 回复里的**远程图片**：识别出来，交给面板代下载，再本地呈现。
 *
 * 为什么不让 webview 直接去取（用户 2026-11-04 的决定：保持严格）：
 * 那样等于告诉外部主机「有人正在看这条对话」，还会带上 webview 自己的来源信息。
 * 改成面板下载之后，请求走用户配置的代理、用扩展自己的身份、有时间与体积上限，
 * 而且 CSP 可以继续保持 `img-src ${webview.cspSource} data:` —— 一条口子都不开。
 */

export interface RemoteImageRef {
  alt: string;
  url: string;
}

/** 单条消息里最多代下载几张：再多只会拖慢首屏，也更容易撞上对方限流。 */
export const REMOTE_IMAGE_LIMIT = 4;

const IMAGE_URL = /!\[([^\]\n]*)\]\(\s*<?(https:\/\/[^)\s>]+)>?\s*(?:"[^"]*")?\s*\)/g;

/**
 * 找出正文里的远程图片（只认 https，按 URL 去重）。
 *
 * 不认 `data:` 与本地路径：前者不需要下载，后者由 `resolveLocalImage` 处理。
 * 也不认明文 `http://` —— 与项目里其余远程请求同一条底线。
 */
export function findRemoteImages(content: string | undefined, limit = REMOTE_IMAGE_LIMIT): RemoteImageRef[] {
  if (!content || !content.includes('https://')) return [];
  const found: RemoteImageRef[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(IMAGE_URL)) {
    const url = (match[2] ?? '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    found.push({ alt: (match[1] ?? '').trim(), url });
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * 按 URL 改写正文里的远程图片。
 *
 * `map` 返回**替换用的 markdown 片段**：
 *  - 拿到本地文件时返回 `![说明](webview 地址)`，图片照常显示；
 *  - 正在下载 / 下载失败时返回一段纯文本（`正在下载图片…` / `图片未能加载（host）`），
 *    这样用户看到的是可读说明，而不是一个既没有原因也没有地址的破图框；
 *  - 返回 `undefined` 表示保持原样。
 */
export function replaceRemoteImages(
  content: string | undefined,
  map: (url: string, alt: string) => string | undefined,
): string | undefined {
  if (!content || !content.includes('https://')) return content;
  return content.replace(IMAGE_URL, (whole, alt: string, rawUrl: string) => {
    const replacement = map((rawUrl ?? '').trim(), (alt ?? '').trim());
    return replacement === undefined ? whole : replacement;
  });
}

/** 只取主机名用于提示：完整地址太长，放进正文会挤满一行。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export interface RemoteImageAttachment {
  sourceUrl?: string;
  path?: string;
}

export interface RemoteImageResolution {
  /** 附件的 `sourceUrl` → 本地文件路径（面板下载成功后记下的）。 */
  attachments: readonly RemoteImageAttachment[];
  /** 这条 URL 的下载状态；undefined 表示还没开始下载。 */
  state: (url: string) => 'loading' | 'ready' | 'failed' | undefined;
  /** 本地文件路径 → 可显示的 webview 地址。 */
  toWebviewUri: (path: string) => string | undefined;
  text: {
    downloading: (host: string) => string;
    failed: (host: string) => string;
  };
}

/**
 * 把正文里的远程图片按「已下载 / 下载中 / 失败」翻成最终要显示的内容。
 *
 * 抽成纯函数的原因：三条分支都必须能单独验证，而面板方法要拿 `webview.asWebviewUri`，
 * 在单测里拿不到。这里只用调用方注入的两个回调，逻辑全在纯函数里。
 */
export function resolveRemoteImages(
  content: string | undefined,
  resolution: RemoteImageResolution,
): string | undefined {
  if (!content || !content.includes('https://')) return content;
  const localByUrl = new Map<string, string>();
  for (const attachment of resolution.attachments) {
    if (attachment.sourceUrl && attachment.path) localByUrl.set(attachment.sourceUrl, attachment.path);
  }
  return replaceRemoteImages(content, (url, alt) => {
    const path = localByUrl.get(url);
    if (path) {
      const src = resolution.toWebviewUri(path);
      // 附件在、但文件被删了 / 拿不到地址：退回「失败」而不是漏出一条远程地址。
      if (src) return `![${alt || 'image'}](${src})`;
      return resolution.text.failed(hostOf(url));
    }
    return resolution.state(url) === 'failed'
      ? resolution.text.failed(hostOf(url))
      : resolution.text.downloading(hostOf(url));
  });
}
