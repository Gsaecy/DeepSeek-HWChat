import assert from 'node:assert/strict';
import test from 'node:test';
import { compactGroupLine } from '../views/groupPanel';
import { makeGroupMessage, type SyncPeer } from '../sync/lanProtocol';

/**
 * 团队群窗口的紧凑行（用户 2026-11-23）：
 *   「群的对话窗口你准备放在哪里？……那就需要将显示的输出简化缩小，避免信息繁杂」
 *
 * 所以群窗口一行只保留：谁 · 什么阶段 · 什么时候 · 一句话正文。
 * 这里钉住三件事：标签能区分甲乙方、正文压成单行、跨天带日期。
 */

const win: SyncPeer = { id: 'p-win', name: 'PC · Windows', platform: 'win32', project: 'app-win', version: 't' };
const mac: SyncPeer = { id: 'p-mac', name: 'Mac · macOS', platform: 'darwin', project: 'app-mac', version: 't' };

test('紧凑行：甲方与乙方标签能区分', () => {
  const fromUser = makeGroupMessage(win, { author: 'user', phase: 'requirement', body: '加个深色开关' }, 1000, 'a')!;
  const fromAgent = makeGroupMessage(mac, { author: 'agent', phase: 'question', body: '跟随系统还是手动？' }, 1000, 'b')!;

  const userLine = compactGroupLine(fromUser, 1000);
  const agentLine = compactGroupLine(fromAgent, 1000);
  assert.match(userLine.who, /甲方/);
  assert.match(agentLine.who, /乙方/);
  assert.match(agentLine.who, /macOS/);
  assert.equal(userLine.phase, '需求');
  assert.equal(agentLine.phase, '追问');
});

test('紧凑行：正文压成一行（换行不会把列表撑开）', () => {
  const message = makeGroupMessage(win, {
    author: 'agent',
    phase: 'analysis',
    body: '我理解：\n1. 设置页加开关\n2. 默认跟随系统',
  }, 1000, 'c')!;
  const line = compactGroupLine(message, 1000);
  assert.equal(line.body.includes('\n'), false, '必须压成单行');
  assert.match(line.body, /设置页加开关/);
});

test('紧凑行：当天只显示时分，跨天带日期', () => {
  const at = new Date(2026, 10, 23, 9, 5).getTime();
  const message = makeGroupMessage(win, { author: 'agent', phase: 'result', body: '完成' }, at, 'd')!;
  const sameDay = compactGroupLine(message, new Date(2026, 10, 23, 20, 0).getTime());
  const otherDay = compactGroupLine(message, new Date(2026, 10, 25, 20, 0).getTime());
  assert.equal(sameDay.time, '09:05');
  assert.match(otherDay.time, /11\/23 09:05/);
});
