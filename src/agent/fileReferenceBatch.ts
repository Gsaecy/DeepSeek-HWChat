/**
 * 正文文件引用的**批量**核实。
 *
 * 现场故障（真实、可复现）：一条总结消息里有几十个裸文件名（`settings.ts`、
 * `chat.css`、`mtime.hwchat-0.2.4.vsix`…）。旧实现为**每一个**裸文件名各做一次
 * `workspace.findFiles`，在 17 根、`--follow` 的工作区里每次约 1.7 秒，
 * 且 76% 是内核 sys 时间；未命中的名字每 10 秒又重搜一次。
 * 结果：消息只是「显示在屏幕上」，整机 CPU 就长期 96–99%，VS Code 卡死。
 *
 * 现在的规则：
 *  1. 先用缓存 + `exists` 做确定性判定，不启动任何搜索；
 *  2. 剩下的裸文件名**合并成一次**搜索（花括号 glob），名字数量有上限；
 *  3. 只有超出上限、或名字含 glob 元字符的少量残留才逐个补搜，
 *     并且**先只搜本项目根**，找不到才扩大到全部根；
 *  4. 命中与未命中都写回缓存——未命中不缓存就等于「每次渲染都重搜一遍」。
 *
 * 不 import `vscode`：搜索与存在性都由调用方注入，所以这里能直接单测
 * 「40 个引用到底发了几次搜索」。
 */

import { basename } from 'node:path';
import { chooseReferenceMatch, filenameSearchName } from './fileReferenceResolve';

/** 一次核实请求里最多处理多少个引用，以及最多合并多少个裸文件名。 */
export const MAX_REFERENCE_ITEMS = 80;
/**
 * 一次核实最多合并多少个裸文件名。
 *
 * 超出的部分**直接降级成普通文本**，不再补搜：一条消息里塞进两百个文件名时，
 * 「保证每个都可点」远不如「不要让扩展宿主卡死」重要。
 */
export const MAX_MERGED_SEARCH_NAMES = 64;
/** 合并搜索的结果上限（每个名字最多保留这么多候选，用于「唯一命中」判定）。 */
export const MERGED_SEARCH_LIMIT_PER_NAME = 50;

export interface ReferenceQuery {
  index: number;
  path: string;
  preferred?: string;
}

export interface ReferenceCacheEntry {
  value?: string;
  at: number;
}

export interface ReferenceCache {
  get(key: string): ReferenceCacheEntry | undefined;
  set(key: string, value: string | undefined): void;
}

export interface ReferenceSearchRequest {
  include: string;
  limit: number;
  /** 只搜这个工作区根（单根内的确定性搜索）。 */
  folder?: string;
}

export interface ResolveReferencesOptions {
  roots: string[];
  /** 未命中的结论有效期；命中永久有效。 */
  missTtlMs: number;
  cache: ReferenceCache;
  exists: (candidate: string) => boolean;
  /** 执行一次搜索，返回命中的绝对路径；失败/取消时返回 undefined。 */
  search: (request: ReferenceSearchRequest) => Promise<string[] | undefined>;
  now?: () => number;
  maxItems?: number;
  maxMergedNames?: number;
}

export function referenceCacheKey(preferred: string | undefined, path: string): string {
  return `${preferred ?? ''}\u0000${path}`;
}

/**
 * 名字能不能塞进合并 glob（花括号列表）。
 *
 * 逗号会破坏列表分隔，花括号会改变展开语义，反斜杠与方括号在 glob 里有特殊含义。
 */
export function isBraceListSafe(name: string): boolean {
  return Boolean(name) && !/[,{}\\[\]]/.test(name);
}

/**
 * 把多个裸文件名合成一个 include 模式。
 *
 * 一个名字时保持原样（`**\/name`），这样它的搜索结果与单搜完全一致。
 */
export function buildMergedInclude(names: readonly string[]): string | undefined {
  const unique = [...new Set(names.filter(isBraceListSafe))];
  if (!unique.length) return undefined;
  if (unique.length === 1) return `**/${unique[0]}`;
  return `**/{${unique.join(',')}}`;
}

/** 规划合并搜索：去重、过滤不安全名字、按上限截断，返回名字与它们覆盖的引用下标。 */
export function planMergedSearch(
  queries: readonly ReferenceQuery[],
  maxNames = MAX_MERGED_SEARCH_NAMES,
): Array<{ name: string; indices: number[] }> {
  const grouped = new Map<string, number[]>();
  for (const query of queries) {
    const name = filenameSearchName(query.path);
    if (!name || !isBraceListSafe(name)) continue;
    const bucket = grouped.get(name);
    if (bucket) bucket.push(query.index);
    else grouped.set(name, [query.index]);
  }
  return [...grouped.entries()]
    .slice(0, Math.max(0, maxNames))
    .map(([name, indices]) => ({ name, indices }));
}

