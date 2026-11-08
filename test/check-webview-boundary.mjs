/*
 * webview 边界守护（2026-11-08 外部评审 ⑨ + ⑫ 批）。
 *
 * 这条边界的两侧是：
 *   - webview 可能已经被攻破（依赖漏洞 / 一处 innerHTML / 注入的脚本）；
 *   - 宿主把它的每条消息都当成真的。
 *
 * 所以这里守住四件事：
 *   ⑫ CSP 的 base-uri / form-action（这两条不会从 default-src 回退）；
 *   ⑫ 入站消息先过运行时形状校验，形状不对整条丢弃；
 *   ⑫ 危险档审批走原生模态框（那条路径不经过 webview，伪造不了）；
 *   ⑨ 运行收尾与卡片结算按 runId，不按对话整片结算；
 *   ⑨ 换对话后，在飞的附件结果不能落到新对话的草稿上。
 *
 * 用法：node test/check-webview-boundary.mjs
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
const PANEL = read('src/views/chatPanel.ts');
const SETTINGS_PANEL = read('src/views/settingsPanel.ts');
const VALIDATOR = read('src/core/incomingMessage.ts');
const EXEC = read('src/agent/toolExecutor.ts');
const I18N = read('src/core/i18n.ts');

const csp = /content="default-src 'none';([^"]+)"/.exec(PANEL);
check('CSP 仍以 default-src none 为底', Boolean(csp), '找不到 CSP');
const cspRest = csp ? csp[1] : '';
check("CSP 补上 base-uri 'none'（不写会落到 default-src 之外）", /base-uri 'none'/.test(cspRest));
check("CSP 补上 form-action 'none'", /form-action 'none'/.test(cspRest));
check('CSP 仍只允许本扩展资源与非 nonce 脚本之外的脚本源', /script-src 'nonce-/.test(cspRest));
check('webview 没有开启 command URI', !/enableCommandUris/.test(PANEL), 'enableCommandUris 一旦为 true，链接能触发 VS Code 命令');

// —— 入站消息校验 ——
const entry = PANEL.slice(PANEL.indexOf('.onDidReceiveMessage('), PANEL.indexOf('.onDidReceiveMessage(') + 900);
check('只有一处入站入口，且入口处先校验', /validateIncomingMessage\(/.test(entry));
check('校验失败整条丢弃，不放行到业务分支', /if \(!verdict\.ok\)[\s\S]{0,200}return;/.test(entry));
check('被丢弃的消息会留下日志线索（不然「点了没反应」无从查起）', /丢弃异常入站消息/.test(entry));

// —— 设置页：同一套校验 + 同一套 CSP ——
const settingsEntry = SETTINGS_PANEL.slice(SETTINGS_PANEL.indexOf('.onDidReceiveMessage('), SETTINGS_PANEL.indexOf('.onDidReceiveMessage(') + 900);
check('设置页入口也先校验（那一侧带明文 Key、能删存档）', /validateSettingsIncomingMessage\(/.test(settingsEntry) && /if \(!verdict\.ok\)/.test(settingsEntry));
check('设置页 CSP 同样补齐 base-uri / form-action', /base-uri 'none'; form-action 'none'/.test(SETTINGS_PANEL));
check('两份规格表互不串用', /SETTINGS_INCOMING_MESSAGE_SPECS/.test(VALIDATOR) && /function validateAgainst\(/.test(VALIDATOR));

check('规格表登记了 50+ 条消息', (VALIDATOR.match(/^\s{2}[a-zA-Z]+: \{/gm) ?? []).length >= 50);
check('未登记的类型一律拒绝', /unknown message type/.test(VALIDATOR));
check('原型链方法名不会被当成已登记类型', /Object\.hasOwn\(specs, type\)/.test(VALIDATOR));
check('__proto__ / prototype / constructor 作为键被拒', /FORBIDDEN_KEYS/.test(VALIDATOR));
check('NaN / Infinity 不算合法数字字段', /Number\.isFinite\(value\)/.test(VALIDATOR));
check('枚举字段按真实取值校验，不是见字符串就放', /MESSAGE_MODES\.includes/.test(VALIDATOR) && /PERMISSION_PRESETS\.includes/.test(VALIDATOR) && /REASONING_EFFORTS\.includes/.test(VALIDATOR));

// —— 危险档审批 ——
check('危险档标记由命令分档给出（两处构造点都打）', (EXEC.match(/dangerous: tier === 'severe'/g) ?? []).length === 2);
check('面板对危险档用原生模态框', /if \(dangerous\)[\s\S]{0,400}modal: true/.test(PANEL));
check('危险档确认文案说明「为什么不在对话框里问」', /notice\.approveDangerousDetail/.test(I18N));
check('审批回调把 dangerous 传下去了', /this\.requestToolApproval\(request\.summary, request\.detail, request\.risk, run, request\.dangerous\)/.test(PANEL));

// —— 运行归属 ——
check('run 带唯一 runId', /runId: makeRunId\(conversationId, \+\+this\.runSequence\)/.test(PANEL));
check('收尾只删自己那一轮', /if \(this\.runs\.get\(conversationId\) === run\) this\.runs\.delete\(conversationId\)/.test(PANEL));
check('没有裸的 runs.delete(conversationId)', !/^[ \t]*this\.runs\.delete\(conversationId\);[ \t]*$/m.test(PANEL));
check('审批卡片按 runId 结算', /pending\.runId !== run\.runId/.test(PANEL));
check('方案卡片按 runId 结算', /private settleDecisionsFor\(run: ConversationRun\)/.test(PANEL));

// —— 草稿归属 ——
check('切对话统一走 setActiveConversation', /private setActiveConversation\(/.test(PANEL));
check('setActiveConversation 会提升草稿代次', /this\.draftEpoch\.bump\(\)/.test(PANEL));
const attach = PANEL.slice(PANEL.indexOf('async attachFiles('), PANEL.indexOf('async attachFiles(') + 3000);
check('选文件链路记下代次', /const epoch = this\.draftEpoch\.current;/.test(attach));
check('选文件链路落地前校验代次', /this\.draftEpoch\.isStale\(epoch\)/.test(attach));
const reuse = PANEL.slice(PANEL.indexOf('private async attachMessageAttachment('), PANEL.indexOf('private async attachMessageAttachment(') + 3000);
check('复用附件链路落地前校验代次', /this\.draftEpoch\.isStale\(epoch\)/.test(reuse));
check('丢弃会明确告诉用户（静默丢 = 点了没反应）', /notice\.attachDiscarded/.test(PANEL) && /notice\.attachDiscarded/.test(I18N));

console.log(`\n${checks - failures}/${checks} 项满足`);
if (failures) {
  console.log(`${failures} 项不满足`);
  process.exit(1);
}
console.log('webview 边界检查通过：CSP 补齐、入站消息校验、危险档走原生模态框、运行与草稿按代次归属。');
