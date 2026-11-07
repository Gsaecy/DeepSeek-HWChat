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
/**
 * Windows 命令行开关（`for /R`、`findstr /S`、`taskkill /F /IM`、`xcopy /E`…）。
 *
 * 真实缺陷（2026-11-03 实测）：Windows 上执行 `for /R %f in (*.cs) do @echo %f` 时，
 * `/R` 被 BARE_ABSOLUTE_PATH 当成绝对路径，`resolve('/R')` 落到当前盘符根（`D:\R`），
 * 整条命令被判成「访问工作区外路径」直接拒绝；模型换写法重试仍被拒，连续 3 轮后
 * 触发「无进展」停机，原话是 `命令被路径隔离策略拦截：路径 /R 不在当前工作区内`。
 *
 * 只放行这份显式名单，而不是把 `/` 开头一律放行：`/etc`、`/tmp`、`/opt` 这些真实
 * 根目录名不在名单里，仍然照常按越界路径拦截。
 */
const WINDOWS_COMMAND_SWITCHES = new Set([
  '/?', '/help', '/wait', '/nobreak',
  '/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i', '/j', '/k', '/l', '/m',
  '/n', '/o', '/p', '/q', '/r', '/s', '/t', '/u', '/v', '/w', '/x', '/y', '/z',
  '/im', '/pid', '/fi', '/fo', '/nh', '/njh', '/njs', '/nc', '/ns', '/np',
  '/nfl', '/ndl', '/log', '/tee', '/xo', '/xc', '/xn', '/xd', '/xf', '/xl',
]);

/** 命令开关形如 `/R`、`/R:3`、`/IM:notepad.exe`：取冒号前那段比对名单。 */
function isWindowsCommandSwitch(token: string, platform: string): boolean {
  if (platform !== 'win32') return false;
  const colon = token.indexOf(':');
  const head = (colon >= 0 ? token.slice(0, colon) : token).toLowerCase();
  return WINDOWS_COMMAND_SWITCHES.has(head);
}

/**
 * 按段推导命令执行时的「当前目录」。
 *
 * 现场（用户 2026-11-04）：
 *
 *     cd "/Users/…/Personal Workstation OS/src-tauri" && du -sh target/x && mkdir -p ../tmp/cargo-check && …
 *     → 命令被路径隔离策略拦截：路径 ../tmp/cargo-check 解析后不在当前工作区内
 *
 * 那条命令执行到 `mkdir` 时其实已经在 `src-tauri` 里，`../tmp` 就是工作区内的
 * `Personal Workstation OS/tmp` —— 完全合法。旧实现只拿 `run_command` 的 `cwd`
 * 参数（缺省＝项目根）去解析，没看命令自己先 `cd` 进了子目录，于是把合法路径判成越界。
 *
 * 规则（保守、只认能静态确定的形式）：
 *  - 只在段首识别 `cd <路径>`（`cd` 之后到段尾只有这一个参数）；
 *  - 相对路径按「这一段开始时的 cwd」解析，解析成功就更新后续段的 cwd；
 *  - 不是单一路径参数（含 `$(…)`、`&&` 之类）一律不更新，保持旧行为。
 */
