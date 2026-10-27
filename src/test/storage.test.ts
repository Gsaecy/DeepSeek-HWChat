import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStorage } from '../core/storage';

async function withStorage(
  run: (storage: ConversationStorage, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-storage-'));
  try {
    const storage = new ConversationStorage(root);
    await storage.initialize();
    await run(storage, root);
    await storage.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('recovers conversations and message metadata when the manifest is corrupt', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation();
    const message = await storage.appendMessage(conversation.id, {
      role: 'user',
      content: '这条记录必须在索引损坏后恢复',
      status: 'complete',
    });

    await writeFile(join(root, 'manifest.json'), '{not-json', 'utf8');
    const recovered = new ConversationStorage(root);
    await recovered.initialize();

    const conversations = await recovered.listConversations();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.id, conversation.id);
    assert.equal(conversations[0]?.messageCount, 1);
    assert.match(conversations[0]?.preview ?? '', /必须在索引损坏后恢复/);
    const messages = await recovered.getAllMessages(conversation.id);
    assert.equal(messages[0]?.id, message.id);
    assert.equal(messages[0]?.content, '这条记录必须在索引损坏后恢复');
  });
});

test('recovers an interrupted streaming reply without dropping partial text', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation();
    const assistant = await storage.appendMessage(conversation.id, {
      role: 'assistant',
      content: '已经生成的部分',
      reasoning: '临时思考缓存',
      status: 'streaming',
    });

    const restarted = new ConversationStorage(root);
    await restarted.initialize();
    const messages = await restarted.getAllMessages(conversation.id);
    const recovered = messages.find((message) => message.id === assistant.id);
    assert.equal(recovered?.status, 'error');
    assert.equal(recovered?.content, '已经生成的部分');
    assert.equal(recovered?.reasoning, '临时思考缓存');
  });
});

test('keeps inserted user questions directly paired with their assistant placeholders', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    const firstUser = await storage.appendMessage(conversation.id, { role: 'user', content: '第一个问题', status: 'complete' });
    const firstAssistant = await storage.appendMessage(conversation.id, { role: 'assistant', content: '', status: 'streaming', replyToMessageId: firstUser.id });
    const insertedUser = await storage.appendMessage(conversation.id, { role: 'user', content: '插入的问题', status: 'complete' });
    const insertedAssistant = await storage.appendMessage(conversation.id, { role: 'assistant', content: '', status: 'queued', replyToMessageId: insertedUser.id });

    const messages = await storage.getAllMessages(conversation.id);
    assert.deepEqual(messages.map((message) => message.id), [firstUser.id, firstAssistant.id, insertedUser.id, insertedAssistant.id]);
    assert.equal(messages[1]?.replyToMessageId, firstUser.id);
    assert.equal(messages[3]?.replyToMessageId, insertedUser.id);
  });
});

test('recovers queued assistant placeholders with a queue-specific interruption message', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation();
    const assistant = await storage.appendMessage(conversation.id, { role: 'assistant', content: '', status: 'queued' });

    const restarted = new ConversationStorage(root);
    await restarted.initialize();
    const recovered = (await restarted.getAllMessages(conversation.id)).find((message) => message.id === assistant.id);
    assert.equal(recovered?.status, 'error');
    assert.match(recovered?.content ?? '', /排队任务/);
  });
});

test('compacts completed task cache while retaining the reply body', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    const assistant = await storage.appendMessage(conversation.id, {
      role: 'assistant',
      content: '最终回复正文',
      reasoning: '很长的思考过程'.repeat(2_000),
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      status: 'complete',
    });

    const result = await storage.cleanup({
      historyRetentionDays: 0,
      taskCacheRetentionHours: 0,
      cacheBudgetMB: 100,
    });
    const messages = await storage.getAllMessages(conversation.id);
    const compacted = messages.find((message) => message.id === assistant.id);
    assert.equal(result.compactedMessages, 1);
    assert.equal(compacted?.content, '最终回复正文');
    assert.equal(compacted?.reasoning, undefined);
    assert.deepEqual(compacted?.usage, { totalTokens: 30 });
    assert.equal((await storage.getConversation(conversation.id))?.totalTokens, 30);
  });
});

