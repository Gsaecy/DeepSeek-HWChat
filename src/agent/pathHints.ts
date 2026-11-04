import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * 路径不存在时，把「真实结构」还给模型，而不是只回一行 `ENOENT`。
 *
 * 真实故障（2026-11-04）：
 *
 *     read_file {"path":"Personal Workstation OS/website/instindex/web/i18n.js"}
 *     → Error: ENOENT: no such file or directory, stat '…/web/i18n.js'
 *
 * 文件其实在 `…/web/assets/i18n.js`。只回错误的话模型只能**再猜一次**，
 * 猜错就撞上「连续 3 轮无进展」停机 —— 用户看到的是「工具老是失败」。
 * 这里做两件事：最近一层真实存在的目录长什么样，以及同名文件在哪。
 */

export interface DirectoryEntryHint {
  name: string;
  directory: boolean;
}

export interface MissingPathHint {
  /** 调用方写的那个路径（原样，便于模型对号）。 */
  requestedPath: string;
  /** 最近一层真实存在的目录（工作区相对路径）。 */
  nearestDir?: string;
  /** 从调用方给的路径往上退了几段。 */
  nearestDepth?: number;
  /** `nearestDir` 下的条目（已排序、已截断）。 */
  entries?: DirectoryEntryHint[];
  /** 同 `nearestDir` 里还有多少条目没列出来。 */
  hiddenCount?: number;
  /** 同一工作区内同名文件的路径（工作区相对路径）。 */
  sameName?: string[];
}

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 从目标路径往上找第一层真实存在的目录，**不越过工作区根**。
 *
 * 返回的 `depth` 是「退了几段」：`web/i18n.js` → `web` 是 1 段。
 */
export function nearestExistingDirectory(
  targetFsPath: string,
  stopAtFsPath: string,
  exists: (candidate: string) => boolean,
): { directory: string; depth: number } | undefined {
  const boundary = resolve(stopAtFsPath);
  if (!within(boundary, targetFsPath)) return undefined;
  let current = dirname(resolve(targetFsPath));
  let depth = 1;
  // 上限只是防御：正常路径不会这么深，出现循环说明入参有问题。
  for (let guard = 0; guard < 256; guard += 1) {
    if (!within(boundary, current)) return undefined;
    if (exists(current)) return { directory: current, depth };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
    depth += 1;
  }
  return undefined;
}

/** 目录条目排序：目录在前，再按名字；便于一眼看出还有哪些子目录可进。 */
export function sortDirectoryHints(entries: DirectoryEntryHint[]): DirectoryEntryHint[] {
  return [...entries].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export interface MissingPathHintText {
  /** i18n 渲染函数，传入 key 与插值。 */
  t: (key: string, values?: Record<string, string | number>) => string;
  /** 用来拼接多行时统一缩进的前缀。 */
  indent?: string;
}

/**
 * 把 `MissingPathHint` 渲染成可直接放进工具结果的文本。
 *
 * 一条都不命中时返回 `undefined` —— 宁可不加提示，也不输出空壳噪声。
 */
export function renderMissingPathHint(hint: MissingPathHint, options: MissingPathHintText): string | undefined {
  const { t } = options;
  const indent = options.indent ?? '  ';
  const lines: string[] = [t('tool.pathNotFound.head', { path: hint.requestedPath })];
  if (hint.nearestDir) {
    lines.push(t('tool.pathNotFound.nearest', { dir: hint.nearestDir, depth: hint.nearestDepth ?? 0 }));
    for (const entry of hint.entries ?? []) {
      lines.push(`${indent}${entry.name}${entry.directory ? '/' : ''}`);
    }
    if (hint.hiddenCount) lines.push(t('tool.pathNotFound.nearestMore', { count: hint.hiddenCount }));
  }
  if (hint.sameName?.length) {
    lines.push(t('tool.pathNotFound.sameName', { count: hint.sameName.length }));
    for (const path of hint.sameName) lines.push(`${indent}${path}`);
  }
  if (!hint.nearestDir && !hint.sameName?.length) return undefined;
  lines.push(t('tool.pathNotFound.advice'));
  return lines.join('\n');
}
