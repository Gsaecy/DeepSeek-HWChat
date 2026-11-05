/*
 * 「不许插队 / 不许跳过未执行的消息」的守护。
 *
 * 用户原话（2026-11-05）：
 *
 *     发的多个消息，如果合并执行的消息中间还有消息，会被跳过。
 *     让 agent 不要跳过未执行的消息，除非用户自己删除，不然需要根据状态之下，
 *     只要对话框还有未执行的消息都需要继续执行，包括执行中断、暂停等，
 *     继续后需要读取未执行清单，继续执行。
 *
 * 三处真实缺口：
 *   1. 插队：M1 判成「独立任务」要等分支结束，后发的 M2 判成「相关」立刻被读走；
 *      分支结束得早（步数用尽 / 用户停止）时 M1 就被跳过。
 *   2. 收尾丢弃：`finish()` 把还在队列里的节点记成完成/取消，那些消息再也不会执行。
 *   3. 续跑不读清单：运行结束后，没执行的消息没有任何地方记着，下一轮无从继续。
 *
 * 用法：node test/check-no-skip.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
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
const QUEUE = read('src/agent/taskQueue.ts');
const RUNNER = read('src/agent/agentRunner.ts');
const PANEL = read('src/views/chatPanel.ts');
const STORAGE = read('src/core/storage.ts');
const TYPES = read('src/core/types.ts');
const I18N = read('src/core/i18n.ts');

/* ── 1. 不许插队 ─────────────────────────────────────────────────── */
check(
  'enqueue：前面还有没执行的独立消息时，「相关」必须降级成「排队」',
  /classified\.relation === 'related' && this\.hasEarlierQueued\(seq\)/.test(QUEUE),
  '不降级的话，后发的会越过先发的执行',
);
check(
  '边界重判同样不许插队',
  /relation === 'related' && this\.hasEarlierQueued\(task\.seq\)/.test(QUEUE),
);
check(
  '顺序由发送序号决定，不靠数组先后',
  /seq: number;/.test(QUEUE) && /\.sort\(\(left, right\) => left\.seq - right\.seq\)/.test(QUEUE),
);

/* ── 2. 收尾不丢消息 ─────────────────────────────────────────────── */
check(
  'finish：队列里的节点保持「排队」，不记成完成/取消',
  /const held = new Set\(\[\.\.\.this\.related, \.\.\.this\.queued\]\.map\(\(task\) => task\.nodeId\)\);/.test(QUEUE)
    && /if \(held\.has\(node\.id\)\) continue;/.test(QUEUE),
);
check(
  '收尾清单按发送顺序交还（retainedTasks）',
  /retainedTasks\(\): AgentTaskUpdate\[\]/.test(QUEUE),
);
check(
  '面板收尾时把清单写进存档，不把占位消息结算成失败',
  /private async retainPendingTasks/.test(PANEL)
    && /retained\.has\(response\.assistantMessageId\)\) continue;/.test(PANEL),
);
check(
  '用户消息保持「还没执行」，不标成已跳过',
  /executionStatus: 'pending'/.test(PANEL) && /chat\.queuedRetained/.test(I18N),
);

