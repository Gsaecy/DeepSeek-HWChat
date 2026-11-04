/**
 * `replace_in_file` 没找到 `oldText` 时，把「为什么没找到」查清楚。
 *
 * 现场（用户 2026-11-04，两次贴回失败原文）：
 *
 *     replace_in_file {"path":"…/web/index.html", "oldText":"…<link rel=\"icon\"…>…<link rel=\"stylesheet\"…>", …}
 *     → oldText 在文件中不存在，未执行修改。
 *
 * 两种情况让模型白跑一轮：
 *  1. **这段修改其实已经改过了** —— 文件里已经是 `newText`。旧实现照样报「不存在」，
 *     模型于是换个写法再试一次，甚至写成重复插入。
 *  2. **只差空白** —— 模型凭记忆重建 `oldText`，缩进/空行与文件不一致。
 *
 * 这两种都能静态查出来，直接说清比让模型猜便宜得多。
 */

/** 「这段修改已经在文件里」的判定结果。 */
export interface AlreadyApplied {
  /** 1 起算的行号（`newText` 在文件里第一次出现的位置）。 */
  line: number;
}

function toLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** 只去首尾空白，不动行内空白：行内空白差异会改变代码含义，不该被忽略。 */
function trimmedLines(text: string): string[] {
  return toLines(text).map((line) => line.trim());
}

/** 去掉尾部空行，`oldText`/`newText` 常带一个多余的换行。 */
function withoutTrailingBlank(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1] === '') copy.pop();
  return copy;
}

function findWindow(haystack: readonly string[], needle: readonly string[]): number[] {
  if (needle.length === 0 || needle.length > haystack.length) return [];
  const hits: number[] = [];
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) hits.push(start);
  }
  return hits;
}

/**
 * `newText` 是不是已经在文件里了（按行去首尾空白比较，忽略 EOL 与缩进）。
 *
 * 空 `newText` 一律不算：删除型修改没有「已经改过」这种状态。
 */
export function findAlreadyApplied(current: string, newText: string): AlreadyApplied | undefined {
  const needle = withoutTrailingBlank(trimmedLines(newText));
  if (needle.length === 0 || needle.every((line) => line === '')) return undefined;
  const hits = findWindow(trimmedLines(current), needle);
  if (hits.length === 0) return undefined;
  return { line: hits[0]! + 1 };
}

export interface MissingOldTextDiagnosis {
  kind: 'whitespace' | 'first-line';
  /** 1 起算的行号：命中窗口在文件中的起始行。 */
  line: number;
  /** 文件在该位置的**真实**内容（已去掉共同缩进之外的空白），供模型原样复制。 */
  actual: string[];
  /** 文件里还剩几处同位置候选（不展开）。 */
  otherMatches?: number;
}

/** 最多回多少行「实际内容」：够看清差异，又不至于把大文件塞进上下文。 */
const MAX_SNIPPET_LINES = 14;
/** 「首行在、后续变了」时在 needle 长度之外多带的上下文行数。 */
const FIRST_LINE_CONTEXT_LINES = 6;

/**
 * 没找到 `oldText` 时，判断它是「只差空白」还是「首行在、后续内容不对」。
 *
 * 只做**每一行去首尾空白**的比较，不做全量空白折叠：行内空白变化会改变语义，
 * 把它当成同一段内容会让模型以为位置找对了。
 */
export function diagnoseMissingOldText(current: string, oldText: string): MissingOldTextDiagnosis | undefined {
  const fileLines = toLines(current);
  const fileTrimmed = trimmedLines(current);
  const needle = withoutTrailingBlank(trimmedLines(oldText));
  if (needle.length === 0) return undefined;

  const trimmedHits = findWindow(fileTrimmed, needle);
  if (trimmedHits.length > 0) {
    return {
      kind: 'whitespace',
      line: trimmedHits[0]! + 1,
      actual: snippet(fileLines, trimmedHits[0]!, needle.length),
      otherMatches: Math.max(0, trimmedHits.length - 1),
    };
  }

  // 首行（第一个非空行）在文件里出现的位置：这是「看起来该在这里但内容已变」的典型。
  const firstLine = needle.find((line) => line !== '');
  if (!firstLine) return undefined;
  const firstHits = fileTrimmed
    .map((line, index) => (line === firstLine ? index : -1))
    .filter((index) => index >= 0);
  if (firstHits.length === 0) return undefined;
  const at = firstHits[0]!;
  // 多给几行上下文：差异往往就在 needle 的末尾之后，只给 needle 的等长窗口刚好切掉它。
  return {
    kind: 'first-line',
    line: at + 1,
    actual: snippet(fileLines, at, needle.length + FIRST_LINE_CONTEXT_LINES),
    otherMatches: Math.max(0, firstHits.length - 1),
  };
}

function snippet(lines: readonly string[], start: number, count: number): string[] {
  return lines.slice(start, start + Math.min(count, MAX_SNIPPET_LINES));
}

/** 渲染成可直接放进工具结果的文本；诊断不出来时返回 `undefined`。 */
export function renderMissingOldTextDiagnosis(
  diagnosis: MissingOldTextDiagnosis | undefined,
  t: (key: string, values?: Record<string, string | number>) => string,
): string | undefined {
  if (!diagnosis) return undefined;
  const lines: string[] = [
    diagnosis.kind === 'whitespace'
      ? t('tool.replace.diffWhitespace', { line: diagnosis.line })
      : t('tool.replace.diffFirstLine', { line: diagnosis.line, count: diagnosis.actual.length }),
  ];
  for (const line of diagnosis.actual) lines.push(`  ${line}`);
  if (diagnosis.otherMatches) lines.push(t('tool.replace.diffMore', { count: diagnosis.otherMatches }));
  lines.push(t('tool.replace.diffAdvice'));
  return lines.join('\n');
}
