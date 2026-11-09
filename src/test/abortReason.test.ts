/**
 * 「这一轮是怎么结束的」。
 *
 * 现场（用户 2026-11-06，面板原样显示）：`请求失败：aborted`
 * —— 没有可操作信息，日志里那一刻也一行都没有。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAbort, isAbortLikeError, isTransportDropError } from '../agent/abortReason';

function named(name: string, message = '', cause?: unknown): Error {
  const error = new Error(message);
  error.name = name;
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause;
  return error;
}

test('认得出 fetch 的 AbortError / TimeoutError', () => {
  assert.equal(isAbortLikeError(named('AbortError', 'This operation was aborted')), true);
  assert.equal(isAbortLikeError(named('TimeoutError', 'The operation was aborted due to timeout')), true);
});

test('认得出我们等待辅助函数 reject 的 Error("aborted")', () => {
  assert.equal(isAbortLikeError(new Error('aborted')), true);
});

test('认得出被当作 abort 原因传出去的字符串', () => {
  assert.equal(isAbortLikeError('aborted'), true);
  assert.equal(isAbortLikeError('  ABORTED  '), true);
});

test('cause 链里嵌着的也算（包装器常常只改外层消息）', () => {
  assert.equal(isAbortLikeError(named('Error', 'fetch failed', named('AbortError', 'aborted'))), true);
});

test('不把「消息里出现 abort 字样」的业务错误误判成中止', () => {
  assert.equal(isAbortLikeError(new Error('abort 按钮的样式没生效')), false);
  assert.equal(isAbortLikeError(new Error('aborted by policy: 该文件被保护')), false);
  assert.equal(isAbortLikeError(undefined), false);
});

test('undici 的 terminated / other side closed 算连接被掐断（可续），不算业务错误', () => {
  /*
   * 这条以前断言的是 `false` —— 那是错的。
   *
   * 现场（用户 2026-11-09 14:03）：一次完全正常的运行中途弹出
   * 「请求失败：terminated」，agent 停下。`terminated` 是 undici 在 socket
   * 被对端提前关闭时抛的通用错误，字面上什么都没说。
   * 它属于「连接被掐断」：内容、步骤、未执行的消息都还在，回一句继续就能接着做。
   */
  assert.equal(isAbortLikeError(named('TypeError', 'terminated')), true);
  assert.equal(isAbortLikeError(named('Error', 'other side closed')), true);
  assert.equal(isAbortLikeError(named('Error', 'socket hang up')), true);
  assert.equal(isTransportDropError(named('TypeError', 'terminated')), true);
  // 挂在 cause 上的一样要认出来（undici 把真原因放在 cause 里）。
  const wrapped = Object.assign(new Error('fetch failed'), { cause: named('Error', 'other side closed') });
  assert.equal(isAbortLikeError(wrapped), true);
  // 只是「消息里出现 terminated 这个词」的业务错误不认。
  assert.equal(isAbortLikeError(new Error('task terminated by user policy')), false);
});

test('有取消信号且没有超时特征 → 用户停止', () => {
  assert.equal(classifyAbort(named('AbortError', 'aborted'), true), 'user');
});

test('超时特征优先于用户停止', () => {
  assert.equal(classifyAbort(named('TimeoutError', 'The operation was aborted due to timeout'), false), 'timeout');
  assert.equal(classifyAbort(new Error('请求超时（120 秒）'), false), 'timeout');
});

test('没有取消信号也不是超时 → 连接被断开', () => {
  assert.equal(classifyAbort(new Error('aborted'), false), 'network');
});

test('循环 cause 不会把判定卡死', () => {
  const a = new Error('outer');
  (a as { cause?: unknown }).cause = a;
  assert.equal(isAbortLikeError(a), false);
});

/* ── 「卡住」必须和「断网」分开 ───────────────────────────────────── */

test('StreamStalledError 判成 stalled（不是 network）', () => {
  const error = Object.assign(new Error('stalled:awaiting-response:120'), {
    name: 'StreamStalledError',
    seconds: 120,
  });
  assert.equal(classifyAbort(error, false), 'stalled');
});

test('用户主动停止仍然是 user（即使错误形状像卡住）', () => {
  const error = Object.assign(new Error('stalled:mid-stream:120'), { name: 'StreamStalledError' });
  assert.equal(classifyAbort(error, true), 'user');
});

test('「卡住」算中断（isAbortLikeError），不会被当成请求失败', () => {
  /*
   * 用户 2026-11-09：运行到 1.03M tokens 时被判「卡住」，界面显示
   * 「请求失败：等待 120 秒没有收到新数据」。它不是失败 —— 已经收到的内容还在，
   * 队列里没跑的消息也还在，用户续一句就能继续。把它归成失败会让人以为白干了。
   */
  const error = Object.assign(new Error('stalled:mid-stream:120'), { name: 'StreamStalledError' });
  assert.equal(isAbortLikeError(error), true);
});

test('普通网络错误不会被误判成 stalled', () => {
  const error = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  assert.equal(classifyAbort(error, false), 'network');
});
