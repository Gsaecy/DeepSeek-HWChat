/*
 * 校验 src/views/webview.ts 里那套 24 格图标的几何：墨迹必须落在 viewBox 内，
 * 需要旋转的图标必须绕自己的圆心转。
 *
 * 为什么单独跑一遍：图标是手写路径（`M20 11a8 8 0 1 0 2 5`），肉眼看上去"大概居中"，
 * 实际墨迹可能整体偏一格、甚至探出 viewBox 被裁掉。SVG 最外层元素默认 overflow: hidden，
 * 超出的部分不报错、也没人提醒，只会静静地少一块。
 *
 * 三种真实踩过的坑：
 *   1. 墨迹偏出中心 —— .icon-button 是 place-items: center，居中作用在 24 格盒子（svg）上，
 *      不是墨迹上。墨迹在盒子内偏多少，画出来就偏多少。
 *   2. 墨迹探出 viewBox —— 底部被裁平，17px 下是一道看不出来但就是别扭的缺角。
 *   3. 圆心偏离盒子中心 —— 加载态跑 `spin`，旋转绕的是盒子中心；
 *      圆心不在中心，画出来的圆环是"绕着中心甩"的，越转越明显。
 *
 * 用法：node test/check-icon-geometry.mjs [--report]
 *   --report 只打印每个图标的实测几何，不做断言（改图标时用来看数字）。
 */
import { readFileSync } from 'node:fs';

const TAU = Math.PI * 2;
const SOURCE = 'src/views/webview.ts';

let checks = 0;
let failures = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

/* ── 路径解析 ──────────────────────────────────────────────────────
   支持这套图标用到的全部命令：M L H V C S Q T A Z 及相对形式。
   曲线不做解析求极值（贝塞尔极值要解导数、还得分段判断），改成按 32 段折线采样：
   24 格网格上误差远小于 0.01 格，比"解析错了但看起来像对的"可靠。
   遇到不认识的命令直接抛错，而不是猜一个包围盒糊过去。 */

const CURVE_SAMPLES = 32;

function tokenize(d) {
  const tokens = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!tokens) throw new Error(`路径解析不出任何标记：${d}`);
  return tokens;
}

