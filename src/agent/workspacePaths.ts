import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { tt } from '../core/i18n';

export interface WorkspaceRootLike {
  name: string;
  fsPath: string;
}

export interface ResolvedWorkspacePath<T extends WorkspaceRootLike = WorkspaceRootLike> {
  root: T;
  fsPath: string;
}

export interface ResolveWorkspacePathOptions<T extends WorkspaceRootLike = WorkspaceRootLike> {
  /**
   * 可选的同步存在性探测，只用于在多根工作区里消解相对路径的歧义。
   *
   * - 不提供时保持旧行为：相对路径一律解析到第一个工作区根目录。
   * - 提供时：在所有根目录下探测，唯一存在的那一个胜出。
   * - 全部不存在时仍回退到第一个根目录，因为写入新文件依赖这一点。
   */
  exists?: (fsPath: string) => boolean;
  /**
   * 本次对话绑定的项目根（必须来自 `roots`）。
   *
   * 多根工作区里相对路径的归属只能靠推断，而「推断」以前固定收敛到第一个根目录：
   * 在 DeepSeek-HWChat 里说「提交一下」，`cwd` 默认是 `'.'`，结果命令落到排在第一
   * 位的另一个项目里执行。传入这次对话所属的项目根后：
   * 1. `.` 直接解析成该项目根，而不是 `roots[0]`；
   * 2. 多根同时存在同名文件时，优先取该项目根下的那一份；
   * 3. 相对路径都不存在时，仍在项目根下创建，而不是落到第一个根。
   */
  preferredRoot?: T;
}

export function resolveWorkspacePath<T extends WorkspaceRootLike>(
  input: string,
  roots: readonly T[],
  options: ResolveWorkspacePathOptions<T> = {},
): ResolvedWorkspacePath<T> {
  if (!roots.length) throw new Error(tt('path.noWorkspace'));
  const value = input?.trim() || '.';
  const absoluteCandidate = isAbsolute(value) ? resolve(value) : undefined;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const preferred = preferredRootOf(roots, options.preferredRoot);

  if (!absoluteCandidate) {
    // 0) 项目根优先：`.` 表示「本次对话所属项目」，不再是「第一个工作区根」。
    if (preferred && normalized === '.') {
      return { root: preferred, fsPath: resolve(preferred.fsPath) };
    }

    // 1) 显式书写根目录名是最明确的意图，优先命中。
    for (const root of roots) {
      const selectedPath = workspaceRootSelector(normalized, root);
      if (selectedPath === undefined) continue;
      const rootPath = resolve(root.fsPath);
      const candidate = resolve(rootPath, selectedPath || '.');
      if (isPathWithin(rootPath, candidate)) return { root, fsPath: candidate };
    }

    // 2) 多根工作区里的相对路径：用存在性消解歧义，避免总是落在第一个根目录。
    if (roots.length > 1 && options.exists && normalized !== '.') {
      const exists = options.exists;
      const matches = roots
        .map((root) => ({ root, fsPath: resolve(resolve(root.fsPath), value) }))
        .filter((entry) => exists(entry.fsPath));
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        // 多个根下都有：项目根下的那一份才是用户的意思，不是歧义。
        const inPreferred = preferred ? matches.find((entry) => resolve(entry.root.fsPath) === resolve(preferred.fsPath)) : undefined;
        if (inPreferred) return inPreferred;
        throw new Error(
          tt('path.ambiguous', { value, roots: matches.map((entry) => entry.root.name).join(tt('common.listSeparator')), example: `${matches[0]!.root.name}/${value}` }),
        );
      }
    }
  }

  // 3) 项目根兜底：相对路径在项目根下不存在时优先在那里创建。
  const ordered = preferred ? [preferred, ...roots.filter((root) => root !== preferred)] : roots;
  for (let index = 0; index < ordered.length; index += 1) {
    const root = ordered[index]!;
    if (!absoluteCandidate && !preferred && index > 0) continue;
    const rootPath = resolve(root.fsPath);
    const candidate = absoluteCandidate ?? resolve(rootPath, value);
    if (isPathWithin(rootPath, candidate)) return { root, fsPath: candidate };
  }
  throw new Error(tt('path.outsideWorkspace'));
}

