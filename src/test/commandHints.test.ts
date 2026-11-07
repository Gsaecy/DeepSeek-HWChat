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
import { missingPathsInCommandOutput } from '../agent/commandPaths';

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

// ── 去掉「cd 到自己所在目录」的多余前缀 ─────────────────────────────────
import { stripRedundantLeadingCd } from '../agent/commandHints';

const noDirs = () => false;

test('用户那条命令：cd 到项目自己的名字可以去掉', () => {
  const result = stripRedundantLeadingCd(
    'cd "Personal Workstation OS" && grep -n "verify:web-i18n" -A 20 package.json | head -40 && ls scripts | head -30',
    CWD,
    noDirs,
  );
  assert.equal(result.removed, 'Personal Workstation OS');
  assert.equal(result.command, 'grep -n "verify:web-i18n" -A 20 package.json | head -40 && ls scripts | head -30');
});

test('带路径 / 单引号 / 分号写法都认', () => {
  assert.equal(stripRedundantLeadingCd(`cd "Personal Workstation OS/" && ls`, CWD, noDirs).removed, 'Personal Workstation OS/', '原样报出被去掉的内容');
  assert.equal(stripRedundantLeadingCd(`cd 'Personal Workstation OS'; ls`, CWD, noDirs).removed, 'Personal Workstation OS');
  assert.equal(stripRedundantLeadingCd(`cd /Users/me/AI\\ projects/Personal\\ Workstation\\ OS && ls`, CWD, noDirs).command, `cd /Users/me/AI\\ projects/Personal\\ Workstation\\ OS && ls`);
});

test('同名子目录真的存在时不动（保持原语义）', () => {
  const result = stripRedundantLeadingCd('cd "Personal Workstation OS" && ls', CWD, () => true);
  assert.equal(result.removed, undefined);
  assert.match(result.command, /^cd /);
});

test('cd 到别的目录不动', () => {
  const result = stripRedundantLeadingCd('cd src-tauri && cargo check', CWD, noDirs);
  assert.equal(result.removed, undefined);
});

test('没有后续命令（只是 cd）时不碰', () => {
  const result = stripRedundantLeadingCd('cd "Personal Workstation OS"', CWD, noDirs);
  assert.equal(result.removed, undefined);
});

test('含变量/命令替换时不动（静态算不出目标）', () => {
  const result = stripRedundantLeadingCd('cd "$(dirname x)" && ls', CWD, noDirs);
  assert.equal(result.removed, undefined);
});

/* ── 命令输出里的「找不到这个文件」──────────────────────────────────── */

test('从 grep/sed/ls/cd 的报错里取出缺失路径', () => {
  const output = [
    'grep: src/app/pet/ChatBubble.tsx: No such file or directory',
    "sed: can't read src/app/pet/ChatBubble.tsx: No such file or directory",
    "ls: cannot access 'web/assets/i18n.js': No such file or directory",
  ].join('\n');
  assert.deepEqual(missingPathsInCommandOutput(output, 4), ['src/app/pet/ChatBubble.tsx', 'web/assets/i18n.js']);
});

test('没有分隔符的提示词不会被当成路径（避免给出无意义的建议）', () => {
  assert.deepEqual(missingPathsInCommandOutput('cd: Personal Workstation OS: No such file or directory'), []);
  assert.deepEqual(missingPathsInCommandOutput('ok'), []);
});

test('只在「找不到文件」那一行取路径，其它输出不参与', () => {
  const output = 'src/app/index.ts:12: error TS2322\nsome/other/path.ts: No such file or directory'.replace('No such file', 'no such file');
  assert.deepEqual(missingPathsInCommandOutput(output), ['some/other/path.ts']);
});
