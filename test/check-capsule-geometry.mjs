// 归档胶囊几何验证：固定 3:1 尺寸，不随栏宽变化；超出可视区域时由栏横向滚动。
//
// 尺寸常量直接从 media/chat.js 读取，并与 chat.css 的值交叉比对。
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
const RATIO = numberConst('CAPSULE_RATIO');

export function capsuleLayout(count) {
  const height = BASE_HEIGHT;
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
check('CSS 横向滚动且禁止纵向溢出',
  /overflow-x:\s*auto/.test(CHAT_CSS) && /overflow-y:\s*hidden/.test(CHAT_CSS),
  '归档栏必须支持横向滚动并裁住纵向溢出');
// 只盯归档栏这一块：别的滚动区（面板栈）保留自己的细滚动条，那是另一件事。
const barBlock = (CHAT_CSS.match(/\.todo-archive-bar\s*\{([\s\S]*?)\n\}/) || [, ''])[1];
const barWebkitBar = (CHAT_CSS.match(/\.todo-archive-bar::-webkit-scrollbar\s*\{([^}]*)\}/) || [, ''])[1];
check('归档栏的滚动条彻底隐藏（没有滚动槽，也没有滚动滑块）',
  /scrollbar-width:\s*none/.test(barBlock)
  && !/scrollbar-width:\s*thin/.test(barBlock)
  && /display:\s*none/.test(barWebkitBar)
  && !/\.todo-archive-bar::-webkit-scrollbar-thumb/.test(CHAT_CSS),
  '不能留下 thin 滚动条或 webkit 滑块样式');
check('隐藏滚动条的同时给了「可拖动」光标',
  /cursor:\s*grab/.test(barBlock) && /\.todo-archive-bar\.dragging[^{]*\{\s*cursor:\s*grabbing/.test(CHAT_CSS),
  '用户要能看出这一条可以按住拖');
check('鼠标纵向滚轮映射到横向滚动',
  /todoArchiveBar\.addEventListener\('wheel'/.test(CHAT_JS) && /scrollLeft \+ event\.deltaY/.test(CHAT_JS),
  '悬停胶囊栏时滚轮应推进横向位置');
// 滚动条隐藏之后，拖动是第二种（也是最直觉的）滚法，必须真的绑上去；
// 同时拖动松手会补发 click，胶囊的点击处理得先问一次「这是不是拖动的尾巴」。
check('按住拖动已接线，且拖动后的 click 会被吞掉',
  /bindTodoArchiveDrag\(elements\.todoArchiveBar\)/.test(CHAT_JS)
  && /if \(consumeArchiveDragClick\(\)\) return;/.test(CHAT_JS),
  'chat.js 要绑定拖动，并让胶囊 click 先过一遍 consumeArchiveDragClick');
// 新胶囊一定排在最右端。栏窄到要滚动时它就在视野外，不跟过去用户会以为「没新增」；
// 但只能跟着「变多」这一种情况走，否则展开/收起引起的重渲染会抢走用户往回滚的位置。
check('新增归档时跟到最右端，且只在变多时跟',
  /const grew = archives\.length > lastArchiveCount/.test(CHAT_JS)
  && /if \(grew\) elements\.todoArchiveBar\.scrollLeft = elements\.todoArchiveBar\.scrollWidth/.test(CHAT_JS),
  '新归档可能在视野之外，渲染后应滚到末尾');

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

/* ── 3. 各种胶囊数量：固定尺寸不因栏宽变化 ─────────────────────── */

for (const count of [1, 2, 3, 5, 8, 12]) {
  const { height, width: capsuleWidth, gap, total } = capsuleLayout(count);
  check(`${count} 颗：宽高比 3:1`, Math.abs(capsuleWidth / height - RATIO) < 1e-9, `${capsuleWidth}/${height}`);
  check(`${count} 颗：始终保持基准高度`, height === BASE_HEIGHT, `height = ${height}`);
  check(`${count} 颗：窄栏是否需要滚动`, (total > 40) === (count > 1), `total = ${total}`);
}

/* ── 4. 高度确实降了，但没降成一条线 ─────────────────────────────── */

const tenCapsules = capsuleLayout(10);
check('十颗胶囊保持完整基准高度', Math.abs(tenCapsules.height - BASE_HEIGHT) < 1e-9, `height = ${tenCapsules.height}`);
check('基准高度约 10.67px（原来的 2/3）', Math.abs(BASE_HEIGHT - 10.6667) < 0.001, `height = ${BASE_HEIGHT}`);
check('基准宽度约 32px（原来的 2/3）', Math.abs(BASE_HEIGHT * RATIO - 32) < 0.01, `width = ${BASE_HEIGHT * RATIO}`);

console.log(failures
  ? `\n${failures} 项不满足`
  : `\n全部通过：固定尺寸 ${BASE_HEIGHT.toFixed(2)}×${(BASE_HEIGHT * RATIO).toFixed(0)}px，超出栏宽可横向滚动`);
process.exitCode = failures ? 1 : 0;
