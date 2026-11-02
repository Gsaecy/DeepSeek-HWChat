/**
 * 消息列表的「画面签名」——决定这次状态推送要不要带上消息正文。
 *
 * 为什么需要它（实测）：一条 1513 条消息的对话，`sendState()` 里仅首页 80 条消息
 * 就是 **5.39 MB**，一次推送在主线程上约 27ms（扩展侧 stringify + 结构化克隆 +
 * webview 端 parse），而 `sendState()` 有 22 处调用点（切对话、置顶、归档、运行结束…）。
 * 绝大多数调用只改了设置/列表/清单，消息一条都没变 —— 却每次都在搬 5 MB。
 *
 * 设计要点：
 *  - 只拼「会让画面不同」的字段，**不拼正文**（只看长度），所以 80 条是微秒级；
 *  - 正文、推理、工具输出只要变了，长度或 `updatedAt` 一定跟着变 → 不会漏推；
 *  - 代次（`generation`）编进签名：webview 被重建后它内存里什么都没有，必须强制全量。
 *
 * 与 `media/chat.js` 的 `messageListSignature` 是同源思路，但两侧各管自己：
 * 宿主决定「要不要传」，前端决定「要不要重绘」，都不依赖对方内部实现。
 */
import type { ChatMessage } from '../core/types';

export function messagesSignatureKey(
  generation: number,
  conversationId: string,
  messages: readonly ChatMessage[],
): string {
  const parts = [`${generation}:${conversationId}`];
  for (const message of messages) {
    const tools = message.toolExecutions ?? [];
    const lastTool = tools.length ? tools[tools.length - 1] : undefined;
    parts.push([
      message.id,
      message.role,
      message.status ?? '',
      message.updatedAt,
      (message.content ?? '').length,
      (message.reasoning ?? '').length,
      tools.length,
      lastTool ? `${lastTool.callId}:${lastTool.status}:${(lastTool.output ?? '').length}` : '',
      (message.usedSkills ?? []).length,
      (message.attachments ?? []).length,
    ].join('~'));
  }
  return parts.join('\n');
}