function sampleCubic(p0, p1, p2, p3, points) {
  for (let step = 1; step <= CURVE_SAMPLES; step += 1) {
    const t = step / CURVE_SAMPLES;
    const u = 1 - t;
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

function sampleQuadratic(p0, p1, p2, points) {
  for (let step = 1; step <= CURVE_SAMPLES; step += 1) {
    const t = step / CURVE_SAMPLES;
    const u = 1 - t;
    points.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
}

/** SVG 规范 F.6.5：由端点参数解出圆心、起角、扫过角度。 */
function arcGeometry(x1, y1, rx, ry, largeArc, sweepFlag, x2, y2) {
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const lambda = (dx2 * dx2) / (rx * rx) + (dy2 * dy2) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }
  const numerator = rx * rx * ry * ry - rx * rx * dy2 * dy2 - ry * ry * dx2 * dx2;
  const denominator = rx * rx * dy2 * dy2 + ry * ry * dx2 * dx2;
  const factor = (largeArc === sweepFlag ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (factor * rx * dy2) / ry;
  const cyp = (-factor * ry * dx2) / rx;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (dx2 - cxp) / rx, (dy2 - cyp) / ry);
  let sweep = angle((dx2 - cxp) / rx, (dy2 - cyp) / ry, (-dx2 - cxp) / rx, (-dy2 - cyp) / ry);
  if (!sweepFlag && sweep > 0) sweep -= TAU;
  if (sweepFlag && sweep < 0) sweep += TAU;
  return { cx: cxp + (x1 + x2) / 2, cy: cyp + (y1 + y2) / 2, rx, ry, t1, sweep };
}

/** 路径端点 + 曲线采样点 + 弧段极值点；外加每个弧的圆心（用于「绕谁转」的断言）。 */
function tracePath(d) {
  const tokens = tokenize(d);
  const points = [];
  const arcs = [];
  let i = 0;
  let command = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // S/T 的隐式控制点是上一段控制点关于当前点的镜像，所以要记住"上一条是什么曲线"。
  let lastCubicControl = null;
  let lastQuadControl = null;
  const next = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(tokens[i])) command = tokens[i++];
    if (command === 'Z' || command === 'z') {
      x = startX;
      y = startY;
      points.push([x, y]);
      command = null;
      continue;
    }
    if (command === null) throw new Error(`路径命令缺失：${d}`);
    const relative = command === command.toLowerCase();
    const originX = relative ? x : 0;
    const originY = relative ? y : 0;
    const previous = command.toUpperCase();
    switch (previous) {
      case 'M':
        x = originX + next();
        y = originY + next();
        startX = x;
        startY = y;
        points.push([x, y]);
        // 「m」后面多出来的坐标对按 lineto 处理。
        command = relative ? 'l' : 'L';
        break;
      case 'L':
        x = originX + next();
        y = originY + next();
        points.push([x, y]);
        break;
      case 'H':
        x = originX + next();
        points.push([x, y]);
        break;
      case 'V':
        y = originY + next();
        points.push([x, y]);
        break;
      case 'C': {
        const c1 = [originX + next(), originY + next()];
        const c2 = [originX + next(), originY + next()];
        const end = [originX + next(), originY + next()];
        sampleCubic([x, y], c1, c2, end, points);
        lastCubicControl = c2;
        x = end[0];
        y = end[1];
        break;
      }
      case 'S': {
        const c1 = lastCubicControl ? [2 * x - lastCubicControl[0], 2 * y - lastCubicControl[1]] : [x, y];
        const c2 = [originX + next(), originY + next()];
        const end = [originX + next(), originY + next()];
        sampleCubic([x, y], c1, c2, end, points);
        lastCubicControl = c2;
        x = end[0];
        y = end[1];
        break;
      }
      case 'Q': {
        const c1 = [originX + next(), originY + next()];
        const end = [originX + next(), originY + next()];
        sampleQuadratic([x, y], c1, end, points);
        lastQuadControl = c1;
        x = end[0];
        y = end[1];
        break;
      }
      case 'T': {
        const c1 = lastQuadControl ? [2 * x - lastQuadControl[0], 2 * y - lastQuadControl[1]] : [x, y];
        const end = [originX + next(), originY + next()];
        sampleQuadratic([x, y], c1, end, points);
        lastQuadControl = c1;
        x = end[0];
        y = end[1];
        break;
      }
      case 'A': {
        const rx = next();
        const ry = next();
        next(); // x 轴旋转：这套图标全是 0
        const largeArc = next() ? 1 : 0;
        const sweepFlag = next() ? 1 : 0;
        const targetX = originX + next();
        const targetY = originY + next();
        const arc = arcGeometry(x, y, rx, ry, largeArc, sweepFlag, targetX, targetY);
        arcs.push({ cx: arc.cx, cy: arc.cy, r: arc.rx });
        // 弧的两端，加上落在弧段内的 0/90/180/270 度极值点。
        points.push([x, y], [targetX, targetY]);
        for (let quarter = 0; quarter < 4; quarter += 1) {
          const t = (quarter * Math.PI) / 2;
          let offset = t - arc.t1;
          while (offset < 0) offset += TAU;
          while (offset > TAU) offset -= TAU;
          const inside = arc.sweep >= 0 ? offset <= arc.sweep : offset - TAU >= arc.sweep;
          if (inside) points.push([arc.cx + arc.rx * Math.cos(t), arc.cy + arc.ry * Math.sin(t)]);
        }
        x = targetX;
        y = targetY;
        break;
      }
      default:
        throw new Error(`未支持的命令 ${command}：${d}`);
    }
    if (previous !== 'C' && previous !== 'S') lastCubicControl = null;
    if (previous !== 'Q' && previous !== 'T') lastQuadControl = null;
  }
  return { points, arcs };
}

/* ── 从源码里读出图标定义与描边宽度 ───────────────────────────── */

const source = readFileSync(SOURCE, 'utf8');

const strokeMatch = source.match(/stroke-width="([\d.]+)"/);
if (!strokeMatch) throw new Error(`没在 ${SOURCE} 里找到 stroke-width`);
const strokeWidth = Number(strokeMatch[1]);

const boxMatch = source.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
if (!boxMatch) throw new Error(`没在 ${SOURCE} 里找到 viewBox`);
const viewBox = { width: Number(boxMatch[1]), height: Number(boxMatch[2]) };

