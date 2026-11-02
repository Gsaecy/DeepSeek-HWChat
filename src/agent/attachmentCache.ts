/**
 * 附件缓存的清理。
 *
 * 现场（审计发现）：`globalStorage/attachment-cache/` 已经 **19.64 MB**，而全项目
 * 没有任何地方删过它 —— 用户点开一张历史图片，就会在磁盘上按内容寻址落一份副本，
 * 之后再也不回收。用得越久越大，属于「只增不减」的慢性问题。
 *
 * 这个缓存**可以安全删除**：文件名是内容哈希，删掉之后下次点开同一张图会重新
 * 从对话存档里生成一份，功能完全不受影响（见 `ChatPanel.attachmentCacheUri`）。
 *
 * 两条清理规则，都很保守：
 *   1. 超过 `maxAgeMs`（默认 30 天）的先删；
 *   2. 仍然超过 `maxBytes`（默认 200 MB）就按最旧优先删到限额以内。
 * 另外**刚写过的文件（1 小时内）一律不碰** —— 那很可能是用户正要打开的那一张。
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface AttachmentCachePruneOptions {
  /** 体积上限（字节）。默认 200 MB。 */
  maxBytes?: number;
  /** 保留时长。默认 30 天。 */
  maxAgeMs?: number;
  /** 注入「现在」，便于测试。 */
  now?: number;
}

export interface AttachmentCachePruneResult {
  /** 删掉的文件数。 */
  removed: number;
  /** 释放的字节数。 */
  freedBytes: number;
  /** 清理后剩余体积。 */
  keptBytes: number;
  /** 剩余文件数。 */
  keptFiles: number;
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 最近这段时间内写过的文件不删：可能正是用户刚点开、还要再看一眼的那张图。 */
const RECENT_GRACE_MS = 60 * 60 * 1000;

export async function pruneAttachmentCache(
  directory: string,
  options: AttachmentCachePruneOptions = {},
): Promise<AttachmentCachePruneResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now();

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // 目录还不存在（从没点开过图片）：什么都不用做。
    return { removed: 0, freedBytes: 0, keptBytes: 0, keptFiles: 0 };
  }

  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const name of entries) {
    // 只处理本缓存自己生成的文件（`<sha256 前 32 位>.<ext>`），别的东西一律不动。
    if (!/^[0-9a-f]{32}\.[a-z0-9]+$/i.test(name)) continue;
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }

  // 最旧的排在前面：先按年龄删，再按体积删，都是「先删最可能不再需要的」。
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const deletable = files.filter((file) => now - file.mtimeMs > RECENT_GRACE_MS);

  let keptBytes = files.reduce((sum, file) => sum + file.size, 0);
  let keptFiles = files.length;
  let removed = 0;
  let freedBytes = 0;

  const drop = async (file: { path: string; size: number }): Promise<void> => {
    const ok = await unlink(file.path).then(() => true, () => false);
    if (!ok) return;
    removed += 1;
    freedBytes += file.size;
    keptBytes -= file.size;
    keptFiles -= 1;
  };

  for (const file of deletable) {
    if (now - file.mtimeMs <= maxAgeMs) continue;
    await drop(file);
  }
  for (const file of deletable) {
    if (keptBytes <= maxBytes) break;
    // 上面可能已经删过它（按年龄）：`stat` 不会再成功，这里靠 keptBytes 兜住。
    if (now - file.mtimeMs > maxAgeMs) continue;
    await drop(file);
  }

  return { removed, freedBytes, keptBytes, keptFiles };
}
