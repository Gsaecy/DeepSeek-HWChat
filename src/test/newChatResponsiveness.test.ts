import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as vscode from 'vscode';
import { ConversationStorage } from '../core/storage';
import { SkillRegistry } from '../agent/skillRegistry';
import { isEmptyDraftConversation } from '../core/conversationControls';
import { SingleFlight } from '../core/singleFlight';

/**
 * 「点了新建对话没反应，重载窗口后才出现」——两条真实根因。
 *
 * 1. 技能扫描会经过统一搜索调度层，队列满时抛 `SearchQueueFullError`；
 *    而「新建对话 / 打开对话 / 激活」都在 `await skills.refresh()`。
 *    于是一旦搜索队列满（刚跑完大量 Agent 任务时最典型），点击就抛异常、界面毫无反应。
 * 2. 一次点击原本要推两遍完整状态，连点几下就并发堆起来，界面在几百毫秒里没响应。
 *
 * 这里把「刷新永不 reject」和「空残骸会被收掉」钉住；状态推送的单飞由
 * `statePushPending` 的脏标记保证，属于面板内部时序，用下面的行为测试间接覆盖：
 * 失败一次之后，下一次刷新必须立刻重试（而不是缓存坏结果 30 秒）。
 */

async function withStorage(run: (storage: ConversationStorage) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-newchat-'));
  try {
    const storage = new ConversationStorage(root);
    await storage.initialize();
    await run(storage);
    await storage.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('技能扫描失败时 refresh 不抛错，并保留上一份清单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-skillroot-'));
  const registry = new SkillRegistry(
    vscode.Uri.file(root),
    vscode.Uri.file(join(root, 'copilot-skills')),
    vscode.Uri.file(join(root, 'quick-launch.json')),
  );
  // 直接替换 scan：模拟搜索调度层抛 SearchQueueFullError 的那一刻。
  const errors: unknown[] = [];
  registry.onError = (error) => errors.push(error);
  (registry as unknown as { scan: () => Promise<never> }).scan = async () => {
    throw new Error('搜索队列已满');
  };

  const list = await registry.refresh({ force: true });
  assert.deepEqual(list, [], '失败时返回上一份清单（初始为空），而不是把异常抛给调用方');
  assert.equal(errors.length, 1, '失败原因必须上报，不能悄悄吞掉');

  // 关键：失败不能把「新鲜窗口」写上，否则接下来 30 秒都不会重试。
  let attempts = 0;
  (registry as unknown as { scan: () => Promise<never[]> }).scan = async () => {
    attempts += 1;
    return [] as never[];
  };
  await registry.refresh();
  assert.equal(attempts, 1, '失败后下一次调用必须立刻重试');
});

test('创建后初始化失败不会在历史里留下空对话残骸（rollback 语义）', async () => {
  await withStorage(async (storage) => {
    const created = await storage.createConversation('新对话');
    // 模拟「updateConversation 抛错」时调用方的回滚动作。
    await storage.deleteConversation(created.id);
    assert.deepEqual(await storage.listConversations({ includeArchived: true }), []);
  });
});

test('清理会收掉「建了但从没初始化」的空残骸，并把它单列计数', async () => {
  await withStorage(async (storage) => {
    // 手工造出磁盘上真实出现过的那种记录：messageCount 0、未初始化、无权限字段。
    const debris = await storage.createConversation('新对话');
    const real = await storage.createConversation('真实对话');
    await storage.appendMessage(real.id, { role: 'user', content: '内容', status: 'complete' });
    await storage.updateConversation(real.id, { skillSelectionInitialized: true });

    // 刚建好的不算残骸（有 60 秒宽限期，避开「创建中」的窗口）。
    const early = await storage.cleanup({
      historyRetentionDays: 30,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 100,
      protectedConversationIds: [],
    });
    assert.equal(early.prunedDrafts, 0, '刚建好的空对话不能被当成残骸删掉');
    assert.ok((await storage.listConversations({ includeArchived: true }))
      .some((item) => item.id === debris.id));

    // 把它的创建时间往前挪，模拟「早就失败留下的」。
    await storage.updateConversation(debris.id, {});
    const manifestPath = join((storage as unknown as { rootPath: string }).rootPath, 'manifest.json');
    const { readFile, writeFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      conversations: Array<{ id: string; createdAt: number }>;
    };
    const target = manifest.conversations.find((item) => item.id === debris.id)!;
    target.createdAt = Date.now() - 10 * 60 * 1000;
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const reloaded = new ConversationStorage((storage as unknown as { rootPath: string }).rootPath);
    await reloaded.initialize();
    const result = await reloaded.cleanup({
      historyRetentionDays: 30,
      taskCacheRetentionHours: 24,
      cacheBudgetMB: 100,
      protectedConversationIds: [],
    });
    assert.equal(result.prunedDrafts, 1, '残骸必须被收掉');
    assert.equal(result.deletedConversations, 1);
    const remaining = (await reloaded.listConversations({ includeArchived: true })).map((item) => item.id);
    assert.deepEqual(remaining, [real.id], '有内容的对话不能被误删');
  });
});

