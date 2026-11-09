import { ChatSettings, GuardedPolicy, PermissionPolicy, PermissionPreset } from './types';
import { Language, t } from './i18n';
import { gitOperationsIn } from '../agent/conversationScope';

/**
 * 权限边界说明
 *
 * 1. 读取 / 写入 / 命令各自有 allow / ask / deny 策略。
 * 2. 终端命令分成三档：
 *    - 只读命令：ls、git status、grep 等无副作用命令；
 *    - 正常命令：安装、构建、提交等常规命令；
 *    - 危险命令：提权、破坏性删除、磁盘擦写、推送远端、把网络脚本管道给 shell 等。
 * 3. 敏感文件（.env、密钥、证书等）单独一列，可取 allow / ask / deny。
 * 4. 硬边界（不随预设放宽）：未受信任工作区禁止写入和执行、工作区外路径隔离。
 */

export type CommandRiskTier = 'safe' | 'standard' | 'severe';

export interface PermissionPresetProfile {
  fileReadPolicy: PermissionPolicy;
  fileWritePolicy: PermissionPolicy;
  /** 只读命令（safe 档） */
  readOnlyCommandPolicy: PermissionPolicy;
  /** 正常命令（standard 档） */
  commandPolicy: PermissionPolicy;
  /** 危险命令（severe 档） */
  dangerousCommandPolicy: GuardedPolicy;
  /** 敏感文件读取 */
  sensitiveFilePolicy: GuardedPolicy;
}

export interface PermissionPresetDetail extends PermissionPresetProfile {
  id: PermissionPreset;
  label: string;
  /** 一句话说明，用于输入框下拉提示与设置页副标题 */
  summary: string;
  /** 设置页对照表里的定性描述 */
  read: string;
  write: string;
  readOnlyCommand: string;
  regularCommand: string;
  dangerousCommand: string;
  sensitive: string;
}

/** 预设顺序，设置页与输入框下拉共用，避免两处顺序漂移。 */
export const PERMISSION_PRESET_IDS: readonly PermissionPreset[] = ['askAll', 'review', 'autopilot', 'full'];

/**
 * 新对话的默认预设。
 *
 * 取最严格的一档（每次询问）而不是 `review`：默认值决定了“用户什么都没说的
 * 时候 Agent 能自己做什么”，这类默认值出错是不可撤销的——一条没被确认的
 * 推送远端或递归删除发出去就收不回来。宁可让第一次使用的人多点几次确认，
 * 再由他主动放宽到 `风险操作询问` / `Autopilot`，也不该让他先承担一次自动执行。
 *
 * 这里而不是 `settings.ts` 定义，是因为 `settings.ts` 要 import 本文件（单向依赖），
 * 反过来 import 会形成循环。
 */
export const DEFAULT_PERMISSION_PRESET: PermissionPreset = 'askAll';

export const PERMISSION_PRESET_PROFILES: Record<PermissionPreset, PermissionPresetProfile> = {
  askAll: {
    fileReadPolicy: 'ask',
    fileWritePolicy: 'ask',
    readOnlyCommandPolicy: 'ask',
    commandPolicy: 'ask',
    dangerousCommandPolicy: 'deny',
    sensitiveFilePolicy: 'deny',
  },
  review: {
    fileReadPolicy: 'allow',
    fileWritePolicy: 'allow',
    readOnlyCommandPolicy: 'allow',
    commandPolicy: 'allow',
    dangerousCommandPolicy: 'ask',
    sensitiveFilePolicy: 'deny',
  },
  autopilot: {
    fileReadPolicy: 'allow',
    fileWritePolicy: 'allow',
    readOnlyCommandPolicy: 'allow',
    commandPolicy: 'allow',
    // 与 review 区分开：Autopilot 连危险命令也自动执行，只把敏感文件挡住。
    dangerousCommandPolicy: 'allow',
    sensitiveFilePolicy: 'deny',
  },
  full: {
    fileReadPolicy: 'allow',
    fileWritePolicy: 'allow',
    readOnlyCommandPolicy: 'allow',
    commandPolicy: 'allow',
    dangerousCommandPolicy: 'allow',
    sensitiveFilePolicy: 'ask',
  },
};

/**
 * 对照表单元格文案由策略值推导，而不是另写一份文字表。
 * 这样「界面写自动允许、实际却逐次确认」这类不一致在结构上不可能出现。
 */
