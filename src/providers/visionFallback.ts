/**
 * 模型/接口不接受图片输入时，把消息降级成纯文本。
 *
 * 真实故障（用户 2026-11-04，连发两次同样的请求都失败）：
 *
 *     请求失败：接口请求失败（400）：messages.content.type 参数非法，取值范围 ['text']
 *
 * 原因是 HWChat 把带图的用户消息发成了 OpenAI 的多模态内容数组
 * （`[{type:'text'}, {type:'image_url'}]`），而这个接口/模型只接受 `text`。
 * 更糟的是它被归到「请求失败」，用户看到的就是「同一个请求再发一次也一样失败」——
 * 因为失败与参数无关，**是这次请求的形状整个不被接受**。
 *
 * 正确做法（与 `removeRejectedReasoningControl` 同一个思路）：把服务端的拒绝当成
 * **可以自我修正的信号**，去掉图片部分重发一次；成功之后记住这对
 * 「配置档 + 模型」不支持图片，后续请求**一开始**就不发图片，并把这一点告诉用户。
 */

/** 服务端明确说「content 只允许 text」这一类拒绝。 */
const TEXT_ONLY_PATTERNS: readonly RegExp[] = [
  /content\.type[^。\n]{0,40}(?:非法|不支持|invalid|not\s+support)/i,
  /(?:只支持|only\s+support[s]?|must\s+be)\s*\[?['"]?text['"]?\]?/i,
  /image_url[^。\n]{0,30}(?:not\s+(?:supported|allowed)|不支持|invalid)/i,
  /(?:does\s+not|doesn't)\s+support\s+(?:image|vision|multimodal)/i,
  /(?:不支持|无法处理)[^。\n]{0,10}(?:图片|图像|多模态)/,
];

/**
 * 这条 400 的说明是不是「不接受图片内容」。
 *
 * 只在**确实带了图片**的时候才值得去匹配 —— 没有图片还判成这一类，会把
 * 一个真正的参数错误（例如 tools 格式不对）错当成图片问题，掩盖真正的失败原因。
 */
export function isTextOnlyContentRejection(detail: string, hasImageParts: boolean): boolean {
  if (!hasImageParts) return false;
  const value = String(detail ?? '');
  if (!value) return false;
  return TEXT_ONLY_PATTERNS.some((pattern) => pattern.test(value));
}

/** 消息里有没有图片部分（决定要不要走这条路）。 */
export function hasImageParts(messages: readonly { content: unknown }[]): boolean {
  return messages.some((message) => Array.isArray(message.content)
    && (message.content as Array<{ type?: string }>).some((part) => part?.type === 'image_url'));
}

/** 最多保留多少个字：降级说明本身不该把正文挤爆。 */
const NOTE_LIMIT = 400;

/**
 * 去掉图片部分，并把「已省略图片」写进正文。
 *
 * 为什么要写进正文：原文里本来就有 `<attached_image name="…" />` 标记，
 * 只删图不说明，模型会以为自己"看到了"却描述不出来，反而更容易编造画面内容。
 * 明确写「当前模型不支持图片输入，内容已省略」能让它老实说不知道。
 */
export function stripImageParts<T extends { content: unknown }>(
  messages: readonly T[],
  note: string,
): { messages: T[]; dropped: number } {
  let dropped = 0;
  const next = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const parts = message.content as Array<{ type?: string; text?: string }>;
    const kept = parts.filter((part) => part?.type !== 'image_url');
    const removed = parts.length - kept.length;
    if (!removed) return message;
    dropped += removed;
    const trimmedNote = note.slice(0, NOTE_LIMIT);
    // 说明并到最后一段文本上：多处文本分散时，追加到末尾最不容易被当成指令。
    const lastTextIndex = kept.reduce((last, part, index) => (part?.type === 'text' ? index : last), -1);
    const merged = lastTextIndex >= 0
      ? kept.map((part, index) => (index === lastTextIndex
        ? { ...part, text: `${part.text ?? ''}\n\n${trimmedNote}` }
        : part))
      : [{ type: 'text', text: trimmedNote }];
    /*
     * 只剩一段文本时**降级成字符串**：有些接口连 `[{type:'text'}]` 的数组都不接受，
     * 它们要的是 `messages.content` 直接为字符串。这一步是把兼容性做到最大。
     */
    const content = merged.length === 1 && merged[0]?.type === 'text'
      ? merged[0].text ?? ''
      : merged;
    return { ...message, content };
  });
  return { messages: next, dropped };
}
