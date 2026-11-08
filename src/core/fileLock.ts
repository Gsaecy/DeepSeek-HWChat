import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 跨进程文件锁。
 *
 * 为什么需要（2026-11-08 外部评审 ⑦）：`SingleFlight` 只合并**同一个扩展宿主进程**里的
 * 并发写。开两个 VS Code 窗口就是两个宿主，各自持有一份 manifest 内存快照，
 * 后写覆盖先写 —— 会话会从索引里消失；两个窗口同时跑清理，还可能删掉对方正在
 * 读的 `payloads/`。
 *
 * 实现用 `open(path, 'wx')`（= O_CREAT|O_EXCL），这是 POSIX 与 Windows 上
 * 都能用的原子创建语义，不依赖额外依赖。锁文件里写持有者 token：
 * 释放时先读回内容，只有仍是自己的 token 才删 —— 避免「超时被抢占后又删掉别人的锁」。
 */

export interface LockOptions {
  /** 最多等多久拿锁。0 表示只试一次。 */
  timeoutMs?: number;
  /** 超过这个时长的锁视为陈旧（进程崩溃留下的），允许接管。 */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 尝试拿锁；拿到返回释放函数，拿不到返回 `undefined`。
 *
 * `timeoutMs: 0` 时是非阻塞的「只试一次」，用于「选主」类场景（清理主）。
 */
export async function tryFileLock(lockPath: string, options: LockOptions = {}): Promise<(() => Promise<void>) | undefined> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const staleMs = Math.max(1_000, options.staleMs ?? DEFAULT_STALE_MS);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  await mkdir(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(token, 'utf8');
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = await readFile(lockPath, 'utf8');
          if (current !== token) return; // 已被别人接管：不能删
          await unlink(lockPath);
        } catch {
          /* 锁文件已不在：说明已被清理，正常。 */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // 陈旧锁：进程崩了但文件还在。接管它，否则会永久卡死。
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue; // 刚好被释放，立刻重试
      }
      if (Date.now() >= deadline) return undefined;
      await sleep(20 + Math.random() * 30);
    }
  }
}

/** 拿锁执行；拿不到就抛错（用于「必须串行」的写路径）。 */
export async function withFileLock<T>(lockPath: string, task: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const release = await tryFileLock(lockPath, options);
  if (!release) throw new Error(`拿不到文件锁：${lockPath}`);
  try {
    return await task();
  } finally {
    await release();
  }
}