const icons = new Map();
for (const line of source.split('\n')) {
  const match = line.match(/^\s+(\w+): '(<(?:path|rect)[^']*)',\s*$/);
  if (match) icons.set(match[1], match[2]);
}
if (icons.size === 0) throw new Error(`没在 ${SOURCE} 里解析出任何图标`);

/** 单个图标元素的墨迹范围：端点 + 描边外扩；实心元素（stroke="none"）不外扩。 */
function inkBounds(markup) {
  const half = /stroke="none"/.test(markup) ? 0 : strokeWidth / 2;
  const points = [];
  const arcs = [];
  for (const path of markup.matchAll(/<path d="([^"]+)"/g)) {
    const traced = tracePath(path[1]);
    points.push(...traced.points);
    arcs.push(...traced.arcs);
  }
  for (const rect of markup.matchAll(/<rect ([^/]+)\/>/g)) {
    const attr = (name) => Number((rect[1].match(new RegExp(`${name}="([\\d.]+)"`)) || [])[1]);
    const x0 = attr('x');
    const y0 = attr('y');
    const width = attr('width');
    const height = attr('height');
    points.push([x0, y0], [x0 + width, y0], [x0, y0 + height], [x0 + width, y0 + height]);
  }
  if (points.length === 0) throw new Error(`图标没有可解析的墨迹：${markup}`);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x0: Math.min(...xs) - half,
    x1: Math.max(...xs) + half,
    y0: Math.min(...ys) - half,
    y1: Math.max(...ys) + half,
    arcs,
  };
}

const measured = [...icons].map(([name, markup]) => {
  const ink = inkBounds(markup);
  return {
    name,
    ink,
    centerX: (ink.x0 + ink.x1) / 2,
    centerY: (ink.y0 + ink.y1) / 2,
    width: ink.x1 - ink.x0,
    height: ink.y1 - ink.y0,
  };
});

const centerX = viewBox.width / 2;
const centerY = viewBox.height / 2;

/* ── 报告模式：只打印实测值（改图标时用来看数字）────────────────── */
if (process.argv.includes('--report')) {
  console.log(`viewBox 0 0 ${viewBox.width} ${viewBox.height}，描边 ${strokeWidth}\n`);
  console.log('图标        墨迹 x / y                          尺寸          中心          偏心');
  for (const icon of measured) {
    const range = `${icon.ink.x0.toFixed(2)}..${icon.ink.x1.toFixed(2)} / ${icon.ink.y0.toFixed(2)}..${icon.ink.y1.toFixed(2)}`;
    const size = `${icon.width.toFixed(2)}×${icon.height.toFixed(2)}`;
    const center = `${icon.centerX.toFixed(2)},${icon.centerY.toFixed(2)}`;
    const offset = `${(icon.centerX - centerX).toFixed(2)},${(icon.centerY - centerY).toFixed(2)}`;
    console.log(`${icon.name.padEnd(11)}${range.padEnd(38)}${size.padEnd(14)}${center.padEnd(14)}${offset}`);
  }
  process.exit(0);
}

/* ── 断言 ───────────────────────────────────────────────────────── */

// ① 任何图标的墨迹都不许探出 viewBox：超出的部分会被静默裁掉。
for (const icon of measured) {
  const overflow = [];
  if (icon.ink.x0 < 0) overflow.push(`左 ${(-icon.ink.x0).toFixed(2)}`);
  if (icon.ink.y0 < 0) overflow.push(`上 ${(-icon.ink.y0).toFixed(2)}`);
  if (icon.ink.x1 > viewBox.width) overflow.push(`右 ${(icon.ink.x1 - viewBox.width).toFixed(2)}`);
  if (icon.ink.y1 > viewBox.height) overflow.push(`下 ${(icon.ink.y1 - viewBox.height).toFixed(2)}`);
  check(`${icon.name} 墨迹不出 viewBox`, overflow.length === 0, `超出：${overflow.join('、')}`);
}

