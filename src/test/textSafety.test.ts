import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipText,
  hasLoneSurrogate,
  safeSlice,
  sanitizeJsonStrings,
  stripLoneSurrogates,
} from '../core/textSafety';
import { oneLine } from '../core/contextWindow';
import { outcomeOf } from '../core/contextWindow';

/**
 * 「请求体里有半个 emoji → 服务端 JSON 解析失败」的回归测试。
 *
 * 真实故障（用户 2026-11-07）：
 *
 *     请求失败：接口请求失败（400）：Failed to parse the request body as JSON:
 *     messages[0].content: lone leading surrogate in hex escape at line 1 column 39266
 *
 * `messages[0]` 是 system，内容是任务记忆 + 历史摘要 + 自动检索片段，全部由 `slice`
 * 截断而成。一个 emoji 占两个 UTF-16 码元，截在中间就留下孤立代理项，
 * `JSON.stringify` 会写成 `\ud83d`，服务端直接 400。
 */

const EMOJI = '😀'; // U+1F600 = \ud83d\ude00

test('safeSlice：截断点落在代理对中间时退让，不留半个字符', () => {
  const text = `${'前'.repeat(5)}${EMOJI}${'后'.repeat(5)}`;
  for (let end = 0; end <= text.length; end += 1) {
    assert.equal(hasLoneSurrogate(safeSlice(text, 0, end)), false, `end=${end}`);
  }
  assert.equal(safeSlice(text, 0, 6), '前'.repeat(5), '刚好切在 emoji 前半 → 整颗不要');
  assert.equal(safeSlice(text, 0, 7), `前`.repeat(5) + EMOJI);
});

test('safeSlice：支持负数与起止在 emoji 两侧', () => {
  const text = `a${EMOJI}b`;
  assert.equal(safeSlice(text, -1), 'b');
  assert.equal(safeSlice(text, -2), `${EMOJI}b`.slice(2) === 'b' ? 'b' : `${EMOJI}b`);
  assert.equal(hasLoneSurrogate(safeSlice(text, 1, 2)), false);
});

test('clipText：正常文本按长度截，emoji 不会被切', () => {
  assert.equal(clipText('abcdef', 3), 'abc');
  assert.equal(clipText('abc', 0), 'abc', '0 表示不截');
  assert.equal(hasLoneSurrogate(clipText(`${'x'.repeat(9)}${EMOJI}`, 10)), false);
});

test('stripLoneSurrogates：去掉孤立项，保留成对 emoji', () => {
  assert.equal(stripLoneSurrogates(`a\ud83db`), 'ab');
  assert.equal(stripLoneSurrogates(`a\ude00b`), 'ab');
  assert.equal(stripLoneSurrogates(`a${EMOJI}b`), `a${EMOJI}b`);
});

test('sanitizeJsonStrings：深层结构与 key 都清理', () => {
  const input = {
    messages: [{ role: 'user', content: `好的${'\ud83d'}见图` }],
    tools: [{ function: { name: 'x', parameters: { text: `\ude00` } } }],
    [`key${'\ud83d'}`]: 1,
  };
  const cleaned = sanitizeJsonStrings(input);
  const body = JSON.stringify(cleaned);
  assert.equal(/\\ud[89ab][0-9a-f]{2}/i.test(body.replace(/\\ud[89ab][0-9a-f]{2}\\ud[c-f][0-9a-f]{2}/gi, '')), false, body);
  assert.equal(cleaned.messages[0]!.content, '好的见图');
  assert.equal(cleaned.tools[0]!.function.parameters.text, '');
  assert.ok(Object.keys(cleaned).some((key) => key === 'key'));
});

test('sanitizeJsonStrings：没有坏字符时原样返回（零拷贝）', () => {
  const input = { messages: [{ role: 'user', content: `${EMOJI} ok` }] };
  assert.equal(sanitizeJsonStrings(input), input);
});

test('真实事故形状：长 system 文本里带 emoji，截断后仍能安全序列化', () => {
  // 复刻 messages[0].content：一长串记忆条目，其中某条以 emoji 结尾并被截断。
  const entries = Array.from({ length: 40 }, (_, index) => `- [x] 任务 ${index}：把胶囊挪到顶部栏 ${index % 3 === 0 ? EMOJI : ''}`);
  const system = entries.join('\n');
  let spliced = 0;
  for (let cut = 1; cut < system.length; cut += 7) {
    const piece = safeSlice(system, 0, cut);
    const body = JSON.stringify({ messages: [{ role: 'system', content: piece }] });
    if (hasLoneSurrogate(piece)) spliced += 1;
    assert.equal(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(body), false, `cut=${cut}`);
  }
  assert.equal(spliced, 0, 'safeSlice 不该产出孤立代理项');
});

test('oneLine（记忆块用）：截断不切 emoji', () => {
  const text = `${'字'.repeat(98)}${EMOJI}${'尾'.repeat(10)}`;
  const line = oneLine(text, 100);
  assert.equal(hasLoneSurrogate(line), false, line);
  assert.ok(line.endsWith('…'));
});

test('outcomeOf（结论摘要用）：含 emoji 的回复也能安全截断', () => {
  const content = `### 我的理解\n\n要做 X。\n\n### 结果\n\n已修好${EMOJI}${'细节'.repeat(80)}`;
  assert.equal(hasLoneSurrogate(outcomeOf(content)), false);
});
