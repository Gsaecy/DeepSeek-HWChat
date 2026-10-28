// Skill 勾选：**界面只发意图，勾选归属当前对话**。
//
// 需求：在 HWChat 里取消某个 Skill 的勾选，效果只作用于当前对话；新对话才去读
// 「本地skill快捷调用」扩展里的勾选状态。所以 webview 这边要保证两件事：
//
// 1. 点勾选框只发一条 `toggleSkill`（带 skillId + 目标状态），不自作主张改
//    `state.selectedSkillIds`——界面若自己也维护一份勾选，迟早与扩展侧的存档分叉，
//    用户就会看到「勾选框自己弹回去」或「明明取消了还在跑」。
// 2. 没装快捷调用扩展时**不能**拦着用户勾（勾的是本对话，不需要那个扩展），
//    只在旁边展开安装提示，说明新对话的默认值本该从那里来。
//
// 做法：从 media/chat.js 原样抽出 renderSkills / syncSkillsInstallHint /
// showSkillsInstallHint 三个真函数，配最小 DOM 桩跑真实事件。
//
// 运行：node test/check-skill-toggle.mjs
import { readFileSync } from 'node:fs';

const CHAT_JS_PATH = process.env.HWCHAT_CHAT_JS || 'media/chat.js';
const CHAT_JS = readFileSync(CHAT_JS_PATH, 'utf8');

/* ── 抽取 chat.js 里的真实函数源码 ─────────────────────────── */

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

const renderSkillsSource = extract('renderSkills');
const syncHintSource = extract('syncSkillsInstallHint');
// syncSkillsInstallHint 末尾会调 syncSkillsSourceNote()（底部说明随安装状态切换），
// 漏掉它这段真代码在桩环境里会 ReferenceError —— 以前一直坏在这里。
const syncNoteSource = extract('syncSkillsSourceNote');
const showHintSource = extract('showSkillsInstallHint');

/* ── 断言 ────────────────────────────────────────────────────── */

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`✓ ${label}`); return; }
  failures += 1;
  console.log(`✗ ${label} — ${detail}`);
}

/* ── 最小 DOM 桩（只实现 chat.js 用到的那几个成员） ───────────── */

