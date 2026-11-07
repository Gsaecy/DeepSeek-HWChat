import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStorage } from '../core/storage';
import {
  buildContextWindow,
  ContextWindowBuilder,
  lightForDigest,
  outcomeOf,
  renderWorkDigest,
  requestBytesOf,
  requestPayloadOf,
  toolsOf,
} from '../core/contextWindow';
import type { ChatMessage } from '../core/types';

/**
 * 「多轮对话后突然忘记项目」的回归测试。
 *
 * 真实故障（2026-11-06，用户存档 conversation_fde3da6a…）：
 *  - 用户贴两张截图的那条消息 = **2747 KB**（图片 base64 直接存在消息里）；
 *  - 旧 `getContextMessages` 按原始 JSON 字节从新到旧累加、上限 2 MB：
 *    2 KB 的助手占位先进窗口，轮到那条用户消息时「2KB + 2747KB > 2MB」→ `break`；
 *  - 占位消息随后因为内容为空被跳过 → 请求里只剩 system；
 *  - 模型的原话是「当前对话里只有运行环境与工具说明」。
 *
 * 这里用当时那四条的**真实大小**复现，断言现在不会再丢用户那句话。
 */

const BIG_BASE64 = 'A'.repeat(2_747 * 1024);

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage {
  return {
    content: '',
    createdAt: 0,
    updatedAt: 0,
    status: 'complete',
    ...partial,
  } as ChatMessage;
}

/** 复刻事故当时的最后四条消息（数值取自真实存档）。 */
function incidentHistory(): ChatMessage[] {
  return [
    message({ id: 'u-old', role: 'user', content: '把录制胶囊放到顶部栏', createdAt: 1 }),
    message({ id: 'a-old', role: 'assistant', content: '### 我的理解\n\n好，先看代码。\n\n改完了。', createdAt: 2 }),
    message({
      id: 'u-incident',
      role: 'user',
      content: '录制状态和停止按钮胶囊，能显示在顶部栏吗？',
      createdAt: 3,
      attachments: [
        { label: '截图 1', kind: 'image', mimeType: 'image/png', dataBase64: BIG_BASE64, thumbnailDataUrl: 'data:image/png;base64,xx' },
        { label: '截图 2', kind: 'image', mimeType: 'image/png', dataBase64: 'B'.repeat(1000) },
      ],
    }),
    message({ id: 'a-placeholder', role: 'assistant', content: '', status: 'streaming', createdAt: 4 }),
  ];
}

test('窗口：新一条占位 + 2.7 MB 用户消息时，用户那句话必进窗口', () => {
  // 预算小到只够放下本轮：旧算法在这一步会把用户的问题整个丢掉（只剩占位）。
  const window = buildContextWindow(incidentHistory(), { maxMessages: 20, maxBytes: 1 });
  const ids = window.messages.map((item) => item.id);
  assert.deepEqual(ids, ['u-incident', 'a-placeholder'], '用户刚发的那句话被预算挤掉了——这正是「忘记项目」的成因');
  assert.deepEqual(window.dropped.map((item) => item.id), ['u-old', 'a-old'], '更早的历史应当被挡下，但只挡在用不到它的地方');
  // 正常预算下（图片字节不算），四条都还在窗口里，说明 2.7 MB 的图不再吃光预算。
  const roomy = buildContextWindow(incidentHistory(), { maxMessages: 20, maxBytes: 4 * 1024 * 1024 });
  assert.equal(roomy.dropped.length, 0);
  assert.equal(roomy.messages.length, 4);
});

test('窗口：最新用户消息之前的一切无条件保留（助手占位不能被预算挡掉）', () => {
  const builder = new ContextWindowBuilder({ maxMessages: 0, maxBytes: 1 });
  const newest = message({ id: 'a1', role: 'assistant', content: 'x'.repeat(100) });
  const user = message({ id: 'u1', role: 'user', content: 'y'.repeat(100) });
  assert.equal(builder.offer(newest), true);
  assert.equal(builder.offer(user), true);
  const result = builder.result();
  assert.deepEqual(result.messages.map((item) => item.id), ['u1', 'a1']);
});

test('窗口：条数上限生效，但最新用户消息仍然保留', () => {
  const window = buildContextWindow(incidentHistory(), { maxMessages: 2, maxBytes: 8 * 1024 * 1024 });
  assert.deepEqual(window.messages.map((item) => item.id), ['u-incident', 'a-placeholder']);
});

test('预算只算会发给模型的内容，图片字节不算', () => {
  const withImage = message({
    id: 'u1',
    role: 'user',
    content: '看图',
    attachments: [{ label: '截图', kind: 'image', mimeType: 'image/png', dataBase64: BIG_BASE64 }],
  });
  const weight = requestBytesOf(withImage);
  assert.ok(weight < 1000, `图片字节不该计入预算，实际 ${weight}`);
  const withText = message({
    id: 'u2',
    role: 'user',
    content: '看文件',
    attachments: [{ label: 'a.ts', kind: 'file', content: 'z'.repeat(5000) }],
  });
  assert.ok(requestBytesOf(withText) >= 5000, '附件正文仍然要计入预算');
});

