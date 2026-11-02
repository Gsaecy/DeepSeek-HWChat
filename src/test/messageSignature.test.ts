/**
 * 「这次状态推送要不要带消息正文」的判定。
 *
 * 现场（审计实测）：1513 条消息的对话，`sendState()` 仅首页 80 条就 5.39 MB，
 * 单次推送约 27ms 主线程开销，而它有 22 处调用点。绝大多数调用只改了设置或清单，
 * 消息一条没变 —— 判定错了就会「该省的不省」或更糟的「该推的不推，界面停在旧内容」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '../core/types';
import { messagesSignatureKey } from '../views/messageSignature';

const base = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  content: 'hello',
  createdAt: 1,
  updatedAt: 1,
  status: 'complete',
  ...over,
});

test('签名：内容没变 → 相同（省掉 5 MB 传输）', () => {
  const messages = [base(), base({ id: 'm2', content: 'world' })];
  assert.equal(
    messagesSignatureKey(0, 'c1', messages),
    messagesSignatureKey(0, 'c1', [base(), base({ id: 'm2', content: 'world' })]),
  );
});

test('签名：正文变长必须不同（不能把新内容漏掉）', () => {
  assert.notEqual(
    messagesSignatureKey(0, 'c1', [base({ content: 'hello' })]),
    messagesSignatureKey(0, 'c1', [base({ content: 'hello world' })]),
  );
});

test('签名：同样长度但改过的消息也要不同（靠 updatedAt 兜住）', () => {
  assert.notEqual(
    messagesSignatureKey(0, 'c1', [base({ content: 'aaaa', updatedAt: 1 })]),
    messagesSignatureKey(0, 'c1', [base({ content: 'bbbb', updatedAt: 2 })]),
  );
});

test('签名：工具步骤状态变化必须不同（否则「待执行」永远不变绿）', () => {
  const running = base({ toolExecutions: [{ callId: 'c1', name: 'read_file', summary: 's', status: 'pending', startedAt: 1 }] });
  const done = base({ toolExecutions: [{ callId: 'c1', name: 'read_file', summary: 's', status: 'success', startedAt: 1 }] });
  assert.notEqual(messagesSignatureKey(0, 'c1', [running]), messagesSignatureKey(0, 'c1', [done]));
});

test('签名：工具输出变长必须不同', () => {
  const short = base({ toolExecutions: [{ callId: 'c1', name: 'read_file', summary: 's', status: 'success', startedAt: 1, output: 'x' }] });
  const long = base({ toolExecutions: [{ callId: 'c1', name: 'read_file', summary: 's', status: 'success', startedAt: 1, output: 'x'.repeat(500) }] });
  assert.notEqual(messagesSignatureKey(0, 'c1', [short]), messagesSignatureKey(0, 'c1', [long]));
});

test('签名：新增/删除消息、换对话、换 webview 代次都必须不同', () => {
  const one = [base()];
  const two = [base(), base({ id: 'm2' })];
  assert.notEqual(messagesSignatureKey(0, 'c1', one), messagesSignatureKey(0, 'c1', two), '新增消息要推');
  assert.notEqual(messagesSignatureKey(0, 'c1', one), messagesSignatureKey(0, 'c2', one), '换对话要推');
  assert.notEqual(messagesSignatureKey(0, 'c1', one), messagesSignatureKey(1, 'c1', one), 'webview 重建后必须强制全量');
});

test('签名：附件数量变化必须不同（缩略图要重新出）', () => {
  const plain = base();
  const withAttachment = base({ attachments: [{ label: 'a.png', kind: 'image', id: 'x' }] });
  assert.notEqual(messagesSignatureKey(0, 'c1', [plain]), messagesSignatureKey(0, 'c1', [withAttachment]));
});

test('签名：空列表也稳定（不抛错、可比较）', () => {
  assert.equal(messagesSignatureKey(0, '', []), messagesSignatureKey(0, '', []));
});
