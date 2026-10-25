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
