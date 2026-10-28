// 归档胶囊栏「按住拖动」的真实行为验证。
//
// 为什么单独一个脚本：滚动条隐藏之后，拖动是唯一不依赖滚轮的滚法，
// 而它的两个坑都只在运行时才暴露 ——
//   1. 位移方向搞反（手往左拖，内容反而往右跑）；
//   2. 松手后浏览器补发的那个 click 被当成点击，拖动一下就莫名展开一颗胶囊。
// 前者靠断言 scrollLeft 的增量，后者靠 consumeArchiveDragClick 的一次性标记。
//
// 做法和其它 check-*.mjs 一致：从 media/chat.js 里原样抽出这两个函数，
// 配一个最小的「指针 + classList + dataset」桩跑真实操作序列，不引入任何依赖。
//
// 运行：node test/check-capsule-drag.mjs
import { readFileSync } from 'node:fs';

const CHAT_JS = readFileSync('media/chat.js', 'utf8');

/* ── 最小 DOM 桩 ─────────────────────────────────────────────── */

class StubClassList {
  constructor() { this.set = new Set(); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
  contains(name) { return this.set.has(name); }
}

class StubBar {
  constructor() {
    this.listeners = new Map();
    this.dataset = {};
    this.classList = new StubClassList();
    // 内容比视口宽：12 颗 × 32px，栏宽 100px。
    this.scrollWidth = 384;
    this.clientWidth = 100;
    this.captured = [];
    this._scrollLeft = 0;
  }
  // 像浏览器一样把 scrollLeft 夹在 [0, 最大可滚距离]，越界不报错也不留负值。
  get scrollLeft() { return this._scrollLeft; }
  set scrollLeft(value) {
    const max = Math.max(0, this.scrollWidth - this.clientWidth);
    this._scrollLeft = Math.min(Math.max(0, value), max);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  /** 派发一次事件：所有监听器都会跑到，返回是否有监听器阻止了默认行为。 */
  fire(type, event) {
    for (const handler of this.listeners.get(type) || []) handler(event);
    return Boolean(event.defaultPrevented);
  }
  setPointerCapture(id) { this.captured.push(id); }
  releasePointerCapture(id) { this.captured = this.captured.filter((value) => value !== id); }
  hasPointerCapture(id) { return this.captured.includes(id); }
  get dragging() { return this.classList.contains('dragging'); }
  get dragMoved() { return this.dataset.dragMoved; }
}

/** 造一个指针事件。默认是鼠标左键按下的第 1 号指针。 */
function pointerEvent(x, extra = {}) {
  const event = {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientX: x,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...extra,
  };
  return event;
}

/* ── 从 chat.js 抽出被测函数 ─────────────────────────────────── */

/** 数大括号取出一段 2 空格缩进的顶层函数。 */
function extract(name) {
  const needle = `\n  function ${name}(`;
  let start = CHAT_JS.indexOf(needle);
  if (start < 0) throw new Error(`media/chat.js 里找不到函数 ${name}`);
  while (CHAT_JS[start] === '\n' || CHAT_JS[start] === '\r') start += 1;
  const lines = CHAT_JS.slice(start).split('\n');
  const body = [];
  let depth = 0;
  for (const line of lines) {
    body.push(line);
    for (const char of line) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    if (depth <= 0) break;
  }
  return body.join('\n');
}

const factory = new Function('elements', `
  ${extract('bindTodoArchiveDrag')}
  ${extract('consumeArchiveDragClick')}
  return { bindTodoArchiveDrag, consumeArchiveDragClick };
`);

/** 新建一条栏，绑定拖动，返回桩与两个被测函数。 */
function setup() {
  const bar = new StubBar();
  const elements = { todoArchiveBar: bar };
  const api = factory(elements);
  api.bindTodoArchiveDrag(bar);
  return { bar, api, elements };
}

/* ── 断言 ────────────────────────────────────────────────────── */

let failures = 0;
let passed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log(`✓ ${label}`); return; }
  failures += 1;
  console.log(`✗ ${label} — ${detail}`);
}

/* ── 1. 基本拖动：手往左，内容跟着往左（scrollLeft 增大）───────── */

{
  const { bar } = setup();
  bar.fire('pointerdown', pointerEvent(200));
  const prevented = bar.fire('pointermove', pointerEvent(160));
  check('往左拖 40px：scrollLeft 增加 40', bar.scrollLeft === 40, `scrollLeft = ${bar.scrollLeft}`);
  check('拖动中挂上 dragging（换成「抓住」光标）', bar.dragging, `classList = ${[...bar.classList.set].join(',')}`);
  check('拖动中阻止默认行为，避免顺带选中内容', prevented, 'pointermove 没有 preventDefault');
  bar.fire('pointermove', pointerEvent(120));
  check('继续往左拖：从按下时的位置算，不累加误差', bar.scrollLeft === 80, `scrollLeft = ${bar.scrollLeft}`);
  bar.fire('pointermove', pointerEvent(240));
  check('反向拖回：scrollLeft 跟着回退，并在 0 处被夹住', bar.scrollLeft === 0, `scrollLeft = ${bar.scrollLeft}`);
  bar.fire('pointermove', pointerEvent(0));
  check('手拖到栏外：位移继续算（200px）', bar.scrollLeft === 200, `scrollLeft = ${bar.scrollLeft}`);
  bar.fire('pointermove', pointerEvent(-200));
  check('拖过内容宽度：在最大可滚距离处被夹住', bar.scrollLeft === 284, `scrollLeft = ${bar.scrollLeft}`);
}

/* ── 2. 只晃了几像素不算拖动，胶囊仍然可以点 ─────────────────── */

