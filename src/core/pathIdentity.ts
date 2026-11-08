import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 路径身份：判断两个路径是不是同一处。
 *
 * 单独放在 `core` 且**只依赖 node:path**，是为了让所有需要它的模块（agent 的
 * 守卫、搜索、路径提示，core 的存档去重）都用同一份实现，不会有人再手抄一份
 * 大小写敏感的版本。这里不 import vscode，可以直接被守护脚本打包运行。
 *
 * 事故（2026-11-08，线上）：Windows 上工作区根登记为 `e:\AI Projects\maiker_windows`，
 * 而 `git rev-parse --show-toplevel` + realpath 回的是 `E:\AI Projects\maiker_windows`。
 * 守卫用 `===` 比字符串，把**同一个目录**判成「另一个工作区项目」，`git pull` 被自己的
 * 扩展拦住 —— 提示里两边路径看起来一模一样，用户完全无从理解。
 */

/** 该平台的文件名默认是否大小写不敏感（决定路径比较要不要折叠大小写）。 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * 比较用的路径键：绝对化 + 去掉尾部分隔符 + 在大小写不敏感的平台上折叠大小写。
 *
 * 不能一律 `toLowerCase()`：Linux 是大小写敏感的，`/tmp/A` 与 `/tmp/a` 是两个目录。
 */
export function pathKey(value: string, caseInsensitive = CASE_INSENSITIVE_FS): string {
  const absolute = resolve(value);
  const trimmed = absolute.length > 1 ? absolute.replace(/[\\/]+$/, '') : absolute;
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

/** 两个路径是否指向同一处（忽略大小写差异与尾部分隔符）。 */
export function samePath(a: string, b: string, caseInsensitive = CASE_INSENSITIVE_FS): boolean {
  return pathKey(a, caseInsensitive) === pathKey(b, caseInsensitive);
}

/** `candidate` 是否落在 `root` 之内（含 `root` 自身）。 */
export function isPathWithin(root: string, candidate: string, caseInsensitive = CASE_INSENSITIVE_FS): boolean {
  const relativePath = relative(pathKey(root, caseInsensitive), pathKey(candidate, caseInsensitive));
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}
