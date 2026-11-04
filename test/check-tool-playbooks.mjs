/*
 * 「按任务类型指定首选工具」的守护。
 *
 * 用户的要求：「给每类任务指定首选工具」。要点是**由代码指定，不是再写一句提示词**。
 * 所以这里检查三件事同时在场：
 *   1. 收窄：`toolAllowList` 真的传进 runner，并在合并三路工具后过滤；
 *   2. 执行：走错的工具被 `blockedToolReason` 硬拒，并指出首选工具；
 *   3. 指令：宿主口吻的执行约定拼进系统提示词（含工具名、参数形状、顺序、禁用项）。
 *
 * 只覆盖三类「路径固定」的任务：本地预览 / 生成图片 / git 写操作 ——
 * 其它任务没有可靠的正则判据，硬套只会误伤。
 *
 * 用法：node test/check-tool-playbooks.mjs
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
const PLAYBOOKS = read('src/agent/toolPlaybooks.ts');
const PANEL = read('src/views/chatPanel.ts');
const RUNNER = read('src/agent/agentRunner.ts');

/* ── 1. 判定是宿主做的（正则），不是模型 ─────────────────────────────── */
check(
  '三类任务都有确定性判据',
  /isWebPreviewRequest/.test(PLAYBOOKS) && /isImageGenerationRequest/.test(PLAYBOOKS) && /isGitWriteRequest/.test(PLAYBOOKS),
);
// 直接按源码里的实际片段判断（写一个复杂的溯源正则只会让守护自己变脆）。
check(
  '「预览图片」不会被当成网页预览',
  PLAYBOOKS.includes('(?:预览|看).{0,4}(?:图|图片|海报|插画)')
  && /if \(\/.*\/\.test\(value\)\) return false;/.test(PLAYBOOKS),
  '两类任务混在一起会互相抢工具',
);
check(
  '写意图判定能区分「预览」与「预览并修改」',
  /export function hasWriteIntent/.test(PLAYBOOKS)
  && /预览效果顺便把标题改大/.test(read('src/test/toolPlaybooks.test.ts')),
  '否则「预览并顺手改一下」会被收窄掉写工具',
);

/* ── 2. 收窄：清单里没有 = 模型连选的机会都没有 ──────────────────────── */
check(
  'runner 支持 toolAllowList 并在合并后过滤',
  /toolAllowList\?: readonly string\[\]/.test(RUNNER)
  && /const merged = options\.mode === 'chat'/.test(RUNNER)
  && /merged\.filter\(\(tool\) => allow\.includes\(tool\.function\.name\)\)/.test(RUNNER),
  '必须在三路工具合并**之后**过滤，否则会漏掉某一路',
);
check(
  '面板发送时计算清单并传给 runner',
  /narrowToolNames\(allToolNames, playbooks, writingRequested\)/.test(PANEL)
  && /^\s+toolAllowList,$/m.test(PANEL),
);
check(
  '工具名清单来自完整目录（原生 + 桥接 + 额外）',
  /private toolCatalog\(settings: ChatSettings, mode: ConversationMode\): string\[\]/.test(PANEL)
  && /this\.toolExecutor\.definitions\(mode/.test(PANEL)
  && /this\.vscodeTools\.definitions\(\)/.test(PANEL),
  '只算一半会导致收窄把本该保留的工具算掉',
);
check(
  '只读与元工具永远保留',
  /const ALWAYS_ALLOWED: readonly string\[\]/.test(PLAYBOOKS)
  && /read_file/.test(PLAYBOOKS) && /update_todos/.test(PLAYBOOKS),
  '预览任务也要能读代码；清单/决策属于基础设施',
);
check(
  '收窄后为空时放弃收窄（不让模型无工具可用）',
  /return kept\.length \? kept : \[\.\.\.names\];/.test(PLAYBOOKS),
);

/* ── 3. 执行期硬拒：模型硬调走错的工具也不放行 ──────────────────────── */
check(
  'executeExtraTool 里先过 playbook 硬拒',
  /const blockedByPlaybook = blockedToolReason\(call\.function\.name, playbooks, writingRequested\)/.test(PANEL)
  && /status: 'denied', summary: tt\('tool\.playbookBlocked'\)/.test(PANEL),
  '凭记忆硬调时必须拒绝，并告诉模型该用哪个',
);
check(
  '硬拒文案要指出首选工具',
  /请改用 \$\{playbook\.preferred\.join\(' → '\)\}/.test(PLAYBOOKS),
);

/* ── 4. 指令进提示词，且写清四要素 ──────────────────────────────────── */
check(
  '执行约定拼进系统提示词',
  /playbookDirective\(playbooks\)/.test(PANEL) && /^\s+playbookDirective,$/m.test(PANEL),
);
check(
  '预览指令含工具名 / 参数 / 顺序 / 禁用项',
  /run_command/.test(PLAYBOOKS) && /background: true/.test(PLAYBOOKS)
  && /open_web_preview/.test(PLAYBOOKS) && /127\.0\.0\.1/.test(PLAYBOOKS)
  && /禁止/.test(PLAYBOOKS),
);
check(
  '要图的指令明确禁止去装渲染器',
  /mermaid-cli/.test(PLAYBOOKS) && /puppeteer/.test(PLAYBOOKS),
  '这是 2026-11-04 实测超时 2 分钟的那次',
);
check(
  'git 写操作指令要求显式 cwd、禁止 -C 跨项目',
  /显式传 `cwd`/.test(PLAYBOOKS) && /git -C/.test(PLAYBOOKS),
);

/* ── 5. 只在「路径固定」的任务上生效（避免误伤）─────────────────────── */
check(
  '没有把任务类型判定做成万能分类器（仅三类）',
  /export type ToolPlaybookKind = 'web-preview' \| 'image-generation' \| 'git-write'/.test(PLAYBOOKS),
  '其它任务缺少可靠判据，硬套会误伤',
);
check(
  '日志可复盘：收窄前后数量与写意图',
  /\[playbook\] \$\{playbooks\.map\(\(item\) => item\.kind\)\.join\('\+'\)\}/.test(PANEL),
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「指定首选工具」这条链路还有缺口。');
  process.exitCode = 1;
} else {
  console.log('首选工具由宿主指定：收窄清单 + 执行期硬拒 + 提示词约定，三道同时在。');
}