function matrixCell(
  kind: 'read' | 'write' | 'readOnlyCommand' | 'regularCommand' | 'dangerousCommand' | 'sensitive',
  policy: GuardedPolicy,
  lang: Language,
): string {
  if (kind === 'dangerousCommand') {
    if (policy === 'deny') return t(lang, 'matrix.deny');
    return policy === 'allow' ? t(lang, 'matrix.allow') : t(lang, 'matrix.askEvery');
  }
  if (kind === 'sensitive') {
    if (policy === 'allow') return t(lang, 'matrix.allow');
    return policy === 'ask' ? t(lang, 'matrix.askEvery') : t(lang, 'matrix.block');
  }
  if (policy === 'ask') return t(lang, 'matrix.askEvery');
  if (policy === 'deny') return t(lang, 'matrix.deny');
  return kind === 'write' ? t(lang, 'matrix.allowInWorkspace') : t(lang, 'matrix.allow');
}

/** 按语言生成预设说明列表；设置页与输入框下拉都从这里取。 */
export function permissionPresetDetails(lang: Language): PermissionPresetDetail[] {
  return PERMISSION_PRESET_IDS.map((id) => {
    const profile = PERMISSION_PRESET_PROFILES[id];
    return {
      id,
      ...profile,
      label: t(lang, `preset.${id}.label`),
      summary: t(lang, `preset.${id}.summary`),
      read: matrixCell('read', profile.fileReadPolicy, lang),
      write: matrixCell('write', profile.fileWritePolicy, lang),
      readOnlyCommand: matrixCell('readOnlyCommand', profile.readOnlyCommandPolicy, lang),
      regularCommand: matrixCell('regularCommand', profile.commandPolicy, lang),
      dangerousCommand: matrixCell('dangerousCommand', profile.dangerousCommandPolicy, lang),
      sensitive: matrixCell('sensitive', profile.sensitiveFilePolicy, lang),
    };
  });
}

/**
 * 预设策略表：只含 id 与六项策略，不含任何语言相关文案。
 * 供测试断言「说明表与策略表同源」。
 */
export const PERMISSION_PRESET_DETAILS: readonly (PermissionPresetProfile & { id: PermissionPreset })[] =
  PERMISSION_PRESET_IDS.map((id) => ({ id, ...PERMISSION_PRESET_PROFILES[id] }));

export function permissionPresetDetail(preset: PermissionPreset, lang: Language): PermissionPresetDetail {
  const details = permissionPresetDetails(lang);
  // 查不到时回落到默认预设，而不是“列表里的第二个”（那是 review，默认值一改就错位）。
  return details.find((detail) => detail.id === preset)
    ?? details.find((detail) => detail.id === DEFAULT_PERMISSION_PRESET)!;
}

/** Autopilot / 完全访问：常规操作不弹窗。 */
export function isAutonomousPreset(settings: Pick<ChatSettings, 'permissionPreset'>): boolean {
  return settings.permissionPreset === 'autopilot' || settings.permissionPreset === 'full';
}

/**
 * 终端命令的最终策略，完全由当前预设决定。
 *
 * 自定义档位已移除：内置四档之外不再允许逐项拼策略，避免出现
 * “设置页显示禁止、实际却按预设放行”这类界面与行为不一致。
 */
export function commandPolicyFor(settings: ChatSettings, tier: CommandRiskTier): PermissionPolicy {
  const profile = PERMISSION_PRESET_PROFILES[settings.permissionPreset];
  if (tier === 'severe') return profile.dangerousCommandPolicy;
  if (tier === 'safe') return profile.readOnlyCommandPolicy;
  return profile.commandPolicy;
}

/** 敏感文件读取的最终策略：允许 / 逐次确认 / 禁止。 */
export function sensitiveFilePolicyFor(settings: ChatSettings): GuardedPolicy {
  return PERMISSION_PRESET_PROFILES[settings.permissionPreset].sensitiveFilePolicy;
}

