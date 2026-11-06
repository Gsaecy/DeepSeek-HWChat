/*
 * 「任务树即记忆 + 对话记录按需检索」的守护。
 *
 * 用户的要求（2026-11-06）：
 *
 *     我希望保留对话记录，除非用户主动清理，但是对话记录已经不再是 agent 的记忆了，
 *     agent 只需要读取任务树和任务清单（包括执行一半退出和执行完的），就能知道对话
 *     中的项目情况，完整的对话记录，只在读取任务树和任务清单无法确定的情况下查找读取。
 *
 * 这份守护盯四件事：
 *   1. 请求里绝不能再出现「只有 system」——真实故障：一条 2747 KB 的贴图消息把用户
 *      当下的提问挤出窗口，模型回答「我这边没有收到具体请求」；
 *   2. 记忆 = 任务树 + 清单：每轮注入 `<project_memory>`，已完成任务带一句结论；
 *   3. 全文照常保留：贴图 base64 落成文件、工具输出搬进 `payloads/`，都能按需还原；
 *   4. 只有「记忆说不清」时才查原文：检索工具每轮都在，且第一条就查当前对话。
 *
 * 用法：node test/check-context-memory.mjs
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';

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
const STORAGE = read('src/core/storage.ts');
const RUNNER = read('src/agent/agentRunner.ts');
const MEMORY = read('src/core/taskMemory.ts');
const WINDOW = read('src/core/contextWindow.ts');
const I18N = read('src/core/i18n.ts');

/* ── 1. 绝不会发出只有 system 的请求 ──────────────────────────────── */
check(
  '预算不再按原始 JSON 字节算（那是「忘记项目」的根因）',
  /export function requestBytesOf/.test(WINDOW) && /requestBytesOf\(message\)/.test(WINDOW),
  '旧实现用 JSON.stringify(message) 的字节数，一条 2.7 MB 的贴图消息就能吃光预算',
);
check(
  '最新那条用户消息必进窗口（超预算也进）',
  /const required = !this\.sawUser;/.test(WINDOW) && /if \(message\.role === 'user'\) this\.sawUser = true;/.test(WINDOW),
);
check(
  '窗口读空时补上本轮内容，并记一行日志',
  /历史窗口里没有本轮消息/.test(PANEL) && /messages\.push\(this\.requestMessageFromParts\(current\.content/.test(PANEL),
);
check(
  '面板把本轮内存副本传进去（图片要能发给模型）',
  /messageId: userMessage\.id, content: userMessage\.content, context, attachments/.test(PANEL),
);

/* ── 2. 记忆 = 任务树 + 清单 ─────────────────────────────────────── */
check(
  '任务树随对话落库（不是只下发界面）',
  /taskNodes\?: AgentTaskNode\[\] \| null;/.test(STORAGE) && /summary\.taskNodes = patch\.taskNodes/.test(STORAGE),
);
check(
  '每轮注入 <project_memory>',
  /renderTaskMemory\(/.test(PANEL) && /'<project_memory>'/.test(MEMORY),
);
check(
  '已完成任务带一句结论',
  /node\.summary/.test(MEMORY) && /outcomeOf\(content\)/.test(PANEL),
);
check(
  '运行结束立刻把记忆落库（不能只停在去抖计时器里）',
  /await this\.flushTaskMemory\(conversationId\)/.test(PANEL),
);
check(
  '结论之外还记约束（只记结果会让模型把禁止的改动做回去）',
  /export function constraintsOf/.test(MEMORY)
    && /constraintsOf\(\[node\.title, content\]\)/.test(PANEL)
    && /约束：/.test(MEMORY),
);
check(
  '约束随任务落库，且新一轮下发不会抹掉旧约束',
  /constraints: Array\.isArray\(node\.constraints\)/.test(STORAGE)
    && /constraints: node\.constraints\?\.length \? node\.constraints : previous\.constraints/.test(MEMORY),
);
check(
  '记忆块里明确要求遵守约束',
  /always honour the 约束/.test(MEMORY),
);
check(
  '任务记忆不随 state/history 下发界面（否则每次推送都多背几十个节点）',
  /taskNodes: _taskNodes, \.\.\.rest/.test(PANEL),
);
check(
  '关窗口前走合并路径写记忆（直接覆盖会丢上一轮的任务）',
  /void this\.flushTaskMemory\(conversationId\);/.test(PANEL)
    && !/updateConversation\(conversationId, \{ taskNodes: pending\.nodes \}\)/.test(PANEL),
);
check(
  '检索会翻 payloads/（否则归档的工具输出永远搜不到）',
  /archiveText/.test(STORAGE) && /existsSync\(this\.payloadPath\(conversationId, message\.id\)\)/.test(STORAGE),
);
check(
  '还原一条消息时先按序号对工具记录（同名工具不会串行）',
  /detail\?\.tools\?\.\[index\] \?\? detail\?\.tools\?\.find/.test(PANEL),
);
check(
  '运行内工具输出只留最近几条全文',
  /pruneToolPayloads\(requestMessages\)/.test(RUNNER) && /const TOOL_PAYLOAD_KEEP = 6;/.test(RUNNER),
);

/* ── 3. 全文保留：base64 落盘、工具输出搬进 payloads ──────────────── */
check(
  '贴图落成文件后再存档（2747 KB → 几十 KB）',
  /async saveConversationImage\(/.test(STORAGE)
    && /await this\.persistAttachments\(conversationId, attachments\)/.test(PANEL)
    && /await this\.persistAttachments\(conversationId, attachments\)/.test(PANEL),
);
check(
  '清理不再直接删重字段，先搬进 payloads/',
  /async packMessagePayload\(/.test(STORAGE) && /payloads/.test(STORAGE),
);
check(
  '正文永远留在消息里（只搬 reasoning / 工具输出 / 附件正文）',
  /delete message\.reasoning;/.test(STORAGE) && !/message\.content = ''/.test(STORAGE),
);
check(
  '能按需还原一条消息的完整内容',
  /async readMessageDetail\(/.test(STORAGE) && /name: 'read_message_detail'/.test(PANEL),
);

/* ── 4. 只在记忆说不清时才查原文 ─────────────────────────────────── */
check(
  '检索工具每轮都在（不再只给续接对话）',
  /const historyTool = conversationHistoryToolDefinition\(\);/.test(PANEL),
);
check(
  '检索第一条就查当前对话的完整记录',
  /searchConversationMessages\(conversation\.id, query, limit\)/.test(PANEL),
);
check(
  '自动检索：窗口外的旧记录由宿主自己捞（不等模型调工具）',
  /recall\?: \{ tokens: readonly string\[\]; limit\?: number \}/.test(STORAGE)
    && /recallTokensForTurn/.test(PANEL)
    && /<auto_recall>/.test(PANEL),
);
check(
  '自动检索会翻 payloads/（报错原文常只在工具输出里）',
  /sidecarCandidates/.test(STORAGE),
);
check(
  '关键词模糊匹配（换说法也能命中）',
  /export function matchTokens/.test(read('src/core/searchText.ts'))
    && /matchTokens\(text, queryTokens\)\.score >= 0\.5/.test(STORAGE),
);
check(
  '多义术语：分不清就问，分得清就说明假设（不打断用户）',
  /export function resolveAmbiguousTerms/.test(read('src/core/searchText.ts'))
    && /<term_conflict>/.test(PANEL)
    && /<term_assumption>/.test(PANEL),
);
check(
  '清单归属按节点时间窗取差集（不再广播整份清单）',
  /export function newlyCompletedTodos/.test(MEMORY)
    && /const baselines = this\.todoBaselines/.test(PANEL)
    && !/doneTodos/.test(PANEL),
);
check(
  '清单执行结果当成任务的变动总结',
  /todos\?: TodoItem\[\]/.test(read('src/core/types.ts'))
    && /清单：/.test(MEMORY)
    && /newlyCompletedTodos\(baseline, todos\)/.test(PANEL),
);
check(
  '记忆块明确告诉模型「记不清就查原文」',
  /search_conversation_history/.test(MEMORY),
);
check(
  '检索结果标出「还能读原文」',
  /hasDetail: true/.test(STORAGE) && /hasDetail\?: boolean;/.test(read('src/core/types.ts')),
);
check(
  '新工具的文案中英文都有',
  /'tool\.readMessageDetailDescription': \{ zh:/.test(I18N) && /'tool\.readMessageDetailDescription': \{ zh: [^}]*en:/.test(I18N),
);

/* ── 5. 真实数据跑一遍：2.7 MB 贴图消息不再挤掉用户那句话 ─────────── */
const OUT = 'out/check/context-memory.cjs';
buildSync({
  entryPoints: ['src/core/contextWindow.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: OUT,
  logLevel: 'silent',
});
const require = createRequire(import.meta.url);
const { buildContextWindow } = require(resolve(OUT));
const big = 'A'.repeat(2747 * 1024);
const history = [
  { id: 'u-old', role: 'user', content: '把录制胶囊放到顶部栏', createdAt: 1, updatedAt: 1, status: 'complete' },
  { id: 'a-old', role: 'assistant', content: '改完了。', createdAt: 2, updatedAt: 2, status: 'complete' },
  {
    id: 'u-incident',
    role: 'user',
    content: '录制状态和停止按钮胶囊，能显示在顶部栏吗？',
    createdAt: 3,
    updatedAt: 3,
    status: 'complete',
    attachments: [{ label: '截图', kind: 'image', mimeType: 'image/png', dataBase64: big }],
  },
  { id: 'a-placeholder', role: 'assistant', content: '', status: 'streaming', createdAt: 4, updatedAt: 4 },
];
const window = buildContextWindow(history, { maxMessages: 20, maxBytes: 1 });
check(
  '真实事故形状：用户那句话在窗口里',
  window.messages.some((message) => message.id === 'u-incident'),
  `窗口里只有：${window.messages.map((message) => message.id).join(', ')}`,
);
check(
  '真实事故形状：更早的历史被挡下（供记忆块使用）',
  window.dropped.some((message) => message.id === 'u-old'),
  `窗口外：${window.dropped.map((message) => message.id).join(', ')}`,
);
rmSync(OUT, { force: true });
check('临时构建产物已清理', !existsSync(OUT));

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「任务树即记忆」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('对话记录留着当档案，agent 靠任务树与清单记事情，细节按需回查。');
}
