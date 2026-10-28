/**
 * 测试专用的 vscode 替身。
 *
 * 目的：`ToolExecutor` 是权限与工具调用的真正拦截层，但因为顶部 `import 'vscode'`
 * 而一直无法在 `node --test` 里运行。本文件只实现被调用到的 API，并让文件系统
 * 操作走真实磁盘，从而保证 `realpath`、符号链接与越界判定和生产环境一致。
 *
 * 使用方式：esbuild 在构建测试入口时把 `vscode` 别名指向本文件。
 */
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class Uri {
  readonly scheme = 'file';

  private constructor(readonly fsPath: string) {}

  static file(value: string): Uri {
    return new Uri(nodePath.resolve(value));
  }

  static joinPath(uri: Uri, ...pathSegments: string[]): Uri {
    return new Uri(nodePath.join(uri.fsPath, ...pathSegments));
  }

  get path(): string {
    return this.fsPath;
  }

  toString(): string {
    return `file://${this.fsPath}`;
  }
}

/** `vscode.EventEmitter` 的替身：足够驱动 watcher 与共享状态回调。 */
export class EventEmitter<T> {
  private listeners: Array<(value: T) => unknown> = [];

  readonly event = (
    listener: (value: T) => unknown,
    thisArg?: unknown,
    disposables?: Array<{ dispose(): void }>,
  ): { dispose(): void } => {
    const bound = (thisArg ? listener.bind(thisArg) : listener) as (value: T) => unknown;
    this.listeners.push(bound);
    const disposable = {
      dispose: () => {
        const index = this.listeners.indexOf(bound);
        if (index >= 0) this.listeners.splice(index, 1);
      },
    };
    disposables?.push(disposable);
    return disposable;
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners = [];
  }
}

type MockWatcherListener = () => unknown;

export interface MockFileSystemWatcher {
  onDidCreate(listener: MockWatcherListener, thisArg?: unknown, disposables?: Array<{ dispose(): void }>): { dispose(): void };
  onDidChange(listener: MockWatcherListener, thisArg?: unknown, disposables?: Array<{ dispose(): void }>): { dispose(): void };
  onDidDelete(listener: MockWatcherListener, thisArg?: unknown, disposables?: Array<{ dispose(): void }>): { dispose(): void };
  dispose(): void;
}

const watcherRegistry: Array<{ pattern: unknown; fire: (kind: 'create' | 'change' | 'delete') => void }> = [];

function createFileSystemWatcher(pattern: unknown): MockFileSystemWatcher {
  const listeners = { create: [] as MockWatcherListener[], change: [] as MockWatcherListener[], delete: [] as MockWatcherListener[] };
  const register = (kind: 'create' | 'change' | 'delete') => (
    listener: MockWatcherListener,
    thisArg?: unknown,
    disposables?: Array<{ dispose(): void }>,
  ): { dispose(): void } => {
    const bound = (thisArg ? listener.bind(thisArg) : listener) as MockWatcherListener;
    listeners[kind].push(bound);
    const disposable = {
      dispose: () => {
        const index = listeners[kind].indexOf(bound);
        if (index >= 0) listeners[kind].splice(index, 1);
      },
    };
    disposables?.push(disposable);
    return disposable;
  };
  const watcher: MockFileSystemWatcher = {
    onDidCreate: register('create'),
    onDidChange: register('change'),
    onDidDelete: register('delete'),
    dispose: () => {
      listeners.create = [];
      listeners.change = [];
      listeners.delete = [];
    },
  };
  watcherRegistry.push({ pattern, fire: (kind) => { for (const listener of [...listeners[kind]]) listener(); } });
  return watcher;
}

/** 触发已注册的 workspace watcher（模拟 VS Code 的文件事件）。 */
export function fireWorkspaceWatchers(kind: 'create' | 'change' | 'delete' = 'change'): void {
  for (const watcher of watcherRegistry) watcher.fire(kind);
}

/** 清理 watcher 注册表，避免用例之间互相污染。 */
export function resetWorkspaceWatchers(): void {
  watcherRegistry.length = 0;
}

