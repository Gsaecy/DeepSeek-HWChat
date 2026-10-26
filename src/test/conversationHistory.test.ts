import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationHistoryDigest } from '../core/conversationHistory';
import type { ChatMessage, ConversationSummary } from '../core/types';

const conversation: ConversationSummary = {
  id: 'conversation-source',
  title: '大型任务',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 4,
  preview: '完成',
  pinned: false,
  totalTokens: 12_345,
  sourceHistoryDigest: '更早的历史要求：不要覆盖用户配置。',
};

const messages: ChatMessage[] = [
  { id: 'm1', role: 'user', content: '修复工作区路径和缓存崩溃问题', createdAt: 1, updatedAt: 1, status: 'complete' },
  {
    id: 'm2', role: 'assistant', content: '路径问题已修复。', createdAt: 2, updatedAt: 2, status: 'complete',
    toolExecutions: [{
      callId: 'call-1', name: 'replace_in_file', summary: '修改路径解析', output: 'done', status: 'success',
      approval: 'not-required', startedAt: 1, finishedAt: 2, changedFiles: ['src/agent/workspacePaths.ts'], risk: 'write',
    }, {
      callId: 'call-2', name: 'run_command', summary: '旧命令方案失败', output: '路径隔离拦截', status: 'error',
      approval: 'not-required', startedAt: 2, finishedAt: 3, risk: 'command',
    }],
  },
];

test('builds a compact handoff with goals, files, failures and upstream history', () => {
  const digest = buildConversationHistoryDigest(conversation, messages);
  assert.match(digest, /修复工作区路径和缓存崩溃问题/);
  assert.match(digest, /src\/agent\/workspacePaths\.ts/);
  assert.match(digest, /路径隔离拦截/);
  assert.match(digest, /不要覆盖用户配置/);
});

test('caps the handoff size for large conversations', () => {
  const largeMessages = Array.from({ length: 80 }, (_, index): ChatMessage => ({
    id: `m-${index}`,
    role: 'user',
    content: `第 ${index} 条要求 ${'很长的任务历史'.repeat(200)}`,
    createdAt: index,
    updatedAt: index,
    status: 'complete',
  }));
  const digest = buildConversationHistoryDigest({ ...conversation, messageCount: largeMessages.length }, largeMessages, 2_400);
  assert.ok(digest.length <= 2_450);
  assert.match(digest, /任务历史摘要已截断/);
});
