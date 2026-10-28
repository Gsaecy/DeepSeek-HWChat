import { ChatSettings, GuardedPolicy, PermissionPolicy, PermissionPreset } from './types';
import { Language, t } from './i18n';

/**
 * 权限边界说明
 *
 * 1. 读取 / 写入 / 命令各自有 allow / ask / deny 策略。
 * 2. 终端命令分成三档：
 *    - 只读命令：ls、git status、grep 等无副作用命令；
 *    - 正常命令：安装、构建、提交等常规命令；
 *    - 危险命令：提权、破坏性删除、磁盘擦写、强制推送、把网络脚本管道给 shell 等。
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
 * 强制推送或递归删除发出去就收不回来。宁可让第一次使用的人多点几次确认，
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

export function classifyCommandTier(command: string): CommandRiskTier {
  const text = command.trim();
  if (!text) return 'standard';
  if (SEVERE_COMMAND_PATTERNS.some((pattern) => pattern.test(text))) return 'severe';
  return isSafeCommand(text) ? 'safe' : 'standard';
}

/**
 * “危险命令”判定：提权、破坏性删除、磁盘擦写、强制推送、把远程脚本直接管道给
 * shell、发布制品等。默认预设逐次确认，只有「完全访问」会静默执行。
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
  // 只要 push 就拦：推出去的提交拿不回来，而 approvalPlan.ts 本来就把 push 列为“不自动批准”。
  // 之前只拦 --force，普通 push 落到 standard、review 预设下静默执行，两个模块口径不一致。
  /\bgit\s+push\b/i,
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
const SHELL_CHAINING = /[\n;&|<>`]|\$\(/;
const FIND_SIDE_EFFECT = /-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/;
const GIT_OUTPUT_FLAG = /--output(?:=|\s)/;

function isSafeCommand(text: string): boolean {
  if (SHELL_CHAINING.test(text)) return false;
  const tokens = text.split(/\s+/).filter(Boolean);
  const head = tokens[0]?.toLocaleLowerCase();
  if (!head) return false;
  const rest = tokens.slice(1);

  if (head === 'git') {
    const subcommand = rest[0]?.toLocaleLowerCase();
    if (!subcommand || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false;
    if (GIT_OUTPUT_FLAG.test(text)) return false;
    if (subcommand === 'branch' && rest.some((token) => /^-(?:d|D|m|M|c|C|f)(?:$|\s)/.test(token))) return false;
    if (subcommand === 'remote' && rest.some((token) => /^(?:add|remove|rename|set-url|prune|update)$/i.test(token))) return false;
    return true;
  }

  if (SAFE_VERSION_EXECUTABLES.has(head)) {
    return rest.length === 1 && VERSION_ONLY_ARGUMENT.test(rest[0]!);
  }

  if (!SAFE_EXECUTABLES.has(head)) return false;
  if (head === 'find' && FIND_SIDE_EFFECT.test(text)) return false;
  return true;
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