/** 项目根必须是 `roots` 里的一个实例，否则忽略（例如工作区根已被移除）。 */
function preferredRootOf<T extends WorkspaceRootLike>(roots: readonly T[], preferred?: T): T | undefined {
  if (!preferred) return undefined;
  return roots.find((root) => resolve(root.fsPath) === resolve(preferred.fsPath));
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

/**
 * 判断这次对话落在哪个工作区根目录上。
 *
 * 依次尝试：存档里的绑定 → 当前编辑器所在的项目 → 单根工作区唯一的根。
 * 都确定不了就返回 undefined —— 这个结果**是要给用户看的**（标题旁显示「项目待建立」），
 * 因为此时 git 写操作会被拒绝，界面不能假装一切正常。
 *
 * 抽成纯函数是为了能单测：`projectRootFor` 依赖 `vscode.window.activeTextEditor`，
 * 在单测里没法构造。这里的入参就是它需要的全部信息。
 */
export function chooseProjectRoot(input: {
  roots: readonly string[];
  stored?: string;
  activeFile?: string;
}): string | undefined {
  const roots = input.roots.filter((root) => Boolean(root));
  if (!roots.length) {
    return undefined;
  }
  const stored = input.stored;
  if (stored && roots.some((root) => resolve(root) === resolve(stored))) {
    return stored;
  }
  const activeFile = input.activeFile;
  const activeRoot = activeFile ? roots.find((root) => isPathWithin(root, activeFile)) : undefined;
  if (activeRoot) {
    return activeRoot;
  }
  return roots.length === 1 ? roots[0] : undefined;
}

/** 项目徽标最多显示几个项目：再多就折成 `+N`，否则整条状态栏都被项目名吃掉。 */
export const PROJECT_BADGE_LIMIT = 8;

/**
 * 本对话**涉及**的项目根：主项目在前，其余按首次触达顺序，去重且只保留仍在工作区里的根。
 *
 * 为什么需要它：`chooseProjectRoot` 只回答「相对路径和 git 操作归属哪个项目」，而一个
 * 对话经常横跨多个项目（在 A 做功能、顺手把 B 的对接改掉）。徽标只显示主项目时，
 * 用户看不出这条对话到底动过什么地方，也发现不了「改到了别的项目」。
 *
 * `touched` 的每一项都会和工作区根做规范化比对（`resolve`），不在工作区里的丢弃——
 * 工作区根被移除、或存档里写的是相对路径时，徽标不能凭空多出一个不存在的项目。
 */
export function involvedProjectRoots(input: {
  roots: readonly string[];
  primary?: string;
  touched?: readonly string[];
  limit?: number;
}): string[] {
  const roots = input.roots.filter((root) => Boolean(root)).map((root) => resolve(root));
  const canonical = (value?: string): string | undefined => {
    if (!value) return undefined;
    const target = resolve(value);
    return roots.includes(target) ? target : undefined;
  };
  const ordered: string[] = [];
  const push = (root?: string): void => {
    if (root && !ordered.includes(root)) ordered.push(root);
  };
  push(canonical(input.primary));
  for (const item of input.touched ?? []) push(canonical(item));
  const limit = Math.max(1, input.limit ?? PROJECT_BADGE_LIMIT);
  return ordered.slice(0, limit);
}

/**
 * 从工具记录里的 `changedFiles` 反推「改过文件的项目」。
 *
 * 多根工作区里 `asRelativePath(uri, true)` 会带上文件夹名前缀（`Local_skill_quick_access/src/x.ts`），
 * 这就是历史记录里唯一能区分项目的线索。它让**升级前**的老对话也能显示出多个项目，
 * 不必等下一次写入才开始记录。单根工作区的前缀是纯文件名，不会误判。
 *
 * 只看第一段是否**精确等于**某个文件夹名：这一条挡掉两边的误报——
 * 文件名恰好与项目同名（`DeepSeek-HWChat` 这种无扩展名文件），以及名字相近的项目。
 */
export function rootsFromChangedFiles(input: {
  roots: readonly WorkspaceRootLike[];
  files: readonly string[];
}): string[] {
  if (input.roots.length < 2) return [];
  const matched: string[] = [];
  for (const file of input.files) {
    const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!normalized || isAbsolute(normalized)) continue;
    const separator = normalized.indexOf('/');
    if (separator <= 0) continue;
    const prefix = normalized.slice(0, separator);
    const root = input.roots.find((item) => item.name === prefix);
    if (root && !matched.includes(resolve(root.fsPath))) matched.push(resolve(root.fsPath));
  }
  return matched;
}

/** 项目徽标上的名字：取文件夹名。根目录本身（`/`、`C:\`）没有名字，按未绑定处理。 */
export function projectNameOf(projectRoot?: string): string | null {
  if (!projectRoot) {
    return null;
  }
  const name = basename(projectRoot);
  return name && name.trim() ? name : null;
}

