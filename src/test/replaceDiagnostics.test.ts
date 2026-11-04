/**
 * `replace_in_file` 找不到 oldText 时的诊断。
 *
 * 现场（用户 2026-11-04，原样贴回的失败）：
 *
 *     replace_in_file {"path":"…/web/index.html", "oldText":"…<link rel=\"icon\"…>\n    <link rel=\"stylesheet\"…>", …}
 *     → oldText 在文件中不存在，未执行修改。
 *
 * 那次文件里**已经是 newText**（上一轮就改好了）：模型重复执行同一处修改，
 * 得到一条「失败」，于是换个写法再试一遍。这里把这两种情形都钉住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diagnoseMissingOldText,
  findAlreadyApplied,
  renderMissingOldTextDiagnosis,
} from '../agent/replaceDiagnostics';

const t = (key: string, values?: Record<string, string | number>): string =>
  `${key}${values ? `(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : ''}`;

/** 用户那次真实的 head 片段（缩进与注释都取自文件）。 */
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

test('用户那次真实重复执行：newText 已在文件里 → 认出并给出行号', () => {
  const applied = findAlreadyApplied(after, `${ICON}\n${ADDED}\n${STYLESHEET}`);
  assert.ok(applied, '应当认出「已经改过了」');
  assert.equal(applied.line, 3, '从 icon 那一行开始');
});

test('已经改过：缩进与行尾不同也算（模型重建的文本常与文件不一致）', () => {
  const needle = [`  ${ICON.trim()}`, '\t' + ADDED.trim(), `  ${STYLESHEET.trim()}`].join('\r\n');
  const applied = findAlreadyApplied(after, needle);
  assert.ok(applied, '去首尾空白后应视为同一段');
});

test('空 newText 不算「已经改过」：删除型修改没有这种状态', () => {
  assert.equal(findAlreadyApplied(after, ''), undefined);
  assert.equal(findAlreadyApplied(after, '   \n  \n'), undefined);
});

test('还没改过时不误报', () => {
  assert.equal(findAlreadyApplied(before, `${ICON}\n${ADDED}\n${STYLESHEET}`), undefined);
});

test('只差空白：指出真实行号并原样回给文件内容', () => {
  // 改动前那两个 link 是相邻的；模型把缩进写成两个空格，与文件不同。
  const oldText = [`  ${ICON.trim()}`, `  ${STYLESHEET.trim()}`].join('\n');
  const diagnosis = diagnoseMissingOldText(before, oldText);
  assert.ok(diagnosis);
  assert.equal(diagnosis.kind, 'whitespace');
  assert.equal(diagnosis.line, 3);
  assert.ok(diagnosis.actual.some((line) => line.includes('rel="icon"')), '要把真实文本还回去');
  assert.ok(diagnosis.actual.some((line) => line.includes('rel="stylesheet"')), '两行都要看得见');
});

test('首行在、后续内容已变：说清「从这里开始对不上」并给真实内容', () => {
  // 用户那次：模型以为两个 link 之间什么都没有，其实中间已经插进了整段 meta。
  const oldText = [ICON, STYLESHEET].join('\n');
  const diagnosis = diagnoseMissingOldText(after, oldText);
  assert.ok(diagnosis);
  assert.equal(diagnosis.kind, 'first-line');
  assert.equal(diagnosis.line, 3);
  assert.ok(diagnosis.actual.length >= 3);
});

test('完全找不到相似内容时不输出空壳诊断', () => {
  assert.equal(diagnoseMissingOldText(after, '这不是文件里的任何一行\n第二行'), undefined);
  assert.equal(renderMissingOldTextDiagnosis(undefined, t), undefined);
});

test('渲染结果：真实内容 + 下一步，且内容行带缩进便于原样复制', () => {
  const diagnosis = diagnoseMissingOldText(after, [ICON, STYLESHEET].join('\n'));
  const text = renderMissingOldTextDiagnosis(diagnosis, t);
  assert.ok(text);
  assert.match(text, /tool\.replace\.diff(Whitespace|FirstLine)\(/);
  assert.match(text, /^ {2,}<link$/m, '内容行保留文件自己的缩进（可直接复制）');
  assert.match(text, /tool\.replace\.diffAdvice/);
  assert.ok(text.split('\n').length < 40, '不能把整份文件塞进上下文');
});

test('同位置多处相似时说明还有几处没展开', () => {
  const file = ['a', 'X', 'b', 'X', 'c'].join('\n');
  const diagnosis = diagnoseMissingOldText(file, 'X\ny');
  assert.ok(diagnosis);
  assert.equal(diagnosis.otherMatches, 1);
});
