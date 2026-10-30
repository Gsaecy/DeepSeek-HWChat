// 布局「不许被子内容撑宽」的回归检查。
//
// 现场（用户反馈两轮，其实是同一个根因）：
//   1. 「任务清单收纳胶囊往左拖到滚不动为止，右侧的胶囊还是被截断」；
//   2. 「对话框会被截断」——正文被横向推走，左边一截看不见。
//
// 根因不是胶囊栏本身，而是**它所在的网格容器允许自己被内容撑宽**：
// `.chat-pane` 只声明了 `grid-template-rows`，唯一的**隐式列**是 `auto`，
// 于是会被最宽的子元素按 max-content 撑开。headless Chromium 实测（视口 870）：
// 归档胶囊 40 颗时，这一列从 602px 涨到 **1387.59px**，`.composer-wrap` 被推到
// left=537 → 右侧 514px 落在视口外；而 `.app-shell` 是 `overflow-x: clip`
// （不建立滚动容器、没有滚动条），那段内容**永远无法通过滚动看到**。
// 胶囊栏自身能滚到最右，但它整体已经在视口外，于是「滚到头也还是被切」。
//
// 修法是把列宽显式压成 `minmax(0, 1fr)`（`.chat-pane` / `.message-area`），
// 横向滚动交还给真正该负责的元素（`.todo-archive-bar`、`.message-viewport`）。
//
// 为什么这里只做静态断言：本项目没有浏览器测试依赖。像素级验证是用 headless
// Chromium 做的（360/420/480/570/640/720/800/870/900/1100/1400 共 11 档，见 CHANGELOG）；
// 这里守住「列宽必须被压住」这条不变量，防止以后一次顺手改动又把它去掉。
//
// 运行：node test/check-layout-containment.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync('media/chat.css', 'utf8');
/** 先把注释去掉：注释里也会出现「.selector {」这样的示例写法，naive indexOf 会扑空。 */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selector) {
  const index = CODE.indexOf(`${selector} {`);
  assert.ok(index >= 0, `chat.css 里找不到 ${selector} 的规则`);
  const end = CODE.indexOf('}', index);
  return CODE.slice(index, end);
}

/** 断言某个网格容器的列宽被压成 `minmax(0, 1fr)`（而不是隐式 auto）。 */
function assertConstrainedColumn(selector, why) {
  const body = ruleBody(selector);
  assert.match(body, /display:\s*grid/, `${selector} 应该是 grid`);
  assert.match(
    body,
    /grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/,
    `${selector} 必须声明 grid-template-columns: minmax(0, 1fr)。${why}`,
  );
}

assertConstrainedColumn('.chat-pane', '否则最宽的子元素会把整列按 max-content 撑出视口，然后被 app-shell 的 overflow-x: clip 永久裁掉。');
assertConstrainedColumn('.message-area', '否则一段超长内容会把消息区整列撑宽、把正文横向推走（用户看到的「对话框被截断」）。');

// 硬边界仍在：clip 而不是 hidden —— 不建立滚动容器，absolute/sticky 浮层定位不受影响。
const shell = ruleBody('.app-shell');
assert.match(shell, /overflow-x:\s*clip/, '.app-shell 的横向硬边界必须是 clip（hidden 会让内部浮层定位出错）');
assert.match(shell, /max-width:\s*100%/, '.app-shell 必须有 max-width: 100%');

// 胶囊栏：不允许用左右外边距 + width:100% 做内缩（那会让整条栏比父容器宽 4px），
// 且必须自己带横向滚动与末尾留白。
const bar = ruleBody('.todo-archive-bar');
assert.match(bar, /max-width:\s*100%/, '归档栏必须 max-width: 100%，不许比父容器宽');
assert.match(bar, /padding:\s*0 2px/, '归档栏的左右内缩要用 padding（右内边距同时充当末尾留白）');
assert.doesNotMatch(bar, /margin:\s*0 2px/, '归档栏不能用左右外边距做内缩：width:100% + 2px 外边距会超出父容器 4px');
assert.match(bar, /overflow-x:\s*auto/, '归档栏要自己横向滚动');
assert.match(bar, /box-sizing:\s*border-box/, '归档栏要 border-box，宽度才等于父容器内容宽');

// 消息区自己管滚动，且不许有横向滚动（正文靠换行，不靠横滚）。
const viewport = ruleBody('.message-viewport');
assert.match(viewport, /overflow:\s*auto/, '.message-viewport 负责消息区的滚动');

console.log('布局收纳检查通过：chat-pane / message-area 的列宽被压住，归档栏不超出父容器。');