/**
 * 核实一批引用。
 *
 * 最多发两次搜索（与引用个数无关）：
 *   1. 先只在项目根内做一次合并搜索（命中率最高，只扫 1 个根）；
 *   2. 仍未解析的再在整个工作区做一次合并搜索。
 * 名字超过上限、或含 glob 元字符而无法安全合并的，直接降级成普通文本。
 *
 * 返回值与输入等长，`null` 表示「判不出来」。
 */
export async function resolveFileReferences(
  queries: readonly ReferenceQuery[],
  options: ResolveReferencesOptions,
): Promise<Array<string | null>> {
  const now = options.now ?? Date.now;
  const maxItems = options.maxItems ?? MAX_REFERENCE_ITEMS;
  const maxNames = options.maxMergedNames ?? MAX_MERGED_SEARCH_NAMES;
  const limited = queries.slice(0, maxItems);
  const resolved: Array<string | null> = new Array(limited.length).fill(null);

  const remember = (query: ReferenceQuery, value: string | undefined): void => {
    options.cache.set(referenceCacheKey(query.preferred, query.path), value);
  };

  const pending: ReferenceQuery[] = [];
  for (const query of limited) {
    const key = referenceCacheKey(query.preferred, query.path);
    const cached = options.cache.get(key);
    if (cached && (cached.value || now() - cached.at < options.missTtlMs)) {
      resolved[query.index] = cached.value ?? null;
      continue;
    }
    // 确定性命中：直接按项目根/各根拼路径，付一次 existsSync 就够。
    const match = chooseReferenceMatch({
      path: query.path,
      roots: options.roots,
      preferred: query.preferred,
      exists: options.exists,
    });
    if (match) {
      resolved[query.index] = match;
      remember(query, match);
      continue;
    }
    pending.push(query);
  }

  const plan = planMergedSearch(pending, maxNames);
  const plannedIndices = new Set(plan.flatMap((item) => item.indices));

  // 没进合并计划的（超上限 / 名字不安全）只缓存「未解析」，绝不再逐个补搜。
  for (const query of pending) {
    if (plannedIndices.has(query.index)) continue;
    remember(query, undefined);
  }

  let remaining = plan;
  // 阶段 1：只在项目根内搜一次（同一批引用通常都属于同一个项目）。
  const preferredRoot = commonPreferredRoot(pending.filter((query) => plannedIndices.has(query.index)));
  if (remaining.length && preferredRoot) {
    remaining = await searchAndApply(remaining, pending, resolved, {
      ...options,
      search: (request) => options.search({ ...request, folder: preferredRoot }),
    });
  }
  // 阶段 2：仍未解析的，在整个工作区搜一次。
  if (remaining.length) {
    remaining = await searchAndApply(remaining, pending, resolved, options);
  }
  for (const item of remaining) {
    for (const index of item.indices) {
      const query = pending.find((candidate) => candidate.index === index);
      if (query) remember(query, undefined);
    }
  }

  return resolved;
}

/** 同一次请求里所有引用的项目根都相同时才做「只搜项目根」的阶段 1。 */
function commonPreferredRoot(queries: readonly ReferenceQuery[]): string | undefined {
  const roots = new Set(queries.map((query) => query.preferred ?? ''));
  if (roots.size !== 1) return undefined;
  const [root] = [...roots];
  return root || undefined;
}

/**
 * 执行一次合并搜索并回填结果，返回**仍未解析**的条目（供下一阶段继续）。
 */
async function searchAndApply(
  plan: Array<{ name: string; indices: number[] }>,
  pending: readonly ReferenceQuery[],
  resolved: Array<string | null>,
  options: ResolveReferencesOptions,
): Promise<Array<{ name: string; indices: number[] }>> {
  const include = buildMergedInclude(plan.map((item) => item.name));
  if (!include) return plan;
  const hits = await options.search({ include, limit: MERGED_SEARCH_LIMIT_PER_NAME * plan.length })
    .catch(() => undefined);
  const byName = new Map<string, string[]>();
  for (const fsPath of hits ?? []) {
    const name = basename(fsPath);
    const bucket = byName.get(name);
    if (bucket) bucket.push(fsPath);
    else byName.set(name, [fsPath]);
  }

  const unresolved: Array<{ name: string; indices: number[] }> = [];
  for (const item of plan) {
    const matches = byName.get(item.name) ?? [];
    const remainingIndices: number[] = [];
    for (const index of item.indices) {
      const query = pending.find((candidate) => candidate.index === index);
      if (!query) continue;
      const value = chooseReferenceMatch({
        path: query.path,
        roots: options.roots,
        preferred: query.preferred,
        exists: options.exists,
        searchMatches: matches,
      });
      if (!value) {
        remainingIndices.push(index);
        continue;
      }
      resolved[index] = value;
      options.cache.set(referenceCacheKey(query.preferred, query.path), value);
    }
    if (remainingIndices.length) unresolved.push({ name: item.name, indices: remainingIndices });
  }
  return unresolved;
}
