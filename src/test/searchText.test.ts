import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ambiguousTerms,
  excerptAround,
  matchTokens,
  normalizeSearchText,
  recallTokens,
  resolveAmbiguousTerms,
} from '../core/searchText';
import { ConversationStorage } from '../core/storage';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 检索质量的三件事（用户 2026-11-07 的要求）：
 *  1. 由宿主**自动**执行，不等模型调工具；
 *  2. 关键词**模糊匹配**，换个说法也要命中；
 *  3. 一个说法对上多条任务时，要提示模型**先问用户**怎么称呼。
 */

test('取词：中文按二元片段，英文/标识符整词保留', () => {
  const tokens = recallTokens('录制状态胶囊放到顶部栏，顺便看下 recorder_engine.ts 和 SCStream');
  assert.ok(tokens.includes('录制'), tokens.join(','));
  assert.ok(tokens.includes('胶囊'));
  assert.ok(tokens.includes('recorder_engine.ts') || tokens.includes('recorder'));
  assert.ok(tokens.includes('scstream'));
  assert.ok(!tokens.includes('的'));
});

test('取词：泛词被丢掉（否则什么都能命中）', () => {
  const tokens = recallTokens('这个功能需要看一下');
  assert.deepEqual(tokens.filter((token) => ['这个', '功能', '需要', '可以'].includes(token)), []);
});

test('模糊命中：换个说法也能中', () => {
  const match = matchTokens('把录制状态胶囊挪到顶部栏', recallTokens('录制胶囊放到顶部'));
  assert.ok(match.score >= 0.5, `score=${match.score}；命中 ${match.hits.join(',')}`);
});

test('模糊命中：不相干的内容不会命中', () => {
  const match = matchTokens('数据库迁移脚本', recallTokens('录制胶囊放到顶部'));
  assert.ok(match.score < 0.5, `score=${match.score}`);
});

test('归一化：全角、大小写、标点都不影响', () => {
  assert.equal(normalizeSearchText('ＳＣＲＥＥＮ　Ｃａｐｔｕｒｅ，ＥＲＲＯＲ！'), 'screen capture error');
});

test('片段：命中词附近取一小段，而不是从头截', () => {
  const text = `${'前'.repeat(400)}录制胶囊崩了${'后'.repeat(400)}`;
  const excerpt = excerptAround(text, recallTokens('录制胶囊'), 120);
  assert.ok(excerpt.includes('录制胶囊'));
  assert.ok(excerpt.length <= 130, `excerpt=${excerpt.length}`);
  assert.ok(excerpt.startsWith('…'), '截断处要有省略号');
});

test('多义：一个说法对上多条任务', () => {
  const conflicts = ambiguousTerms(recallTokens('把胶囊挪一下'), ['改录制胶囊', '拖动区域胶囊', '同步文档']);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.term, '胶囊');
  assert.deepEqual(conflicts[0]!.titles, ['改录制胶囊', '拖动区域胶囊']);
});

test('多义：只有一条对应时不算冲突', () => {
  assert.deepEqual(ambiguousTerms(recallTokens('胶囊'), ['改录制胶囊', '同步文档']), []);
});

/* ── 真实存储：窗口切掉的历史会被自动检索回来 ─────────────────────── */

async function withStorage(run: (storage: ConversationStorage) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-recall-'));
  try {
    const storage = new ConversationStorage(root);
    await storage.initialize();
    await run(storage);
    await storage.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('自动检索：窗口外的旧记录，按本轮说法被捞回来', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('录制功能');
    await storage.appendMessage(conversation.id, {
      role: 'user',
      content: '录制胶囊的停止按钮不见了，报错 SCStreamError -3801',
      status: 'complete',
    });
    await storage.appendMessage(conversation.id, { role: 'assistant', content: '先看 SCStream 的日志。', status: 'complete' });
    // 再堆几条，把上面两条挤出窗口。
    for (let index = 0; index < 6; index += 1) {
      await storage.appendMessage(conversation.id, { role: 'user', content: `第 ${index} 条闲聊`, status: 'complete' });
      await storage.appendMessage(conversation.id, { role: 'assistant', content: `收到 ${index}`, status: 'complete' });
    }
    const window = await storage.getContextWindow(conversation.id, {
      maxMessages: 4,
      maxBytes: 8 * 1024,
      recall: { tokens: recallTokens('胶囊那个 SCStream 报错是什么'), limit: 3 },
    });
    assert.ok(window.dropped.length > 0, '这几条应当已经被切到窗口外');
    assert.ok(window.recall.length > 0, '自动检索必须自己把相关旧记录捞回来，而不是等模型调工具');
    const hit = window.recall.find((item) => item.messageId);
    assert.ok(hit?.excerpt.includes('胶囊') || hit?.excerpt.includes('SCStream'), hit?.excerpt);
  });
});

