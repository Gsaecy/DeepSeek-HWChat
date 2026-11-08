/**
 * 存档跨窗口并发（2026-11-08 外部评审 ⑦）。
 *
 * 现场风险：`SingleFlight` 只合并**同一个扩展宿主进程**内的写。开两个 VS Code 窗口
 * 就是两个宿主，各自持有一份 manifest 内存快照 → 后写覆盖先写，会话从索引里消失；
 * 两个窗口同时清理还会互相删对方正在读的 `payloads/`。
 *
 * 这里验证三件事：
 *  1. 合并写：两个实例各建一条对话，最终两条都在；
 *  2. 删除不被复活：另一个实例的旧快照不能把已删条目写回来；
 *  3. 清理主：同一时刻只有一个实例能拿到清理锁。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStorage, mergeManifests } from '../core/storage';
import { tryFileLock, withFileLock } from '../core/fileLock';
import { MANIFEST_VERSION } from '../core/storage';

const summary = (id: string, updatedAt: number) => ({
  id,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  messageCount: 1,
  preview: '',
  pinned: false,
  totalTokens: 0,
  skillIds: [],
  skillSelectionInitialized: false,
  archived: false,
});

test('mergeManifests：两个窗口各建一条 → 两条都在', () => {
  const disk = { version: MANIFEST_VERSION, conversations: [summary('a', 100)] };
  const memory = { version: MANIFEST_VERSION, conversations: [summary('b', 200)] };
  const merged = mergeManifests(disk as never, memory as never);
  assert.deepEqual(merged.conversations.map((item) => item.id).sort(), ['a', 'b']);
});

test('mergeManifests：同一条以 updatedAt 更新的那份为准', () => {
  const disk = { version: MANIFEST_VERSION, conversations: [summary('a', 300)] };
  const memory = { version: MANIFEST_VERSION, conversations: [summary('a', 100)] };
  const merged = mergeManifests(disk as never, memory as never);
  assert.equal(merged.conversations.find((item) => item.id === 'a')?.updatedAt, 300);
});

test('mergeManifests：显式删除的 id 不会被磁盘旧副本复活', () => {
  const disk = { version: MANIFEST_VERSION, conversations: [summary('gone', 100), summary('keep', 100)] };
  const memory = { version: MANIFEST_VERSION, conversations: [summary('keep', 100)] };
  const merged = mergeManifests(disk as never, memory as never, ['gone']);
  assert.deepEqual(merged.conversations.map((item) => item.id), ['keep']);
});

test('两个实例共用同一个存储根：各建一条，重载后两条都在', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-concurrent-'));
  try {
    const a = new ConversationStorage(root);
    const b = new ConversationStorage(root);
    await a.initialize();
    await b.initialize();

    const one = await a.createConversation('from-a');
    const two = await b.createConversation('from-b');

    // 第三个实例重新读盘：manifest 是唯一真相。
    const reloaded = new ConversationStorage(root);
    await reloaded.initialize();
    const ids = (await reloaded.listConversations({ includeArchived: true })).map((item) => item.id);
    assert.ok(ids.includes(one.id), 'A 建的对话被 B 的写入覆盖了');
    assert.ok(ids.includes(two.id));

    const onDisk = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { conversations: Array<{ id: string }> };
    assert.equal(onDisk.conversations.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('删除不会被另一个实例的旧快照写回来', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-tombstone-'));
  try {
    const a = new ConversationStorage(root);
    await a.initialize();
    const target = await a.createConversation('to-delete');

    // B 先读盘（此时能看到 target），随后 A 删除。
    const b = new ConversationStorage(root);
    await b.initialize();
    await a.deleteConversation(target.id);

    // B 再写一次（模拟它在另一个窗口里改了别的东西）。
    await b.createConversation('from-b');

    const onDisk = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { conversations: Array<{ id: string }> };
    assert.equal(onDisk.conversations.some((item) => item.id === target.id), false, '已删除的对话被复活了');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('文件锁：同一时刻只有一个持有者', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-lock-'));
  const lock = join(root, 'x.lock');
  try {
    const first = await tryFileLock(lock, { timeoutMs: 0 });
    assert.ok(first, '第一个应该拿到锁');
    const second = await tryFileLock(lock, { timeoutMs: 50 });
    assert.equal(second, undefined, '第二个不该拿到锁');
    await first!();
    const third = await tryFileLock(lock, { timeoutMs: 50 });
    assert.ok(third, '释放后应能再拿到');
    await third!();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('文件锁：陈旧锁（进程崩溃留下）可以被接管', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-stale-'));
  const lock = join(root, 'x.lock');
  try {
    await writeFile(lock, 'dead-process:1', 'utf8');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, old, old);
    const handle = await tryFileLock(lock, { timeoutMs: 200, staleMs: 1_000 });
    assert.ok(handle, '陈旧锁必须能被接管，否则一次崩溃会永久卡住所有写入');
    await handle!();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('文件锁：任务抛错也要释放（否则后续写入全部卡死）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-lock-throw-'));
  const lock = join(root, 'x.lock');
  try {
    await assert.rejects(withFileLock(lock, async () => { throw new Error('boom'); }), /boom/);
    const again = await tryFileLock(lock, { timeoutMs: 50 });
    assert.ok(again, '抛错后锁必须已释放');
    await again!();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