export function commandCwdTimeline(command: string, baseCwd: string): Array<{ text: string; cwd: string }> {
  const parts = command.split(SEGMENT_SPLIT);
  const timeline: Array<{ text: string; cwd: string }> = [];
  let cwd = resolve(baseCwd);
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index] ?? '';
    timeline.push({ text, cwd });
    const target = leadingCdTarget(text);
    if (!target) continue;
    // `$(…)` / 反引号 / 通配符：静态算不出目标，保持原 cwd。
    if (/[$`*?]/.test(target)) continue;
    cwd = resolve(cwd, target);
  }
  return timeline;
}

/** 段首是 `cd <单个路径参数>` 时返回那个参数，否则 `undefined`。 */
function leadingCdTarget(segment: string): string | undefined {
  const tokens = tokenizeSegment(segment);
  const headIndex = tokens.findIndex((token) => !isAssignment(token.text) && !isGrouping(token.text));
  if (headIndex < 0) return undefined;
  const head = basename(tokens[headIndex]!.text).toLocaleLowerCase();
  if (head !== 'cd' && head !== 'pushd') return undefined;
  const rest = tokens.slice(headIndex + 1).filter((token) => token.text !== '');
  if (rest.length !== 1) return undefined;
  return rest[0]!.text;
}

/** `..` 引用按段解析：每段用它自己那一时刻的 cwd。 */
function parentReferenceViolation(
  command: string,
  roots: readonly string[],
  cwd: string | undefined,
): string | undefined {
  if (!ANY_PARENT_REFERENCE.test(command)) return undefined;
  if (!cwd) {
    // 不知道工作目录时无法静态判定 `..` 会解析到哪里，只能保守拒绝。
    return tt('path.blockedGeneric');
  }
  for (const { text, cwd: segmentCwd } of commandCwdTimeline(command, cwd)) {
    for (const match of text.matchAll(PARENT_REFERENCE)) {
      const token = match[2]!.replace(/[.,;:)\]]+$/, '');
      if (!token) continue;
      if (!roots.some((root) => isPathWithin(root, resolve(segmentCwd, token)))) {
        return tt('path.blockedResolved', { token });
      }
    }
  }
  return undefined;
}

export function commandPathViolation(
  rawCommand: string,
  roots: readonly string[],
  cwd?: string,
  platform: string = process.platform,
): string | undefined {
  // 先把 sed / grep 的“模式/脚本”参数遮掉：`sed -n '/a/,/^b/p' file.txt` 里的
  // `/"name"/,/displayName/p` 会被 BARE_ABSOLUTE_PATH 当成绝对路径拒绝，而它根本
  // 不是文件访问。旧实现只能给出“请改写成 -e”的提示，让调用方替工具背锅。
  // 遮掉的是模式位置上的参数，真正的文件参数仍在后面照常校验。
  //
  // heredoc 正文（`python3 - <<'PY' … PY`）同理：那是代码/样式数据，里面的
  // `/* 注释 *\/`、`url(../x)` 都不是命令行参数。正文里只保留一种检查：
  // **带引号的绝对路径**（`open('/etc/passwd')` 这种真实访问照样拦住）。
  const heredocs = heredocRanges(rawCommand);
  const bodies = heredocs.map((range) => rawCommand.slice(range.start, range.end));
  const command = maskPatternFlagArguments(maskPatternArguments(maskRanges(rawCommand, heredocs)));
  if (ESCAPING_PATH.test(command)) {
    return tt('path.blockedGeneric');
  }
  const parentViolation = parentReferenceViolation(command, roots, cwd);
  if (parentViolation) return parentViolation;
  if (!roots.length) return undefined;

  // URL 里的 `//host/path` 不是文件路径，先剔除再扫描。
  const withoutUrls = command.replace(URL_LIKE, ' ');
  const candidates: string[] = [];
  // 带引号的路径可以含空格（例如 "…/AI projects/x"），要整体取出再判断。
  for (const match of withoutUrls.matchAll(QUOTED_STRING)) {
    const value = (match[1] ?? match[2] ?? '').trim();
    // 跨行的「字符串」不是路径：`css = """ … /* … */ … """` 这种整段代码块
    // 会被 isAbsolute 误判（因为正文里有以 `/` 开头的注释行）。
    if (/[\r\n]/.test(value)) continue;
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) candidates.push(value);
  }
  const unquoted = withoutUrls.replace(QUOTED_STRING, ' ');
  for (const match of unquoted.matchAll(BARE_ABSOLUTE_PATH)) {
    candidates.push(match[2]!);
  }
  // 裸根 `/`：上面的 BARE_ABSOLUTE_PATH 要求 `/` 后至少一个字符，会漏掉
  // `rm -rf /` 这类写法，这里补一条独立检出。
  if (BARE_ROOT_PATH.test(unquoted)) candidates.push('/');
  // heredoc 正文只收紧到「带引号的绝对路径」：CSS 注释、`url(../x)`、正则字面量
  // 都不再误伤，而脚本里真去 open('/etc/passwd') 仍然会被拦下。
  for (const body of bodies) {
    for (const match of body.matchAll(QUOTED_STRING)) {
      const value = (match[1] ?? match[2] ?? '').trim();
      if (/[\r\n]/.test(value)) continue;
      if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) candidates.push(value);
    }
  }

  for (const raw of candidates) {
    const candidate = raw.replace(/[.,;:)\]]+$/, '');
    if (!candidate) continue;
    if (isWindowsCommandSwitch(candidate, platform)) continue;
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
 * heredoc 正文的区间（`python3 - <<'PY' … PY`）。
 *
 * 现场（2026-11-04，用户把失败原样贴回来两次）：
 *
 *     python3 - <<'PY'
 *     ...
 *     /* 移动菜单（2026-11-06）：≤720px 时导航里的文字链全部收进这块面板。 *\/
 *     ...
 *     PY
 *
 * 隔离策略把 `/* 移动菜单…` 当成绝对路径，整条命令被拒绝，还建议「改成 grep -e」——
 * 可那段是 **CSS 注释**，并不是文件访问。heredoc 正文是代码/样式数据，不是命令行
 * 参数，不能按命令行参数的方式扫描。
 */
export function heredocRanges(command: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const lines: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const line of command.split('\n')) {
    lines.push({ start: offset, end: offset + line.length });
    offset += line.length + 1;
  }
  const HEREDOC = /<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z0-9_.:-]+))/g;
  for (let index = 0; index < lines.length; index += 1) {
    const text = command.slice(lines[index]!.start, lines[index]!.end);
    // 一行里可能有多个 heredoc（`cat <<A > a.txt <<B`）：正文按顺序依次排在后面。
    const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
    for (const match of text.matchAll(HEREDOC)) {
      const delimiter = match[2] ?? match[3] ?? match[4];
      if (delimiter) pending.push({ delimiter, stripTabs: match[1] === '-' });
    }
    if (!pending.length) continue;
    let bodyStart = lines[index]!.end + 1;
    let lastTerminator = index;
    for (const { delimiter, stripTabs } of pending) {
      let terminator = -1;
      for (let scan = lastTerminator + 1; scan < lines.length; scan += 1) {
        const candidate = command.slice(lines[scan]!.start, lines[scan]!.end);
        const compared = stripTabs ? candidate.replace(/^\t+/, '') : candidate;
        if (compared === delimiter) {
          terminator = scan;
          break;
        }
      }
      // 找不到结束标记就不遮：宁可多检查，也不能把后面的命令当成正文吞掉。
      if (terminator < 0) break;
      ranges.push({ start: bodyStart, end: lines[terminator]!.start });
      bodyStart = lines[terminator]!.end + 1;
      lastTerminator = terminator;
    }
    index = lastTerminator;
  }
  return ranges;
}

/** 把若干区间替换成等长空白（保留换行），使它们不参与后续扫描。 */
function maskRanges(text: string, ranges: ReadonlyArray<{ start: number; end: number }>): string {
  if (!ranges.length) return text;
  let result = text;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    const blank = result.slice(range.start, range.end).replace(/[^\n]/g, ' ');
    result = `${result.slice(0, range.start)}${blank}${result.slice(range.end)}`;
  }
  return result;
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

/**
 * 值本身是「匹配模式」而不是「文件路径」的选项。
 *
 * 真实故障（2026-11-03，用户原话：「命令被路径隔离策略拦截」/「已阻止访问敏感文件」）：
 * 模型执行
 *
 *     tar czf <工作区内>/tmp/x.tgz --exclude 'node_modules' --exclude '.env' server
 *
 * `--exclude` 后面的是**排除模式**，`'.env'` 根本不是要读的文件；但敏感文件守卫在整条
 * 命令里 grep 到了 `.env`，于是判定「命令参数引用了敏感文件名」直接拒绝。模型换路径
 * 重试三次全被拒，最后触发「连续 3 轮失败」停机 —— 用户为此专门反馈「为什么要停」。
 *
 * 这些选项的值一律不算文件访问：
 *   --exclude / --exclude-dir / --include / --include-dir
 *   --ignore / --ignore-pattern / --ignore-dir / --glob / --filter
 *   find 的 -name / -iname / -path / -ipath / -regex / -iregex
 *
 * 刻意**不**包含读文件的选项：`--exclude-from`、`-f`、`--file`、`-X` 指向的是真实文件，
 * 继续按路径校验，不能借掩码绕过去。
 */
const PATTERN_VALUE_FLAGS = new Set([
  '--exclude', '--exclude-dir', '--include', '--include-dir',
  '--ignore', '--ignore-pattern', '--ignore-dir', '--glob', '--filter',
  '-name', '-iname', '-path', '-ipath', '-regex', '-iregex',
]);

/**
 * 把「模式选项的值」替换成占位词，使它们不再被当成文件路径或敏感文件名。
 *
 * 支持三种写法：`--exclude .env`、`--exclude=.env`、`-name '.env'`。
 * 只改选项自己的值，命令其它部分原样保留。
 */
export function maskPatternFlagArguments(command: string): string {
  const tokens = tokenizeSegment(command);
  const masked: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const equals = token.text.indexOf('=');
    if (equals > 0 && PATTERN_VALUE_FLAGS.has(token.text.slice(0, equals))) {
      masked.push({ start: token.start, end: token.end });
      continue;
    }
    if (!PATTERN_VALUE_FLAGS.has(token.text)) continue;
    const value = tokens[index + 1];
    if (!value) continue;
    masked.push({ start: value.start, end: value.end });
    index += 1;
  }
  if (!masked.length) return command;
  let result = command;
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

/**
 * 从命令输出里捞出「报错说找不到的那些路径」。
 *
 * 真实反馈（用户 2026-11-07，贴回原始输出）：
 *
 *     grep: src/app/pet/ChatBubble.tsx: No such file or directory
 *     sed: can't read src/app/pet/ChatBubble.tsx: No such file or directory
 *
 * 只回这一句时，模型只能再猜一次路径；而它猜的方向（文件被改名 / 挪进子目录）
 * 恰好是可以直接查出来的。这里只负责**取出候选**，真实结构由调用方用
 * `pathHintFor` 补齐 —— 纯函数、不碰磁盘，便于单测。
 *
 * 认的形状（都来自 coreutils / binutils 的真实措辞）：
 *  - `grep: <path>: No such file or directory`
 *  - `cat: <path>: No such file or directory`
 *  - `sed: can't read <path>: No such file or directory`
 *  - `ls: cannot access '<path>': No such file or directory`
 *  - `/bin/sh: line 0: cd: <path>: No such file or directory`
 */
export function missingPathsInCommandOutput(output: string, limit = 2): string[] {
  const found: string[] = [];
  for (const raw of (output ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || !/no such file or directory|cannot access|can't read/i.test(line)) continue;
    /*
     * 从**句尾**往前剥，不要从开头剥。
     *
     * 旧写法用 `^[^:]*:` 去掉「谁在报错」，结果把 `some/other/path.ts: no such file…`
     * 里的路径本身当成前缀吃掉了（自己的单测抓到）。句尾的
     * `: no such file or directory` 是稳定的，先切它。
     */
    const body = line
      .replace(/:\s*no such file or directory.*$/i, '')
      .replace(/\bno such file or directory.*$/i, '')
      .trim();
    // 程序名前缀：`grep:`、`sed:`、`/bin/sh: line 0: cd:`。只认「短名 + 冒号」，
    // 所以 `some/other/path.ts` 这种带斜杠/点号的路径不会被误剥。
    const withoutProgram = body
      .replace(/^(?:\/[^\s:]+|[a-z][a-z0-9_-]{0,12}):\s*(?:line\s+\d+:\s*)?/i, '')
      .replace(/^(?:cannot access|can't read|cd:)\s*/i, '')
      .replace(/^['"`]|['"`]$/g, '')
      .trim();
    // 只要像路径的东西：带分隔符或扩展名。
    if (!withoutProgram || withoutProgram.length > 300) continue;
    if (!/[/\\.]/.test(withoutProgram)) continue;
    if (!found.includes(withoutProgram)) found.push(withoutProgram);
    if (found.length >= limit) break;
  }
  return found;
}
