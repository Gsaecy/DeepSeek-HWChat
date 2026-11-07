import type { ChatMessage, MessageContext, TodoItem } from './types.js';
import { clipText } from './textSafety.js';

/**
 * 上下文窗口：决定「哪些历史还发给模型、被丢掉的怎么不丢记忆」。
 *
 * 真实故障（用户 2026-11-06）：「hwchat 有时候会突然忘记项目」，面板里显示
 * 「我这边没有收到具体请求：当前对话里只有运行环境与工具说明」。
 *
 * 用真实存档复现（`conversation_fde3da6a…`，154 条消息）后确认根因不是模型，
 * 而是这里的预算算法：
 *  - 旧实现按**原始 JSON 字节**从新到旧累加，上限 2 MB；
 *  - 用户贴两张截图的那条消息有 **2747 KB**（base64 直接存在消息里）；
 *  - 新一条消息（助手占位、2 KB）先进窗口，轮到那条 2.7 MB 的用户消息时
 *    `bytes + 2747KB > 2MB` → `break`，**用户这句话被整个丢掉**；
 *  - 占位消息随后因为「内容为空」被跳过 → 请求里只剩 system。
 * 于是模型看到的就是「只有运行环境与工具说明」。
 *
 * 现在三条规则：
 *  1. 预算按「真正会发给模型的内容」计算，图片字节不算（老图片本来就不该重发）；
 *  2. 最新的那条用户消息**必进**窗口，超预算也要进；
 *  3. 被挡在窗口外的历史不再静默消失，而是压成一份本地摘要注入 system
 *     （见 `renderWorkDigest`），模型据此记得「之前做过什么」。
 */

export interface ContextWindowBudget {
  /** 最多保留多少条（0 = 不限）。 */
  maxMessages: number;
  /** 窗口内「会发给模型的内容」的字节上限。 */
  maxBytes: number;
}

export interface ContextWindowResult {
  /** 进窗口的消息，按时间升序（旧 → 新）。 */
  messages: ChatMessage[];
  /** 被挡在窗口外的消息，按时间升序（旧 → 新），供生成摘要。 */
  dropped: ChatMessage[];
  /** 窗口内实际占用的字节。 */
  bytes: number;
}

/** 这段正文里是否还有值得发给模型的图片字节（用于统计与提示）。 */
export function hasInlineImage(context: MessageContext | undefined): boolean {
  return Boolean(context?.kind === 'image' && context.dataBase64);
}

/**
 * 把一条存档消息压成「可以发给模型」的形状。
 *
 * 去掉的都是**模型用不到、但很占字节**的东西：图片 base64、缩略图、思考过程。
 * 图片仍然能在面板里看到（文件在磁盘上、缩略图在消息里），只是不再随每一轮
 * 请求重发 —— 旧实现每轮都把历史里所有图片的 base64 重新发一遍。
 */
export function requestPayloadOf(message: ChatMessage, options: { keepImages?: boolean } = {}): ChatMessage {
  const keepImages = options.keepImages === true;
  const lighten = (context: MessageContext): MessageContext => {
    if (keepImages && context.kind === 'image' && context.dataBase64) return { ...context, thumbnailDataUrl: undefined };
    return { ...context, dataBase64: undefined, thumbnailDataUrl: undefined };
  };
  const attachments = message.attachments?.map(lighten);
  return {
    ...message,
    reasoning: undefined,
    context: message.context ? lighten(message.context) : undefined,
    attachments,
  };
}

/**
 * 这条消息进窗口要花多少字节。
 *
 * 只算模型真的会看到的部分：角色、正文、附件文本、选区文本。
 * 不算 `toolExecutions`（请求里根本不发）、不算图片字节、不算思考过程 ——
 * 用原始 JSON 大小当预算正是这次「忘记项目」的成因。
 */
export function requestBytesOf(message: ChatMessage): number {
  const payload = requestPayloadOf(message);
  const parts = [
    payload.role,
    payload.content ?? '',
    payload.context?.content ?? '',
    ...(payload.attachments ?? []).map((attachment) => attachment.content ?? ''),
  ];
  return Buffer.byteLength(parts.join('\u0000'));
}

/**
 * 按预算切出窗口。
 *
 * 与旧实现的关键差别：最新的用户消息以及它之后的一切**无条件保留**。
 * 否则「助手占位 + 一条巨大的用户消息」这种顺序会让用户的问题本身被挤掉，
 * 而占位消息随后又被当成空内容跳过 —— 模型收到一整轮 system 什么也没有。
 *
 * 输入必须是时间升序（旧 → 新）；内部反向遍历，从最新的开始吃预算。
 */
