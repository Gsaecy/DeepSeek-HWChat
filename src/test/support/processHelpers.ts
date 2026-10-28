/** 测试辅助：进程存活探测与轮询等待。 */

/** 用 signal 0 探测进程是否存在；EPERM 表示存在但无权限（即仍然存活）。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 轮询直到条件成立或超时；返回条件是否最终成立。 */
export async function sleepUntil(predicate: () => boolean, timeoutMs = 3_000, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}