test('自动检索：正文里没有、但归档过的工具输出里有，也要能捞到', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('报错');
    const message = await storage.appendMessage(conversation.id, {
      role: 'assistant',
      content: '跑了一下命令。',
      status: 'complete',
      toolExecutions: [{
        name: 'run_command',
        status: 'error',
        summary: '运行命令',
        approval: 'not-required',
        content: '',
        output: 'xcodebuild: error: SCStreamError -3801 stream output not found',
      }] as never,
    });
    await storage.cleanup({ historyRetentionDays: 30, taskCacheRetentionHours: 0, cacheBudgetMB: 0 });
    for (let index = 0; index < 4; index += 1) {
      await storage.appendMessage(conversation.id, { role: 'user', content: `闲聊 ${index}`, status: 'complete' });
      await storage.appendMessage(conversation.id, { role: 'assistant', content: `好 ${index}`, status: 'complete' });
    }
    const window = await storage.getContextWindow(conversation.id, {
      maxMessages: 2,
      maxBytes: 4 * 1024,
      recall: { tokens: recallTokens('SCStreamError -3801'), limit: 3 },
    });
    const hit = window.recall.find((item) => item.messageId === message.id);
    assert.ok(hit, '归档到 payloads 里的工具输出必须能被自动检索到');
    assert.equal(hit?.hasDetail, true);
    assert.match(hit!.excerpt, /SCStreamError/);
  });
});

test('显式检索：换成近义词也能命中（模糊匹配）', async () => {
  await withStorage(async (storage) => {
    const conversation = await storage.createConversation('模糊');
    await storage.appendMessage(conversation.id, {
      role: 'user',
      content: '把录制状态胶囊挪到顶部栏，别挡住屏幕',
      status: 'complete',
    });
    const hits = await storage.searchConversationMessages(conversation.id, '胶囊放顶部', 5);
    assert.equal(hits.length, 1, '「胶囊放顶部」应当命中「录制状态胶囊挪到顶部栏」');
  });
});

test('多义处理：只说了多义词、没有限定词 → 问', () => {
  const [resolution] = resolveAmbiguousTerms(recallTokens('把胶囊挪一下'), ['改录制胶囊', '拖动区域胶囊']);
  assert.equal(resolution?.mode, 'ask');
  assert.deepEqual(resolution?.candidates, ['改录制胶囊', '拖动区域胶囊']);
});

test('多义处理：有限定词且明显指向一条 → 按它继续（不打扰用户）', () => {
  const [resolution] = resolveAmbiguousTerms(
    recallTokens('拖动区域胶囊那个还没修'),
    ['改录制胶囊', '拖动区域胶囊'],
  );
  assert.equal(resolution?.mode, 'assume');
  assert.equal(resolution?.chosen, '拖动区域胶囊');
});

test('多义处理：限定词两边各沾一点 → 还是要问', () => {
  const [resolution] = resolveAmbiguousTerms(
    recallTokens('胶囊的录制和拖动两边都看看'),
    ['改录制胶囊', '拖动区域胶囊'],
  );
  assert.equal(resolution?.mode, 'ask');
});

test('多义处理：只有一条对应时不出提示', () => {
  assert.deepEqual(resolveAmbiguousTerms(recallTokens('胶囊'), ['改录制胶囊', '同步文档']), []);
});
