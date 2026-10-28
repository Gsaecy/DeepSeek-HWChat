import assert from 'node:assert/strict';
import test from 'node:test';
import { SearchQueueFullError, SearchResourceBusyError, SearchScheduler } from '../agent/searchScheduler';
import { OperationCancelledError } from '../agent/transientErrors';

/**
 * 调度层测试。
 *
 * 每条用例都统计**真实的后端调用次数与峰值并发**，不靠日志文字：
 * 「日志里写着已排队」和「确实只跑了一次」是两件事，前者不能证明限流生效。
 */

interface Params {
  id: string;
}

/** 手动控制何时完成的 Promise，用来精确构造「正在执行 / 排队中」的状态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildScheduler(options: {
  maxConcurrent?: number;
  maxQueue?: number;
  cacheTtlMs?: number;
  retryDelaysMs?: number[];
  run: (params: Params, context: { signal: AbortSignal; attempt: number }) => Promise<{ files: string[]; truncated: boolean }>;
}) {
  return new SearchScheduler<Params, string>({
    run: options.run,
    maxConcurrent: options.maxConcurrent,
    maxQueue: options.maxQueue,
    cacheTtlMs: options.cacheTtlMs,
    retryDelaysMs: options.retryDelaysMs ?? [1, 2, 3],
    pressureCooldownMs: 0,
  });
}

test('search scheduler: ten identical concurrent requests collapse into one real search', async () => {
  let calls = 0;
  const gate = deferred<void>();
  const subject = buildScheduler({
    async run() {
      calls += 1;
      await gate.promise;
      return { files: ['a.ts'], truncated: false };
    },
  });

  const pending = Array.from({ length: 10 }, () => subject.run({ id: 'same' }, 'same-key'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  gate.resolve();
  const results = await Promise.all(pending);

  assert.equal(calls, 1, '相同参数只能真正搜索一次');
  assert.equal(results.length, 10);
  for (const result of results) assert.deepEqual(result.outcome.files, ['a.ts']);
  assert.equal(subject.stats().deduped, 9);
  assert.equal(subject.stats().completed, 1);
});

test('search scheduler: active searches never exceed the configured limit', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const subject = buildScheduler({
    maxConcurrent: 2,
    async run(params: Params) {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { files: [params.id], truncated: false };
    },
  });

  await Promise.all(Array.from({ length: 8 }, (_, index) => subject.run({ id: String(index) }, `k${index}`)));

  assert.equal(calls, 8);
  assert.equal(peak, 2, `峰值并发应为 2，实际 ${peak}`);
  assert.equal(subject.stats().active, 0);
  assert.equal(subject.stats().queued, 0);
});

test('search scheduler: the queue has a hard capacity and rejects instead of piling up', async () => {
  const gate = deferred<void>();
  const subject = buildScheduler({
    maxConcurrent: 1,
    maxQueue: 2,
    async run() {
      await gate.promise;
      return { files: [], truncated: false };
    },
  });

  const running = subject.run({ id: 'run' }, 'run');
  const queuedA = subject.run({ id: 'a' }, 'a');
  const queuedB = subject.run({ id: 'b' }, 'b');
  await assert.rejects(subject.run({ id: 'overflow' }, 'overflow'), SearchQueueFullError);
  assert.equal(subject.stats().rejected, 1);

  gate.resolve();
  await Promise.all([running, queuedA, queuedB]);
});

test('search scheduler: cancelling a queued search means it is never executed', async () => {
  const gate = deferred<void>();
  const executed: string[] = [];
  const subject = buildScheduler({
    maxConcurrent: 1,
    async run(params: Params) {
      executed.push(params.id);
      if (params.id === 'first') await gate.promise;
      return { files: [], truncated: false };
    },
  });

  const first = subject.run({ id: 'first' }, 'first');
  const controller = new AbortController();
  const cancelled = subject.run({ id: 'never' }, 'never', { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, OperationCancelledError);

  gate.resolve();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(executed, ['first'], '被取消的排队任务不得在稍后偷偷执行');
  assert.equal(subject.stats().cancelled, 1);
});

test('search scheduler: cancelling a running search releases its slot for the next request', async () => {
  let aborted = false;
  const started: string[] = [];
  const subject = buildScheduler({
    maxConcurrent: 1,
    run(params: Params, context: { signal: AbortSignal }) {
      started.push(params.id);
      if (params.id === 'slow') {
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new OperationCancelledError());
          }, { once: true });
        });
      }
      return Promise.resolve({ files: ['done'], truncated: false });
    },
  });

  const controller = new AbortController();
  const slow = subject.run({ id: 'slow' }, 'slow', { signal: controller.signal });
  const next = subject.run({ id: 'next' }, 'next');
  controller.abort();

  await assert.rejects(slow, OperationCancelledError);
  const nextResult = await next;
  assert.equal(aborted, true, '运行中的搜索必须收到取消信号');
  assert.deepEqual(started, ['slow', 'next'], '取消后并发名额必须立刻释放');
  assert.deepEqual(nextResult.outcome.files, ['done']);
});

test('search scheduler: a cancelled request does not cancel other waiters on the same search', async () => {
  const gate = deferred<void>();
  let calls = 0;
  const subject = buildScheduler({
    async run() {
      calls += 1;
      await gate.promise;
      return { files: ['shared'], truncated: false };
    },
  });

  const controller = new AbortController();
  const cancelled = subject.run({ id: 'shared' }, 'same', { signal: controller.signal });
  const survivor = subject.run({ id: 'shared' }, 'same');
  controller.abort();
  await assert.rejects(cancelled, OperationCancelledError);
  gate.resolve();
  const result = await survivor;
  assert.deepEqual(result.outcome.files, ['shared']);
  assert.equal(calls, 1);
});

test('search scheduler: cached results are returned only until invalidation', async () => {
  let version = 1;
  let calls = 0;
  const subject = buildScheduler({
    cacheTtlMs: 60_000,
    async run() {
      calls += 1;
      return { files: [`file-v${version}.ts`], truncated: false };
    },
  });

  const first = await subject.run({ id: 'cached' }, 'cached');
  assert.deepEqual(first.outcome.files, ['file-v1.ts']);
  assert.equal(first.cached, false);

  const second = await subject.run({ id: 'cached' }, 'cached');
  assert.equal(second.cached, true);
  assert.equal(calls, 1);

  // 模拟「文件写入了」：缓存必须立刻失效，绝不返回过期内容。
  version = 2;
  subject.invalidate();
  const third = await subject.run({ id: 'cached' }, 'cached');
  assert.deepEqual(third.outcome.files, ['file-v2.ts']);
  assert.equal(calls, 2);
});

test('search scheduler: a failed search does not poison the queue', async () => {
  let attempts = 0;
  const subject = buildScheduler({
    async run() {
      attempts += 1;
      if (attempts === 1) throw new Error('ENOENT: no such directory');
      return { files: ['ok.ts'], truncated: false };
    },
  });

  await assert.rejects(subject.run({ id: 'fails' }, 'fails'), /ENOENT/);
  const recovered = await subject.run({ id: 'fails' }, 'fails');
  assert.deepEqual(recovered.outcome.files, ['ok.ts']);
  assert.equal(subject.stats().failed, 1);
  assert.equal(subject.stats().active, 0);
});

test('search scheduler: EAGAIN is retried with bounded backoff and then recovers', async () => {
  let calls = 0;
  const subject = buildScheduler({
    retryDelaysMs: [1, 2, 3],
    async run() {
      calls += 1;
      if (calls <= 2) {
        const error = new Error('spawn /Applications/Visual Studio Code.app/.../rg EAGAIN') as Error & { code: string };
        error.code = 'EAGAIN';
        throw error;
      }
      return { files: ['recovered.ts'], truncated: false };
    },
  });

  const result = await subject.run({ id: 'retry' }, 'retry');
  assert.deepEqual(result.outcome.files, ['recovered.ts']);
  assert.equal(calls, 3, '两次 EAGAIN 后第三次成功');
  assert.equal(result.attempts, 3);
  assert.equal(subject.stats().retries, 2);
});

test('search scheduler: persistent EAGAIN stops after three retries with an actionable error', async () => {
  let calls = 0;
  const subject = buildScheduler({
    retryDelaysMs: [1, 2, 3],
    async run() {
      calls += 1;
      const error = new Error('spawn rg EAGAIN') as Error & { code: string };
      error.code = 'EAGAIN';
      throw error;
    },
  });

  await assert.rejects(subject.run({ id: 'dead' }, 'dead'), SearchResourceBusyError);
  // 首次 + 3 次重试 = 4 次，之后必须放弃（否则就是无限快速重试）。
  assert.equal(calls, 4);
  assert.equal(subject.stats().retries, 3);
});

test('search scheduler: non-resource errors are never retried', async () => {
  let calls = 0;
  const subject = buildScheduler({
    retryDelaysMs: [1, 2, 3],
    async run() {
      calls += 1;
      throw new Error('Invalid glob pattern');
    },
  });

  await assert.rejects(subject.run({ id: 'bad' }, 'bad'), /Invalid glob/);
  assert.equal(calls, 1, '普通错误重试只会浪费资源');
});

test('search scheduler: no further retry happens after cancellation', async () => {
  let calls = 0;
  const subject = buildScheduler({
    retryDelaysMs: [50, 50, 50],
    async run() {
      calls += 1;
      const error = new Error('EAGAIN') as Error & { code: string };
      error.code = 'EAGAIN';
      throw error;
    },
  });

  const controller = new AbortController();
  const pending = subject.run({ id: 'cancel-retry' }, 'cancel-retry', { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, OperationCancelledError);
  const callsAtCancel = calls;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls, callsAtCancel, '取消之后不允许再有重试');
});

test('search scheduler: dispose cancels everything that is still queued or running', async () => {
  const subject = buildScheduler({
    maxConcurrent: 1,
    run() {
      return new Promise(() => undefined);
    },
  });

  const running = subject.run({ id: 'running' }, 'running');
  const queued = subject.run({ id: 'queued' }, 'queued');
  subject.dispose();

  assert.equal(subject.stats().queued, 0);
  // 每个等待者都必须被结算，否则调用方会永远挂着。
  await assert.rejects(running, OperationCancelledError);
  await assert.rejects(queued, OperationCancelledError);
  await assert.rejects(subject.run({ id: 'after' }, 'after'));
});
