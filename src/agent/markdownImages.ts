/**
 * 正文里 markdown 图片地址的处理。
 *
 * 抽成纯函数是因为两件事要分开验证：**哪些写法算图片引用**（正则）与
 * **哪些地址可以被换成 webview 资源**（调用方给的映射）。面板侧只负责提供
 * 「本地路径 → asWebviewUri」的映射，正则边界不该散落在 4600 行的面板文件里。
 */

/**
 * markdown 图片的两种写法：`![alt](路径)` 与 `![alt](<带 空格 的路径>)`。
 *
 * 为什么必须支持尖括号：多根工作区里图片路径天然带空格
 * （`<Personal Workstation OS/tmp/x.png>`）。旧正则用 `[^)\s]+` 取地址，
 * 遇到空格就整条不匹配 —— 模型写对了，面板却当成文字显示（用户 2026-11-04 连报三次）。
 */
const IMAGE_LINK = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))\s*(?:"[^"]*")?\s*\)/g;

/** `%20` → 空格（只处理路径里合法的编码，解析失败就原样用）。 */
function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const LOCAL_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/**
 * 判断一个路径是否可能是图片文件（按扩展名）。
 *
 * 只用于「值得去磁盘确认一下」的前置筛选：不在这里判断文件存在与否，也不接受
 * 带查询串的地址 —— 工作区里的图片路径不会有 `?v=1` 这种写法。
 */
export function isImagePath(value: string): boolean {
  const path = value.trim();
  if (!path) return false;
  if (path.includes('?') || path.includes('#')) return false;
  return LOCAL_IMAGE_EXTENSIONS.test(path);
}

/**
 * 把正文中的**本地**图片引用改写一遍；`map` 返回 `undefined` 表示保持原样。
 *
 * 三种写法都认：`![alt](a.png)`、`![alt](a.png "标题")`、`![alt](<a b.png>)`
 * （路径带空格时 markdown 要求用尖括号包起来）。
 *
 * 带 scheme 的地址（`data:`、`https:`、`vscode-*:`）原样返回交给前端白名单判断：
 * 这里若是替模型「猜」该不该放行，就等于把渲染层的安全策略复制了一份，两边会漂移。
 */
export function rewriteMarkdownImagePaths(
  content: string | undefined,
  map: (src: string) => string | undefined,
): string | undefined {
  if (!content || !content.includes('![')) return content;
  return content.replace(IMAGE_LINK, (whole, alt: string, angleSrc: string, plainSrc: string) => {
    const raw = (angleSrc ?? plainSrc ?? '').trim();
    if (!raw) return whole;
    // 带 scheme 的（data:、https:、vscode-*:）交给前端白名单判断，这里不猜。
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return whole;
    // `%20` 是 URL 编码里的空格：反解回来才能在工作区里找到那个文件。
    const src = decodePath(raw);
    const replacement = map(src);
    return replacement ? `![${alt}](${replacement})` : whole;
  });
}

/**
 * 确认一个候选路径确实是工作区内的图片文件。
 *
 * 纯函数，`exists` / `insideWorkspace` 由调用方注入：这样「越界路径一律拒绝」
 * 这条规则可以在没有工作区、没有文件系统的测试里被验证。
 */
