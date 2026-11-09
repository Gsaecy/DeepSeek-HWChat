/**
 * 「等多久算卡住」—— 空闲超时必须随请求体大小放宽。
 *
 * 真实故障（用户 2026-11-09 13:57）：一次运行的上下文涨到 **1.03M tokens**，
 * 发出去之后模型光 prefill 就要几分钟，其间一个字节都不会回来；
 * 固定的 120 秒空闲判定先到点，于是整轮被判「卡住」，agent 直接停下。
 * 用户看到的是「请求失败：等待 120 秒没有收到新数据」。
 *
 * 这不是网络问题，也不是模型的问题：**请求越大，首字延迟越长**，
 * 而旧实现拿同一个 120 秒去卡 3 KB 和 4 MB 的请求。
 *
 * 现在的规则：
 *  允许的沉默 = 基础超时 + 预填时间
 *  预填时间按「保守 2,000 tokens/秒」估算（真实服务通常更快，这里刻意留余量）
 *  再叠一个上限 `STALL_CEILING_SECONDS`，避免一个坏连接把界面挂上半小时。
 *
 * 为什么用字符数而不是真实 token 数：发请求之前拿不到真实 token 数，而
 * 字符 → token 的 4:1 估算在代码/中文混排下足够保守；真正要的是「量级对」。
 */

/** 沉默的上限。超过这个就真的是卡住了，不再是「大请求在预填」。 */
export const STALL_CEILING_SECONDS = 600;

/** 保守的预填速度（tokens/秒）。故意低估 —— 宁可多等，也不要误杀。 */
const PREFILL_TOKENS_PER_SECOND = 2_000;

/** 字符 → token 的粗估比例。 */
const CHARS_PER_TOKEN = 4;

/**
 * 这一次请求允许沉默多少秒。
 *
 * @param requestChars 请求体字符数（`encodeBody` 的结果长度）
 * @param baseSeconds 用户设置里的「请求超时」（秒），作为下限
 */
export function stallIdleSeconds(requestChars: number, baseSeconds: number): number {
  const base = Math.max(1, Math.round(Number.isFinite(baseSeconds) ? baseSeconds : 120));
  const chars = Math.max(0, Number.isFinite(requestChars) ? requestChars : 0);
  const prefillSeconds = Math.ceil(chars / CHARS_PER_TOKEN / PREFILL_TOKENS_PER_SECOND);
  return Math.min(STALL_CEILING_SECONDS, base + prefillSeconds);
}

/**
 * 是否因为请求体太大而**明显**放宽了（用于日志与界面提示）。
 *
 * 阈值 10 秒：3 KB 的请求也会多算 1 秒，那不叫「放宽」，不值得打扰用户。
 */
export function stallExtended(requestChars: number, baseSeconds: number): boolean {
  return stallIdleSeconds(requestChars, baseSeconds) - Math.max(1, Math.round(baseSeconds)) >= 10;
}
