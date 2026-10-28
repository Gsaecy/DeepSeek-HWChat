/**
 * 文件搜索的统一调度层。
 *
 * 为什么需要它（真实故障链）：
 * - `search_files` / `list_files` 每次都直接调 `vscode.workspace.findFiles`，
 *   VS Code 的文件搜索会为**每次调用**启动 ripgrep 子进程；多根工作区里
 *   代码还会逐根循环，一次工具调用就能拉起十几个 rg。
 * - 这些调用既没有并发上限、也没有去重和缓存：同一轮里模型连发几次同样的
 *   搜索，就是几十个 rg；步数不设上限时能一直堆下去。
 * - 进程/线程耗尽后内核返回 `spawn … rg EAGAIN`，而旧代码把失败原样丢回
 *   模型，模型立刻换个措辞重试，形成正反馈，最终把 CPU 和进程表一起打满。
 *
 * 这一层提供四件事：
 * 1. **并发上限**：活动搜索默认 1 个（可在基准测试证明必要后调大）。
 * 2. **single-flight 去重**：相同参数（同一 key）的并发请求合并成一次真实搜索。
 * 3. **短期缓存 + 显式失效**：文件写入/保存/删除后由调用方 invalidate，绝不长期用旧结果。
 * 4. **有上限的退避重试**：只对 EAGAIN 一类资源错误重试，且退避期间把并发压到 1。
 *
 * 队列有容量上限；超过容量直接拒绝，而不是无限堆积任务。
 */

import {
  DEFAULT_TRANSIENT_RETRY_DELAYS_MS,
  OperationCancelledError,
  describeTransientResourceError,
  sleep,
  throwIfAborted,
} from './transientErrors';

export interface SearchOutcome<TFile> {
  files: TFile[];
  truncated: boolean;
}

export interface SearchRunContext {
  signal: AbortSignal;
  /** 第几次尝试，从 1 开始。 */
  attempt: number;
}

export type SearchRunner<TParams, TFile> = (
  params: TParams,
  context: SearchRunContext,
) => Promise<SearchOutcome<TFile>>;

export interface SearchCallResult<TFile> {
  outcome: SearchOutcome<TFile>;
  cached: boolean;
  queueWaitMs: number;
  durationMs: number;
  attempts: number;
}

export interface SearchSchedulerStats {
  active: number;
  queued: number;
  inFlight: number;
  cacheSize: number;
  completed: number;
  failed: number;
  cancelled: number;
  deduped: number;
  retries: number;
  rejected: number;
}

export type SearchSchedulerEvent =
  | { type: 'retry'; key: string; attempt: number; code: string; delayMs: number }
  | { type: 'rejected'; key: string; queued: number }
  | { type: 'cancelled'; key: string; started: boolean };

export interface SearchSchedulerOptions<TParams, TFile> {
  run: SearchRunner<TParams, TFile>;
  /** 活动搜索上限，默认 1。 */
  maxConcurrent?: number;
  /** 等待队列容量，默认 24；满了直接拒绝。 */
  maxQueue?: number;
  /** 成功后结果的缓存时长，默认 1.5 秒。 */
  cacheTtlMs?: number;
  /** 重试间隔；长度即最大重试次数，默认 3 次（200/600/1500ms）。 */
  retryDelaysMs?: readonly number[];
  /** 资源紧张后的冷却时间，期间并发固定为 1。 */
  pressureCooldownMs?: number;
  now?: () => number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onEvent?: (event: SearchSchedulerEvent) => void;
}

export class SearchQueueFullError extends Error {
  readonly code = 'SEARCH_QUEUE_FULL';

  constructor(readonly queued: number, readonly capacity: number) {
    super(`Search queue is full (${queued}/${capacity}).`);
    this.name = 'SearchQueueFullError';
  }
}

export class SearchResourceBusyError extends Error {
  readonly code = 'SEARCH_RESOURCE_BUSY';

  constructor(readonly resourceCode: string, readonly attempts: number, message: string) {
    super(message);
    this.name = 'SearchResourceBusyError';
  }
}

interface CacheEntry<TFile> {
  outcome: SearchOutcome<TFile>;
  at: number;
}