/** 嵌套 shell / 解释器的 `-c` 载荷：静态无法判定它会做什么。 */
const NESTED_SHELL = /\b(?:ba|z|k|da|fi)?sh\s+-[a-zA-Z]*c\b/i;
const NESTED_INTERPRETER = /\b(?:python[0-9.]*|node|deno|bun|perl|ruby|php|pwsh|powershell|osascript)\b[^|;&\n]*?(?:\s-[ce]\b|\s-(?:Command|EncodedCommand)\b)/i;
const CMD_SLASH_C = /\bcmd(?:\.exe)?\s+\/c\b/i;
// 只认「命令位置」的 eval / source / `. script`：`find .` 里的点不是 dot-source（曾误判）。
const EVAL_LIKE = /(?:^|[;&|]\s*)(?:eval|source)\s|(?:^|[;&|]\s*)\.\s+\S|\bInvoke-Expression\b|\biex\b/i;
const PIPE_TO_SHELL = /\|\s*(?:sudo\s+)?(?:ba|z|k|da|fi)?sh\b/i;
const BASE64_DECODE = /\bbase64\b[^|;&]*?(?:-d\b|--decode\b|-[dD]\b)/;
/** 命令位置是变量展开（`X=rm; $X -rf x`）。 */
const VARIABLE_AS_COMMAND = /(?:^|[;&|]\s*)\$(?:\{)?[A-Za-z_]\w*(?:\})?\s/;
/** 会把整棵子树删掉、却常常藏在「只读」命令里的写法。 */
const IMPLICIT_DELETE = [
  /\bfind\b[^|;&]*-delete\b/i,
  /\bxargs\b[^|;&]*\brm\b/i,
  /\bgit\s+clean\b[^|;&]*-[a-z]*[fdx][a-z]*/i,
  /\bgit\s+checkout\s+--\s+\.\s*$/i,
];

/**
 * 「这条命令会不会执行我读不懂的东西？」
 *
 * 2026-11-08 外部评审（Claude + GPT）一致指出：正则黑名单不能当沙箱。
 * 但这不代表正则没用 —— 它能把**明显无法静态判定**的写法一律升级到 `severe`
 * （`askAll` 直接拒绝，其余预设逐次确认），从而把「静默执行」变成「必须人看」。
 *
 * 真机复现的四个绕过（修复前 `standard` + 路径检查放行）：
 *
 *     python -c "open('/etc/passwd').read()"
 *     node -e "require('fs').readFileSync('/etc/passwd','utf8')"
 *     bash -c 'cat /etc/passwd'
 *     echo "$(cat /etc/passwd)"
 *
 * 返回原因（用于日志与测试），不是 severe 则返回 undefined。
 */
export function dynamicExecutionReason(command: string): string | undefined {
  const text = String(command ?? '');
  if (NESTED_SHELL.test(text)) return 'nested-shell';
  if (NESTED_INTERPRETER.test(text)) return 'nested-interpreter';
  if (CMD_SLASH_C.test(text)) return 'cmd-slash-c';
  if (EVAL_LIKE.test(text)) return 'eval';
  if (PIPE_TO_SHELL.test(text)) return 'pipe-to-shell';
  if (BASE64_DECODE.test(text) && PIPE_TO_SHELL.test(text)) return 'decoded-to-shell';
  if (VARIABLE_AS_COMMAND.test(text)) return 'variable-as-command';
  if (IMPLICIT_DELETE.some((pattern) => pattern.test(text))) return 'implicit-delete';
  // 命令替换里出现危险动作：`echo "$(rm -rf x)"`
  for (const payload of commandSubstitutions(text)) {
    if (SEVERE_COMMAND_PATTERNS.some((pattern) => pattern.test(payload))) return 'dangerous-substitution';
    if (NESTED_SHELL.test(payload) || NESTED_INTERPRETER.test(payload)) return 'dangerous-substitution';
  }
  return undefined;
}

/** 取出 `$(…)`（含嵌套）与反引号里的内容。 */
export function commandSubstitutions(text: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > index) found.push(text.slice(index + 1, end));
    }
    if (text[index] === '$' && text[index + 1] === '(') {
      let depth = 0;
      for (let cursor = index + 1; cursor < text.length; cursor += 1) {
        if (text[cursor] === '(') depth += 1;
        else if (text[cursor] === ')') {
          depth -= 1;
          if (depth === 0) {
            found.push(text.slice(index + 2, cursor));
            break;
          }
        }
      }
    }
  }
  return found;
}

/**
 * 会「被别的程序自动执行」的文件。
 *
 * 2026-11-08 外部评审（Claude）指出的绕过：`write_file` 在 `review` 预设下是
 * **allow**，于是写 `.vscode/tasks.json`（`runOn: folderOpen`）、
 * `package.json` 的 `postinstall`、`.envrc`、`.github/workflows/*`、
 * `.devcontainer/*`、`.git/hooks/*`，等价于把执行推迟到工具闸门之外 ——
 * 用户下次打开文件夹或装依赖时，代码就跑起来了。
 *
 * 这些路径一律**至少要一次确认**（`deny` 仍然拒绝，不会被放宽）。
 */