/** `vscode.CancellationError` 替身：真实 VS Code 在搜索被取消时抛这个。 */
export class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

export interface MockCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => unknown): { dispose(): void };
}

/** `vscode.CancellationTokenSource` 替身，并记录每次 findFiles 收到的 token。 */
export class CancellationTokenSource {
  private readonly listeners: Array<() => unknown> = [];
  private cancelled = false;
  private disposed = false;
  readonly token: MockCancellationToken;

  constructor() {
    const self = this;
    this.token = {
      get isCancellationRequested(): boolean {
        return self.cancelled;
      },
      onCancellationRequested(listener: () => unknown) {
        self.listeners.push(listener);
        return {
          dispose: () => {
            const index = self.listeners.indexOf(listener);
            if (index >= 0) self.listeners.splice(index, 1);
          },
        };
      },
    };
  }

  cancel(): void {
    if (this.cancelled || this.disposed) return;
    this.cancelled = true;
    for (const listener of [...this.listeners]) listener();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.length = 0;
  }
}

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

export interface MockWorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

/** `findFiles(new RelativePattern(folder, glob), ...)` 的替身，用于逐根查询。 */
export class RelativePattern {
  readonly baseUri: Uri;
  readonly pattern: string;

  constructor(base: MockWorkspaceFolder | Uri | string, pattern: string) {
    if (typeof base === 'string') this.baseUri = Uri.file(base);
    else if (base instanceof Uri) this.baseUri = base;
    else this.baseUri = base.uri;
    this.pattern = pattern;
  }
}

let folders: MockWorkspaceFolder[] = [];
const configuration = new Map<string, unknown>();
/** 各工作区文件夹自己的 .vscode/settings.json（对应 workspaceFolderValue）。 */
const folderConfiguration = new Map<string, Map<string, unknown>>();
let diagnostics: Array<[Uri, unknown[]]> = [];

/** 设定当前多根工作区。路径均为真实存在的目录。 */
export function setWorkspaceRoots(paths: readonly string[]): void {
  folders = paths.map((fsPath, index) => ({
    uri: Uri.file(fsPath),
    name: nodePath.basename(fsPath),
    index,
  }));
}

/** 设定用户/工作区层配置（对应 globalValue）。会清空已设的文件夹层配置。 */
export function setConfiguration(values: Record<string, unknown>): void {
  configuration.clear();
  folderConfiguration.clear();
  for (const [key, value] of Object.entries(values)) configuration.set(key, value);
}

/**
 * 设定某个工作区文件夹的配置（对应 workspaceFolderValue）。
 * 需要在 setConfiguration 之后调用，因为后者会清空文件夹层。
 */
export function setFolderConfiguration(folderPath: string, values: Record<string, unknown>): void {
  folderConfiguration.set(nodePath.resolve(folderPath), new Map(Object.entries(values)));
}

export function setDiagnostics(entries: Array<[Uri, unknown[]]>): void {
  diagnostics = entries;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${nodePath.sep}`) && relative !== '..' && !nodePath.isAbsolute(relative));
}

/** 把 VS Code 的 glob 语法转成正则：支持 `**`、`*`、`?`、`{a,b}`。 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 2;
        } else {
          out += '.*';
          index += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '{') {
      const end = glob.indexOf('}', index);
      if (end === -1) {
        out += '\\{';
        continue;
      }
      const parts = glob
        .slice(index + 1, end)
        .split(',')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      out += `(?:${parts.join('|')})`;
      index = end;
      continue;
    }
    out += /[\\^$+.()|[\]{}]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${out}$`);
}

/** 从排除 glob 的 `{...}` 里取出目录名，用于剪枝。 */
function excludeDirectories(exclude?: string | null): Set<string> {
  const names = new Set<string>();
  if (!exclude) return names;
  const open = exclude.indexOf('{');
  const close = exclude.lastIndexOf('}');
  const body = open !== -1 && close > open ? exclude.slice(open + 1, close) : exclude;
  for (const part of body.split(',')) {
    const cleaned = part.trim().replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
    if (cleaned) names.add(cleaned);
  }
  return names;
}