test('updates conversation token totals without double-counting streaming checkpoints', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    const assistant = await storage.appendMessage(conversation.id, {
      role: 'assistant',
      content: '',
      status: 'streaming',
      usedSkills: [{
        id: 'skill-1', name: 'Project Skill', source: 'copilot', relativePath: '~/.copilot/skills/project/SKILL.md',
      }],
    });

    await storage.updateMessage(conversation.id, assistant.id, {
      content: 'partial',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      status: 'streaming',
    });
    await storage.updateMessage(conversation.id, assistant.id, {
      content: 'complete',
      usage: { promptTokens: 180, completionTokens: 40, totalTokens: 220 },
      status: 'complete',
    });

    const summary = await storage.getConversation(conversation.id);
    const stored = (await storage.getAllMessages(conversation.id)).find((message) => message.id === assistant.id);
    assert.equal(summary?.totalTokens, 220);
    assert.equal(stored?.usage?.totalTokens, 220);
    assert.equal(stored?.usedSkills?.[0]?.name, 'Project Skill');
  });
});

test('keeps pinned history when retention cleanup removes expired conversations', async () => {
  await withStorage(async (storage) => {
    const removable = await storage.createConversation('普通对话');
    await storage.appendMessage(removable.id, { role: 'user', content: 'remove', status: 'complete' });
    const pinned = await storage.createConversation('固定对话');
    await storage.appendMessage(pinned.id, { role: 'user', content: 'keep', status: 'complete' });
    await storage.setPinned(pinned.id, true);
    await new Promise((resolve) => setTimeout(resolve, 15));

    await storage.cleanup({
      historyRetentionDays: 0.0000001,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 100,
    });
    const ids = (await storage.listConversations()).map((item) => item.id);
    assert.deepEqual(ids, [pinned.id]);
  });
});

test('evicts old unpinned history before pinned history when over budget', async () => {
  await withStorage(async (storage) => {
    const old = await storage.createConversation('旧对话');
    await storage.appendMessage(old.id, {
      role: 'assistant',
      content: 'a'.repeat(3 * 1024 * 1024),
      status: 'complete',
    });
    const pinned = await storage.createConversation('固定的大对话');
    await storage.appendMessage(pinned.id, {
      role: 'assistant',
      content: 'b'.repeat(3 * 1024 * 1024),
      status: 'complete',
    });
    await storage.setPinned(pinned.id, true);

    const result = await storage.cleanup({
      historyRetentionDays: 0,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 5,
    });
    const ids = (await storage.listConversations()).map((item) => item.id);
    assert.ok(result.deletedConversations >= 1);
    assert.deepEqual(ids, [pinned.id]);
  });
});

test('writes a valid streaming export without assembling the whole archive in memory', async () => {
  await withStorage(async (storage, root) => {
    const first = await storage.createConversation('第一段');
    await storage.appendMessage(first.id, { role: 'user', content: 'hello', status: 'complete' });
    const second = await storage.createConversation('第二段');
    await storage.appendMessage(second.id, { role: 'assistant', content: 'world', status: 'complete' });
    const destination = join(root, 'export.json');

    await storage.writeExportFile(destination);
    const parsed = JSON.parse(await readFile(destination, 'utf8')) as {
      conversations: Array<{ conversation: { id: string }; messages: Array<{ content: string }> }>;
    };
    assert.equal(parsed.conversations.length, 2);
    assert.deepEqual(
      parsed.conversations.flatMap((item) => item.messages.map((message) => message.content)).sort(),
      ['hello', 'world'],
    );
  });
});

test('keeps archived conversations during retention and budget cleanup', async () => {
  await withStorage(async (storage) => {
    const archived = await storage.createConversation('归档记录');
    await storage.appendMessage(archived.id, {
      role: 'assistant',
      content: 'a'.repeat(6 * 1024 * 1024),
      status: 'complete',
    });
    await storage.setArchived(archived.id, true);
    await new Promise((resolve) => setTimeout(resolve, 15));

    await storage.cleanup({
      historyRetentionDays: 0.0000001,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 5,
    });
    const conversation = await storage.getConversation(archived.id);
    assert.equal(conversation?.archived, true);
  });
});

