/*
 * `replace_in_file` 不该让模型去数行首空格。
 *
 * 线上现场（2026-11-08，用户连续贴回三次失败）：
 *
 *     replace_in_file → oldText 在文件中不存在，未执行修改。
 *     内容其实在第 706 行找到了，只是**空白/缩进不同**。文件里实际是：
 *             /* 深色卡里那三行价格…
 *
 * 文件里是 7 个空格，模型写了 9 个；而提示渲染时给每行又加了 2 个空格（7+2=9），
 * 于是「实际是」与它写的一字不差 —— 照抄重试仍然失败，三轮后停机。
 *
 * 两条硬要求：
 *   1. 只差行首缩进且窗口唯一时，工具自己按文件缩进落盘；
 *   2. 真要打印文件原文时，必须原样输出，不许自己加缩进。
 *
 * 用法：node test/check-replace-indent.mjs
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

const DIAG = readFileSync('src/agent/replaceDiagnostics.ts', 'utf8');
const EXEC = readFileSync('src/agent/toolExecutor.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

/* ── 1. 静态：提示不许给原文加缩进 ─────────────────────────────── */
check(
  '诊断渲染原样输出每一行（不再 `push(`  ${line}`)`）',
  /for \(const line of diagnosis\.actual\) lines\.push\(line\);/.test(DIAG),
  '给原文加缩进，会让「实际是」与模型写的看起来一样，照抄必失败',
);
check(
  '提示文案声明「原样，未做任何增减」',
  /原样，未做任何增减/.test(I18N) && /verbatim, nothing added or removed/.test(I18N),
);

/* ── 2. 缩进容错真的接进了替换路径 ─────────────────────────────── */
check(
  '有缩进容错的入口 findIndentTolerantWindow',
  /export function findIndentTolerantWindow\(/.test(DIAG),
);
check(
  '只容忍行首空白（行内空白不参与）',
  /function leadingWidth\(/.test(DIAG) && /trimmedLines\(current\), needle/.test(DIAG),
);
check(
  '窗口唯一才自动落盘（多处不动手）',
  /tolerant && tolerant\.count === 1/.test(EXEC),
);
check(
  '替换按文件缩进对齐 newText，而不是原样塞进去',
  /shiftIndent\(newText, tolerant\.fileIndent - tolerant\.oldIndent\)/.test(EXEC),
);
check(
  '仍然走同一套写入路径（EOL 对齐 + 版本号检查 + 落盘）',
  /const eol = lineEndingOf\(current\.slice\(tolerant\.start, tolerant\.end\), fallbackEol\)/.test(EXEC),
);

/* ── 3. 真机：用真实文本跑一遍纯函数 ───────────────────────────── */
const { build } = await import('esbuild');
const bundle = await build({
  stdin: {
    contents: `export { findIndentTolerantWindow, shiftIndent } from './src/agent/replaceDiagnostics';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
});
const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir = mkdtempSync(join(tmpdir(), 'hwchat-indent-'));
writeFileSync(join(dir, 'bundle.mjs'), bundle.outputFiles[0].text);
const { findIndentTolerantWindow, shiftIndent } = await import(`file://${join(dir, 'bundle.mjs')}`);
rmSync(dir, { recursive: true, force: true });

const file = [
  '    /* 深色卡里那三行价格（一次性买断 / 金额 / 付一次，长期使用）',
  '       2026-12-24 第六十五版删掉：H2 已经写着「一次买断，之后不再收费」，',
  '       同一句话说两遍。2026-12-25 起 H2 也不写金额了——全站唯一的金额在',
  '       `pricing.html` 的 `.price-amount`，改价只改那一处。 */',
].join('\n');
// 模型凭记忆写的版本：第一行 4 个空格（对），续行 9 个空格（错）
const drifted = file.split('\n').map((line, i) => (i === 0 ? line : `  ${line}`)).join('\n');

const window = findIndentTolerantWindow(file, drifted);
check('真机：只差续行缩进 → 找得到唯一窗口', Boolean(window) && window.count === 1, JSON.stringify(window ?? null));
check('真机：文件首行缩进 4', window?.fileIndent === 4);

const single = '         2026-12-24 第六十五版删掉：H2 已经写着「一次买断，之后不再收费」，';
const singleWindow = findIndentTolerantWindow(file.split('\n')[1], single);
check('真机：单行 9 空格 vs 文件 7 空格 → 找得到', Boolean(singleWindow) && singleWindow.count === 1);
check(
  '真机：按差值 -2 对齐后正好是文件缩进',
  Boolean(singleWindow) && shiftIndent(single, singleWindow.fileIndent - singleWindow.oldIndent) === file.split('\n')[1],
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('replace_in_file 仍会因为缩进反复失败，或提示会误导模型。');
  process.exitCode = 1;
} else {
  console.log('只差行首缩进时由工具自己对齐；提示里的原文不再被加缩进。');
}
