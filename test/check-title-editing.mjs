// 标题编辑与项目徽标的真实验证：
// 从 media/chat.js 里原样抽出 renderProjectBadge / startTitleEdit / finishTitleEdit / syncSkillsButton，
// 配一个最小 DOM 跑一遍用户描述的操作序列。
//
// 为什么不用 jsdom：项目没有 DOM 测试依赖，这几个函数只需要 hidden / value / classList / focus，
// 最小实现足够，且不引入新依赖。
//
// 运行：node test/check-title-editing.mjs
import { readFileSync } from 'node:fs';

const CHAT_JS = readFileSync('media/chat.js', 'utf8');

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
    this.attributes = new Map();
    this.title = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.focused = false;
    this.selected = false;
    this.children = [];
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}

const elements = {
  conversationTitle: new StubNode('strong'),
  conversationTitleInput: new StubNode('input'),
  projectBadge: new StubNode('span'),
  editTitleButton: new StubNode('button'),
  saveTitleButton: new StubNode('button'),
  cancelTitleButton: new StubNode('button'),
  skillsCount: new StubNode('span'),
  skillsButton: new StubNode('button'),
};

const state = {
  conversation: null,
  titleEditing: false,
  project: { name: null, bound: false },
  selectedSkillIds: [],
};

const posted = [];
const post = (type, payload = {}) => { posted.push({ type, ...payload }); };
const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

/* ── 抽取 chat.js 里的函数源码 ───────────────────────────────── */

/** 数大括号取出一段代码（从给定起点行开始）。 */
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

function extract(name) {
  return extractBlock(CHAT_JS, `\n  function ${name}(`).replace(/^\n/, '');
}

const source = ['renderProjectBadge', 'startTitleEdit', 'finishTitleEdit', 'syncSkillsButton']
  .map(extract)
  .join('\n\n');

const factory = new Function(
  'elements', 'state', 'post', 't',
  `${source}
   return { renderProjectBadge, startTitleEdit, finishTitleEdit, syncSkillsButton };`,
);

const ui = factory(elements, state, post, t);

/* ── 断言 ────────────────────────────────────────────────────── */

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`✓ ${label}`); return; }
  failures += 1;
  console.log(`✗ ${label} — ${detail}`);
}

function reset() {
  posted.length = 0;
  state.titleEditing = false;
  elements.conversationTitle.hidden = false;
  elements.conversationTitleInput.hidden = true;
  elements.conversationTitleInput.value = '';
  elements.editTitleButton.hidden = false;
  elements.saveTitleButton.hidden = true;
  elements.cancelTitleButton.hidden = true;
}

/* 1. 项目徽标：已绑定 → 文件夹名（橙色类）；未绑定 → 红字「项目待建立」。 */
state.project = { name: 'DeepSeek-HWChat', bound: true };
ui.renderProjectBadge();
check('项目已绑定：徽标显示文件夹名', elements.projectBadge.textContent === 'DeepSeek-HWChat', elements.projectBadge.textContent);
check('项目已绑定：挂上 bound 类（CSS 用橙色）', elements.projectBadge.classList.contains('bound'), '缺 bound 类');
check('项目已绑定：不带 missing 类', !elements.projectBadge.classList.contains('missing'), '仍带 missing 类');
check('项目已绑定：徽标可见', elements.projectBadge.hidden === false, '徽标被隐藏');
check('项目已绑定：悬停提示带项目名', elements.projectBadge.title.includes('DeepSeek-HWChat'), elements.projectBadge.title);

state.project = { name: null, bound: false };
ui.renderProjectBadge();
check('项目未绑定：显示「项目待建立」文案', elements.projectBadge.textContent === 'chat.projectPending', elements.projectBadge.textContent);
check('项目未绑定：挂上 missing 类（CSS 用红色）', elements.projectBadge.classList.contains('missing'), '缺 missing 类');
check('项目未绑定：不带 bound 类', !elements.projectBadge.classList.contains('bound'), '仍带 bound 类');
check('项目未绑定：徽标仍然可见（不能静默隐藏）', elements.projectBadge.hidden === false, '徽标被隐藏');

