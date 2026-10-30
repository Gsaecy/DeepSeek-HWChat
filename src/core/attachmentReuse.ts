import { MessageContext } from './types';

/**
 * 「把已经发出去的附件再拿一份放进输入框」的判定。
 *
 * 需求（用户原话）：「已经发到聊天框的消息里面的图片，想要拖动，或者复制到输入框
 * 显示成新的附件」。
 *
 * 为什么要单独一个模块：真正的风险全在这一小段判断里，而且都是**静默出错**的类型 ——
 *  * 索引里明明有原始副本，却去读磁盘（慢，而且 `path` 可能是相对路径）；
 *  * 复制时把原附件的 `id` 一起带过来，两条附件共用一个句柄，打开/删除互相串；
 *  * 索引被 LRU 淘汰后不 fallback，用户点了按钮什么也不发生；
 *  * 上限只在「选文件」那条路上判，拖拽这条路悄悄突破 20 条 / 总量上限。
 *
 * 所以在 `core/` 里做纯函数，IO 留给调用方（`chatPanel`）。
 */

/** 输入框里最多放多少条附件（与「选文件」那条路保持一致）。 */
export const MAX_PENDING_ATTACHMENTS = 20;

export interface AttachmentReuseInput {
  /** `attachmentIndex` 里按 id 命中的原始附件（可能已经被淘汰 → undefined）。 */
  known?: MessageContext;
  /** 界面回传的路径（有些调用方只有路径，没有 id）。 */
  path?: string;
  /** 输入框当前的附件数量与总字节。 */
  pendingCount: number;
  pendingBytes: number;
  /** 总量上限（由设置推导，见 chatPanel）。 */
  maxTotalBytes: number;
}

export type AttachmentReusePlan =
  /** 内存里就有完整内容，直接加这份（已去掉 id）。 */
  | { action: 'add'; attachment: MessageContext }
  /** 内存里没有内容，但有路径：调用方去磁盘读，读完再用 `checkReuseLimits` 复核配额。 */
  | { action: 'read'; path: string }
  /** 既没内容也没路径：这条附件已经取不回来了。 */
  | { action: 'unavailable' }
  /** 输入框里的附件已经到上限。 */
  | { action: 'too-many' }
  /** 再加这一条会超过总量上限。 */
  | { action: 'too-large' };

/** 这条附件在内存里是否还有完整内容（图片是 base64，文本文件是正文）。 */
function hasContent(attachment: MessageContext | undefined): attachment is MessageContext {
  return Boolean(attachment && (attachment.dataBase64 || attachment.content));
}

/**
 * 同一条附加复制成新附件时**必须去掉 id**。
 *
 * `id` 是面板侧用来从索引里取回完整内容的句柄，而且会被 `attachmentForWebview`
 * 写回源对象。复制时带着它，两条附件就共用一个句柄：删掉一条后另一条点开变成
 * 另一条的内容（或取不到），排查起来极其费解。
 */
export function reuseCopy(attachment: MessageContext): MessageContext {
  const copy: MessageContext = { ...attachment };
  delete copy.id;
  return copy;
}

/** 配额判定：数量与总量。用于「已经拿到内容、准备加入」这一步。 */
export function checkReuseLimits(
  bytes: number,
  pendingCount: number,
  pendingBytes: number,
  maxTotalBytes: number,
): 'ok' | 'too-many' | 'too-large' {
  if (pendingCount >= MAX_PENDING_ATTACHMENTS) return 'too-many';
  if (pendingBytes + Math.max(0, bytes) > maxTotalBytes) return 'too-large';
  return 'ok';
}

export function planAttachmentReuse(input: AttachmentReuseInput): AttachmentReusePlan {
  const candidate = hasContent(input.known) ? reuseCopy(input.known) : undefined;
  if (candidate) {
    const limit = checkReuseLimits(candidate.bytes ?? 0, input.pendingCount, input.pendingBytes, input.maxTotalBytes);
    if (limit === 'too-many') return { action: 'too-many' };
    if (limit === 'too-large') return { action: 'too-large' };
    return { action: 'add', attachment: candidate };
  }
  // 索引被淘汰（按字符数 LRU，几 MB 的图片会先出队）或调用方只给了路径。
  const path = (input.known?.path ?? input.path ?? '').trim();
  if (!path) return { action: 'unavailable' };
  // 数量上限与「选文件」一致，先挡掉再读：没必要为一个注定放不下的附件去读几 MB。
  if (input.pendingCount >= MAX_PENDING_ATTACHMENTS) return { action: 'too-many' };
  return { action: 'read', path };
}
