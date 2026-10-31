import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStorage } from '../core/storage';
import { AGENT_STEP_SAFETY_CAP } from '../core/agentLimits';

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

test('「未完成」标记与「已中断」互斥，重启后仍然只有一个', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('incomplete');
    await storage.updateConversation(conversation.id, {
      todos: [
        { content: '读代码', status: 'completed' },
        { content: '改实现', status: 'pending' },
      ],
      todosInterrupted: true,
    });
    // 同一份清单改成「跑完没结清」：中断标记必须被清掉，不能两个标签同时挂着。
    await storage.updateConversation(conversation.id, { todosIncomplete: true });
    const afterSwap = await storage.getConversation(conversation.id);
    assert.equal(afterSwap?.todosIncomplete, true);
    assert.equal(afterSwap?.todosInterrupted, undefined);

    // 反过来再置中断，也要把「未完成」清掉。
    await storage.updateConversation(conversation.id, { todosInterrupted: true });
    const afterBack = await storage.getConversation(conversation.id);
    assert.equal(afterBack?.todosInterrupted, true);
    assert.equal(afterBack?.todosIncomplete, undefined);

    // 重启后标记仍在。
    await storage.updateConversation(conversation.id, { todosInterrupted: null, todosIncomplete: true });
    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    assert.equal(loaded?.todosIncomplete, true);
    assert.equal(loaded?.todosInterrupted, undefined);
  });
});

test('manifest 里两个标记同时为真时按「已中断」算，丢掉「未完成」', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('both flags');
    const manifestPath = join(root, 'manifest.json');
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    raw.conversations[0].todosInterrupted = true;
    raw.conversations[0].todosIncomplete = true;
    raw.conversations[0].todos = [{ content: 'A', status: 'pending' }];
    await writeFile(manifestPath, JSON.stringify(raw), 'utf8');

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    assert.equal(loaded?.todosInterrupted, true);
    assert.equal(loaded?.todosIncomplete, undefined);
  });
});

// ── 每条对话自己的项目归属与运行时设置 ──────────────────────────────────

test('对话的项目根与运行时设置随 manifest 持久化', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('per-conversation settings');
    await storage.updateConversation(conversation.id, {
      projectRoot: join('workspace', 'DeepSeek-HWChat'),
      permissionPreset: 'full',
      agentMaxSteps: 8,
      reasoningEffort: 'max',
    });
    await storage.flush();

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    assert.equal(loaded?.projectRoot, join('workspace', 'DeepSeek-HWChat'));
    assert.equal(loaded?.permissionPreset, 'full');
    assert.equal(loaded?.agentMaxSteps, 8);
    assert.equal(loaded?.reasoningEffort, 'max');

    // 另一条对话不受影响：这是「设置不互相污染」的落库级断言。
    const other = await reloaded.createConversation('untouched');
    const otherLoaded = await reloaded.getConversation(other.id);
    assert.equal(otherLoaded?.permissionPreset, undefined);
    assert.equal(otherLoaded?.agentMaxSteps, undefined);
    assert.equal(otherLoaded?.reasoningEffort, undefined);
  });
});

test('manifest 里非法的项目根与运行时设置在载入时被丢掉', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('bad controls');
    const manifestPath = join(root, 'manifest.json');
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    raw.conversations[0].projectRoot = 42;
    raw.conversations[0].permissionPreset = 'custom';
    raw.conversations[0].agentMaxSteps = '99';
    raw.conversations[0].reasoningEffort = 'ultra';
    await writeFile(manifestPath, JSON.stringify(raw), 'utf8');

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    // 脏值一律当成「没有设置」，运行时回落到全局默认，而不是带着脏值去猜。
    assert.equal(loaded?.projectRoot, undefined);
    assert.equal(loaded?.permissionPreset, undefined);
    assert.equal(loaded?.agentMaxSteps, undefined);
    assert.equal(loaded?.reasoningEffort, undefined);
  });
});

test('涉及多个项目：projectRoots 随 manifest 持久化，且不碰主项目', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('multi project');
    const primary = join(root, 'workspace', 'DeepSeek-HWChat');
    await storage.updateConversation(conversation.id, {
      projectRoot: primary,
      projectRoots: [join(root, 'workspace', 'Local_skill_quick_access')],
    });
    await storage.flush();

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    // 主项目仍由 projectRoot 表达：追加展示用的项目不能把它改掉，
    // 否则相对路径与 git 写操作的归属会跟着漂。
    assert.equal(loaded?.projectRoot, primary);
    assert.deepEqual(loaded?.projectRoots, [join(root, 'workspace', 'Local_skill_quick_access')]);
  });
});