test('请求副本：默认去掉图片字节与缩略图，保留标签与文字', () => {
  const [, , user] = incidentHistory();
  const payload = requestPayloadOf(user!);
  assert.equal(payload.content, '录制状态和停止按钮胶囊，能显示在顶部栏吗？');
  assert.equal(payload.attachments?.[0]?.label, '截图 1');
  assert.equal(payload.attachments?.[0]?.dataBase64, undefined);
  assert.equal(payload.attachments?.[0]?.thumbnailDataUrl, undefined);
  const keep = requestPayloadOf(user!, { keepImages: true });
  assert.equal(keep.attachments?.[0]?.dataBase64, BIG_BASE64, '本轮这张图必须还能发给模型');
});

test('摘要：配对「用户要求 → 做完了什么」，并带上工具名', () => {
  const dropped = [
    message({ id: 'u1', role: 'user', content: '把胶囊放到顶部栏' }),
    message({
      id: 'a1',
      role: 'assistant',
      content: '### 我的理解\n\n要把胶囊挪走。\n\n### 结果\n\n已把胶囊移到底部状态栏。',
      toolExecutions: [
        { name: 'read_file', status: 'success', summary: '', approval: 'not-required', content: '' },
        { name: 'replace_in_file', status: 'success', summary: '', approval: 'not-required', content: '' },
        { name: 'read_file', status: 'success', summary: '', approval: 'not-required', content: '' },
      ] as never,
    }),
    message({ id: 'u2', role: 'user', content: '顺便加个快捷键' }),
  ];
  const digest = renderWorkDigest(dropped, { todos: [{ content: '加 Esc 停止录制', status: 'pending' }] });
  assert.match(digest, /<earlier_work_summary>/);
  assert.match(digest, /用户：把胶囊放到顶部栏/);
  assert.match(digest, /已把胶囊移到底部状态栏/);
  assert.match(digest, /工具：read_file、replace_in_file/);
  assert.match(digest, /顺便加个快捷键.*没有回复/);
  assert.match(digest, /<task_list_archive>/);
  assert.match(digest, /\[ \] 加 Esc 停止录制/);
  assert.match(digest, /not a new instruction/);
});

test('摘要：条数上限保留最近的记录，并说明还有多少没列出', () => {
  const dropped: ChatMessage[] = [];
  for (let index = 0; index < 12; index += 1) {
    dropped.push(message({ id: `u${index}`, role: 'user', content: `第 ${index} 件事` }));
    dropped.push(message({ id: `a${index}`, role: 'assistant', content: `做完第 ${index} 件事` }));
  }
  const digest = renderWorkDigest(dropped, { limit: 3 });
  assert.match(digest, /第 11 件事/);
  assert.ok(!/第 1 件事/.test(digest), '更早的记录应当被裁掉');
  assert.match(digest, /older entry\/entries not listed/);
});

test('摘要片段：跳过「我的理解」取结果段；没有结果段时退回第一段', () => {
  assert.equal(outcomeOf('### 我的理解\n\n要做 X。\n\n### 结果\n\nX 已上线。'), 'X 已上线。');
  assert.equal(outcomeOf('### 我的理解\n\n要做 X。\n\n顺手改了配置。'), '顺手改了配置。', '没有结果段时取最后一段正文');
  assert.equal(outcomeOf('### 我的理解\n\n要做 X。'), '要做 X。', '只有「我的理解」时退回它后面的正文');
  assert.equal(outcomeOf('### 我的理解\n\n要做 X。\n\n### 结果\n\nX 已上线。\n\n- 需要你做的：重载'), 'X 已上线。');
  assert.equal(outcomeOf(''), '');
});

test('轻副本：只为摘要保留一行正文，工具输出全部丢掉', () => {
  const heavy = message({
    id: 'a1',
    role: 'assistant',
    content: 'x'.repeat(5000),
    reasoning: 'y'.repeat(5000),
    attachments: [{ label: '图', kind: 'image', dataBase64: BIG_BASE64 }],
    toolExecutions: [{ name: 'run_command', status: 'success', summary: '', approval: 'not-required', content: '', input: 'z'.repeat(4000), output: 'w'.repeat(4000) }] as never,
  });
  const light = lightForDigest(heavy);
  assert.ok((light.content ?? '').length <= 600);
  assert.equal(light.reasoning, undefined);
  assert.equal(light.attachments, undefined);
  assert.equal(light.toolExecutions?.[0]?.output, undefined);
  assert.deepEqual(toolsOf(light), ['run_command']);
});

/* ── 真实存储：存档里的图片搬到磁盘，读取不再受 2 MB 影响 ───────────── */