/* 2. 进入编辑：只切显示，不发请求。 */
reset();
state.conversation = { id: 'conv_1', title: '原来的标题' };
ui.startTitleEdit();
check('进入编辑：输入框显示', elements.conversationTitleInput.hidden === false, '输入框仍隐藏');
check('进入编辑：标题隐藏', elements.conversationTitle.hidden === true, '标题仍显示');
check('进入编辑：输入框预填当前标题', elements.conversationTitleInput.value === '原来的标题', elements.conversationTitleInput.value);
check('进入编辑：铅笔按钮隐藏', elements.editTitleButton.hidden === true, '铅笔仍显示');
check('进入编辑：对勾与叉出现', elements.saveTitleButton.hidden === false && elements.cancelTitleButton.hidden === false, '确认按钮未出现');
check('进入编辑：输入框已聚焦并全选', elements.conversationTitleInput.focused && elements.conversationTitleInput.selected, '未聚焦/未全选');
check('进入编辑：不发任何请求', posted.length === 0, JSON.stringify(posted));

/* 3. 点叉 / Esc：放弃，不发请求，保留原标题。 */
elements.conversationTitleInput.value = '改了一半就不要了';
ui.finishTitleEdit(false);
check('放弃编辑：不发请求', posted.length === 0, JSON.stringify(posted));
check('放弃编辑：标题恢复显示', elements.conversationTitle.hidden === false, '标题仍隐藏');
check('放弃编辑：输入框隐藏', elements.conversationTitleInput.hidden === true, '输入框仍显示');
check('放弃编辑：对勾与叉收起', elements.saveTitleButton.hidden === true && elements.cancelTitleButton.hidden === true, '确认按钮仍显示');
check('放弃编辑：铅笔按钮回来', elements.editTitleButton.hidden === false, '铅笔仍隐藏');

/* 4. 点对勾：发请求，标题去掉首尾空白。 */
reset();
ui.startTitleEdit();
elements.conversationTitleInput.value = '  新标题  ';
ui.finishTitleEdit(true);
check('确认编辑：发出 renameConversation', posted.length === 1 && posted[0].type === 'renameConversation', JSON.stringify(posted));
check('确认编辑：带上当前对话 id', posted[0]?.id === 'conv_1', String(posted[0]?.id));
check('确认编辑：标题已去首尾空白', posted[0]?.title === '新标题', String(posted[0]?.title));
check('确认编辑：退出编辑态', elements.conversationTitleInput.hidden === true && elements.editTitleButton.hidden === false, '仍停在编辑态');

/* 5. 没改动 / 空标题：退出编辑但不打扰用户。 */
reset();
posted.length = 0;
ui.startTitleEdit();
elements.conversationTitleInput.value = '原来的标题';
ui.finishTitleEdit(true);
check('标题没改动：不发请求', posted.length === 0, JSON.stringify(posted));

reset();
posted.length = 0;
ui.startTitleEdit();
elements.conversationTitleInput.value = '   ';
ui.finishTitleEdit(true);
check('空标题：不发请求（不会把标题清空）', posted.length === 0, JSON.stringify(posted));

/* 6. 草稿（还没有对话）不能改名：按钮从源头挡住。 */
reset();
state.conversation = null;
ui.startTitleEdit();
check('草稿：startTitleEdit 不进入编辑态', state.titleEditing === false && elements.conversationTitleInput.hidden === true, '进入了编辑态');
check('草稿：不发请求', posted.length === 0, JSON.stringify(posted));

/* 7. skills 按钮只留图标后，数量必须还在提示里。 */
state.selectedSkillIds = [];
ui.syncSkillsButton();
check('skills 无选中：提示为「选择 Skill」', elements.skillsButton.title === 'chat.selectSkill', elements.skillsButton.title);
check('skills 无选中：不点亮按钮', !elements.skillsButton.classList.contains('active'), '仍点亮');

