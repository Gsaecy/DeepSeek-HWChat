import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TEAM_GROUP_PROMPT } from '../sync/lanProtocol';

/**
 * 频道优先级（用户 2026-11-23 的追问）：
 *   「需要协调完成，或者一个功能两个 agent 都需要做的时候，
 *    是哪个对话框的用户消息起作用？」
 *
 * 定死的规则：**群 = 双方共享且权威；主对话 = 只给本机**。
 * 两个输入框如果都广播，就等于两个事实来源，冲突时谁也说不清。
 *
 * 这里钉住三件事：群里的决定优先、冲突不许悄悄分叉、代码里只有群频道会广播。
 */

const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');

test('频道规则：只有 origin=group 才广播给对端', () => {
  // 广播（shareRequirement）必须发生在 origin === 'group' 分支里。
  const groupBranch = PANEL.indexOf("options?.origin === 'group'");
  assert.ok(groupBranch > 0, '必须显式区分群频道');
  const broadcast = PANEL.indexOf('shareRequirement(content)', groupBranch);
  assert.ok(broadcast > groupBranch, '广播必须在群频道分支内');

  // 主对话（没有 origin）不应再广播：它只提醒一次「这条只发给了本机」。
  const notice = PANEL.indexOf('sync.localOnlyNotice');
  assert.ok(notice > broadcast, '主对话要有一次性提示，说明没有同步出去');
});

test('群窗口发送走 origin=group（否则等于只在群里演戏）', () => {
  const index = PANEL.indexOf('async sendGroupMessage(');
  assert.ok(index > 0);
  const body = PANEL.slice(index, index + 260);
  assert.match(body, /origin: 'group'/, '群窗口的消息必须标成群频道');
});

test('对端发来的消息不会再次广播（防两台机器互相转发）', () => {
  const index = PANEL.indexOf("origin: 'sync'");
  assert.ok(index > 0);
  const guard = PANEL.indexOf("options?.origin !== 'sync'", index - 1200);
  assert.ok(guard > 0, '必须有「来自同步就不再广播」的判断');
});

test('提示词：群里的决定优先，冲突不许悄悄分叉', () => {
  assert.match(TEAM_GROUP_PROMPT, /authoritative/i, '要说明群里的决定是权威的');
  assert.match(TEAM_GROUP_PROMPT, /single-agent chat belongs to that one device/i, '要说明主对话只作用于本机');
  assert.match(TEAM_GROUP_PROMPT, /do not silently diverge/i, '冲突时要先说清再确认，而不是各自实现一套');
});
