export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type MessageStatus = 'queued' | 'streaming' | 'complete' | 'error';
export type ConversationMode = 'chat' | 'agent' | 'plan';
export type PermissionPolicy = 'allow' | 'ask' | 'deny';
/** 敏感文件与危险命令使用的三态策略：允许 / 逐次确认 / 禁止。 */
export type GuardedPolicy = 'allow' | 'ask' | 'deny';
export type PermissionPreset = 'askAll' | 'review' | 'autopilot' | 'full';
export type ReasoningEffort = 'default' | 'none' | 'low' | 'high' | 'max';
import type { LanguageSetting } from './i18n';
export type { Language, LanguageSetting } from './i18n';

/** 待办条目状态：等待执行 / 执行中 / 已完成。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * Agent 自己维护的待办清单。
 * 用于把「大任务拆成若干步」显式化：面板按数组顺序展示序号，
 * 每一项右侧带执行状态，用户不必从回复正文里推断进度。
 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/**
 * 已归档的任务清单。
 *
 * 一份对话里可以有多份：每份清单全部完成后压缩成输入框上方的一颗胶囊，
 * 点击才展开回看。`todos` 是快照，不再随任务变化。
 */
export interface TodoArchive {
  id: string;
  createdAt: number;
  todos: TodoItem[];
}

/** 推给 webview 的胶囊数据：颜色由扩展算好，脚本只负责画。 */
export interface TodoArchiveView {
  id: string;
  createdAt: number;
  total: number;
  completed: number;
  /** 纯色胶囊颜色（绿 → 浅蓝 → 深蓝），按归档顺序插值。 */
  color: string;
  todos: TodoItem[];
}

export interface ApiProfile {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  excludedModels?: string[];
  requestHeaders: Record<string, string>;
}

export interface ModelOption {
  id: string;
  name: string;
  reasoningSupport?: 'unsupported' | 'fixed' | 'configurable' | 'unknown';
  reasoningEfforts?: ReasoningEffort[];
}

export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface MessageContext {
  label: string;
  content?: string;
  dataBase64?: string;
  path?: string;
  kind?: 'selection' | 'file' | 'image';
  bytes?: number;
  language?: string;
  mimeType?: string;
  thumbnailDataUrl?: string;
}

export type AgentTaskStatus = 'routing' | 'active' | 'merged' | 'queued' | 'complete' | 'cancelled' | 'error';

export interface AgentTaskNode {
  id: string;
  parentId?: string;
  title: string;
  status: AgentTaskStatus;
  relation: 'root' | 'pending' | 'related' | 'queued';
}

export interface AgentTaskTreeState {
  active: boolean;
  currentNodeId?: string;
  nodes: AgentTaskNode[];
  usage?: UsageInfo;
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  updatedAt: number;
  status?: MessageStatus;
  reasoning?: string;
  usage?: UsageInfo;
  model?: string;
  context?: MessageContext;
  attachments?: MessageContext[];
  toolExecutions?: ToolExecution[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  usedSkills?: SkillUsage[];
  consumedByAssistantId?: string;
  replyToMessageId?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
  pinned: boolean;
  totalTokens: number;
  model?: string;
  apiProfileId?: string;
  mode?: ConversationMode;
  skillIds?: string[];
  skillSelectionInitialized?: boolean;
  archived?: boolean;
  archivedAt?: number;
  sourceConversationId?: string;
  sourceConversationTitle?: string;
  sourceHistoryDigest?: string;
  sourceLinkedAt?: number;
  /** 本轮任务拆解出来的待办清单；随对话持久化，重开面板仍在。 */
  todos?: TodoItem[];
  /** 已完成并压缩成胶囊的历史任务清单，按时间从早到晚。 */
  todoArchives?: TodoArchive[];
  /**
   * 这份清单是否已被中断（停止 / 报错 / 关窗口）。
   *
   * 中断的清单不归档成胶囊，而是把 `in_progress` 降级成 `pending` 留在面板上：
   * 用户接着做，模型重新标 `in_progress` 就能照常完成并归档；用户换新任务，新清单直接覆盖它。
   */
  todosInterrupted?: boolean;
}

export interface ConversationHistoryHit {
  messageId: string;
  role: MessageRole;
  createdAt: number;
  excerpt: string;
}

export interface ConversationExport {
  version: 1;
  exportedAt: string;
  conversation: ConversationSummary;
  messages: ChatMessage[];
}

export interface StorageStats {
  conversations: number;
  messages: number;
  bytes: number;
  compactedMessages: number;
  deletedConversations: number;
}

export interface CleanupOptions {
  historyRetentionDays: number;
  taskCacheRetentionHours: number;
  cacheBudgetMB: number;
  protectedConversationIds?: string[];
}

export interface CleanupResult extends StorageStats {
  deletedMessageCacheBytes: number;
}

export interface ChatRequestMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  usage?: UsageInfo;
  toolCalls?: ToolCall[];
}