async function withStorage(run: (storage: ConversationStorage, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-context-'));
  try {
    const storage = new ConversationStorage(root);
    await storage.initialize();
    await run(storage, root);
    await storage.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('存储：粘贴的图片落成文件，消息里只留路径，窗口照样读得到本轮内容', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('上下文');
    const saved = await storage.saveConversationImage(conversation.id, {
      dataBase64: Buffer.from('fake-png-bytes').toString('base64'),
      mimeType: 'image/png',
      label: '截图 1',
    });
    assert.ok(saved.path, '图片应当落到磁盘上');
    assert.ok(saved.path!.endsWith('.png'));
    const onDisk = await stat(saved.path!);
    assert.equal(onDisk.size, Buffer.byteLength('fake-png-bytes'));

    await storage.appendMessage(conversation.id, {
      role: 'user',
      content: '这条带图',
      status: 'complete',
      attachments: [saved],
    });
    await storage.appendMessage(conversation.id, { role: 'assistant', content: '', status: 'streaming' });

    const window = await storage.getContextWindow(conversation.id, { maxMessages: 0, maxBytes: 1024 });
    assert.ok(window.messages.some((item) => item.role === 'user' && item.content === '这条带图'));
    const userFile = (await readdir(join(root, 'conversations', conversation.id, 'messages')))
      .filter((file) => file.endsWith('.json'))
      .sort()[0]!;
    const raw = await readFile(join(root, 'conversations', conversation.id, 'messages', userFile), 'utf8');
    assert.ok(!raw.includes('dataBase64'), '存档里不该再留着 base64');
  });
});

test('存储：清理时把老存档里内联的图片搬到磁盘（不丢图）', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('老存档');
    const png = Buffer.alloc(64 * 1024, 7).toString('base64');
    await storage.appendMessage(conversation.id, {
      role: 'user',
      content: '粘贴的截图',
      status: 'complete',
      attachments: [{ label: '截图', kind: 'image', mimeType: 'image/png', dataBase64: png }],
    });
    const before = await storage.stats();
    const result = await storage.cleanup({ historyRetentionDays: 30, taskCacheRetentionHours: 0, cacheBudgetMB: 0 });
    const after = await storage.stats();
    assert.ok(result.deletedMessageCacheBytes > 0, '这一步应当报告腾出的字节数');
    assert.ok(after.bytes < before.bytes, '内联图片应当被搬走，存档因此变小');
    const messages = await storage.getAllMessages(conversation.id);
    const attachment = messages[0]?.attachments?.[0];
    assert.equal(attachment?.dataBase64, undefined, '消息里只留路径');
    assert.ok(attachment?.path, '图片必须落在磁盘上');
    assert.equal((await readFile(attachment!.path!)).byteLength, 64 * 1024);
  });
});

test('存储：正文永远保留，工具输出搬进 payloads 且能按需还原', async () => {
  await withStorage(async (storage, root) => {
    const conversation = await storage.createConversation('档案');
    const message = await storage.appendMessage(conversation.id, {
      role: 'assistant',
      content: '正文永远留着：已把胶囊挪到顶部栏。',
      status: 'complete',
      toolExecutions: [{
        name: 'run_command',
        status: 'success',
        summary: '跑测试',
        approval: 'not-required',
        content: '',
        input: '{"command":"npm test"}',
        output: 'tool-output-xyz',
      }] as never,
    });
    await storage.cleanup({ historyRetentionDays: 30, taskCacheRetentionHours: 0, cacheBudgetMB: 0 });

    const [after] = await storage.getAllMessages(conversation.id);
    assert.equal(after?.content, '正文永远留着：已把胶囊挪到顶部栏。', '正文属于记录，不该被搬走');
    assert.equal(after?.toolExecutions?.[0]?.output, undefined, '重字段已经搬走');
    assert.ok(existsSync(join(root, 'conversations', conversation.id, 'payloads', `${message.id}.json`)), 'payloads 里要有一份');

    const { detail } = await storage.readMessageDetail(conversation.id, message.id);
    assert.equal(detail?.tools?.[0]?.output, 'tool-output-xyz', '按需能原样还原');
    assert.equal(detail?.tools?.[0]?.input, '{"command":"npm test"}');

    const hits = await storage.searchConversationMessages(conversation.id, '胶囊');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.hasDetail, true, '检索结果要告诉模型「还能读原文」');

    // 关键词只存在于被搬走的工具输出里：不翻 payloads 就永远搜不到（记录还在，检索装瞎）。
    const archivedHits = await storage.searchConversationMessages(conversation.id, 'tool-output-xyz');
    assert.equal(archivedHits.length, 1, '归档的工具输出也要能被检索到');
    assert.equal(archivedHits[0]?.messageId, message.id);
    assert.match(archivedHits[0]!.excerpt, /tool-output-xyz/);
  });
});

test('存储：任务节点的 baseline 能落库并被读回（重载后算得出清单变动）', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('基线');
    await storage.updateConversation(conversation.id, {
      taskNodes: [{
        id: 't1',
        title: '改代码',
        status: 'active',
        relation: 'root',
        baseline: ['读代码', '看文档'],
      }],
    });
    const stored = await storage.getConversation(conversation.id);
    assert.deepEqual(stored?.taskNodes?.[0]?.baseline, ['读代码', '看文档']);
  });
});
