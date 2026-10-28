// 工具条「最大步骤 / 思考深度」两列的真实渲染验证。
//
// 现场：两列的可选值各改过一次——步数从 12/24/40/80/120 改成 24/68/120/无限制，
// 思考深度从 默认/无/低/高/最大值 改成 低/中/高/最大。这类改动最容易出的问题是
// 「HTML 里的选项改了、media/chat.js 里的归一化没跟上」：选了「无限制」显示 0 步，
// 或者旧对话的 'none' 让下拉框变成空白。
//
// 两段验证：
//  1. 从 media/chat.js 原样抽出 syncReasoningSelector / normalizeStepValue /
//     stepsLabel / ensureStepOption / replaceSelectOptions，配最小 DOM 跑真实逻辑；
//  2. 源码级断言：两列选项必须来自同一份预设常量，且文案是四档中文。
//
// 运行：node test/check-runtime-controls.mjs
import { readFileSync } from 'node:fs';

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const SETTINGS_PANEL = readFileSync('src/views/settingsPanel.ts', 'utf8');
const LIMITS = readFileSync('src/core/agentLimits.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

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

/* ── 最小 DOM ────────────────────────────────────────────────── */

class StubSelect {
  constructor() {
    this.options = [];
    this.dataset = {};
    this.value = '';
    this.title = '';
  }
  replaceChildren(...nodes) { this.options = [...nodes]; }
  append(node) { this.options.push(node); }
}

const elements = {
  reasoningEffortInput: new StubSelect(),
  agentMaxStepsInput: new StubSelect(),
  // syncReasoningSelector 在拿不到 modelOption 时会回读 modelInput 的当前值。
  modelInput: { value: 'deepseek-flash' },
};
const state = { reasoningEffort: 'high', model: 'deepseek-flash', modelOptionsByProfile: {}, activeApiProfileId: 'default', conversation: null };
// t 直接回显 key：断言的是「选了哪一档文案」，不是文案内容本身。
const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
const document = { createElement: (tag) => ({ tagName: String(tag).toUpperCase(), value: '', textContent: '' }) };

/** 数大括号取出一段函数源码（与 check-project-badge.mjs 同一套做法）。 */
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

function extractFunction(name) {
  return extractBlock(CHAT_JS, `\n  function ${name}(`);
}

// REASONING_DEPTHS / STEPS_UNLIMITED 是 IIFE 里的字面量常量：直接取出真实定义，
// 不要在脚本里另抄一份，否则改了 chat.js 这里还在自娱自乐。
const depthsMatch = CHAT_JS.match(/const REASONING_DEPTHS = \[([^\]]+)\];/);
if (!depthsMatch) throw new Error('chat.js 里找不到 REASONING_DEPTHS');
const unlimitedMatch = CHAT_JS.match(/const STEPS_UNLIMITED = ([^;]+);/);
if (!unlimitedMatch) throw new Error('chat.js 里找不到 STEPS_UNLIMITED');

const prelude = `const REASONING_DEPTHS = [${depthsMatch[1]}];\nconst STEPS_UNLIMITED = ${unlimitedMatch[1]};`;
const body = [
  'replaceSelectOptions',
  'syncReasoningSelector',
  'normalizeStepValue',
  'stepsLabel',
  'ensureStepOption',
].map(extractFunction).join('\n\n');

const ui = new Function(
  'elements', 'state', 't', 'document',
  `${prelude}\n${body}\n return { syncReasoningSelector, normalizeStepValue, stepsLabel, ensureStepOption, REASONING_DEPTHS, STEPS_UNLIMITED };`,
)(elements, state, t, document);

/* ── ① 思考深度：四档，且旧值落到「高」 ───────────────────────── */

check('chat.js 的四档深度就是 low/medium/high/max', JSON.stringify(ui.REASONING_DEPTHS) === JSON.stringify(['low', 'medium', 'high', 'max']), `实测 ${JSON.stringify(ui.REASONING_DEPTHS)}`);
check('chat.js 的「无限制」表示值是 0', ui.STEPS_UNLIMITED === 0);

