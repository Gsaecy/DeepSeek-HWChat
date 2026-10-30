// 面板高度预算的回归检查：
// 「任务树 + 任务清单展开时，消息区被压到看不见对话」这个缺陷的守门人。
//
// 现场：768×830 的侧边栏里，两个面板都展开时消息区只剩 264px（占 32%）；
// 620 高的窗口里只剩 88px（14%），用户反馈「这种状态下界面对话框显示不全」。
// 根因是 `.panel-stack` 的 max-height 取 `min(44vh, 360px)` —— 面板按视口高度
// 要空间，而消息区只能吃剩下的。
//
// 为什么这里只做静态断言：本项目没有浏览器测试依赖。真正的像素测量是用
// headless Chromium 做的（见 CHANGELOG 的实测数据）；这里守住「不许把上限改回去」
// 与「几条约必要的配套规则」，避免以后一次顺手改动又把它调大。
//
// 运行：node test/check-panel-budget.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync('media/chat.css', 'utf8');

/** 取出某个选择器的规则体（只处理本项目里出现的扁平写法）。 */
function ruleBody(selector) {
  const index = CSS.indexOf(`${selector} {`);
  assert.ok(index >= 0, `chat.css 里找不到 ${selector}`);
  const end = CSS.indexOf('}', index);
  return CSS.slice(index, end);
}

/** 把 `min(28vh, 260px)` 拆成 { vh, px }。 */
function parseCap(body, selector) {
  const match = body.match(/max-height:\s*min\((\d+)vh,\s*(\d+)px\)/);
  assert.ok(match, `${selector} 的 max-height 必须写成 min(<vh>vh, <px>px)，实际没匹配到`);
  return { vh: Number(match[1]), px: Number(match[2]) };
}

const stack = ruleBody('.panel-stack');
const cap = parseCap(stack, '.panel-stack');

assert.ok(cap.vh <= 30, `面板区上限 ${cap.vh}vh 太大：以前 44vh 时消息区只剩 14%～32%，最多 30vh`);
assert.ok(cap.px <= 260, `面板区上限 ${cap.px}px 太大：高窗口里同样会把对话挤没`);

// 面板自己必须能滚，否则「上限变小」会把内容直接切掉。
assert.match(stack, /overflow-y:\s*auto/, '面板区必须自己滚');
assert.match(stack, /overflow-x:\s*hidden/, '面板区不该横向滚');
assert.match(stack, /min-height:\s*0/, 'flex 子项的 min-height 默认 auto，不写 0 就压不下去');

// 面板自己的滚动依赖「不许被压扁」：这三项若回到 flex-shrink:1，
// 浏览器会把每个面板压缩到容器高度，容器永不溢出，滚动条也就不出现。
assert.match(CSS, /\.panel-stack > \* \{ flex: 0 0 auto; \}/, '面板必须固定为内容高度，否则内部滚动失效');

// 矮窗口要再让一步（480 高的窗口实测 28vh 只剩 21%）
assert.match(
  CSS,
  /@media \(max-height: 560px\) \{\s*\.panel-stack \{ max-height: min\(22vh, 180px\); \}/,
  '缺少矮窗口的让步规则',
);

// 被否掉的方案要留痕：给消息区加行下限会把输入框顶出视口（430×480 实测），比消息区小更糟。
assert.equal(
  /grid-template-rows:\s*auto minmax\(\d+px, 1fr\) auto/.test(CSS),
  false,
  '不要给 .chat-pane 的行加像素下限：实测会把输入框挤出视口',
);

// 消息区自己管滚动，这两条是既有的硬要求（见那里的注释）。
const viewport = ruleBody('.message-viewport');
assert.match(viewport, /overflow:\s*auto/);
assert.match(viewport, /overflow-anchor:\s*none/);

// 输入框必须始终留在视口内：它所在的 footer 只允许面板区滚，不允许自己溢出。
const composerWrap = ruleBody('.composer-wrap');
assert.equal(/overflow:\s*hidden/.test(composerWrap), false, 'footer 不能裁剪，否则输入框会被切掉');

// 硬边界：任何子内容都不许把文档撑宽（否则右侧内容会被窗口裁掉，且 macOS 的
// 覆盖式滚动条不滚动时不显示，看起来就是「显示不全、又没有横向滚动条」）。
const shell = ruleBody('.app-shell');
assert.match(shell, /overflow-x:\s*clip/, '.app-shell 必须用 overflow-x: clip 兜住横向溢出');
assert.match(shell, /max-width:\s*100%/, '.app-shell 不该超过 100% 宽');
assert.equal(/overflow-x:\s*hidden/.test(shell), false, '用 clip 而不是 hidden：hidden 会建立滚动容器，里面 absolute 浮层定位会变');
const area = ruleBody('.message-area');
assert.match(area, /min-width:\s*0/, '.message-area 缺 min-width: 0 时最小尺寸按内容算，会被长内容顶宽');
assert.match(ruleBody('.message-list'), /max-width:\s*100%/, '.message-list 需要 max-width 兜底');
assert.match(ruleBody('.composer-wrap'), /max-width:\s*100%/, '.composer-wrap 需要 max-width 兜底');

console.log(`✓ 面板区上限 ${cap.vh}vh / ${cap.px}px（不再挤占对话）`);
console.log('✓ 面板自己滚（overflow-y: auto）且不许被压扁（flex: 0 0 auto）');
console.log('✓ 矮窗口另有让步规则（<=560px → 22vh / 180px）');
console.log('✓ 没有给消息区加像素行下限（那会把输入框顶出视口）');
console.log('✓ 消息区滚动 / 关闭滚动锚定 / footer 不裁剪 三条既有约束都在');
console.log('✓ 横向硬边界：app-shell 用 clip 兜住溢出，列表与输入框有 max-width 兜底');
console.log('\n全部通过：面板不会再把对话框挤到看不见');
