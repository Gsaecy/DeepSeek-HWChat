// 项目徽标「显示多个项目」的真实验证。
//
// 现场故障：在 A 项目里做功能、顺手把 B 项目的对接改掉，标题旁却始终只显示一个
// 项目名——用户看不出这条对话动过别处，也发现不了自己改到了别的项目。
//
// 两段验证：
//  1. 从 media/chat.js 原样抽出 renderProjectBadge，配最小 DOM 跑真实渲染；
//  2. 源码级断言：每次落盘都要上报项目根，且上报的项目必须真的被记进对话存档。
//
// 运行：node test/check-project-badge.mjs
import { readFileSync } from 'node:fs';

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const TOOL_EXECUTOR = readFileSync('src/agent/toolExecutor.ts', 'utf8');
const STORAGE = readFileSync('src/core/storage.ts', 'utf8');

/* ── 最小 DOM ────────────────────────────────────────────────── */

class ClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const name of names) this.set.add(name); }
  remove(...names) { for (const name of names) this.set.delete(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
}

class StubNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.classList = new ClassList();
    this.title = '';
    this.textContent = '';
    this.hidden = false;
  }
}

const elements = { projectBadge: new StubNode('span') };
const state = { project: { name: null, others: [], bound: false } };
const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

/** 数大括号取出一段函数源码（与 check-title-editing.mjs 同一套做法）。 */
function extractBlock(sourceText, needle) {
  let start = sourceText.indexOf(needle);
  if (start < 0) throw new Error(`chat.js 里找不到代码块：${needle}`);
  while (start < sourceText.length && (sourceText[start] === '\n' || sourceText[start] === '\r')) start += 1;
  const lines = sourceText.slice(start).split('\n');
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

const source = extractBlock(CHAT_JS, '\n  function renderProjectBadge(').replace(/^\n/, '');
const ui = new Function('elements', 'state', 't', `${source}\n return { renderProjectBadge };`)(elements, state, t);

/* ── 断言 ────────────────────────────────────────────────────── */

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`✓ ${label}`); return; }
  failures += 1;
  console.log(`✗ ${label} — ${detail}`);
}

const badge = elements.projectBadge;

/* 1. 单个项目：和以前完全一样，只显示文件夹名。 */
state.project = { name: 'DeepSeek-HWChat', others: [], bound: true };
ui.renderProjectBadge();
check('单个项目：只显示项目名', badge.textContent === 'DeepSeek-HWChat', badge.textContent);
check('单个项目：不带 multi 类', !badge.classList.contains('multi'), '误加 multi 类');

/* 2. 两个项目：两个名字都要显示——这正是用户报的那条。 */
state.project = { name: 'DeepSeek-HWChat', others: ['Local_skill_quick_access'], bound: true };
ui.renderProjectBadge();
check(
  '两个项目：两个名字都显示',
  badge.textContent === 'DeepSeek-HWChat · Local_skill_quick_access',
  badge.textContent,
);
check('两个项目：挂上 multi 类', badge.classList.contains('multi'), '缺 multi 类');
check('两个项目：仍然带 bound 类', badge.classList.contains('bound'), '缺 bound 类');
check('两个项目：悬停提示列出全部项目', badge.title.includes('Local_skill_quick_access') && badge.title.includes('DeepSeek-HWChat'), badge.title);

/* 3. 很多项目：一行放不下时折成 +N，完整清单进 title。 */
const many = ['DeepSeek-HWChat', 'Local_skill_quick_access', 'MaiKer_Win', 'LazyDesktopAI', 'hongyuguo.com'];
state.project = { name: many[0], others: many.slice(1), bound: true };
ui.renderProjectBadge();
check('多个项目：前三个名字可见', badge.textContent === 'DeepSeek-HWChat · Local_skill_quick_access · MaiKer_Win +2', badge.textContent);
check('多个项目：折起来的名字不能只存在于 +N 里', many.every((name) => badge.title.includes(name)), badge.title);