state.reasoningEffort = 'high';
state.modelOptionsByProfile = { default: [{ id: 'deepseek-flash', reasoningSupport: 'configurable', reasoningEfforts: ['low', 'medium', 'high', 'max'] }] };
ui.syncReasoningSelector();
const depthValues = elements.reasoningEffortInput.options.map((option) => option.value);
check('可调模型的下拉框只有四档深度', JSON.stringify(depthValues) === JSON.stringify(['low', 'medium', 'high', 'max']), `实测 ${JSON.stringify(depthValues)}`);
check('四档文案走 chat.reasoning.* 键', JSON.stringify(elements.reasoningEffortInput.options.map((option) => option.textContent)) === JSON.stringify(['chat.reasoning.low', 'chat.reasoning.medium', 'chat.reasoning.high', 'chat.reasoning.max']), `实测 ${JSON.stringify(elements.reasoningEffortInput.options.map((option) => option.textContent))}`);
check('可调模型的下拉框可用（dataset.support = configurable）', elements.reasoningEffortInput.dataset.support === 'configurable');
check('当前值 high 被正确选中', elements.reasoningEffortInput.value === 'high');

// 旧对话存着 'none' / 'default'：这两档已不在四档深度里，但不能静默改成「高」
// （那等于替用户打开思考、多花 token）。它们要原样保留并临时显示出来，
// 避免 select.value 被赋成不存在的值而显示空白。
for (const legacy of ['none', 'default']) {
  state.reasoningEffort = legacy;
  state.modelOptionsByProfile = { default: [{ id: 'deepseek-flash', reasoningSupport: 'configurable', reasoningEfforts: ['low', 'medium', 'high', 'max'] }] };
  ui.syncReasoningSelector();
  const values = elements.reasoningEffortInput.options.map((option) => option.value);
  check(`旧值 ${legacy} 被原样保留并显示`, state.reasoningEffort === legacy && elements.reasoningEffortInput.value === legacy, `state=${state.reasoningEffort}, options=${JSON.stringify(values)}`);
  check(`旧值 ${legacy} 之外仍是四档`, JSON.stringify(values.filter((value) => value !== legacy)) === JSON.stringify(['low', 'medium', 'high', 'max']), `实测 ${JSON.stringify(values)}`);
}

// 模型声明的档位里若还带 default/none，也要被过滤掉。
state.reasoningEffort = 'medium';
state.modelOptionsByProfile = { default: [{ id: 'deepseek-flash', reasoningSupport: 'configurable', reasoningEfforts: ['default', 'none', 'low', 'medium', 'high', 'max'] }] };
ui.syncReasoningSelector();
check('能力数据里的 default/none 被过滤', JSON.stringify(elements.reasoningEffortInput.options.map((option) => option.value)) === JSON.stringify(['low', 'medium', 'high', 'max']), `实测 ${JSON.stringify(elements.reasoningEffortInput.options.map((option) => option.value))}`);
check('medium 能被选中', elements.reasoningEffortInput.value === 'medium');

// 不支持 / 固定 / 未知：单选项说明文字，保持原行为。
for (const [support, label] of [['unsupported', 'chat.reasoningUnsupportedShort'], ['fixed', 'chat.reasoningFixedShort'], ['unknown', 'chat.reasoningUnknownShort']]) {
  state.reasoningEffort = 'high';
  state.modelOptionsByProfile = { default: [{ id: 'deepseek-flash', reasoningSupport: support }] };
  ui.syncReasoningSelector();
  const options = elements.reasoningEffortInput.options;
  check(`${support} 模型只给一个说明项（${label}）`, options.length === 1 && options[0].textContent === label, `实测 ${JSON.stringify(options.map((option) => [option.value, option.textContent]))}`);
}

/* ── ② 步数：四档含「无限制」 ─────────────────────────────────── */

const presetsMatch = LIMITS.match(/AGENT_STEP_PRESETS: readonly number\[\] = \[([^\]]+)\]/);
if (!presetsMatch) throw new Error('agentLimits.ts 里找不到 AGENT_STEP_PRESETS');
const presets = presetsMatch[1].split(',').map((value) => Number(value.trim()));
check('步数预设来自 agentLimits.ts：[24, 68, 120, 0]', JSON.stringify(presets) === JSON.stringify([24, 68, 120, 0]), `实测 ${JSON.stringify(presets)}`);

