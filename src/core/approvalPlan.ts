/**
 * VS Code 侧审批设置的纯计算层（不 import vscode，方便单测）。
 *
 * 背景：桥接工具（run_in_terminal 等）是否需要确认，由 VS Code 自己的
 * `chat.tools.*` 设置决定，HWChat 的 permissionPreset 管不到它们
 * （见 agent/vscodeTools.ts 的 delegateApproval: true）。本模块只负责把
 * 「一个审批档位」翻译成「要写进 VS Code 设置的具体值」，真正落盘在
 * vscodeApprovals.ts。
 *
 * 设计约束：
 * 1. 只声明我们确实管理的条目，用户自己写的其他条目原样保留；
 * 2. 不同 VS Code 版本键名可能不同，因此调用方传入「探测到的可用目标」；
 * 3. 危险命令永远是显式 deny，且优先级高于任何 allow 规则。
 */

export type ApprovalBridgeLevel = 'off' | 'safeCommands' | 'standard' | 'everything';

export type ApprovalValueKind = 'boolean' | 'map';

export interface ApprovalTarget {
  /** 完整设置 id，例如 chat.tools.terminal.autoApprove */
  id: string;
  kind: ApprovalValueKind;
  label: string;
}

export interface ApprovalTargetState extends ApprovalTarget {
  /** 该键在当前 VS Code 版本里是否真实注册 */
  available: boolean;
  /**
   * 用户在用户设置（settings.json）里的显式值。刻意不用 `configuration.get()`：
   * 那会把 VS Code 的默认值也读出来，写回时等于把默认值固化进用户设置。
   */
  current: unknown;
  /** 工作区/文件夹级也有值时，我们写到全局会被它覆盖。 */
  workspaceOverride?: boolean;
}

export interface ApprovalOperation {
  id: string;
  before: unknown;
  after: unknown;
}

export interface ApprovalPlan {
  level: ApprovalBridgeLevel;
  operations: ApprovalOperation[];
  unavailable: ApprovalTarget[];
  warnings: string[];
}

export interface ApprovalLevelDetail {
  id: ApprovalBridgeLevel;
  label: string;
  detail: string;
}

/**
 * VS Code 可能使用的审批键。命名在不同版本间变过，所以全部列出来，
 * 由「是否注册」决定实际写哪几个，而不是硬编码猜一个。
 */
export const APPROVAL_TARGETS: readonly ApprovalTarget[] = [
  { id: 'chat.tools.terminal.autoApprove', kind: 'map', label: '终端命令逐条批准表' },
  { id: 'chat.tools.terminal.enableAutoApprove', kind: 'boolean', label: '终端自动批准总开关' },
  { id: 'chat.tools.edits.autoApprove', kind: 'boolean', label: '文件编辑自动批准' },
  { id: 'chat.tools.global.autoApprove', kind: 'boolean', label: '全部工具自动批准' },
  { id: 'chat.tools.autoApprove', kind: 'boolean', label: '（旧命名）全部工具自动批准' },
];

export const APPROVAL_LEVEL_DETAILS: readonly ApprovalLevelDetail[] = [
  {
    id: 'off',
    label: '关闭（全部询问）',
    detail: '撤掉 HWChat 写入的批准条目，终端、编辑、工具都回到逐次确认。',
  },
  {
    id: 'safeCommands',
    label: '只读命令自动放行',
    detail: 'ls / grep / git status 这类只读命令不再弹窗；写入、编辑与危险命令仍然确认。',
  },
  {
    id: 'standard',
    label: '只读 + 构建测试',
    detail: '在“只读命令”基础上放行 npm test / run build / tsc 等；安装依赖会执行 postinstall，属正常命令。',
  },
  {
    id: 'everything',
    label: '全部自动批准（危险）',
    detail: '关闭所有询问，包括删除、强推与提权。仅在完全信任的仓库里使用。',
  },
];

interface ManagedRule {
  pattern: string;
  approve: boolean;
  note: string;
}

/** 只读、无副作用。 */
const READ_ONLY_RULES: readonly ManagedRule[] = [
  {
    pattern: '/^(?:ls|dir|pwd|tree|stat|du|df|wc|head|tail|cat|file|which|whoami|hostname|basename|dirname|realpath)\\b/',
    approve: true,
    note: '只读查看',
  },
  { pattern: '/^(?:grep|rg)\\b/', approve: true, note: '文本搜索' },
  {
    // find 的 -exec / -delete 有副作用，用负向前瞻挡掉。
    pattern: '/^find\\b(?!.*\\s-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\\b)/',
    approve: true,
    note: '查找文件（排除 -exec / -delete）',
  },
  { pattern: '/^jq\\b/', approve: true, note: 'JSON 查询' },
  { pattern: '/^diff\\b/', approve: true, note: '内容比较' },
];

const GIT_READ_ONLY_RULES: readonly ManagedRule[] = [
  {
    pattern: '/^git (?:status|diff|log|show|rev-parse|describe|blame|shortlog|ls-files)\\b/',
    approve: true,
    note: 'git 只读子命令',
  },
  { pattern: '/^git remote(?: -v| --verbose)?$/', approve: true, note: 'git remote 列表' },
  { pattern: '/^git branch(?: -[arv]+)*$/', approve: true, note: 'git branch 列表' },
];

const BUILD_RULES: readonly ManagedRule[] = [
  {
    pattern: '/^(?:npm|pnpm|yarn) (?:test|run (?:test|check|lint|build|compile|typecheck))\\b/',
    approve: true,
    note: '构建与测试',
  },
  {
    pattern: '/^(?:npm|pnpm|yarn) (?:install|ci)\\b/',
    approve: true,
    note: '安装依赖（会执行 postinstall 脚本）',
  },
  { pattern: '/^(?:npx )?tsc\\b.*(?:--noEmit|-p|-b)\\b/', approve: true, note: 'TypeScript 类型检查' },
];

