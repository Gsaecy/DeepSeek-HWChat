export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type MessageStatus = 'queued' | 'streaming' | 'complete' | 'error';
/**
 * 一条**用户消息**被执行到哪一步了。
 *
 * 为什么单独记一个字段，而不是从任务树推：任务树只在运行期间存在
 * （`runs.has(conversationId)` 才下发），运行一结束、或者用户点「继续」开新的一轮，
 * 上一轮那些消息到底跑没跑就看不出来了 —— 而「哪些被忽略」正是要看的东西。
 * 所以状态落在消息本身上，重启 VS Code 也还在。
 *
 * - `pending`：已发出，还在队列里等 agent 取走；
 * - `running`：agent 正在执行这一条；
 * - `done`：执行过（跑完、失败、被停止都算执行过）；
 * - `skipped`：这一轮结束了它还没被执行 —— 也就是「被忽略」的那条。
 */
export type MessageExecutionStatus = 'pending' | 'running' | 'done' | 'skipped';
export type ConversationMode = 'chat' | 'agent' | 'plan';
export type PermissionPolicy = 'allow' | 'ask' | 'deny';
/** 敏感文件与危险命令使用的三态策略：允许 / 逐次确认 / 禁止。 */
export type GuardedPolicy = 'allow' | 'ask' | 'deny';
export type PermissionPreset = 'askAll' | 'review' | 'autopilot' | 'full';
export type ReasoningEffort = 'default' | 'none' | 'low' | 'medium' | 'high' | 'max';
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
  /**
   * 出图用的模型名（例如 `gpt-image-1`、`dall-e-3`，或中转网关自己的名字）。
   *
   * 为什么单独一个字段：聊天模型（DeepSeek）与出图模型通常不是同一个，
   * 而 `POST /images/generations` 必须显式带 `model`。留空时不出图并给出
   * 明确提示，而不是拿聊天模型的名字去试 —— 那只会得到一句看不懂的 400。
   */
  imageModel?: string;
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
  /**
   * 面板侧用来找回「完整附件」的句柄。
   *
   * webview 只拿到去掉 `dataBase64` / `content` 的精简副本（避免把几 MB 的图片
   * 常驻在前端），所以点击附件时只能回传一个标识，由扩展按 id 取回原始内容。
   * 对同一个附件反复调用 `attachmentForWebview` 必须得到同一个 id，否则
   * 每次重绘都会在索引里多出一条，而点击时又找不回刚才那条。
   */
  id?: string;
  content?: string;
  dataBase64?: string;
  path?: string;
  kind?: 'selection' | 'file' | 'image';
  bytes?: number;
  language?: string;
  mimeType?: string;
  thumbnailDataUrl?: string;
  /**
   * **只给 webview 看**的图片地址：落成文件的附件（例如 agent 生成的图片）由面板
   * 用 `asWebviewUri` 生成。它不是存档字段，也不参与 `stripMessagePayload` ——
   * 只在 `attachmentForWebview` 里临时补上，避免 4 MB base64 常驻前端。
   */
  webviewSrc?: string;
  /**
   * 这张图的**原始远程地址**（面板代下载时记下来）。
   *
   * 用途：正文里的 `![](https://…)` 被下载并挂成附件之后，渲染时需要知道
   * 「这个 URL 已经有一份本地副本」，才不会又把原文的 markdown 显示成一段文字。
   */
  sourceUrl?: string;
}

export type AgentTaskStatus = 'routing' | 'active' | 'merged' | 'queued' | 'complete' | 'cancelled' | 'error';

