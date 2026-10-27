// 归档胶囊几何验证：把 media/chat.js 里 layoutTodoArchives 的算法原样搬过来，
// 检查「永不换行 + 3:1 + 缩到放得下」这三条在常见面板宽度下是否成立。
// 运行：node test/check-capsule-geometry.mjs
const BASE_HEIGHT = 16;
const MIN_HEIGHT = 6;
const RATIO = 3;

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

for (const width of [846, 700, 620, 500, 400, 320, 240]) {
  for (const count of [1, 2, 3, 5, 8, 12]) {
    const { height, width: capsuleWidth, total } = capsuleLayout(width - 4, count);
    check(`${width}px/${count}`, Math.abs(capsuleWidth / height - RATIO) < 1e-9, `宽高比 ${capsuleWidth}/${height}`);
    check(`${width}px/${count}`, height >= MIN_HEIGHT && height <= BASE_HEIGHT, `高度越界 ${height}`);
    // 缩到下限（6px）仍放不下是允许的（CSS 裁掉右侧），其余情况必须放得下。
    // 允许 0.5px 容差：CSS 用的是小数像素，亚像素级别由 overflow: hidden 兜住。
    if (height > MIN_HEIGHT) check(`${width}px/${count}`, total <= width - 4 + 0.5, `总宽 ${total.toFixed(1)} > ${width - 4}`);
    if (height === BASE_HEIGHT) check(`${width}px/${count}`, total <= width - 4 + 0.5 || count * 48 > width, `初始尺寸溢出 ${total}`);
  }
}

console.log(failures ? `\n${failures} 项不满足` : '\n全部通过：宽高比 3:1、高度不越界、放不下时会缩小');
process.exitCode = failures ? 1 : 0;