const AUTO_EXEC_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.vscode\/[^/]+$/i,
  /(^|\/)\.devcontainer\//i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)\.git\/hooks\//i,
  /(^|\/)\.gitmodules$/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)\.pre-commit-config\.ya?ml$/i,
  /(^|\/)[^/]+\.code-workspace$/i,
  /(^|\/)(?:package|composer)\.json$/i,
  /(^|\/)(?:Makefile|GNUmakefile|makefile)$/i,
  /(^|\/)(?:setup\.py|pyproject\.toml|Pipfile)$/i,
  /(^|\/)(?:build|preinstall|postinstall|prepare|install)\.(?:sh|js|cjs|mjs|ps1|bat)$/i,
];

export function isAutoExecPath(path: string): boolean {
  const normalized = String(path ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized) return false;
  return AUTO_EXEC_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function classifyCommandTier(command: string): CommandRiskTier {
  const text = command.trim();
  if (!text) return 'standard';
  if (isPushingToRemote(text)) return 'severe';
  if (SEVERE_COMMAND_PATTERNS.some((pattern) => pattern.test(text))) return 'severe';
  // 无法静态判定的动态执行：一律 severe（= 必须人看），不再静默放行。
  if (dynamicExecutionReason(text)) return 'severe';
  return isSafeCommand(text) ? 'safe' : 'standard';
}

/**
 * 只要这条命令会推送到远端，就按危险命令处理。
 *
 * 为什么不用一条正则了事（实测出来的绕过）：`/\bgit\s+push\b/` 要求 `git` 后面
 * 紧跟 `push`，于是下面三种把 git 的全局选项夹在中间的写法都落到 `standard`，
 * 在「风险操作询问」预设下会被**静默执行**：
 *
 *     git -C . push          git --no-pager push          git -c user.name=x push
 *
 * 所以再借 `conversationScope` 的 git 解析器判一次 —— 它本来就负责跳过
 * `-C <path>` / `-c <k=v>` / `--no-pager` / `--git-dir=…` 这些全局选项，
 * 并且认 `cd repo && git push`、`GIT_DIR=. git push`、`/usr/bin/git push`。
 *
 * 正则仍然保留：解析器只看「命令头是 git」的段落，`bash -c "git push"` 这种
 * 被引号包起来的写法它看不到，而正则能命中。两条互补，取并集。
 */
function isPushingToRemote(text: string): boolean {
  return /\bgit\s+push\b/i.test(text)
    || gitOperationsIn(text).some((operation) => operation.verb === 'push');
}

/**
 * “危险命令”判定：提权、破坏性删除、磁盘擦写、把远程脚本直接管道给 shell、
 * 发布制品等。四个预设的处置各不相同：`每次询问` **直接拒绝**（不是先问再拒），
 * `风险操作询问` 逐次确认，`Autopilot` 与 `完全访问` 自动执行。
 *
 * 推送远端不在这张表里，见 `isPushingToRemote()` —— 它需要跳过 git 的全局选项，
 * 一条正则表达不了。
 */
const SEVERE_COMMAND_PATTERNS: readonly RegExp[] = [
  // 提权命令：sudo / doas / su。原先要求命令名后必须跟一个空白，导致单独一条
  // `sudo`（等着输密码）被判成 standard、在 review 预设下静默执行；改成“后面是空白或结束”都算危险。
  /(?:^|[\s;&|(`{])(?:sudo|doas|su)(?=\s|$)/i,
  /(?:^|[\s;&|(`])rm\s+(?:-[a-z]*[rf][a-z]*|--recursive|--force)/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /\b(?:fdisk|diskpart)\b/i,
  /\bdiskutil\s+(?:erase|partition|secureErase)/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /:\s*\(\s*\)\s*\{/,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*[fd]|filter-branch|reflog\s+expire|checkout\s+--\s+\.)/i,
  /\bchmod\s+(?:-r\s+)?777\b/i,
  /\bchown\s+-r\b/i,
  // 同理：approvalPlan.ts 把 curl / wget 整类当成“网络下载，不自动批准”。
  // 这里对齐，只放过纯 --version / --help。管道给 shell 的情形本来也由这条覆盖。
  /\b(?:curl|wget)\b(?!\s+(?:--version|-V|--help|-h)\s*$)/i,
  /\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b/i,
  /\btwine\s+upload\b/i,
  /\b(?:drop|truncate)\s+(?:database|schema|table)\b/i,
  /\b(?:del|erase)\s+\/[a-z]*[sqf]/i,
  /\brd\s+\/s\b/i,
  /\bremove-item\b[^\n]*-recurse/i,
  /\bkill(?:all)?\s+-9\b/i,
  /\bpkill\b/i,
  /\bshred\b/i,
  /\bhistory\s+-c\b/i,
  />\s*\/dev\/(?:sd|disk|nvme|rdisk)/i,
  /\btruncate\s+-s\s*\+?0\b/i,
];

/** 只读、无副作用、且在审阅模式下可以静默执行的命令。 */
const SAFE_EXECUTABLES = new Set([
  'ls', 'dir', 'pwd', 'tree', 'stat', 'du', 'df', 'wc', 'head', 'tail', 'cat', 'type', 'less', 'more',
  'grep', 'rg', 'find', 'basename', 'dirname', 'realpath', 'whoami', 'hostname', 'date', 'sort', 'uniq',
  'diff', 'jq',
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'describe', 'blame', 'shortlog', 'ls-files', 'remote', 'branch',
]);

/** `node --version` 这类只打印版本/帮助的命令。 */
const SAFE_VERSION_EXECUTABLES = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'python', 'python3', 'pip', 'pip3', 'go', 'cargo', 'rustc', 'java',
  'dotnet', 'deno', 'bun',
]);

