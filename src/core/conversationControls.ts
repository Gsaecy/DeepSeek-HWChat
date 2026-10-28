import { ChatSettings, PermissionPreset, ReasoningEffort } from './types';
import { isPermissionPreset, normalizeAgentMaxSteps } from './settings';
import { DEFAULT_REASONING_EFFORT } from './settings';
import { DEFAULT_PERMISSION_PRESET } from './permissions';
import { DEFAULT_AGENT_MAX_STEPS } from './agentLimits';

/**
 * 每条对话自己的运行时设置。
 *
 * 背景（真实缺陷）：面板上的权限预设 / 最大步骤 / 思考深度以前全部写进
 * `hwchat.*` 全局设置。多线程对话时就会出现「污染」——在对话 A 把预设从
 * 「逐次确认」改成「完全访问」，对话 B 立刻也变成完全访问；对话 B 把步骤数
 * 从 40 改成 8，正在跑的对话 A 下一轮就只剩 8 步。
 *
 * 现在这三项完全归属于对话本身：
 *   对话存档值 → 界面上的草稿选择 → `NEW_CONVERSATION_CONTROLS`（固定初始值）
 * **没有全局默认值这一层**：新对话一律从「每次询问 / 24 步 / 模型官方思考默认」
 * 开始，settings.json 里的旧值不参与判定（原因见下面的常量注释）。
 * 与模式（core/modes.ts）保持同一套「按对话」的思路，但模式仍保留全局默认值。
 */

export interface ConversationControls {
  permissionPreset: PermissionPreset;
  agentMaxSteps: number;
  reasoningEffort: ReasoningEffort;
}

export interface ConversationControlSource {
  permissionPreset?: unknown;
  agentMaxSteps?: unknown;
  reasoningEffort?: unknown;
}

/**
 * 新对话的初始运行时设置（唯一出处）。
 *
 * 三条都是**固定值**，不再从 `hwchat.*` 全局/工作区/文件夹设置继承：
 * - 权限预设 = 每次询问（最严格一档）；
 * - 最大步数 = 24（工具条的四档是 24 / 68 / 120 / 不限制）；
 * - 思考深度 = `default`，即不发送 `reasoning_effort` / `thinking`，跟随模型官方默认。
 *
 * 为什么必须固定（真实故障）：设置里残留的 `hwchat.permissionPreset: autopilot`、
 * `hwchat.agentMaxSteps: 0` 会让每一条新对话一开就自动执行、无限步——用户以为自己
 * 设的是「每次询问 / 24 步」，实际拿到的却是最宽松的组合。这几项本来就归属对话，
 * 新对话只能从最保守的初始值开始，要放宽必须由用户在**那一条对话**的工具条上显式改
 * （危险预设还会二次确认），改完随该对话存档。
 */
export const NEW_CONVERSATION_CONTROLS: Readonly<ConversationControls> = Object.freeze({
  permissionPreset: DEFAULT_PERMISSION_PRESET,
  agentMaxSteps: DEFAULT_AGENT_MAX_STEPS,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
});

/**
 * 新对话（草稿）的初始值：固定默认 + 用户在当前草稿上的临时选择。
 *
 * 草稿上的选择只属于「即将新建的这条对话」：发送时随对话落库，点「新建对话」时
 * 由调用方清空（`draftControls = {}`），所以下一条新对话仍然回到固定默认。
 */
export function resolveNewConversationControls(draft?: ConversationControlSource): ConversationControls {
  return resolveConversationControls(NEW_CONVERSATION_CONTROLS, draft);
}

const REASONING_VALUES: readonly ReasoningEffort[] = ['default', 'none', 'low', 'medium', 'high', 'max'];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_VALUES as readonly string[]).includes(value);
}

/**
 * 存档里是不是一个可用的步数。
 *
 * `0` 是**合法的「无限制」**（工具条上的第四档），负数与非数字仍然是脏值。
 * 这里必须放行 0，否则选了「无限制」的对话一落库就退回默认预算，
 * 界面上会显示「无限制」跑起来却是 24 步 —— 比不提供这一档更糟。
 */
