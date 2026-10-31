import { isAbsolute, join, resolve } from 'node:path';
import { Dirent } from 'node:fs';
import {
  cp,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isEmptyDraftConversation } from './conversationControls';
import { createId, createOrderedId, previewText, shortTitle } from './ids';
import { readJsonWithBackup, removeIfPresent, writeJsonAtomic } from './jsonFile';
import {
  ChatMessage,
  CleanupOptions,
  CleanupResult,
  ConversationHistoryHit,
  ConversationExport,
  ConversationSummary,
  ConversationMode,
  MessageExecutionStatus,
  StorageStats,
  TodoArchive,
  TodoItem,
} from './types';
import { normalizeTodoArchives } from './todoArchives';
import { tt } from './i18n';
import { AGENT_MAX_STEPS_UNLIMITED, AGENT_STEP_SAFETY_CAP } from './agentLimits';

interface Manifest {
  version: 1;
  conversations: ConversationSummary[];
}

/**
 * 收掉多余空对话前的最小存活时间。
 *
 * 空对话没有内容可丢，但「刚点完新建就凭空消失」会让人以为按钮坏了；
 * 留 5 分钟，足够覆盖「点开、看一眼、接着用」的正常节奏。
 */
const EMPTY_DRAFT_PRUNE_GRACE_MS = 5 * 60 * 1000;

const MANIFEST_VERSION = 1 as const;

/**
 * 归档标记的落盘文件名。
 *
 * 为什么要它：代码里多处「不可删」的保护都读内存里的 `summary.archived`
 * （超期清理、缓存预算回收）。而 manifest 一旦读不出来（写到一半断电、手改坏），
 * `rebuildManifestFromDisk()` 会把所有对话重建为 `archived: false` —— 保护随之失效，
 * 下一次清理就会把它们当普通旧对话回收掉。用户 2026-10-31 报的「13 条归档对话消失」
 * 正是这个组合：`rm -rf` + 标记只存在内存里。
 *
 * 标记写进对话目录本身，manifest 丢了也还在。
 */
const ARCHIVED_MARKER = '.archived';

/**
 * 「归档守护快照」。
 *
 * 记录上一次启动时**归档**的对话。下次启动如果某条归档既不在磁盘上、也不在回收站里，
 * 就说明它在我们不知情的情况下消失了 —— 立刻告警，而不是等几个月后用户自己发现。
 * 这是唯一能对「未知的删除路径」兜底的手段。
 */
interface SafetySnapshot {
  version: 1;
  archived: Array<{ id: string; title: string; archivedAt?: number }>;
  savedAt: number;
}

/**
 * 一条对话为什么进了回收站。
 *
 * `'expired'` / `'budget'` 只为兼容旧版本写下的条目保留（那时自动清理会直接搬走对话），
 * 现在 HWChat 只会产生 `'draft'`（空对话）与 `'manual'`（用户自己删的）两种。
 */
export type TrashReason = 'draft' | 'expired' | 'budget' | 'manual';

export interface TrashEntry {
  /**
   * 回收站里的目录名。
   *
   * 平时就是对话 id；同一条对话被反复删除（恢复后又删）时会带时间后缀，
   * 这样旧的那份不会被新的覆盖掉 —— 覆盖也是丢数据。
   */
  id: string;
  /** 原始的对话 id，恢复时按它落回 `conversations/<id>`。 */
  conversationId: string;
  title: string;
  messageCount: number;
  archived: boolean;
  deletedAt: number;
  reason: TrashReason;
}
const MAX_UI_MESSAGES = 200;
/** 首屏消息页缓存最多保留几条对话的首页（够覆盖「切回上一条对话」这个高频动作）。 */
const MESSAGE_PAGE_CACHE_LIMIT = 8;

export class ConversationStorage {
  private readonly manifestPath: string;
  private readonly conversationsPath: string;
  /** 自动删除（草稿清理 / 超期 / 预算回收）的对话挪到这里，而不是直接 rm。 */
  private readonly trashPath: string;
  private readonly safetyPath: string;
  /** 本次启动发现「归档对话无故消失」时的告警，由宿主取走并提示用户。 */
  private integrityAlert: { missing: Array<{ id: string; title: string }> } | undefined;
  private manifest: Manifest = { version: MANIFEST_VERSION, conversations: [] };
  private initialized = false;
  private initializing: Promise<void> | undefined;
  private writeTail: Promise<unknown> = Promise.resolve();
  private lastMessageTimestamp = 0;
  /**
   * 首屏消息页缓存（真实性能缺口）。
   *
   * `ChatPanel.sendState()` 每次都会 `getMessages({limit: 80})`，而它有 19 个调用点
   * （切预设 / 切模型 / 加附件 / 归档 / 每轮 Agent 结束…）。21MB 历史实测：一次
   * 80 条消息要从磁盘读并解析 80 个 JSON，**28ms CPU**；点两下界面就是上百毫秒。
   *
   * 这里按「对话 + 失效代数」缓存首页结果：任何一次写入/删除消息、清理、重建都会
   * 让代数 +1，于是缓存只会在**内容真的没变**时命中——不存在「文件改了还返回旧消息」。
   * 只保留最近几页（`MESSAGE_PAGE_CACHE_LIMIT`），不会把整份历史留在内存里。
   */
  private readonly messagePageCache = new Map<string, { generation: number; page: { messages: ChatMessage[]; hasMore: boolean } }>();
  /** 消息内容代数：任何写/删/清理都会 +1，用于让上面那份页缓存失效。 */
  private messageGeneration = 0;
  /**
   * 每条对话的写入次数（清理的增量扫描用）。
   *
   * `cleanup()` 原来每 10 分钟把所有对话的每个消息文件读一遍 + `JSON.parse` 一遍，
   * 只为了判断「要不要瘦身 / 要不要按保留期删除」。本机 19.29MB 历史实测
   * **131ms CPU / 122ms 墙钟一次，而 `compacted=0 deleted=0`——纯白跑**，一天 144 次。
   *
   * 这里给每条对话记一个写入序号：只有「自上次扫描后又被写过」的对话才需要重扫，
   * 其余直接复用上次量到的字节数/消息数。语义不变（内容没变就不可能有要瘦身或过期的东西），
   * 唯一需要额外兜底的是**时间**：保留期是按时间前进的，所以过了最短窗口仍会整体重扫一次。
   */
  private readonly conversationRevisions = new Map<string, number>();
  /** 上次清理扫描时每条对话的写入序号 + 量到的体积/条数。 */
  private readonly cleanupScanCache = new Map<string, { revision: number; bytes: number; messages: number }>();
  private cleanupScanAt = 0;
  private cleanupScanKey: string | null = null;

  constructor(private readonly rootPath: string) {
    this.manifestPath = join(rootPath, 'manifest.json');
    this.conversationsPath = join(rootPath, 'conversations');
    this.trashPath = join(rootPath, 'trash');
    this.safetyPath = join(rootPath, 'safety.json');
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.initializing) {
      this.initializing = (async () => {
        await mkdir(this.conversationsPath, { recursive: true });
        const stored = await readJsonWithBackup<Manifest>(this.manifestPath);
        if (stored?.version === MANIFEST_VERSION && Array.isArray(stored.conversations)) {
          this.manifest = {
            version: MANIFEST_VERSION,
            // 归档列表来自磁盘，可能是老版本写的或被手工改过，进来就归一化一次。
            conversations: stored.conversations.filter((item) => Boolean(item?.id)).map((item) => sanitizeSummary(item)),
          };
        } else {
          await this.rebuildManifestFromDisk();
        }
        // 中断消息的恢复与清单对账共用同一次遍历。
        // 以前这里是「recoverInterruptedMessages 读一遍全部消息 → reconcileManifest
        // 再读一遍」：每次 VS Code 启动都付双份 JSON 解析与 IO（21MB 历史实测多付
        // 约 130ms CPU）。两个入口本来就要逐条读，顺手修好即可，语义完全一致。
        await this.reconcileManifest();
        await this.reconcileArchiveMarkers();
        // 必须在 reconcile 之后：先让磁盘状态稳定下来，再判断「谁不见了」。
        await this.checkArchivedIntegrity();
        this.initialized = true;
      })();
    }
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  async listConversations(options: { archived?: boolean; includeArchived?: boolean } = {}): Promise<ConversationSummary[]> {
    await this.initialize();
    return this.sortedSummaries()
      .filter((summary) => options.includeArchived === true || options.archived === undefined || Boolean(summary.archived) === options.archived)
      .map((summary) => ({ ...summary }));
  }

  async getConversation(id: string): Promise<ConversationSummary | undefined> {
    await this.initialize();
    const summary = this.findSummary(id);
    return summary ? { ...summary } : undefined;
  }