test('状态推送单飞：连点 5 次只跑 1 份，并补跑 1 次保证最后一次生效', async () => {
  let executions = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const flight = new SingleFlight(async () => {
    executions += 1;
    if (executions === 1) await gate;
  });

  const first = flight.run();
  assert.equal(flight.isRunning, true);
  // 连点：这 4 次都不能各自开一份。
  const burst = [flight.run(), flight.run(), flight.run(), flight.run()];
  await Promise.resolve();
  assert.equal(executions, 1, '并发请求必须合并成 1 份，不能并发堆起来');

  release?.();
  await Promise.all([first, ...burst]);
  assert.equal(executions, 2, '跑完必须补一次，最后一次点击的结果不能被丢掉');
  assert.equal(flight.executionCount, 2);
  assert.equal(flight.isRunning, false, '跑完后必须回到空闲，否则后续推送会被永久吞掉');
});

test('状态推送单飞：空闲时的调用立刻执行，不被合并', async () => {
  let executions = 0;
  const flight = new SingleFlight(async () => { executions += 1; });
  await flight.run();
  await flight.run();
  assert.equal(executions, 2, '两次独立调用之间没有重叠时，必须各跑一次');
});

test('状态推送单飞：任务抛错不会把后续推送锁死', async () => {
  let executions = 0;
  const flight = new SingleFlight(async () => {
    executions += 1;
    if (executions === 1) throw new Error('推送失败');
  });
  await assert.rejects(flight.run());
  assert.equal(flight.isRunning, false, '失败后必须释放运行标记');
  await flight.run();
  assert.equal(executions, 2);
});

test('「空对话」判据：只认真正没有内容的，且面板与清理共用同一套', () => {
  const empty = { messageCount: 0 };
  assert.equal(isEmptyDraftConversation(empty), true, '0 条消息 = 空');
  assert.equal(isEmptyDraftConversation({ messageCount: 0, pinned: true }), false, '置顶的不动');
  assert.equal(isEmptyDraftConversation({ messageCount: 0, archived: true }), false, '归档的不动');
  assert.equal(isEmptyDraftConversation({ messageCount: 0, sourceConversationId: 'src' }), false, '续接副本不动');
  assert.equal(isEmptyDraftConversation({ messageCount: 1 }), false, '有内容绝不算空');
  assert.equal(isEmptyDraftConversation({}), true, '缺字段按 0 条消息处理');
});

test('newChat 永远不删已有对话：空卡片时连点也必须各出一张新卡片', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  // 与 searchBoundary.test.ts 同口径：编译产物在 out/test，源码在 src。
  const source = await readFile(join(dirname(__dirname), '..', 'src', 'views', 'chatPanel.ts'), 'utf8');
  const start = source.indexOf('  async newChat(): Promise<void> {');
  assert.ok(start > 0, '找不到 newChat()');
  const body = source.slice(start, source.indexOf('\n  }\n', start));

  // 真实故障：曾经在这里「顺手清掉上一条空对话」。当前这条没实际用过时，
  // 删旧 + 建新 = 界面上仍是 1 张同样的空卡片，用户看到的就是「点了没反应」。
  assert.ok(!body.includes('deleteConversation'), 'newChat 里不能删除任何对话');
  assert.ok(!body.includes('pruneEmpty'), 'newChat 里不能做空对话清理');
  // 必须真的建一条：否则侧边栏不会出现新卡片。
  assert.ok(body.includes('createConversation('), 'newChat 必须真的创建一条对话');
  // 创建后必须完成初始化，否则又会留下「建了但没初始化」的残骸。
  assert.ok(body.includes('skillSelectionInitialized: true'));
});

test('装了「本地skill快捷调用」时空对话不会被清理误删', async () => {
  await withStorage(async (storage) => {
    // 新建对话现在会立刻写 skillSelectionInitialized: true——这种空对话是用户
    // 主动建出来、准备使用的，绝不能因为「消息数为 0」就被清掉。
    const fresh = await storage.createConversation('新对话');
    await storage.updateConversation(fresh.id, { skillSelectionInitialized: true });

    const options = { historyRetentionDays: 30, taskCacheRetentionHours: 24, cacheBudgetMB: 100, protectedConversationIds: [] };
    // 连跑两轮（第二轮会跳过扫描，也要保证结论一致）。
    await storage.cleanup(options);
    const result = await storage.cleanup(options);
    assert.equal(result.prunedDrafts ?? 0, 0, '用户建的空对话不能被当成残骸清掉');
    assert.ok((await storage.listConversations({ includeArchived: true })).some((item) => item.id === fresh.id));
  });
});