function isStoredSteps(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 单值校验：无效值一律回落到默认值，避免手改存档或界面脏值把预设变成
 * 「既不是 review 也不是 full」的第三种状态。
 */
export function resolveConversationControls(
  defaults: Pick<ChatSettings, 'permissionPreset' | 'agentMaxSteps' | 'reasoningEffort'>,
  conversation?: ConversationControlSource,
): ConversationControls {
  const preset = conversation?.permissionPreset;
  const steps = conversation?.agentMaxSteps;
  const reasoning = conversation?.reasoningEffort;
  return {
    permissionPreset: isPermissionPreset(preset) ? preset : defaults.permissionPreset,
    // 存档里的 `0` 是显式选择的「无限制」，必须原样保留；负数 / 非数字才回落到
    // 调用方给的初始值（新对话是固定的 24），这样既不会无限执行，也不会把
    // 用户在草稿上选的 68 步改成 24 步。
    agentMaxSteps: isStoredSteps(steps)
      ? normalizeAgentMaxSteps(steps)
      : normalizeAgentMaxSteps(defaults.agentMaxSteps),
    // 不用 normalizeReasoningEffort：它会把无效值直接变成 'default'，而调用方给的
    // 初始值可能是别的档（例如旧对话迁移时），脏数据不该静默改写选择。
    reasoningEffort: isReasoningEffort(reasoning) ? reasoning : defaults.reasoningEffort,
  };
}

/** 面板显示用的设置快照：对话有值用对话的，没有则用全局默认。 */
export function conversationControlPatch(controls: ConversationControls): Pick<ConversationControlSource, 'permissionPreset' | 'agentMaxSteps' | 'reasoningEffort'> {
  return {
    permissionPreset: controls.permissionPreset,
    agentMaxSteps: controls.agentMaxSteps,
    reasoningEffort: controls.reasoningEffort,
  };
}

/**
 * 一次权限预设变更会落在哪一轮。
 *
 * 需求（与 Copilot 一致）：任务运行中**也允许**改预设，但改完只对「下一次对话」生效，
 * 绝不能改变正在执行的任务——它可能在改之前就已经通过了某个危险动作的判定，
 * 中途放宽或收紧都会让用户看到的确认与实际执行对不上。
 *
 * 实现上靠「每次运行开始时快照一次设置」（`ConversationRun.settings`）：
 * 本次运行的所有工具调用都读这份快照，所以持久化新预设天然不会影响它。
 * 这个函数只用于**决定要不要告诉用户「下一次生效」**，把语义写死在一个地方，
 * 免得界面文案和实际行为分叉。
 */
export function presetChangeScope(options: {
  /** 本次运行开始时快照的预设；没有正在运行的任务时为 undefined。 */
  runningPreset?: PermissionPreset;
  /** 用户刚选的预设。 */
  requested: PermissionPreset;
}): 'immediate' | 'next-turn-only' {
  if (options.runningPreset === undefined) return 'immediate';
  return options.runningPreset === options.requested ? 'immediate' : 'next-turn-only';
}

/**
 * 这是不是一条「建了但一直没用」的空对话？
 *
 * 用途有两处，判据必须完全一致（以前是两段各写一遍的条件，容易走偏）：
 *  1. 新建对话时清掉上一条空对话 —— 否则连点会把历史堆满「新对话 · 空对话」；
 *  2. 周期性清理收掉崩溃/失败留下的残骸。
 *
 * 保守到什么程度都不为过：只有**一条消息都没有**、没置顶、没归档、不是续接副本的
 * 对话才会被判为可丢弃。这种对话不存在任何可以丢失的内容。
 */
export function isEmptyDraftConversation(summary: {
  messageCount?: number;
  pinned?: boolean;
  archived?: boolean;
  sourceConversationId?: string;
}): boolean {
  if ((summary.messageCount ?? 0) !== 0) return false;
  if (summary.pinned || summary.archived) return false;
  if (summary.sourceConversationId) return false;
  return true;
}
