// 面板高度预算的回归检查：
// 「任务树 + 任务清单展开时，消息区被压到看不见对话」这个缺陷的守门人。
//
// 现场二（2026-10-31）：「选择项目会挤压输入框，看不到输入框了」——决策卡片
// （3 个选项 474px）在 footer 里没有上限，430×790 实测消息区被压到 **0px**、
// footer 863px、输入框 top=852 完全落到视口外。修法：输入框以外的面板收进
// `.composer-panels`（自己滚 + 可收缩），footer 整体封顶，输入框 flex: 0 0 auto。
//
// 现场一：768×830 的侧边栏里，两个面板都展开时消息区只剩 264px（占 32%）；
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

/* ── 输入框必须永远留在视口里 ───────────────────────────────────────────── */

const wrap = ruleBody('.composer-wrap');
// footer 必须封顶，否则里面的卡片一高就无上限地顶下去（旧缺陷的直接成因）。
const wrapCap = wrap.match(/max-height:\s*min\((\d+)vh,\s*(\d+)px\)/);
assert.ok(wrapCap, '.composer-wrap 必须封顶（max-height: min(<vh>vh, <px>px)）');
assert.ok(Number(wrapCap[1]) <= 60, `footer 上限 ${wrapCap[1]}vh 太大：56vh 实测消息区 264px，再大对话就看不见了`);
assert.ok(Number(wrapCap[2]) <= 560, `footer 上限 ${wrapCap[2]}px 太大：极高窗口里会重新把对话挤没`);
assert.match(wrap, /display:\s*flex/, 'footer 必须是纵向 flex：靠 flex 才能让面板区收缩、输入框不收缩');
assert.match(wrap, /min-height:\s*0/, 'footer 缺 min-height: 0 时 flex 子项按内容算，压不下去');