export interface AgentTaskNode {
  id: string;
  parentId?: string;
  title: string;
  status: AgentTaskStatus;
  relation: 'root' | 'pending' | 'related' | 'queued';
  /**
   * 这条任务对应的用户消息 id。
   *
   * 界面上的「编辑」要靠它读回原话（任务标题是截断过的），「删除」要靠它把
   * 那条还没执行的消息从存档里撤掉。
   */
  userMessageId?: string;
  /**
   * 这条任务对应**回复**消息的 id。
   *
   * 点了任务树里的一行就要跳到它的输出位置；回复气泡才是「输出」，
   * 只给 userMessageId 会让界面跳到用户自己的那句话上，等于没跳。
   */
  assistantMessageId?: string;
  /**
   * 还没被 agent 取走执行。
   *
   * 只有这类节点能原地改、能删：队列里持有它的 request，改完下一轮读到的就是新内容。
   * 一旦 `take()` 把它取走变成当前分支，历史已经发生，就只能「改完重新发一条」。
   */
  pending?: boolean;
  /**
   * 「上次运行没执行、这次接着执行」的消息。
   *
   * 用户要求（2026-11-05）：「跳过的消息恢复执行的时候在任务树里面也恢复显示」。
   * 任务树每一轮都会随新的队列重建，恢复进来的节点如果和普通排队节点长得一样，
   * 用户根本看不出「这条是上次没跑完的」。界面据此加一个「恢复执行」标记。
   */
  restored?: boolean;
  /**
   * 用户正在**悬浮编辑框**里改这条消息。
   *
   * 队列会因此在 `take()` 里挂一道闸门：agent 走到它时暂停等待，
   * 改完（或取消）才读取内容继续执行。
   */
  editing?: boolean;
  /** agent 已经走到这条、正停着等用户改完。 */
  waitingForEdit?: boolean;
  /**
   * 这条任务做完之后的一句话结论（本地从回复里摘出来）。
   *
   * 用户的要求（2026-11-06）：「将历史执行完的记录总结成简单的过程」「agent 只需要
   * 读取任务树和任务清单，就能知道对话中的项目情况」。完整聊天记录仍然留在磁盘上，
   * 但不再逐轮发给模型；任务树里这一行就是它「记得自己做过什么」的唯一来源。
   */
  summary?: string;
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
  /**
   * 这条用户消息的执行状态（见 `MessageExecutionStatus`）。
   *
   * 只有用户消息会写；老存档里没有这个字段，界面就不画徽标（不猜）。
   */
  executionStatus?: MessageExecutionStatus;
}

