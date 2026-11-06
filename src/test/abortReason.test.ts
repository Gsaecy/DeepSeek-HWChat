/**
 * 「这一轮是怎么结束的」。
 *
 * 现场（用户 2026-11-06，面板原样显示）：`请求失败：aborted`
 * —— 没有可操作信息，日志里那一刻也一行都没有。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAbort, isAbortLikeError } from '../agent/abortReason';

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
  assert.equal(isAbortLikeError(named('TypeError', 'terminated')), false);
  assert.equal(isAbortLikeError(undefined), false);
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
