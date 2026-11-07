/**
 * 文本安全：不许把 emoji 切成半个。
 *
 * 真实故障（用户 2026-11-07，连报两次）：
 *
 *     请求失败：接口请求失败（400）：Failed to parse the request body as JSON:
 *     messages[0].content: lone leading surrogate in hex escape at line 1 column 39266
 *
 * `messages[0]` 是 system 消息，里面是任务记忆、历史摘要与自动检索片段 —— 每一块都
 * 由 `slice(0, N)` 截断而成。JS 的字符串按 UTF-16 码元计数，一个 emoji 占两个码元；
 * 只要截断点落在中间，就会留下一个**孤立的代理项**，`JSON.stringify` 会把它写成
 * `\ud83d` 这样的转义，服务端解析 JSON 直接 400。
 *
 * 已核对：用户真实存档里**没有**孤立代理项（246 个消息文件全扫过），所以不是存进去的
 * 坏数据，而是**拼请求时**切出来的 —— 因此既要修截断，也要在出站口兜一道。
 *
 * 本模块全是纯函数：不 import vscode、不读写磁盘，便于单测与守护脚本直接跑。
 */

/** 高位代理项（emoji 的前半个码元）。 */
export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 低位代理项（emoji 的后半个码元）。 */
export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 按码元切片，但**绝不切开代理对**。
 *
 * 参数语义与 `String.prototype.slice` 一致（支持负数），只是会在边界上退让一码元。
 * 直接用 `slice` 做截断是本类 400 的根源，凡是要截给模型看的文本都该走这里。
 */
export function safeSlice(value: string, start: number, end?: number): string {
  if (typeof value !== 'string' || !value) return '';
  const length = value.length;
  let from = start < 0 ? Math.max(0, length + start) : Math.min(start, length);
  let to = end === undefined ? length : end < 0 ? Math.max(0, length + end) : Math.min(end, length);
  if (from > 0 && from < length && isHighSurrogate(value.charCodeAt(from - 1)) && isLowSurrogate(value.charCodeAt(from))) {
    from += 1;
  }
  if (to > 0 && to < length && isHighSurrogate(value.charCodeAt(to - 1)) && isLowSurrogate(value.charCodeAt(to))) {
    to -= 1;
  }
  return to > from ? value.slice(from, to) : '';
}

/** 截到最多 `limit` 个字符（不切开代理对）。负数/0 视为不截。 */
export function clipText(value: string, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0) return value ?? '';
  const text = value ?? '';
  return text.length <= limit ? text : safeSlice(text, 0, limit);
}

/**
 * 去掉所有**孤立**的代理项（保留成对的 emoji）。
 *
 * 这是最后一道闸：即使上游某处仍然切坏了，也不能把坏字符发出去。服务端收到的
 * 401/400 里只会说「JSON 解析失败」，用户完全无从判断，代价远高于丢掉半个字符。
 */
export function stripLoneSurrogates(value: string): string {
  if (typeof value !== 'string' || !value) return '';
  let out = '';
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (isHighSurrogate(code)) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (isLowSurrogate(next)) {
        out += value.slice(index, index + 2);
        index += 2;
        continue;
      }
      index += 1; // 孤立的高位：丢掉
      continue;
    }
    if (isLowSurrogate(code)) {
      index += 1; // 孤立的低位：丢掉
      continue;
    }
    out += value[index]!;
    index += 1;
  }
  return out;
}

/**
 * 深度清理：把任意 JSON 结构里所有字符串（含对象的 key）去掉孤立代理项。
 *
 * 请求体是嵌套的（messages → content 可以是字符串或分段数组 → 工具参数 JSON 字符串），
 * 逐个字段修不现实；在出站口统一走一遍，才能保证「这个错误再也不会出现」。
 * 只在真的发现坏字符时返回新对象，正常路径零拷贝开销。
 */
export function sanitizeJsonStrings<T>(value: T): T {
  const seen = new Set<object>();
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') {
      const cleaned = stripLoneSurrogates(input);
      return cleaned === input ? input : cleaned;
    }
    if (Array.isArray(input)) {
      if (seen.has(input)) return input;
      seen.add(input);
      let changed = false;
      const next = input.map((item) => {
        const walked = walk(item);
        if (walked !== item) changed = true;
        return walked;
      });
      return changed ? next : input;
    }
    if (input && typeof input === 'object') {
      if (seen.has(input)) return input;
      seen.add(input);
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        const safeKey = stripLoneSurrogates(key);
        const walked = walk(item);
        if (safeKey !== key || walked !== item) changed = true;
        next[safeKey] = walked;
      }
      return changed ? next : input;
    }
    return input;
  };
  return walk(value) as T;
}

/** 这段文本里有没有孤立代理项（诊断与测试用）。 */
export function hasLoneSurrogate(value: string): boolean {
  if (typeof value !== 'string' || !value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isHighSurrogate(code)) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (!isLowSurrogate(next)) return true;
      index += 1;
      continue;
    }
    if (isLowSurrogate(code)) return true;
  }
  return false;
}