test('涉及多个项目：载入时丢掉相对路径、重复项与非字符串', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('bad roots');
    const manifestPath = join(root, 'manifest.json');
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    const absolute = join(root, 'workspace', 'MaiKer_Win');
    raw.conversations[0].projectRoots = ['workspace/relative', 42, '', absolute, absolute, `${absolute}/`];
    await writeFile(manifestPath, JSON.stringify(raw), 'utf8');

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    // 徽标只展示绝对路径的项目：相对路径会拼到进程 cwd 上，显示出来是个不存在的目录。
    assert.deepEqual(loaded?.projectRoots, [absolute]);
  });
});

test('涉及多个项目：写空数组等于清空该字段', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('clear roots');
    const absolute = join(process.cwd(), 'workspace', 'MaiKer_Win');
    await storage.updateConversation(conversation.id, { projectRoots: [absolute] });
    assert.deepEqual((await storage.getConversation(conversation.id))?.projectRoots, [absolute]);
    await storage.updateConversation(conversation.id, { projectRoots: [] });
    assert.equal((await storage.getConversation(conversation.id))?.projectRoots, undefined);
  });
});

test('存档里的 agentMaxSteps = 0 是「无限制」，原样保留；负数才是脏值', async () => {  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('unlimited steps');
    const manifestPath = join(root, 'manifest.json');
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    // 0 = 工具条第四档「无限制」（显式选择），必须原样读回来，
    // 否则选了「无限制」的对话一重启就悄悄退回默认预算。
    raw.conversations[0].agentMaxSteps = 0;
    await writeFile(manifestPath, JSON.stringify(raw), 'utf8');

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    assert.equal(loaded?.agentMaxSteps, 0, '0 是「无限制」，不能当成脏值丢掉');

    // 负数才是脏值：它既不是任何一档预设，也不该被解释成无限。
    const negative = JSON.parse(await readFile(manifestPath, 'utf8'));
    negative.conversations[0].agentMaxSteps = -5;
    await writeFile(manifestPath, JSON.stringify(negative), 'utf8');
    const reloadedNegative = new ConversationStorage(root);
    await reloadedNegative.initialize();
    assert.equal(
      (await reloadedNegative.getConversation(conversation.id))?.agentMaxSteps,
      undefined,
      '负数必须当成脏值丢掉，回落到默认预算',
    );

    // 超过绝对上限的值被夹到上限，而不是原样保留。
    const over = JSON.parse(await readFile(manifestPath, 'utf8'));
    over.conversations[0].agentMaxSteps = 10_000;
    await writeFile(manifestPath, JSON.stringify(over), 'utf8');
    const reloadedAgain = new ConversationStorage(root);
    await reloadedAgain.initialize();
    assert.equal((await reloadedAgain.getConversation(conversation.id))?.agentMaxSteps, AGENT_STEP_SAFETY_CAP);
  });
});

test('title: the first user message still names an untouched conversation', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    await storage.appendMessage(conversation.id, { role: 'user', content: '帮我检查一下滚动条', status: 'complete' });
    const loaded = await storage.getConversation(conversation.id);
    assert.equal(loaded?.title, '帮我检查一下滚动条');
    assert.equal(loaded?.titleCustomized, undefined);
  });
});

test('title: a custom title is marked and survives later messages', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    const renamed = await storage.setTitle(conversation.id, '  胶囊配色  ');
    assert.equal(renamed.title, '胶囊配色');
    assert.equal(renamed.titleCustomized, true);

    // 关键回归点：首条用户消息以前会无条件把标题改成消息内容，
    // 用户刚改的名字会被第一句话冲掉。
    await storage.appendMessage(conversation.id, { role: 'user', content: '这是一句很长的新任务描述', status: 'complete' });
    const loaded = await storage.getConversation(conversation.id);
    assert.equal(loaded?.title, '胶囊配色');
  });
});

test('title: renaming does not count as conversation activity', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    await storage.appendMessage(conversation.id, { role: 'user', content: '第一条', status: 'complete' });
    const before = await storage.getConversation(conversation.id);
    const renamed = await storage.setTitle(conversation.id, '改个名字');
    // updatedAt 一变，历史列表的顺序就会因为「改了个名字」而跳动。
    assert.equal(renamed.updatedAt, before?.updatedAt);
    assert.equal(renamed.title, '改个名字');
  });
});

