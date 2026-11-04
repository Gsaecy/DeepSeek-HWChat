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

// ── Windows 命令行开关不是路径（真实缺陷：for /R 被当成工作区外路径）─────────
// 2026-11-03 实测：`for /R %f in (*.cs) do @echo %f` 被判成「路径 /R 不在当前
// 工作区内」，模型换写法重试仍被拒，连续 3 轮后触发「无进展」停机。
const winRoots = ['D:\\AI projects\\MaiKer-windows'];
const winCwd = winRoots[0]!;

test('accepts Windows command switches instead of treating /R as an outside path', () => {
  for (const command of [
    'for /R %f in (*.cs) do @echo %f',
    'findstr /S /R /C:"HorizontalScrollBarVisibility" Views\\*.cs',
    'taskkill /F /IM dotnet.exe',
    'xcopy /E /I src dst',
    'where /R . dotnet',
    'dir /B *.cs',
  ]) {
    assert.equal(commandPathViolation(command, winRoots, winCwd, 'win32'), undefined, command);
  }
});

test('a Windows switch list is not a blanket exemption for real root paths', () => {
  for (const command of ['type /etc/passwd', 'cat /opt/secrets.txt', 'dir /tmp']) {
    assert.match(
      String(commandPathViolation(command, winRoots, winCwd, 'win32')),
      /不在当前工作区内/,
      command,
    );
  }
});

test('the switch exemption only applies on Windows', () => {
  assert.match(
    String(commandPathViolation('ls /R', roots, undefined, 'darwin')),
    /不在当前工作区内/,
  );
});

// ── heredoc 正文：代码/样式数据不是命令行参数（2026-11-04 真实故障）──────────
/*
 * 现场（用户贴回的失败原文）：
 *
 *     命令被路径隔离策略拦截：路径 /* 移动菜单（2026-11-06）：≤720px 时导航里的文字链全部收进这块面板。
 *
 * 模型用 `python3 - <<'PY'` 改 site.css，正文里是 CSS 注释；隔离策略把注释开头当成
 * 绝对路径，整条命令被拒绝，还建议「改成 grep -e」。那段文字一个文件都没碰。
 */
test('heredoc body with CSS comments is not a path', () => {
  const command = [
    "python3 - <<'PY'",
    'from pathlib import Path',
    'css = """',
    '/*',
    ' * 移动菜单（2026-11-06）：≤720px 时导航里的文字链全部收进这块面板。',
    ' * 原来的做法是把链接 display:none——手机上「价格 / 常见问题」从顶栏消失。',
    ' */',
    '.menu-toggle { display: none; }',
    '"""',
    'PY',
  ].join('\n');
  assert.equal(commandPathViolation(command, roots), undefined);
});

test('heredoc body with relative url() and ~ is not an escape', () => {
  const command = [
    "cat <<'CSS' > assets/site.css",
    '.hero { background: url(../img/hero.png); }',
    '.x::after { content: "~/tmp"; }',
    'CSS',
  ].join('\n');
  assert.equal(commandPathViolation(command, roots), undefined);
});

test('quoted absolute paths inside a heredoc are still checked', () => {
  const command = [
    "python3 - <<'PY'",
    "open('/etc/passwd')",
    'PY',
  ].join('\n');
  assert.match(String(commandPathViolation(command, roots)), /不在当前工作区内/);
});

test('a workspace quoted path inside a heredoc is allowed', () => {
  const command = [
    "python3 - <<'PY'",
    "Path('/Users/test/AI projects/DeepSeek-HWChat/site.css').read_text()",
    'PY',
  ].join('\n');
  assert.equal(commandPathViolation(command, roots), undefined);
});

test('heredoc variants: tab-stripping, unquoted and several bodies', () => {
  const tabStripped = ["cat <<-EOF > out.txt", '\t/* 注释 */', '\tEOF'].join('\n');
  assert.equal(commandPathViolation(tabStripped, roots), undefined);
  const unquoted = ['cat <<EOF > x.txt', '/* 注释 */', 'EOF'].join('\n');
  assert.equal(commandPathViolation(unquoted, roots), undefined);
  const two = ['cat <<A > a.txt <<B', '/* 一 */', 'A', '/* 二 */', 'B'].join('\n');
  assert.equal(commandPathViolation(two, roots), undefined);
});

test('paths on the heredoc command line itself are still validated', () => {
  const command = ["cat <<'EOF' > /etc/motd", '/* 注释 */', 'EOF'].join('\n');
  assert.match(String(commandPathViolation(command, roots)), /不在当前工作区内/);
});

test('an unterminated heredoc is checked conservatively (no terminator → no masking)', () => {
  // 找不到结束标记时宁可按普通命令检查：遮错区间会把后面的真实命令当成正文吞掉。
  const command = ["cat <<'EOF'", '/* 注释 */'].join('\n');
  assert.match(String(commandPathViolation(command, roots)), /不在当前工作区内/);
  assert.match(String(commandPathViolation(["cat > /etc/x <<'EOF'", 'body'].join('\n'), roots)), /不在当前工作区内/);
});
