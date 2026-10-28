import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStorage } from '../core/storage';

/**
 * `cleanup()` 的增量扫描。
 *
 * 背景（本机实测）：19.29MB / 610 条消息的历史，每 10 分钟一次清理要读盘 + 解析
 * **131ms CPU**，而且日志是 `compacted=0 deleted=0`——什么都没变却重扫 20MB。
 * 现在只有「自上次扫描后又被写过」的对话才重扫，其余复用上次量到的体积/条数。
 *
 * 这些用例锁死两件事：**该省的要省**（不变的对话 0 次读盘）、**该做的要做**
 * （新写入的消息照样瘦身、过了保留期照样删除、改了保留配置照样整体重判）。
 */

const baseOptions = {
  historyRetentionDays: 30,
  taskCacheRetentionHours: 24,
  cacheBudgetMB: 100,
};

async function withStorage(run: (storage: ConversationStorage) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-cleanup-'));
  try {
    const storage = new ConversationStorage(root);
    await storage.initialize();
    await run(storage);
    await storage.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('unchanged conversations are not re-scanned on the next cleanup', async () => {
  await withStorage(async (storage) => {
    const ids: string[] = [];
    for (const title of ['甲', '乙', '丙']) {
      const conversation = await storage.createConversation(title);
      await storage.appendMessage(conversation.id, { role: 'user', content: title, status: 'complete' });
      ids.push(conversation.id);
    }

    const first = await storage.cleanup({ ...baseOptions, protectedConversationIds: [] });
    assert.equal(first.scannedConversations, 3, '首轮必须把每条对话读一遍');
    assert.equal(first.conversations, 3);
    assert.equal(first.messages, 3);

    const second = await storage.cleanup({ ...baseOptions, protectedConversationIds: [] });
    assert.equal(second.scannedConversations, 0, '内容没变时一次也不该读盘');
    assert.equal(second.compactedMessages, 0);
    assert.equal(second.deletedConversations, 0);
    assert.equal(second.messages, 3, '跳过扫描仍要报出准确的消息数');
    assert.equal(second.bytes, first.bytes, '跳过扫描仍要报出准确的体积');

    // 只有被写过的那一条需要重扫。
    await storage.appendMessage(ids[1]!, { role: 'assistant', content: '新回复', status: 'complete' });
    const third = await storage.cleanup({ ...baseOptions, protectedConversationIds: [] });
    assert.equal(third.scannedConversations, 1);
    assert.equal(third.messages, 4);
    assert.ok(third.bytes > first.bytes, '写入后体积必须跟着变大');
  });
});

test('a conversation written after a scan is still compacted', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    await storage.appendMessage(conversation.id, { role: 'user', content: '先写一条', status: 'complete' });
    await storage.cleanup({ ...baseOptions, protectedConversationIds: [] });

    // 保留期设成 0 = 立刻瘦身，模拟真实配置。上一轮已经扫过这条对话，
    // 但新写入的消息必须仍然被扫到并去掉思考过程/工具输出。
    const created = await storage.appendMessage(conversation.id, {
      role: 'assistant',
      content: '正文保留',
      reasoning: '思考过程'.repeat(500),
      status: 'complete',
      toolExecutions: [{
        callId: 'c1',
        name: 'read_file',
        summary: 'read a',
        status: 'success',
        startedAt: Date.now(),
        input: '{"path":"a"}',
        output: 'x'.repeat(2_000),
      }],
    });

    const result = await storage.cleanup({ ...baseOptions, taskCacheRetentionHours: 0, protectedConversationIds: [] });
    assert.equal(result.scannedConversations, 1, '只有被写过的对话需要重扫');
    assert.equal(result.compactedMessages, 1);

    const messages = await storage.getAllMessages(conversation.id);
    const compacted = messages.find((message) => message.id === created.id);
    assert.equal(compacted?.content, '正文保留');
    assert.equal(compacted?.reasoning, undefined);
    assert.equal(compacted?.toolExecutions?.[0]?.output, undefined);
  });
});

test('a conversation that becomes expired is still deleted even without new writes', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('陈旧记录');
    await storage.appendMessage(conversation.id, { role: 'user', content: '内容', status: 'complete' });

    // 1e-5 天 ≈ 864ms：留足余量，避免整套测试并发跑时「第一轮就已经过期」把断言弄成偶发失败。
    const options = { ...baseOptions, historyRetentionDays: 1e-5, protectedConversationIds: [] };
    const first = await storage.cleanup(options);
    assert.equal(first.deletedConversations, 0, '刚写完不该被判过期');

    await new Promise((resolve) => setTimeout(resolve, 900));
    const second = await storage.cleanup(options);
    assert.equal(second.scannedConversations, 1, '时间越过保留期时必须重新判定，不能因为「没写入」就跳过');
    assert.equal(second.deletedConversations, 1);
    assert.equal((await storage.listConversations()).length, 0);
  });
});

