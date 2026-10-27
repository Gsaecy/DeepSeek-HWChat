// 归档胶囊几何验证：把 media/chat.js 里 layoutTodoArchives 的算法原样搬过来，
// 检查「永不换行 + 3:1 + 缩到放得下」这三条在常见面板宽度下是否成立。
//
// 三个常量不再在本文件里写死，而是直接从 media/chat.js 读出来：
// 之前这里复制了一份 16 / 6 / 3，改基准高度时脚本不会跟着变，
// 于是「测试通过」和「实际变小了」可以同时成立，等于没有守住。
// 同理，chat.css 的兜底值也一并比对，防止只改 JS 不改 CSS。
//
// 运行：node test/check-capsule-geometry.mjs
import { readFileSync } from 'node:fs';

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_CSS = readFileSync('media/chat.css', 'utf8');

/** 从 chat.js 源码里取出形如 `const NAME = 表达式;` 的数值常量。 */
function numberConst(name) {
  const match = CHAT_JS.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!match) throw new Error(`media/chat.js 里找不到 ${name}`);
  return Function(`'use strict'; return (${match[1]});`)();
}

const BASE_HEIGHT = numberConst('CAPSULE_BASE_HEIGHT');
const MIN_HEIGHT = numberConst('CAPSULE_MIN_HEIGHT');
const RATIO = numberConst('CAPSULE_RATIO');

export function capsuleLayout(available, count) {
  const perUnit = count * RATIO + Math.max(0, count - 1) * 0.25;
  let height = Math.min(BASE_HEIGHT, available / perUnit);
  if (height < 8) height = Math.min(height, (available - 2 * (count - 1)) / (count * RATIO));
  height = Math.max(MIN_HEIGHT, height);
  const gap = Math.max(2, height * 0.25);
  return { height, width: height * RATIO, gap, total: count * height * RATIO + Math.max(0, count - 1) * gap };
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) return;
  failures += 1;
  console.log(`✗ ${label} — ${detail}`);
}

/* ── 1. 常量本身：初始高度应是原来 16px 的 2/3 ───────────────────── */

check('初始高度 = 16px 的 2/3（本次要求高度减少 1/3）',
  Math.abs(BASE_HEIGHT - (16 * 2) / 3) < 1e-9, `BASE_HEIGHT = ${BASE_HEIGHT}`);
check('宽高比仍是 3:1', RATIO === 3, `RATIO = ${RATIO}`);
check('缩放下限仍是 6px', MIN_HEIGHT === 6, `MIN_HEIGHT = ${MIN_HEIGHT}`);
check('初始高度仍高于缩放下限', BASE_HEIGHT > MIN_HEIGHT, `${BASE_HEIGHT} <= ${MIN_HEIGHT}`);

/* ── 2. chat.css 的兜底值必须和 JS 算出来的一致 ──────────────────── */

const cssVar = (name) => {
  const match = CHAT_CSS.match(new RegExp(`--${name}:\\s*([0-9.]+)px`));
  return match ? Number(match[1]) : NaN;
};
const cssHeight = cssVar('capsule-h');
const cssWidth = cssVar('capsule-w');
const cssRadius = cssVar('capsule-radius');
const cssMinHeightFallback = (() => {
  const match = CHAT_CSS.match(/min-height:\s*calc\(var\(--capsule-h,\s*([0-9.]+)px\)/);
  return match ? Number(match[1]) : NaN;
})();

check('chat.css 的 --capsule-h 与 JS 基准一致',
  Math.abs(cssHeight - Number(BASE_HEIGHT.toFixed(2))) < 0.01, `CSS ${cssHeight} vs JS ${BASE_HEIGHT}`);
check('chat.css 的 --capsule-w 等于 高度 × 3',
  Math.abs(cssWidth - Number((BASE_HEIGHT * RATIO).toFixed(2))) < 0.01, `CSS ${cssWidth} vs ${BASE_HEIGHT * RATIO}`);
check('chat.css 的 min-height 兜底与 --capsule-h 一致',
  Math.abs(cssMinHeightFallback - cssHeight) < 0.01, `兜底 ${cssMinHeightFallback} vs ${cssHeight}`);
check('chat.css 的圆角为高度约 30%（最小 2px）',
  Math.abs(cssRadius - Math.max(2, Math.round(BASE_HEIGHT * 0.3))) < 0.01,
  `CSS ${cssRadius} vs ${Math.max(2, Math.round(BASE_HEIGHT * 0.3))}`);
check('chat.css 里不再残留旧的 16px / 48px 胶囊尺寸',
  !/--capsule-h:\s*16px/.test(CHAT_CSS) && !/--capsule-w:\s*48px/.test(CHAT_CSS),
  '还留着 16px / 48px');

/* ── 3. 各种面板宽度 × 胶囊数量的几何 ───────────────────────────── */

for (const width of [846, 700, 620, 500, 400, 320, 240]) {
  for (const count of [1, 2, 3, 5, 8, 12]) {
    const { height, width: capsuleWidth, total } = capsuleLayout(width - 4, count);
    check(`${width}px/${count}`, Math.abs(capsuleWidth / height - RATIO) < 1e-9, `宽高比 ${capsuleWidth}/${height}`);
    check(`${width}px/${count}`, height >= MIN_HEIGHT && height <= BASE_HEIGHT, `高度越界 ${height}`);
    // 缩到下限（6px）仍放不下是允许的（CSS 裁掉右侧），其余情况必须放得下。
    // 允许 0.5px 容差：CSS 用的是小数像素，亚像素级别由 overflow: hidden 兜住。
    if (height > MIN_HEIGHT) check(`${width}px/${count}`, total <= width - 4 + 0.5, `总宽 ${total.toFixed(1)} > ${width - 4}`);
    // 用基准高度算，不再写死 48px —— 基准改成 10.67 后，48 这个数字已经不成立了。
    if (height === BASE_HEIGHT) {
      check(`${width}px/${count}`, total <= width - 4 + 0.5 || count * BASE_HEIGHT * RATIO > width,
        `初始尺寸溢出 ${total}`);
    }
  }
}

/* ── 4. 高度确实降了，但没降成一条线 ─────────────────────────────── */

const tenCapsules = capsuleLayout(846 - 4, 10);
check('十颗胶囊在宽面板上仍是完整基准高度', Math.abs(tenCapsules.height - BASE_HEIGHT) < 1e-9, `height = ${tenCapsules.height}`);
check('基准高度约 10.67px（原来的 2/3）', Math.abs(BASE_HEIGHT - 10.6667) < 0.001, `height = ${BASE_HEIGHT}`);
check('基准宽度约 32px（原来的 2/3）', Math.abs(BASE_HEIGHT * RATIO - 32) < 0.01, `width = ${BASE_HEIGHT * RATIO}`);

console.log(failures
  ? `\n${failures} 项不满足`
  : `\n全部通过：宽高比 3:1、高度不越界、初始尺寸 ${BASE_HEIGHT.toFixed(2)}×${(BASE_HEIGHT * RATIO).toFixed(0)}px、放不下时会缩小`);
process.exitCode = failures ? 1 : 0;
