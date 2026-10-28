/**
 * 命令调度的资源压力冷却。
 *
 * 现场：一次 `spawn … EAGAIN` 之后，单条命令自己会退避重试，但排队中的另一条
 * 命令会立刻补上空出来的并发名额继续 fork，于是 EAGAIN 连成一片。
 * 这里验证冷却期内并发被压到 1，冷却结束后恢复。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandScheduler } from '../agent/commandScheduler';
import { OperationCancelledError } from '../agent/transientErrors';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function trackedTask(state: { active: number; peak: number }, holdMs = 15) {
  return async (): Promise<string> => {
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    await sleep(holdMs);
    state.active -= 1;
    return 'done';
  };
}

test('commands: resource pressure serialises new commands until the cooldown expires', async () => {
  let now = 1_000;
  const scheduler = new CommandScheduler(2, 8, () => now);
  scheduler.markResourcePressure(5_000);

  const during = { active: 0, peak: 0 };
  await Promise.all([
    scheduler.run(undefined, trackedTask(during)),
    scheduler.run(undefined, trackedTask(during)),
  ]);
  assert.equal(during.peak, 1, '冷却期内不得同时跑两条命令');

  now += 6_000;
  const after = { active: 0, peak: 0 };
  await Promise.all([
    scheduler.run(undefined, trackedTask(after)),
    scheduler.run(undefined, trackedTask(after)),
  ]);
  assert.equal(after.peak, 2, '冷却结束后必须恢复配置的并发度');
});

test('commands: a cancelled task queued under pressure never starts', async () => {
  let now = 1_000;
  const scheduler = new CommandScheduler(1, 8, () => now);
  scheduler.markResourcePressure(5_000);

  let started = 0;
  const first = scheduler.run(undefined, async () => {
    started += 1;
    await sleep(20);
  });
  const controller = new AbortController();
  const queued = scheduler.run(controller.signal, async () => {
    started += 1;
  });
  controller.abort();

  await assert.rejects(queued, OperationCancelledError);
  await first;
  assert.equal(started, 1, '排队中被取消的命令不得执行');
});

test('commands: pressure does not leak after dispose', async () => {
  const scheduler = new CommandScheduler(2, 8);
  scheduler.markResourcePressure(5_000);
  scheduler.dispose();
  await assert.rejects(scheduler.run(undefined, async () => 'never'), OperationCancelledError);
});
