/**
 * 升级前的老对话：预设 / 步数 / 思考深度只存在于旧版全局设置里。
 *
 * 现场（用户 2026-11-09，Windows）：装上 0.4.15 之后，所有历史对话的
 * 「自动 / 不限制」变成「每次询问 / 24 步」。根因是这几个字段 0.2.5 才改成
 * 按对话存档，老对话存档里没有；升级后固定初始值兜底把它们盖住了。
 *
 * 规则：
 *  - 有消息、且对应字段缺失 → 用旧全局值补一次并落盘；
 *  - 0 条消息（等同于新对话）→ 不补，保持固定初始值；
 *  - 存档里已经有的值 → 绝不覆盖。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStorage } from '../core/storage';

const LEGACY = {
  permissionPreset: 'autopilot',
  agentMaxSteps: 0,
  reasoningEffort: 'max',
} as const;

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-legacy-controls-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('升级前有消息的老对话从旧全局设置补齐三项，并写回 manifest', async () => {
  await withRoot(async (root) => {
    const before = new ConversationStorage(root);
    const conversation = await before.createConversation();
    await before.appendMessage(conversation.id, { role: 'user', content: '升级前的对话', status: 'complete' });
    await before.flush();
    assert.equal((await before.getConversation(conversation.id))?.permissionPreset, undefined, '旧存档里本来没有这一项');

    const upgraded = new ConversationStorage(root, { legacyControls: LEGACY });
    const summary = await upgraded.getConversation(conversation.id);
    assert.equal(summary?.permissionPreset, 'autopilot');
    assert.equal(summary?.agentMaxSteps, 0, '0 是显式的「不限制」，必须原样保留');
    assert.equal(summary?.reasoningEffort, 'max');

    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      conversations: Array<Record<string, unknown>>;
    };
    const stored = manifest.conversations.find((item) => item.id === conversation.id);
    assert.equal(stored?.permissionPreset, 'autopilot');
    assert.equal(stored?.agentMaxSteps, 0);
    assert.equal(stored?.reasoningEffort, 'max');
  });
});

test('0 条消息的对话等同于新对话，不吃旧全局设置', async () => {
  await withRoot(async (root) => {
    const before = new ConversationStorage(root);
    const empty = await before.createConversation();
    await before.flush();

    const upgraded = new ConversationStorage(root, { legacyControls: LEGACY });
    const summary = await upgraded.getConversation(empty.id);
    assert.equal(summary?.permissionPreset, undefined);
    assert.equal(summary?.agentMaxSteps, undefined);
    assert.equal(summary?.reasoningEffort, undefined);
  });
});

test('存档里已有的值不会被旧全局设置覆盖（只补缺失项）', async () => {
  await withRoot(async (root) => {
    const before = new ConversationStorage(root);
    const conversation = await before.createConversation();
    await before.appendMessage(conversation.id, { role: 'user', content: '新版本的对话', status: 'complete' });
    await before.updateConversation(conversation.id, { permissionPreset: 'review', agentMaxSteps: 68 });
    await before.flush();

    const upgraded = new ConversationStorage(root, { legacyControls: LEGACY });
    const summary = await upgraded.getConversation(conversation.id);
    assert.equal(summary?.permissionPreset, 'review');
    assert.equal(summary?.agentMaxSteps, 68);
    // 这一项本来就没写过，可以补。
    assert.equal(summary?.reasoningEffort, 'max');
  });
});
