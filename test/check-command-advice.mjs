/*
 * 被拦下的命令，改写建议必须**照抄就能跑**。
 *
 * 线上现场（2026-11-08，11 条命令后停机）：
 *
 *     命令被路径隔离策略拦截：路径 /tmp/mac.txt 不在当前工作区内。
 *     可直接改写为：`cd …/Safevault_macOS && … > /Users/…/Personal Workstation OS/tmp/mac.txt …`
 *
 * 这条「建议」有两处硬伤：
 *   1. 临时目录用的是**对话绑定的项目**，而命令在另一个工作区里执行 → 照抄仍被拦；
 *   2. `<工作区根>/tmp` 当时并不存在 → 照抄会以 No such file or directory 收场。
 *
 * 同一份日志里还有一条：`diff <(…) <(…)` 用 `/bin/sh` 执行直接语法错误
 * （进程替换是 bash 专有）。这类命令应当自动交给 bash，而不是白跑一轮。
 *
 * 用法：node test/check-command-advice.mjs
 */
import { readFileSync } from 'node:fs';

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

const EXEC = readFileSync('src/agent/toolExecutor.ts', 'utf8');

/* ── 1. 建议的临时目录按 cwd 所属的根选 ─────────────────────────── */
check(
  '建议入口接收 cwd，而不是「对话绑定的项目根」',
  /export function pathRewriteSuggestion\(command: string, roots: readonly string\[\], cwd\?: string\)/.test(EXEC),
);
check(
  '按 isPathWithin 找 cwd 所属的根',
  /roots\.find\(\(item\) => isPathWithin\(item, cwd\)\)/.test(EXEC),
);
check(
  '调用方传的是 cwd（不再传 preferredRoot）',
  /pathRewriteSuggestion\(command, roots\.map\(\(root\) => root\.fsPath\), cwd\)/.test(EXEC),
  '传 preferredRoot 会让建议落到另一个工作区，照抄仍被拦',
);
check(
  '建议先建目录再写文件',
  /const prepared = `mkdir -p \$\{shellQuote\(directory\)\} && \$\{rewritten\}`/.test(EXEC),
  'tmp/ 往往不存在，不建目录的建议等于没改',
);

/* ── 2. bash 专有语法要换 shell ────────────────────────────────── */
check('有 bash 专有语法的探测', /export function bashOnlySyntax\(/.test(EXEC));
check('进程替换被识别', EXEC.includes('<(') && EXEC.includes('bashOnlySyntax'));
check('有 shell 选择函数', /export function shellFor\(/.test(EXEC));
check(
  'spawn 使用 shellFor(command)（两处执行路径都改）',
  (EXEC.match(/shell: shellFor\(command\)/g) ?? []).length === 2,
  `实际 ${(EXEC.match(/shell: shellFor\(command\)/g) ?? []).length} 处`,
);
check('只在 POSIX 上切 bash，Windows 保持原状', /platform === 'win32'\) return true;/.test(EXEC));

/* ── 3. 真机：用日志里的真实命令跑一遍纯函数 ───────────────────── */
const { build } = await import('esbuild');
const bundle = await build({
  stdin: {
    contents: `export { bashOnlySyntax, pathRewriteSuggestion, shellFor } from './src/agent/toolExecutor';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
  alias: { vscode: './src/test/support/vscodeMock.ts' },
});
const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir = mkdtempSync(join(tmpdir(), 'hwchat-advice-'));
writeFileSync(join(dir, 'bundle.mjs'), bundle.outputFiles[0].text);
const { bashOnlySyntax, pathRewriteSuggestion, shellFor } = await import(`file://${join(dir, 'bundle.mjs')}`);
rmSync(dir, { recursive: true, force: true });

const ROOTS = ['/w/Personal Workstation OS', '/w/Safevault_windows'];
const command = 'cd "/w/Safevault_macOS" && find src -type f | sort > /tmp/mac.txt && diff -u /tmp/mac.txt /tmp/win.txt';
const suggestion = pathRewriteSuggestion(command, ROOTS, '/w/Safevault_windows');
check('真机：建议落在 cwd 所属的工作区', /Safevault_windows\/tmp\/mac\.txt/.test(suggestion), suggestion);
check('真机：建议里不再出现另一个工作区', !/Personal Workstation OS\/tmp/.test(suggestion), suggestion);
check('真机：建议带 mkdir -p', /mkdir -p '?\/w\/Safevault_windows\/tmp'?/.test(suggestion), suggestion);
check('真机：建议里没有裸 /tmp 残留', !/[^/\w]\/tmp\b/.test(suggestion), suggestion);
check('真机：进程替换被识别出来', Boolean(bashOnlySyntax('diff <(a) <(b)')));
check('真机：进程替换交给 /bin/bash', shellFor('diff <(a) <(b)', 'darwin') === '/bin/bash');
check('真机：普通命令仍用默认 shell', shellFor('ls -la', 'darwin') === true);
check('真机：Windows 不切 bash', shellFor('diff <(a) <(b)', 'win32') === true);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('改写建议仍可能「照抄也没用」，或 bash 专有语法仍走 /bin/sh。');
  process.exitCode = 1;
} else {
  console.log('建议落在命令所在的工作区并自带 mkdir -p；bash 专有语法自动交给 bash。');
}