test('当前已是空对话时不再新建卡片（最多一张空对话）', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const source = await readFile(join(dirname(__dirname), '..', 'src', 'views', 'chatPanel.ts'), 'utf8');
  const start = source.indexOf('  async newChat(): Promise<void> {');
  const body = source.slice(start, source.indexOf('\n  }\n', start));

  // 用户要求：只有这条对话「用过了」，新建对话才产生下一张卡片。
  assert.ok(body.includes('current.messageCount === 0'), '缺少「当前是空对话」的判定');
  assert.ok(body.indexOf('current.messageCount === 0') < body.indexOf('createConversation('), '判定必须在创建之前');
  // 判定成立时要提前返回，不能再走到创建那一步。
  const guard = body.slice(body.indexOf('current.messageCount === 0'), body.indexOf('createConversation('));
  assert.ok(guard.includes('return'), '空对话时必须提前结束，不能继续创建');

  // 编译产物在 out/test → out → 仓库根；media 在仓库根下。
  const chatJs = await readFile(join(dirname(__dirname), '..', 'media', 'chat.js'), 'utf8');
  assert.ok(chatJs.includes('const currentEmpty'), '界面侧也要先判断，避免画出服务端没建的卡片');
});

test('清理会把堆积的空对话收敛成一张', async () => {
  await withStorage(async (storage) => {
    const options = { historyRetentionDays: 30, taskCacheRetentionHours: 24, cacheBudgetMB: 100, protectedConversationIds: [] };
    const made: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const conversation = await storage.createConversation('新对话');
      await storage.updateConversation(conversation.id, { skillSelectionInitialized: true });
      made.push(conversation.id);
    }
    const used = await storage.createConversation('用过的对话');
    await storage.appendMessage(used.id, { role: 'user', content: '内容', status: 'complete' });
    await storage.updateConversation(used.id, { skillSelectionInitialized: true });

    // 首轮：四张空对话都还在宽限期内，一张都不动。
    const early = await storage.cleanup(options);
    assert.equal(early.prunedDrafts ?? 0, 0, '宽限期内不能动刚建的空对话');

    // 把创建时间前移，模拟「堆了几天」。
    const root = (storage as unknown as { rootPath: string }).rootPath;
    const manifestPath = join(root, 'manifest.json');
    const { readFile: read, writeFile: write } = await import('node:fs/promises');
    const manifest = JSON.parse(await read('manifest.json'.replace('manifest.json', manifestPath), 'utf8')) as {
      conversations: Array<{ id: string; createdAt: number }>;
    };
    for (const item of manifest.conversations) item.createdAt = Date.now() - 60 * 60 * 1000;
    await write(manifestPath, JSON.stringify(manifest), 'utf8');

    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const later = await reloaded.cleanup(options);
    const remaining = await reloaded.listConversations({ includeArchived: true });
    const remainingEmpty = remaining.filter((item) => item.messageCount === 0);
    assert.equal(remainingEmpty.length, 1, `空对话应只剩一张，实际 ${remainingEmpty.length}`);
    assert.equal(later.prunedDrafts, 3);
    assert.ok(remaining.some((item) => item.id === used.id), '有内容的对话不能被误删');
  });
});

test('侧栏对话再多也不能把输入框顶出视口（布局约束）', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const css = await readFile(join(dirname(__dirname), '..', 'media', 'chat.css'), 'utf8');

  // 真实故障：`.app-shell` 只声明了 grid-template-columns，隐式行是 auto，
  // 于是 12 条对话把这一行撑到 956px（视口 760px），右栏输入框被推到视口外面，
  // 用户看到的是「对话框不见了」。两处约束缺一不可。
  const shell = /\.app-shell\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(shell, /grid-template-rows:\s*minmax\(0,\s*1fr\)/, '.app-shell 必须显式声明 rows 为 minmax(0,1fr)');
  assert.match(shell, /height:\s*100%/, '.app-shell 必须占满高度');

  const pane = /\.history-pane\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(pane, /min-height:\s*0/, '.history-pane 必须允许收缩（grid item 默认 min-height:auto 会顶高整列）');
  assert.match(pane, /minmax\(0,\s*1fr\)/, '对话列表那一行必须是 minmax(0,1fr)');

  const list = /\.conversation-list\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(list, /overflow:\s*auto/, '对话列表要自己滚动，而不是把整页撑高');
});
