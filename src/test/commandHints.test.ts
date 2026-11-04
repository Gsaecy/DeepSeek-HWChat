/**
 * `cd` 到自己所在目录。
 *
 * 现场（用户 2026-11-04）：
 *
 *     cd "Personal Workstation OS" && grep -n … package.json
 *     → /bin/sh: line 0: cd: Personal Workstation OS: No such file or directory
 *
 * cwd 本来就是 `…/Personal Workstation OS`（本次对话的项目根），所以 `cd` 去找它下面的
 * 同名子目录。宿主知道真实 cwd，直接说清比让模型换写法再猜一次便宜。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { selfNestedCdHint } from '../agent/commandHints';

const CWD = '/Users/me/AI projects/Personal Workstation OS';
const FAIL = '/bin/sh: line 0: cd: Personal Workstation OS: No such file or directory';

test('认得出「cd 到自己所在目录」', () => {
  assert.equal(selfNestedCdHint(`cd "Personal Workstation OS" && grep -n x package.json`, CWD, FAIL), 'Personal Workstation OS');
});

test('带路径的 cd 也认（取最后一段比较）', () => {
  assert.equal(selfNestedCdHint(`cd "Personal Workstation OS/" && ls`, CWD, FAIL), 'Personal Workstation OS');
  assert.equal(selfNestedCdHint(`cd 'Personal Workstation OS' && ls`, CWD, FAIL), 'Personal Workstation OS');
});

test('cd 到别的目录不提示', () => {
  const other = "/bin/sh: line 0: cd: src-tauri: No such file or directory";
  assert.equal(selfNestedCdHint(`cd src-tauri && ls`, CWD, other), undefined);
});

test('同名但不是当前目录也不提示（例如子目录里真的有一层同名目录）', () => {
  const cwd = '/Users/me/AI projects';
  assert.equal(selfNestedCdHint(`cd "Personal Workstation OS" && ls`, cwd, FAIL), undefined);
});

test('这场失败与 cd 无关时不提示', () => {
  assert.equal(selfNestedCdHint(`cd "Personal Workstation OS" && ls`, CWD, 'grep: package.json: No such file'), undefined);
});

test('没有 cwd（解析失败）时不提示', () => {
  assert.equal(selfNestedCdHint(`cd "Personal Workstation OS" && ls`, undefined, FAIL), undefined);
});
