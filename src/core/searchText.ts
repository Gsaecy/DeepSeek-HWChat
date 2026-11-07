/**
 * 检索用文本匹配：归一化 + 取词 + 模糊命中。
 *
 * 为什么需要它（用户 2026-11-07 的要求）：
 *  1. 「检索仍要靠模型主动调用，这个可以让 agent 自动执行」——每轮由宿主机自己
 *     从完整记录里捞相关片段，不再等模型想起来调工具；
 *  2. 「关键词做成模糊匹配」——用户问「胶囊」，记录里写的是「悬浮条 / 录制条」时
 *     也要能命中，不能只靠子串；
 *  3. 「有多个类似功能类似描述的情况，需要让用户确定称呼」——同一个说法对上
 *     多条任务时，要明确提示模型先问，不许猜。
 *
 * 全部是纯函数：不 import vscode、不读写磁盘，便于单测与守护脚本直接跑。
 */

/** 归一化：全角转半角、大小写、空白与标点。中英文混排时不丢信息。 */
import { safeSlice } from './textSafety.js';

export function normalizeSearchText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
    .replace(/[，。！？；：、（）【】《》“”‘’·—…,.!?;:()[\]{}"'`~!@#$%^&*+=|\\/<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 太泛的词不参与匹配：命中它们等于没命中。 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'were', 'are', 'but', 'not',
  '一个', '一下', '这个', '那个', '什么', '怎么', '可以', '需要', '现在', '然后', '还是', '就是', '因为',
  '所以', '如果', '已经', '没有', '不是', '我们', '你们', '他们', '这里', '那里', '功能', '问题', '时候',
]);

/**
 * 从一句话里取检索词。
 *
 * 取法：ASCII 词（含 `_`/`-`/`.` 的标识符、文件名）、中文连续串的 2 字片段、
 * 引号里的内容。中文按二元片段取是为了「模糊」：用户写「录制胶囊」，记录里写
 * 「胶囊录制状态」，两者共享「胶囊」这个片段。
 */
export function recallTokens(text: string, limit = 10): string[] {
  const normalized = normalizeSearchText(text);
  if (!normalized) return [];
  const tokens: string[] = [];
  const push = (token: string): void => {
    const value = token.trim();
    if (value.length < 2 || STOP_WORDS.has(value)) return;
    if (value.length === 1) return;
    if (!tokens.includes(value)) tokens.push(value);
  };
  for (const raw of normalized.split(' ')) {
    if (!raw) continue;
    // 纯 ASCII：整个词是一个检索词（标识符、路径、错误码）。
    if (/^[a-z0-9_.\-/]+$/.test(raw)) {
      if (raw.length >= 3) push(raw);
      // 标识符再拆一份：「recorder_engine」也要能被「recorder」找到。
      for (const part of raw.split(/[_\-/]+/)) {
        if (part.length >= 3) push(part);
      }
      continue;
    }
    // 中文（可能夹着英文/数字）：按连续汉字取二元片段。
    for (const run of raw.match(/[\u4e00-\u9fff]+/g) ?? []) {
      if (run.length <= 3) {
        push(run);
        continue;
      }
      for (let index = 0; index + 2 <= run.length; index += 1) {
        push(run.slice(index, index + 2));
      }
    }
    for (const word of raw.match(/[a-z0-9_.\-/]{3,}/g) ?? []) push(word);
  }
  // 长词更具体：优先保留长词，再补短的。
  return tokens.sort((left, right) => right.length - left.length).slice(0, Math.max(1, limit));
}

/** 这条 token 在归一化文本里命中没有（中文单字词按子串，二元片段按包含）。 */
function hasToken(haystack: string, token: string): boolean {
  return haystack.includes(token);
}

export interface MatchResult {
  /** 命中的检索词（去重、保持入参顺序）。 */
  hits: string[];
  /** 0–1：命中的词占多少（长词加权）。 */
  score: number;
}

/**
 * 模糊命中：不再要求整句子串相等。
 *
 * 打分口径：命中的 token 越长越算数（「录制胶囊」比「胶囊」更有信息量），
 * 命中一半以上才算相关（否则「改一下」这种词会把无关记录都捞出来）。
 */
export function matchTokens(haystack: string, tokens: readonly string[]): MatchResult {
  const normalized = normalizeSearchText(haystack);
  if (!normalized || !tokens.length) return { hits: [], score: 0 };
  const hits: string[] = [];
  let weight = 0;
  let total = 0;
  for (const token of tokens) {
    const tokenWeight = Math.min(4, token.length);
    total += tokenWeight;
    if (hasToken(normalized, token)) {
      hits.push(token);
      weight += tokenWeight;
    }
  }
  return { hits, score: total ? weight / total : 0 };
}