  /**
   * 新建对话。
   *
   * `mode` 由调用方传入（面板传当前选择 / 设置默认值）：以前这里写死 `'agent'`，
   * 建好的对话在面板 `send()` 补齐模式之前都是 Agent，任何读摘要的路径都会看到错的值。
   */
  async createConversation(title = tt('storage.defaultTitle'), model?: string, mode: ConversationMode = 'agent'): Promise<ConversationSummary> {
    await this.initialize();
    const now = Math.max(Date.now(), this.lastMessageTimestamp + 1);
    this.lastMessageTimestamp = now;
    const summary: ConversationSummary = {
      id: createId('conversation'),
      title: shortTitle(title),
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      preview: '',
      pinned: false,
      totalTokens: 0,
      model,
      apiProfileId: undefined,
      mode,
      skillIds: [],
      skillSelectionInitialized: false,
      archived: false,
    };
    await this.enqueueWrite(async () => {
      await mkdir(this.messageDirectory(summary.id), { recursive: true });
      this.manifest.conversations.push(summary);
      await this.persistManifest();
    });
    return { ...summary };
  }

  async appendMessage(
    conversationId: string,
    input: Omit<ChatMessage, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<ChatMessage, 'id'>>,
  ): Promise<ChatMessage> {
    await this.initialize();
    const summary = this.requireSummary(conversationId);
    const now = Math.max(Date.now(), this.lastMessageTimestamp + 1);
    this.lastMessageTimestamp = now;
    const message: ChatMessage = {
      id: input.id ?? createOrderedId('message', now),
      role: input.role,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      status: input.status ?? 'complete',
      reasoning: input.reasoning,
      usage: input.usage,
      model: input.model,
      context: input.context,
      attachments: input.attachments,
      toolExecutions: input.toolExecutions,
      toolCalls: input.toolCalls,
      toolCallId: input.toolCallId,
      usedSkills: input.usedSkills,
      consumedByAssistantId: input.consumedByAssistantId,
      replyToMessageId: input.replyToMessageId,
      executionStatus: normalizeExecutionStatus(input.executionStatus),
    };
    await this.enqueueWrite(async () => {
      await writeJsonAtomic(this.messagePath(conversationId, message.id), message);
      this.invalidateMessagePages();
      this.markConversationChanged(conversationId);
      summary.messageCount += 1;
      summary.totalTokens = Math.max(0, (summary.totalTokens ?? 0) + (message.usage?.totalTokens ?? 0));
      summary.updatedAt = now;
      summary.preview = previewText(message.content);
      if (message.role === 'user' && !summary.titleCustomized && summary.title === tt('storage.defaultTitle')) {
        summary.title = shortTitle(message.content);
      }
      if (message.role === 'assistant' && message.toolExecutions?.length) {
        summary.preview = previewText(message.toolExecutions.at(-1)?.summary ?? message.content);
      }
      if (message.model) {
        summary.model = message.model;
      }
      await this.persistManifest();
    });
    return { ...message };
  }

  async updateMessage(
    conversationId: string,
    messageId: string,
    patch: Partial<Pick<ChatMessage, 'content' | 'reasoning' | 'usage' | 'status' | 'model' | 'toolExecutions' | 'toolCalls' | 'usedSkills' | 'consumedByAssistantId' | 'replyToMessageId' | 'executionStatus'>>,
  ): Promise<ChatMessage> {
    await this.initialize();
    const summary = this.requireSummary(conversationId);
    let updated!: ChatMessage;
    await this.enqueueWrite(async () => {
      const current = await this.readMessage(conversationId, messageId);
      if (!current) {
        throw new Error(tt('storage.messageMissing'));
      }
      updated = {
        ...current,
        ...patch,
        ...(patch.executionStatus === undefined ? {} : { executionStatus: normalizeExecutionStatus(patch.executionStatus) }),
        updatedAt: Date.now(),
      };
      summary.totalTokens = Math.max(
        0,
        (summary.totalTokens ?? 0) - (current.usage?.totalTokens ?? 0) + (updated.usage?.totalTokens ?? 0),
      );
      await writeJsonAtomic(this.messagePath(conversationId, messageId), updated);
      this.invalidateMessagePages();
      this.markConversationChanged(conversationId);
      if (updated.status === 'complete' || updated.status === 'error') {
        await removeIfPresent(`${this.messagePath(conversationId, messageId)}.bak`);
      }
      summary.updatedAt = updated.updatedAt;
      if (updated.content) {
        summary.preview = previewText(updated.content);
      }
      if (updated.model) {
        summary.model = updated.model;
      }
      await this.persistManifest();
    });
    return { ...updated };
  }

