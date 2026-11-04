/**
 * 正文里 markdown 图片地址的处理。
 *
 * 抽成纯函数是因为两件事要分开验证：**哪些写法算图片引用**（正则）与
 * **哪些地址可以被换成 webview 资源**（调用方给的映射）。面板侧只负责提供
 * 「本地路径 → asWebviewUri」的映射，正则边界不该散落在 4600 行的面板文件里。
 */

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
  return content.replace(/!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?\s*(?:"[^"]*")?\s*\)/g, (whole, alt: string, src: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return whole;
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