export interface ChatSettings {
  apiProfiles: ApiProfile[];
  activeApiProfileId: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  sendOnEnter: boolean;
  historyRetentionDays: number;
  taskCacheRetentionHours: number;
  cacheBudgetMB: number;
  cleanupIntervalMinutes: number;
  maxMessagesInContext: number;
  requestHeaders: Record<string, string>;
  requestTimeoutSeconds: number;
  defaultMode: ConversationMode;
  agentMaxSteps: number;
  reasoningEffort: ReasoningEffort;
  permissionPreset: PermissionPreset;
  fileReadPolicy: PermissionPolicy;
  fileWritePolicy: PermissionPolicy;
  commandPolicy: PermissionPolicy;
  /** 危险命令：允许 / 逐次确认 / 禁止。 */
  dangerousCommandPolicy: GuardedPolicy;
  /** 敏感文件（.env、密钥、证书等）：允许 / 逐次确认 / 禁止。 */
  sensitiveFilePolicy: GuardedPolicy;
  maxReadBytes: number;
  maxToolOutputBytes: number;
  maxCommandSeconds: number;
  auditRetentionDays: number;
  /** 界面语言：auto 跟随 VS Code，zh / en 强制指定。 */
  language: LanguageSetting;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: 'workspace' | 'user' | 'copilot';
  relativePath: string;
  defaultEnabled?: boolean;
  lastUsedAt?: number;
}

export interface SkillUsage {
  id: string;
  name: string;
  source: SkillSummary['source'];
  relativePath: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolExecutionStatus = 'pending' | 'approved' | 'denied' | 'success' | 'error';

export interface ToolExecution {
  callId: string;
  name: string;
  summary: string;
  input?: string;
  output?: string;
  status: ToolExecutionStatus;
  approval?: 'not-required' | 'approved' | 'denied';
  startedAt: number;
  finishedAt?: number;
  changedFiles?: string[];
  risk?: 'read' | 'write' | 'command';
  /**
   * 这条步骤接在正文的第几个字符之后（相对本条消息的 content）。
   * Agent 每轮会先说一句「我打算做什么」，再调用工具；把边界记下来，
   * 面板就能在渲染时把步骤显示在它对应的那段说明下面，而不是全部堆在正文之前。
   * 旧数据没有这个字段，渲染时退回「步骤块 + 正文」的旧排法。
   */
  contentOffset?: number;
}

export interface ToolExecutionResult {
  status: Exclude<ToolExecutionStatus, 'pending'>;
  summary: string;
  content: string;
  approval: 'not-required' | 'approved' | 'denied';
  changedFiles?: string[];
}

/** 推给 webview 的审批请求：面板内一张卡片，替代会锁死整个窗口的模态框。 */
export interface PendingApprovalView {
  requestId: string;
  conversationId: string;
  title: string;
  summary: string;
  detail: string;
  risk: 'read' | 'write' | 'command';
}

export interface WebviewConversationState {
  conversation: ConversationSummary | null;
  messages: ChatMessage[];
  hasMore: boolean;
  conversations: ConversationSummary[];
  settings: Pick<ChatSettings, 'apiProfiles' | 'activeApiProfileId' | 'model' | 'sendOnEnter' | 'permissionPreset' | 'agentMaxSteps' | 'reasoningEffort'>;
  apiKeyConfigured: boolean;
  pendingAttachments: Array<Pick<MessageContext, 'label' | 'path' | 'kind' | 'bytes' | 'mimeType' | 'thumbnailDataUrl'>>;
  modelOptionsByProfile: Record<string, ModelOption[]>;
  archivedConversations: ConversationSummary[];
  skills: SkillSummary[];
  selectedSkillIds: string[];
  mode: ConversationMode;
  workspaceTrusted: boolean;
  agentAvailable: boolean;
  availableToolCount: number;
  taskTree?: AgentTaskTreeState;
  showArchived: boolean;
  todos?: TodoItem[];
  /** 已归档的任务清单（胶囊），颜色由扩展计算。 */
  todoArchives?: TodoArchiveView[];
  /** 当前清单是否被中断过；界面据此在折叠框标题上标「已中断」。 */
  todosInterrupted?: boolean;
  /**
   * 正在后台执行的对话 id 列表。
   *
   * 多线程对话：每个对话各自跑自己的 Agent 循环，用户切走对话不会中断它。
   * 界面据此在历史列表上打「运行中」圆点，并决定输入框的发送/停止按钮状态。
   */
  runningConversationIds?: string[];
  /** 仍在等待用户确认的工具授权（可能属于别的对话）。 */
  pendingApprovals?: PendingApprovalView[];
}