test('title: an empty title is ignored instead of wiping the name', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('原来的名字');
    const after = await storage.setTitle(conversation.id, '   ');
    assert.equal(after.title, '原来的名字');
    assert.equal(after.titleCustomized, undefined);
  });
});

test('title: custom titles are capped at 48 characters like auto titles', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    const long = '长'.repeat(80);
    const renamed = await storage.setTitle(conversation.id, long);
    assert.equal(renamed.title.length, 48);
    assert.ok(renamed.title.endsWith('…'));
  });
});

test('title: the customized flag survives a reload', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation();
    await storage.setTitle(conversation.id, '重启也还在');
    await storage.flush();

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const loaded = await reloaded.getConversation(conversation.id);
    assert.equal(loaded?.title, '重启也还在');
    assert.equal(loaded?.titleCustomized, true);
  });
});

test('history order: newest created conversation first', async () => {
  await withStorage(async (storage) => {
    const first = await storage.createConversation('最早建的');
    const second = await storage.createConversation('中间建的');
    const third = await storage.createConversation('最新建的');

    const ids = (await storage.listConversations()).map((item) => item.id);
    assert.deepEqual(ids, [third.id, second.id, first.id]);
  });
});

test('history order: new messages and model switches do not reshuffle the list', async () => {
  await withStorage(async (storage) => {
    const older = await storage.createConversation('先建的');
    const newer = await storage.createConversation('后建的');
    const before = (await storage.listConversations()).map((item) => item.id);
    assert.deepEqual(before, [newer.id, older.id]);

    // 关键回归点：以前按 updatedAt 排序，在旧对话里接着聊一句、
    // 或者只是换个模型，它就会窜到最上面 —— 位置随使用不停跳动。
    await storage.appendMessage(older.id, { role: 'user', content: '接着聊一句', status: 'complete' });
    await storage.updateConversation(older.id, { model: 'deepseek-reasoner' });
    await storage.appendMessage(older.id, { role: 'assistant', content: '好的', status: 'complete' });

    const after = (await storage.listConversations()).map((item) => item.id);
    assert.deepEqual(after, [newer.id, older.id], '对话位置只由新建时间决定，不能被后发消息顶上去');

    // 反过来：更新的一条也不能把新建的更晚的对话挤下去。
    await storage.appendMessage(newer.id, { role: 'user', content: '这条也聊两句', status: 'complete' });
    const again = (await storage.listConversations()).map((item) => item.id);
    assert.deepEqual(again, [newer.id, older.id]);
  });
});

test('history order: pinned still floats to the top and archived still sinks', async () => {
  await withStorage(async (storage) => {
    const oldest = await storage.createConversation('最早的');
    const middle = await storage.createConversation('中间的');
    const newest = await storage.createConversation('最新的');

    await storage.setPinned(oldest.id, true);
    // 置顶优先于新建时间：即使它是最早建的，也要排在最前。
    assert.deepEqual(
      (await storage.listConversations()).map((item) => item.id),
      [oldest.id, newest.id, middle.id],
    );

    await storage.setArchived(middle.id, true);
    // 归档的沉底。注意 listConversations() 不带参数时**包含**归档项
    // （过滤器在 archived === undefined 时直接放行），要排除得显式传 archived: false。
    assert.deepEqual(
      (await storage.listConversations({ archived: false })).map((item) => item.id),
      [oldest.id, newest.id],
    );
    assert.deepEqual(
      (await storage.listConversations({ includeArchived: true })).map((item) => item.id),
      [oldest.id, newest.id, middle.id],
    );
  });
});

test('history order: createdAt order is stable across a reload', async () => {
  await withStorage(async (storage, root) => {
    const first = await storage.createConversation('第一条');
    const second = await storage.createConversation('第二条');
    // 让第一条的 updatedAt 变成最新，再存盘：重启后的顺序不能因此翻转。
    await storage.appendMessage(first.id, { role: 'user', content: '更新的内容', status: 'complete' });
    await storage.flush();

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    assert.deepEqual(
      (await reloaded.listConversations()).map((item) => item.id),
      [second.id, first.id],
    );
  });
});

test('deleteMessage：删掉一条排队消息，计数与预览跟着回退', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    const kept = await storage.appendMessage(conversation.id, { role: 'user', content: '保留这句', status: 'complete' });
    const queued = await storage.appendMessage(conversation.id, { role: 'user', content: '要删掉这句', status: 'complete' });
    const before = await storage.getConversation(conversation.id);
    assert.equal(before?.messageCount, 2);

    await storage.deleteMessage(conversation.id, queued.id);

    const messages = await storage.getMessages(conversation.id);
    assert.deepEqual(messages.messages.map((message) => message.id), [kept.id], '只剩下没被删的那条');
    const after = await storage.getConversation(conversation.id);
    assert.equal(after?.messageCount, 1, '计数要跟着减，否则界面显示的总条数是错的');
  });
});

