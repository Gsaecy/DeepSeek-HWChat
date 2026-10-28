/**
 * 命令输出累积器的回归与 A/B 基准。
 *
 * 真实故障形态：命令很「话多」（watch 模式、dev server、详细测试输出），每个
 * data 事件都要把整个已累积缓冲区重新拼一遍、再 `Buffer.byteLength` 全量编码
 * 一次。留 200KB 输出时，每秒上千个 chunk 就是每秒几百 MB 的无谓拷贝，
 * Extension Host 直接 100%，而命令本身几乎不占 CPU。
 *
 * 这里同时钉住两件事：
 * 1. 语义：保留内容与旧的 `truncate` 一致（开头 75%），总量按全部输出记账；
 * 2. 成本：同样 2 万个 chunk，新实现必须比旧写法快一个数量级（阈值取得很松，
 *    只用来证明「不再随缓冲区大小线性变慢」，不当作精确基准）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendBoundedText, EMPTY_BOUNDED_TEXT, renderBoundedText, spawnCommand } from '../agent/toolExecutor';

const CAP = 200_000;

/** 旧实现的等价物：每个 chunk 都重拼 + 全量字节编码。 */
function legacyAppend(current: string, chunk: string, maxBytes: number): string {
  const value = `${current}${chunk}`;
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = value.slice(0, Math.max(1, Math.floor(maxBytes * 0.75)));
  while (Buffer.byteLength(result) > maxBytes - 80) result = result.slice(0, -256);
  return `… [输出已截断，原始大小 ${Buffer.byteLength(value).toLocaleString()} 字节]\n${result}`;
}

test('bounded output: below the cap the text is kept verbatim', () => {
  let buffer = EMPTY_BOUNDED_TEXT;
  buffer = appendBoundedText(buffer, 'hello ', CAP);
  buffer = appendBoundedText(buffer, 'world', CAP);

  assert.equal(buffer.text, 'hello world');
  assert.equal(buffer.bytes, Buffer.byteLength('hello world'));
  assert.equal(buffer.totalBytes, Buffer.byteLength('hello world'));
  assert.equal(buffer.truncated, false);
  assert.equal(renderBoundedText(buffer), 'hello world');
});

test('bounded output: overflowing keeps the head, records the real total, and renders one notice', () => {
  let buffer = EMPTY_BOUNDED_TEXT;
  const chunk = 'x'.repeat(1_000);
  for (let index = 0; index < 500; index += 1) buffer = appendBoundedText(buffer, chunk, CAP);

  assert.equal(buffer.truncated, true);
  assert.equal(buffer.totalBytes, 500_000, '总量必须按收到的全部字节记账');
  assert.ok(buffer.bytes <= CAP, `保留部分不得超过上限（实际 ${buffer.bytes}）`);
  assert.equal(buffer.text, 'x'.repeat(buffer.text.length), '保留的应是输出开头');
  const rendered = renderBoundedText(buffer);
  assert.match(rendered, /截断|truncated/);
  assert.match(rendered, /500,000|500000/);
});

test('bounded output: once truncated, later chunks are counted but never accumulated', () => {
  let buffer = EMPTY_BOUNDED_TEXT;
  buffer = appendBoundedText(buffer, 'a'.repeat(CAP), CAP);
  buffer = appendBoundedText(buffer, 'b'.repeat(10), CAP);
  const afterFirstOverflow = buffer.text;
  const bytesAfterOverflow = buffer.bytes;

  for (let index = 0; index < 50_000; index += 1) buffer = appendBoundedText(buffer, 'c'.repeat(1_000), CAP);

  assert.equal(buffer.text, afterFirstOverflow, '截断后不得继续拼接（内存与 CPU 都必须是 O(chunk)）');
  assert.equal(buffer.bytes, bytesAfterOverflow);
  assert.equal(buffer.totalBytes, CAP + 10 + 50_000_000);
});

test('bounded output: multibyte text never exceeds the byte cap', () => {
  let buffer = EMPTY_BOUNDED_TEXT;
  const chunk = '中文输出🙂'.repeat(200);
  for (let index = 0; index < 100; index += 1) buffer = appendBoundedText(buffer, chunk, 8_192);

  assert.equal(buffer.truncated, true);
  assert.ok(Buffer.byteLength(buffer.text) <= 8_192, '按字节收边，不能只按字符截断');
  // 不能把代理对切开：否则输出里会留一个孤立代理项（JSON / 终端里显示成乱码）。
  assert.doesNotMatch(buffer.text, /[\uD800-\uDBFF]$/);
});

test('perf A/B: 20k chunks stay flat instead of re-encoding the whole buffer each time', () => {
  const chunk = 'line of command output '.repeat(40);
  const chunks = 20_000;

  let legacy = '';
  const legacyStart = process.hrtime.bigint();
  for (let index = 0; index < chunks; index += 1) legacy = legacyAppend(legacy, chunk, CAP);
  const legacyMs = Number(process.hrtime.bigint() - legacyStart) / 1e6;

  let bounded = EMPTY_BOUNDED_TEXT;
  const boundedStart = process.hrtime.bigint();
  for (let index = 0; index < chunks; index += 1) bounded = appendBoundedText(bounded, chunk, CAP);
  const boundedMs = Number(process.hrtime.bigint() - boundedStart) / 1e6;

  console.log(`# perf A/B output accumulation: legacy=${legacyMs.toFixed(0)}ms bounded=${boundedMs.toFixed(0)}ms over ${chunks} chunks`);
  assert.ok(bounded.bytes <= CAP);
  assert.ok(boundedMs * 5 < legacyMs, `新实现至少应快 5 倍（legacy=${legacyMs.toFixed(1)}ms bounded=${boundedMs.toFixed(1)}ms）`);
});

test('spawn: a chatty command stays bounded and reports the real output size', async () => {
  const cap = 20_000;
  const command = `node -e "const line = 'y'.repeat(1024); for (let i = 0; i < 500; i += 1) process.stdout.write(line)"`;
  const result = await spawnCommand(command, process.cwd(), 30, cap);

  assert.equal(result.code, 0);
  assert.ok(Buffer.byteLength(result.stdout) <= cap + 200, '保留部分必须受上限约束');
  assert.match(result.stdout, /截断|truncated/, '截断时必须告诉模型输出不完整');
  assert.match(result.stdout, /512,000|512000/, '必须报告真实总字节数');
});
