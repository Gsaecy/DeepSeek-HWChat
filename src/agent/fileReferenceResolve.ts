/**
 * 「正文里提到的这个文件，到底是磁盘上的哪个文件」的判定层。
 *
 * 为什么需要这一层：模型写出来的 `extension.js` 只是一个**裸文件名**。
 * 它可能是根目录下的文件，可能是 `out/extension.js`，也可能根本不存在
 * （只是在说「这个打包产物里的中文被转义了」）。原来的做法是「按扩展名
 * 认下来、直接拼到项目根上」，于是 `extension.js` 被渲染成一个可以右键的
 * 引用，点开却报「文件不存在」——比不给引用更糟：用户会以为自己点错了。
 *
 * 这里的规则是**先确定、再猜、猜不准就不认**：
 *  1. 绝对路径 → 只认它本身；
 *  2. 带目录的相对路径 → 依次试项目根与各工作区根（确定性，与原行为等价）；
 *  3. 裸文件名 → 也先按根目录拼（`package.json`、`README.md` 就在根上），
 *     拼不到才去整棵树里按文件名搜，而且**只有唯一命中才算数**。
 *     猜错文件比不给引用更糟，所以同名多份时宁可降级成普通文本。
 *
 * 不 import vscode：命中集合由调用方用 `workspace.findFiles` 取来喂进来，
 * 存在性也由调用方以 `exists` 注入。这样 node:test 能覆盖
 * 「同名多份不认」这类判断，不用启动编辑器。
 */

import { posix, win32 } from 'node:path';
import { isInsideWorkspace } from './fileReveal';

/** 路径分隔符判定：两种都认，模型的输出里两种都可能出现。 */
function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

/** 绝对路径（POSIX `/x` 或 Windows `C:\x` / `C:/x`）。 */
export function isAbsoluteReferencePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value);
}

/**
 * 裸文件名：不含任何目录分隔符，也不是绝对路径。
 *
 * 只有这一种情况才允许「整棵树按文件名搜」——带目录的相对路径已经有明确的
 * 定位依据，再去搜反而会把 `src/a.ts` 匹配到另一个目录里的同名文件。
 */
export function isBareBasename(value: string): boolean {
  if (!value || isAbsoluteReferencePath(value)) return false;
  if (/[\\/]/.test(value)) return false;
  // `.` / `..` 是目录而不是文件名。
  if (value === '.' || value === '..') return false;
  return true;
}

/**
 * 文件名能不能安全地拼进 glob 模式。
 *
 * `findFiles` 的 include 模式里，方括号是字符集：写 `a[1].ts` 会把搜索范围
 * 扩大到 `a1.ts` 之类的无关文件，甚至搜出一堆同名结果、白白触发「不唯一」而降级。
 * 所以带 glob 元字符的名字一律不搜，只当普通路径处理。
 */
export function isGlobSafeName(value: string): boolean {
  return !/[*?[\]{}()!]/.test(value);
}

/**
 * 允许按文件名搜索时返回要搜的名字，否则 `undefined`。
 *
 * 这一层单独存在，是为了让调用方在「确定性候选都不存在」之后，
 * 先问一句「值不值得去搜」，再决定要不要付 `findFiles` 的代价。
 */
export function filenameSearchName(value: string): string | undefined {
  if (!isBareBasename(value)) return undefined;
  if (!isGlobSafeName(value)) return undefined;
  return value;
}

/**
 * 相对路径的候选绝对路径，按优先级排列。
 *
 * 项目根优先：多根工作区里，`src/a.ts` 更可能属于当前对话绑定的那个项目，
 * 而不是碰巧排在第一位的根。重复项去掉，避免对同一个候选做两次 fs 判断。
 */
export function referenceCandidatePaths(
  value: string,
  roots: readonly string[],
  preferred?: string,
): string[] {
  const api = process.platform === 'win32' ? win32 : posix;
  const clean = value.replace(/^\.\//, '');
  const ordered: string[] = [];
  if (preferred) ordered.push(preferred);
  for (const root of roots) if (root) ordered.push(root);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const root of ordered) {
    const candidate = api.join(root, clean);
    // Windows 上大小写不敏感，`C:/A` 与 `c:/a` 是同一个候选。
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * 从同名搜索结果里挑出**唯一**的那一个。
 *
 * 多于一个就返回 `undefined`：这时没有任何依据说明用户指的是哪一个，
 * 随便挑一个会把引用指向无关文件。重复项（大小写不同的同一路径）先合并，
 * 否则 Windows 上同一个文件会被算成两份。
 */
export function pickUniqueMatch(matches: readonly string[], platform: string = process.platform): string | undefined {
  const unique = new Map<string, string>();
  for (const match of matches) {
    if (!match) continue;
    const key = platform === 'win32' ? match.toLowerCase() : match;
    if (!unique.has(key)) unique.set(key, match);
  }
  if (unique.size !== 1) return undefined;
  return [...unique.values()][0];
}

/** 候选命中是否应当被采纳：必须落在某个工作区内，否则无从相对化也无从定位。 */
function acceptable(candidate: string, roots: readonly string[], platform: string): boolean {
  if (roots.length === 0) return true;
  return isInsideWorkspace(candidate, roots, platform);
}

export interface ChooseReferenceMatchInput {
  /** 正文里的原始写法：可能是绝对路径、相对路径或裸文件名。 */
  path: string;
  roots: readonly string[];
  preferred?: string;
  platform?: string;
  /** 存在性判断，由调用方注入（扩展侧是 `existsSync`，测试里是假数据）。 */
  exists: (candidate: string) => boolean;
  /** 同名搜索的结果（绝对路径）。不传就表示「不许搜」。 */
  searchMatches?: readonly string[];
}

/**
 * 给出这条引用指向的真实文件；判定不了时返回 `undefined`。
 *
 * 返回 `undefined` 的调用方约定是「不要渲染成引用」——降级成普通文本，
 * 用户看到的还是原文，只是没有右键菜单，不会点开一个不存在的路径。
 */
export function chooseReferenceMatch(input: ChooseReferenceMatchInput): string | undefined {
  const platform = input.platform ?? process.platform;
  const path = input.path?.trim() ?? '';
  if (!path) return undefined;

  if (isAbsoluteReferencePath(path)) {
    if (!input.exists(path)) return undefined;
    return acceptable(path, input.roots, platform) ? path : undefined;
  }

  for (const candidate of referenceCandidatePaths(path, input.roots, input.preferred)) {
    if (input.exists(candidate)) return candidate;
  }

  // 只有裸文件名才去搜：带目录的路径已经有定位依据，再搜会张冠李戴。
  if (!filenameSearchName(path)) return undefined;
  const match = pickUniqueMatch(input.searchMatches ?? [], platform);
  if (!match) return undefined;
  if (!input.exists(match)) return undefined;
  return acceptable(match, input.roots, platform) ? match : undefined;
}
