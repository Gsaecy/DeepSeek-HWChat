/*
 * 「调不通的桥接工具」与「本地预览」的守护。
 *
 * 现场（用户 2026-11-04）：「经常调用 vs code 工具失败」。执行记录里：
 *   run_in_terminal → `Invocation context must be provided for this tool`
 *   → 写日志被路径隔离拦两次 → 连续 3 轮失败 → 整轮停机。
 *
 * 根因在 VS Code 侧：`run_in_terminal` 的 invoke 要求 `toolSpecificData` + `context`，
 * 而 `lm.invokeTool` 的公开参数里没有这两项。所以它**永远**调不通，不该继续下发。
 * 同时原生 `run_command` 需要「后台常驻」能力，否则静态服务器只能跑满超时。
 *
 * 用法：node test/check-bridged-tools.mjs
 */
import { readFileSync } from 'node:fs';

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

const read = (path) => readFileSync(path, 'utf8');
const BRIDGED = read('src/agent/bridgedTools.ts');
const TOOLS = read('src/agent/vscodeTools.ts');
const EXECUTOR = read('src/agent/toolExecutor.ts');
const PANEL = read('src/views/chatPanel.ts');
const I18N = read('src/core/i18n.ts');

/* ── 1. 已知调不通的工具：识别 + 不下发 + 运行期学习 ─────────────────── */
check(
  '已知名单里有 run_in_terminal',
  /KNOWN_NEEDS_CHAT_CONTEXT[^=]*=\s*\['run_in_terminal'\]/.test(BRIDGED),
  '那是唯一一个在 Workbench 里检查 toolSpecificData + context 的工具',
);
check(
  '识别 VS Code 的真实错误文案（两句都要认）',
  /invocation context must be provided/i.test(BRIDGED) && /toolSpecificData must be provided/i.test(BRIDGED),
  'run_in_terminal 先抛 toolSpecificData、再抛 invocation context',
);
check(
  '下发时过滤掉调不通的工具',
  /private externalDefinitions\(\)[\s\S]{0,400}filter\(\(tool\) => !needsChatContext\(tool\.name, this\.unusableExternalTools\)\)/.test(TOOLS),
  '继续把注定失败的工具摆在模型面前 = 每次白烧一轮，还会算进「连续失败」预算',
);
check(
  '执行时撞上上下文错误 → 记入会话级不可用集合',
  /isMissingChatContextError\(message\)[\s\S]{0,200}this\.unusableExternalTools\.add\(tool\.name\)/.test(TOOLS),
  '运行期学到的也要挡住，否则模型下次还会被同一个工具骗一轮',
);
check(
  '确定性失败返回 denied（不计入「连续失败」的 error）',
  /isMissingChatContextError\(message\)[\s\S]{0,240}return denied\(missingChatContextNotice/.test(TOOLS),
  '这类失败重试一万次也一样，不该消耗模型的无进展预算',
);

/* ── 2. 给模型的说明必须能阻止它「换个写法重试」 ────────────────────── */
check(
  '说明里写清「不是权限 / 路径 / 参数问题」',
  /不是权限、路径或参数格式的问题/.test(BRIDGED),
  '不写这句，模型会去改参数、换路径，把三轮预算耗光',
);
check('说明里写清「不要重试」', /不要重试/.test(BRIDGED));
check(
  '说明里给出替代方案（run_command / open_web_preview）',
  /run_command/.test(BRIDGED) && /open_web_preview/.test(BRIDGED),
);

/* ── 3. 原生 run_command 的后台模式 ─────────────────────────────────── */
check(
  'run_command 的 schema 带 background',
  /this\.definition\('run_command'[\s\S]{0,700}background:\s*\{/.test(EXECUTOR),
  '没有它，静态服务器 / watch 这类命令只能跑满超时',
);
check(
  '后台模式立刻返回，不等命令结束',
  /if \(args\.background === true(?: \|\| autoBackground)?\) \{[\s\S]{0,500}startBackground\(/.test(EXECUTOR),
);
check(
  '后台进程登记在册，可被明确停掉',
  /backgroundChildren = new Map/.test(EXECUTOR)
  && /stopBackground\(id: string\): boolean/.test(EXECUTOR)
  && /listBackground\(\)/.test(EXECUTOR),
  '不登记就收不掉 —— 会留下占着端口的孤儿服务',
);
check(
  'dispose 时把后台进程一起收掉',
  /dispose\(\): void \{[\s\S]{0,300}stopBackground\(id\)/.test(EXECUTOR),
);
check(
  '取消（停止按钮会话结束）时也收掉',
  /scope\?\.signal\?\.addEventListener\('abort', \(\) => this\.stopBackground\(id\)/.test(EXECUTOR),
);
check(
  '起不来时把真实输出带回来（不谎报「已启动」）',
  /exited\) \{[\s\S]{0,300}code === 0 \? 'success' : 'error'/.test(EXECUTOR),
  '端口占用是最常见的失败原因，必须让模型看到 Address already in use',
);

/* ── 4. 系统提示词教对「本地预览」这条路 ────────────────────────────── */
check(
  '提示词写明「run_command background + open_web_preview」',
  /background: true`? to start the server/.test(PANEL) && /open_web_preview/.test(PANEL),
  '不写清正确路径，模型只会继续去撞桥接工具',
);
check(
  '提示词明确禁止用桥接终端工具起服务',
  /Do not use a bridged VS Code terminal tool for this/.test(PANEL),
);
check(
  '新增文案键真实存在（否则界面直接显示键名）',
  ['tool.runCommand.backgroundParam', 'tool.runCommand.backgroundStarted', 'tool.runCommand.backgroundNotice',
    'tool.runCommand.backgroundFinished', 'tool.runCommand.backgroundFailed']
    .every((key) => I18N.includes(`'${key}':`)),
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「经常调用 VS Code 工具失败」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('调不通的桥接工具不再下发；本地预览走 run_command 后台 + open_web_preview。');
}