async function walkFiles(root: string, excluded: ReadonlySet<string>): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = nodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        await visit(full);
      } else if (entry.isFile()) {
        found.push(full);
      }
    }
  };
  await visit(root);
  return found;
}

/** 每个 findFiles 调用收到的 token：用来断言「取消真的传给了搜索引擎」。 */
const receivedSearchTokens: MockCancellationToken[] = [];

export function getReceivedSearchTokens(): readonly MockCancellationToken[] {
  return receivedSearchTokens;
}

export function resetReceivedSearchTokens(): void {
  receivedSearchTokens.length = 0;
}

/**
 * 让测试把 findFiles 卡在「已经开始搜索」的那一刻。
 *
 * 用例需要「取消发生在搜索进行中」这个确定状态，靠 sleep 猜时机必然随机失败。
 */
let findFilesGate: (() => Promise<void> | void) | undefined;

export function setFindFilesGate(gate: (() => Promise<void> | void) | undefined): void {
  findFilesGate = gate;
}

async function findFiles(
  include: string | RelativePattern,
  exclude?: string | null,
  maxResults = 0,
  token?: MockCancellationToken,
): Promise<Uri[]> {
  if (token) receivedSearchTokens.push(token);
  if (findFilesGate) await findFilesGate();
  if (!folders.length) return [];
  const scoped = typeof include === 'string' ? undefined : include.baseUri.fsPath;
  const pattern = globToRegExp(typeof include === 'string' ? include : include.pattern);
  const excluded = excludeDirectories(exclude);
  const results: Uri[] = [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    if (scoped && nodePath.resolve(root) !== nodePath.resolve(scoped)) continue;
    for (const file of await walkFiles(root, excluded)) {
      // 真实 VS Code 在 token 取消后会让搜索引擎停下并抛 Cancelled；
      // 替身也遵守同一契约，才能测出「取消是否真的传下去了」。
      if (token?.isCancellationRequested) throw new CancellationError();
      const relative = nodePath.relative(root, file).split(nodePath.sep).join('/');
      if (!pattern.test(relative)) continue;
      results.push(Uri.file(file));
      if (maxResults > 0 && results.length >= maxResults) return results;
    }
  }
  return results;
}

function asRelativePath(uriOrPath: Uri | string, includeWorkspaceFolder = false): string {
  const target = typeof uriOrPath === 'string' ? nodePath.resolve(uriOrPath) : uriOrPath.fsPath;
  for (const folder of folders) {
    if (!isWithin(folder.uri.fsPath, target)) continue;
    const relative = nodePath.relative(folder.uri.fsPath, target).split(nodePath.sep).join('/');
    if (!includeWorkspaceFolder || folders.length <= 1) return relative;
    return relative ? `${folder.name}/${relative}` : folder.name;
  }
  return target;
}

const fileSystem = {
  async stat(uri: Uri) {
    const info = await fsp.stat(uri.fsPath);
    return {
      type: info.isDirectory() ? FileType.Directory : FileType.File,
      size: info.size,
      ctime: info.ctimeMs,
      mtime: info.mtimeMs,
    };
  },
  async readFile(uri: Uri) {
    return new Uint8Array(await fsp.readFile(uri.fsPath));
  },
  async writeFile(uri: Uri, content: Uint8Array) {
    await fsp.writeFile(uri.fsPath, content);
  },
  async createDirectory(uri: Uri) {
    await fsp.mkdir(uri.fsPath, { recursive: true });
  },
  async readDirectory(uri: Uri) {
    const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [
      entry.name,
      entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.SymbolicLink,
    ] as [string, FileType]);
  },
  async rename(from: Uri, to: Uri, options?: { overwrite?: boolean }) {
    if (!options?.overwrite && (await fsp.stat(to.fsPath).catch(() => undefined))) {
      throw new Error(`目标已存在：${to.fsPath}`);
    }
    await fsp.mkdir(nodePath.dirname(to.fsPath), { recursive: true });
    await fsp.rename(from.fsPath, to.fsPath);
  },
  async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }) {
    await fsp.rm(uri.fsPath, { recursive: Boolean(options?.recursive) });
  },
};