{
  const { bar, api } = setup();
  bar.fire('pointerdown', pointerEvent(200));
  bar.fire('pointermove', pointerEvent(202));
  check('抖动 2px：不滚动', bar.scrollLeft === 0, `scrollLeft = ${bar.scrollLeft}`);
  check('抖动 2px：不打吞点击标记，点击照样生效', bar.dragMoved === undefined, `dragMoved = ${bar.dragMoved}`);
  bar.fire('pointerup', pointerEvent(202));
  check('抖动 2px：也不留 dragging 类', !bar.dragging, 'dragging 还在');
  check('抖动 2px：consumeArchiveDragClick 返回 false', api.consumeArchiveDragClick() === false, '被误判成拖动');
}

/* ── 3. 松手即停，不再跟着鼠标 ───────────────────────────────── */

{
  const { bar } = setup();
  bar.fire('pointerdown', pointerEvent(200));
  bar.fire('pointermove', pointerEvent(120));
  const afterDrag = bar.scrollLeft;
  bar.fire('pointerup', pointerEvent(120));
  check('松手：dragging 类被移除', !bar.dragging, 'dragging 还在');
  bar.fire('pointermove', pointerEvent(0));
  check('松手后移动鼠标：不再滚动', bar.scrollLeft === afterDrag, `${afterDrag} → ${bar.scrollLeft}`);
}

/* ── 4. 指针捕获：拖到栏外也跟手，但不能在按下时就捕获 ─────────── */

{
  const { bar } = setup();
  bar.fire('pointerdown', pointerEvent(200, { pointerId: 7 }));
  check('按下时不捕获指针', !bar.hasPointerCapture(7),
    `captured = ${bar.captured.join(',')}（捕获会把 click 改派给栏，胶囊就点不动了）`);
  bar.fire('pointermove', pointerEvent(198, { pointerId: 7 }));
  check('2px 抖动：仍不捕获（这一次要留给点击）', bar.captured.length === 0, `captured = ${bar.captured.join(',')}`);
  bar.fire('pointermove', pointerEvent(100, { pointerId: 7 }));
  check('确实拖起来之后才捕获（拖出栏外仍能继续收 move）', bar.hasPointerCapture(7), `captured = ${bar.captured.join(',')}`);
  check('捕获状态下继续生效', bar.scrollLeft === 100, `scrollLeft = ${bar.scrollLeft}`);
  bar.fire('pointerup', pointerEvent(100, { pointerId: 7 }));
  check('松手释放捕获', !bar.hasPointerCapture(7), `captured = ${bar.captured.join(',')}`);
  bar.fire('lostpointercapture', pointerEvent(100, { pointerId: 7 }));
  check('丢失捕获（比如拖到窗口外松手）后不再处于拖动状态', !bar.dragging, 'dragging 还在');
}

/* ── 5. 触摸屏与右键交给别人处理 ─────────────────────────────── */

{
  const { bar } = setup();
  bar.fire('pointerdown', pointerEvent(200, { pointerType: 'touch' }));
  bar.fire('pointermove', pointerEvent(100, { pointerType: 'touch' }));
  check('触摸：不接管，交给浏览器原生惯性滚动', bar.scrollLeft === 0 && !bar.dragging,
    `scrollLeft = ${bar.scrollLeft}, dragging = ${bar.dragging}`);
}
{
  const { bar } = setup();
  bar.fire('pointerdown', pointerEvent(200, { button: 2 }));
  bar.fire('pointermove', pointerEvent(100));
  check('右键按下：不进入拖动', bar.scrollLeft === 0 && !bar.dragging,
    `scrollLeft = ${bar.scrollLeft}, dragging = ${bar.dragging}`);
}
{
  const { bar } = setup();
  bar.fire('pointerdown', pointerEvent(200, { pointerId: 1 }));
  bar.fire('pointermove', pointerEvent(0, { pointerId: 2 }));
  check('别的指针的 move 被忽略（多指/多设备不串台）', bar.scrollLeft === 0, `scrollLeft = ${bar.scrollLeft}`);
}

/* ── 6. 拖动后的那个 click 被吞掉，且只吞一次 ────────────────── */

{
  const { bar, api } = setup();
  bar.fire('pointerdown', pointerEvent(200));
  bar.fire('pointermove', pointerEvent(120));
  bar.fire('pointerup', pointerEvent(120));
  check('拖动松手后：第一次 consume 返回 true（吞掉这个 click）', api.consumeArchiveDragClick() === true, '没吞掉，拖完会误展开一颗胶囊');
  check('标记是一次性的：第二次 consume 返回 false', api.consumeArchiveDragClick() === false, '标记没被清掉，下次正常点击会失效');
}
{
  // 拖到栏内空白处松手：浏览器不会补 click，标记会留到下一次按下。
  const { bar, api } = setup();
  bar.fire('pointerdown', pointerEvent(200));
  bar.fire('pointermove', pointerEvent(120));
  bar.fire('pointerup', pointerEvent(120));
  bar.fire('pointerdown', pointerEvent(200)); // 下一次正常点击：按下时先清标记
  check('上次拖到空白处松手留下的标记，在下次按下时被清掉', api.consumeArchiveDragClick() === false, '残留标记会吞掉一次正常点击');
  bar.fire('pointermove', pointerEvent(200));
  bar.fire('pointerup', pointerEvent(200));
  check('不移动的按下-松开：仍然算点击', api.consumeArchiveDragClick() === false, '正常点击被当成拖动');
}

console.log(failures
  ? `\n${failures} 项不满足（共 ${passed + failures} 项）`
  : `\n全部通过：拖动方向正确、松手即停、拖动后的 click 被吞掉（共 ${passed} 项）`);
process.exitCode = failures ? 1 : 0;
