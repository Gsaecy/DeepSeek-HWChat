import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMissingChatContextError,
  missingChatContextNotice,
  needsChatContext,
} from '../agent/bridgedTools';

/**
 * 桥接工具的「注定失败」判定。
 *
 * 真实故障（用户 2026-11-07）：
 *
 *     调用 VS Code 工具：copilot_multiReplaceString 失败 → Invalid input
 *
 * 读 VS Code 自带 `extensions/copilot/dist/extension.js` 确认了实现：
 *
 *     async resolveInput(e, n) { return this._promptContext = n, e }
 *     async _prepareEditsForFile(e, n) {
 *       if (… || !this._promptContext) throw …, new Error('Invalid input');
 *
 * `_promptContext` 是聊天请求上下文，`lm.invokeTool` 传不了 → 永远只会回 `Invalid input`。
 * 旧代码只认「invocation context must be provided」这一类措辞，于是：
 *  - 模型拿到一句无信息的 `Invalid input`，换写法重试；
 *  - HWChat 也不学，下一轮照样把它摆在工具清单里。
 */

test('已知需要 chat 上下文的工具：不再下发', () => {
  assert.equal(needsChatContext('run_in_terminal'), true);
  assert.equal(needsChatContext('copilot_multiReplaceString'), true, '实读 Copilot 实现确认它要 promptContext');
  assert.equal(needsChatContext('copilot_replaceString'), true);
});

test('普通桥接工具照常可用（不误伤能力）', () => {
  assert.equal(needsChatContext('copilot_readFile'), false);
  assert.equal(needsChatContext('open_browser_page'), false);
});

test('裸 `Invalid input` 只在已知工具上判成「缺上下文」', () => {
  assert.equal(isMissingChatContextError('Invalid input', 'copilot_multiReplaceString'), true);
  assert.equal(isMissingChatContextError('Invalid input', 'copilot_replaceString'), true);
  // 别的工具回同一句话，可能是真实参数错误：必须原样上报，不能被吞掉变成「不可用」。
  assert.equal(isMissingChatContextError('Invalid input', 'some_other_tool'), false);
  assert.equal(isMissingChatContextError('Invalid input'), false);
});

test('VS Code 原来的两句措辞仍然认', () => {
  assert.equal(isMissingChatContextError('Invocation context must be provided for this tool'), true);
  assert.equal(isMissingChatContextError('toolSpecificData must be provided for this tool'), true);
});

test('编辑类的替代方案是 replace_in_file / write_file，而不是 run_command', () => {
  const notice = missingChatContextNotice('copilot_multiReplaceString');
  assert.match(notice, /replace_in_file/);
  assert.match(notice, /write_file/);
  assert.match(notice, /不要重试/);
  assert.doesNotMatch(notice, /run_command/, '给编辑工具推 run_command 会把模型带偏');
});

test('终端类的替代方案仍然是 run_command', () => {
  const notice = missingChatContextNotice('run_in_terminal');
  assert.match(notice, /run_command/);
  assert.match(notice, /不要重试/);
});

test('说明里必须点明「不是权限/路径/参数问题」', () => {
  for (const name of ['copilot_multiReplaceString', 'run_in_terminal']) {
    const notice = missingChatContextNotice(name);
    assert.match(notice, /不是权限、路径或参数格式的问题/, name);
  }
});
