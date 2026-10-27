import { ChatSettings, PermissionPreset, ReasoningEffort } from './types';
import { isPermissionPreset, normalizeAgentMaxSteps } from './settings';

/**
 * 每条对话自己的运行时设置。
 *
 * 背景（真实缺陷）：面板上的权限预设 / 最大步骤 / 思考深度以前全部写进
 * `hwchat.*` 全局设置。多线程对话时就会出现「污染」——在对话 A 把预设从
 * 「逐次确认」改成「完全访问」，对话 B 立刻也变成完全访问；对话 B 把步骤数
 * 从 40 改成 8，正在跑的对话 A 下一轮就只剩 8 步。
 *
 * 现在这三项归属于对话本身，全局设置只作为**新对话的默认值**：
 *   对话存档值 → 界面上的草稿选择 → 全局默认值
 * 与模式（core/modes.ts）保持同一套优先级思路。
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

const REASONING_VALUES: readonly ReasoningEffort[] = ['default', 'none', 'low', 'high', 'max'];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_VALUES as readonly string[]).includes(value);
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
    agentMaxSteps: typeof steps === 'number' ? normalizeAgentMaxSteps(steps) : defaults.agentMaxSteps,
    // 注意不能直接用 normalizeReasoningEffort：它把无效值变成 'default'，
    // 而全局默认可能是 'high'，那样脏数据会静默改变思考深度。
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
