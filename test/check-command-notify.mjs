// 命令「卡住却不通知」的界面侧验证。
//
// 回归的故障：一条 `cargo test` 卡在 `qlmanage`（30 分钟只用了 0.03 秒 CPU），
// HWChat 的卡片一直显示「准备运行命令」，没有任何计时、没有输出、也没有提示，
// 用户无法判断它是在跑、卡住了、还是在等自己输入密码。
//
// 这个脚本做两件事：
// 1. 从 media/chat.js 抽出真实的 runningToolMeta，用假节点跑一遍，验证
//    「运行中一定带秒数」「停滞时一定带提示」——不是另写一份逻辑来测逻辑。
// 2. 断言各处接线还在（执行器的三重结算、进度回调、toast、CSS、文案），
//    这些点任何一处被删掉，用户就又看不到卡住了。
//
// 运行：node test/check-command-notify.mjs
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const CHAT_JS = read('media/chat.js');
const CHAT_CSS = read('media/chat.css');
const I18N = read('src/core/i18n.ts');
const EXECUTOR = read('src/agent/toolExecutor.ts');
const RUNNER = read('src/agent/agentRunner.ts');
const PANEL = read('src/views/chatPanel.ts');
const TYPES = read('src/core/types.ts');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed += 1; console.log(`✔ ${name}`); }
  else { failed += 1; console.log(`✘ ${name}`); }
}

/* ── 1. 抽取并运行真实的 runningToolMeta ───────────────────── */

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

const runningToolMetaSource = extractBlock(CHAT_JS, '\n  function runningToolMeta(');
// t() 用真实文案格式，保证断言的字符串和界面一致。
const t = (key, params = {}) => (key === 'chat.toolRunningSeconds'
  ? `已运行 ${params.seconds} 秒`
  : key);
const runningToolMeta = new Function('t', `${runningToolMetaSource}\nreturn runningToolMeta;`)(t);

const liveNode = {
  dataset: { riskLabel: '命令', startedAt: String(Date.now() - 12_300) },
};
const liveText = runningToolMeta(liveNode);
check('运行中的卡片带实时秒数（不再只有静止的「正在等待结果…」）', /^命令 · 已运行 12\.\d 秒$/.test(liveText));

const stalledNode = {
  dataset: { riskLabel: '命令', startedAt: String(Date.now() - 45_000), stallHint: '已 45 秒无输出，可能在等终端输入' },
};
const stalledText = runningToolMeta(stalledNode);
check('停滞时卡片直接写出「无输出、可能在等终端输入」', stalledText.includes('可能在等终端输入'));
check('停滞提示与秒数同时可见', stalledText.includes('已运行 4') && stalledText.includes('已 45 秒无输出'));

const freshNode = { dataset: { riskLabel: '命令', startedAt: '0' } };
check('拿不到开始时间时不会输出 NaN', !/NaN/.test(runningToolMeta(freshNode)));

/* ── 2. 接线断言 ──────────────────────────────────────────── */

check('chat.js 渲染拼装后会启动计时器', CHAT_JS.includes('scheduleToolTicker();'));
check('chat.js 只用「未结束」的卡片参与实时计时', CHAT_JS.includes("const running = tool.status === 'pending' && !tool.finishedAt;"));
check('chat.js 记下开始时间供每秒重算', CHAT_JS.includes("details.dataset.startedAt = String(tool.startedAt || 0);"));
check('chat.js 每秒刷新运行中的卡片', CHAT_JS.includes('setInterval(paintRunningToolMeta, 1000)'));
check('chat.js 没有运行中卡片时停掉计时器', CHAT_JS.includes('clearInterval(toolTicker)'));
check('停滞提示同时写进卡片正文（窄窗口小字会被隐藏）', CHAT_JS.includes("textElement('p', 'tool-stall', tool.stallHint)"));

check('CSS 给停滞步骤换警示色图标', CHAT_CSS.includes('.tool-execution.stalled .tool-status'));
check('CSS 有停滞提示行的样式', CHAT_CSS.includes('.tool-stall'));

check('文案：运行中秒数', I18N.includes("'chat.toolRunningSeconds'"));
check('文案：停滞提示', I18N.includes("'tool.commandStallHint'"));
check('文案：超时正在结束进程', I18N.includes("'tool.commandTimeoutRunning'"));
check('文案：toast 提醒', I18N.includes("'agent.commandStalled'"));

check('进程组：spawn 时 detached', EXECUTOR.includes('detached,'));
check('进程组：按负 PID 杀整组', EXECUTOR.includes('process.kill(-pid, signal)'));
check('stdin 接到 /dev/null，需要输入的命令不会无限等', EXECUTOR.includes("stdio: ['ignore', 'pipe', 'pipe']"));
check("退出后不再只等 'close'：有宽限结算", EXECUTOR.includes("child.on('exit'") && EXECUTOR.includes('COMMAND_CLOSE_GRACE_MS'));
check('超时后还有硬结算兜底', EXECUTOR.includes('COMMAND_HARD_SETTLE_MS'));
check('结算时主动断开管道', EXECUTOR.includes('child.stdout?.destroy()'));

check('执行器把进度回调接进命令执行', EXECUTOR.includes('scope?.onCommandProgress'));
check('停滞提示每 10 秒刷新秒数（不再冻在 30）', EXECUTOR.includes('COMMAND_STALL_REFRESH_SECONDS'));
// 签名在「可配置停滞阈值」那次改动里多了第三个参数（stallAfterSeconds），
// 断言要跟着真实签名走，否则会误报成「没抽出来」。
check('刷新节奏抽成纯函数，可被单测覆盖到秒级',
  /export function shouldReportStall\(\s*idleSeconds: number,\s*lastReportedIdle: number,/.test(EXECUTOR)
  && EXECUTOR.includes('stallAfterSeconds: number = COMMAND_STALL_SECONDS')
  && /shouldReportStall\(idle, lastStallIdle, stallAfter\)/.test(EXECUTOR));
check('停滞阈值从调用点传进来（可按模型/命令调整）', EXECUTOR.includes('COMMAND_STALL_SECONDS') && EXECUTOR.includes('COMMAND_STALL_REFRESH_SECONDS'));
check('toast 每条命令只弹一次（否则每 10 秒弹一次等于噪音）', RUNNER.includes('stallToastSent'));
check('toast 文案带出超时上限（用户知道它什么时候会被终止）', I18N.includes('到达 {timeout} 秒上限'));
check('面板把超时上限传给 toast 文案', PANEL.includes('timeout: info.timeoutSeconds'));
check('执行器把停滞/超时写进步骤的 stallHint', RUNNER.includes('execution.stallHint = tt('));
check('执行器结果落定后清掉 stallHint', RUNNER.includes('execution.stallHint = undefined;'));
check('面板收到停滞事件后弹 toast', PANEL.includes('onCommandStall:') && PANEL.includes("tone: 'warning'"));
check('步骤类型带 stallHint 字段', TYPES.includes('stallHint?: string;'));

console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
