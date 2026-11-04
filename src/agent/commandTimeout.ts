/**
 * 命令超时的「请求值 vs 生效值」。
 *
 * 现场（用户 2026-11-04）：
 *
 *     {"command":"cd \"…/Personal Workstation OS\" && cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -40",
 *      "timeoutSeconds": 900}
 *     → 超时（120 秒）·（无输出）
 *
 * 模型明确要求 900 秒，设置项 `hwchat.maxCommandSeconds` 是 120 秒，于是**被静默截断**：
 * 结果里只说「超时（120 秒）」，既没说是被截断的、也没说可以调大或换后台跑。
 * 模型只能再猜一次，用户看到的是「命令莫名其妙失败」。
 *
 * 这个模块只做两件纯函数的事：算出真正的生效值，并把「为什么被打断 / 下一步怎么跑」
 * 说清楚。**不擅自突破用户设置** —— 上限就是上限，但要让人知道。
 */

export interface EffectiveTimeout {
  /** 模型请求的秒数（没传时等于上限）。 */
  requested: number;
  /** 真正生效的秒数。 */
  effective: number;
  /** 请求值被上限截断了。 */
  clamped: boolean;
}

/** 与 `runCommand` 保持一致的取整：最少 5 秒，绝不超过上限。 */
export function effectiveTimeoutSeconds(requested: unknown, capSeconds: number): EffectiveTimeout {
  const cap = Number.isFinite(capSeconds) && capSeconds > 0 ? capSeconds : 120;
  const wanted = typeof requested === 'number' && Number.isFinite(requested) ? requested : cap;
  const clampedValue = Math.max(5, wanted);
  return {
    requested: wanted,
    effective: Math.min(cap, clampedValue),
    clamped: wanted > cap,
  };
}

/**
 * 被截断时的说明。没有截断就返回 `undefined`，不产生噪声。
 */
export function timeoutClampNotice(
  plan: EffectiveTimeout,
  deps: { t: (key: string, values?: Record<string, string | number>) => string; settingKey: string; maxSeconds: number },
): string | undefined {
  if (!plan.clamped) return undefined;
  return deps.t('tool.runCommand.timeoutClamped', {
    requested: Math.round(plan.requested),
    effective: Math.round(plan.effective),
    setting: deps.settingKey,
    max: deps.maxSeconds,
  });
}

/** 摘要里的短形式：一眼能看出「要求 900、实际 120」。 */
export function timeoutClampSummary(
  plan: EffectiveTimeout,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (!plan.clamped) return '';
  return t('tool.runCommand.timeoutClampedShort', {
    requested: Math.round(plan.requested),
    effective: Math.round(plan.effective),
  });
}

/**
 * 超时后给模型的下一步。
 *
 * 三条都是实测有效的做法；同时点名两个已知的坑：
 *  - `| tail -40` 会缓冲全部输出，超时后只能拿到空结果（用户那次就是「无输出」）；
 *  - 「等一会儿再试」是纯消耗 —— 上限不变，重试一定同样超时。
 */
export function timeoutAdvice(
  plan: EffectiveTimeout,
  deps: { t: (key: string, values?: Record<string, string | number>) => string; settingKey: string; maxSeconds: number },
): string {
  return deps.t('tool.runCommand.timeoutAdvice', {
    seconds: Math.round(plan.effective),
    setting: deps.settingKey,
    max: deps.maxSeconds,
  });
}