export interface ConversationSummary {
  id: string;
  title: string;
  /**
   * 标题是用户手动改过的。
   *
   * 首条用户消息会自动给对话命名（`appendMessage` 里判断标题是否仍是「新对话」），
   * 只靠字符串比较挡不住「用户自己就改成了『新对话』」这种巧合，所以改名时留下这个标记：
   * 标记为真之后自动命名永久让位，用户的选择不会被后续消息覆盖。
   */
  titleCustomized?: boolean;
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
  /**
   * 本次对话绑定的项目根（某个工作区根的绝对路径）。
   *
   * 多根工作区里相对路径和 git 写操作都必须归属到具体项目：没有这个字段时
   * `cwd` 默认是 `'.'`，会解析到**第一个**工作区根目录，于是「提交一下」可能
   * 提交掉另一个项目。首次写入文件或显式指定 cwd 时绑定，之后只读不改。
   */
  projectRoot?: string;
  /**
   * 本对话改过文件的**其它**项目根（绝对路径，按首次触达顺序，不含 `projectRoot`）。
   *
   * 一个对话经常横跨多个项目（在 A 里做功能、顺手把 B 的对接改一下）。只留一个
   * `projectRoot` 时，标题旁的项目徽标永远只显示第一个项目，用户看不出这条对话
   * 到底动过哪些地方。`projectRoot` 仍然是「相对路径与 git 写操作归属哪个项目」的
   * 唯一依据，这个字段只用于展示，不参与路径解析。
   */
  projectRoots?: string[];
  /**
   * 本对话自己的运行时设置。
   *
   * 以前这三项直接写 `hwchat.*` 全局设置，多线程对话时互相污染：在 A 调成
   * 「完全访问」，B 立刻也跟着放宽；B 把步骤数改成 8，正在跑的 A 下一轮就被截断。
   * 现在它们属于对话，全局设置只作为新对话的默认值。
   */
  permissionPreset?: PermissionPreset;
  agentMaxSteps?: number;
  reasoningEffort?: ReasoningEffort;
  /** 互联网参考：这条对话是否要求先检索网络再执行。 */
  internetReference?: boolean;
  sourceConversationId?: string;
  sourceConversationTitle?: string;
  sourceHistoryDigest?: string;
  sourceLinkedAt?: number;
  /** 本轮任务拆解出来的待办清单；随对话持久化，重开面板仍在。 */
  todos?: TodoItem[];
  /**
   * 这条对话累积下来的任务树（含已完成的）。
   *
   * 与 `todos` 同级的「项目记忆」：模型每轮读它而不是读整段聊天记录。
   */
  taskNodes?: AgentTaskNode[];
  /** 已完成并压缩成胶囊的历史任务清单，按时间从早到晚。 */
  todoArchives?: TodoArchive[];
  /**
   * 这份清单是否已被中断（停止 / 报错 / 关窗口）。
   *
   * 中断的清单不归档成胶囊，而是把 `in_progress` 降级成 `pending` 留在面板上：
   * 用户接着做，模型重新标 `in_progress` 就能照常完成并归档；用户换新任务，新清单直接覆盖它。
   */
  todosInterrupted?: boolean;
  /**
   * 本轮正常跑完，但清单还有没打勾的项（模型漏了收尾）。
   *
   * 与 `todosInterrupted` 互斥：那个表示「被掐断」，这个表示「跑完了但没结清」。
   * 分开存是为了界面不把「跑完忘了打勾」说成「已中断」——后者会让用户以为工作被腰斩。
   */
  todosIncomplete?: boolean;
  /**
   * 还没被 agent 执行过的用户消息 id（按发送顺序）。
   *
   * 窗口关掉、用户点停止、步数用尽都会留下这种消息。它们不是「失败」，也不是「跳过」：
   * 下一轮开始时按原顺序放回任务队列继续执行，直到全部读过为止。
   */
  pendingTaskIds?: string[];
}

