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

/**
 * 环境类失败的确定性提示：**命令没错，环境缺东西**。
 *
 * 现场（用户 2026-11-05，连着两条）：
 *
 *     /bin/sh: timeout: command not found          （macOS 自带没有 GNU timeout）
 *     screencapture: capture error 这项操作无法完成  （屏幕录制没有授权）
 *
 * 这两条都不是「命令写错了」，但工具只把 stderr 原样还回去，模型只能换个写法再撞一次。
 * 环境事实是静态可判的，直接说出来能省掉好几轮。
 */
export interface EnvironmentHint {
  /** i18n 键，只描述**事实与做法**。 */
  key: string;
  values?: Record<string, string | number>;
}

/** macOS / Linux 的 `timeout` 存在性差异（只看命令文本，不探测系统路径）。 */
export function commandEnvironmentHint(command: string, output: string, platform: string = process.platform): EnvironmentHint | undefined {
  const text = `${command}\n${output}`;
  // `timeout: command not found` / `timeout：未找到命令`：GNU coreutils 在 macOS 上默认不存在。
  if (/(?:^|\s)timeout[:：]\s*(?:command not found|未找到命令|not found)/i.test(text)
    || /\btimeout: command not found\b/i.test(text)) {
    if (platform === 'darwin') return { key: 'tool.runCommand.noTimeoutMac' };
    return { key: 'tool.runCommand.noTimeout' };
  }
  /*
   * `screencapture -v` 失败几乎只有一个原因：运行它的进程没有「屏幕录制」权限。
   * 实测（2026-11-05，macOS 15）未授权时输出 `screencapture: capture error 这项操作无法完成`，
   * 而且**不会**自动弹权限请求 —— 必须手动到「系统设置 → 隐私与安全性 → 屏幕录制」勾选。
   */
  if (/screencapture\b/.test(command) && /capture error|无法完成|could not create image/i.test(output)) {
    return { key: 'tool.runCommand.screenCapturePermission' };
  }
  return undefined;
}