/* 4. 未绑定：仍然是红字「项目待建立」，不能因为多了 others 就变成已绑定。 */
state.project = { name: null, others: [], bound: false };
ui.renderProjectBadge();
check('未绑定：显示「项目待建立」', badge.textContent === 'chat.projectPending', badge.textContent);
check('未绑定：挂上 missing 类', badge.classList.contains('missing'), '缺 missing 类');
check('未绑定：不带 bound / multi 类', !badge.classList.contains('bound') && !badge.classList.contains('multi'), '多挂了类');
check('未绑定：徽标仍然可见', badge.hidden === false, '徽标被隐藏');

/* 5. 列表里混进脏值时不能渲染出空名字。 */
state.project = { name: 'DeepSeek-HWChat', others: ['', null, 42, 'MaiKer_Win'], bound: true };
ui.renderProjectBadge();
check('脏值被过滤，只显示合法项目名', badge.textContent === 'DeepSeek-HWChat · MaiKer_Win', badge.textContent);

/* ── 接线断言：上报链路必须真的接上 ───────────────────────────── */

// 工具执行器：每个写盘分支都要在上报项目根（写/改/移/删 + git 写命令）。
const recordCalls = (TOOL_EXECUTOR.match(/this\.recordProjectRoot\(/g) || []).length;
check('工具执行器：写/改/移/删/命令都上报项目根', recordCalls >= 5, `只找到 ${recordCalls} 处 recordProjectRoot 调用`);
check('工具执行器：上报发生在改动成功之后（写文件后）', /writeFile\(resolved\.uri, new TextEncoder\(\)\.encode\(content\)\);\n\s*invalidateWorkspaceSearch\(\);\n\s*this\.recordProjectRoot\(scope, resolved\);/.test(TOOL_EXECUTOR), '写文件处没有在上报');
check('工具执行器：被拒绝的写操作不上报', !/assertWritable\(resolved, settings\);\n\s*this\.recordProjectRoot/.test(TOOL_EXECUTOR), '上报被放到了写盘之前');
check('工具执行器：只读命令不算改过项目', /if \(gitWrite && result\.code === 0\) this\.recordProjectRoot/.test(TOOL_EXECUTOR), '命令上报缺成功判定');

// 面板：作用域里必须传 touchProjectRoot，否则上面的回调全是空调用。
check('面板：作用域传了 touchProjectRoot', /touchProjectRoot: \(fsPath\) => this\.touchProjectRoot\(conversationId!?/.test(CHAT_PANEL), '作用域里没有 touchProjectRoot');
check('面板：追加项目时读的是存档里的现值', /const existing = conversation\.projectRoots \?\? \[\];/.test(CHAT_PANEL), '没有读存档现值');
check('面板：主项目不重复入库', /if \(conversation\.projectRoot && resolve\(conversation\.projectRoot\) === target\) return;/.test(CHAT_PANEL), '缺主项目去重');
check('面板：徽标用 involvedProjectRoots 汇总', /involvedProjectRoots\(\{/.test(CHAT_PANEL), '徽标没走 involvedProjectRoots');
check('面板：老对话从 changedFiles 反推项目', /rootsFromChangedFiles\(\{/.test(CHAT_PANEL), '缺老对话反推');
check('面板：sendState 把消息一起交给徽标', /this\.projectBadgeFor\(conversation, page\.messages\)/.test(CHAT_PANEL), 'sendState 没传消息');

// 存档：projectRoots 必须能被写入，否则面板追加的请求会被静默丢掉。
check('存档：补丁类型放行 projectRoots', /'projectRoots'/.test(STORAGE), '补丁类型里没有 projectRoots');
check('存档：读盘时归一化 projectRoots', /normalizeProjectRoots\(withIncomplete\.projectRoots\)/.test(STORAGE), '读盘没有归一化');
check('存档：projectRoots 只认绝对路径', /if \(!text \|\| !isAbsolute\(text\)\) continue;/.test(STORAGE), '没有绝对路径校验');

// webview：state 接收端必须带上 others，否则渲染函数永远拿到 undefined。
check('webview：接收 others', /others: Array\.isArray\(incoming\.project\.others\)/.test(CHAT_JS), '接收端没读 others');

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
