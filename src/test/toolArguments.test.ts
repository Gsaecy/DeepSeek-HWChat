import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeToolArguments } from '../agent/toolExecutor';

/**
 * 参数归一化（用户 2026-11-22：「没法换工具调用更强的模型，能不能优化工具调用
 * 结构、参数」）。
 *
 * 换不了模型，就在入口处把它常见的写法差异修到能用。每一条都来自真实会话里见过的
 * 形状：参数名不对、蛇形命名、数字当路径、Claude 风格的 oldString/newString。
 */

test('别名：file / filePath 补成 path', () => {
  assert.deepEqual(normalizeToolArguments('read_file', { file: 'src/a.ts' }), { path: 'src/a.ts' });
  assert.deepEqual(normalizeToolArguments('read_file', { filePath: 'src/a.ts' }), { path: 'src/a.ts' });
  assert.deepEqual(normalizeToolArguments('read_file', { file_path: 'src/a.ts' }), { path: 'src/a.ts' });
});

test('别名：不覆盖模型真正写的规范参数', () => {
  const args = normalizeToolArguments('read_file', { path: 'src/a.ts', file: 'src/b.ts' });
  assert.equal(args.path, 'src/a.ts');
});

test('蛇形命名与字符串数字：start_line="10" → startLine=10', () => {
  const args = normalizeToolArguments('read_file', { path: 'a.ts', start_line: '10', end_line: '20' });
  assert.equal(args.startLine, 10);
  assert.equal(args.endLine, 20);
  assert.equal(args.start_line, undefined);
});

test('布尔字符串："true" / "false" → 布尔值', () => {
  const args = normalizeToolArguments('read_file', { path: 'a.ts', caseSensitive: 'true', replaceAll: 'false' });
  assert.equal(args.caseSensitive, true);
  assert.equal(args.replaceAll, false);
});

test('replace_in_file：oldString / newString → oldText / newText', () => {
  const args = normalizeToolArguments('replace_in_file', { path: 'a.ts', oldString: 'a', newString: 'b' });
  assert.equal(args.oldText, 'a');
  assert.equal(args.newText, 'b');
});

test('replace_in_file：pattern 当作旧文本（不抢成 query）', () => {
  const args = normalizeToolArguments('replace_in_file', { path: 'a.ts', pattern: 'old', replacement: 'new' });
  assert.equal(args.oldText, 'old');
  assert.equal(args.newText, 'new');
  assert.equal(args.query, undefined);
});

test('search_files：pattern / include 补成 query / glob', () => {
  const args = normalizeToolArguments('search_files', { pattern: 'needle', include: 'src/**' });
  assert.equal(args.query, 'needle');
  assert.equal(args.glob, 'src/**');
});

test('run_command：cmd → command，且命令正文不被 trim 破坏', () => {
  const args = normalizeToolArguments('run_command', { cmd: '  git status  ' });
  assert.equal(args.command, '  git status  ', '命令正文原样保留，交给执行器自己判断');
  const keep = normalizeToolArguments('run_command', { command: '  echo a  ' });
  assert.equal(keep.command, '  echo a  ', '命令正文原样保留，交给执行器自己判断');
});
