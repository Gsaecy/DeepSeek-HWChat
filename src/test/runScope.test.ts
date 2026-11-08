import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EpochGuard, makeRunId } from '../core/runScope';

const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const EXECUTOR = readFileSync('src/agent/toolExecutor.ts', 'utf8');

function bodyOf(source: string, marker: string, length = 1200): string {
  const index = source.indexOf(marker);
  assert.ok(index > 0, `找不到 ${marker}`);
  return source.slice(index, index + length);
}

test('EpochGuard：换一份状态后，之前记下的代次全部作废', () => {
  const guard = new EpochGuard();
  const first = guard.current;
  assert.equal(guard.isStale(first), false);
  guard.bump();
  assert.equal(guard.isStale(first), true);
  assert.equal(guard.isStale(guard.current), false);
});

test('EpochGuard：A → B → A 切回来仍然算过期', () => {
  /*
   * 这正是不能直接比较 `activeConversationId` 的原因：
   * 切走再切回同一个对话时 id 一模一样，只有代次能证明中间发生过切换。
   */
  const guard = new EpochGuard();
  const epochInA = guard.current;
  guard.bump(); // 切到 B
  guard.bump(); // 切回 A
  assert.equal(guard.isStale(epochInA), true);
});

test('EpochGuard：不提升就永远不过期（正常路径不受影响）', () => {
  const guard = new EpochGuard();
  const epoch = guard.current;
  for (let index = 0; index < 50; index += 1) assert.equal(guard.isStale(epoch), false);
});

test('每轮运行的 id 都不重复，且能看出属于哪条对话', () => {
  const ids = new Set<string>();
  for (let index = 1; index <= 200; index += 1) {
    // 故意让时间戳完全相同：靠序号也要能区分。
    ids.add(makeRunId('conv-1', index, 1_700_000_000_000));
  }
  assert.equal(ids.size, 200, '同一毫秒内连续 200 轮也必须互不相同');
  for (const id of ids) assert.ok(id.startsWith('conv-1#'), `runId 应带对话 id：${id}`);
  // 不同对话不会撞。
  assert.notEqual(makeRunId('conv-a', 1, 1), makeRunId('conv-b', 1, 1));
});

test('当前对话的每处赋值都必须走 setActiveConversation（否则草稿代次不会提升）', () => {
  // 唯一允许出现裸赋值的地方就是 setter 自己。
  const setterStart = PANEL.indexOf('private setActiveConversation(');
  assert.ok(setterStart > 0);
  const setterEnd = PANEL.indexOf('\n  }', setterStart) + 4;
  const outside = PANEL.slice(0, setterStart) + PANEL.slice(setterEnd);
  const bare = [...outside.matchAll(/this\.activeConversationId = /g)];
  assert.equal(bare.length, 0, `还有 ${bare.length} 处直接赋值，绕过了代次提升`);
  assert.match(PANEL, /private setActiveConversation\(/, '必须保留集中赋值的方法');
  assert.match(bodyOf(PANEL, 'private setActiveConversation(', 400), /this\.draftEpoch\.bump\(\)/);
});

test('切到同一个对话不提升代次（避免无意义地作废在飞结果）', () => {
  const body = bodyOf(PANEL, 'private setActiveConversation(', 400);
  assert.match(body, /if \(this\.activeConversationId === id\) return;/);
});

test('两条附件异步链都在落地前对代次', () => {
  for (const marker of ['async attachFiles(', 'private async attachMessageAttachment(']) {
    const body = bodyOf(PANEL, marker, 3000);
    assert.match(body, /const epoch = this\.draftEpoch\.current;/, `${marker} 必须记下代次`);
    assert.match(body, /this\.draftEpoch\.isStale\(epoch\)/, `${marker} 落地前必须校验代次`);
  }
  // 丢弃必须说出来：静默丢等于「点了没反应」。
  const discards = [...PANEL.matchAll(/tt\('notice\.attachDiscarded'\)/g)];
  assert.ok(discards.length >= 2, `两处丢弃都要提示用户，实际 ${discards.length} 处`);
});

test('运行收尾只删自己那一轮的登记', () => {
  // 只禁止「裸的一行」：带 `if (this.runs.get(...) === run)` 守卫的那一行是正确写法。
  assert.doesNotMatch(
    PANEL,
    /^[ \t]*this\.runs\.delete\(conversationId\);[ \t]*$/m,
    '无条件 delete(conversationId) 会把同一对话新起的那一轮删掉',
  );
  assert.match(PANEL, /if \(this\.runs\.get\(conversationId\) === run\) this\.runs\.delete\(conversationId\);/);
});

test('审批与方案卡片按 runId 结算，不再按对话整片结算', () => {
  const approval = bodyOf(PANEL, 'private rejectApprovalsFor(', 600);
  assert.match(approval, /private rejectApprovalsFor\(run: ConversationRun\)/);
  assert.match(approval, /pending\.runId !== run\.runId/);
  const decision = bodyOf(PANEL, 'private settleDecisionsFor(', 800);
  assert.match(decision, /private settleDecisionsFor\(run: ConversationRun\)/);
  assert.match(decision, /pending\.runId !== run\.runId/);
  // 收尾处必须传 run 而不是 conversationId。
  assert.match(PANEL, /this\.rejectApprovalsFor\(run\);/);
  assert.match(PANEL, /this\.settleDecisionsFor\(run\);/);
});

test('两张卡片建立时都带上了 runId', () => {
  assert.match(PANEL, /this\.pendingApprovals\.set\(requestId, \{\s*conversationId: run\.conversationId,\s*runId: run\.runId,/);
  assert.match(PANEL, /this\.pendingDecisions\.set\(requestId, \{ conversationId: run\.conversationId, runId: run\.runId,/);
});

test('危险档审批走原生模态框（webview 被注入也伪造不了）', () => {
  assert.match(PANEL, /private async requestToolApproval\(\s*summary: string,\s*detail: string,\s*risk: 'read' \| 'write' \| 'command',\s*run: ConversationRun,\s*dangerous = false,/);
  const body = bodyOf(PANEL, 'private async requestToolApproval(', 3000);
  // 危险分支必须在「面板卡片」之前，并且用 modal: true。
  const dangerousIndex = body.indexOf('if (dangerous)');
  const cardIndex = body.indexOf('this.pendingApprovals.set');
  assert.ok(dangerousIndex > 0, '必须有 dangerous 分支');
  assert.ok(cardIndex > dangerousIndex, '危险分支必须早于面板卡片分支');
  assert.match(body.slice(dangerousIndex, cardIndex), /modal: true/);
  // 调用点要把 dangerous 传进去。
  assert.match(PANEL, /this\.requestToolApproval\(request\.summary, request\.detail, request\.risk, run, request\.dangerous\)/);
});

test('危险档标记来自命令分档，不是靠关键词再猜一遍', () => {
  const matches = [...EXECUTOR.matchAll(/dangerous: tier === 'severe'/g)];
  assert.equal(matches.length, 2, `两处构造审批请求的地方都要打标记，实际 ${matches.length} 处`);
});
