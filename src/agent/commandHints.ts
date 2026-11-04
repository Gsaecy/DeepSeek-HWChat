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

export interface StrippedCd {
  /** 去掉多余 `cd` 之后真正要执行的命令。 */
  command: string;
  /** 被去掉的那段 `cd <目标>`；没去掉时为 undefined。 */
  removed?: string;
}

/**
 * 去掉「`cd` 到自己所在目录」这种多余前缀。
 *
 * 现场（用户 2026-11-04，第二次贴回同一条失败）：
 *
 *     cd "Personal Workstation OS" && grep -n … package.json
 *     → /bin/sh: line 0: cd: Personal Workstation OS: No such file or directory
 *
 * 这条命令的 cwd 本来就是 `…/Personal Workstation OS`，模型的意图就是「在这个项目里执行」，
 * 那个 `cd` 是纯粹的噪声。只提示不处理的话，模型要再跑一轮；直接执行原命令又必然失败。
 * 所以：**只在能百分百确定它是噪声时**把它去掉 ——
 *   1. 命令以 `cd <单个参数>` 开头，且后面还有别的命令（`&& rest`）；
 *   2. 该参数按 cwd 解析**不存在**（真的没有这个子目录）；
 *   3. 该参数的最后一段 == cwd 的 basename（即「想进的就是当前目录」）。
 * 三条缺一不可；被去掉什么会写进工具结果，不偷偷改。
 */
export function stripRedundantLeadingCd(
  command: string,
  cwd: string,
  exists: (candidate: string) => boolean,
): StrippedCd {
  const match = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;|]+))\s*(?:&&|;|\n)\s*([\s\S]+)$/.exec(command);
  if (!match) return { command };
  const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  const rest = match[4] ?? '';
  if (!target || !rest.trim()) return { command };
  // 变量、命令替换、通配符：静态算不出目标，一律不碰。
  if (/[$`*?]/.test(target)) return { command };
  if (exists(resolve(cwd, target))) return { command };
  const last = target.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  if (!last || last !== basename(resolve(cwd))) return { command };
  return { command: rest.trim(), removed: target };
}
