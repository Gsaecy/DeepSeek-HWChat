/*
 * 「路径不存在只回一行 ENOENT」的守护。
 *
 * 现场（用户 2026-11-04，两次贴回同一条失败）：
 *
 *     read_file {"path":"Personal Workstation OS/website/instindex/web/i18n.js"}
 *     → Error: ENOENT: no such file or directory, stat '…/web/i18n.js'
 *
 * 文件其实在 `…/web/assets/i18n.js`。只回错误的话模型只能再猜一次，
 * 猜错就撞「连续 3 轮无进展」停机 —— 用户看到的是「工具老是失败」。
 *
 * 用法：node test/check-path-hints.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
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
const EXECUTOR = read('src/agent/toolExecutor.ts');
const I18N = read('src/core/i18n.ts');

/* ── 1. 只对「文件真的不存在」补提示 ─────────────────────────────── */
check(
  '只认 ENOENT / ENOTDIR，不认识别的错误（不掩盖真正的参数错误）',
  /ENOENT\|ENOTDIR\|no such file or directory/.test(EXECUTOR),
);
check(
  '提示接在原始错误后面（原始错误信息不能丢）',
  /hint \? `\$\{detail\}\\n\\n\$\{hint\}` : detail/.test(EXECUTOR),
);
check(
  '失败状态仍然是 error（读数确实失败了，不伪装成成功）',
  /status: 'error',[\s\S]{0,200}hint/.test(EXECUTOR),
);
check(
  '只在解析成功、文件真的不存在时才查（越界/歧义直接放行原始错误）',
  /if \(existsSync\(resolved\.fsPath\)\) continue;/.test(EXECUTOR),
);
check(
  '同名文件只在工作区根内找，且排除 node_modules',
  /new vscode\.RelativePattern\(resolved\.folder, `\*\*\/\$\{basename\(resolved\.fsPath\)\}`\)/.test(EXECUTOR)
    && /'\*\*\/node_modules\/\*\*'/.test(EXECUTOR),
);
check(
  '不自动替换成同名文件（读错文件比读不到更糟）',
  !/readFile\(.*sameName/.test(EXECUTOR),
);
const hintBlock = EXECUTOR.slice(EXECUTOR.indexOf('private async missingPathHint'), EXECUTOR.indexOf('private async resolvePath'));
check(
  '同名搜索结果有上限（不把整棵树塞进上下文）',
  hintBlock.includes('findFiles(') && /\b5,/.test(hintBlock),
);

/* ── 2. 文案中英都齐 ─────────────────────────────────────────────── */
for (const key of [
  'tool.pathNotFound.head',
  'tool.pathNotFound.nearest',
  'tool.pathNotFound.nearestMore',
  'tool.pathNotFound.sameName',
  'tool.pathNotFound.advice',
]) {
  const line = I18N.split('\n').find((row) => row.includes(`'${key}'`)) ?? '';
  check(`文案 ${key} 中英都有`, /\bzh:/.test(line) && /\ben:/.test(line), line.slice(0, 120));
}
check(
  '建议里点名了 list_directory（给的是能执行的动作，不是「再检查一下」）',
  /list_directory/.test(I18N),
);

/* ── 3. 真实源码跑一遍用户那次失败 ───────────────────────────────── */
mkdirSync('out/check', { recursive: true });
buildSync({
  entryPoints: ['src/agent/pathHints.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/check/pathHints.cjs',
  logLevel: 'silent',
});
const require = createRequire(import.meta.url);
const { nearestExistingDirectory, renderMissingPathHint } = require(resolve('out/check/pathHints.cjs'));

const site = '/Users/guohongyu/AI projects/Personal Workstation OS/website/instindex';
const requested = `${site}/web/i18n.js`;
const nearest = nearestExistingDirectory(requested, site, existsSync);
check(
  '真实路径：web/i18n.js → 最近存在的目录是 web（退 1 段）',
  nearest?.directory === `${site}/web` && nearest?.depth === 1,
  JSON.stringify(nearest),
);

const hint = renderMissingPathHint(
  {
    requestedPath: 'web/i18n.js',
    nearestDir: 'web',
    nearestDepth: 1,
    entries: [{ name: 'assets', directory: true }],
    sameName: ['web/assets/i18n.js'],
  },
  {
    t: (key, values) => `${key}${values ? Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',') : ''}`,
  },
);
check('渲染结果非空', Boolean(hint));
check('渲染结果里有真实可用的路径 assets/i18n.js', Boolean(hint) && hint.includes('web/assets/i18n.js'));

rmSync('out/check/pathHints.cjs', { force: true });

/* ── 4. 外平台绝对路径：直接说清，而不是拼成怪路径 ─────────────────── */
const PATHS = read('src/agent/workspacePaths.ts');
check(
  '解析入口先判「这是另一个平台的路径」',
  /const foreign = foreignPathStyle\(value/.test(PATHS),
  '不判的话 Windows 路径在 macOS 上会被当成相对路径拼到工作区根后面',
);
check(
  'Windows 路径 / POSIX 路径的提示文案中英都齐',
  /'path\.windowsPathOnThisPlatform'/.test(I18N) && /'path\.posixPathOnThisPlatform'/.test(I18N),
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「路径不存在」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('路径不存在时会把真实结构还回去：模型不用再猜第二次。');
}
