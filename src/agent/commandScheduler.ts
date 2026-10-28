/**
 * 终端命令的有界调度。
 *
 * 搜索和命令是两种不同的资源：搜索会拉起 ripgrep，命令会拉起任意进程树。
 * 用同一个很小的全局并发值去卡所有操作，会让「一边跑构建、一边查文件」这种
 * 完全无关的任务互相堵死，所以这里给命令单独一个闸门：
 *
 * - 并发上限（默认 2）：多线程对话同时跑命令时，不至于一次 fork 出几十个进程；
 * - 队列容量（默认 8）：满了直接拒绝，而不是无限堆积；
 * - 取消优先：排队中被取消的任务绝不会稍后偷偷执行。
 */

import { OperationCancelledError, throwIfAborted } from './transientErrors';

export interface WaitingTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface CommandSchedulerStats {
  active: number;
  queued: number;
  completed: number;
  cancelled: number;
  rejected: number;
}

export class CommandQueueFullError extends Error {
  readonly code = 'COMMAND_QUEUE_FULL';

  constructor(readonly queued: number, readonly capacity: number) {
    super(`Command queue is full (${queued}/${capacity}).`);
    this.name = 'CommandQueueFullError';
  }
}

export class CommandScheduler {
  private readonly queue: Array<WaitingTask<unknown>> = [];
  private active = 0;
  private disposed = false;
  private pressureUntil = 0;
  private readonly counters = { completed: 0, cancelled: 0, rejected: 0 };

  constructor(
    private readonly maxConcurrent = 2,
    private readonly maxQueue = 8,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 资源紧张（例如 `spawn … EAGAIN`）后的冷却。
   *
   * 只靠「单条命令自己退避重试」不够：另一条排队命令会立刻拿走释放出的并发
   * 名额，继续抢进程，EAGAIN 就会连成一片。冷却期内把并发压到 1，先把已经
   * 在跑的命令跑完，再放新的进来。与 `SearchScheduler` 的压力冷却同一口径。
   */
  markResourcePressure(cooldownMs: number): void {
    this.pressureUntil = Math.max(this.pressureUntil, this.now() + Math.max(0, cooldownMs));
  }

  private effectiveConcurrency(): number {
    return this.now() < this.pressureUntil ? 1 : this.maxConcurrent;
  }

  run<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new OperationCancelledError('Command scheduler disposed.'));
    throwIfAborted(signal);
    if (this.active < this.effectiveConcurrency()) {
      return this.start(run);
    }
    if (this.queue.length >= this.maxQueue) {
      this.counters.rejected += 1;
      return Promise.reject(new CommandQueueFullError(this.queue.length, this.maxQueue));
    }
    return new Promise<T>((resolve, reject) => {
      const task: WaitingTask<T> = {
        run,
        resolve,
        reject,
        signal,
      };
      if (signal) {
        task.onAbort = () => {
          const index = this.queue.indexOf(task as unknown as WaitingTask<unknown>);
          if (index >= 0) this.queue.splice(index, 1);
          this.counters.cancelled += 1;
          reject(new OperationCancelledError());
        };
        signal.addEventListener('abort', task.onAbort, { once: true });
      }
      this.queue.push(task as unknown as WaitingTask<unknown>);
    });
  }

  stats(): CommandSchedulerStats {
    return {
      ...this.counters,
      active: this.active,
      queued: this.queue.length,
    };
  }

  /** 取消所有排队任务；已经在跑的命令由调用方通过各自的 abort 终止。 */
  dispose(): void {
    this.disposed = true;
    for (const task of this.queue.splice(0)) {
      this.detach(task);
      task.reject(new OperationCancelledError('Command scheduler disposed.'));
    }
  }

  private async start<T>(run: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      const value = await run();
      this.counters.completed += 1;
      return value;
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.drain();
    }
  }

  private drain(): void {
    while (!this.disposed && this.active < this.effectiveConcurrency() && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.detach(next);
      if (next.signal?.aborted) {
        this.counters.cancelled += 1;
        next.reject(new OperationCancelledError());
        continue;
      }
      this.active += 1;
      void next.run().then(
        (value) => {
          this.counters.completed += 1;
          next.resolve(value);
        },
        (error) => next.reject(error),
      ).finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.drain();
      });
    }
  }

  private detach(task: WaitingTask<unknown>): void {
    if (task.signal && task.onAbort) task.signal.removeEventListener('abort', task.onAbort);
    task.onAbort = undefined;
  }
}