  /**
   * 删掉一条消息。
   *
   * 目前只有「删除排队中的消息」用它：那条消息还没被 agent 读过，从队列里撤掉之后
   * 存档里也不该再留着，否则重开对话会看到一条既不会执行、也没有回复的孤儿消息。
   *
   * 已经落成的对话历史不提供删除入口 —— 删掉一问一答里的问句会让上下文断裂。
   */
  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    await this.initialize();
    const summary = this.requireSummary(conversationId);
    await this.enqueueWrite(async () => {
      const current = await this.readMessage(conversationId, messageId);
      if (!current) return;
      await removeIfPresent(this.messagePath(conversationId, messageId));
      await removeIfPresent(`${this.messagePath(conversationId, messageId)}.bak`);
      this.invalidateMessagePages();
      this.markConversationChanged(conversationId);
      summary.messageCount = Math.max(0, (summary.messageCount ?? 1) - 1);
      summary.totalTokens = Math.max(0, (summary.totalTokens ?? 0) - (current.usage?.totalTokens ?? 0));
      summary.updatedAt = Date.now();
      await this.persistManifest();
    });
  }

  async getMessages(
    conversationId: string,
    options: { limit?: number; before?: string; maxBytes?: number } = {},
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    await this.initialize();
    this.requireSummary(conversationId);
    // 只有「默认参数的首屏」才缓存：翻页（before）与自定义字节预算的调用很少，
    // 缓存它们只会挤掉真正高频的那一份。
    const cacheKey = this.pageCacheKey(conversationId, options);
    const cached = cacheKey ? this.messagePageCache.get(cacheKey) : undefined;
    if (cached && cached.generation === this.messageGeneration) {
      // 消息对象本身当作只读共享，但数组与顶层字段各给一份副本：
      // 调用方排序 / 改写顶层字段时不会污染缓存。
      return { messages: cached.page.messages.map((message) => ({ ...message })), hasMore: cached.page.hasMore };
    }
    const files = await this.messageFiles(conversationId);
    const ordered = files.sort((a, b) => a.localeCompare(b));
    const beforeIndex = options.before ? ordered.findIndex((file) => file === `${options.before}.json`) : -1;
    const end = beforeIndex >= 0 ? beforeIndex : ordered.length;
    const limit = Math.min(Math.max(options.limit ?? MAX_UI_MESSAGES, 1), MAX_UI_MESSAGES);
    const maxBytes = Math.max(256 * 1024, options.maxBytes ?? 6 * 1024 * 1024);
    const messages: ChatMessage[] = [];
    let bytes = 0;
    let index = end - 1;
    for (; index >= 0 && messages.length < limit; index -= 1) {
      const file = ordered[index]!;
      const message = await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(conversationId), file));
      if (message) {
        const messageBytes = Buffer.byteLength(JSON.stringify(message));
        if (messages.length > 0 && bytes + messageBytes > maxBytes) {
          break;
        }
        bytes += messageBytes;
        // 存档可能是手改的：认不出来的执行状态在这里就丢掉，别让它流到界面。
        message.executionStatus = normalizeExecutionStatus(message.executionStatus);
        messages.unshift(message);
      }
    }
    const page = { messages, hasMore: index >= 0 };
    if (cacheKey) this.rememberPage(cacheKey, page);
    return { messages: page.messages.map((message) => ({ ...message })), hasMore: page.hasMore };
  }

  /** 只有默认首屏（无 before、无自定义字节预算、默认 limit）才值得缓存。 */
  private pageCacheKey(
    conversationId: string,
    options: { limit?: number; before?: string; maxBytes?: number },
  ): string | undefined {
    if (options.before || options.maxBytes !== undefined) return undefined;
    const limit = Math.min(Math.max(options.limit ?? MAX_UI_MESSAGES, 1), MAX_UI_MESSAGES);
    if (limit !== 80) return undefined;
    return `${conversationId}\u0000${limit}`;
  }

  private rememberPage(key: string, page: { messages: ChatMessage[]; hasMore: boolean }): void {
    this.messagePageCache.delete(key);
    this.messagePageCache.set(key, { generation: this.messageGeneration, page });
    while (this.messagePageCache.size > MESSAGE_PAGE_CACHE_LIMIT) {
      const oldest = this.messagePageCache.keys().next();
      if (oldest.done) break;
      this.messagePageCache.delete(oldest.value);
    }
  }

  /** 内容变了：让所有页缓存失效（调用方只需写一行，不必记得清哪些 key）。 */
  /** 记账：这条对话的消息内容变了，下一次清理必须重扫它。 */
  private markConversationChanged(conversationId: string): void {
    this.conversationRevisions.set(conversationId, (this.conversationRevisions.get(conversationId) ?? 0) + 1);
  }

  private invalidateMessagePages(): void {
    this.messageGeneration += 1;
    this.messagePageCache.clear();
  }

  async getAllMessages(conversationId: string): Promise<ChatMessage[]> {
    await this.initialize();
    this.requireSummary(conversationId);
    const files = (await this.messageFiles(conversationId)).sort((a, b) => a.localeCompare(b));
    const messages: ChatMessage[] = [];
    for (const file of files) {
      const message = await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(conversationId), file));
      if (message) {
        messages.push(message);
      }
    }
    return messages;
  }

  async getContextMessages(
    conversationId: string,
    maxMessages: number,
    maxBytes = 2 * 1024 * 1024,
  ): Promise<ChatMessage[]> {
    await this.initialize();
    this.requireSummary(conversationId);
    const files = (await this.messageFiles(conversationId)).sort((a, b) => b.localeCompare(a));
    const messages: ChatMessage[] = [];
    let bytes = 0;
    for (const file of files) {
      if (maxMessages > 0 && messages.length >= maxMessages) {
        break;
      }
      const message = await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(conversationId), file));
      if (!message) {
        continue;
      }
      const messageBytes = Buffer.byteLength(JSON.stringify(message));
      if (messages.length > 0 && bytes + messageBytes > maxBytes) {
        break;
      }
      bytes += messageBytes;
      messages.unshift(message);
    }
    return messages;
  }

  async searchConversationMessages(conversationId: string, query = '', limit = 12): Promise<ConversationHistoryHit[]> {
    await this.initialize();
    this.requireSummary(conversationId);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const cappedLimit = Math.min(30, Math.max(1, Math.floor(limit) || 12));
    const files = (await this.messageFiles(conversationId)).sort((a, b) => b.localeCompare(a));
    const hits: ConversationHistoryHit[] = [];
    for (const file of files) {
      const message = await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(conversationId), file));
      if (!message) continue;
      const searchable = [
        message.content,
        message.reasoning,
        ...(message.toolExecutions ?? []).flatMap((tool) => [tool.summary, tool.output, ...(tool.changedFiles ?? [])]),
        ...(message.usedSkills ?? []).flatMap((skill) => [skill.name, skill.relativePath]),
      ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join('\n');
      if (normalizedQuery && !searchable.toLocaleLowerCase().includes(normalizedQuery)) continue;
      hits.push({
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        excerpt: historyExcerpt(searchable, normalizedQuery, 1_200),
      });
      if (hits.length >= cappedLimit) break;
    }
    return hits;
  }

  async setPinned(conversationId: string, pinned: boolean): Promise<ConversationSummary> {
    await this.initialize();
    const summary = this.requireSummary(conversationId);
    await this.enqueueWrite(async () => {
      summary.pinned = pinned;
      summary.updatedAt = Date.now();
      await this.persistManifest();
    });
    return { ...summary };
  }

  /**
   * 用户自定义对话标题。
   *
   * 两件事和普通 `updateConversation({ title })` 不同：
   * 1. 打上 `titleCustomized`，首条消息的自动命名从此不再覆盖它；
   * 2. 不动 `updatedAt` —— 改个名字不算「这对话有新活动」，不该把历史列表的时序打乱。
   *
   * 传空串（或只有空白）视为放弃修改，保持原标题不变。
   */
  async setTitle(conversationId: string, title: string): Promise<ConversationSummary> {
    await this.initialize();
    const summary = this.requireSummary(conversationId);
    const normalized = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return { ...summary };
    }
    await this.enqueueWrite(async () => {
      summary.title = shortTitle(normalized);
      summary.titleCustomized = true;
      await this.persistManifest();
    });
    return { ...summary };
  }

  async updateConversation(
    conversationId: string,
    patch: Partial<Pick<ConversationSummary, 'title' | 'model' | 'apiProfileId' | 'mode' | 'skillIds' | 'skillSelectionInitialized' | 'projectRoot' | 'projectRoots' | 'permissionPreset' | 'agentMaxSteps' | 'reasoningEffort' | 'internetReference'>> & {
      sourceConversationId?: string | null;
      sourceConversationTitle?: string | null;
      sourceHistoryDigest?: string | null;
      sourceLinkedAt?: number | null;
      todos?: TodoItem[] | null;
      todoArchives?: TodoArchive[] | null;
      todosInterrupted?: boolean | null;
      todosIncomplete?: boolean | null;
    },
  ): Promise<ConversationSummary> {
    await this.initialize();
    const summary = this.requireSummary(conversationId);
    await this.enqueueWrite(async () => {
      if (patch.title !== undefined) {
        summary.title = shortTitle(patch.title);
      }
      if (patch.model !== undefined) {
        summary.model = patch.model;
      }
      if (patch.apiProfileId !== undefined) {
        summary.apiProfileId = patch.apiProfileId;
      }
      if (patch.mode !== undefined) {
        summary.mode = patch.mode;
      }
      if (patch.skillIds !== undefined) {
        summary.skillIds = [...new Set(patch.skillIds)];
        summary.skillSelectionInitialized = patch.skillSelectionInitialized ?? true;
      } else if (patch.skillSelectionInitialized !== undefined) {
        summary.skillSelectionInitialized = patch.skillSelectionInitialized;
      }
      assignOptional(summary, 'sourceConversationId', patch.sourceConversationId);
      assignOptional(summary, 'sourceConversationTitle', patch.sourceConversationTitle);
      assignOptional(summary, 'sourceHistoryDigest', patch.sourceHistoryDigest);
      assignOptional(summary, 'sourceLinkedAt', patch.sourceLinkedAt);
      // 待办清单整体替换：模型每次传的都是完整清单，合并反而会留下过期条目。
      if (patch.todos !== undefined) {
        if (patch.todos && patch.todos.length) summary.todos = patch.todos.map((todo) => ({ ...todo }));
        else delete summary.todos;
      }
      // 归档列表同样是整体替换：调用方已经做过上限裁剪，这里只负责深拷贝落库。
      if (patch.todoArchives !== undefined) {
        if (patch.todoArchives && patch.todoArchives.length) {
          summary.todoArchives = patch.todoArchives.map((archive) => ({
            id: archive.id,
            createdAt: archive.createdAt,
            todos: archive.todos.map((todo) => ({ content: todo.content, status: todo.status })),
          }));
        } else {
          delete summary.todoArchives;
        }
      }
      // 中断标记是布尔量：写 null/false 表示「这份清单不再算中断」（归档了或换了新清单）。
      if (patch.todosInterrupted !== undefined) {
        if (patch.todosInterrupted) {
          summary.todosInterrupted = true;
          delete summary.todosIncomplete;
        } else {
          delete summary.todosInterrupted;
        }
      }
      // 「未完成」标记同理，且与中断标记互斥：置一个就把另一个清掉，避免面板同时挂两个标签。
      if (patch.todosIncomplete !== undefined) {
        if (patch.todosIncomplete) {
          summary.todosIncomplete = true;
          delete summary.todosInterrupted;
        } else {
          delete summary.todosIncomplete;
        }
      }
      // 项目归属与运行时设置：无效值一律当作「没有设置」，回落到全局默认，
      // 而不是把脏值留在存档里让运行时去猜。
      applyOptional(summary, 'projectRoot', normalizeProjectRoot(patch.projectRoot));
      // 涉及的项目是整体替换：调用方每次传的就是完整列表，合并只会留下过期项目。
      if (patch.projectRoots !== undefined) {
        const roots = normalizeProjectRoots(patch.projectRoots);
        if (roots.length) summary.projectRoots = roots;
        else delete summary.projectRoots;
      }
      applyOptional(summary, 'permissionPreset', normalizeStoredPreset(patch.permissionPreset));
      applyOptional(summary, 'agentMaxSteps', normalizeStoredSteps(patch.agentMaxSteps));
      applyOptional(summary, 'reasoningEffort', normalizeStoredReasoning(patch.reasoningEffort));
      // 互联网参考：只认布尔 true。false 时把字段删掉（默认就是关），
      // 免得存档里留一堆 `internetReference: false` 让「有没有开过」看不出来。
      if (patch.internetReference !== undefined) {
        if (patch.internetReference === true) summary.internetReference = true;
        else delete summary.internetReference;
      }
      summary.updatedAt = Date.now();
      await this.persistManifest();
    });
    return { ...summary };
  }

  async setArchived(conversationId: string, archived: boolean): Promise<ConversationSummary> {
    await this.initialize();
    const summary = this.requireSummary(conversationId);
    await this.enqueueWrite(async () => {
      summary.archived = archived;
      summary.archivedAt = archived ? Date.now() : undefined;
      summary.updatedAt = Date.now();
      /*
       * 同时落一份标记文件到对话目录。
       *
       * 内存里的 `archived` 只活到这次运行结束；manifest 一旦读不出来就会被
       * `rebuildManifestFromDisk()` 重建为 `archived: false`，而超期清理与预算回收
       * 都靠这个字段判断「能不能删」——标记丢了，归档对话就会被当普通旧对话删掉。
       */
      if (archived) {
        await mkdir(this.conversationDirectory(conversationId), { recursive: true }).catch(() => undefined);
        await writeFile(this.archivedMarkerPath(conversationId), String(summary.archivedAt ?? Date.now()), 'utf8').catch(() => undefined);
      } else {
        await rm(this.archivedMarkerPath(conversationId), { force: true }).catch(() => undefined);
      }
      await this.persistManifest();
      await this.persistSafetySnapshot();
    });
    return { ...summary };
  }

  /**
   * 删除一条对话 —— 但只是**移入回收站**。
   *
   * 用户点「删除」表达的是「从列表里拿掉」，不等于「现在就销毁」。真正的销毁只在
   * 用户清空回收站（设置里的危险区）时发生，所以删错了永远还能找回来。
   */
  async deleteConversation(conversationId: string): Promise<void> {
    await this.initialize();
    const summary = this.requireSummary(conversationId);
    await this.enqueueWrite(async () => {
      this.invalidateMessagePages();
      if (!await this.moveToTrash(conversationId, summary, 'manual')) {
        // 搬不进回收站就保持原样：宁可删不掉，也不能把内容弄丢。
        throw new Error(tt('storage.trashFailed'));
      }
      this.conversationRevisions.delete(conversationId);
      this.cleanupScanCache.delete(conversationId);
      this.manifest.conversations = this.manifest.conversations.filter((item) => item.id !== conversationId);
      await this.persistManifest();
      // 用户明确删掉的，必须立刻从「归档守护快照」里去掉，否则下次启动会误报缺失。
      await this.persistSafetySnapshot();
    });
  }

  /**
   * 永久清空回收站（**只有用户明确要求时才能调用**）。
   *
   * 传入 `entryIds` 只清指定的几条；不传表示清空。这是整个存储里唯一会销毁
   * 对话内容的地方（另一处是设置里的「清除本地数据」）。
   */
  async purgeTrash(entryIds?: string[]): Promise<number> {
    await this.initialize();
    return this.enqueueWrite(async () => {
      const entries = await this.readTrashIndex();
      const selected = entryIds ? entries.filter((entry) => entryIds.includes(entry.id)) : entries;
      let removed = 0;
      for (const entry of selected) {
        await this.destroyTrashEntry(entry.id);
        removed += 1;
      }
      const remaining = entryIds
        ? entries.filter((entry) => !entryIds.includes(entry.id))
        : [];
      await writeJsonAtomic(this.trashIndexPath, remaining, false).catch(() => undefined);
      return removed;
    });
  }

  async clearAll(): Promise<void> {
    await this.initialize();
    await this.enqueueWrite(async () => {
      await rm(this.conversationsPath, { recursive: true, force: true });
      await mkdir(this.conversationsPath, { recursive: true });
      this.manifest = { version: MANIFEST_VERSION, conversations: [] };
      // 清空后增量扫描的记账也必须一起清掉，否则下次清理会沿用已不存在的对话的体积。
      this.conversationRevisions.clear();
      this.cleanupScanCache.clear();
      await this.persistManifest();
      // 清空是用户明确要求的，快照必须一起清掉，否则下次启动会把它们全报成「无故消失」。
      await this.persistSafetySnapshot();
    });
  }

  async exportConversation(conversationId: string): Promise<ConversationExport> {
    await this.initialize();
    const conversation = this.requireSummary(conversationId);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      conversation: { ...conversation },
      messages: await this.getAllMessages(conversationId),
    };
  }

  async writeExportFile(destination: string, conversationId?: string): Promise<void> {
    await this.initialize();
    const selected = conversationId
      ? [this.requireSummary(conversationId)]
      : this.sortedSummaries();
    const handle = await open(destination, 'w');
    try {
      await handle.write('{\n  "version": 1,\n');
      await handle.write(`  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n`);
      await handle.write('  "conversations": [\n');
      for (let index = 0; index < selected.length; index += 1) {
        const summary = selected[index]!;
        await handle.write('    {\n');
        await handle.write(`      "conversation": ${JSON.stringify(summary, null, 2).replace(/\n/g, '\n      ')},\n`);
        await handle.write('      "messages": [\n');
        const files = (await this.messageFiles(summary.id)).sort((a, b) => a.localeCompare(b));
        let written = 0;
        for (const file of files) {
          const message = await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(summary.id), file));
          if (!message) {
            continue;
          }
          if (written > 0) {
            await handle.write(',\n');
          }
          const json = JSON.stringify(message, null, 2).replace(/\n/g, '\n        ');
          await handle.write(`        ${json}`);
          written += 1;
        }
        await handle.write('\n      ]\n    }');
        if (index < selected.length - 1) {
          await handle.write(',');
        }
        await handle.write('\n');
      }
      await handle.write('  ]\n}\n');
    } finally {
      await handle.close();
    }
  }

  async cleanup(options: CleanupOptions): Promise<CleanupResult> {
    await this.initialize();
    let compactedMessages = 0;
    let deletedMessageCacheBytes = 0;
    let deletedConversations = 0;
    let scannedConversations = 0;
    let prunedDrafts = 0;
    let overBudget = false;
    let totalBytes = 0;
    let totalMessages = 0;
    await this.enqueueWrite(async () => {
      // 清理会压缩消息体、删除过期对话：整段任务开始时让页缓存失效一次，
      // 避免「刚清理完还把带附件的旧消息交给界面」。
      this.invalidateMessagePages();
      const now = Date.now();
      const retentionMs = Math.max(0, options.taskCacheRetentionHours) * 60 * 60 * 1000;
      const historyMs = Math.max(0, options.historyRetentionDays) * 24 * 60 * 60 * 1000;
      const protectedIds = new Set(options.protectedConversationIds ?? []);
      for (const conversation of this.manifest.conversations) {
        if (conversation.sourceConversationId) protectedIds.add(conversation.sourceConversationId);
      }

      // 增量扫描的判定：内容没变就跳过整条对话的读盘。
      //  - 写入序号变了 → 必须重扫（可能新增附件/推理内容要瘦身，也可能要按保留期删）；
      //  - 保留期是按时间前进的，所以「距上次扫描已超过最短窗口」时整体重扫一次；
      //  - 保留天数/小时数被改过 → 判定基准变了，整体重扫一次。
      const scanKey = `${options.historyRetentionDays}:${options.taskCacheRetentionHours}`;
      const windows = [retentionMs, historyMs].filter((value) => value > 0);
      const windowMs = windows.length ? Math.min(...windows) : 0;
      const elapsed = this.cleanupScanKey === scanKey ? now - this.cleanupScanAt : Number.POSITIVE_INFINITY;
      const timeRefresh = windowMs > 0 && elapsed >= windowMs;
      const optionsChanged = this.cleanupScanKey !== scanKey;
      const bytesById = new Map<string, number>();
      const countById = new Map<string, number>();

      /**
       * 空对话只保留**最新的一张**。
       *
       * 用户反馈：历史里堆了 6 张「新对话 · 空对话」，分不清是哪一条。现在
       * 新建对话在「当前已是空对话」时不再新建（见 `ChatPanel.newChat`），所以不会再增长；
       * 这里把历史上已经堆起来的收敛成一张。
       *
       * 安全性：只有「一条消息都没有、没置顶、没归档、不是续接副本、不在保护名单里」的
       * 对话会进这个候选集——这种对话不存在任何可以丢失的内容。另外留
       * `EMPTY_DRAFT_PRUNE_GRACE_MS` 宽限期，刚建好、用户正要用的那张绝不会被碰。
       */
      const emptyDrafts = this.manifest.conversations
        .filter((summary) => isEmptyDraftConversation(summary)
          // 只统计「用户正常建出来、初始化也完成了」的空对话。未初始化的属于
          // 半途失败的残骸，走下面那条更严格的规则（60 秒后一律删），不参与保留竞争。
          && summary.skillSelectionInitialized === true
          && !protectedIds.has(summary.id))
        .sort((a, b) => b.createdAt - a.createdAt);
      const newestEmptyId = emptyDrafts[0]?.id;
      const prunableEmptyIds = new Set(
        emptyDrafts
          .slice(1)
          .filter((summary) => now - summary.createdAt >= EMPTY_DRAFT_PRUNE_GRACE_MS)
          .map((summary) => summary.id),
      );
      if (newestEmptyId) {
        // 最新的那张在这次清理里也不该被当成「未初始化残骸」删掉。
        protectedIds.add(newestEmptyId);
      }

      for (const summary of [...this.manifest.conversations]) {
        if (prunableEmptyIds.has(summary.id)) {
          // 自动删除一律进回收站：出问题时还能找回（用户 2026-10-31 报过数据丢失）。
          if (!await this.moveToTrash(summary.id, summary, 'draft')) continue;
          this.manifest.conversations = this.manifest.conversations.filter((item) => item.id !== summary.id);
          this.conversationRevisions.delete(summary.id);
          this.cleanupScanCache.delete(summary.id);
          deletedConversations += 1;
          prunedDrafts += 1;
          continue;
        }
        const revision = this.conversationRevisions.get(summary.id) ?? 0;
        const cached = this.cleanupScanCache.get(summary.id);
        const expired = historyMs > 0 && now - summary.updatedAt >= historyMs;
        const needsScan = optionsChanged || timeRefresh || expired || !cached || cached.revision !== revision;
        if (!needsScan && cached) {
          bytesById.set(summary.id, cached.bytes);
          countById.set(summary.id, cached.messages);
          continue;
        }
        scannedConversations += 1;
        const files = await this.messageFiles(summary.id);
        let compactedHere = 0;
        let hasStreamingMessage = false;
        for (const file of files) {
          const path = join(this.messageDirectory(summary.id), file);
          const message = await readJsonWithBackup<ChatMessage>(path);
          if (!message) {
            continue;
          }
          if (message.status === 'streaming') {
            hasStreamingMessage = true;
            continue;
          }
          const age = now - message.updatedAt;
          if (retentionMs === 0 || age >= retentionMs) {
            const heavyBytes = stripMessagePayload(message);
            if (heavyBytes > 0) {
              message.updatedAt = now;
              await writeJsonAtomic(path, message);
              await removeIfPresent(`${path}.bak`);
              compactedMessages += 1;
              compactedHere += 1;
              deletedMessageCacheBytes += heavyBytes;
            }
          }
        }
        if (hasStreamingMessage) {
          protectedIds.add(summary.id);
        }
        // 半途失败的残骸：创建成功但从未初始化、也没有任何消息。当前代码在建对话后
        // 会立刻写入 mode/权限/Skill（`skillSelectionInitialized: true`），所以这种记录
        // 只可能来自「建了但初始化失败」。它们永远不可能包含内容，留着只会让历史列表
        // 堆满「新对话 · 空对话」。留 60 秒宽限，避开「刚建好、正在初始化」的窗口。
        if (
          isEmptyDraftConversation(summary)
          && summary.skillSelectionInitialized !== true
          && !protectedIds.has(summary.id)
          && now - summary.createdAt >= 60_000
        ) {
          if (!await this.moveToTrash(summary.id, summary, 'draft')) continue;
          this.manifest.conversations = this.manifest.conversations.filter((item) => item.id !== summary.id);
          this.conversationRevisions.delete(summary.id);
          this.cleanupScanCache.delete(summary.id);
          bytesById.delete(summary.id);
          countById.delete(summary.id);
          deletedConversations += 1;
          prunedDrafts += 1;
          continue;
        }
        const bytes = compactedHere > 0 || !cached || cached.revision !== revision
          ? await this.measureDirectory(this.messageDirectory(summary.id))
          : cached.bytes;
        bytesById.set(summary.id, bytes);
        countById.set(summary.id, files.length);
        this.cleanupScanCache.set(summary.id, { revision, bytes, messages: files.length });
      }

      await this.persistManifest();
      const sum = (values: Map<string, number>): number => {
        let total = 0;
        for (const summary of this.manifest.conversations) total += values.get(summary.id) ?? 0;
        return total;
      };
      const budgetBytes = Math.max(5, options.cacheBudgetMB) * 1024 * 1024;
      const currentBytes = sum(bytesById) + await stat(this.manifestPath).then((value) => value.size).catch(() => 0);
      /*
       * 超预算只是**报告**，不再动手。
       *
       * 旧实现在这里把最旧的未保护对话整条搬走 —— 用户 2026-10-31 报的 13 条归档
       * 丢失就是这条路径（保护字段一失效，它就把归档当普通旧对话挤出去）。现在的规则
       * 只有一条：HWChat 不会自己让任何一条对话消失；空间不够就告诉用户，由用户在
       * 设置里决定清什么。
       */
      overBudget = currentBytes > budgetBytes;
      this.cleanupScanAt = Date.now();
      this.cleanupScanKey = scanKey;
      totalBytes = currentBytes;
      totalMessages = sum(countById);
    });

    return {
      conversations: this.manifest.conversations.length,
      messages: totalMessages,
      bytes: totalBytes,
      compactedMessages,
      deletedConversations,
      deletedMessageCacheBytes,
      scannedConversations,
      prunedDrafts,
      overBudget,
    };
  }

  async stats(): Promise<StorageStats> {
    await this.initialize();
    let messages = 0;
    for (const summary of this.manifest.conversations) {
      messages += (await this.messageFiles(summary.id)).length;
    }
    return {
      conversations: this.manifest.conversations.length,
      messages,
      bytes: await this.measureBytes(),
      compactedMessages: 0,
      deletedConversations: 0,
    };
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  /**
   * 历史列表的顺序：按 **新建时间** 倒序（新的在上、旧的在下）。
   *
   * 以前按 `updatedAt` 排，而 `updatedAt` 会随「新发一条消息」「换了模型」「置顶」变化，
   * 于是在一条旧对话里接着聊一句，它就窜到列表最上面 —— 位置随使用不断跳动。
   * 按 `createdAt` 定序后，每条对话的位置在建好的那一刻就固定了，只有新建的才插到最上面。
   *
   * 两个既有优先级原样保留：归档的始终沉底、置顶的始终浮顶。
   * `createdAt` 撞车时退化为比 `updatedAt`，纯粹为了让结果稳定（同毫秒建两条时也不会乱序）。
   */
  private sortedSummaries(): ConversationSummary[] {
    return [...this.manifest.conversations].sort((a, b) => {
      if (Boolean(a.archived) !== Boolean(b.archived)) {
        return a.archived ? 1 : -1;
      }
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      if (a.createdAt !== b.createdAt) {
        return b.createdAt - a.createdAt;
      }
      return b.updatedAt - a.updatedAt;
    });
  }

  private findSummary(id: string): ConversationSummary | undefined {
    return this.manifest.conversations.find((item) => item.id === id);
  }

  private requireSummary(id: string): ConversationSummary {
    const summary = this.findSummary(id);
    if (!summary) {
      throw new Error(tt('storage.conversationMissing'));
    }
    return summary;
  }

  /**
   * 一条对话的**根目录**（`conversations/<id>`），消息在它下面的 `messages/` 里。
   *
   * 删除时必须删这一层，不能只删 `messages/`：留下空壳目录会被 `reconcileManifest`
   * 当成「磁盘上还有这条对话」而重建记录，而空目录没有消息可取时间，重建出来的
   * `createdAt` 就是当时的 `Date.now()` —— 用户看到的就是「删掉的空对话又冒出来了，
   * 时间显示刚刚」。
   */
  private conversationDirectory(conversationId: string): string {
    return join(this.conversationsPath, conversationId);
  }

  /** 归档标记落盘的位置：与对话目录同生命周期，manifest 丢了也能恢复。 */
  private archivedMarkerPath(conversationId: string): string {
    return join(this.conversationDirectory(conversationId), ARCHIVED_MARKER);
  }

  /**
   * 把一条对话**移进回收站**，而不是 `rm -rf`。
   *
   * 现场（用户 2026-10-31 报数据丢失）：13 条归档对话在一次清理后消失，目录被
   * `rm -rf` 直接删掉，废纸篓里也没有 —— 无法恢复。批量自动删除（空草稿、超期、
   * 预算回收）不该是不可逆的，所以统一改成「挪进 `trash/`」，并留一条记录
   * 供 `HWChat: 恢复已删除的对话` 找回。
   *
   * 用户**主动**删除（点 × / 删除命令）仍走 `deleteConversation` 直接删 —— 那是
   * 明确的意图，不该在回收站里留一份让人以为没删掉。
   */
  private async moveToTrash(conversationId: string, summary: ConversationSummary | undefined, reason: TrashReason): Promise<boolean> {
    const source = this.conversationDirectory(conversationId);
    const sourceMessages = (await this.messageFiles(conversationId)).length;
    let entryId = conversationId;
    let destination = join(this.trashPath, entryId);
    let moved = false;
    /*
     * 整段都用 try 包住：`mkdir` 也可能失败（磁盘满、回收站路径被占成普通文件、
     * 权限被改）。任何一步失败都只意味着「这次别删」，绝不能把异常吞掉后继续删原件，
     * 更不能让一个搬运失败把整轮清理打断。
     */
    try {
      await mkdir(this.trashPath, { recursive: true });
      // 同名目录已经在回收站里（恢复后又删一次）→ 换个名字，旧的那份原样留着。
      if (existsSync(destination)) {
        entryId = `${conversationId}.${Date.now()}`;
        destination = join(this.trashPath, entryId);
      }
      try {
        await rename(source, destination);
        moved = true;
      } catch {
        moved = await this.copyDirectoryVerified(source, destination, sourceMessages);
      }
    } catch {
      moved = false;
    }
    /*
     * 搬不进去就**什么都不做**。
     *
     * 旧实现在 `cp` 失败时用 `.catch(() => undefined)` 吞掉错误，紧接着无条件
     * `rm` 原目录 —— 拷贝失败等于直接销毁，这正是「删除」本该避免的事。
     * 现在只有确认目标目录里消息文件数与源一致，才认为搬成功了；否则保留原件、
     * 返回 false，让调用方把这条对话留在清单里。
     */
    if (!moved) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      return false;
    }
    const entries = await this.readTrashIndex();
    entries.push({
      id: entryId,
      conversationId,
      title: summary?.title ?? conversationId,
      messageCount: summary?.messageCount ?? 0,
      archived: Boolean(summary?.archived),
      deletedAt: Date.now(),
      reason,
    });
    await writeJsonAtomic(this.trashIndexPath, entries, false).catch(() => undefined);
    return true;
  }

  /**
   * 复制一个对话目录到目标位置，并**核对消息文件数**。
   *
   * 用于 `rename` 跨设备失败时的退化路径。只有数量一致才返回 true 并由调用方删除源；
   * 数量不一致说明拷贝不完整 —— 此时删源就是把对话变成半截，必须放弃。
   */
  private async copyDirectoryVerified(source: string, destination: string, expectedMessages: number): Promise<boolean> {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    try {
      await cp(source, destination, { recursive: true, errorOnExist: false });
    } catch {
      return false;
    }
    const copied = (await readdir(join(destination, 'messages')).catch(() => [] as string[]))
      .filter((file) => file.endsWith('.json') && !file.endsWith('.bak')).length;
    return copied === expectedMessages;
  }

  /**
   * 销毁回收站里的**一条**记录。
   *
   * 只有 `purgeTrash()` 会走到这里 —— 也就是用户在设置里点「清空回收站」的时候。
   * 回收站不再有「到期自动清理」：工具替用户决定「这条放 30 天了，可以真删了」，
   * 和自动删对话是同一类问题 —— 用户报告数据丢失时，看到的正是这种「没人下令就没了」。
   */
  private async destroyTrashEntry(entryId: string): Promise<void> {
    await rm(join(this.trashPath, entryId), { recursive: true, force: true }).catch(() => undefined);
  }

  /** 回收站用量（设置页展示用）：条数与实际磁盘占用。 */
  async trashStats(): Promise<{ count: number; bytes: number }> {
    await this.initialize();
    const entries = await this.readTrashIndex();
    let bytes = 0;
    for (const entry of entries) {
      bytes += await this.measureDirectory(join(this.trashPath, entry.id));
    }
    return { count: entries.length, bytes };
  }

  private get trashIndexPath(): string {
    return join(this.trashPath, 'index.json');
  }

  private async readTrashIndex(): Promise<TrashEntry[]> {
    const stored = await readJsonWithBackup<TrashEntry[]>(this.trashIndexPath);
    return Array.isArray(stored) ? stored.filter((entry) => entry && typeof entry.id === 'string') : [];
  }

  /** 回收站内容（供「恢复已删除的对话」列出）。 */
  async listTrash(): Promise<TrashEntry[]> {
    await this.initialize();
    const entries = await this.readTrashIndex();
    return entries.sort((left, right) => right.deletedAt - left.deletedAt);
  }

  /**
   * 从回收站恢复一条对话。
   *
   * 目录挪回 `conversations/`，再让 `reconcileManifest` 按磁盘重建摘要 —— 不依赖
   * 当初那份 manifest（那份可能正是出问题的那份）。
   */
  async restoreFromTrash(entryId: string): Promise<boolean> {
    await this.initialize();
    const entries = await this.readTrashIndex();
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return false;
    const source = join(this.trashPath, entryId);
    if (!existsSync(source)) return false;
    await mkdir(this.conversationsPath, { recursive: true });
    const destination = this.conversationDirectory(entry.conversationId);
    // 同 id 的对话又活在磁盘上（恢复过、又新建了同 id）→ 不动它，也不动回收站里的那份。
    if (existsSync(destination)) return false;
    const expected = (await readdir(join(source, 'messages')).catch(() => [] as string[]))
      .filter((file) => file.endsWith('.json') && !file.endsWith('.bak')).length;
    let restored = false;
    try {
      await rename(source, destination);
      restored = true;
    } catch {
      restored = await this.copyDirectoryVerified(source, destination, expected);
      // 只有核对通过才允许删源；没拷贝成功就保持回收站原样。
      if (restored) await rm(source, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!restored) return false;
    await writeJsonAtomic(this.trashIndexPath, entries.filter((item) => item.id !== entryId), false).catch(() => undefined);
    this.invalidateMessagePages();
    await this.reconcileManifest();
    await this.persistSafetySnapshot();
    return true;
  }

  private messageDirectory(conversationId: string): string {
    return join(this.conversationDirectory(conversationId), 'messages');
  }

  private messagePath(conversationId: string, messageId: string): string {
    return join(this.messageDirectory(conversationId), `${messageId}.json`);
  }

  private async messageFiles(conversationId: string): Promise<string[]> {
    try {
      return (await readdir(this.messageDirectory(conversationId)))
        .filter((file) => file.endsWith('.json') && !file.endsWith('.bak'));
    } catch {
      return [];
    }
  }

  private async readMessage(conversationId: string, messageId: string): Promise<ChatMessage | undefined> {
    return readJsonWithBackup<ChatMessage>(this.messagePath(conversationId, messageId));
  }

  private async persistManifest(): Promise<void> {
    await writeJsonAtomic(this.manifestPath, this.manifest);
  }

  private enqueueWrite<T = void>(task: () => Promise<T>): Promise<T> {
    const next = this.writeTail.then(task, task);
    this.writeTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async rebuildManifestFromDisk(): Promise<void> {
    const directories = await readdir(this.conversationsPath, { withFileTypes: true });
    const conversations: ConversationSummary[] = [];
    for (const entry of directories) {
      if (!entry.isDirectory()) {
        continue;
      }
      const id = entry.name;
      const files = (await this.messageFiles(id)).sort((a, b) => a.localeCompare(b));
      let firstUser: ChatMessage | undefined;
      let firstMessage: ChatMessage | undefined;
      let lastMessage: ChatMessage | undefined;
      let totalTokens = 0;
      for (const file of files) {
        const message = await this.readMessageForReconcile(join(this.messageDirectory(id), file), id);
        if (!message) {
          continue;
        }
        firstMessage ??= message;
        lastMessage = message;
        totalTokens += message.usage?.totalTokens ?? 0;
        if (!firstUser && message.role === 'user') {
          firstUser = message;
        }
      }
      const createdAt = firstMessage?.createdAt ?? Date.now();
      conversations.push({
        id,
        title: shortTitle(firstUser?.content ?? tt('storage.defaultTitle')),
        createdAt,
        updatedAt: lastMessage?.updatedAt ?? createdAt,
        messageCount: files.length,
        preview: previewText(lastMessage?.content ?? ''),
        pinned: false,
        totalTokens,
        model: lastMessage?.model,
        apiProfileId: undefined,
        mode: 'agent',
        skillIds: [],
        skillSelectionInitialized: false,
        // 标记文件还在 → 它本来就是归档的，别让 manifest 丢失把保护一起丢掉。
        ...(existsSync(join(this.conversationsPath, id, ARCHIVED_MARKER)) ? { archived: true as const } : { archived: false }),
      });
    }
    this.manifest = { version: MANIFEST_VERSION, conversations };
    await this.persistManifest();
  }

  /** 取走本次启动的完整性告警（取过一次就清空，避免每个窗口都弹）。 */
  takeIntegrityAlert(): { missing: Array<{ id: string; title: string }> } | undefined {
    const alert = this.integrityAlert;
    this.integrityAlert = undefined;
    return alert;
  }

  /**
   * 对比上次的归档清单，找出「既不在这条磁盘上、也不在回收站里」的对话。
   *
   * 只在启动时跑一次，不写任何东西到对话目录；发现异常也**不会**尝试修复 ——
   * 内容已经没了，能做的只有立刻告诉用户，让用户拿备份、并让我们知道出了新问题。
   */
  private async checkArchivedIntegrity(): Promise<void> {
    const previous = await readJsonWithBackup<SafetySnapshot>(this.safetyPath).catch(() => undefined);
    if (previous?.version === 1 && Array.isArray(previous.archived)) {
      const live = new Set(this.manifest.conversations.map((summary) => summary.id));
      const trashed = new Set((await this.readTrashIndex()).map((entry) => entry.conversationId));
      const missing = previous.archived.filter((item) => !live.has(item.id) && !trashed.has(item.id));
      if (missing.length) {
        this.integrityAlert = { missing: missing.map((item) => ({ id: item.id, title: item.title })) };
      }
    }
    await this.persistSafetySnapshot();
  }

  /** 把当前归档清单写成下一次启动的对照基准。 */
  private async persistSafetySnapshot(): Promise<void> {
    const snapshot: SafetySnapshot = {
      version: 1,
      archived: this.manifest.conversations
        .filter((summary) => summary.archived)
        .map((summary) => ({ id: summary.id, title: summary.title, archivedAt: summary.archivedAt })),
      savedAt: Date.now(),
    };
    await writeJsonAtomic(this.safetyPath, snapshot, false).catch(() => undefined);
  }

  /**
   * 用磁盘上的 `.archived` 标记校正内存里的归档状态。
   *
   * 为什么必须有这一步：manifest 读失败时会回退到 `manifest.json.bak`，而备份是
   * **上一次**写盘的内容 —— 用户刚归档完就出问题的话，从备份恢复出来的正是
   * 「还没归档」的那一版，保护看起来完好、实际已经被抹掉。
   *
   * 规则刻意单向，只做两件事：
   *  - 有标记 → 置 `archived: true`（标记是真相）；
   *  - 摘要说归档但没标记 → 补写标记（老版本存档没有标记文件，靠这一步补齐），
   *    绝不因为「没标记」就把归档清掉，那等于把用户已经归档的对话丢回可删状态。
   */
  private async reconcileArchiveMarkers(): Promise<void> {
    let changed = false;
    for (const summary of this.manifest.conversations) {
      const markerExists = existsSync(this.archivedMarkerPath(summary.id));
      if (markerExists && !summary.archived) {
        summary.archived = true;
        summary.archivedAt ??= await stat(this.archivedMarkerPath(summary.id))
          .then((info) => Math.round(info.mtimeMs))
          .catch(() => Date.now());
        changed = true;
        continue;
      }
      if (summary.archived && !markerExists) {
        await mkdir(this.conversationDirectory(summary.id), { recursive: true }).catch(() => undefined);
        await writeFile(this.archivedMarkerPath(summary.id), String(summary.archivedAt ?? Date.now()), 'utf8').catch(() => undefined);
      }
    }
    if (changed) {
      await this.persistManifest();
    }
  }

  private async reconcileManifest(): Promise<void> {
    const entries = (await readdir(this.conversationsPath, { withFileTypes: true }))
      .filter((entry: Dirent) => entry.isDirectory());
    /**
     * 丢掉**空壳目录**：`conversations/<id>/` 里连 `messages/` 都没有。
     *
     * 真实故障：删除对话时只 `rm` 了 `messages/`，`conversations/<id>/` 留了下来；
     * 下次启动这里看到「磁盘上还有这个 id」，就把它当成一条对话重建出来 ——
     * 空目录没有消息可读时间，`createdAt` 取的就是当时的 `Date.now()`，
     * 于是用户看到「删掉的空对话又回来了，还显示『刚刚』」。
     *
     * `createConversation` 一定会 `mkdir messages/`，所以**没有 `messages/` 子目录的
     * 对话目录一定是残骸**，直接删掉比留着重建成幽灵对话安全。
     */
    const directories: string[] = [];
    for (const entry of entries) {
      const messagesPath = join(this.conversationsPath, entry.name, 'messages');
      const hasMessages = await stat(messagesPath).then((info) => info.isDirectory()).catch(() => false);
      if (hasMessages) {
        directories.push(entry.name);
        continue;
      }
      await rm(join(this.conversationsPath, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
    const existing = new Set(directories);
    const summaries = new Map(
      this.manifest.conversations
        .filter((summary) => existing.has(summary.id))
        .map((summary) => [summary.id, summary]),
    );
    let changed = summaries.size !== this.manifest.conversations.length;
    for (const id of directories) {
      const files = (await this.messageFiles(id)).sort((a, b) => a.localeCompare(b));
      // 逐条读一次就够：first / last / 首个用户消息 / token 合计 / 中断修复
      // 都来自同一份数据。旧实现把首尾文件额外读了两遍，再加上独立的
      // recoverInterruptedMessages 全量读取，一次启动最多把每个文件解析三遍。
      let firstMessage: ChatMessage | undefined;
      let lastMessage: ChatMessage | undefined;
      let firstUser: ChatMessage | undefined;
      let diskTokenTotal = 0;
      for (const file of files) {
        const message = await this.readMessageForReconcile(join(this.messageDirectory(id), file), id);
        if (!message) continue;
        firstMessage ??= message;
        lastMessage = message;
        diskTokenTotal += message.usage?.totalTokens ?? 0;
        if (!firstUser && message.role === 'user') firstUser = message;
      }
      let summary = summaries.get(id);
      if (!summary) {
        const createdAt = firstMessage?.createdAt ?? Date.now();
        summary = {
          id,
          title: shortTitle(firstUser?.content ?? tt('storage.defaultTitle')),
          createdAt,
          updatedAt: lastMessage?.updatedAt ?? createdAt,
          messageCount: files.length,
          preview: previewText(lastMessage?.content ?? ''),
          pinned: false,
          totalTokens: diskTokenTotal,
          model: lastMessage?.model,
          apiProfileId: undefined,
          mode: 'agent',
          skillIds: [],
          skillSelectionInitialized: false,
          // 与 `rebuildManifestFromDisk` 同一条规则：标记文件还在就说明它本来是归档的。
          // 这里漏掉的话，manifest 读不出来时重建出的摘要一律 `archived: false`，
          // 紧接着的超期清理/预算回收就会把归档对话当普通旧对话删掉。
          ...(existsSync(join(this.conversationsPath, id, ARCHIVED_MARKER)) ? { archived: true as const } : { archived: false }),
        };
        summaries.set(id, summary);
        changed = true;
      } else {
        const nextCount = files.length;
        const nextUpdatedAt = Math.max(summary.updatedAt, lastMessage?.updatedAt ?? 0);
        const nextPreview = lastMessage?.content ? previewText(lastMessage.content) : summary.preview;
        if (
          summary.messageCount !== nextCount
          || summary.updatedAt !== nextUpdatedAt
          || summary.preview !== nextPreview
          || (summary.totalTokens ?? 0) !== diskTokenTotal
        ) {
          summary.messageCount = nextCount;
          summary.updatedAt = nextUpdatedAt;
          summary.preview = nextPreview;
          summary.totalTokens = diskTokenTotal;
          changed = true;
        }
      }
      if (lastMessage?.createdAt && lastMessage.createdAt > this.lastMessageTimestamp) {
        this.lastMessageTimestamp = lastMessage.createdAt;
      }
    }
    this.manifest.conversations = [...summaries.values()];
    if (changed) {
      await this.persistManifest();
    }
  }

  /**
   * 读一条消息；如果是上次被中断的 `streaming` / `queued` 占位消息，就地修好并写回。
   *
   * 修复规则与原 `recoverInterruptedMessages` 完全一致：有部分内容的保留内容，
   * 空的按「排队未执行 / 被中断」补一句说明，状态一律降级成 `error`。
   */
  private async readMessageForReconcile(path: string, conversationId: string): Promise<ChatMessage | undefined> {
    const message = await readJsonWithBackup<ChatMessage>(path);
    if (!message) return undefined;
    /*
     * 用户消息的执行状态也要收口。
     *
     * 进程退出、窗口关掉时，正在进行的那一轮来不及把 `running` / `pending` 落定，
     * 这两个状态就会永远挂在气泡上。启动时已经没有任何运行中的对话了，所以：
     * `running` → `done`（它确实被 agent 读过、跑过），`pending` → `skipped`（从未被执行）。
     * 这一步只发生在 `initialize()` 里，不会打断正在进行的运行。
     */
    if (message.role === 'user' && (message.executionStatus === 'running' || message.executionStatus === 'pending')) {
      message.executionStatus = message.executionStatus === 'running' ? 'done' : 'skipped';
      message.updatedAt = Date.now();
      await writeJsonAtomic(path, message);
      this.invalidateMessagePages();
      this.markConversationChanged(conversationId);
    }
    if (message.status !== 'streaming' && message.status !== 'queued') return message;
    const previousStatus = message.status;
    message.status = 'error';
    message.content = message.content || (previousStatus === 'queued' ? tt('storage.queuedNotRun') : tt('storage.interrupted'));
    message.updatedAt = Date.now();
    await writeJsonAtomic(path, message);
    this.invalidateMessagePages();
    this.markConversationChanged(conversationId);
    return message;
  }

  private async measureBytes(): Promise<number> {
    let total = 0;
    try {
      total += (await stat(this.manifestPath)).size;
    } catch {
      // The manifest may not exist during first launch.
    }
    for (const summary of this.manifest.conversations) {
      total += await this.measureDirectory(join(this.conversationsPath, summary.id));
    }
    return total;
  }

  private async measureDirectory(directory: string): Promise<number> {
    let total = 0;
    let entries: Dirent[] = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        total += await this.measureDirectory(path);
      } else {
        total += await stat(path).then((info) => info.size).catch(() => 0);
      }
    }
    return total;
  }
}

/**
 * 把一条消息里的「体积大头」就地删掉，返回释放的原始字节数。
 *
 * 保留期压缩与预算瘦身共用同一套字段集合 —— 两者删掉的东西必须完全一致，
 * 否则会出现「预算回收删得比保留期还狠」这类难以解释的差异。
 * 附件只留 `id`/`label`/`path` 等描述信息：界面退化成文件条目，正文照常显示。
 */
function stripMessagePayload(message: ChatMessage): number {
  const heavyBytes = Buffer.byteLength(JSON.stringify({
    reasoning: message.reasoning,
    usage: message.usage,
    toolInputs: message.toolExecutions?.map((tool) => tool.input),
    toolOutputs: message.toolExecutions?.map((tool) => tool.output),
    attachments: message.attachments?.map((attachment) => ({
      content: attachment.content,
      dataBase64: attachment.dataBase64,
      thumbnailDataUrl: attachment.thumbnailDataUrl,
    })),
    selection: {
      content: message.context?.content,
      dataBase64: message.context?.dataBase64,
      thumbnailDataUrl: message.context?.thumbnailDataUrl,
    },
  }));
  const present = message.reasoning !== undefined
    || message.usage?.promptTokens !== undefined
    || message.usage?.completionTokens !== undefined
    || message.toolExecutions?.some((tool) => tool.input !== undefined || tool.output !== undefined)
    || message.attachments?.some((attachment) => attachment.content !== undefined || attachment.dataBase64 !== undefined || attachment.thumbnailDataUrl !== undefined)
    || message.context?.content !== undefined
    || message.context?.dataBase64 !== undefined
    || message.context?.thumbnailDataUrl !== undefined;
  if (!present) return 0;
  delete message.reasoning;
  message.usage = message.usage?.totalTokens ? { totalTokens: message.usage.totalTokens } : undefined;
  if (message.toolExecutions) {
    for (const tool of message.toolExecutions) {
      delete tool.input;
      delete tool.output;
    }
  }
  if (message.attachments) {
    for (const attachment of message.attachments) {
      delete attachment.content;
      delete attachment.dataBase64;
      delete attachment.thumbnailDataUrl;
    }
  }
  if (message.context) {
    delete message.context.content;
    delete message.context.dataBase64;
    delete message.context.thumbnailDataUrl;
  }
  return heavyBytes;
}

function historyExcerpt(value: string, query: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  if (!query) return `${normalized.slice(0, maxChars - 1)}…`;
  const matchIndex = normalized.toLocaleLowerCase().indexOf(query);
  if (matchIndex < 0) return `${normalized.slice(0, maxChars - 1)}…`;
  const context = Math.max(0, Math.floor((maxChars - query.length) / 2));
  const start = Math.max(0, matchIndex - context);
  const end = Math.min(normalized.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

function assignOptional<K extends keyof ConversationSummary>(
  target: ConversationSummary,
  key: K,
  value: ConversationSummary[K] | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    delete target[key];
    return;
  }
  Object.assign(target, { [key]: value });
}

/**
 * 从磁盘读到的对话摘要归一化。
 *
 * 手工改过的 manifest、老版本写的字段都可能带着不合法的值；这里统一处理成
 * 「要么是明确合法值，要么干脆没有这个字段」，让运行时只需回落到默认值，
 * 不必到处判脏数据。
 */
function sanitizeSummary(item: ConversationSummary): ConversationSummary {
  const todoArchives = normalizeTodoArchives(item.todoArchives);
  const normalized: ConversationSummary = todoArchives.length
    ? { ...item, todoArchives }
    : (() => {
      const { todoArchives: _discarded, ...rest } = item;
      return rest as ConversationSummary;
    })();
  // 中断标记只认严格的 true：老存档没有这个字段，手改成字符串/数字一律当没有。
  const withFlag = normalized.todosInterrupted === true
    ? { ...normalized, todosInterrupted: true as const }
    : (() => {
      const { todosInterrupted: _stale, ...withoutFlag } = normalized;
      return withoutFlag as ConversationSummary;
    })();
  // 「未完成」标记同样只认 true；两个标记同时为真时按「已中断」算，避免出现互相矛盾的存档。
  const withIncomplete = withFlag.todosIncomplete === true && withFlag.todosInterrupted !== true
    ? { ...withFlag, todosIncomplete: true as const }
    : (() => {
      const { todosIncomplete: _staleIncomplete, ...withoutIncomplete } = withFlag;
      return withoutIncomplete as ConversationSummary;
    })();
  applyOptional(withIncomplete, 'projectRoot', normalizeProjectRoot(withIncomplete.projectRoot));
  // 涉及的项目同样只认绝对路径的字符串数组，老存档没有这个字段时保持没有。
  {
    const roots = normalizeProjectRoots(withIncomplete.projectRoots);
    if (roots.length) withIncomplete.projectRoots = roots;
    else delete withIncomplete.projectRoots;
  }
  // 「标题是用户改的」同样只认严格的 true：老存档没这个字段，手写成字符串一律当没有。
  if (withIncomplete.titleCustomized !== true) {
    delete withIncomplete.titleCustomized;
  }
  applyOptional(withIncomplete, 'permissionPreset', normalizeStoredPreset(withIncomplete.permissionPreset));
  applyOptional(withIncomplete, 'agentMaxSteps', normalizeStoredSteps(withIncomplete.agentMaxSteps));
  applyOptional(withIncomplete, 'reasoningEffort', normalizeStoredReasoning(withIncomplete.reasoningEffort));
  return withIncomplete;
}

/** `undefined` = 补丁里没提这个字段；`null` = 值不合法，删掉它回落到默认。 */
function applyOptional<K extends keyof ConversationSummary>(
  target: ConversationSummary,
  key: K,
  value: ConversationSummary[K] | null | undefined,
): void {
  assignOptional(target, key, value);
}

function normalizeProjectRoot(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
}

/**
 * 「本对话涉及的项目」归一化：逐项必须是绝对路径，去重后保序。
 *
 * 只用于展示（标题旁的徽标），但存档是可以手改的，脏值必须在这里挡掉：徽标上出现一个
 * 不存在的路径段、或者 `"."` 这种相对路径，比少显示一个项目更让人困惑。
 */
function normalizeProjectRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roots: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || !isAbsolute(text)) continue;
    const canonical = resolve(text);
    if (!roots.includes(canonical)) roots.push(canonical);
  }
  return roots;
}

