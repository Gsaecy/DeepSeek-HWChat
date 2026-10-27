import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnCommand, shouldReportStall, COMMAND_STALL_REFRESH_SECONDS } from '../agent/toolExecutor';

/**
 * 这组用例守的是一个真实故障，不是假想场景。
 *
 * 现场：Agent 执行 `cargo test --offline 2>&1 | tail -30`，其中一条测试卡在
 * `qlmanage -t`（30 分钟只用了 0.03 秒 CPU）。超时触发后 HWChat 只杀掉了
 * shell，`cargo`、`tail`、`qlmanage` 全部存活并被 init 收养（PPID 变成 1）。
 * 因为它们仍然攥着 stdout 管道，Node 的 `'close'` 事件永不触发，
 * 那次工具调用就永久挂起——界面上一直显示「准备运行命令」。
 *
 * 所以这里断言的不是「命令能跑通」，而是**永远不许挂住**：
 * 只要子进程退出，剩下的不管谁还开着管道，都必须在一个宽限期内结算。
 */

const MAX_OUTPUT = 100_000;

test('孙进程继续攥着 stdout 时，仍然在宽限期后结算（回归：永不挂起的工具调用）', async () => {
  const startedAt = Date.now();
  // `sleep 6 &` 让一个后台进程继承 stdout：shell 立刻退出，但管道写端还没关，
  // 只监听 'close' 的实现会一直等这 6 秒甚至更久。
  const result = await spawnCommand('sleep 6 & echo started', process.cwd(), 30, MAX_OUTPUT);
  const elapsed = (Date.now() - startedAt) / 1000;

  assert.ok(elapsed < 5, `应在宽限期内结算，实际用了 ${elapsed.toFixed(1)} 秒`);
  assert.equal(result.timedOut, false, '这不是超时，是正常退出后管道被孙进程占着');
  assert.match(result.stdout, /started/, '退出前已经产出的输出必须带回来');
});

test('正常命令照常返回退出码与输出', async () => {
  const result = await spawnCommand('echo hi', process.cwd(), 10, MAX_OUTPUT);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /hi/);
});

test('超时会把整个进程组杀掉并结算，timedOut 为 true', async () => {
  const startedAt = Date.now();
  const result = await spawnCommand('sleep 30', process.cwd(), 1, MAX_OUTPUT);
  const elapsed = (Date.now() - startedAt) / 1000;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 8, `超时后应在几秒内结算，实际用了 ${elapsed.toFixed(1)} 秒`);
});

test('stdin 接到 /dev/null：需要输入的命令立刻读到 EOF，不会无限等待', async () => {
  // 旧实现把 stdin 留成一条永远不写入的管道，`cat` 这类命令会一直等输入。
  const startedAt = Date.now();
  const result = await spawnCommand('cat', process.cwd(), 10, MAX_OUTPUT);
  const elapsed = (Date.now() - startedAt) / 1000;

  assert.equal(result.timedOut, false, '应当因为 EOF 自己结束，而不是被超时杀掉');
  assert.ok(elapsed < 5, `应立即结束，实际用了 ${elapsed.toFixed(1)} 秒`);
});

test('运行期会推送进度，界面才有「已运行 N 秒」可显示', async () => {
  const phases: string[] = [];
  await spawnCommand('sleep 2', process.cwd(), 10, MAX_OUTPUT, (progress) => {
    phases.push(progress.phase);
  });
  assert.ok(phases.length > 0, '运行超过 1 秒至少应推送一次进度');
  assert.ok(phases.every((phase) => ['tick', 'stall', 'timeout'].includes(phase)));
});

test('进度回调抛错不会影响命令本身', async () => {
  const result = await spawnCommand('echo safe', process.cwd(), 10, MAX_OUTPUT, () => {
    throw new Error('通知层崩了');
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /safe/);
});

/**
 * 停滞提示的失真是真实踩过的：卡片左边「已运行 43.3 秒」在跳，
 * 右边「已 30 秒无输出」却冻在 30。两个数字对不上，看着像界面又卡了。
 *
 * 这里用纯函数验证刷新节奏，而不是真等 40 秒——那样只能写出没意义的静态断言。
 */
test('停滞提示：30 秒首次触发，之后每 10 秒刷新一次秒数', () => {
  assert.equal(shouldReportStall(29, -1), false, '29 秒还没到阈值');
  assert.equal(shouldReportStall(30, -1), true, '30 秒必须首次提示');

  assert.equal(shouldReportStall(31, 30), false, '刚报过 1 秒，不应重复');
  assert.equal(shouldReportStall(39, 30), false, '9 秒内不重复，避免刷屏');
  assert.equal(shouldReportStall(40, 30), true, '满 10 秒刷新，让秒数跟着涨');
  assert.equal(shouldReportStall(41, 40), false, '刷新后重新计时');
  assert.equal(shouldReportStall(50, 40), true);
});

test('停滞刷新间隔常量与提示阈值一致可用', () => {
  assert.equal(COMMAND_STALL_REFRESH_SECONDS, 10);
  const firstStall = 30;
  assert.equal(shouldReportStall(firstStall + COMMAND_STALL_REFRESH_SECONDS, firstStall), true);
  assert.equal(shouldReportStall(firstStall + COMMAND_STALL_REFRESH_SECONDS - 1, firstStall), false);
});
