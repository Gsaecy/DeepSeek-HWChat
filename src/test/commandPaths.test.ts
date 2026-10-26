import assert from 'node:assert/strict';
import test from 'node:test';
import { commandPathViolation } from '../agent/commandPaths';

const roots = [
  '/Users/test/AI projects/DeepSeek-HWChat',
  '/Users/test/AI projects/扩展选择助手',
];

// ── 允许：工作区内的绝对路径（含空格、含中文）──────────────────────────────
test('accepts an absolute workspace path quoted with spaces', () => {
  const command = 'cd "/Users/test/AI projects/扩展选择助手" && ls';
  assert.equal(commandPathViolation(command, roots), undefined);
});

test('accepts an unquoted absolute workspace path composed of single segments', () => {
  const command = 'ls /Users/test/AI projects/DeepSeek-HWChat/src';
  // 未加引号时按空白切分，`/Users/test/AI` 与 `projects/...` 都不在根目录内，
  // 因此这里应当被拦下——提醒调用方必须加引号。
  assert.match(String(commandPathViolation(command, roots)), /不在当前工作区内/);
});

test('accepts commands that only use relative paths', () => {
  assert.equal(commandPathViolation('npm test 2>&1 | tail -40', roots), undefined);
  assert.equal(commandPathViolation('git status --short', roots), undefined);
});

test('accepts URLs that look like paths', () => {
  assert.equal(
    commandPathViolation('git clone https://github.com/Gsaecy/Chinese-eyes', roots),
    undefined,
  );
});

test('accepts redirects to /dev/null', () => {
  assert.equal(commandPathViolation('npm run build > /dev/null 2>&1', roots), undefined);
});

// ── 拒绝：工作区外的绝对路径 ──────────────────────────────────────────────
test('rejects an absolute path outside every workspace root', () => {
  assert.match(
    String(commandPathViolation('cat /etc/hosts', roots)),
    /路径 \/etc\/hosts 不在当前工作区内/,
  );
});

test('rejects a quoted absolute path outside every workspace root', () => {
  assert.match(
    String(commandPathViolation('cp "/Users/test/Documents/private.txt" ./y', roots)),
    /不在当前工作区内/,
  );
});

test('rejects another user\'s home directory expansion', () => {
  assert.match(
    String(commandPathViolation('ls ~otheruser/projects', roots)),
    /HOME 或上级目录/,
  );
});

test('rejects a path escaping the workspace with ..', () => {
  assert.match(
    String(commandPathViolation('cat ../secrets.txt', roots)),
    /HOME 或上级目录/,
  );
});

test('rejects HOME expansion even when it would land inside a workspace', () => {
  assert.match(
    String(commandPathViolation('ls $HOME/AI projects/x', roots)),
    /HOME 或上级目录/,
  );
});

test('rejects tilde expansion', () => {
  assert.match(
    String(commandPathViolation('ls ~/Documents', roots)),
    /HOME 或上级目录/,
  );
});

test('rejects a windows drive path outside the workspace', () => {
  assert.match(
    String(commandPathViolation('dir D:\\AI projects\\Chinese eyes', roots)),
    /不在当前工作区内/,
  );
});

// ── 空工作区：没有根目录时不额外拦截 ──────────────────────────────────────
test('does not flag absolute paths when no workspace root is open', () => {
  assert.equal(commandPathViolation('cat /etc/hosts', []), undefined);
});

// ── `..` 按 cwd 解析后判界，而不是一律拒绝 ───────────────────────────────
const rootB = '/Users/test/AI projects/DeepSeek-HWChat';
const srcCwd = `${rootB}/src`;

test('allows .. when it resolves inside a workspace root and cwd is known', () => {
  assert.equal(commandPathViolation('cat ../package.json', roots, srcCwd), undefined);
});

test('allows .. as a standalone target when it stays inside the workspace', () => {
  assert.equal(commandPathViolation('cd .. && ls', roots, srcCwd), undefined);
});

test('rejects .. that resolves outside every root even when cwd is known', () => {
  assert.match(
    String(commandPathViolation('cat ../../../../etc/passwd', roots, srcCwd)),
    /解析后不在当前工作区内/,
  );
});

test('still rejects .. when cwd is unknown, since it cannot be resolved', () => {
  assert.match(
    String(commandPathViolation('cat ../secrets.txt', roots)),
    /HOME 或上级目录/,
  );
});

test('rejects .. that climbs out of the workspace root', () => {
  assert.match(
    String(commandPathViolation('cat ../../../etc/hosts', roots, srcCwd)),
    /解析后不在当前工作区内/,
  );
});

// ── sed / grep 的模式参数不是文件路径 ────────────────────────────────────
test('allows a sed address pattern instead of rejecting it as an outside path', () => {
  assert.equal(
    commandPathViolation("sed -n '/not ok 75/,/^ok/p' file.txt", roots, srcCwd),
    undefined,
  );
});

test('allows sed scripts passed with -e or combined short flags', () => {
  assert.equal(commandPathViolation("sed -e 's/a/b/' file.txt", roots, srcCwd), undefined);
  assert.equal(commandPathViolation("sed -ne '/x/p' file.txt", roots, srcCwd), undefined);
  assert.equal(commandPathViolation("grep -e '/usr/local' file.txt", roots, srcCwd), undefined);
});

test('allows a grep pattern that looks like an absolute path', () => {
  assert.equal(commandPathViolation('grep -n "/etc/hosts" file.txt', roots, srcCwd), undefined);
});

test('still rejects the real file argument that follows a sed script', () => {
  assert.match(
    String(commandPathViolation("sed -n 'p' /etc/hosts", roots, srcCwd)),
    /路径 \/etc\/hosts 不在当前工作区内/,
  );
});

test('still rejects a sed script file outside the workspace', () => {
  assert.match(
    String(commandPathViolation('sed -f /etc/scripts/rewrite.sed file.txt', roots, srcCwd)),
    /不在当前工作区内/,
  );
});

test('still rejects an outside path used as grep input', () => {
  assert.match(
    String(commandPathViolation('grep -n pattern /etc/hosts', roots, srcCwd)),
    /不在当前工作区内/,
  );
});

// ── 裸根 `/`：BARE_ABSOLUTE_PATH 要求 `/` 后至少一个字符，曾是漏检点 ─────────
test('rejects commands that target the bare filesystem root', () => {
  for (const command of ['rm -rf /', 'chmod -R 777 /', 'chown -R me:me /', 'ls -la /']) {
    assert.match(
      String(commandPathViolation(command, roots)),
      /路径 \/ 不在当前工作区内/,
      command,
    );
  }
});

test('still accepts redirects and devices that are not the bare root', () => {
  assert.equal(commandPathViolation('npm run build > /dev/null 2>&1', roots), undefined);
  assert.equal(commandPathViolation('ls "/Users/test/AI projects/DeepSeek-HWChat/src"', roots), undefined);
  assert.equal(commandPathViolation('date +%Y/%m/%d', roots), undefined);
});
