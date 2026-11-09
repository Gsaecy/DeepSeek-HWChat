/**
 * 对话长度：这条对话离「装不下」还有多远。
 *
 * 为什么要显示它：用户的实际感受是「聊到后面就开始变慢、变贵、偶尔失败」，
 * 但界面上除了一个累计 token 数什么提示都没有 —— 那个数是**计费累加**，
 * 不是上下文长度，看到 1.03M 也无法判断离上限还差多少。
 *
 * 这里算的是**真正会发给模型的那部分**（与 `requestBytesOf` 同一口径：
 * 正文 + 附件文本，不算图片 base64、不算工具执行记录、不算思考过程），
 * 所以进度条和实际请求大小是一致的。
 */

/** 字符 → token 的粗估比例（代码/中英混排下足够保守）。 */
const CHARS_PER_TOKEN = 4;

/**
 * 默认上下文预算（tokens）。
 *
 * 主流 OpenAI 兼容模型的窗口在 64K–128K 之间，`modelCapabilities` 里目前没有
 * 逐模型的窗口上限，所以取 128K 作为「大致装得下」的上界：
 * 超了不一定失败，但一定又慢又贵，而且更容易被服务端掐断。
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 128_000;

/** 超过这个比例开始提醒。 */
export const CONTEXT_WARN_RATIO = 0.7;
/** 超过这个比例判定为「该开新对话了」。 */
export const CONTEXT_OVER_RATIO = 0.9;

export type ContextLoadLevel = 'ok' | 'warn' | 'over';

export interface ContextLoad {
  /** 估算的上下文 tokens。 */
  tokens: number;
  /** 用来比较的预算。 */
  budget: number;
  /** 0–100 的整数百分比（超过 100 也照实报，界面自己决定怎么画）。 */
  percent: number;
  level: ContextLoadLevel;
}

/** 字节 → 估算 tokens。 */
export function estimateTokens(bytes: number): number {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return Math.round(safe / CHARS_PER_TOKEN);
}

/**
 * 把「已用量」换算成进度与档位。
 *
 * 分档刻意只有三档：`ok` / `warn` / `over`。
 * 再细分只会让用户去猜「75% 要不要紧」，而这个问题的答案取决于模型窗口 ——
 * 与其猜，不如在 `over` 时直接给一个「在新对话继续」的按钮。
 */
export function contextLoad(tokens: number, budget = DEFAULT_CONTEXT_TOKEN_BUDGET): ContextLoad {
  const safeBudget = Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_CONTEXT_TOKEN_BUDGET;
  const safeTokens = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
  const ratio = safeTokens / safeBudget;
  const level: ContextLoadLevel = ratio >= CONTEXT_OVER_RATIO ? 'over' : ratio >= CONTEXT_WARN_RATIO ? 'warn' : 'ok';
  return { tokens: safeTokens, budget: safeBudget, percent: Math.round(ratio * 100), level };
}
