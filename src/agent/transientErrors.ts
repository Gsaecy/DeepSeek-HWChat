/**
 * 暂时性资源错误的统一识别与有上限退避。
 *
 * 背景（真实故障）：在 macOS 上执行 Agent 任务时，VS Code 启动 ripgrep 报
 * `spawn …/rg EAGAIN`。EAGAIN 表示「系统暂时没资源再 fork 一个进程」——
 * 它既不是参数错误也不是权限错误，**立刻原样重试只会继续抢资源**。
 * 旧代码把 search_files 的异常原样丢回模型，模型看到「搜索失败」就会换个
 * 说法再搜一次，于是形成「失败 → 立刻重试 → 更缺资源」的正反馈。
 *
 * 这里的规则：
 * 1. 只把明确的资源类错误当成可重试；语法错误、路径不存在、权限拒绝一律不重试。
 * 2. 重试次数有上限（默认 3 次），间隔递增。
 * 3. 取消（AbortSignal）优先于重试：用户点了停止就不再有任何后续动作。
 */

export interface TransientResourceError {
  /** 归一化后的错误码，例如 EAGAIN。 */
  code: string;
  /** 原始错误信息（已截断），仅用于诊断日志。 */
  message: string;
}

const TRANSIENT_CODES = ['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY'] as const;

const TRANSIENT_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  { code: 'EAGAIN', pattern: /\bEAGAIN\b|resource temporarily unavailable/i },
  { code: 'EMFILE', pattern: /\bEMFILE\b|too many open files/i },
  { code: 'ENFILE', pattern: /\bENFILE\b|file table overflow/i },
  { code: 'ENOMEM', pattern: /\bENOMEM\b|cannot allocate memory|out of memory/i },
  { code: 'EBUSY', pattern: /\bEBUSY\b|resource busy/i },
];

interface ErrorCarrier {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
}

/** 从任意错误对象/字符串里识别暂时性资源错误；不是这类错误时返回 undefined。 */
export function describeTransientResourceError(error: unknown): TransientResourceError | undefined {
  const carrier = (error ?? {}) as ErrorCarrier;
  const rawCode = typeof carrier.code === 'string' ? carrier.code : typeof carrier.errno === 'string' ? carrier.errno : '';
  const normalizedCode = rawCode.toUpperCase();
  if ((TRANSIENT_CODES as readonly string[]).includes(normalizedCode)) {
    return { code: normalizedCode, message: errorMessage(error).slice(0, 300) };
  }
  const message = errorMessage(error);
  for (const candidate of TRANSIENT_PATTERNS) {
    if (candidate.pattern.test(message)) {
      return { code: candidate.code, message: message.slice(0, 300) };
    }
  }
  return undefined;
}

export function isTransientResourceError(error: unknown): boolean {
  return describeTransientResourceError(error) !== undefined;
}

export class OperationCancelledError extends Error {
  readonly code = 'CANCELLED';

  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationCancelledError();
}

/** 可取消的等待：取消时立刻拒绝，不会把计时器留在事件循环里。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperationCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OperationCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface TransientRetryOptions {
  /** 每次重试前的等待时间；长度就是最大重试次数。默认 3 次。 */
  delaysMs?: readonly number[];
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; code: string; delayMs: number }) => void;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [200, 600, 1_500];

/**
 * 执行一次可能因资源不足失败的操做，失败时按固定间隔退避重试。
 *
 * 非暂时性错误立刻抛出；取消时立刻抛出 OperationCancelledError，绝不继续重试。
 */
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<{ value: T; attempts: number }> {
  const delays = options.delaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS;
  const wait = options.sleepImpl ?? sleep;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return { value: await operation(), attempts: attempt };
    } catch (error) {
      throwIfAborted(options.signal);
      const transient = describeTransientResourceError(error);
      if (!transient || attempt > delays.length) throw error;
      const delayMs = delays[attempt - 1] ?? delays[delays.length - 1] ?? 0;
      options.onRetry?.({ attempt, code: transient.code, delayMs });
      await wait(delayMs, options.signal);
      throwIfAborted(options.signal);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as ErrorCarrier).message;
    if (typeof message === 'string') return message;
  }
  return String(error ?? '');
}