/** 无论哪个档位都显式拒绝，且排在所有 allow 之后（后写入的规则优先）。 */
const DENIED_RULES: readonly ManagedRule[] = [
  { pattern: '/^(?:sudo|doas|su)\\b/', approve: false, note: '提权' },
  { pattern: '/^rm\\b/', approve: false, note: '删除' },
  { pattern: '/^shred\\b/', approve: false, note: '擦写' },
  { pattern: '/^git push\\b/', approve: false, note: '推送' },
  { pattern: '/^git (?:reset --hard|clean)\\b/', approve: false, note: '丢弃改动' },
  { pattern: '/^(?:npm|pnpm|yarn) (?:publish|unpublish)\\b/', approve: false, note: '发布制品' },
  { pattern: '/^(?:curl|wget)\\b/', approve: false, note: '网络下载' },
  { pattern: '/^chmod\\b/', approve: false, note: '权限变更' },
];

/** 我们管理的全部条目，用于「关闭」时精确清理。 */
export const MANAGED_RULE_PATTERNS: readonly string[] = [
  ...READ_ONLY_RULES,
  ...GIT_READ_ONLY_RULES,
  ...BUILD_RULES,
  ...DENIED_RULES,
].map((rule) => rule.pattern);

function rulesForLevel(level: ApprovalBridgeLevel): readonly ManagedRule[] {
  if (level === 'safeCommands') return [...READ_ONLY_RULES, ...GIT_READ_ONLY_RULES, ...DENIED_RULES];
  if (level === 'standard') {
    return [...READ_ONLY_RULES, ...GIT_READ_ONLY_RULES, ...BUILD_RULES, ...DENIED_RULES];
  }
  return DENIED_RULES;
}

/** 布尔型目标在各档位下应该是什么值。未列出的按「关闭」处理。 */
const BOOLEAN_DESIRED: Readonly<Record<string, (level: ApprovalBridgeLevel) => boolean>> = {
  'chat.tools.terminal.enableAutoApprove': (level) => level !== 'off',
  'chat.tools.edits.autoApprove': (level) => level === 'standard' || level === 'everything',
  'chat.tools.global.autoApprove': (level) => level === 'everything',
  'chat.tools.autoApprove': (level) => level === 'everything',
};

/**
 * 把档位翻译成要写入的操作列表。只对「当前版本确实存在」的键生成操作，
 * 并且跳过值本来就没变化的键，避免每次调用都重写 settings.json。
 */
export function planApprovalBridge(
  level: ApprovalBridgeLevel,
  targets: readonly ApprovalTargetState[],
): ApprovalPlan {
  const operations: ApprovalOperation[] = [];
  const unavailable: ApprovalTarget[] = [];
  const warnings: string[] = [];

  for (const target of targets) {
    if (!target.available) {
      const { current: _current, available: _available, ...descriptor } = target;
      unavailable.push(descriptor);
      continue;
    }
    if (target.workspaceOverride) {
      warnings.push(`${target.id} 在工作区设置里已定义，会覆盖本次写入的用户设置。`);
    }
    const after = target.kind === 'map'
      ? mapAfter(target.current, level, warnings)
      : booleanAfter(target.id, level);
    if (after === undefined) continue;
    if (valuesEqual(target.current, after)) continue;
    operations.push({ id: target.id, before: target.current, after });
  }

  if (level === 'standard') {
    warnings.push('“安装依赖”会执行包里的 postinstall 脚本，属于正常命令档，会一并自动放行。');
  }
  if (level === 'everything') {
    warnings.push('“全部自动批准”会连删除、强制推送、提权一起放行，仅建议在完全信任的仓库里使用。');
  }

  return { level, operations, unavailable, warnings };
}

function booleanAfter(id: string, level: ApprovalBridgeLevel): boolean | undefined {
  const desired = BOOLEAN_DESIRED[id];
  return desired ? desired(level) : false;
}

function mapAfter(
  current: unknown,
  level: ApprovalBridgeLevel,
  warnings: string[],
): Record<string, unknown> | undefined {
  // “全部自动批准”由布尔总开关负责，这里不动，避免和总开关语义打架。
  if (level === 'everything') return undefined;

  const original: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  const existing: Record<string, unknown> = { ...original };
  for (const pattern of MANAGED_RULE_PATTERNS) delete existing[pattern];

  if (level === 'off') {
    // 关闭时必须清掉我们写入的条目；用户自己的其他条目保持原样。
    if (!isPlainObject(current)) return undefined;
    return Object.keys(existing).length === Object.keys(original).length ? undefined : existing;
  }

  for (const rule of rulesForLevel(level)) {
    // 冲突判定必须看原始值：existing 里的托管条目刚被清空过。
    const previous = original[rule.pattern];
    if (previous === false && rule.approve) {
      warnings.push(`你原本手动禁止了 ${rule.pattern}（${rule.note}），这条保持为禁止。`);
      existing[rule.pattern] = false;
      continue;
    }
    if (previous === true && !rule.approve) {
      warnings.push(`原本自动批准 ${rule.pattern}（${rule.note}）的条目已被改为禁止。`);
    }
    existing[rule.pattern] = rule.approve;
  }
  return existing;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把 `chat.tools.terminal.autoApprove` 拆成 section + key。 */
export function splitSettingId(id: string): { section: string; key: string } {
  const index = id.lastIndexOf('.');
  if (index <= 0) return { section: id, key: '' };
  return { section: id.slice(0, index), key: id.slice(index + 1) };
}