check('normalizeStepValue(0) 保持 0（无限制）', ui.normalizeStepValue(0) === 0, `实测 ${ui.normalizeStepValue(0)}`);
check('normalizeStepValue("0") 保持 0（下拉框的字符串值）', ui.normalizeStepValue('0') === 0, `实测 ${ui.normalizeStepValue('0')}`);
check('normalizeStepValue(68) = 68', ui.normalizeStepValue(68) === 68);
check('normalizeStepValue(999) 夹到 200', ui.normalizeStepValue(999) === 200, `实测 ${ui.normalizeStepValue(999)}`);
check('normalizeStepValue(-1) 回落到 24（负数不是无限制）', ui.normalizeStepValue(-1) === 24, `实测 ${ui.normalizeStepValue(-1)}`);
check('normalizeStepValue("") 回落到 24（空值不是无限制）', ui.normalizeStepValue('') === 24, `实测 ${ui.normalizeStepValue('')}`);
check('stepsLabel(0) 用「无限制」文案', ui.stepsLabel(0) === 'chat.stepsUnlimited', `实测 ${ui.stepsLabel(0)}`);
check('stepsLabel(68) 用「68 步」文案', ui.stepsLabel(68).startsWith('chat.stepsOption'), `实测 ${ui.stepsLabel(68)}`);

// 老对话存着 8/40/80 这类不在四档里的值：补一个选项显示出来，不能空白。
elements.agentMaxStepsInput.replaceChildren();
ui.ensureStepOption(8);
check('非预设值 8 补成选项并显示成 8 步', elements.agentMaxStepsInput.options.length === 1 && elements.agentMaxStepsInput.options[0].textContent === 'chat.stepsOption:{"count":8}', `实测 ${JSON.stringify(elements.agentMaxStepsInput.options.map((option) => [option.value, option.textContent]))}`);
ui.ensureStepOption(8);
check('同一个值不会重复补选项', elements.agentMaxStepsInput.options.length === 1);
ui.ensureStepOption(0);
check('补「无限制」选项时文案是「无限制」', elements.agentMaxStepsInput.options.at(-1).textContent === 'chat.stepsUnlimited');

/* ── ③ 源码级接线 ─────────────────────────────────────────────── */

check('工具条的步数选项由 AGENT_STEP_PRESETS 生成', /AGENT_STEP_PRESETS\.map\(/.test(CHAT_PANEL) && !/\{\[12, 24, 40, 80, 120\]\.map/.test(CHAT_PANEL));
check('工具条的思考深度由 REASONING_DEPTHS 生成', /REASONING_DEPTHS\.map\(/.test(CHAT_PANEL));
check('工具条不再出现「默认 / 无」两档选项', !/\['default', 'none', 'low', 'high', 'max'\]/.test(CHAT_PANEL));
check('设置页的步数也是同一份预设（不是自由填数字）', /AGENT_STEP_PRESETS\.map\(/.test(SETTINGS_PANEL) && /<select id="agentMaxSteps"/.test(SETTINGS_PANEL));
check('设置页允许 0（无限制），只挡负数', /values\.agentMaxSteps < 0/.test(SETTINGS_PANEL));
check('设置页的思考深度校验接受 medium', /'low', 'medium', 'high', 'max'/.test(SETTINGS_PANEL));

const zh = (key) => {
  const match = I18N.match(new RegExp(`'${key.replace(/\./g, '\\.')}': \\{ zh: '([^']+)'`));
  return match ? match[1] : undefined;
};
for (const [key, label] of [['chat.reasoning.low', '低'], ['chat.reasoning.medium', '中'], ['chat.reasoning.high', '高'], ['chat.reasoning.max', '最大'], ['chat.stepsUnlimited', '无限制']]) {
  check(`中文文案 ${key} = ${label}`, zh(key) === label, `实测 ${zh(key)}`);
}

console.log(`\n${checks - failures}/${checks} 项通过`);
process.exit(failures === 0 ? 0 : 1);