export const workspace = {
  get workspaceFolders(): MockWorkspaceFolder[] | undefined {
    return folders.length ? folders : undefined;
  },
  fs: fileSystem,
  findFiles,
  createFileSystemWatcher,
  asRelativePath,
  async openTextDocument(uri: Uri) {
    return {
      uri,
      getText: async () => fsp.readFile(uri.fsPath, 'utf8'),
    };
  },
  getConfiguration(section: string, scope?: Uri | MockWorkspaceFolder) {
    // VS Code 只有拿到 resource 才会应用 workspaceFolderValue；替身如实照做，
    // 否则「多根工作区读不到文件夹级设置」这类缺陷在测试里永远暴露不出来。
    const folderPath = scope
      ? nodePath.resolve(scope instanceof Uri ? scope.fsPath : scope.uri.fsPath)
      : undefined;
    const folderValues = folderPath ? folderConfiguration.get(folderPath) : undefined;
    const fullKey = (key: string) => `${section}.${key}`;
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const stored = folderValues?.get(fullKey(key)) ?? configuration.get(fullKey(key));
        return (stored === undefined ? fallback : stored) as T | undefined;
      },
      inspect(key: string) {
        return {
          key: fullKey(key),
          workspaceFolderValue: folderValues?.get(fullKey(key)),
          workspaceValue: undefined,
          globalValue: configuration.get(fullKey(key)),
          defaultValue: undefined,
        };
      },
      async update(key: string, value: unknown, target?: unknown) {
        if (target === ConfigurationTarget.WorkspaceFolder && folderValues) {
          folderValues.set(fullKey(key), value);
          return;
        }
        configuration.set(fullKey(key), value);
      },
    };
  },
};

export const window = {
  async showTextDocument() {
    return undefined;
  },
};

/** `vscode.lm` 的替身：记录 invokeTool 调用，用于验证「越界参数在调用前就被拒绝」。 */
let lmTools: Array<{ name: string; description?: string; inputSchema?: object; tags?: readonly string[] }> = [];
let invokeToolCalls: Array<{ name: string; input: unknown }> = [];

export function setLmTools(tools: typeof lmTools): void {
  lmTools = tools;
}

export function getInvokeToolCalls(): readonly { name: string; input: unknown }[] {
  return invokeToolCalls;
}

export function resetInvokeToolCalls(): void {
  invokeToolCalls = [];
}

export const lm = {
  get tools() {
    return lmTools;
  },
  async invokeTool(name: string, options: { input?: unknown } = {}) {
    invokeToolCalls.push({ name, input: options.input });
    return { content: [new LanguageModelTextPart('mocked-tool-result')] };
  },
};

/** `toolResultText` 会用 instanceof 判断结果分片类型，替身必须提供这两个类。 */
export class LanguageModelTextPart {
  constructor(readonly value: string) {}
}

export class LanguageModelDataPart {
  constructor(readonly data: Uint8Array, readonly mimeType: string) {}
}

export const extensions = {
  all: [] as Array<{ isActive: boolean; packageJSON?: unknown; activate: () => Promise<void> }>,
  /** 默认没有安装任何扩展；需要时用 `setInstalledExtension` 注入。 */
  getExtension(_id: string): { id: string } | undefined {
    return installedExtension;
  },
};

let installedExtension: { id: string } | undefined;

export function setInstalledExtension(extension: { id: string } | undefined): void {
  installedExtension = extension;
}

/**
 * 显示语言替身。默认中文，使既有断言可以继续比对中文文案；
 * 需要验证英文文案的用例可以临时改写 `env.language`。
 */
export const env = { language: 'zh-cn' };

export const languages = {
  getDiagnostics(uri?: Uri): Array<[Uri, unknown[]]> {
    if (!uri) return diagnostics;
    return diagnostics.filter(([candidate]) => candidate.fsPath === uri.fsPath);
  },
};

export class Disposable {
  constructor(private readonly callback: () => void = () => undefined) {}

  dispose(): void {
    this.callback();
  }
}