test('changing retention options forces a full rescan', async () => {
  await withStorage(async (storage) => {
    for (const title of ['甲', '乙']) {
      const conversation = await storage.createConversation(title);
      await storage.appendMessage(conversation.id, { role: 'user', content: title, status: 'complete' });
    }
    assert.equal((await storage.cleanup({ ...baseOptions, protectedConversationIds: [] })).scannedConversations, 2);
    assert.equal((await storage.cleanup({ ...baseOptions, protectedConversationIds: [] })).scannedConversations, 0);

    const changed = await storage.cleanup({ ...baseOptions, taskCacheRetentionHours: 12, protectedConversationIds: [] });
    assert.equal(changed.scannedConversations, 2, '瘦身窗口变了，旧结论作废');
  });
});

test('deleting a conversation drops its scan bookkeeping', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation();
    await storage.appendMessage(conversation.id, { role: 'user', content: 'x', status: 'complete' });
    await storage.cleanup({ ...baseOptions, protectedConversationIds: [] });

    await storage.deleteConversation(conversation.id);
    const result = await storage.cleanup({ ...baseOptions, protectedConversationIds: [] });
    assert.equal(result.scannedConversations, 0);
    assert.equal(result.conversations, 0);
    assert.equal(result.messages, 0);
  });
});

/**
 * 「删掉的空对话重载后又回来了，还显示『刚刚』」。
 *
 * 原因有两层，缺一不可：
 *  1. 删除只 `rm` 了 `conversations/<id>/messages`，`conversations/<id>/` 留下空壳；
 *  2. 下次 `reconcileManifest` 看到磁盘上还有这个 id，就把空目录重建成一条对话——
 *     空目录没有消息可读时间，`createdAt` 取当时的 `Date.now()`，于是"刚刚"。
 */
test('删除对话会删掉整个目录，不留空壳（否则重载后被 reconcile 复活）', async () => {
  const { readdir, stat } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'hwchat-shell-'));
  try {
    const storage = new ConversationStorage(root);
    await storage.initialize();
    const conversation = await storage.createConversation('要删掉的');
    await storage.appendMessage(conversation.id, { role: 'user', content: 'x', status: 'complete' });
    await storage.deleteConversation(conversation.id);

    const dirExists = await stat(join(root, 'conversations', conversation.id))
      .then(() => true)
      .catch(() => false);
    assert.equal(dirExists, false, 'conversations/<id> 必须整条删掉，不能只删 messages/');
    assert.deepEqual(await readdir(join(root, 'conversations')), [], '不能留下空目录');

    // 重载：绝不能把删掉的对话又变出来。
    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    assert.deepEqual(await reloaded.listConversations({ includeArchived: true }), [], '重载后不该复活');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('启动时清掉历史遗留的空壳目录，且不把它重建成幽灵对话', async () => {
  const { mkdir, readdir, stat, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'hwchat-shadow-'));
  try {
    // 复刻用户磁盘上的破损状态：manifest 里有一条「新对话」，磁盘上只剩空壳目录。
    await mkdir(join(root, 'conversations', 'conversation_ghost'), { recursive: true });
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      version: 1,
      conversations: [{
        id: 'conversation_ghost', title: '新对话', createdAt: 1, updatedAt: 1,
        messageCount: 0, preview: '', pinned: false, totalTokens: 0, mode: 'agent',
        skillIds: [], skillSelectionInitialized: false, archived: false,
      }],
    }), 'utf8');

    const storage = new ConversationStorage(root);
    await storage.initialize();
    assert.deepEqual(await storage.listConversations({ includeArchived: true }), [], '空壳不能变成对话');

    const leftover = await readdir(join(root, 'conversations'));
    assert.deepEqual(leftover, [], '空壳目录本身也要清掉');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('正常空对话（有 messages/ 目录）不会被当成空壳删掉', async () => {
  const { stat } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'hwchat-keep-'));
  try {
    const storage = new ConversationStorage(root);
    await storage.initialize();
    const conversation = await storage.createConversation('新对话');
    await storage.updateConversation(conversation.id, { skillSelectionInitialized: true });

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    assert.deepEqual(
      (await reloaded.listConversations({ includeArchived: true })).map((item) => item.id),
      [conversation.id],
      '刚建好的空对话必须还在',
    );
    assert.ok(await stat(join(root, 'conversations', conversation.id, 'messages')).then(() => true));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
