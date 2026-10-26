import { basename, isAbsolute, resolve } from 'node:path';
import { isPathWithin } from './workspacePaths';
import { tt } from '../core/i18n';

/**
 * 命令路径隔离（纯函数，不依赖 vscode，便于单测）。
 *
 * 旧实现是一条正则把所有 `/Users`、`/home`、`/etc` 开头的绝对路径一律拦掉，
 * 连工作区自己的绝对路径也一起拦了——多根工作区里
 * `cd "/Users/me/AI projects/x" && npm test` 这种写法很常见，而且路径常带空格，
 * 结果被判成“访问工作区外”直接拒绝。
 *
 * 现在分两步：先拦 HOME 展开、`..` 这类无法静态判定的写法；再把命令里出现的
 * 绝对路径逐个解析，只要求它们落在某个工作区根目录之内。
 */

/**
 * 无法静态判定的写法，一律拒绝。
 * 注意 `~user/x` 也会被 shell 展开成该用户的家目录，不能只拦 `~/`。
 */
const ESCAPING_PATH = /(^|[\s'"=(,;])(?:~[A-Za-z0-9._-]*(?:\/|\s|$)|\$(?:\{)?HOME\}?\b)/i;
/**
 * 上级目录引用。`..` 本身不能一律拒绝：cwd 已知时它完全可以落在工作区内
 * （例如在 `DeepSeek-HWChat/src` 里执行 `cat ../package.json`）。旧实现把所有
 * `..` 都当成越界，会逼调用方改用更绕的写法。
 */
const PARENT_REFERENCE = /(^|[\s'"=(,;:])(\.\.(?!\.)(?:[/\\][^\s'"`;&|<>(){}]*)?)/g;
const ANY_PARENT_REFERENCE = /(^|[\s'"=(,;:])(\.\.(?!\.)(?=[\s/\\]|$))/;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const QUOTED_STRING = /'([^']*)'|"([^"]*)"/g;
const BARE_ABSOLUTE_PATH = /(^|[\s'"=(,;:])(\/[^\s'"`;&|<>(){}]+|[A-Za-z]:[\\/][^\s'"`;&|<>(){}]*)/g;
/** 只读设备与管道目标，不属于“访问工作区外文件”。 */
const HARMLESS_DEVICE_PATH = /^\/(?:dev\/(?:null|stdout|stderr|tty|fd\/\d+)|proc\/self\/fd\/\d+)$/;
/**
 * 单独出现的文件系统根 `/`（前后都是空白或分隔符）。
 * BARE_ABSOLUTE_PATH 要求 `/` 后至少有一个字符，因此 `rm -rf /`、`chown -R x /`
 * 这类直接指向根的写法会漏检——根目录永远不可能落在工作区根之内，必须单独拦截。
 */
const BARE_ROOT_PATH = /(^|[\s'"=(,;:])\/(?=$|[\s'"`;&|<>(){}])/;

export function commandPathViolation(
  rawCommand: string,
  roots: readonly string[],
  cwd?: string,
): string | undefined {
  // 先把 sed / grep 的“模式/脚本”参数遮掉：`sed -n '/a/,/^b/p' file.txt` 里的
  // `/"name"/,/displayName/p` 会被 BARE_ABSOLUTE_PATH 当成绝对路径拒绝，而它根本
  // 不是文件访问。旧实现只能给出“请改写成 -e”的提示，让调用方替工具背锅。
  // 遮掉的是模式位置上的参数，真正的文件参数仍在后面照常校验。
  const command = maskPatternArguments(rawCommand);
  if (ESCAPING_PATH.test(command)) {
    return tt('path.blockedGeneric');
  }
  if (ANY_PARENT_REFERENCE.test(command)) {
    // 不知道工作目录时无法静态判定 `..` 会解析到哪里，只能保守拒绝。
    if (!cwd) {
      return tt('path.blockedGeneric');
    }
    const base = resolve(cwd);
    for (const match of command.matchAll(PARENT_REFERENCE)) {
      const token = match[2]!.replace(/[.,;:)\]]+$/, '');
      if (!token) continue;
      if (!roots.some((root) => isPathWithin(root, resolve(base, token)))) {
        return tt('path.blockedResolved', { token });
      }
    }
  }
  if (!roots.length) return undefined;

  // URL 里的 `//host/path` 不是文件路径，先剔除再扫描。
  const withoutUrls = command.replace(URL_LIKE, ' ');
  const candidates: string[] = [];
  // 带引号的路径可以含空格（例如 "…/AI projects/x"），要整体取出再判断。
  for (const match of withoutUrls.matchAll(QUOTED_STRING)) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) candidates.push(value);
  }
  const unquoted = withoutUrls.replace(QUOTED_STRING, ' ');
  for (const match of unquoted.matchAll(BARE_ABSOLUTE_PATH)) {
    candidates.push(match[2]!);
  }
  // 裸根 `/`：上面的 BARE_ABSOLUTE_PATH 要求 `/` 后至少一个字符，会漏掉
  // `rm -rf /` 这类写法，这里补一条独立检出。
  if (BARE_ROOT_PATH.test(unquoted)) candidates.push('/');

  for (const raw of candidates) {
    const candidate = raw.replace(/[.,;:)\]]+$/, '');
    if (!candidate) continue;
    if (HARMLESS_DEVICE_PATH.test(candidate.replaceAll('\\', '/'))) continue;
    const resolved = resolve(candidate);
    if (!roots.some((root) => isPathWithin(root, resolved))) {
      // 形如 `/foo/,/^bar/p` 的 sed 地址段会被误当成绝对路径。这里不放松边界，
      // 但把原因说清楚，避免调用方以为是真的越界而反复试错。
      return looksLikeRegex(candidate)
        ? tt('path.blockedSedHint', { path: candidate })
        : tt('path.blockedSimple', { path: candidate });
    }
  }
  return undefined;
}