export interface ConversationHistoryHit {
  messageId: string;
  role: MessageRole;
  createdAt: number;
  excerpt: string;
  /**
   * 这条消息的重字段（工具输出 / 附件正文）被搬进了同目录的 `payloads/`。
   *
   * 正文永远留在消息里；这里只是告诉模型「想看当时的完整输出，可以再读一次」——
   * 用户在 2026-11-06 的要求：记录保留，但只在任务树/清单说不清时才查。
   */
  hasDetail?: boolean;
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
  /** 本次真正读盘的对话数：0 表示内容没变、整轮被跳过（用于日志与测试断言）。 */
  scannedConversations?: number;
  /** 其中「建了但从没初始化、也没有消息」的残骸条数（已包含在 deletedConversations 里）。 */
  prunedDrafts?: number;
  /**
   * 缓存体积是否已超出 `hwchat.cacheBudgetMB`。
   *
   * 超预算**不会**触发删除：清理只做瘦身与统计，空间由用户在设置里自己清。
   */
  overBudget?: boolean;
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
  /**
   * 追加的搜索排除目录名（`hwchat.searchExclude`）。
   *
   * 声明为可选：这是 resource 作用域的配置（多根工作区里用户可能只写在某个根的
   * `.vscode/settings.json` 里），读取侧由 `workspaceSearch` 逐根取并集；设置页只
   * 负责把它呈现成一个逗号分隔的输入框并写回。可选能让既有测试夹具不必逐个补字段。
   */
  /**
   * 当前接口配置档的出图模型名；缺失/空表示这个档位不支持出图。
   * 与 `baseUrl` 一样由 readSettings 从当前配置档镜像出来。
   *
   * 声明为可选：这是能力开关，不是必需配置；可选也让既有测试夹具不必逐个补字段。
   */
  imageModel?: string;
  searchExclude?: string[];
  requestHeaders: Record<string, string>;
  requestTimeoutSeconds: number;
  /**
   * 出网代理（`http://host:port`，留空 = 直连）。
   *
   * 必须由用户显式填写：Node 的 `fetch` 不会使用 `HTTPS_PROXY` 环境变量，VS Code 的
   * `http.proxy` 也不覆盖扩展 —— 所以「系统代理开着、扩展却 fetch failed」是真实
   * 存在的一类故障。真的填了，请求会走 CONNECT 隧道（见 providers/proxyFetch.ts）。
   *
   * 不做自动探测：环境里残留一个指向已关闭端口的代理变量，自动启用会直接把原本
   * 可用（直连）的请求弄坏。
   */
  proxy: string;
  defaultMode: ConversationMode;
  agentMaxSteps: number;
  reasoningEffort: ReasoningEffort;
  permissionPreset: PermissionPreset;
  /**
   * 互联网参考（按对话）：开启后 Agent 先检索网络上的成熟项目与官方文档再动手。
   *
   * 它不是全局设置：`readSettings()` 恒为 false，只有 `applyRuntimeControls()`
   * 按对话存档打开。这样「在 A 对话开了查资料」不会让 B 对话也偷偷联网。
   */
  internetReference: boolean;
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
  /**
   * 给人和给路由看的一句话摘要（已剥掉 `USE FOR:` / `Triggers:` 段落，见下面的字段）。
   *
   * 为什么剥：这两个段落原来混在描述里，而描述会被截断到 240 字符 —— 写在末尾的
   * 触发词**永远到不了模型**（本机 38 个技能里有 16 个中招）。现在它们各有独立字段。
   */
  description: string;
  /** `USE FOR:` / `Use when:` / `适用：` 之后的「什么时候该用」。 */
  useFor?: string;
  /**
   * 触发词。来自 `Triggers:` / `触发词：` 段落，或 frontmatter 里显式的 `triggers:`。
   *
   * 单独一个字段的意义：它不参与描述截断，路由表里会**原样带上**，所以放在描述
   * 第几段都不影响模型看不看得见。
   */
  triggers?: string[];
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
  /**
   * 运行期的停滞提示（长时间没有输出、或已超时正在结束进程）。
   * 只在还「没结束」时有意义：结果落定后会清掉，不进入存档语义。
   */
  stallHint?: string;
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

/**
 * 一张等用户拍板的方案卡片（`ask_user_choice`）。
 *
 * 与 `PendingApprovalView` 分开而不是复用它：审批问「允不允许做」，这里问
 * 「**做哪一个**」，后者要按选项渲染成多张对比卡片。混成一种结构会让界面和
 * 用户都分不清哪张在拦权限、哪张在等决策。
 */
export interface PendingDecisionView {
  requestId: string;
  conversationId: string;
  question: string;
  why?: string;
  options: Array<{
    /** 这个方案是什么（动词开头，几个字）。 */
    title: string;
    /** 做成之后用户能得到什么。 */
    achieves: string;
    /** 做到什么地步：范围内/外，哪里还粗糙。 */
    extent: string;
    /** 代价：时间、改动面、风险、后续维护。 */
    cost: string;
  }>;
}

/**
 * 标题旁的项目徽标。
 *
 * 一个对话可以改到多个项目，所以这里是一组名字而不是一个：
 * - `name`：本次对话的主项目（相对路径与 git 写操作的归属），未绑定时为 null；
 * - `others`：本对话改过文件、但不是主项目的其它项目，按首次触达顺序；
 * - `bound`：是否已落到某个工作区文件夹（为假表示 git 写操作会被拒绝）。
 */
export interface ProjectBadgeView {
  name: string | null;
  others: string[];
  bound: boolean;
}

export interface WebviewConversationState {
  conversation: ConversationSummary | null;
  /**
   * 首页消息。
   *
   * `messagesUnchanged` 为 true 时这里是**空数组**，webview 必须保留自己已有的列表 ——
   * 一条 1513 条消息的对话，光首页 80 条就是 5.39 MB，而绝大多数状态推送只改了设置
   * 或清单，消息一条没变。实测每次推送约 27ms 主线程开销，省掉它才谈得上「流畅」。
   */
  messages: ChatMessage[];
  messagesUnchanged?: boolean;
  hasMore: boolean;
  conversations: ConversationSummary[];
  settings: Pick<ChatSettings, 'apiProfiles' | 'activeApiProfileId' | 'model' | 'sendOnEnter' | 'permissionPreset' | 'agentMaxSteps' | 'reasoningEffort' | 'internetReference'>;
  apiKeyConfigured: boolean;
  pendingAttachments: Array<Pick<MessageContext, 'id' | 'label' | 'path' | 'kind' | 'bytes' | 'mimeType' | 'thumbnailDataUrl'>>;
  modelOptionsByProfile: Record<string, ModelOption[]>;
  archivedConversations: ConversationSummary[];
  skills: SkillSummary[];
  /**
   * 当前生效的 Skill（勾选的）：来自共享清单的全局勾选 + 本对话的非共享选择。
   *
   * 勾选框直接照这个渲染，界面不自己维护一份——两份状态一定会漂。
   */
  selectedSkillIds: string[];
  /**
   * 「本地skill快捷调用」扩展是否已安装。
   *
   * 那扩展是全局勾选状态的唯一落盘方，没装就没有地方存，界面改为引导安装。
   */
  quickLaunchInstalled: boolean;
  mode: ConversationMode;
  workspaceTrusted: boolean;
  agentAvailable: boolean;
  /**
   * 对话标题旁的项目徽标（本对话涉及的全部项目）。
   *
   * `bound` 为假表示这条对话还没落到任何工作区文件夹上（`projectRootFor` 返回 undefined）——
   * 这个状态下 git 写操作会被拒绝，所以必须让用户看得见，而不是显示一个猜的目录名。
   */
  project: ProjectBadgeView;
  /**
   * 正文里文件引用的解析上下文。
   *
   * webview 没有文件系统，相对路径（`src/core/ids.ts`）没法自己变成绝对路径。
   * 这里把工作区根目录和本对话的项目根一起下发，界面就能把相对路径拼完整，
   * 右键「在系统中显示」时再把绝对路径回传。
   *
   * 只下发**目录**，不下发任何文件内容。
   */
  fileRoots: { roots: string[]; preferred?: string };
  /**
   * 右键菜单里那个「在 X 中显示」的 X：Finder / 资源管理器 / 文件管理器。
   *
   * 由扩展按 `process.platform` 决定，界面只负责查文案表——
   * 平台判断放在一处，才不会出现「Windows 上写成 Finder」这种错位。
   */
  fileTarget: 'finder' | 'explorer' | 'fileManager';