// 面板区：可以收缩、自己滚。
const panels = ruleBody('.composer-panels');
assert.match(panels, /flex:\s*0 1 auto/, '面板区必须可收缩（flex: 0 1 auto）');
assert.match(panels, /min-height:\s*0/, '面板区缺 min-height: 0，内容就撑住不缩，滚动条永远不出现');
assert.match(panels, /overflow-y:\s*auto/, '面板区必须自己滚');
assert.match(panels, /overflow-x:\s*hidden/, '面板区不该横向滚');
// 滚动条常显：macOS 覆盖式滚动条不滚就看不见，用户会以为内容被切掉了。
assert.match(CSS, /\.composer-panels::-webkit-scrollbar \{ width:/, '面板区滚动条要常显');

// 输入框不许被压缩。
assert.match(CSS, /\.composer-wrap > \.composer \{ flex: 0 0 auto; \}/, '输入框必须 flex: 0 0 auto：允许收缩就等于允许它消失');

// 矮窗口再让一步。
assert.match(
  CSS,
  /@media \(max-height: 560px\) \{[\s\S]*?\.composer-wrap \{ max-height: 58vh; \}/,
  '矮窗口缺少 footer 让步规则（58vh）',
);

// 结构：决策卡片 / 授权卡片必须在这个可滚动区**里面**，输入框在它外面。
const PANEL_TS = readFileSync('src/views/chatPanel.ts', 'utf8');
const footerStart = PANEL_TS.indexOf('<footer class="composer-wrap">');
const footerBlock = PANEL_TS.slice(footerStart, PANEL_TS.indexOf('</footer>', footerStart));
const areaOpen = footerBlock.indexOf('id="composerPanels"');
const formOpen = footerBlock.indexOf('<form id="composer"');
assert.ok(areaOpen > 0 && areaOpen < formOpen, 'composerPanels 必须在输入框之前打开');
for (const card of ['id="decisionCard"', 'id="approvalCard"', 'id="panelStack"']) {
  const at = footerBlock.indexOf(card);
  assert.ok(at > areaOpen && at < formOpen, `${card} 必须落在 composerPanels 里面（否则它又能把输入框顶出去）`);
}
assert.ok(
  footerBlock.slice(areaOpen, formOpen).trimEnd().endsWith('</div>'),
  'composerPanels 必须在输入框之前关闭',
);
// 标签配平：少一个 </div> 会让输入框被后面的兄弟节点结构吞掉，肉眼很难发现。
const opens = {};
const closes = {};
for (const match of footerBlock.matchAll(/<(\/?)(div|section|form|details)\b[^>]*?>/g)) {
  const key = match[2];
  if (match[1]) closes[key] = (closes[key] ?? 0) + 1;
  else opens[key] = (opens[key] ?? 0) + 1;
}
for (const tag of ['div', 'section', 'form', 'details']) {
  assert.equal(opens[tag] ?? 0, closes[tag] ?? 0, `footer 里 <${tag}> 开闭标签不配平`);
}

/* ── 新卡片要自己滚进可视区 ─────────────────────────────────────────────
   面板区开始自己滚之后，新弹出的卡片可能落在可视区外；用户看到的是「面板闪了一下」，
   却不知道有东西在等他决定。这条行为只能跑代码验，所以从 chat.js 里抽出真实函数。 */
const CHAT_JS = readFileSync('media/chat.js', 'utf8');

/** 取出 chat.js 里一个完整的函数源码（按大括号配平，不是按下一个函数名切）。 */
function functionSource(name) {
  const start = CHAT_JS.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `chat.js 里找不到 ${name}()`);
  let depth = 0;
  for (let index = CHAT_JS.indexOf('{', start); index < CHAT_JS.length; index += 1) {
    const char = CHAT_JS[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return CHAT_JS.slice(start, index + 1);
    }
  }
  throw new Error(`${name}() 的大括号不配平`);
}

const revealFn = new Function(
  'elements',
  `${functionSource('revealInPanelArea')}\nreturn revealInPanelArea;`,
);

/** 用最小 stub 跑真实的 revealInPanelArea，返回滚动后的 scrollTop。 */
function runReveal({ areaTop, areaBottom, rectTop, rectBottom, scrollTop = 0 }) {
  const area = { scrollTop, getBoundingClientRect: () => ({ top: areaTop, bottom: areaBottom }) };
  const element = { getBoundingClientRect: () => ({ top: rectTop, bottom: rectBottom }) };
  revealFn({ composerPanels: area })(element);
  return area.scrollTop;
}

// 完全可见 → 一动不动（不能打断用户自己的滚动）。
assert.equal(runReveal({ areaTop: 200, areaBottom: 600, rectTop: 250, rectBottom: 500, scrollTop: 40 }), 40, '卡片已完整可见时不许滚动');
// 卡片超出下边界 → 把卡片顶部对齐到可视区顶部（问题与第一个选项最要紧）。
assert.equal(runReveal({ areaTop: 200, areaBottom: 600, rectTop: 700, rectBottom: 1000 }), 494, '卡片在下方不可见时应把顶部滚到可视区（700-200-6=494）');
// 卡片在可视区上方 → 同样拉回来。
assert.equal(runReveal({ areaTop: 200, areaBottom: 600, rectTop: 100, rectBottom: 350, scrollTop: 300 }), 194, '卡片在上方不可见时也应拉回（300+(100-200-6)=194）');
// 按 requestId 记账：每帧重发状态时不许反复强行滚动。
assert.match(CHAT_JS, /let revealedDecisionFor = '';/, '必须按 requestId 记住已滚过的卡片');
assert.match(CHAT_JS, /let revealedApprovalFor = '';/, '授权卡片同理');
assert.match(CHAT_JS, /if \(isNewCard\) \{/, '只在换了一张新卡片时滚动');
assert.match(CHAT_JS, /elements\.composerPanels/, 'chat.js 必须引用 composerPanels');

console.log(`✓ 面板区上限 ${cap.vh}vh / ${cap.px}px（不再挤占对话）`);
console.log('✓ 面板自己滚（overflow-y: auto）且不许被压扁（flex: 0 0 auto）');
console.log('✓ 矮窗口另有让步规则（<=560px → 22vh / 180px）');
console.log('✓ 没有给消息区加像素行下限（那会把输入框顶出视口）');
console.log('✓ 消息区滚动 / 关闭滚动锚定 / footer 不裁剪 三条既有约束都在');
console.log('✓ 横向硬边界：app-shell 用 clip 兜住溢出，列表与输入框有 max-width 兜底');
console.log(`✓ footer 封顶 ${wrapCap[1]}vh / ${wrapCap[2]}px：面板再长也顶不掉输入框`);
console.log('✓ 面板区可收缩 + 自己滚，输入框 flex: 0 0 auto 永不收缩');
console.log('✓ 结构：决策/授权卡片在 composerPanels 内，输入框在外，标签配平');
console.log('✓ 新卡片自动滚进可视区，已可见时不打扰用户滚动');
console.log('\n全部通过：面板不会再把对话框挤到看不见');
