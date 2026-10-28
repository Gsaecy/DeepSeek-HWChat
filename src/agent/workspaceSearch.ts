/**
 * HWChat 内部所有工作区文件搜索的唯一入口。
 *
 * 任何 `vscode.workspace.findFiles` 都必须经过这里，原因见 `searchScheduler.ts`：
 * 每次 findFiles 在 VS Code 里都对应一次真实搜索（会拉起 ripgrep），
 * 无上限并发正是 `spawn rg EAGAIN` 与 Extension Host CPU 打满的直接来源。
 *
 * 默认排除：依赖、构建产物、缓存与语言工具链目录。它们不是用户的工作区内容，
 * 每次「搜一下」都扫一遍会让 I/O 和 CPU 都翻几倍。需要搜索这些目录时，
 * 用户可以显式写进 `hwchat.searchExclude` 的反向做法（见 README）——
 * 或者用更具体的 glob 直接指向目标目录。
 */

import * as vscode from 'vscode';
import { SearchScheduler } from './searchScheduler';
import type { SearchCallResult, SearchSchedulerStats } from './searchScheduler';
import { OperationCancelledError } from './transientErrors';

/** 默认不参与搜索的目录名。 */
export const DEFAULT_SEARCH_EXCLUDED_DIRS: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'DerivedData',
  '.cache',
];

/**
 * 排除档位。
 *
 * - `default`：依赖 / 构建 / 缓存目录一律不扫（绝大多数「搜一下代码」的场景）；
 * - `minimal`：只排除 `node_modules` 与 `.git`。用于「这个裸文件名到底是哪个文件」
 *   这类必须看到构建产物的查询——`extension.js` 的真实位置就是 `out/extension.js`。
 */
export type WorkspaceSearchExcludeProfile = 'default' | 'minimal';

/** `minimal` 档的排除规则。 */
export const MINIMAL_SEARCH_EXCLUDE = '**/{node_modules,.git}/**';

export interface WorkspaceSearchRequest {
  /** findFiles 的 include 模式。 */
  include: string;
  /** 单根目录搜索时限定在该根内。 */
  folder?: string;
  /** 结果上限。 */
  limit: number;
  /** 排除档位，默认 `default`。 */
  exclude?: WorkspaceSearchExcludeProfile;
  /** 诊断用：这次搜索来自哪个工具。 */
  operation?: string;
}

export interface WorkspaceSearchParams {
  include: string;
  folder?: string;
  limit: number;
  exclude: string;
  operation: string;
}

let scheduler: SearchScheduler<WorkspaceSearchParams, vscode.Uri> | undefined;
let invalidationDisposables: vscode.Disposable[] | undefined;
/**
 * 文件变化代数。
 *
 * 任何上层缓存（例如 search_files 的「查询 → 命中结果」缓存）都把代数编进 key：
 * 一次写入/保存/删除就让旧条目永远不可达，不需要各处手动清理，也不会出现
 * 「文件改了但搜索还返回旧命中」。
 */
let generation = 0;

/** 供测试与诊断使用：当前生效的排除规则（默认目录 + files.exclude + 用户扩展）。 */
export function workspaceSearchExclude(): string {
  const configured = readConfiguredExcludes();
  const fileExcludes = readFileExcludeNames();
  const names = [...new Set([...DEFAULT_SEARCH_EXCLUDED_DIRS, ...fileExcludes, ...configured])];
  return `**/{${names.join(',')}}/**`;
}

/**
 * 用户 `files.exclude` 里的目录名。
 *
 * 权威依据（`vscode.d.ts`，`workspace.findFiles` 的 `exclude` 参数原文）：
 *
 * > When `undefined`, default file-excludes (e.g. the `files.exclude`-setting but not
 * > `search.exclude`) will apply. When `null`, no excludes will apply.
 *
 * 也就是说：**只要传了自定义 exclude，VS Code 的默认排除（即 `files.exclude`）就不再生效**。
 * HWChat 必须传自定义 exclude（要挡住 node_modules / 构建产物），所以必须自己把
 * `files.exclude` 并进来——否则用户在 `files.exclude` 里排掉的目录（例如 `vendor`、
 * `Pods`）反而会被我们逐个扫描，正是「越优化越费 CPU」的那类坑。
 *
 * 只合并能塞进 `**​/{a,b}/**` 花括号列表的**单段目录名**；`**​/*.log`、`**​/foo[0-9]` 这类
 * 复杂 glob 无法表达成目录名，明确放弃（宁可少排除，也不塞进语义不对的规则）。
 */