const VERSION_ONLY_ARGUMENT = /^(?:--version|-v|--help|-h)$/;
const FIND_SIDE_EFFECT = /-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/;
const GIT_OUTPUT_FLAG = /--output(?:=|\s)/;

/**
 * 只读的「子命令型」命令（像 git 那样要看完第二个词才知道干不干净）。
 *
 * 用户现场（2026-11-09）：`rustup target list --installed 2>/dev/null` 因为不在白名单里
 * 落到 `standard`，于是 Autopilot 下也要确认一次 —— 但它只是打印已安装的 target。
 */
const SAFE_READONLY_SUBCOMMANDS: readonly RegExp[] = [
  /^rustup\s+(?:show|which|target\s+list|toolchain\s+list|component\s+list|--version|-V|--help|-h)(?:\s|$)/i,
  /^rustup\s+--version$/i,
];

/**
 * 切不动就返回 `null`：这是**安全**判定，解析失败必须当成「不可自动放行」。
 *
 * 为什么需要它：以前 `SHELL_CHAINING` 一见到 `|`、`&&`、`;` 就整条降级到 `standard`，
 * 于是 `cd X && grep -rn … | head -20; echo …` 这种纯读命令在 Autopilot 下也要逐个确认
 * （用户 2026-11-09 的实际困扰）。现在把它切开，**每一段都只读**才算只读。
 *
 * 明确拒绝（返回 null）的东西：反引号 / `$(` / `${…}` / `$VAR`（动态执行或动态内容）、
 * 子 shell `( )`、输入重定向 `<`、除 `/dev/null` 之外的输出重定向、未闭合的引号。
 * 这些正是「静态判不准」的部分 —— 宁可让人看一眼。
 */
function shellSegments(text: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === "'") {
      current += char;
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      // 单引号里反斜杠是字面量（上面已经 continue 掉了），这里只在引号外/双引号内转义。
      const next = text[index + 1];
      if (next === undefined) return null;
      current += char + next;
      index += 1;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"';
      current += char;
      continue;
    }
    if (char === "'") {
      quote = "'";
      current += char;
      continue;
    }
    if (quote === '"') {
      // 双引号里仍然会发生替换与命令执行。
      if (char === '`' || char === '$') return null;
      current += char;
      continue;
    }
    if (char === '`' || char === '$') return null;
    if (char === '(' || char === ')') return null;
    if (char === '<') return null;
    if (char === '>') {
      // 只接受「把噪音丢掉」的那几种重定向；写文件一律不算只读。
      const rest = text.slice(index);
      const allowed = /^(?:[12]?>&[12]|&>{1,2}\s*\/dev\/null|[12]?>{1,2}\s*\/dev\/null)/.exec(rest);
      if (!allowed) return null;
      current += ` ${allowed[0]} `;
      index += allowed[0].length - 1;
      continue;
    }
    if (char === ';' || char === '\n' || char === '&' || char === '|') {
      // `&&` / `||` / `|&` 一并吃掉，其余单个连接符本身就是分隔符。
      const pair = text.slice(index, index + 2);
      segments.push(current);
      current = '';
      index += pair === '&&' || pair === '||' || pair === '|&' ? 1 : 0;
      continue;
    }
    current += char;
  }
  if (quote) return null;
  segments.push(current);
  return segments;
}