export function resolveLocalImage(
  input: string,
  options: {
    roots: readonly string[];
    isAbsolute: (path: string) => boolean;
    resolvePath: (root: string, path: string) => string;
    insideWorkspace: (path: string) => boolean;
    exists: (path: string) => boolean;
  },
): string | undefined {
  const value = input.trim();
  if (!value || !isImagePath(value) || !options.roots.length) return undefined;
  const candidates = options.isAbsolute(value)
    ? [value]
    : options.roots.map((root) => options.resolvePath(root, value));
  for (const candidate of candidates) {
    if (!options.insideWorkspace(candidate)) continue;
    if (options.exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 回复里「提到了某个本地图片」却没有把它嵌进去时，补一行 `![说明](地址)`。
 *
 * 现场（用户 2026-11-04）：让 agent 画一张原理图，它确实生成了
 * `tmp/enterprise-agent-architecture/architecture.svg`（和 `.svg.png`），回复里也写了
 * 这个路径，但只写成反引号路径 +「已在编辑器打开」。用户在对话里什么也没看到，
 * 得到的结论是「图片输出功能没成功」。
 *
 * 为什么不改存档、只在下发副本上补：这是**呈现层**的兜底，重算结果恒定（同一份正文
 * 每次得到同样的图），存档里保留模型原文，刷新/换窗口后依然一致。
 *
 * 幂等靠「已存在的图片地址」判断：补进去的地址来自 `resolve`，下次算出同一个，
 * 于是不会重复追加。
 *
 * @param resolve 把正文里的路径解析成可显示的地址（工作区内真实存在的图片才返回）
 */
export function embedMentionedImages(
  content: string | undefined,
  resolve: (path: string) => string | undefined,
  limit = 3,
): string | undefined {
  if (!content || content.length > 60_000) return content;
  const embedded = new Set<string>();
  // 捕获到右括号为止（而不是到空白）：路径本身可能带空格（`<a b.png>` 或未编码的
  // webview 地址），按空白截断会把同一张图认成另一张，于是反复追加。
  for (const match of content.matchAll(/!\[[^\]\n]*\]\(\s*<?([^)>]+?)>?\s*\)/g)) {
    embedded.add(match[1] ?? '');
  }
  // 只认「像路径」的写法：可带 ./ 或 ../ 前缀，允许子目录，扩展名必须是图片。
  /*
   * 路径可能带空格（`<Personal Workstation OS/tmp/x.png>`）：先匹配尖括号里的整段，
   * 再匹配普通的不含空白写法。空格路径只取「从某个工作区根名开始」的整段交给
   * `resolve` 去判断，判断不了就不会嵌 —— 不会凭空造图。
   */
  const candidate = /(?:^|[\s`("'（[<])(?:<([^>\n]+\.(?:png|jpe?g|gif|webp|bmp|avif|svg))>|((?:\.{1,2}\/)?[\w\u4e00-\u9fa5.@+\-/]+\.(?:png|jpe?g|gif|webp|bmp|avif|svg)))(?=[\s`)"'）\],。；;:]|$)/g;
  const appended: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(candidate)) {
    if (appended.length >= limit) break;
    const path = (match[1] ?? match[2] ?? '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const src = resolve(path);
    if (!src || embedded.has(src)) continue;
    embedded.add(src);
    const label = path.split('/').pop() ?? path;
    appended.push(`![${label}](${src})`);
  }
  if (!appended.length) return content;
  return `${content.replace(/\s+$/, '')}\n\n${appended.join('\n\n')}`;
}

/**
 * 把回复里**已经是 webview 资源地址**的图片重新解析成「工作区文件 → 规范地址」。
 *
 * 为什么需要（真实事故 2026-11-04）：模型看到上一轮回复里的地址后，会照着抄一份
 * `https://file%2B.vscode-resource.vscode-cdn.net/...`。这种地址带着宿主进程才知道的
 * 授权口径，模型抄错一个字符（`%2B` / `+` / 少个前缀）就是一张破图，而且没法诊断。
 *
 * 所以凡是能反解回**工作区内真实文件**的，一律换成宿主自己用 `asWebviewUri` 生成的
 * 规范地址 —— 那是唯一保证能加载的形式。反解不出来的（工作区外的文件、编码对不上）
 * 原样保留，交给渲染层白名单判断。
 */
export function rehostWebviewImageUrls(
  content: string | undefined,
  map: (localPath: string) => string | undefined,
): string | undefined {
  if (!content || !content.includes('vscode-cdn.net')) return content;
  const pattern = /!\[([^\]\n]*)\]\(\s*<?(https:\/\/(?:file(?:\+|%2B)\.vscode-resource\.|[a-z0-9-]+\.)?vscode-cdn\.net\/[^)\s>]+)>?\s*(?:"[^"]*")?\s*\)/gi;
  return content.replace(pattern, (whole, alt: string, url: string) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(url).pathname);
    } catch {
      return whole;
    }
    // Windows 的绝对路径在 URL 里长成 `/c:/Users/...`。
    const localPath = /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    const replacement = map(localPath);
    return replacement ? `![${alt}](${replacement})` : whole;
  });
}
