import assert from 'node:assert/strict';
import test from 'node:test';
import { commandPathViolation } from '../agent/commandPaths';
import { pathRewriteSuggestion } from '../agent/toolExecutor';

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

// ── 命令里先 cd 再写相对路径：按 cd 之后的目录解析（2026-11-04 真实故障）──────
/*
 * 用户那条被拒的命令：
 *
 *     cd "/Users/…/Personal Workstation OS/src-tauri" && du -sh target/sherpa-onnx-prebuilt \
 *       && mkdir -p ../tmp/cargo-check && cp -R target/sherpa-onnx-prebuilt ../tmp/cargo-check/
 *
 * 执行到 mkdir 时已经在 src-tauri 里，`../tmp` ＝ 工作区内的 `Personal Workstation OS/tmp`，
 * 完全合法；旧实现只按 `run_command` 的 cwd（项目根）解析，把它判成越界。
 */
const osRoot = '/Users/test/AI projects/Personal Workstation OS';

test('a leading cd changes how later ../ paths resolve', () => {
  const command = `cd "${osRoot}/src-tauri" && du -sh target/sherpa-onnx-prebuilt && mkdir -p ../tmp/cargo-check && cp -R target/sherpa-onnx-prebuilt ../tmp/cargo-check/ && ls ../tmp/cargo-check/sherpa-onnx-prebuilt`;
  assert.equal(commandPathViolation(command, [osRoot], osRoot), undefined);
});

test('a leading cd cannot be used to escape the workspace', () => {
  const command = `cd "${osRoot}/src-tauri" && cat ../../../etc/passwd`;
  assert.match(String(commandPathViolation(command, [osRoot], osRoot)), /不在当前工作区内/);
});

test('a leading cd to outside is still caught by the absolute-path check', () => {
  const command = 'cd /etc && ls ..';
  assert.match(String(commandPathViolation(command, [osRoot], osRoot)), /不在当前工作区内/);
});

test('cd with more than one argument is not treated as a plain path (base stays put)', () => {
  const command = `cd "${osRoot}/src-tauri" && echo hi && cat ../tmp/x`;
  assert.equal(commandPathViolation(command, [osRoot], osRoot), undefined, '单个路径参数的 cd 会移动基准');
  // 多参数的 cd 算不出目标目录 → 不移动基准 → ../tmp 仍相对项目根，落在工作区外。
  const ambiguous = 'cd src-tauri extra && cat ../tmp/x';
  assert.match(String(commandPathViolation(ambiguous, [osRoot], osRoot)), /不在当前工作区内/);
});

test('cd with a command substitution does not move the base (cannot be resolved statically)', () => {
  const command = 'cd "$(git rev-parse --show-toplevel)" && cat ../../outside/x';
  assert.match(String(commandPathViolation(command, [osRoot], osRoot)), /不在当前工作区内/);
});

test('cd chain: each segment uses the cwd in effect at that point', () => {
  const command = `cd "${osRoot}" && cd src-tauri && cat ../tmp/ok.txt`;
  assert.equal(commandPathViolation(command, [osRoot], osRoot), undefined);
});

// ── 路径改写建议必须改**全部**出现的位置（2026-11-05 真实故障）──────────────
/*
 * 用户贴回的原样输出：命令里 `/tmp` 出现两次（`cd /tmp` 与 `2>/tmp/pws-t.err`），
 * 建议只改了第一处 —— 照着敲仍然被拦，比不给建议更浪费时间。
 */
test('the rewrite suggestion fixes every temp path, not just the first', () => {
  const command = 'cd /tmp && rm -f pws-t.mov && screencapture -v pws-t.mov 2>/tmp/pws-t.err; cat /tmp/pws-t.err';
  // 先确认隔离确实拦下了它（否则测试会变成「改写一个本来就能跑的命令」）
  assert.match(String(commandPathViolation(command, [osRoot], osRoot)), /不在当前工作区内/);
  const suggestion = pathRewriteSuggestion(command, [osRoot]);
  assert.match(suggestion, /Personal Workstation OS\/tmp/);
  /*
   * 建议里**每一个** `/tmp` 都必须属于工作区内那个临时目录 —— 只要还剩一处裸 `/tmp`，
   * 照着敲仍然会被拦（这正是用户遇到的「改了但没用」）。
   */
  const tempMentions = (suggestion.match(/\/tmp\b/g) ?? []).length;
  const insideWorkspace = (suggestion.match(/Personal Workstation OS\/tmp/g) ?? []).length;
  assert.ok(tempMentions >= 3, suggestion);
  assert.equal(insideWorkspace, tempMentions, `每一处 /tmp 都必须在工作区内：${suggestion}`);
});

test('a single temp path is still rewritten once', () => {
  assert.match(pathRewriteSuggestion('cat /tmp/x.log', [osRoot]), /Personal Workstation OS\/tmp\/x\.log/);
});