/**
 * 把「根目录名前缀」从 glob 里剥掉，并返回该前缀命中的根目录。
 *
 * glob 与 path 参数使用同一套约定：`DeepSeek-HWChat/src/**\/*.ts` 等价于在
 * DeepSeek-HWChat 根下匹配 `src/**\/*.ts`。此前带前缀的 glob 被原样交给
 * findFiles，一个文件都匹配不到，却对外回答“找到 0 个文件”——调用方无法区分
 * 是自己写错了还是确实没有文件，只能反复试错。
 */
export function normalizeWorkspaceGlob<T extends WorkspaceRootLike>(
  glob: string,
  roots: readonly T[],
): { glob: string; root?: T } {
  const normalized = glob.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  for (const root of roots) {
    const selectors = [...new Set([root.name.trim(), basename(root.fsPath).trim()].filter(Boolean))];
    for (const selector of selectors) {
      if (normalized.startsWith(`${selector}/`)) {
        return { glob: matchEverything(normalized.slice(selector.length + 1)), root };
      }
    }
  }
  return { glob: matchEverything(normalized) };
}

/**
 * findFiles 的 include 里裸 `**` 匹配不到任何文件，必须写成展开形式。
 * 根名前缀被剥掉后恰好剩下 `**`（例如 `DeepSeek-HWChat/**`），若不归一就会
 * 静默返回 0 个文件，调用方只能误判为“该目录下没有文件”。
 */
function matchEverything(glob: string): string {
  return !glob || glob === '**' ? '**/*' : glob;
}

function workspaceRootSelector(input: string, root: WorkspaceRootLike): string | undefined {
  const selectors = [...new Set([root.name.trim(), basename(root.fsPath).trim()].filter(Boolean))];
  for (const selector of selectors) {
    if (input === selector) return '';
    if (input.startsWith(`${selector}/`)) return input.slice(selector.length + 1);
  }
  return undefined;
}

/**
 * 参数名里可能是「路径」的键。只按**键名**判断，不扫描所有字符串值：
 * 工具的 content / text / command / query 等参数经常包含 `/` 开头的正文，
 * 一刀切检查会把正常调用误杀。
 */
const PATH_ARGUMENT_KEYS = new Set([
  'path', 'paths', 'file', 'files', 'filepath', 'filepaths', 'filename', 'filenames',
  'directory', 'dir', 'directories', 'folder', 'folders', 'cwd', 'target', 'destination',
  'dest', 'source', 'src', 'root', 'roots', 'workspacefolder', 'newpath', 'oldpath',
  'inputfile', 'outputfile',
]);

/**
 * 桥接（VS Code 语言模型）工具的路径隔离校验。
 *
 * 真实缺陷：`hwchat_vscode_copilot_readFile` 传 `/etc/hosts` 会直接返回工作区外的
 * 文件内容，`copilot_listDirectory` 传 `/etc` 会列出整个系统目录——桥接通道此前
 * 完全绕过 HWChat 自己的路径隔离，而原生 `read_file` / `run_command` 被严格限制在
 * 工作区内。两条通道安全等级不一致，等于留了一个后门。
 *
 * 返回值是拒绝理由，`undefined` 表示通过。
 */
export function externalToolPathViolation<T extends WorkspaceRootLike>(
  args: Record<string, unknown>,
  roots: readonly T[],
): string | undefined {
  const rootPaths = roots.map((root) => resolve(root.fsPath));
  if (!rootPaths.length) return undefined;

  const inspect = (raw: string): string | undefined => {
    const value = raw.trim();
    if (!value) return undefined;
    if (/^~(?:\/|\\|$)/.test(value) || /\$\{?HOME\}?/.test(value)) {
      return tt('path.homeReference', { value });
    }
    const absolute = isAbsolute(value);
    if (!absolute && !value.replaceAll('\\', '/').split('/').includes('..')) {
      // 普通相对路径：相对任何一个工作区根目录都必然落在工作区内。
      return undefined;
    }
    const candidates = absolute ? [resolve(value)] : rootPaths.map((root) => resolve(root, value));
    const within = candidates.some((candidate) => rootPaths.some((root) => isPathWithin(root, candidate)));
    return within ? undefined : tt('path.notInside', { value });
  };

  for (const [key, value] of Object.entries(args)) {
    if (!PATH_ARGUMENT_KEYS.has(key.toLowerCase())) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== 'string') continue;
      const violation = inspect(item);
      if (violation) return `${key} ${violation}`;
    }
  }
  return undefined;
}
