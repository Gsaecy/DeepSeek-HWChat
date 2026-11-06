/*
 * 方案卡片期间发的附件不能消失。
 *
 * 用户原话（2026-11-06）：「hwchat 让我选择方案的时候我发的附件，存在哪里了」。
 *
 * 当时的实现只把**文本**当成答案：
 *
 *     if (content && run && this.answerDecisionWithText(conversationId, content)) {
 *       this.pendingContext = undefined;
 *       this.pendingAttachments = [];      // ← 附件在这里被丢掉
 *       …
 *     }
 *
 * 附件既没进消息存档、也没写进任何文件 —— 用户以为 agent 看到了那张图，其实什么也没有。
 *
 * 现在：附件先落成真实路径（粘贴的图片写进 attachment-cache，磁盘文件用原路径），
 * 清单拼进答案正文，用户消息也照常落库。
 *
 * 用法：node test/check-decision-attachments.mjs
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

const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

/* ── 1. 不再「只认文本、然后清空附件」────────────────────────────── */
check(
  '决策分支把「有附件但没文字」也算作回答',
  /if \(run && \(content \|\| this\.pendingAttachments\.length\)\)/.test(PANEL),
  '只认 content 时，纯附件会被当成新任务排队，而 agent 仍卡在决策上',
);
check(
  '旧的「只交文本 + 清空附件」实现已删除',
  !/private answerDecisionWithText/.test(PANEL),
  '留着它就会被误调用',
);
check(
  '附件在决策路径里被逐个转成真实路径',
  /for \(const attachment of attachments\)/.test(PANEL) && /attachmentCacheUri\(attachment, attachment\.dataBase64\)/.test(PANEL),
);
check(
  '磁盘文件用原路径（不复制一份副本）',
  /manifest\.push\(`- 文件「\$\{attachment\.label\}」：\$\{attachment\.path\}`\)/.test(PANEL),
);
check(
  '选中文本把内容带进答案（有长度上限）',
  /attachment\.content\.slice\(0, 2_000\)/.test(PANEL),
);
check(
  '保存失败也要说明，而不是静默丢',
  /保存失败/.test(PANEL),
);
check(
  '用户消息落库（附件与文字都留得下，之后能点开）',
  /attachments: entry\.attachments,/.test(PANEL) && /executionStatus: 'done',/.test(PANEL),
);
check(
  '答案正文里写明「用户同时附上了这些内容」',
  /用户同时附上了这些内容/.test(PANEL),
);
check(
  '附件仍然会推给界面（输入框清空）',
  /await this\.post\(\{ type: 'attachments', attachments: this\.pendingAttachmentsForWebview\(\) \}\);/.test(PANEL),
);

/* ── 2. 回答本身要成为一条气泡（两种回答方式都要）──────────────────── */
check(
  '有一条统一的「记录回答」落库方法',
  /private async recordDecisionAnswer\(/.test(PANEL),
  '两条路径各写一遍迟早漂移',
);
check(
  '自己写做法 → 落一条用户消息（executionStatus done）',
  /await this\.recordDecisionAnswer\(conversationId, \{/.test(PANEL)
    && /executionStatus: 'done',/.test(PANEL),
);
check(
  '点击某个方案 → 也落一条「选择方案：…」',
  /tt\('decision\.choiceMessage', \{ title: chosen\.title \}\)/.test(PANEL),
  '以前点选连痕迹都没有，事后查不到当时选的是哪个',
);
check(
  '点选时把挂着的附件一起带上',
  /const attachments = this\.pendingAttachments\.map\(\(item\) => \(\{ \.\.\.item \}\)\);\s*\n\s*const context = this\.pendingContext;/.test(PANEL),
);
check(
  '文案中英都齐',
  /'decision\.choiceMessage'/.test(I18N),
);
check(
  '气泡通过 messageAdded 立刻出现在对话里',
  /type: 'messageAdded', conversationId, message: this\.forWebview\(message\)/.test(PANEL),
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「选方案时发的附件」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('选方案时发的附件会被落成真实路径、写进答案、留在对话里，不再凭空消失。');
}
