// 「方案决策」与「命令摘要」的接线检查。
//
// 两件事必须同时成立，否则 agent 还是「闷头做」：
//  1. 遇到岔路口**停下来问**，而且问得有内容 —— 每个选项都要写清
//     「能做成什么 / 做到什么地步 / 代价」，并在用户回答前**不返回**；
//  2. 界面上的执行流水要**读得懂** —— 一行 `命令退出码 0` 看不出在干什么
//     （用户截图里一次运行有 20 多行这种）。
//
// 这些都不靠单测能覆盖（跨扩展/界面两层），所以单独守接线。
//
// 运行：node test/check-decision-gate.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const GATE = readFileSync('src/core/decisionGate.ts', 'utf8');
const EXECUTOR = readFileSync('src/agent/toolExecutor.ts', 'utf8');
const JS = readFileSync('media/chat.js', 'utf8');
const CSS = readFileSync('media/chat.css', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

let failures = 0;
function check(name, pass, detail) {
  if (pass) return;
  failures += 1;
  console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

// —— 1. 工具与提示词 ——
check('注册了 ask_user_choice 工具',
  /name: 'ask_user_choice'/.test(PANEL) && /decisionToolDefinition\(\)/.test(PANEL),
  '没有工具就只剩「文本里问一句」，模型可以直接忽略往下做');

check('工具的三项对比是必填',
  /required: \['title', 'achieves', 'extent', 'cost'\]/.test(PANEL),
  '缺「代价」等于告诉用户那是免费的');

check('系统提示词带决策闸门',
  /DECISION_GATE_PROMPT/.test(PANEL) && /You MUST stop and ask with ask_user_choice/.test(GATE),
  '没有提示词规则，模型不会主动停下来问');

check('提示词同时写了「不许问」的条件（避免每步都问）',
  /Do NOT ask when/.test(GATE),
  '只写「要问」会把 agent 变成每步都问');

check('明确禁止在等回答期间自己往下做',
  /do not start implementing|never act before the answer arrives/i.test(GATE),
  '否则工具还没返回，模型已经在猜默认方案了');

// —— 2. 在用户回答前不返回 ——
check('工具调用挂在 Promise 上直到用户选择',
  /const choice = await new Promise<number>/.test(PANEL),
  '必须真的阻塞，模型才无法绕过决策');

check('停止 / 出错 / 释放时结算掉卡片',
  /settleDecisionsFor\(conversationId\)/.test(PANEL) && /settleAllDecisions\(\)/.test(PANEL),
  '不结算的话那张线程的 finally 永远不跑（与审批卡片同一个坑）');

check('方案卡片随状态重发（面板重载不丢）',
  /pendingDecisions: \[\.\.\.this\.pendingDecisions\.values\(\)\]/.test(PANEL),
  '丢了卡片用户只看到「正在执行」却无处可点');

check('回答只回下标，内容以扩展侧入参为准',
  /decisionResponse'; requestId: string; chosenIndex: number/.test(PANEL) && /Number\.isInteger\(message\.chosenIndex\)/.test(PANEL),
  '界面回内容的话，被改写的界面能给模型塞一份"用户没选过"的方案');

// —— 3. 界面 ——
check('三个标签按固定顺序渲染（能横向比较）',
  ['decision.achieves', 'decision.extent', 'decision.cost'].every((key) => JS.includes(key)),
  '顺序乱跳就没法比较');

check('点选用按钮而不是复选框（一次只能选一个）',
  /decision-choose/.test(JS) && /for \(const button of elements\.decisionOptions\.querySelectorAll\('button'\)\) button\.disabled = true/.test(JS),
  '连点会重复回答');

check('卡片样式与审批卡片区分开（蓝 vs 黄）',
  /\.decision-card \{/.test(CSS) && /var\(--accent\)/.test(CSS.slice(CSS.indexOf('.decision-card'))),
  '两张卡片语义不同，颜色一样会分不清哪张在等决策');

check('中英文案齐全',
  ['decision.achieves', 'decision.extent', 'decision.cost', 'decision.choose', 'decision.invalid', 'decision.cancelled', 'decision.otherConversation']
    .every((key) => new RegExp(`'${key.replace(/\./g, '\\.')}':`).test(I18N)),
  '');

// —— 4. 命令摘要 ——
check('命令类摘要带上命令本身（不再只有退出码）',
  /commandSummary\(command, result, timeout/.test(EXECUTOR) && /tool\.commandExitSummary/.test(I18N),
  '一行「命令退出码 0」看不出在干什么');

check('摘要里对凭据脱敏（会进界面与审计）',
  /redactCommandForSummary/.test(EXECUTOR) && /bearer\|basic\|token/.test(EXECUTOR),
  '只脱方案名会把真 token 留在摘要里');

check('摘要压成一行并截断',
  /const flat = String\(command \?\? ''\)\.replace/.test(EXECUTOR) && /limit = 60/.test(EXECUTOR),
  '多行命令会把列表撑高');

if (failures) {
  console.log(`\n${failures} 项不满足`);
  process.exit(1);
}
console.log('决策闸门检查通过：会停下来问、选项三项齐全、回答前不返回、命令摘要读得懂。');
