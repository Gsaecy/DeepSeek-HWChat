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

export interface ResolveWorkspacePathOptions {
  /**
   * 可选的同步存在性探测，只用于在多根工作区里消解相对路径的歧义。
   *
   * - 不提供时保持旧行为：相对路径一律解析到第一个工作区根目录。
   * - 提供时：在所有根目录下探测，唯一存在的那一个胜出。
   * - 全部不存在时仍回退到第一个根目录，因为写入新文件依赖这一点。
   */
  exists?: (fsPath: string) => boolean;
}

export function resolveWorkspacePath<T extends WorkspaceRootLike>(
  input: string,
  roots: readonly T[],
  options: ResolveWorkspacePathOptions = {},
): ResolvedWorkspacePath<T> {
  if (!roots.length) throw new Error(tt('path.noWorkspace'));
  const value = input?.trim() || '.';
  const absoluteCandidate = isAbsolute(value) ? resolve(value) : undefined;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');

  if (!absoluteCandidate) {
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
        throw new Error(
          tt('path.ambiguous', { value, roots: matches.map((entry) => entry.root.name).join(tt('common.listSeparator')), example: `${matches[0]!.root.name}/${value}` }),
        );
      }
    }
  }

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]!;
    if (!absoluteCandidate && index > 0) continue;
    const rootPath = resolve(root.fsPath);
    const candidate = absoluteCandidate ?? resolve(rootPath, value);
    if (isPathWithin(rootPath, candidate)) return { root, fsPath: candidate };
  }
  throw new Error(tt('path.outsideWorkspace'));
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
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
