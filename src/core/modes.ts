import { ConversationMode } from './types';

/**
 * 全部工作模式，顺序与界面下拉一致：Agent / Plan / Chat。
 * 界面的 `<option>`、设置里的默认模式、存档里的 `mode` 都必须是这三个值之一。
 */
export const CONVERSATION_MODES: readonly ConversationMode[] = ['agent', 'plan', 'chat'];

export function isConversationMode(value: unknown): value is ConversationMode {
  return typeof value === 'string' && (CONVERSATION_MODES as readonly string[]).includes(value);
}

/**
 * 模式的唯一解析入口。
 *
 * 界面传上来的值、存档里的值、设置里的默认值都要过这里：
 * 以前面板把 `activeMode` 写死成 `'agent'`，又把设置里的默认模式只在「新建对话」时才读一次，
 * 结果就是「界面上明明选的是 Plan，实际却按 Agent 执行」——校验缺失还会让非法值
 * 悄悄跑到 Agent 分支去调工具。任何一处取值都必须回落到明确声明的默认值。
 */
export function resolveConversationMode(value: unknown, fallback: ConversationMode = 'agent'): ConversationMode {
  if (isConversationMode(value)) return value;
  return isConversationMode(fallback) ? fallback : 'agent';
}

/**
 * 面板里「当前生效的模式」的唯一解析规则，优先级从高到低：
 *
 * 1. 存档里的对话模式（已落库对话以自己的记录为准）；
 * 2. 用户在工具条里为「还没有落库的新对话」选的草稿模式；
 * 3. 设置里的 `hwchat.defaultMode`；
 * 4. 兜底 `agent`。
 *
 * 把这条规则独立出来，是因为它以前散落在四个地方（`sendState` / `send` / `setMode` /
 * 字段初始化），其中字段初始化写死了 `agent`、`sendState` 又直接读缓存的字段——
 * 于是界面显示 Plan、运行时按 Agent 执行。现在四处都调用这一个函数，单元测试也直接盯它。
 */
export function resolveActiveMode(input: {
  /** 存档里的对话模式；草稿会话传 `undefined`。 */
  conversationMode?: unknown;
  /** 用户在工具条里为草稿会话做的选择；没有选择时传 `undefined`。 */
  draftOverride?: unknown;
  /** 设置里的 `hwchat.defaultMode`。 */
  defaultMode?: unknown;
}): ConversationMode {
  if (isConversationMode(input.conversationMode)) return input.conversationMode;
  if (isConversationMode(input.draftOverride)) return input.draftOverride;
  return resolveConversationMode(input.defaultMode, 'agent');
}

/** 与界面文案保持一致的显示名。 */
export function modeLabel(mode: ConversationMode): string {
  switch (resolveConversationMode(mode)) {
    case 'plan': return 'Plan';
    case 'chat': return 'Chat';
    default: return 'Agent';
  }
}

/**
 * 写进系统提示词的模式说明。
 *
 * 必须同时说清三件事，否则模型会用自己的假设替代界面的选择：
 * 1. 当前是哪一种模式（名字与界面下拉完全一致：Agent / Plan / Chat）；
 * 2. 这一轮以它为准——同一对话里可能夹着别的模式下发出的历史消息；
 * 3. 该模式允许与禁止的边界。
 */
export function modePromptInstruction(mode: ConversationMode): string {
  const resolved = resolveConversationMode(mode);
  const rule = resolved === 'agent'
    ? 'Use workspace tools when needed to inspect, edit, diagnose, and verify the project.'
    : resolved === 'plan'
      ? 'Use only read-only tools. Do not edit files and do not run commands. Investigate the workspace first, then produce a concrete implementation plan.'
      : 'Do not call workspace tools and do not edit files; answer using the supplied conversation context and your own knowledge.';
  return [
    `Current HWChat mode: ${modeLabel(resolved)} (the user selected it in the HWChat UI).`,
    rule,
    'This selection is authoritative for the current turn: do not claim that another mode is active, and do not carry over mode assumptions from earlier messages.',
  ].join(' ');
}