/** 判断一个“绝对路径”候选其实是不是正则表达式片段。 */
function looksLikeRegex(candidate: string): boolean {
  return /[\^$]/.test(candidate) || /\/[^/]*,[^/]*\//.test(candidate);
}

/**
 * 把 sed / grep 等程序里「模式或脚本」位置上的参数替换成占位词，
 * 使它们不再被当作文件路径校验。
 *
 * 只处理能静态确认的位置：`-e` / `--expression` / `--regexp` 之后的那个参数，
 * 以及**第一个非选项参数**（sed 的脚本、grep 的模式）。`-f` / `--file` 指向的
 * 是脚本文件，属于真实路径，保持原样校验。
 */
const PATTERN_PROGRAMS = new Set(['sed', 'gsed', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const PATTERN_FLAGS = /^-[A-Za-z]*e$/;
const FILE_FLAG = new Set(['-f', '--file']);
const INLINE_PATTERN_FLAG = /^--(?:expression|regexp)=/;
const SEGMENT_SPLIT = /(&&|\|\||[;|\n])/;

function maskPatternArguments(command: string): string {
  return command
    .split(SEGMENT_SPLIT)
    .map((part, index) => (index % 2 === 0 ? maskSegment(part) : part))
    .join('');
}

function maskSegment(segment: string): string {
  const tokens = tokenizeSegment(segment);
  const headIndex = tokens.findIndex((token) => !isAssignment(token.text) && !isGrouping(token.text));
  if (headIndex < 0) return segment;
  const head = basename(tokens[headIndex]!.text).toLocaleLowerCase();
  if (!PATTERN_PROGRAMS.has(head)) return segment;

  const masked: Array<{ start: number; end: number }> = [];
  let expectPattern = false;
  let skipNext = false;
  let patternTaken = false;

  for (const token of tokens.slice(headIndex + 1)) {
    if (skipNext) {
      skipNext = false;
      patternTaken = true;
      continue;
    }
    if (expectPattern) {
      masked.push({ start: token.start, end: token.end });
      expectPattern = false;
      patternTaken = true;
      continue;
    }
    const text = token.text;
    if (!text) continue;
    if (text.startsWith('-') && text.length > 1) {
      if (FILE_FLAG.has(text)) {
        // 脚本来自文件：后面的参数是数据文件，不能当成模式遮掉。
        skipNext = true;
        continue;
      }
      if (INLINE_PATTERN_FLAG.test(text)) {
        masked.push({ start: token.start, end: token.end });
        patternTaken = true;
        continue;
      }
      if (PATTERN_FLAGS.test(text)) expectPattern = true;
      continue;
    }
    if (!patternTaken) {
      masked.push({ start: token.start, end: token.end });
      patternTaken = true;
    }
  }

  if (!masked.length) return segment;
  let result = segment;
  for (const range of masked.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, range.start)}pattern${result.slice(range.end)}`;
  }
  return result;
}

interface SegmentToken {
  text: string;
  start: number;
  end: number;
}

/** 极简分词：只处理引号与转义，足以定位参数位置。 */
function tokenizeSegment(segment: string): SegmentToken[] {
  const tokens: SegmentToken[] = [];
  let index = 0;
  while (index < segment.length) {
    if (/\s/.test(segment[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    let text = '';
    while (index < segment.length && !/\s/.test(segment[index]!)) {
      const current = segment[index]!;
      if (current === "'" || current === '"') {
        const quote = current;
        index += 1;
        while (index < segment.length && segment[index] !== quote) {
          if (quote === '"' && segment[index] === '\\' && index + 1 < segment.length) index += 1;
          text += segment[index];
          index += 1;
        }
        index += 1;
        continue;
      }
      text += current;
      index += 1;
    }
    tokens.push({ text, start, end: index });
  }
  return tokens;
}

function isAssignment(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);
}

function isGrouping(text: string): boolean {
  return /^[({]+$/.test(text);
}