state.selectedSkillIds = ['a', 'b', 'c'];
ui.syncSkillsButton();
check('skills 有选中：提示里带数量', elements.skillsButton.title.includes('3'), elements.skillsButton.title);
check('skills 有选中：aria-label 同样带数量', String(elements.skillsButton.getAttribute('aria-label')).includes('3'), String(elements.skillsButton.getAttribute('aria-label')));
check('skills 有选中：点亮按钮', elements.skillsButton.classList.contains('active'), '未点亮');
check('skills 有选中：隐藏的计数元素仍被更新', elements.skillsCount.textContent === '3', elements.skillsCount.textContent);

/* 8. 项目徽标必须挂在状态行里，不能回到标题行。
   需求：标题行只放标题和编辑按钮，项目名显示在「准备就绪 · N 个工具」那一行。
   这条读 chatPanel.ts 的 HTML 模板，防止以后调版式时把徽标挪回去。 */
const PANEL_TS = readFileSync('src/views/chatPanel.ts', 'utf8');
const statusLineAt = PANEL_TS.indexOf('class="conversation-status-line"');
const titleLineAt = PANEL_TS.indexOf('class="conversation-title-line"');
const badgeAt = PANEL_TS.indexOf('id="projectBadge"');
const connectionAt = PANEL_TS.indexOf('id="connectionState"');
check('模板里有状态行容器', statusLineAt > -1, '缺 conversation-status-line');
check('模板里有徽标元素', badgeAt > -1, '缺 projectBadge');
check('徽标在状态行容器之后', badgeAt > statusLineAt, `徽标(${badgeAt}) 在状态行(${statusLineAt}) 之前`);
check('徽标在标题行容器之后', badgeAt > titleLineAt, `徽标(${badgeAt}) 在标题行(${titleLineAt}) 之前`);
check('徽标和连接状态在同一行容器内（中间没有别的闭合容器）',
  badgeAt > connectionAt && PANEL_TS.slice(connectionAt, badgeAt).includes('projectBadge') === false,
  '连接状态与徽标不在同一行');
check('徽标紧跟连接状态（中间不插入卡片/按钮）',
  !/id="connectionState"[\s\S]{0,120}?<(button|div[^>]*class="[^"]*title-line)/.test(PANEL_TS),
  '连接状态与徽标之间插了别的元素');

/* 9. CSS：状态行必须是 flex 行，徽标在状态行里右对齐且不吃掉状态文字。 */
const CSS = readFileSync('media/chat.css', 'utf8');
check('CSS 有状态行规则', /\.conversation-status-line\s*\{[^}]*display:\s*flex/.test(CSS), '缺 .conversation-status-line flex 规则');
check('CSS 状态文字可省略', /\.conversation-status-line\s*>\s*#connectionState\s*\{[^}]*text-overflow:\s*ellipsis/.test(CSS), '状态文字没有省略处理');
/* 项目标签：纯文字、左对齐、与状态文字固定间距。 */
const badgeRule = (CSS.match(/\.conversation-heading \.project-badge\s*\{[^}]*\}/) || [''])[0];
check('项目标签是纯文字（无边框 / 背景 / 圆角 / 内边距）',
  /border:\s*0/.test(badgeRule) && /background:\s*none/.test(badgeRule)
  && /border-radius:\s*0/.test(badgeRule) && /padding:\s*0/.test(badgeRule),
  badgeRule);
check('项目标签不再向右推（左对齐，紧跟状态文字）',
  !/margin-left:\s*auto/.test(badgeRule), badgeRule);
check('状态行左对齐（不走 space-between，也不靠右）',
  /\.conversation-status-line\s*\{[^}]*justify-content:\s*flex-start/.test(CSS), '状态行不是左对齐');
check('状态文字与项目标签之间有固定间距',
  /\.conversation-status-line\s*\{[^}]*gap:\s*8px/.test(CSS), '间距不是固定的 8px');