test('deleteMessage：删不存在的消息不报错、也不改计数', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    await storage.appendMessage(conversation.id, { role: 'user', content: '一', status: 'complete' });
    await storage.deleteMessage(conversation.id, 'message-does-not-exist');
    const after = await storage.getConversation(conversation.id);
    assert.equal(after?.messageCount, 1, '幂等：重复删同一条不能把计数越减越少');
  });
});

/* ── 用户消息的执行状态（气泡上的四色徽标） ───────────────────── */

test('执行状态：默认不写、写了能读回、能改', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation();
    const plain = await storage.appendMessage(conversation.id, {
      role: 'user', content: '老消息没有状态', status: 'complete',
    });
    assert.equal(plain.executionStatus, undefined, '没传就不写，界面据此不画徽标（不猜）');

    const queued = await storage.appendMessage(conversation.id, {
      role: 'user', content: '排队那条', status: 'complete', executionStatus: 'pending',
    });
    assert.equal(queued.executionStatus, 'pending');

    const running = await storage.updateMessage(conversation.id, queued.id, { executionStatus: 'running' });
    assert.equal(running.executionStatus, 'running');
    const done = await storage.updateMessage(conversation.id, queued.id, { executionStatus: 'done' });
    assert.equal(done.executionStatus, 'done');

    // 落盘之后重新读一遍（重启 VS Code 的场景）
    const reopened = new ConversationStorage(root);
    await reopened.initialize();
    const { messages } = await reopened.getMessages(conversation.id, { limit: 20 });
    assert.equal(messages.find((item) => item.id === queued.id)?.executionStatus, 'done');
    assert.equal(messages.find((item) => item.id === plain.id)?.executionStatus, undefined);
  });
});

test('执行状态：认不出来的值一律丢掉（不猜成「已执行」）', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation();
    const message = await storage.appendMessage(conversation.id, {
      role: 'user', content: '脏数据', status: 'complete',
    });
    const path = join(root, 'conversations', conversation.id, 'messages', `${message.id}.json`);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    raw.executionStatus = 'finished-ish';
    await writeFile(path, JSON.stringify(raw), 'utf8');

    const reopened = new ConversationStorage(root);
    await reopened.initialize();
    const { messages } = await reopened.getMessages(conversation.id, { limit: 20 });
    assert.equal(messages.find((item) => item.id === message.id)?.executionStatus, undefined, '脏值不该被当成任何状态');
  });
});

test('执行状态：重启时把没结算的 running/pending 收口，不永远挂着', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation();
    const wasRunning = await storage.appendMessage(conversation.id, {
      role: 'user', content: '进程退出时还在跑', status: 'complete', executionStatus: 'running',
    });
    const neverRan = await storage.appendMessage(conversation.id, {
      role: 'user', content: '还排在队列里就退出了', status: 'complete', executionStatus: 'pending',
    });
    await storage.flush();

    const reopened = new ConversationStorage(root);
    await reopened.initialize();
    const { messages } = await reopened.getMessages(conversation.id, { limit: 20 });
    assert.equal(messages.find((item) => item.id === wasRunning.id)?.executionStatus, 'done', '跑过 → 已执行');
    assert.equal(messages.find((item) => item.id === neverRan.id)?.executionStatus, 'skipped', '没跑过 → 已跳过');
  });
});

test('moves automatically expired conversations to the recycle bin instead of deleting them', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('会被清理的对话');
    await storage.appendMessage(conversation.id, { role: 'user', content: '这条内容必须还能找回', status: 'complete' });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const result = await storage.cleanup({
      historyRetentionDays: 0.0000001,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 100,
    });
    assert.equal(result.deletedConversations, 1);
    assert.equal((await storage.listConversations()).length, 0);

    // 「删除」现在是移入回收站：条目在、内容也在。
    const trash = await storage.listTrash();
    assert.equal(trash.length, 1);
    assert.equal(trash[0]?.id, conversation.id);
    assert.equal(trash[0]?.reason, 'expired');

    assert.equal(await storage.restoreFromTrash(conversation.id), true);
    const restored = await storage.listConversations();
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.id, conversation.id);
    const messages = await storage.getAllMessages(conversation.id);
    assert.equal(messages[0]?.content, '这条内容必须还能找回');
    assert.equal((await storage.listTrash()).length, 0);
  });
});