  availableToolCount: number;
  taskTree?: AgentTaskTreeState;
  showArchived: boolean;
  todos?: TodoItem[];
  /** 已归档的任务清单（胶囊），颜色由扩展计算。 */
  todoArchives?: TodoArchiveView[];
  /** 当前清单是否被中断过；界面据此在折叠框标题上标「已中断」。 */
  todosInterrupted?: boolean;
  /** 当前清单是否「正常跑完但没结清」；界面据此标「未完成」，与「已中断」区分开。 */
  todosIncomplete?: boolean;
  /**
   * 正在后台执行的对话 id 列表。
   *
   * 多线程对话：每个对话各自跑自己的 Agent 循环，用户切走对话不会中断它。
   * 界面据此在历史列表上打「运行中」圆点，并决定输入框的发送/停止按钮状态。
   */
  runningConversationIds?: string[];
  /** 仍在等待用户确认的工具授权（可能属于别的对话）。 */
  pendingApprovals?: PendingApprovalView[];
  /**
   * 仍在等用户拍板的方案卡片。
   *
   * 随状态一起重发：面板重载、切对话回来，卡片都还在（否则那条线程会静默卡在
   * 等决策上，用户只看到「agent 正在执行」却没有任何可点的地方）。
   */
  pendingDecisions?: PendingDecisionView[];
}