/* 10. 控件行的宽度与间距。
   历史问题一：模型框曾是 flex:1 1 auto，把整行剩余宽度全吸走（箭头离文字很远）。
   历史问题二：控件被三组 control-group 包装，组内固定 gap + margin-left:auto，
   导致下拉框之间、刷新↔图标之间、图标之间的间距各不相同。
   现在改为「扁平化 + space-between」：所有控件都是 .toolbar-controls 的直接子项，
   剩余宽度被平均分到每两个相邻控件之间，所以任意相邻两个控件的距离恒等（两端对齐）。
   这里锁住三件事：宽度由内容决定、控件行两端对齐、控件没有被分组包装。 */
const rulesOf = (selector) => [...CSS.matchAll(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`, 'g'))].map((m) => m[0]);
/* 同名的 .model-field 有两条（共用定位规则 + 单独的宽度规则），取带 flex 的那条。 */
const pickWidthRule = (rules) => rules.find((rule) => /flex:/.test(rule)) || rules[rules.length - 1] || '';
const modelRule = pickWidthRule(rulesOf('.model-field'));
const profileRule = pickWidthRule(rulesOf('.profile-field'));
const modeRule = pickWidthRule(rulesOf('.mode-field'));
check('模式控件宽度按内容定（Agent 约 55px → 60px）', /width:\s*60px/.test(modeRule), modeRule);
check('供应商控件宽度按内容定（DeepSeek 约 73px → 82px）', /width:\s*82px/.test(profileRule), profileRule);
check('模型控件宽度按内容定（19 字符约 139px → 150px）', /width:\s*150px/.test(modelRule), modelRule);
check('三个下拉框都不许吸收剩余宽度（flex-grow 必须为 0）',
  [modeRule, profileRule, modelRule].every((rule) => /flex:\s*0\s+1\s+auto/.test(rule)),
  [modeRule, profileRule, modelRule].join(' | '));
check('控件行两端对齐（space-between：相邻控件等距）',
  /\.toolbar-controls\s*\{[^}]*justify-content:\s*space-between/.test(CSS), '控件行不是 space-between');
check('控件不再被分组包装（有包装时 space-between 只在组间分配，间距仍不等）',
  !/\.(?:mode|connection|utility|control)-group\s*\{/.test(CSS), '分组规则还留在 css 里');
const toolbarBlock = (PANEL_TS.match(/<div class="toolbar-controls">[\s\S]*?<section id="skillsPanel"/) || [''])[0];
check('HTML 里控件是 .toolbar-controls 的直接子项（没有 control-group 包装）',
  toolbarBlock.length > 0 && !/control-group/.test(toolbarBlock),
  toolbarBlock ? 'chatPanel.ts 的控件行仍有 control-group 包装' : '没找到 toolbar-controls 区块');
check('间距只有一个来源 --control-gap',
  /--control-gap:\s*6px/.test(CSS)
  && /\.toolbar-controls\s*\{[^}]*gap:\s*var\(--control-gap\)/.test(CSS),
  '行间距不是 --control-gap');
check('行内间距没有被改成写死的数字（以前窄屏是 4px）',
  !/\.toolbar-controls\s*\{[^}]*gap:\s*\d/.test(CSS), 'toolbar-controls 出现了写死的数字间距');
check('控件行没有 margin-left:auto（会造出一段比别人大的间距）',
  !/\.toolbar-controls\s*\{[^}]*margin-left:\s*auto/.test(CSS), '控件行仍有 margin-left:auto');
check('下拉箭头到控件右边缘距离固定', /\.mode-field::after[\s\S]{0,200}?right:\s*5px/.test(CSS), '箭头位置不是固定的 5px');
check('下拉箭头与文字的内边距固定', /\.model-field select[\s\S]{0,220}?padding:\s*0 19px 0 6px/.test(CSS), '内边距不是固定的 19px/6px');

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