test('persists, searches and detaches a read-only source conversation', async () => {
  await withStorage(async (storage, root) => {
    const source = await storage.createConversation('大型重构任务');
    await storage.appendMessage(source.id, {
      role: 'assistant',
      content: '已修复多根工作区路径判断。',
      status: 'complete',
      toolExecutions: [{
        callId: 'call-history', name: 'replace_in_file', summary: '修改路径解析器',
        output: '回归测试通过', status: 'success', approval: 'not-required', startedAt: 1, finishedAt: 2,
        changedFiles: ['src/agent/workspacePaths.ts'], risk: 'write',
      }],
    });
    const continued = await storage.createConversation('继续：大型重构任务');
    await storage.updateConversation(continued.id, {
      sourceConversationId: source.id,
      sourceConversationTitle: source.title,
      sourceHistoryDigest: '不要再次把多根工作区路径识别成外部路径。',
      sourceLinkedAt: 123,
    });

    const restarted = new ConversationStorage(root);
    await restarted.initialize();
    const linked = await restarted.getConversation(continued.id);
    assert.equal(linked?.sourceConversationId, source.id);
    assert.match(linked?.sourceHistoryDigest ?? '', /多根工作区/);
    const hits = await restarted.searchConversationMessages(source.id, 'workspacePaths', 5);
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.excerpt ?? '', /workspacePaths/);

    await restarted.updateConversation(continued.id, {
      sourceConversationId: null,
      sourceConversationTitle: null,
      sourceHistoryDigest: null,
      sourceLinkedAt: null,
    });
    assert.equal((await restarted.getConversation(continued.id))?.sourceConversationId, undefined);
  });
});

test('keeps source history while another conversation references it', async () => {
  await withStorage(async (storage) => {
    const source = await storage.createConversation('来源历史');
    await storage.appendMessage(source.id, { role: 'user', content: '需要长期保留的坑点', status: 'complete' });
    const continued = await storage.createConversation('续接任务');
    await storage.updateConversation(continued.id, {
      sourceConversationId: source.id,
      sourceConversationTitle: source.title,
      sourceHistoryDigest: '来源摘要',
      sourceLinkedAt: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    await storage.cleanup({
      historyRetentionDays: 0.0000001,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 100,
      protectedConversationIds: [continued.id],
    });
    assert.ok(await storage.getConversation(source.id));
    assert.ok(await storage.getConversation(continued.id));
  });
});

test('compacts tool and attachment details but retains execution summaries', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('Agent task');
    const message = await storage.appendMessage(conversation.id, {
      role: 'assistant',
      content: '任务完成',
      status: 'complete',
      context: { label: 'selection', kind: 'selection', content: 'selected code', dataBase64: 'unused-context-data' },
      attachments: [
        { label: 'src/a.ts', path: 'src/a.ts', kind: 'file', content: 'large file content' },
        { label: 'screenshot.png', kind: 'image', mimeType: 'image/png', dataBase64: 'aGVhdnktaW1hZ2UtZGF0YQ==', thumbnailDataUrl: 'data:image/jpeg;base64,dGh1bWI=' },
      ],
      toolExecutions: [{
        callId: 'call-1', name: 'replace_in_file', summary: '修改 src/a.ts：替换 1 处文本',
        input: '{"oldText":"a","newText":"b"}', output: 'done', status: 'success',
        approval: 'approved', startedAt: 1, finishedAt: 2, changedFiles: ['src/a.ts'], risk: 'write',
      }],
    });

    await storage.cleanup({ historyRetentionDays: 0, taskCacheRetentionHours: 0, cacheBudgetMB: 100 });
    const compacted = (await storage.getAllMessages(conversation.id)).find((item) => item.id === message.id);
    assert.equal(compacted?.attachments?.[0]?.label, 'src/a.ts');
    assert.equal(compacted?.attachments?.[0]?.content, undefined);
    assert.equal(compacted?.attachments?.[1]?.label, 'screenshot.png');
    assert.equal(compacted?.attachments?.[1]?.dataBase64, undefined);
    assert.equal(compacted?.attachments?.[1]?.thumbnailDataUrl, undefined);
    assert.equal(compacted?.context?.content, undefined);
    assert.equal(compacted?.context?.dataBase64, undefined);
    assert.equal(compacted?.toolExecutions?.[0]?.summary, '修改 src/a.ts：替换 1 处文本');
    assert.equal(compacted?.toolExecutions?.[0]?.input, undefined);
    assert.equal(compacted?.toolExecutions?.[0]?.output, undefined);
  });
});

