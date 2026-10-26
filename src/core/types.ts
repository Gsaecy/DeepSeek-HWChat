export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type MessageStatus = 'queued' | 'streaming' | 'complete' | 'error';
export type ConversationMode = 'chat' | 'agent' | 'plan';
export type PermissionPolicy = 'allow' | 'ask' | 'deny';
export type PermissionPreset = 'askAll' | 'review' | 'autopilot' | 'full' | 'custom';
export type ReasoningEffort = 'default' | 'none' | 'low' | 'high' | 'max';

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
  allowSensitiveFiles: boolean;
  allowDangerousCommands: boolean;
  maxReadBytes: number;
  maxToolOutputBytes: number;
  maxCommandSeconds: number;
  auditRetentionDays: number;
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
}

export interface ToolExecutionResult {
  status: Exclude<ToolExecutionStatus, 'pending'>;
  summary: string;
  content: string;
  approval: 'not-required' | 'approved' | 'denied';
  changedFiles?: string[];
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
}
