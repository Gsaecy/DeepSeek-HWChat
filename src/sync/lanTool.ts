/**
 * `team_sync`：让 agent 像同事一样和对端设备的 agent 沟通。
 *
 * 用户的原话（2026-11-23）：
 *   「甚至两边设备的 agent 可以像一个团队的同事一样沟通交流项目的情况，互通有无」
 *
 * 工具刻意只有三个动作：
 *  - `send`：把一段话发给队友（例如「我把窗口标题栏改成自绘了，你那边边距要不要一起调」）；
 *  - `ask`：发一个**需要回答**的问题（对端会自动跑一轮来回答）；
 *  - `status`：看当前协作状态、最近消息、以及哪些需求还没对齐。
 *
 * 为什么不做成「自由聊天」：两个 agent 无限互发会把配额烧光。所以协议层有
 * `shouldAutoRespond`（只有真在问才触发对端自动运行），提示词层也明令禁止
 * 「收到 / 好的」这类空消息。
 */

import { renderNotes } from './lanProtocol';
import type { LanSyncService } from './lanSync';
import type { ToolDefinition, ToolExecutionResult } from '../core/types';

export function teamSyncToolDefinition(enabled: boolean): ToolDefinition | undefined {
  if (!enabled) return undefined;
  return {
    type: 'function',
    function: {
      name: 'team_sync',
      description: [
        '与同一 WiFi 下另一台设备的 agent 沟通（同一个 app 的另一个平台版本）。',
        'action=send 发一条进展或决定；action=ask 向队友提问（对方会跑一轮来回答）；action=status 查看协作状态与待对齐项。',
        '只在确有必要时使用：不要发「收到」「好的」这类空消息，也不要为了保证同步而重复发同样内容。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['send', 'ask', 'status'] },
          message: { type: 'string', description: '要发的内容（action=send / ask 时必填）' },
          topic: { type: 'string', description: '可选主题，便于把同一件事的往来归组' },
          replyTo: { type: 'string', description: '可选：回复哪一条消息的 id' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  };
}

export interface TeamSyncResult {
  status: 'success' | 'denied';
  summary: string;
  content: string;
}

/** 执行一次 `team_sync`。同步未启用时明确拒绝，而不是假装成功。 */
export async function runTeamSync(
  service: LanSyncService | undefined,
  args: Record<string, unknown>,
): Promise<TeamSyncResult> {
  if (!service) {
    return {
      status: 'denied',
      summary: '局域网同步未启用',
      content: '局域网同步没有启用，无法联系队友。需要用户在 HWChat 里启动「局域网同步」后再试。',
    };
  }
  const action = typeof args.action === 'string' ? args.action : 'status';
  if (action === 'status') {
    const state = service.state();
    const notes = renderNotes(service.recentNotes(8), 8);
    const requirements = service.requirementTitles(6);
    return {
      status: 'success',
      summary: state.text,
      content: [
        state.text,
        requirements.length ? `最近需求：\n- ${requirements.join('\n- ')}` : '最近需求：（无）',
        notes.length ? `最近消息：\n- ${notes.join('\n- ')}` : '最近消息：（无）',
      ].join('\n\n'),
    };
  }
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (!message) {
    return { status: 'denied', summary: '缺少消息内容', content: 'action=send / ask 时必须提供 message。' };
  }
  const question = action === 'ask';
  const result = await service.shareNote({
    body: question ? `${message}` : message,
    topic: typeof args.topic === 'string' ? args.topic : '',
    replyTo: typeof args.replyTo === 'string' ? args.replyTo : '',
  });
  return {
    status: result.ok ? 'success' : 'denied',
    summary: question ? '已向队友提问' : '已发送给队友',
    content: result.message,
  };
}