function readFileExcludeNames(): string[] {
  const collected = new Set<string>();
  const add = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [pattern, enabled] of Object.entries(value as Record<string, unknown>)) {
      if (enabled !== true) continue;
      const name = simpleDirectoryName(pattern);
      if (name) collected.add(name);
    }
  };
  try {
    // 取合并视图（含 VS Code 自带的 .git / node_modules / .DS_Store 等默认值）。
    add(vscode.workspace.getConfiguration('files').get<unknown>('exclude', {}));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      add(vscode.workspace.getConfiguration('files', folder.uri).get<unknown>('exclude', {}));
    }
  } catch {
    // 配置读取失败只意味着「没有额外排除」，不影响搜索本身。
  }
  return [...collected].slice(0, 40);
}

/** `**​/node_modules/**`、`node_modules`、`**​/out` 这类能归一成「一个目录名」的写法。 */
export function simpleDirectoryName(pattern: string): string | undefined {
  // 先剥掉「显式包含」（!）与前后空白，再只接受「可选的多层通配 + 单段名字 + 可选尾部通配」。
  const cleaned = String(pattern || '').trim().replace(/^!\s*/, '');
  if (!cleaned) return undefined;
  const match = /^(?:\*\*\/)*([A-Za-z0-9._@-]+)(?:\/\*\*|\/)?$/.exec(cleaned);
  if (!match) return undefined;
  const name = match[1]!;
  if (name === '.' || name === '..') return undefined;
  return name;
}

/**
 * 读取用户追加的排除目录。
 *
 * `hwchat.searchExclude` 是 resource 作用域：多根工作区里用户完全可能只在某一个根的
 * `.vscode/settings.json` 里写它。只读无 resource 的合并视图会像当年的权限配置一样
 * 「写了但读不到」，所以这里逐根读一遍再取并集（并集只会少排除、不会多排除，
 * 不会把用户想搜的目录悄悄挡掉）。
 */
function readConfiguredExcludes(): string[] {
  const collected = new Set<string>();
  const add = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const cleaned = item.trim().replace(/[^A-Za-z0-9._*?-]/g, '');
      if (cleaned) collected.add(cleaned);
    }
  };
  try {
    add(vscode.workspace.getConfiguration('hwchat').get<unknown>('searchExclude', []));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      add(vscode.workspace.getConfiguration('hwchat', folder.uri).get<unknown>('searchExclude', []));
    }
  } catch {
    // 配置读取失败只意味着「没有额外排除」，不影响搜索本身。
  }
  return [...collected].slice(0, 40);
}

function workspaceFoldersKey(): string {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath).join('\u0000');
}

function buildKey(params: WorkspaceSearchParams): string {
  return [
    workspaceFoldersKey(),
    params.folder ?? '',
    params.include,
    params.exclude,
    String(params.limit),
  ].join('\u0001');
}

/**
 * 把调度层的 `AbortSignal` 接到 VS Code 的 `CancellationToken` 上。
 *
 * 权威依据（`vscode.d.ts`，`workspace.findFiles` 的官方签名与注释）：
 *
 * ```ts
 * findFiles(include, exclude?, maxResults?, token?: CancellationToken): Thenable<Uri[]>;
 * // @param token A token that can be used to signal cancellation to the underlying search engine.
 * ```
 *
 * 之前这里只传了三个参数，并在注释里写「findFiles 没有 CancellationToken」——那是错的。
 * 后果是：用户点「停止」后，搜索调度层只是不再等待结果，**底层搜索（ripgrep）仍会把
 * 整个工作区扫完**，CPU 与进程占用照旧。现在把 token 传下去，取消会真正传给搜索
 * 引擎，这才符合「取消任务后不遗留由 HWChat 启动的搜索」。
 *
 * token 的来源要在本次搜索结束后 dispose，避免每搜一次就漏一个 CancellationTokenSource。
 */
