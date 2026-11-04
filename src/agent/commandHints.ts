import { basename, resolve } from 'node:path';

/**
 * `cd <目录>` 失败时，判断「是不是已经在那个目录里了」。
 *
 * 现场（用户 2026-11-04）：
 *
 *     cd "Personal Workstation OS" && grep -n … package.json
 *     → /bin/sh: line 0: cd: Personal Workstation OS: No such file or directory
 *
 * 这条命令的 cwd 本来就是 `…/Personal Workstation OS`（本次对话的项目根），
 * 于是 `cd` 去找它**下面**的同名子目录，当然不存在。宿主比模型更清楚当前 cwd，
 * 直接把「你已经在这里了」说出来，比让它换个写法再猜一次便宜。
 */
export function selfNestedCdHint(command: string, cwd: string | undefined, output: string): string | undefined {
  if (!cwd) return undefined;
  const segments = command.split(/&&|\|\||[;|\n]/);
  const own = basename(resolve(cwd));
  if (!own) return undefined;
  for (const segment of segments) {
    const match = /^\s*cd\s+(?:'([^']+)'|"([^"]+)"|([^\s&;|]+))\s*$/.exec(segment);
    if (!match) continue;
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!target) continue;
    const last = target.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (last !== own) continue;
    // 只有「真的因为这个 cd 失败了」才算：避免把无关的失败也解释成路径问题。
    if (!output.includes(`cd: ${target}:`) && !output.includes(`cd: ${own}:`)) continue;
    return own;
  }
  return undefined;
}