/** 单个命令段是否只读。`cd` / `echo` / `printf` 这类没有副作用的也在这里放行。 */
function isSafeSegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0]?.toLocaleLowerCase();
  if (!head) return false;
  // `X=rm` 之后再 `$X` 属于动态执行（那一类由 `VARIABLE_AS_COMMAND` 判 severe），
  // 单纯的赋值也不该算只读。
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return false;
  // 引号包起来的命令名、路径前缀（`./x`、`/bin/x`）都不在「可判定」范围内。
  if (head.includes('"') || head.includes("'")) return false;
  const rest = tokens.slice(1);

  if (head === 'cd' || head === 'echo' || head === 'printf' || head === ':' || head === 'true') return true;
  if (SAFE_READONLY_SUBCOMMANDS.some((pattern) => pattern.test(segment.trim()))) return true;

  if (head === 'git') {
    const subcommand = rest[0]?.toLocaleLowerCase();
    if (!subcommand || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false;
    if (GIT_OUTPUT_FLAG.test(segment)) return false;
    if (subcommand === 'branch' && rest.some((token) => /^-(?:d|D|m|M|c|C|f)(?:$|\s)/.test(token))) return false;
    if (subcommand === 'remote' && rest.some((token) => /^(?:add|remove|rename|set-url|prune|update)$/i.test(token))) return false;
    return true;
  }

  if (SAFE_VERSION_EXECUTABLES.has(head)) {
    return rest.length === 1 && VERSION_ONLY_ARGUMENT.test(rest[0]!);
  }

  if (!SAFE_EXECUTABLES.has(head)) return false;
  if (head === 'find' && FIND_SIDE_EFFECT.test(segment)) return false;
  return true;
}

/**
 * 「这条命令只读吗」——**逐段**判定，每一段都必须只读。
 *
 * 用户现场（2026-11-09，Autopilot）：`cd … && grep -rn '…' shot/ocr.rs | head -20;
 * echo '=== rustup targets ==='; rustup target list --installed 2>/dev/null`
 * 整条只看不写，却因为含有 `&&` / `|` / `;` 被旧实现判成 `standard`。
 */
function isSafeCommand(text: string): boolean {
  const segments = shellSegments(text);
  if (!segments) return false;
  const meaningful = segments.map((segment) => segment.trim()).filter(Boolean);
  if (!meaningful.length) return false;
  return meaningful.every(isSafeSegment);
}

/**
 * VS Code 扩展工具的风险分档，只用于展示、Plan 模式和未受信任工作区的硬边界；
 * 是否需要用户授权完全交给 VS Code（工具的 prepareInvocation 决定）。
 */
export function classifyVscodeToolRisk(tool: {
  name: string;
  description?: string;
  tags?: readonly string[];
}): 'read' | 'write' | 'command' {
  const text = `${tool.name} ${tool.description ?? ''} ${(tool.tags ?? []).join(' ')}`;
  const readName = VSCODE_READ_NAME.test(tool.name.replace(/^(?:vscode|copilot|github|mcp|ext)[_.-]/i, ''));
  const writes = VSCODE_WRITE_SIGNAL.test(text);
  if (readName && !writes) return 'read';
  if (writes) return 'write';
  if (VSCODE_COMMAND_SIGNAL.test(text)) return 'command';
  return 'read';
}

const VSCODE_READ_NAME = /^(?:get|read|list|show|view|search|find|inspect|describe|fetch|query|lookup|check|diagnose|suggest|terminal_(?:last_command|selection|output))/i;
const VSCODE_COMMAND_SIGNAL = /(terminal|shell|command|process|spawn|exec(?:ute|dir)?|run[_\s-]|running|task[_\s-]|build|test[_\s-]?runner|network|http|fetch|web[_\s-]?request|remote|cloud)/i;
const VSCODE_WRITE_SIGNAL = /(write|edit|create|delete|remove|drop|move|rename|apply|replace|patch|install|uninstall|update|publish|deploy|push|commit|merge|send|post|insert|save|upload|format)/i;