function bridgeCancellation(signal: AbortSignal): { token: vscode.CancellationToken; dispose: () => void } {
  const source = new vscode.CancellationTokenSource();
  if (signal.aborted) {
    source.cancel();
    return { token: source.token, dispose: () => source.dispose() };
  }
  const onAbort = (): void => source.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    token: source.token,
    dispose: () => {
      signal.removeEventListener('abort', onAbort);
      source.dispose();
    },
  };
}

function ensureScheduler(): SearchScheduler<WorkspaceSearchParams, vscode.Uri> {
  if (scheduler) return scheduler;
  scheduler = new SearchScheduler<WorkspaceSearchParams, vscode.Uri>({
    run: async (params, context) => {
      if (context.signal.aborted) throw new OperationCancelledError();
      const folder = params.folder
        ? (vscode.workspace.workspaceFolders ?? []).find((candidate) => candidate.uri.fsPath === params.folder)
        : undefined;
      const cancellation = bridgeCancellation(context.signal);
      try {
        const files = folder
          // RelativePattern 才能把搜索限制在单个根内；字符串 include 在多根工作区里
          // 会以「所有根合计」的上限返回，靠后的根会被整体挤掉。
          ? await vscode.workspace.findFiles(new vscode.RelativePattern(folder, params.include), params.exclude, params.limit, cancellation.token)
          : await vscode.workspace.findFiles(params.include, params.exclude, params.limit, cancellation.token);
        if (context.signal.aborted) throw new OperationCancelledError();
        return { files, truncated: params.limit > 0 && files.length >= params.limit };
      } finally {
        cancellation.dispose();
      }
    },
  });
  registerInvalidation();
  return scheduler;
}

/**
 * 文件内容变化后立刻丢弃缓存。
 *
 * 这里刻意不用「全工作区递归 FileSystemWatcher」：在大型工作区上那本身就是一个
 * 昂贵的递归监听，修性能问题时不该再加一个。这几个事件覆盖 VS Code 内的保存、
 * 新建、删除、重命名；编辑器之外的改动由 1.5 秒的短 TTL 兜住。
 */
function registerInvalidation(): void {
  if (invalidationDisposables) return;
  const workspaceApi = vscode.workspace as unknown as {
    onDidSaveTextDocument?: (listener: () => unknown) => vscode.Disposable;
    onDidCreateFiles?: (listener: () => unknown) => vscode.Disposable;
    onDidDeleteFiles?: (listener: () => unknown) => vscode.Disposable;
    onDidRenameFiles?: (listener: () => unknown) => vscode.Disposable;
  };
  const invalidate = (): void => invalidateWorkspaceSearch();
  const disposables: vscode.Disposable[] = [];
  for (const register of [
    workspaceApi.onDidSaveTextDocument,
    workspaceApi.onDidCreateFiles,
    workspaceApi.onDidDeleteFiles,
    workspaceApi.onDidRenameFiles,
  ]) {
    if (typeof register !== 'function') continue;
    try {
      disposables.push(register(invalidate));
    } catch {
      // 测试替身 / 旧版本 VS Code 没有这个事件：忽略即可。
    }
  }
  invalidationDisposables = disposables;
}

export async function searchWorkspace(
  params: WorkspaceSearchRequest,
  options: { signal?: AbortSignal } = {},
): Promise<SearchCallResult<vscode.Uri>> {
  const resolved: WorkspaceSearchParams = {
    include: params.include,
    folder: params.folder,
    limit: params.limit,
    operation: params.operation ?? 'find_files',
    exclude: params.exclude === 'minimal' ? MINIMAL_SEARCH_EXCLUDE : workspaceSearchExclude(),
  };
  return ensureScheduler().run(resolved, buildKey(resolved), options);
}

export function invalidateWorkspaceSearch(): void {
  generation += 1;
  scheduler?.invalidate();
}

/** 当前文件变化代数；上层缓存把它编进 key 即可自动失效。 */
export function workspaceSearchGeneration(): number {
  return generation;
}

export function workspaceSearchStats(): SearchSchedulerStats | undefined {
  return scheduler?.stats();
}

/** 取消所有排队 / 活动搜索（扩展停用、工作区关闭）。 */
export function disposeWorkspaceSearch(): void {
  scheduler?.dispose();
  scheduler = undefined;
  for (const disposable of invalidationDisposables ?? []) {
    try {
      disposable.dispose();
    } catch {
      // 忽略：扩展停用阶段的清理不应抛错。
    }
  }
  invalidationDisposables = undefined;
}