export function buildContextWindow(
  messages: readonly ChatMessage[],
  budget: ContextWindowBudget,
): ContextWindowResult {
  const builder = new ContextWindowBuilder(budget);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    builder.offer(messages[index]!);
  }
  return builder.result();
}

/**
 * 增量版窗口：调用方从**最新**往**最旧**逐条喂，不必先把整段历史读进内存。
 *
 * 为什么要增量：154 条消息、21 MB 的真实存档，一次 `send()` 全量 `JSON.parse`
 * 要几百毫秒；而窗口通常只有最近几条。这里让存储边读边判断，被挡在外面的
 * 消息立刻压成摘要用的轻副本，原始对象随即可以被回收。
 */
export class ContextWindowBuilder {
  private readonly kept: ChatMessage[] = [];
  private readonly dropped: ChatMessage[] = [];
  private bytes = 0;
  private sawUser = false;

  constructor(private readonly budget: ContextWindowBudget) {}

  /** 喂一条消息（必须从最新往最旧）。返回它是否进了窗口。 */
  offer(message: ChatMessage): boolean {
    const weight = requestBytesOf(message);
    const overCount = this.budget.maxMessages > 0 && this.kept.length >= this.budget.maxMessages;
    const overBytes = this.kept.length > 0 && this.bytes + weight > this.budget.maxBytes;
    /*
     * 还没遇到任何用户消息时一律保留：最新那条用户消息（也就是用户刚发、
     * 甚至还没落成完整回复的那一轮）绝不允许被预算挤掉。
     */
    const required = !this.sawUser;
    if (required || (!overCount && !overBytes)) {
      this.kept.push(message);
      this.bytes += weight;
      if (message.role === 'user') this.sawUser = true;
      return true;
    }
    this.dropped.push(message);
    return false;
  }

  result(): ContextWindowResult {
    return {
      messages: [...this.kept].reverse(),
      dropped: [...this.dropped].reverse(),
      bytes: this.bytes,
    };
  }
}

/**
 * 摘要用的轻副本：只留「谁说了什么、动了哪些工具」。
 *
 * 被挡在窗口外的消息**不会**再发给模型，但摘要要逐条过一遍；留着完整对象
 * 等于把 21 MB 历史在内存里再放一遍，所以一进来就把大字段清掉。
 */
export function lightForDigest(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: clipText(message.content ?? '', 600),
    reasoning: undefined,
    context: undefined,
    attachments: undefined,
    toolExecutions: (message.toolExecutions ?? []).slice(0, 6).map((tool) => ({ ...tool, input: undefined, output: undefined })),
  };
}

/** 摘要里一行最多多少字（防止某条超长回复把摘要撑爆）。 */
const DIGEST_LINE_LIMIT = 120;

export function oneLine(text: string, limit = DIGEST_LINE_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  // 截断不能切开 emoji：半个代理项会让整份请求 JSON 解析失败（详见 textSafety.ts）。
  return `${clipText(flat, limit - 1)}…`;
}

/**
 * 从一条助手回复里挑出「做完了什么」。
 *
 * 回复形状是固定的（`### 我的理解` → 结果 → `需要你做的`，见 replyShapePrompt），
 * 所以跳过「我的理解」那一段，取下一段正文当结果；没有小标题时退回第一段。
 */
