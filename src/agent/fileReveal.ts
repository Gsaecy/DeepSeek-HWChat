/**
 * 「在 Finder / 资源管理器中显示文件」的决策层。
 *
 * 这里刻意不 import vscode：平台映射和入参清洗都是纯逻辑，`node:test` 可以直接
 * 覆盖「Windows 该叫资源管理器」这类判断，不用启动编辑器。
 *
 * 为什么单独成一层：正文里的文件引用是**模型输出**驱动的，模型写出来的路径
 * 可能为空、可能是 `~/.zshrc`、可能带着一堆控制字符。这些都得在交给
 * `revealFileInOS` 之前挡掉，而不是指望路径本身是干净的。
 */

import { posix, win32 } from 'node:path';

/** 用户给这个「文件管理器」起的名字。显示文案按它查 i18n 表。 */
export type FileRevealTarget = 'finder' | 'explorer' | 'fileManager';

/**
 * 平台 → 文件管理器。
 *
 * macOS 的 Finder、Windows 的资源管理器都有专门的名字，值得单独说；
 * 其余平台（Linux 各发行版叫法不一致）统一叫「文件管理器」，不猜具体是哪个。
 */
export function revealTargetFor(platform: string): FileRevealTarget {
  if (platform === 'darwin') return 'finder';
  if (platform === 'win32') return 'explorer';
  return 'fileManager';
}

export interface FileReferenceTarget {
  path: string;
  line?: number;
  column?: number;
}

/** 行号/列号只接受正整数字符串或数字，其余忽略。 */
function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

/**
 * 清洗 webview 回传的文件引用。
 *
 * 返回 `undefined` 表示这条消息不该被执行：
 *  - 空路径、纯空白；
 *  - `~` 开头的家目录写法——展开它等于替用户猜测主目录在哪里，
 *    HWChat 在工具参数里也是同样的口径（见 workspacePaths 的 homeReference）；
 *  - 含控制字符的路径（粘贴或模型输出里常见的脏数据）。
 */
export function normalizeFileReference(input: { path?: unknown; line?: unknown; column?: unknown }): FileReferenceTarget | undefined {
  const raw = typeof input?.path === 'string' ? input.path.trim() : '';
  if (!raw) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  if (raw.startsWith('~')) return undefined;
  const target: FileReferenceTarget = { path: raw };
  const line = positiveInt(input.line);
  const column = positiveInt(input.column);
  if (line) target.line = line;
  if (column) target.column = column;
  return target;
}

/**
 * 判断绝对路径是否落在某个工作区根之内。
 *
 * 为什么要这道判断：`revealInExplorer` 是「在 VS Code 自己的资源管理器里定位」，
 * 而资源管理器只显示工作区里的内容。文件在工作区外时，这个命令**什么都不会发生**
 * 也不报错——用户点了菜单却看不到任何反应，比给一条提示更糟。
 *
 * 为什么不能直接 `startsWith`：`/a/bc` 会以 `/a/b` 开头，但那不是它的子路径。
 * 所以比较前一律补上分隔符，做到「整段目录名相等」。
 *
 * `platform` 单独传进来（默认当前平台），是为了让 Windows 的大小写不敏感能被
 * 单测直接覆盖，而不用真到 Windows 上跑。
 */
export function isInsideWorkspace(
  target: string,
  roots: readonly string[],
  platform: string = process.platform,
): boolean {
  if (!target || roots.length === 0) return false;
  // 显式取 win32 / posix 实现，而不是用默认的 `path`：
  // 默认实现跟随**运行平台**，在 macOS 上比对 Windows 路径会全盘失配
  // （`\` 不会被当成分隔符），既测不出来、也会让判断与平台脱节。
  const api = platform === 'win32' ? win32 : posix;
  const normalize = (value: string): string => {
    const resolved = api.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const resolvedTarget = normalize(target);
  for (const root of roots) {
    if (!root) continue;
    const base = normalize(root);
    if (resolvedTarget === base) return true;
    const prefix = base.endsWith(api.sep) ? base : `${base}${api.sep}`;
    if (resolvedTarget.startsWith(prefix)) return true;
  }
  return false;
}