interface Waiter<TFile> {
  resolve: (value: SearchCallResult<TFile>) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface SearchTask<TParams, TFile> {
  key: string;
  params: TParams;
  controller: AbortController;
  waiters: Set<Waiter<TFile>>;
  queuedAt: number;
  startedAt?: number;
  started: boolean;
  settled: boolean;
}

export class SearchScheduler<TParams, TFile> {
  private readonly runner: SearchRunner<TParams, TFile>;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly cacheTtlMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly pressureCooldownMs: number;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly onEvent?: (event: SearchSchedulerEvent) => void;

  private readonly queue: Array<SearchTask<TParams, TFile>> = [];
  private readonly inFlight = new Map<string, SearchTask<TParams, TFile>>();
  private readonly cache = new Map<string, CacheEntry<TFile>>();
  private active = 0;
  private pressureUntil = 0;
  private disposed = false;
  private readonly counters: SearchSchedulerStats = {
    active: 0,
    queued: 0,
    inFlight: 0,
    cacheSize: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    deduped: 0,
    retries: 0,
    rejected: 0,
  };

  constructor(options: SearchSchedulerOptions<TParams, TFile>) {
    this.runner = options.run;
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 1));
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? 24));
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 1_500);
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS;
    this.pressureCooldownMs = Math.max(0, options.pressureCooldownMs ?? 5_000);
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.onEvent = options.onEvent;
  }

  /**
   * 提交一次搜索。`key` 必须完整编码搜索参数（含工作区根），
   * 否则不同参数的请求会被错误合并。
   */
  async run(params: TParams, key: string, options: { signal?: AbortSignal } = {}): Promise<SearchCallResult<TFile>> {
    if (this.disposed) throw new Error('Search scheduler disposed.');
    throwIfAborted(options.signal);

    const cached = this.readCache(key);
    if (cached) return cached;

    const existing = this.inFlight.get(key);
    if (existing) {
      this.counters.deduped += 1;
      return this.attach(existing, options.signal);
    }

    if (this.queue.length >= this.maxQueue) {
      this.counters.rejected += 1;
      this.emit({ type: 'rejected', key, queued: this.queue.length });
      throw new SearchQueueFullError(this.queue.length, this.maxQueue);
    }

    const task: SearchTask<TParams, TFile> = {
      key,
      params,
      controller: new AbortController(),
      waiters: new Set(),
      queuedAt: this.now(),
      started: false,
      settled: false,
    };
    this.inFlight.set(key, task);
    const promise = this.attach(task, options.signal);
    this.queue.push(task);
    this.schedule();
    return promise;
  }

  /** 丢弃全部缓存（文件写入 / 保存 / 删除 / 重命名后必须调用）。 */
  invalidate(): void {
    this.cache.clear();
  }

  stats(): SearchSchedulerStats {
    return {
      ...this.counters,
      active: this.active,
      queued: this.queue.length,
      inFlight: this.inFlight.size,
      cacheSize: this.cache.size,
    };
  }

  /**
   * 取消所有排队与活动搜索（扩展停用 / 工作区关闭）。
   *
   * 每个等待者都必须收到拒绝：只清空队列而不结算 Promise，会让调用方
   * （Agent 的 tool 调用）永远挂着——这本身就是一次「卡死」。
   */
  dispose(): void {
    this.disposed = true;
    for (const task of this.queue.splice(0)) this.cancelTask(task);
    for (const task of [...this.inFlight.values()]) this.cancelTask(task);
  }

  private readCache(key: string): SearchCallResult<TFile> | undefined {
    if (this.cacheTtlMs <= 0) return undefined;
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.cacheTtlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return {
      outcome: { files: [...entry.outcome.files], truncated: entry.outcome.truncated },
      cached: true,
      queueWaitMs: 0,
      durationMs: 0,
      attempts: 0,
    };
  }

  private attach(task: SearchTask<TParams, TFile>, signal?: AbortSignal): Promise<SearchCallResult<TFile>> {
    return new Promise<SearchCallResult<TFile>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new OperationCancelledError());
        return;
      }
      const waiter: Waiter<TFile> = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          if (!task.waiters.delete(waiter)) return;
          reject(new OperationCancelledError());
          // 只有「没有任何人还想要这个结果」时才真正取消任务：
          // 否则一个调用方取消会连带把共享同一 key 的其他调用方一起打断。
          if (task.waiters.size === 0 && !task.settled) this.cancelTask(task);
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      task.waiters.add(waiter);
    });
  }

  private cancelTask(task: SearchTask<TParams, TFile>): void {
    if (task.settled) return;
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    task.settled = true;
    this.inFlight.delete(task.key);
    this.counters.cancelled += 1;
    this.emit({ type: 'cancelled', key: task.key, started: task.started });
    for (const waiter of task.waiters) {
      this.detach(waiter);
      waiter.reject(new OperationCancelledError());
    }
    task.waiters.clear();
    // 已经开始执行的搜索：只能中止等待，真正取消由 backend 的 signal 处理。
    task.controller.abort();
  }

  private effectiveConcurrency(): number {
    // 资源紧张冷却期内强制串行：宁可慢一点，也不要继续抢进程。
    return this.now() < this.pressureUntil ? 1 : this.maxConcurrent;
  }

  private schedule(): void {
    if (this.disposed) return;
    while (this.queue.length > 0 && this.active < this.effectiveConcurrency()) {
      const task = this.queue.shift();
      if (!task) return;
      if (task.settled) continue;
      task.started = true;
      task.startedAt = this.now();
      this.active += 1;
      this.counters.active = this.active;
      void this.execute(task);
    }
    this.counters.queued = this.queue.length;
    this.counters.active = this.active;
  }

  private async execute(task: SearchTask<TParams, TFile>): Promise<void> {
    let attempts = 0;
    try {
      for (;;) {
        attempts += 1;
        try {
          const outcome = await this.runner(task.params, { signal: task.controller.signal, attempt: attempts });
          if (task.controller.signal.aborted) throw new OperationCancelledError();
          if (!task.settled) {
            this.cache.set(task.key, { outcome, at: this.now() });
            this.settle(task, {
              outcome,
              cached: false,
              queueWaitMs: (task.startedAt ?? task.queuedAt) - task.queuedAt,
              durationMs: this.now() - (task.startedAt ?? this.now()),
              attempts,
            });
          }
          return;
        } catch (error) {
          if (task.controller.signal.aborted) throw new OperationCancelledError();
          const transient = describeTransientResourceError(error);
          if (!transient) throw error;
          if (attempts > this.retryDelaysMs.length) {
            throw new SearchResourceBusyError(transient.code, attempts, transient.message);
          }
          const delayMs = this.retryDelaysMs[attempts - 1] ?? 0;
          this.pressureUntil = this.now() + this.pressureCooldownMs;
          this.counters.retries += 1;
          this.emit({ type: 'retry', key: task.key, attempt: attempts, code: transient.code, delayMs });
          await this.sleepImpl(delayMs, task.controller.signal);
        }
      }
    } catch (error) {
      if (!task.settled) this.fail(task, error);
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.counters.active = this.active;
      this.schedule();
    }
  }

  private settle(task: SearchTask<TParams, TFile>, result: SearchCallResult<TFile>): void {
    task.settled = true;
    this.inFlight.delete(task.key);
    this.counters.completed += 1;
    for (const waiter of task.waiters) {
      this.detach(waiter);
      waiter.resolve({
        ...result,
        outcome: { files: [...result.outcome.files], truncated: result.outcome.truncated },
      });
    }
    task.waiters.clear();
  }

  private fail(task: SearchTask<TParams, TFile>, error: unknown): void {
    task.settled = true;
    this.inFlight.delete(task.key);
    if (error instanceof OperationCancelledError) this.counters.cancelled += 1;
    else this.counters.failed += 1;
    for (const waiter of task.waiters) {
      this.detach(waiter);
      waiter.reject(error);
    }
    task.waiters.clear();
  }

  private detach(waiter: Waiter<TFile>): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.onAbort = undefined;
  }

  private emit(event: SearchSchedulerEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // 诊断回调永远不能影响搜索本身。
    }
  }
}
