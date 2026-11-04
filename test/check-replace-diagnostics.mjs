/*
 * `replace_in_file` 失败/重复执行时的诊断守护。
 *
 * 现场（用户 2026-11-04）：
 *
 *     replace_in_file {"path":"…/web/index.html", …}
 *     → oldText 在文件中不存在，未执行修改。
 *
 * 实测那个文件里**已经是 newText**（上一轮就改好了）——模型重复执行同一处修改，
 * 得到一条「失败」，于是换个写法再试一遍。这条脚本把两种情况都钉住：
 *   1. 已经改过 → 认出并给出行号，不再报「不存在」；
 *   2. 只差空白 / 首行在但后续变了 → 把文件的真实内容还回去。
 *
 * 用法：node test/check-replace-diagnostics.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
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

mkdirSync('out/check', { recursive: true });
buildSync({
  entryPoints: ['src/agent/replaceDiagnostics.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/check/replaceDiagnostics.cjs',
  logLevel: 'silent',
});
const require = createRequire(import.meta.url);
const { findAlreadyApplied, diagnoseMissingOldText, renderMissingOldTextDiagnosis } = require(resolve('out/check/replaceDiagnostics.cjs'));

/* ── 1. 接线：先查「已经改过」，再给诊断 ─────────────────────────── */
check(
  'replaceInFile 先查「已经改过了」（不再一律报不存在）',
  /if \(occurrences < 1\) \{[\s\S]{0,400}findAlreadyApplied\(current, newText\)/.test(EXECUTOR),
);
check(
  '已经改过时返回 success 且不带 changedFiles（文件确实没动）',
  /status: 'success',[\s\S]{0,220}alreadyAppliedAdvice/.test(EXECUTOR)
    && !/alreadyAppliedAdvice[\s\S]{0,200}changedFiles/.test(EXECUTOR),
);
check(
  '诊断接在原始错误之后（原始错误信息不丢）',
  /hint|diagnosis \? `\$\{tt\('tool\.oldTextMissing'\)\}\\n\\n\$\{diagnosis\}`/.test(EXECUTOR),
);
check(
  '工具结果有上限（不把整份文件塞进上下文）',
  /MAX_SNIPPET_LINES/.test(read('src/agent/replaceDiagnostics.ts')),
);

/* ── 2. 文案中英都齐 ─────────────────────────────────────────────── */
for (const key of [
  'tool.replace.alreadyApplied',
  'tool.replace.alreadyAppliedAdvice',
  'tool.replace.diffWhitespace',
  'tool.replace.diffFirstLine',
  'tool.replace.diffMore',
  'tool.replace.diffAdvice',
]) {
  const line = I18N.split('\n').find((row) => row.includes(`'${key}'`)) ?? '';
  check(`文案 ${key} 中英都有`, /\bzh:/.test(line) && /\ben:/.test(line), line.slice(0, 120));
}

/* ── 3. 真实源码跑用户那次重复执行 ───────────────────────────────── */
const ICON = `    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%239fe870'/%3E%3Ccircle cx='16' cy='16' r='5' fill='%230e0f0c'/%3E%3C/svg%3E"
    />`;
const STYLESHEET = `    <link rel="stylesheet" href="/assets/site.css" />`;
const ADDED = `    <!-- 移动端浏览器的界面色与主屏图标（2026-11-06）。
         theme-color 取 body 的底色 #f1f8ec（不是纯白）：地址栏与页面之间
         若差一档颜色，滚动时会看到一条色带。图标复用 og.png（512×512）。 -->
    <meta name="theme-color" content="#f1f8ec" />
    <link rel="apple-touch-icon" href="/assets/og.png" />`;
const before = ['<head>', '    <meta charset="utf-8" />', ICON, STYLESHEET, '</head>', ''].join('\n');
const after = ['<head>', '    <meta charset="utf-8" />', ICON, ADDED, STYLESHEET, '</head>', ''].join('\n');

const applied = findAlreadyApplied(after, `${ICON}\n${ADDED}\n${STYLESHEET}`);
check('用户那次重复执行 → 认成「已经改过」（第 3 行起）', applied?.line === 3, JSON.stringify(applied));
check('还没改过时不会误报', findAlreadyApplied(before, `${ICON}\n${ADDED}\n${STYLESHEET}`) === undefined);

const whitespace = diagnoseMissingOldText(before, [`  ${ICON.trim()}`, `  ${STYLESHEET.trim()}`].join('\n'));
check('只差缩进 → 判成 whitespace，并给出行号', whitespace?.kind === 'whitespace' && whitespace.line === 3, JSON.stringify(whitespace?.kind));

const firstLine = diagnoseMissingOldText(after, [ICON, STYLESHEET].join('\n'));
check('两个 link 之间已被插入内容 → 判成 first-line', firstLine?.kind === 'first-line', JSON.stringify(firstLine?.kind));

const rendered = renderMissingOldTextDiagnosis(firstLine, (key, values) =>
  `${key}${values ? `(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : ''}`);
check('诊断里带文件的真实内容（可直接复制当 oldText）', Boolean(rendered) && rendered.includes('theme-color'));
check('诊断里带下一步，并限制行数', Boolean(rendered) && rendered.includes('tool.replace.diffAdvice') && rendered.split('\n').length < 40);

/* ── 4. 真实文件（存在时）再验一遍 ───────────────────────────────── */
const site = '/Users/guohongyu/AI projects/Personal Workstation OS/website/instindex/web/index.html';
if (existsSync(site)) {
  const file = readFileSync(site, 'utf8');
  const real = findAlreadyApplied(file, `${ICON}\n${ADDED}\n${STYLESHEET}`);
  check('真实 index.html：那次修改确实已经在文件里', Boolean(real), JSON.stringify(real));
} else {
  console.log('- 跳过真实 index.html 校验（不在本机）');
}

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「oldText 找不到」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('重复执行会认成「已经改过」，真的不匹配时会把文件的真实内容还回去。');
}
