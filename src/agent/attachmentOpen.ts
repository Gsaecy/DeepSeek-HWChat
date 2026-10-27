import { createHash } from 'node:crypto';

/**
 * 附件「点击打开」的决策层。
 *
 * 这里刻意不 import vscode：决策与 IO 分开之后，`node:test` 就能直接验证
 * 「有路径的附件走原文件、粘贴的图片走二进制查看、粘贴的文本走未命名文档」，
 * 不需要启动编辑器。
 *
 * 关键约束（用户明确要求）：打开动作**不允许**移动或覆盖附件本身的位置。
 * 因此三条分支都只读原数据：
 *   - `path`：打开磁盘上那个文件本身；
 *   - `text`：内容来自内存，用未命名文档展示，不落盘；
 *   - `image`：原图只在内存里有，需要一份派生副本才能用图像查看器打开，
 *     副本写在扩展自己的 storage 里（见 `attachmentCacheName`），不碰用户文件。
 */
export interface AttachmentLike {
  label?: string;
  path?: string;
  kind?: 'selection' | 'file' | 'image';
  content?: string;
  dataBase64?: string;
  mimeType?: string;
  language?: string;
}

export type AttachmentOpenPlan =
  /** 磁盘上已有文件：直接按原路径打开。 */
  | { action: 'path'; path: string }
  /** 只有内存文本：开一个未命名文档，不写任何文件。 */
  | { action: 'text'; content: string; language?: string }
  /** 只有内存图片：需要派生一份缓存副本才能用图像查看器打开。 */
  | { action: 'image'; dataBase64: string; extension: string }
  /** 正文已被归档清理，没有可显示的内容。 */
  | { action: 'unavailable' };

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
};

export function imageExtensionFor(mimeType?: string): string {
  return IMAGE_EXTENSIONS[(mimeType ?? '').trim().toLowerCase()] ?? 'png';
}

export function planAttachmentOpen(attachment: AttachmentLike): AttachmentOpenPlan {
  // 顺序很重要：先认路径。有路径说明原文件还在，必须打开它本身，
  // 而不是拿内存里的副本另存一份——那正是「影响附件文件位置」的典型做法。
  const path = (attachment.path ?? '').trim();
  if (path) return { action: 'path', path };

  const dataBase64 = attachment.dataBase64 ?? '';
  if (attachment.kind === 'image' && dataBase64) {
    return { action: 'image', dataBase64, extension: imageExtensionFor(attachment.mimeType) };
  }

  const content = attachment.content;
  if (typeof content === 'string' && content.length) {
    return { action: 'text', content, language: attachment.language };
  }

  return { action: 'unavailable' };
}

/**
 * 派生缓存副本的文件名：按内容寻址。
 *
 * 同一个附件点开两次必须命中同一个文件，否则会在 storage 里堆出无数份同样的
 * 截图。取 32 位十六进制足够避免碰撞，也让文件名短到不会撞上路径长度限制。
 */
export function attachmentCacheName(attachment: AttachmentLike): string {
  const digest = createHash('sha256')
    .update(attachment.dataBase64 ?? '')
    .digest('hex')
    .slice(0, 32);
  return `${digest}.${imageExtensionFor(attachment.mimeType)}`;
}
