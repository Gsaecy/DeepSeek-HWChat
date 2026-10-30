/**
 * Agent 单轮执行预算的常量与归一化。
 *
 * 单独成文件（不 import vscode）是为了让存储层也能用同一份规则清洗历史存档。
 */

/**
 * 工具循环的默认预算。
 *
 * 24 步足够覆盖「读几个文件 → 改代码 → 跑测试」这一类常规任务，同时保证
 * 一轮 Agent 请求不会无限跑下去。
 */
export const DEFAULT_AGENT_MAX_STEPS = 24;

/**
 * 工具条 / 设置页里可选的四档预算（0 = 无限制）。
 *
 * 只给四档而不是让用户自由填数字：实测 12 步几乎必然截断、40/80 这类中间值
 * 又没人会去微调，选项越多越容易停在某个想不起来为什么设的值上。
 * 忠实回填：存档里若有别的合法数字（老对话写过 8/40/80），界面会把它补成一个
 * 选项显示出来，不会静默改成最近的一档。
 */
export const AGENT_STEP_PRESETS: readonly number[] = [24, 68, 120, 0];

/**
 * 「无限制」的表示值。
 *
 * 沿用历史上 `0 = 不限制` 的语义：用户在工具条/设置页显式选「无限制」时才写出 0，
 * 其余一切**脏值**（负数、非数字、空值）仍然回落到默认预算，不会被解释成无限。
 * 循环侧还要靠 `ToolLoopGuard` / 连续无进展 / 单轮工具调用上限 / 取消这几道闸兜底，
 * 所以「无限制」不等于「一定会踢死机器」。
 */
export const AGENT_MAX_STEPS_UNLIMITED = 0;

/**
 * 工具循环的绝对安全上限（仅对有限预算生效）。
 *
 * 任何来源（全局设置、会话存档、界面传值、历史脏数据）都不能突破它。
 * 超出上限的值夹到上限；`0` 只作为「无限制」哨兵单独处理。
 */
export const AGENT_STEP_SAFETY_CAP = 200;

/** 显式选择的「无限制」。 */
export function isUnlimitedSteps(value: unknown): boolean {
  return value === AGENT_MAX_STEPS_UNLIMITED;
}

/**
 * 归一化一个步数来源。
 * - `0` → 无限制（显式选择）
 * - 正数 → 取整并夹到 `AGENT_STEP_SAFETY_CAP`
 * - 其余（空值 / 负数 / 布尔 / 非数字）→ `DEFAULT_AGENT_MAX_STEPS`
 *
 * 注意 `Number('')` 与 `Number(null)` 都是 0：空值必须先挡掉，否则一个空字符串
 * 会被解释成「无限制」——那是最危险的方向（本来只是没填，结果再也不停）。
 */
export function normalizeAgentMaxSteps(value: unknown): number {
  if (value === null || value === undefined || typeof value === 'boolean') return DEFAULT_AGENT_MAX_STEPS;
  if (typeof value === 'string' && !value.trim()) return DEFAULT_AGENT_MAX_STEPS;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AGENT_MAX_STEPS;
  if (numeric === AGENT_MAX_STEPS_UNLIMITED) return AGENT_MAX_STEPS_UNLIMITED;
  if (numeric <= 0) return DEFAULT_AGENT_MAX_STEPS;
  return Math.min(Math.floor(numeric), AGENT_STEP_SAFETY_CAP);
}

/**
 * 一次运行里累计的工具调用上限：**不设限**。
 *
 * 历史（2026-10-29 起）：
 * 1. 最初写死 200 —— 用户把最大步骤设成「无限制」仍会在第 200 个调用被打断，
 *    与设置的字面意思冲突；于是「无限制」档位放宽到 1000、常规档位保持 200。
 * 2. 用户实测后要求**所有档位都不限次**：「执行次数多了，每次运行命令都弹窗，
 *    很麻烦」。这道闸的用意本来就是「绝对兜底」，而不是「常用预算」，
 *    反复打断真实任务比它防住的风险更糟，所以整体移除。
 *
 * 仍然是「不限制」而不是「随便跑」：循环里还留着这几道闸——
 *  - `MAX_TOOL_CALLS_PER_ROUND`：一轮内最多执行多少个调用（超出的跳过并回报模型）；
 *  - `MAX_IDENTICAL_TOOL_CALLS`：同一个调用连续 3 次即判定死循环；
 *  - `MAX_FAILED_ROUNDS_WITHOUT_PROGRESS`：连续 3 轮全部失败即停；
 *  - 有限档位（24 / 68 / 120）依旧由轮数预算封顶；
 *  - 停止按钮随时可用。
 *
 * 留成常量而不是删掉：将来若要重新加回总量兜底，改这一个值即可。
 */
export const MAX_TOOL_CALLS_PER_RUN = Number.POSITIVE_INFINITY;

/**
 * 交给工具循环的实际轮数预算。
 *
 * 无限制在循环里就是 `Infinity`：循环只在模型不再调用工具时结束，
 * 或由循环守卫 / 取消提前终止。有限预算保持原样。
 */
export function agentStepBudget(value: unknown): number {
  const steps = normalizeAgentMaxSteps(value);
  return isUnlimitedSteps(steps) ? Number.POSITIVE_INFINITY : steps;
}
