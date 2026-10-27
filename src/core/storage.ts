import { join } from 'node:path';
import { Dirent } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
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
  StorageStats,
  TodoItem,
} from './types';
import { tt } from './i18n';

interface Manifest {
  version: 1;
  conversations: ConversationSummary[];
}

const MANIFEST_VERSION = 1 as const;
const MAX_UI_MESSAGES = 200;

export class ConversationStorage {
  private readonly manifestPath: string;
  private readonly conversationsPath: string;
  private manifest: Manifest = { version: MANIFEST_VERSION, conversations: [] };
  private initialized = false;
  private initializing: Promise<void> | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private lastMessageTimestamp = 0;

  constructor(private readonly rootPath: string) {
    this.manifestPath = join(rootPath, 'manifest.json');
    this.conversationsPath = join(rootPath, 'conversations');
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
            conversations: stored.conversations.filter((item) => Boolean(item?.id)),
          };
        } else {
          await this.rebuildManifestFromDisk();
        }
        await this.recoverInterruptedMessages();
        await this.reconcileManifest();
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
    };
    await this.enqueueWrite(async () => {
      await writeJsonAtomic(this.messagePath(conversationId, message.id), message);
      summary.messageCount += 1;
      summary.totalTokens = Math.max(0, (summary.totalTokens ?? 0) + (message.usage?.totalTokens ?? 0));
      summary.updatedAt = now;
      summary.preview = previewText(message.content);
      if (message.role === 'user' && summary.title === tt('storage.defaultTitle')) {
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
    patch: Partial<Pick<ChatMessage, 'content' | 'reasoning' | 'usage' | 'status' | 'model' | 'toolExecutions' | 'toolCalls' | 'usedSkills' | 'consumedByAssistantId' | 'replyToMessageId'>>,
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
        updatedAt: Date.now(),
      };
      summary.totalTokens = Math.max(
        0,
        (summary.totalTokens ?? 0) - (current.usage?.totalTokens ?? 0) + (updated.usage?.totalTokens ?? 0),
      );
      await writeJsonAtomic(this.messagePath(conversationId, messageId), updated);
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

  async getMessages(
    conversationId: string,
    options: { limit?: number; before?: string; maxBytes?: number } = {},
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    await this.initialize();
    this.requireSummary(conversationId);
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
        messages.unshift(message);
      }
    }
    return { messages, hasMore: index >= 0 };
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

  async updateConversation(
    conversationId: string,
    patch: Partial<Pick<ConversationSummary, 'title' | 'model' | 'apiProfileId' | 'mode' | 'skillIds' | 'skillSelectionInitialized'>> & {
      sourceConversationId?: string | null;
      sourceConversationTitle?: string | null;
      sourceHistoryDigest?: string | null;
      sourceLinkedAt?: number | null;
      todos?: TodoItem[] | null;
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
      await this.persistManifest();
    });
    return { ...summary };
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.initialize();
    this.requireSummary(conversationId);
    await this.enqueueWrite(async () => {
      await rm(this.messageDirectory(conversationId), { recursive: true, force: true });
      this.manifest.conversations = this.manifest.conversations.filter((item) => item.id !== conversationId);
      await this.persistManifest();
    });
  }

  async clearAll(): Promise<void> {
    await this.initialize();
    await this.enqueueWrite(async () => {
      await rm(this.conversationsPath, { recursive: true, force: true });
      await mkdir(this.conversationsPath, { recursive: true });
      this.manifest = { version: MANIFEST_VERSION, conversations: [] };
      await this.persistManifest();
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
    await this.enqueueWrite(async () => {
      const now = Date.now();
      const retentionMs = Math.max(0, options.taskCacheRetentionHours) * 60 * 60 * 1000;
      const historyMs = Math.max(0, options.historyRetentionDays) * 24 * 60 * 60 * 1000;
      const protectedIds = new Set(options.protectedConversationIds ?? []);
      for (const conversation of this.manifest.conversations) {
        if (conversation.sourceConversationId) protectedIds.add(conversation.sourceConversationId);
      }

      for (const summary of [...this.manifest.conversations]) {
        const files = await this.messageFiles(summary.id);
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
            if (
              message.reasoning !== undefined
              || message.usage?.promptTokens !== undefined
              || message.usage?.completionTokens !== undefined
              || message.toolExecutions?.some((tool) => tool.input !== undefined || tool.output !== undefined)
              || message.attachments?.some((attachment) => attachment.content !== undefined || attachment.dataBase64 !== undefined || attachment.thumbnailDataUrl !== undefined)
              || message.context?.content !== undefined
              || message.context?.dataBase64 !== undefined
              || message.context?.thumbnailDataUrl !== undefined
            ) {
              delete message.reasoning;
              message.usage = message.usage?.totalTokens
                ? { totalTokens: message.usage.totalTokens }
                : undefined;
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
              message.updatedAt = now;
              await writeJsonAtomic(path, message);
              await removeIfPresent(`${path}.bak`);
              compactedMessages += 1;
              deletedMessageCacheBytes += heavyBytes;
            }
          }
        }
        if (hasStreamingMessage) {
          protectedIds.add(summary.id);
        }
        if (!summary.pinned && !summary.archived && !protectedIds.has(summary.id) && historyMs > 0 && now - summary.updatedAt >= historyMs) {
          await rm(this.messageDirectory(summary.id), { recursive: true, force: true });
          this.manifest.conversations = this.manifest.conversations.filter((item) => item.id !== summary.id);
          deletedConversations += 1;
        }
      }

      await this.persistManifest();
      const budgetBytes = Math.max(5, options.cacheBudgetMB) * 1024 * 1024;
      let currentBytes = await this.measureBytes();
      if (currentBytes > budgetBytes) {
        const evictable = this.manifest.conversations
          .filter((summary) => !summary.pinned && !summary.archived && !protectedIds.has(summary.id))
          .sort((a, b) => a.updatedAt - b.updatedAt);
        for (const summary of evictable) {
          if (currentBytes <= budgetBytes) {
            break;
          }
          const before = await this.measureDirectory(this.messageDirectory(summary.id));
          await rm(this.messageDirectory(summary.id), { recursive: true, force: true });
          this.manifest.conversations = this.manifest.conversations.filter((item) => item.id !== summary.id);
          currentBytes = Math.max(0, currentBytes - before);
          deletedConversations += 1;
        }
        await this.persistManifest();
      }
    });

    const stats = await this.stats();
    return {
      ...stats,
      compactedMessages,
      deletedConversations,
      deletedMessageCacheBytes,
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

  private sortedSummaries(): ConversationSummary[] {
    return [...this.manifest.conversations].sort((a, b) => {
      if (Boolean(a.archived) !== Boolean(b.archived)) {
        return a.archived ? 1 : -1;
      }
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
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

  private messageDirectory(conversationId: string): string {
    return join(this.conversationsPath, conversationId, 'messages');
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

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(task, task);
    this.writeTail = next.catch(() => undefined);
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
        const message = await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(id), file));
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
        archived: false,
      });
    }
    this.manifest = { version: MANIFEST_VERSION, conversations };
    await this.persistManifest();
  }

  private async reconcileManifest(): Promise<void> {
    const directories = (await readdir(this.conversationsPath, { withFileTypes: true }))
      .filter((entry: Dirent) => entry.isDirectory())
      .map((entry) => entry.name);
    const existing = new Set(directories);
    const summaries = new Map(
      this.manifest.conversations
        .filter((summary) => existing.has(summary.id))
        .map((summary) => [summary.id, summary]),
    );
    let changed = summaries.size !== this.manifest.conversations.length;
    for (const id of directories) {
      const files = (await this.messageFiles(id)).sort((a, b) => a.localeCompare(b));
      const first = files[0]
        ? await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(id), files[0]!))
        : undefined;
      const last = files.at(-1)
        ? await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(id), files.at(-1)!))
        : undefined;
      let diskTokenTotal = 0;
      for (const file of files) {
        const message = await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(id), file));
        diskTokenTotal += message?.usage?.totalTokens ?? 0;
      }
      let summary = summaries.get(id);
      if (!summary) {
        const firstUser = await this.findFirstUserMessage(id, files);
        const createdAt = first?.createdAt ?? Date.now();
        summary = {
          id,
          title: shortTitle(firstUser?.content ?? tt('storage.defaultTitle')),
          createdAt,
          updatedAt: last?.updatedAt ?? createdAt,
          messageCount: files.length,
          preview: previewText(last?.content ?? ''),
          pinned: false,
          totalTokens: diskTokenTotal,
          model: last?.model,
          apiProfileId: undefined,
          mode: 'agent',
          skillIds: [],
          skillSelectionInitialized: false,
          archived: false,
        };
        summaries.set(id, summary);
        changed = true;
      } else {
        const nextCount = files.length;
        const nextUpdatedAt = Math.max(summary.updatedAt, last?.updatedAt ?? 0);
        const nextPreview = last?.content ? previewText(last.content) : summary.preview;
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
      if (last?.createdAt && last.createdAt > this.lastMessageTimestamp) {
        this.lastMessageTimestamp = last.createdAt;
      }
    }
    this.manifest.conversations = [...summaries.values()];
    if (changed) {
      await this.persistManifest();
    }
  }

  private async recoverInterruptedMessages(): Promise<void> {
    const directories = (await readdir(this.conversationsPath, { withFileTypes: true }))
      .filter((entry: Dirent) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const conversationId of directories) {
      for (const file of await this.messageFiles(conversationId)) {
        const path = join(this.messageDirectory(conversationId), file);
        const message = await readJsonWithBackup<ChatMessage>(path);
        if (message?.status !== 'streaming' && message?.status !== 'queued') {
          continue;
        }
        const previousStatus = message.status;
        message.status = 'error';
        message.content = message.content || (previousStatus === 'queued' ? tt('storage.queuedNotRun') : tt('storage.interrupted'));
        message.updatedAt = Date.now();
        await writeJsonAtomic(path, message);
      }
    }
  }

  private async findFirstUserMessage(conversationId: string, files: string[]): Promise<ChatMessage | undefined> {
    for (const file of files) {
      const message = await readJsonWithBackup<ChatMessage>(join(this.messageDirectory(conversationId), file));
      if (message?.role === 'user') {
        return message;
      }
    }
    return undefined;
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