class ClassList {
  constructor() { this.set = new Set(); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
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
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.dataset = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.textContent = '';
    this.hidden = false;
    this.checked = false;
    this.style = {};
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) {
    if (node && typeof node === 'object') node.parentNode = this;
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) { this.children = []; for (const node of nodes) this.appendChild(node); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  scrollIntoView() {}
  /** 模拟用户点一下：浏览器先把 checked 翻过来，再触发 change。 */
  toggleFromUser() {
    this.checked = !this.checked;
    const handler = this.listeners.get('change');
    if (handler) handler();
  }
}

const document = { createElement: (tag) => new StubNode(tag) };

/* ── 用真实代码块组一个可反复触发的面板 ───────────────────────── */

const sent = [];
const factory = new Function(
  'elements', 'state', 'document', 't', 'textElement', 'post',
  `${renderSkillsSource}\n${syncHintSource}\n${syncNoteSource}\n${showHintSource}\n` +
  'return { renderSkills, syncSkillsInstallHint, syncSkillsSourceNote, showSkillsInstallHint };',
);

function buildPanel({ installed }) {
  const elements = {
    skillsList: new StubNode('div'),
    workspaceTrustBadge: new StubNode('span'),
    skillsPanel: (() => { const node = new StubNode('section'); node.hidden = true; return node; })(),
    skillsInstallHint: (() => { const node = new StubNode('div'); node.hidden = true; return node; })(),
  };
  const state = {
    skills: [
      { id: 'sha-apple', name: 'apple-app-store-rules', description: '规则', relativePath: '~/.copilot/skills/apple/SKILL.md', source: 'copilot', defaultEnabled: true },
      { id: 'sha-workspace', name: 'workspace-skill', description: '本地', relativePath: '.hwchat/skills/a.md', source: 'workspace' },
    ],
    selectedSkillIds: ['sha-apple'],
    workspaceTrusted: true,
    quickLaunchInstalled: installed,
  };
  const ui = factory(
    elements, state, document,
    (key) => key,
    (tag, className, text) => {
      const node = new StubNode(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    },
    (type, payload) => sent.push({ type, payload }),
  );
  return { elements, state, ui };
}

/** 列表里第 index 行的勾选框。 */
function checkboxOf(elements, index) {
  return elements.skillsList.children[index].children[0];
}

/* ── 场景 1：装了扩展 → 只发意图，界面不自己改状态 ───────────── */

{
  sent.length = 0;
  const { elements, state, ui } = buildPanel({ installed: true });
  ui.renderSkills();

  const box = checkboxOf(elements, 0);
  check('渲染时按 selectedSkillIds 打勾', box.checked === true, '第一行（已勾选）应为选中');
  check('未勾选的技能不打勾', checkboxOf(elements, 1).checked === false, '第二行应为未选中');
  check('已安装时不显示安装提示', elements.skillsInstallHint.hidden === true, '提示块应保持隐藏');

  box.toggleFromUser(); // 取消勾选
  check('取消勾选发 toggleSkill 意图', sent.length === 1 && sent[0].type === 'toggleSkill', JSON.stringify(sent));
  check('意图带技能 id 与目标状态', sent[0]?.payload?.skillId === 'sha-apple' && sent[0]?.payload?.enabled === false, JSON.stringify(sent[0]));
  check('界面不擅自改本地状态（等 skillsChanged 回推）', state.selectedSkillIds.length === 1 && state.selectedSkillIds[0] === 'sha-apple', JSON.stringify(state.selectedSkillIds));
  check('未安装提示不会因为取消而弹出', elements.skillsInstallHint.hidden === true, '提示块不该出现');

  sent.length = 0;
  checkboxOf(elements, 1).toggleFromUser();
  check('勾选工作区 Skill 走同一条消息', sent[0]?.payload?.skillId === 'sha-workspace' && sent[0]?.payload?.enabled === true, JSON.stringify(sent[0]));
  check('界面仍然没动本地状态', state.selectedSkillIds.length === 1, JSON.stringify(state.selectedSkillIds));
}

/* ── 场景 2：没装扩展 → 不列技能，只显示安装提示 ────────────────
 *
 * 这是**有意的产品决定**（用户反馈：「本地skill快捷调用」卸载后星标面板里还挂着
 * 一整屏技能 + 「默认启用」打勾，看起来像扩展残留）。所以未安装时面板的职责只有
 * 一个：告诉用户去装那个扩展。装好后 `extensions.onDidChange` 会立刻回推、列表接上。
 */

{
  sent.length = 0;
  const { elements, state, ui } = buildPanel({ installed: false });
  ui.renderSkills();

  check('未安装时不列任何技能', elements.skillsList.children.length === 0 && elements.skillsList.hidden === true, `children=${elements.skillsList.children.length}, hidden=${elements.skillsList.hidden}`);
  check('未安装时展开安装提示（说明装好之后才有列表）', elements.skillsInstallHint.hidden === false, '提示块应可见');
  check('未安装时不发任何勾选意图', sent.length === 0, JSON.stringify(sent));
  check('界面没动本地状态', state.selectedSkillIds.length === 1, JSON.stringify(state.selectedSkillIds));
}

/* ── 场景 3：装上之后重渲染 → 列表与勾选一起接上，提示自动收起 ── */

{
  const { elements, state, ui } = buildPanel({ installed: false });
  ui.renderSkills();
  check('未安装时列表为空', elements.skillsList.children.length === 0);
  state.quickLaunchInstalled = true;        // 用户装完扩展，扩展侧回推 state
  ui.renderSkills();
  check('装上后重渲染：列表回来了', elements.skillsList.children.length === 2 && elements.skillsList.hidden === false, `children=${elements.skillsList.children.length}`);
  check('装上后重渲染：提示收起', elements.skillsInstallHint.hidden === true, '提示块应被收起');
  check('装上后重渲染：勾选状态按 selectedSkillIds 恢复', checkboxOf(elements, 0).checked === true && checkboxOf(elements, 1).checked === false);
}

/* ── 场景 4：源码层 ──────────────────────────────────────────── */

check('chat.js 不再发送 setSkills 整份数组', !CHAT_JS.includes("post('setSkills'"), '仍存在 post(\'setSkills\')');
check('chat.js 的意图消息名是 toggleSkill', CHAT_JS.includes("post('toggleSkill', { skillId: skill.id, enabled: input.checked })"), '找不到 toggleSkill 发送点');
check('未安装分支在发消息之前展开提示、且不 return', !CHAT_JS.includes("      if (skill.source === 'copilot' && !state.quickLaunchInstalled) {\n"), '未安装分支仍在拦截勾选');

console.log('');
if (failures > 0) {
  console.log(`失败 ${failures} 项`);
  process.exit(1);
}
console.log('全部通过');