/** 命中位置附近的片段：给模型看「原文大概长什么样」。 */
export function excerptAround(text: string, tokens: readonly string[], size = 240): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const normalized = normalizeSearchText(flat);
  let at = -1;
  for (const token of tokens) {
    const index = normalized.indexOf(token);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) return safeSlice(flat, 0, size);
  // 归一化会改变长度（全角/标点），按比例折算回原文位置，够用即可。
  const ratio = flat.length / Math.max(1, normalized.length);
  const center = Math.min(flat.length, Math.round(at * ratio));
  const start = Math.max(0, center - Math.floor(size / 3));
  return `${start > 0 ? '…' : ''}${safeSlice(flat, start, start + size)}${start + size < flat.length ? '…' : ''}`;
}

export interface AmbiguousTerm {
  term: string;
  titles: string[];
}

/**
 * 找出「一个说法对上多条任务」的情况。
 *
 * 用户的要求：「有多个类似功能类似描述的情况，需要让用户确定称呼，agent 可以
 * 主动问来确定」。这里只负责**发现**并在记忆里点出来；要不要问由模型按提示执行。
 * 判据：同一个检索词命中 ≥2 个不同的任务标题。
 */
export function ambiguousTerms(
  tokens: readonly string[],
  titles: readonly string[],
): AmbiguousTerm[] {
  const result: AmbiguousTerm[] = [];
  for (const token of tokens) {
    const matched = [...new Set(titles.filter((title) => normalizeSearchText(title).includes(token)))];
    if (matched.length >= 2) result.push({ term: token, titles: matched.slice(0, 4) });
  }
  return result;
}

export interface TermResolution {
  term: string;
  /** ask：候选一样相关，问用户；assume：有明显最相关的一条，说明假设后继续。 */
  mode: 'ask' | 'assume';
  /** 按相关度排好的候选。 */
  candidates: string[];
  scores: number[];
  chosen?: string;
}

/**
 * 多义术语该怎么处理：问，还是直接按最相关的那条做。
 *
 * 用户 2026-11-07 的要求是「有多个类似功能类似描述的情况，需要让用户确定称呼，
 * agent 可以主动问来确定」；但如果每句话都被打断一次，体验会更糟 —— 比如句子里
 * 还带着「拖动区域」「pick_mac」这类限定词时，其实只有一个候选真的相关。
 *
 * 判据用的是「**限定词**覆盖」而不是整句相似度：把多义术语本身从检索词里剔掉，
 * 剩下的词就是这一轮的限定信息。哪个候选标题覆盖得多，就更可能是它。
 *  - 覆盖领先（≥0.5 且比第二名高 0.25）→ assume：按它继续，但要在回复里说明；
 *  - 谁都不覆盖 / 差不多 → ask：先问清楚再动手（这正是用户描述的「需要确定称呼」）；
 *  - 只有一条候选 → 不算冲突。
 */
export function resolveAmbiguousTerms(
  tokens: readonly string[],
  titles: readonly string[],
): TermResolution[] {
  const result: TermResolution[] = [];
  for (const item of ambiguousTerms(tokens, titles)) {
    const extra = tokens.filter((token) => token !== item.term && !token.includes(item.term) && !item.term.includes(token));
    if (!extra.length) {
      // 这句话只说了那个多义词，没有任何限定信息：问，别猜。
      result.push({ term: item.term, mode: 'ask', candidates: item.titles, scores: item.titles.map(() => 0) });
      continue;
    }
    /*
     * 按**命中的限定词个数**比较，而不是「占全部词的比例」：一句话里大半是
     * 语气词（那个 / 还要 / 再改），它们不可能出现在任务标题里，用比例会把
     * 「4 比 0」这种决定性差距稀释成「0.36 比 0」，于是该自动选的时候去打扰用户。
     */
    const scored = item.titles
      .map((title) => {
        const normalized = normalizeSearchText(title);
        const covered = extra.filter((token) => normalized.includes(token)).length;
        return { title, score: covered };
      })
      .sort((left, right) => right.score - left.score);
    const top = scored[0];
    const second = scored[1];
    if (!top) continue;
    // 有命中，且明显压过第二名（第二名为 0，或至少是它的两倍）→ 直接按它做。
    const clearWinner = top.score > 0 && (!second || second.score === 0 || top.score >= second.score * 2);
    result.push({
      term: item.term,
      mode: clearWinner ? 'assume' : 'ask',
      candidates: scored.map((entry) => entry.title),
      scores: scored.map((entry) => entry.score),
      chosen: clearWinner ? top.title : undefined,
    });
  }
  return result;
}
