/*
 * `run_command` 报「找不到这个文件」时，要给出真实结构。
 *
 * 用户原话（2026-11-07，贴回原始输出）：
 *
 *     grep: src/app/pet/ChatBubble.tsx: No such file or directory
 *     sed: src/app/pet/ChatBubble.tsx: No such file or directory
 *
 * 两句都只有「文件不存在」，模型接着又是 sed 同一个路径 —— 两轮白烧，最后撞
 * 「连续失败」停机。而报错行里**就带着真实路径**，宿主完全查得到它到底在哪。
 *
 * 这条守护盯三件事：
 *   1. 能从各类 coreutils 报错里取出路径（`grep:` / `sed: can't read` / `ls: cannot access` / `sh: cd:`）；
 *   2. 相对路径按**命令自己的 cwd** 折算，不按对话项目根猜；
 *   3. 只在命令失败时补提示，成功时一个字都不加。
 *
 * 用法：node test/check-command-path-hint.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';

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

const read = (path) => readFileSync(path, 'utf8');
const PATHS = read('src/agent/commandPaths.ts');
const EXECUTOR = read('src/agent/toolExecutor.ts');

/* ── 1. 解析：只认真的「找不到文件」行 ────────────────────────────── */
buildSync({
  entryPoints: ['src/agent/commandPaths.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/check/commandPaths.cjs',
  alias: { vscode: './src/test/support/vscodeMock.ts' },
  logLevel: 'silent',
});
const require = createRequire(import.meta.url);
const { missingPathsInCommandOutput } = require(resolve('out/check/commandPaths.cjs'));

const userOutput = [
  '===',
  'grep: src/app/pet/ChatBubble.tsx: No such file or directory',
  '===',
  'grep: src/app/pet/ChatBubble.tsx: No such file or directory',
].join('\n');
check(
  '用户那条命令的真实输出 → 取出路径',
  JSON.stringify(missingPathsInCommandOutput(userOutput)) === JSON.stringify(['src/app/pet/ChatBubble.tsx']),
  JSON.stringify(missingPathsInCommandOutput(userOutput)),
);
check(
  '`sed: can\'t read` 与 `ls: cannot access` 也认',
  JSON.stringify(missingPathsInCommandOutput("sed: can't read a/b.ts: No such file or directory")) === JSON.stringify(['a/b.ts'])
    && JSON.stringify(missingPathsInCommandOutput("ls: cannot access 'web/x.js': No such file or directory")) === JSON.stringify(['web/x.js']),
);
check(
  '带 `line 0: cd:` 前缀的 shell 报错也认',
  JSON.stringify(missingPathsInCommandOutput('/bin/sh: line 0: cd: sub/dir: No such file or directory')) === JSON.stringify(['sub/dir']),
  'cd 的目标带分隔符时要能取出来',
);
check(
  '句子中间的路径不会被当成前缀吃掉',
  JSON.stringify(missingPathsInCommandOutput('some/other/path.ts: No such file or directory')) === JSON.stringify(['some/other/path.ts']),
  '从开头剥 `^[^:]*:` 会把路径本身剥掉（这条曾经真的写错过）',
);
check(
  '与「找不到文件」无关的输出不产生候选',
  missingPathsInCommandOutput('src/a.ts:12: error TS2322\nok').length === 0,
);
check(
  '没有分隔符的词不当路径（避免给无意义建议）',
  missingPathsInCommandOutput('cd: Personal Workstation OS: No such file or directory').length === 0,
);
check(
  '最多取 2 个候选（提示要短）',
  missingPathsInCommandOutput([
    'a/1.ts: No such file or directory',
    'b/2.ts: No such file or directory',
    'c/3.ts: No such file or directory',
  ].join('\n')).length === 2,
);

/* ── 2. 接入位置：失败才补，且按命令自己的 cwd 折算 ───────────────── */
check(
  '只在命令失败时生成提示',
  /const missingPath = result\.code === 0[\s\S]{0,120}commandMissingPathHint/.test(EXECUTOR),
  '成功的命令不该多出一段路径说明',
);
check(
  '相对路径按命令的 cwd 折算成绝对路径',
  /join\(commandCwd, candidate\)/.test(EXECUTOR),
  '命令可能 cd 过；按对话项目根猜会指到另一个文件上',
);
check(
  '提示进入结果正文',
  /nestedCdHint, missingPath, environmentHint, advice/.test(EXECUTOR),
);
check(
  '复用已有的「最近存在的目录」提示，不另造一套',
  /const hint = await this\.pathHintFor\(absolute, scope\);/.test(EXECUTOR)
    && /nearestExistingDirectory/.test(EXECUTOR),
);
check(
  '解析器是纯函数模块（不 import vscode）',
  !/from 'vscode'/.test(PATHS),
  '要能被单测与守护脚本直接跑',
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('命令里的「文件不存在」仍然没有给出下一步。');
  process.exitCode = 1;
} else {
  console.log('命令报「找不到文件」时会给出真实目录结构，模型不必再猜一遍。');
}