test('clears all local conversation data without leaving manifest entries', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('to delete');
    await storage.appendMessage(conversation.id, { role: 'user', content: 'remove me', status: 'complete' });
    await storage.clearAll();
    assert.deepEqual(await storage.listConversations({ includeArchived: true }), []);
    assert.equal((await storage.stats()).messages, 0);
  });
});

test('新对话按调用方传入的模式落库，不再一律写成 agent', async () => {
  await withStorage(async (storage, root) => {
    const plan = await storage.createConversation('plan chat', undefined, 'plan');
    const chat = await storage.createConversation('chat chat', undefined, 'chat');
    const fallback = await storage.createConversation('default chat');
    assert.equal((await storage.getConversation(plan.id))?.mode, 'plan');
    assert.equal((await storage.getConversation(chat.id))?.mode, 'chat');
    assert.equal((await storage.getConversation(fallback.id))?.mode, 'agent');

    // 重新加载（读的是磁盘上的 manifest）后模式仍然一致。
    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const modes = (await reloaded.listConversations()).map((item) => item.mode);
    assert.deepEqual(modes, ['agent', 'chat', 'plan']);
  });
});

test('归档任务清单随对话持久化，且能整体清空', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('archives');
    const archive = {
      id: 'todo-archive-1',
      createdAt: 1_700_000_000_000,
      todos: [
        { content: '读代码', status: 'completed' as const },
        { content: '改实现', status: 'completed' as const },
      ],
    };
    await storage.updateConversation(conversation.id, { todos: [], todoArchives: [archive] });
    assert.deepEqual((await storage.getConversation(conversation.id))?.todoArchives, [archive]);

    // 换一个实例从磁盘重读：归档必须还在（胶囊是「历史记录」，不能只活在内存里）。
    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const stored = (await reloaded.getConversation(conversation.id))?.todoArchives;
    assert.equal(stored?.length, 1);
    assert.equal(stored?.[0]?.todos.length, 2);

    await reloaded.updateConversation(conversation.id, { todoArchives: null });
    assert.equal((await reloaded.getConversation(conversation.id))?.todoArchives, undefined);
  });
});

test('manifest 里被改坏的归档条目在载入时被丢掉，不影响对话本身', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('broken archives');
    const manifestPath = join(root, 'manifest.json');
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    raw.conversations[0].todoArchives = [
      { id: 'good', createdAt: 2, todos: [{ content: '有效', status: 'completed' }] },
      { id: 'bad', createdAt: 3, todos: 'not-an-array' },
    ];
    await writeFile(manifestPath, JSON.stringify(raw), 'utf8');

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    assert.equal(loaded?.title, 'broken archives');
    assert.equal(loaded?.todoArchives?.length, 1);
    assert.equal(loaded?.todoArchives?.[0]?.id, 'good');
  });
});

test('中断标记随对话持久化，换新清单后可清掉', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('interrupted');
    await storage.updateConversation(conversation.id, {
      todos: [
        { content: '读代码', status: 'completed' },
        { content: '改实现', status: 'pending' },
      ],
      todosInterrupted: true,
    });
    assert.equal((await storage.getConversation(conversation.id))?.todosInterrupted, true);

    // 换实例从磁盘重读：标记和清单都要还在（重启后仍能看到「已中断」的待办）。
    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const stored = await reloaded.getConversation(conversation.id);
    assert.equal(stored?.todosInterrupted, true);
    assert.equal(stored?.todos?.length, 2);
    // 中断不清空清单：失败/停止后用户还要接着做。
    assert.equal(stored?.todos?.[1]?.content, '改实现');

    await reloaded.updateConversation(conversation.id, { todosInterrupted: null });
    assert.equal((await reloaded.getConversation(conversation.id))?.todosInterrupted, undefined);
  });
});

test('manifest 里非布尔的中断标记在载入时被丢掉', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('bad flag');
    const manifestPath = join(root, 'manifest.json');
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    raw.conversations[0].todosInterrupted = 'yes';
    raw.conversations[0].todos = [{ content: 'A', status: 'pending' }];
    await writeFile(manifestPath, JSON.stringify(raw), 'utf8');

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    assert.equal(loaded?.todosInterrupted, undefined);
    // 标记被丢弃不影响清单本身。
    assert.equal(loaded?.todos?.length, 1);
  });
});