// ② 会转的图标必须绕自己的圆心转：加载态 `spin` 绕的是盒子中心，
//    墨迹圆心与盒子中心不重合时，画出来的圆环会绕着盒子中心甩。
//    这里锁 refresh —— 它是目前唯一挂了旋转动画的图标。
const spinning = measured.find((icon) => icon.name === 'refresh');
const chatCss = readFileSync('media/chat.css', 'utf8');
// 刷新模型列表的按钮已经去掉（模型清单改成静默自动刷新），
// 所以那条 `.loading .icon { animation: spin }` 也一并删掉：留着就是死规则。
check('已无 #refreshModelsButton 的旋转死规则', !/#refreshModelsButton\.loading/.test(chatCss));
// 占用它位置的是「互联网参考」开关：必须是 globe 图标，且开启态有独立样式。
const panelTs = readFileSync('src/views/chatPanel.ts', 'utf8');
check('工具栏的联网开关用 globe 图标', /id="internetReferenceButton"[\s\S]{0,200}icon\('globe'\)/.test(panelTs));
check('联网开关有开启态样式', /\.toolbar-toggle\[aria-pressed="true"\]/.test(chatCss));
if (spinning && spinning.ink.arcs.length > 0) {
  const ring = spinning.ink.arcs[0];
  check(
    'refresh 的圆环圆心在盒子中心（±0.35）',
    Math.abs(ring.cx - centerX) <= 0.35 && Math.abs(ring.cy - centerY) <= 0.35,
    `实测圆心 ${ring.cx.toFixed(2)},${ring.cy.toFixed(2)}；盒子中心 ${centerX},${centerY}`,
  );
} else {
  check('refresh 的圆环圆心在盒子中心（±0.35）', false, '没找到弧段（refresh 应该是一个圆环 + 一个箭头）');
}
check(
  'refresh 的墨迹中心在盒子中心（±0.35）',
  Math.abs(spinning.centerX - centerX) <= 0.35 && Math.abs(spinning.centerY - centerY) <= 0.35,
  `实测 ${spinning.centerX.toFixed(2)},${spinning.centerY.toFixed(2)}`,
);

// ②b 箭头必须接在弧的**末端**，不能接在弧的起点。
//     真实踩过：折点画在弧起点上、横画还从环内穿过去，看上去像箭头挂在转圈的尾巴上。
//     判定不依赖具体坐标：拿箭头路径的顶点分别量到弧的起点与终点，末端必须更近且基本重合。
const refreshPaths = [...(icons.get('refresh') ?? '').matchAll(/<path d="([^"]+)"/g)].map((match) => tracePath(match[1]));
if (refreshPaths.length >= 2) {
  const stem = refreshPaths[0].points;
  const stemStart = stem[0];
  const stemEnd = stem[stem.length - 1];
  const headVertices = refreshPaths[1].points;
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const toEnd = Math.min(...headVertices.map((point) => distance(point, stemEnd)));
  const toStart = Math.min(...headVertices.map((point) => distance(point, stemStart)));
  check('refresh 的箭头接在弧末端（±0.35）', toEnd <= 0.35, `箭头折点离弧末端 ${toEnd.toFixed(2)} 格`);
  check('refresh 的箭头不接在弧起点', toEnd < toStart, `离末端 ${toEnd.toFixed(2)}、离起点 ${toStart.toFixed(2)}`);
} else {
  check('refresh 的箭头接在弧末端（±0.35）', false, '没解析出两段路径（refresh 应该是「弧 + 箭头」两个 path）');
}

// ③ 尺寸不许和同排图标差太远：图标框一样大（.icon 17px），墨迹尺寸决定"看起来多大"。
//    参照取 history（同为 r=9 的圆环，构造一样）和 export（方形墨迹）。
//    刻意不比 archive：它的盖子横跨整个网格，宽度天生 23.8，拿它当基准会要求 refresh 也变得那么宽。
for (const reference of ['history', 'export']) {
  const sibling = measured.find((icon) => icon.name === reference);
  const wider = Math.abs(Math.max(spinning.width, sibling.width) / Math.min(spinning.width, sibling.width) - 1);
  const taller = Math.abs(Math.max(spinning.height, sibling.height) / Math.min(spinning.height, sibling.height) - 1);
  check(
    `refresh 与 ${reference} 的墨迹尺寸相近（≤12%）`,
    wider <= 0.12 && taller <= 0.12,
    `refresh ${spinning.width.toFixed(2)}×${spinning.height.toFixed(2)} vs ${reference} ${sibling.width.toFixed(2)}×${sibling.height.toFixed(2)}`,
  );
}

console.log(`\n${checks - failures}/${checks} 项通过`);
process.exit(failures === 0 ? 0 : 1);
