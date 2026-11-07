/*
 * 我自己提过的缺口，现在到底关了没有。
 *
 * 用户追问（2026-11-07）：「过程中你说有漏洞，修复了没有」。
 * 这份守护把当时列的每一条都变成可执行断言 —— 不靠我说，靠代码证明。
 *
 * 用法：node test/check-gap-closure.mjs
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
const EXECUTOR = read('src/agent/toolExecutor.ts');
const PANEL = read('src/views/chatPanel.ts');
const RUNNER = read('src/agent/agentRunner.ts');
const TYPES = read('src/core/types.ts');
const STORAGE = read('src/core/storage.ts');

/* ── 缺口 1：read_message_detail 受文件读取策略约束（每次弹确认）────── */
check(
  '读自己的对话存档不再走 fileReadPolicy',
  /internal\?: boolean;/.test(EXECUTOR) && /const policy = internal \? 'allow' : policyFor/.test(EXECUTOR),
  '读的是我们刚存下的记录，与「能不能读你的代码」无关',
);
check(
  'read_message_detail 明确标成 internal',
  /\{ conversationId, internal: true \}/.test(PANEL),
);
check(
  'internal 仍然写审计（只是不弹窗）',
  /const approvalRequired = !internal/.test(EXECUTOR) && /auditResult/.test(EXECUTOR),
);

/* ── 缺口 2：重载窗口后清单基线丢失 ─────────────────────────────── */
check(
  '基线随任务节点落库',
  /baseline\?: string\[\];/.test(TYPES) && /baseline: Array\.isArray\(node\.baseline\)/.test(STORAGE),
);
check(
  '重载后优先从节点恢复基线',
  /if \(!baselines\.has\(node\.id\) && node\.baseline\?\.length\)/.test(PANEL),
);
check(
  '写回时把基线一起带上',
  /\.\.\.\(baseline\?\.length \? \{ baseline \} : \{\}\)/.test(PANEL),
);

/* ── 缺口 3：运行中途才出现的线索，开局检索看不到 ────────────────── */
check(
  'runner 有了失败回查钩子',
  /recallForFailure\?: \(toolName: string, errorText: string\) => Promise<string>;/.test(RUNNER),
);
check(
  '回查结果并进同一条 tool 结果（不插 system / user）',
  /const recall = result\.status === 'error' && options\.recallForFailure/.test(RUNNER)
    && /result: recall \? `\$\{result\.content\}\\n\\n\$\{recall\}` : result\.content/.test(RUNNER),
);
check(
  '面板实现了回查，且有次数上限（默认 3 次）',
  /private async recallForFailure\(conversationId: string, toolName: string, errorText: string\)/.test(PANEL)
    && /if \(used >= 3\) return '';/.test(PANEL),
);
check(
  '每轮运行开始时把计数清零',
  /this\.failureRecallUsed\.delete\(conversationId\);/.test(PANEL),
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('还有我说过要修、但没修的缺口。');
  process.exitCode = 1;
} else {
  console.log('当时列的缺口：三条已关（归档读取不再打扰、基线跨重载、失败自动回查）。');
}
