import { ChatSettings, GuardedPolicy, PermissionPolicy, PermissionPreset } from './types';

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

export interface PermissionPresetDetail extends Partial<PermissionPresetProfile> {
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

export const PERMISSION_PRESET_PROFILES: Record<Exclude<PermissionPreset, 'custom'>, PermissionPresetProfile> = {
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
    dangerousCommandPolicy: 'ask',
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

export const PERMISSION_PRESET_DETAILS: readonly PermissionPresetDetail[] = [
  {
    id: 'askAll',
    label: '每次询问',
    summary: '读取、写入和命令全部逐次确认；危险命令直接拒绝',
    read: '逐次确认',
    write: '逐次确认',
    readOnlyCommand: '逐次确认',
    regularCommand: '逐次确认',
    dangerousCommand: '直接拒绝',
    sensitive: '禁止',
    ...PERMISSION_PRESET_PROFILES.askAll,
  },
  {
    id: 'review',
    label: '风险操作询问',
    summary: '自动读写与常规命令，只有危险命令逐次确认',
    read: '自动允许',
    write: '自动允许（工作区内）',
    readOnlyCommand: '自动允许',
    regularCommand: '自动允许',
    dangerousCommand: '逐次确认',
    sensitive: '禁止',
    ...PERMISSION_PRESET_PROFILES.review,
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    summary: '自动读写与常规命令，只有危险命令逐次确认',
    read: '自动允许',
    write: '自动允许（工作区内）',
    readOnlyCommand: '自动允许',
    regularCommand: '自动允许',
    dangerousCommand: '逐次确认',
    sensitive: '禁止',
    ...PERMISSION_PRESET_PROFILES.autopilot,
  },
  {
    id: 'full',
    label: '完全访问',
    summary: '全部自动执行（含危险命令），读取敏感文件时逐次确认',
    read: '自动允许',
    write: '自动允许（工作区内）',
    readOnlyCommand: '自动允许',
    regularCommand: '自动允许',
    dangerousCommand: '自动允许',
    sensitive: '逐次确认',
    ...PERMISSION_PRESET_PROFILES.full,
  },
  {
    id: 'custom',
    label: '自定义',
    summary: '按设置页中的读取 / 写入 / 命令 / 危险命令 / 敏感文件策略逐项组合',
    read: '自定义',
    write: '自定义',
    readOnlyCommand: '自定义',
    regularCommand: '自定义',
    dangerousCommand: '自定义',
    sensitive: '自定义',
  },
];

export function permissionPresetDetail(preset: PermissionPreset): PermissionPresetDetail {
  return PERMISSION_PRESET_DETAILS.find((detail) => detail.id === preset) ?? PERMISSION_PRESET_DETAILS[1]!;
}

/** Autopilot / 完全访问：常规操作不弹窗。 */
export function isAutonomousPreset(settings: Pick<ChatSettings, 'permissionPreset'>): boolean {
  return settings.permissionPreset === 'autopilot' || settings.permissionPreset === 'full';
}

/**
 * 终端命令的最终策略。预设由 PERMISSION_PRESET_PROFILES 决定；自定义模式使用
 * 设置页里的 commandPolicy（只读 + 正常命令）与 dangerousCommandPolicy（危险命令）。
 */
export function commandPolicyFor(settings: ChatSettings, tier: CommandRiskTier): PermissionPolicy {
  if (settings.permissionPreset === 'custom') {
    if (tier === 'severe') return settings.dangerousCommandPolicy;
    return settings.commandPolicy;
  }
  const profile = PERMISSION_PRESET_PROFILES[settings.permissionPreset];
  if (tier === 'severe') return profile.dangerousCommandPolicy;
  if (tier === 'safe') return profile.readOnlyCommandPolicy;
  return profile.commandPolicy;
}

/** 敏感文件读取的最终策略：允许 / 逐次确认 / 禁止。 */
export function sensitiveFilePolicyFor(settings: ChatSettings): GuardedPolicy {
  if (settings.permissionPreset === 'custom') return settings.sensitiveFilePolicy;
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
  /(?:^|[\s;&|(`{])(?:sudo|doas|su)\s/i,
  /(?:^|[\s;&|(`])rm\s+(?:-[a-z]*[rf][a-z]*|--recursive|--force)/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /\b(?:fdisk|diskpart)\b/i,
  /\bdiskutil\s+(?:erase|partition|secureErase)/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /:\s*\(\s*\)\s*\{/,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*[fd]|push\s+(?:--force|-f)|filter-branch|reflog\s+expire|checkout\s+--\s+\.)/i,
  /\bchmod\s+(?:-r\s+)?777\b/i,
  /\bchown\s+-r\b/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|python3?|node|perl)\b/i,
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