/* ── 3. 步数用尽 / 中断后继续执行 ────────────────────────────────── */
check(
  'Agent 循环：步数用尽但队列还有消息 → 给新预算继续',
  /const pending = budgetExtensions < MAX_BUDGET_EXTENSIONS/.test(RUNNER)
    && /hasPendingTasks/.test(RUNNER),
);
check(
  '独立分支（排队消息）各自有步数预算',
  /if \(update\.relation === 'queued'\) \{\n\s*step = 0;/.test(RUNNER),
  '整轮共用预算时，后面的消息必然一步都轮不到',
);
check(
  '面板如实回答「还有没执行的」',
  /hasPendingTasks: \(\) => taskQueue\.pendingTaskCount\(\) > 0/.test(PANEL),
);

/* ── 4. 续跑：读清单放回队列 ─────────────────────────────────────── */
check(
  '存档里有未执行消息清单（pendingTaskIds）',
  /pendingTaskIds\?: string\[\];/.test(TYPES) && /pendingTaskIds\?: string\[\] \| null;/.test(STORAGE),
);
check(
  '读盘时归一化脏值（去空、去重、保序）',
  /function normalizePendingTaskIds/.test(STORAGE),
);
check(
  '下一轮开始时把清单放回队列',
  /taskQueue\.seedPending\(await this\.pendingTaskSeed\(conversationId\)\)/.test(PANEL)
    || /seedPending\(\[seed\]\)/.test(PANEL),
);
check(
  '放回的消息不重新分类（身份已经定过）',
  /reviewedFor: \[this\.currentNodeId\]/.test(QUEUE),
);
check(
  '取走一条就立刻收窄清单（崩溃后不重复执行）',
  /await this\.persistPendingTaskIds\(run\);/.test(PANEL),
);
check(
  '被删掉的消息不再续跑',
  /kept\.length !== ids\.length/.test(PANEL),
);
check(
  '占位消息在重启后仍算「待执行」，不改判成错误',
  /this\.findSummary\(conversationId\)\?\.pendingTaskIds \?\? \[\]\)\.includes\(message\.replyToMessageId!\)/.test(STORAGE),
);

/* ── 5. 真实队列跑一遍用户的场景 ─────────────────────────────────── */
mkdirSync('out/check', { recursive: true });
buildSync({
  entryPoints: ['src/agent/taskQueue.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/check/taskQueue.cjs',
  // i18n 会 `import * as vscode`：这里只跑纯队列逻辑，指向测试替身即可。
  alias: { vscode: './src/test/support/vscodeMock.ts' },
  logLevel: 'silent',
});
const require = createRequire(import.meta.url);
const { AgentTaskQueue } = require(resolve('out/check/taskQueue.cjs'));

const noop = () => {};
const queue = new AgentTaskQueue('修登录刷新');
const add = (text, relation, id) => queue.enqueue(text, { role: 'user', content: text }, async () => ({ relation }), noop, {
  userMessageId: `user-${id}`,
  assistantMessageId: `assistant-${id}`,
});
add('M1 独立任务', 'queued', '1');
await queue.awaitRouting();
add('M2 相关指导', 'related', '2');
await queue.awaitRouting();
add('M3 独立任务', 'queued', '3');
await queue.awaitRouting();

const statusOf = (id) => queue.state().nodes.find((node) => node.userMessageId === `user-${id}`)?.status;
check('M2 不会越过先到的 M1 抢先执行', statusOf('2') === 'queued', `实际 ${statusOf('2')}`);

await queue.finish('cancelled', noop);
check(
  '按了停止之后三条都还在清单里，顺序不变',
  JSON.stringify(queue.retainedTasks().map((task) => task.userMessageId)) === JSON.stringify(['user-1', 'user-2', 'user-3']),
  JSON.stringify(queue.retainedTasks().map((task) => task.userMessageId)),
);
check('停止之后节点仍显示「未执行」', statusOf('1') === 'queued' && statusOf('3') === 'queued');

const resumed = new AgentTaskQueue('继续');
resumed.seedPending([
  { title: 'M1', request: { role: 'user', content: 'M1 独立任务' }, binding: { userMessageId: 'user-1' } },
  { title: 'M2', request: { role: 'user', content: 'M2 相关指导' }, binding: { userMessageId: 'user-2' } },
  { title: 'M3', request: { role: 'user', content: 'M3 独立任务' }, binding: { userMessageId: 'user-3' } },
]);
const order = [];
for (let index = 0; index < 5; index += 1) {
  const taken = await resumed.take('complete', noop);
  if (!taken.length) break;
  order.push(taken[0].userMessageId);
}
check(
  '续跑按原顺序执行完三条，一条不落',
  JSON.stringify(order) === JSON.stringify(['user-1', 'user-2', 'user-3']),
  JSON.stringify(order),
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「不跳过未执行消息」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('先来先做、收尾不丢、续跑按清单继续：未执行的消息不会再被跳过。');
}
