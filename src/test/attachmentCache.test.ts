/**
 * 附件缓存回收的回归测试。
 *
 * 现场（审计发现）：`globalStorage/attachment-cache/` 已经 19.64 MB，而项目里
 * 没有任何地方删过它 —— 「点开一张历史图片就落一份副本」只增不减。
 * 缓存本身可以安全删除（文件名是内容哈希，删了下次点开会重新生成），
 * 所以这里只守两件事：**该删的删掉**、**不该删的一个都不动**。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneAttachmentCache } from '../agent/attachmentCache';

const NAME_A = 'a'.repeat(32) + '.png';
const NAME_B = 'b'.repeat(32) + '.jpg';
const NAME_C = 'c'.repeat(32) + '.png';

async function withCache(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'hwchat-attach-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 造一个指定大小的缓存文件，并把 mtime 设到指定天数之前。 */
async function seed(directory: string, name: string, bytes: number, ageDays: number): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, Buffer.alloc(bytes, 1));
  if (ageDays > 0) {
    const when = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
    await utimes(path, when, when);
  }
}

test('附件缓存：超过保留期的文件被删掉，其余保留', async () => {
  await withCache(async (directory) => {
    await seed(directory, NAME_A, 1024, 40);  // 40 天前 → 该删
    await seed(directory, NAME_B, 1024, 2);   // 2 天前 → 保留
    const result = await pruneAttachmentCache(directory, { maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
    assert.equal(result.removed, 1);
    assert.equal(result.freedBytes, 1024);
    assert.deepEqual((await readdir(directory)).sort(), [NAME_B]);
  });
});

test('附件缓存：超过体积上限时按最旧优先删到限额以内', async () => {
  await withCache(async (directory) => {
    // 三个各 1 MB、都不到保留期；上限设 2 MB → 必须删掉最旧的一个。
    await seed(directory, NAME_A, 1024 * 1024, 10);
    await seed(directory, NAME_B, 1024 * 1024, 5);
    await seed(directory, NAME_C, 1024 * 1024, 1);
    const result = await pruneAttachmentCache(directory, { maxBytes: 2 * 1024 * 1024 });
    assert.equal(result.removed, 1, '只删到限额以内为止，不许多删');
    assert.equal(result.keptBytes, 2 * 1024 * 1024);
    const left = (await readdir(directory)).sort();
    assert.ok(!left.includes(NAME_A), '最旧的先删');
    assert.deepEqual(left, [NAME_B, NAME_C]);
  });
});

test('附件缓存：刚写过的文件一律不碰（可能是用户正要打开的那张）', async () => {
  await withCache(async (directory) => {
    // 刚写完，但上限设成 0：即使超限也不许删它。
    await seed(directory, NAME_A, 1024 * 1024, 0);
    const result = await pruneAttachmentCache(directory, { maxBytes: 0 });
    assert.equal(result.removed, 0, '1 小时内的文件必须保留');
    assert.deepEqual(await readdir(directory), [NAME_A]);
  });
});

test('附件缓存：不认识的文件夹内容不删', async () => {
  await withCache(async (directory) => {
    await writeFile(join(directory, 'notes.txt'), 'keep me');
    await writeFile(join(directory, 'README'), 'keep me too');
    const result = await pruneAttachmentCache(directory, { maxBytes: 0, maxAgeMs: 0 });
    assert.equal(result.removed, 0, '只处理 <sha256-32>.<ext> 形式的缓存文件，别的东西一律不动');
    assert.deepEqual((await readdir(directory)).sort(), ['README', 'notes.txt']);
  });
});

test('附件缓存：目录不存在时安静返回（从没点开过图片）', async () => {
  const missing = join(tmpdir(), 'hwchat-attach-does-not-exist-1234');
  const result = await pruneAttachmentCache(missing);
  assert.deepEqual(result, { removed: 0, freedBytes: 0, keptBytes: 0, keptFiles: 0 });
});