export function outcomeOf(content: string | undefined): string {
  const text = (content ?? '').trim();
  if (!text) return '';
  /*
   * 回复的形状是固定的（`### 我的理解` → 结果 → `### 需要你做的`，见 replyShapePrompt）。
   * 旧实现只看「最后一个非标题段落」，于是经常把「需要你做的」当成结论写进记忆 ——
   * 那句「重载窗口后试一下」会变成下一轮的项目记忆，纯噪音。
   * 现在按小标题切段，按优先级取：结果 → 我的理解之后的那段 → 最后一个普通段落。
   */
  const sections: Array<{ title: string; body: string }> = [];
  let current = { title: '', body: '' };
  for (const line of text.split(/\n/)) {
    const heading = /^#{1,6}\s*(.+?)\s*$/.exec(line.trim());
    if (heading) {
      if (current.title || current.body.trim()) sections.push({ title: current.title, body: current.body.trim() });
      current = { title: heading[1]!.trim(), body: '' };
      continue;
    }
    current.body += `${line}\n`;
  }
  if (current.title || current.body.trim()) sections.push({ title: current.title, body: current.body.trim() });

  const paragraphsOf = (body: string): string[] => body.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const byTitle = (pattern: RegExp): string[] => {
    const section = sections.find((item) => pattern.test(item.title));
    return section ? paragraphsOf(section.body) : [];
  };
  const skipTitle = /^(需要你做的|需要你|follow[- ]?up|next steps?|what you need)/i;
  const isUnderstanding = (title: string): boolean => /^(我的理解|我理解|理解需求|需求理解|what i understood|understanding|my understanding)$/i.test(title);
  const understanding = sections.find((item) => isUnderstanding(item.title));
  const afterUnderstanding = understanding
    ? sections.slice(sections.indexOf(understanding) + 1).filter((item) => !skipTitle.test(item.title) && !isUnderstanding(item.title))
    : [];
  const plainSections = sections.filter((item) => !skipTitle.test(item.title));

  const candidates = [
    // 1) 明确的「结果」段
    ...byTitle(/^(结果|结论|result|done|已完成|完成的)/i),
    // 2) 「我的理解」之后的第一个普通段落
    ...afterUnderstanding.flatMap((item) => paragraphsOf(item.body)).slice(0, 1),
    // 3) 「我的理解」段里的**最后**一段：模型常把复述和正文写在同一小节下
    ...(understanding ? paragraphsOf(understanding.body).slice(-1) : []),
    // 4) 最后一个不是「需要你做的」的段落
    ...(plainSections.at(-1) ? paragraphsOf(plainSections.at(-1)!.body).slice(-1) : []),
    // 5) 兜底：整段最后一段
    ...paragraphsOf(text).slice(-1),
  ];
  for (const candidate of candidates) {
    const cleaned = oneLine(candidate.replace(/^#{1,6}\s*/gm, '').replace(/^[-*]\s+/gm, ''));
    if (cleaned) return cleaned;
  }
  return '';
}

/** 这条回复动过哪些工具（最多 `limit` 个，去重保序）。 */
export function toolsOf(message: ChatMessage, limit = 4): string[] {
  const names: string[] = [];
  for (const tool of message.toolExecutions ?? []) {
    const name = (tool.name ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

/**
 * 把窗口外的历史压成一份「之前做过什么」的本地摘要。
 *
 * 为什么放在本地生成：这一步发生在**每一轮**发送前，如果调模型来总结，
 * 既多一次请求又多一份延迟；而任务树、清单、每条回复的开头本来就在存档里，
 * 本地就能拼出一份够用的索引。摘要只写「结论」，细节仍然让模型用工具去查。
 */
export function renderWorkDigest(
  dropped: readonly ChatMessage[],
  options: { todos?: readonly TodoItem[]; limit?: number } = {},
): string {
  if (!dropped.length) return '';
  const limit = Math.max(1, options.limit ?? 30);
  const lines: string[] = [];
  let pending: ChatMessage | undefined;
  for (const message of dropped) {
    if (message.role === 'user') {
      if (pending) lines.push(`- 用户：${oneLine(pending.content ?? '', 80)} → （没有回复，未完成）`);
      pending = message;
      continue;
    }
    if (message.role !== 'assistant') continue;
    if (!pending) {
      const outcome = outcomeOf(message.content);
      if (outcome) lines.push(`- 助手：${outcome}`);
      continue;
    }
    const request = oneLine(pending.content ?? '', 80);
    const outcome = outcomeOf(message.content) || '（无结论）';
    const tools = toolsOf(message);
    lines.push(`- 用户：${request} → ${outcome}${tools.length ? ` ｜ 工具：${tools.join('、')}` : ''}`);
    pending = undefined;
  }
  if (pending) lines.push(`- 用户：${oneLine(pending.content ?? '', 80)} → （没有回复，未完成）`);

  const shown = lines.slice(-limit);
  const hidden = lines.length - shown.length;
  const taskLines = (options.todos ?? [])
    .filter((todo) => todo?.content?.trim())
    .map((todo) => `- ${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[>]' : '[ ]'} ${oneLine(todo.content, 60)}`);

  return [
    '<earlier_work_summary>',
    `The conversation is long, so the earliest ${dropped.length} message(s) are no longer sent verbatim. This local summary is an index of what was already done — it is not a new instruction and it is not complete.`,
    'Treat the results below as work that is already finished: do not redo it, and verify anything that matters with tools before relying on details.',
    hidden > 0 ? `(${hidden} older entry/entries not listed.)` : '',
    ...shown,
    taskLines.length ? `<task_list_archive>\n${taskLines.join('\n')}\n</task_list_archive>` : '',
    '</earlier_work_summary>',
  ].filter(Boolean).join('\n');
}