/**
 * 用户消息执行状态的归一化。
 *
 * 存档可能是手改的、也可能是未来版本写的：认不出来的值一律**丢掉**（返回 undefined），
 * 界面就不画徽标 —— 猜一个「已执行」是最糟的方向，那会让用户以为跑过了。
 */
export function normalizeExecutionStatus(value: unknown): MessageExecutionStatus | undefined {
  return value === 'pending' || value === 'running' || value === 'done' || value === 'skipped'
    ? value
    : undefined;
}

function normalizeStoredPreset(value: unknown): ConversationSummary['permissionPreset'] | null | undefined {
  if (value === undefined) return undefined;
  return value === 'askAll' || value === 'review' || value === 'autopilot' || value === 'full' ? value : null;
}

/**
 * 会话里保存的步数。
 *
 * `0` 是**显式选择的「无限制」**（工具条第四档），原样保留；负数、非数字一律
 * 当脏值丢弃（回落到全局默认），避免手改存档把预算改成「既不是 0 也不是正数」。
 * 正数照旧夹到绝对上限 `AGENT_STEP_SAFETY_CAP`。
 */
function normalizeStoredSteps(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (value === AGENT_MAX_STEPS_UNLIMITED) return AGENT_MAX_STEPS_UNLIMITED;
  return Math.min(Math.floor(value), AGENT_STEP_SAFETY_CAP);
}

function normalizeStoredReasoning(value: unknown): ConversationSummary['reasoningEffort'] | null | undefined {
  if (value === undefined) return undefined;
  // 'default' / 'none' 是旧版本写的值（工具条上已不再提供这两档），保留是为了让
  // 老对话不会因为一次升级就丢掉思考深度；'medium' 是新增的第二档。
  return value === 'default' || value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'max'
    ? value
    : null;
}