test('keeps archived conversations protected when the manifest is lost', async () => {
  await withStorage(async (storage, root) => {
    const active = await storage.createConversation('活跃对话');
    await storage.appendMessage(active.id, { role: 'user', content: 'active', status: 'complete' });
    const archived = await storage.createConversation('归档对话');
    await storage.appendMessage(archived.id, { role: 'user', content: 'archived', status: 'complete' });
    await storage.setArchived(archived.id, true);
    await new Promise((resolve) => setTimeout(resolve, 15));

    /*
     * 复现用户报告的那次数据丢失：manifest 读不出来 → 走 rebuild 重建。
     * 旧实现在这里会把所有对话重建成 `archived: false`，紧接着的超期清理
     * 就把归档对话当普通旧对话删掉了。
     */
    await writeFile(join(root, 'manifest.json'), '{not-json', 'utf8');
    const recovered = new ConversationStorage(root);
    await recovered.initialize();
    const summaries = await recovered.listConversations().catch(() => []);
    const archivedSummary = summaries.find((item) => item.id === archived.id);
    assert.equal(archivedSummary?.archived, true, '重建后归档标记必须保留');

    await recovered.cleanup({
      historyRetentionDays: 0.0000001,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 100,
    });
    const ids = (await recovered.listConversations()).map((item) => item.id);
    assert.deepEqual(ids, [archived.id]);
  });
});

/** 把一条已落盘的消息改成「很久以前」，用来绕过预算瘦身的时间下限。 */
async function ageMessageOnDisk(root: string, conversationId: string, messageId: string, ageMs: number): Promise<void> {
  const path = join(root, 'conversations', conversationId, 'messages', `${messageId}.json`);
  const message = JSON.parse(await readFile(path, 'utf8'));
  message.updatedAt = Date.now() - ageMs;
  await writeFile(path, JSON.stringify(message), 'utf8');
}

test('slims cached payloads before deleting a conversation when over budget', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('带大附件的对话');
    const message = await storage.appendMessage(conversation.id, {
      role: 'user',
      content: '附件很占地方，但正文不能丢',
      status: 'complete',
      // 8MB 的 base64 缩略图：预算 5MB 一定超，但它是可再生的缓存。
      attachments: [{ label: 'shot.png', kind: 'image', dataBase64: 'A'.repeat(8 * 1024 * 1024) }],
    });
    // 超过瘦身时间下限（6 小时）才会被削缓存。
    await ageMessageOnDisk(root, conversation.id, message.id, 7 * 60 * 60 * 1000);

    const result = await storage.cleanup({
      historyRetentionDays: 0,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 5,
    });

    // 对话必须还在：削缓存已经够用了，不该删整条。
    assert.equal(result.deletedConversations, 0);
    const ids = (await storage.listConversations()).map((item) => item.id);
    assert.deepEqual(ids, [conversation.id]);
    const stored = (await storage.getAllMessages(conversation.id))[0];
    assert.equal(stored?.content, '附件很占地方，但正文不能丢');
    assert.equal(stored?.attachments?.[0]?.dataBase64, undefined, 'base64 缓存应被削掉');
    assert.equal(stored?.attachments?.[0]?.label, 'shot.png', '附件描述必须保留');
    assert.ok(result.deletedMessageCacheBytes > 1024 * 1024);
  });
});

test('never slims cache of messages from the last few hours, even when over budget', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('刚发的大附件');
    await storage.appendMessage(conversation.id, {
      role: 'user',
      content: '刚贴了一张图',
      status: 'complete',
      attachments: [{ label: 'fresh.png', kind: 'image', dataBase64: 'B'.repeat(8 * 1024 * 1024) }],
    });

    const result = await storage.cleanup({
      historyRetentionDays: 0,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 5,
    });

    // 刚发的内容不许被削：否则用户看到的是「图突然变成文件条目」。
    assert.equal(result.deletedMessageCacheBytes, 0);
    // 削不动就只能整条挪进回收站 —— 但内容一个字节都不能少，能原样恢复。
    assert.equal(result.deletedConversations, 1);
    assert.equal((await storage.listConversations()).length, 0);
    assert.equal(await storage.restoreFromTrash(conversation.id), true);
    const stored = (await storage.getAllMessages(conversation.id))[0];
    assert.ok(stored?.attachments?.[0]?.dataBase64, '恢复后附件缓存必须原样还在');
  });
});
