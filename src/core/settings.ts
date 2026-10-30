import * as vscode from 'vscode';
import { ApiProfile, ChatSettings, PermissionPreset, ReasoningEffort } from './types';
import { PERMISSION_PRESET_PROFILES, DEFAULT_PERMISSION_PRESET } from './permissions';
import { LanguageSetting, normalizeLanguageSetting } from './i18n';
import { resolveConversationMode } from './modes';
import { normalizeAgentMaxSteps, DEFAULT_AGENT_MAX_STEPS } from './agentLimits';

const SECTION = 'hwchat';

/**
 * 新对话的默认思考深度：`default` = 不发送任何思考参数。
 *
 * 用户要求「按模型官方思考深度设置」：不同模型（以及同一模型的不同版本）官方默认档
 * 并不相同，DeepSeek 服务端在未指定时按模型自己的默认值处理，OpenAI 兼容端点同理。
 * 由我们猜一个 `high` 发出去，等于替模型改默认值，还会多烧 token。
 * 所以初始值固定为 `default`；想更深/更浅由用户在工具条上显式选四档深度之一。
 *
 * 与 `package.json` 里 `hwchat.reasoningEffort` 的 default 必须一致（有测试钉住）。
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'default';

export function readSettings(): ChatSettings {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const legacyBaseUrl = configuration.get<string>('baseUrl', 'https://api.deepseek.com');
  const legacyModel = configuration.get<string>('model', 'deepseek-flash');
  const legacyHeaders = configuration.get<Record<string, string>>('requestHeaders', {});
  const apiProfiles = normalizeProfiles(configuration.get<unknown>('apiProfiles'), {
    id: 'default',
    name: 'DeepSeek',
    baseUrl: legacyBaseUrl,
    models: uniqueStrings([legacyModel, 'deepseek-flash', 'deepseek-v4-pro']),
    excludedModels: [],
    requestHeaders: legacyHeaders,
  });
  const configuredProfileId = configuration.get<string>('activeApiProfileId', apiProfiles[0]!.id);
  const activeProfile = apiProfiles.find((profile) => profile.id === configuredProfileId) ?? apiProfiles[0]!;
  // 权限预设 / 最大步数 / 思考深度这三项**归属于每一条对话**，不再从配置读取：
  // 新对话一律从固定的最保守初始值开始（每次询问 / 24 步 / 模型官方思考默认），
  // 需要调整只能在某条对话的工具条上显式改，改完随该对话存档。
  //
  // 为什么连配置都不读（真实故障）：旧版本会把面板上的选择写进 `hwchat.*`，
  // 用户设置里因此留下了 `permissionPreset: autopilot`、`agentMaxSteps: 0`；
  // 之后每一条新对话一开就自动执行、无限步，与「每次询问 / 24 步」完全相反。
  // 声明值仍由 `describePermissionScope()` 如实汇报（便于对账），但不参与判定。
  const permissionPreset = DEFAULT_PERMISSION_PRESET;
  const permission = resolvePermissionPreset(permissionPreset);
  return {
    apiProfiles,
    activeApiProfileId: activeProfile.id,
    baseUrl: activeProfile.baseUrl,
    model: legacyModel || activeProfile.models[0] || 'deepseek-flash',
    temperature: clamp(configuration.get<number>('temperature', 1), 0, 2),
    maxTokens: Math.max(0, configuration.get<number>('maxTokens', 0)),
    systemPrompt: configuration.get<string>('systemPrompt', ''),
    sendOnEnter: configuration.get<boolean>('sendOnEnter', true),
    historyRetentionDays: Math.max(0, configuration.get<number>('historyRetentionDays', 30)),
    taskCacheRetentionHours: Math.max(0, configuration.get<number>('taskCacheRetentionHours', 24)),
    cacheBudgetMB: Math.max(5, configuration.get<number>('cacheBudgetMB', 100)),
    cleanupIntervalMinutes: Math.max(1, configuration.get<number>('cleanupIntervalMinutes', 10)),
    maxMessagesInContext: Math.max(0, configuration.get<number>('maxMessagesInContext', 20)),
    requestHeaders: activeProfile.requestHeaders,
    requestTimeoutSeconds: clamp(configuration.get<number>('requestTimeoutSeconds', 120), 10, 900),
    defaultMode: resolveConversationMode(configuration.get<unknown>('defaultMode'), 'agent'),
    agentMaxSteps: DEFAULT_AGENT_MAX_STEPS,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    permissionPreset,
    // 只由对话自己的存档打开（见 applyRuntimeControls）。没有全局开关：
    // 联网会把内容发给第三方检索服务，不能靠一个会被历史残留影响的设置项决定。
    internetReference: false,
    ...permission,
    maxReadBytes: clamp(configuration.get<number>('maxReadBytes', 512_000), 16_384, 5_242_880),
    maxToolOutputBytes: clamp(configuration.get<number>('maxToolOutputBytes', 200_000), 16_384, 2_097_152),
    maxCommandSeconds: clamp(configuration.get<number>('maxCommandSeconds', 120), 5, 900),
    auditRetentionDays: clamp(configuration.get<number>('auditRetentionDays', 30), 0, 365),
    language: normalizeLanguageSetting(configuration.get<unknown>('language', 'auto')),
  };
}

export async function updateSettings(values: Partial<ChatSettings>): Promise<void> {
  const entries: Array<[keyof ChatSettings, unknown]> = [
    ['apiProfiles', values.apiProfiles],
    ['activeApiProfileId', values.activeApiProfileId],
    ['baseUrl', values.baseUrl],
    ['model', values.model],
    ['temperature', values.temperature],
    ['maxTokens', values.maxTokens],
    ['systemPrompt', values.systemPrompt],
    ['sendOnEnter', values.sendOnEnter],
    ['historyRetentionDays', values.historyRetentionDays],
    ['taskCacheRetentionHours', values.taskCacheRetentionHours],
    ['cacheBudgetMB', values.cacheBudgetMB],
    ['cleanupIntervalMinutes', values.cleanupIntervalMinutes],
    ['maxMessagesInContext', values.maxMessagesInContext],
    ['requestHeaders', values.requestHeaders],
    ['requestTimeoutSeconds', values.requestTimeoutSeconds],
    ['defaultMode', values.defaultMode],
    // 权限预设 / 最大步数 / 思考深度**不写配置**：它们属于对话，随对话存档。
    // 旧实现写全局设置，于是「在 A 对话放宽权限」会连带影响所有新对话。
    // 五项单项策略（fileReadPolicy / commandPolicy / dangerousCommandPolicy …）
    // 已废弃：权限完全由预设推导。它们仍出现在 `contributes.configuration` 里，
    // 只为让老用户的 settings.json 不报「未知配置项」，并带 deprecationMessage
    // 说明已失效。这里**不再写回**——旧实现每次保存设置都会把预设推导出的值
    // 写进用户设置，留下一条看起来能生效、实际被忽略的配置，正是「日志里写着
    // allow、实际情况另有来源」那种混淆的来源。读取侧也从不使用它们。
    ['maxReadBytes', values.maxReadBytes],
    ['maxToolOutputBytes', values.maxToolOutputBytes],
    ['maxCommandSeconds', values.maxCommandSeconds],
    ['auditRetentionDays', values.auditRetentionDays],
    ['language', values.language === undefined ? undefined : normalizeLanguageSetting(values.language)],
  ];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    // 写回“已经定义该键的最近一层作用域”。此前固定写 Global，一旦用户在
    // settings.json（.code-workspace 或某个文件夹的 .vscode/settings.json）里
    // 出现过 hwchat.*，面板里的修改就会被更高优先级的作用域覆盖，表现为
    // “预设改了但没生效”。多根工作区里每个文件夹要分别带资源 URI 才能判断。
    const plan = updatePlan(key);
    for (const step of plan) {
      await step.configuration.update(key, value, step.target);
    }
  }
}

export interface PermissionScopeEntry {
  key: string;
  resolved: string;
  folders: Array<{ name: string; value?: string }>;
  workspaceValue?: string;
  globalValue?: string;
  defaultValue?: string;
}

export interface PermissionScopeReport {
  preset: PermissionPreset;
  entries: PermissionScopeEntry[];
}

const PERMISSION_SCOPE_KEYS = [
  'permissionPreset',
  'fileReadPolicy',
  'fileWritePolicy',
  'commandPolicy',
  'dangerousCommandPolicy',
  'sensitiveFilePolicy',
] as const;

/**
 * 汇报权限相关配置的**声明值**与**实际生效值**。
 *
 * 这几项已不再参与判定：新对话固定从「每次询问」开始，之后按对话单独调整并存档。
 * 这里仍然把每一层的声明原样摊开，原因是排障时最常见的困惑就是「我明明在
 * settings.json 写了 autopilot，为什么没生效」——报告要能直接回答：它确实被读到了，
 * 但按新规则不生效（通常是旧版本自动写入的残留）。
 */
export function describePermissionScope(): PermissionScopeReport {
  const settings = readSettings();
  const entries = PERMISSION_SCOPE_KEYS.map((key) => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => {
      const inspected = vscode.workspace.getConfiguration(SECTION, folder.uri).inspect<unknown>(key);
      return { name: folder.name, value: stringifyScopeValue(inspected?.workspaceFolderValue) };
    });
    const inspected = vscode.workspace.getConfiguration(SECTION).inspect<unknown>(key);
    return {
      key,
      resolved: String(settings[key]),
      folders,
      workspaceValue: stringifyScopeValue(inspected?.workspaceValue),
      globalValue: stringifyScopeValue(inspected?.globalValue),
      defaultValue: stringifyScopeValue(inspected?.defaultValue),
    };
  });
  return { preset: settings.permissionPreset, entries };
}

/** 把报告压成几行文本，供日志与通知使用。 */
export function formatPermissionScope(report: PermissionScopeReport): string[] {
  const lines = [
    `权限预设：${report.preset}（新对话固定值；声明值不参与判定，按对话调整）`,
  ];
  for (const entry of report.entries) {
    const declared = entry.folders
      .filter((folder) => folder.value !== undefined)
      .map((folder) => `${folder.name}=${folder.value}`);
    lines.push(
      `${entry.key} → ${entry.resolved}｜文件夹: ${declared.length ? declared.join(', ') : '无'}`
        + `｜工作区: ${entry.workspaceValue ?? '无'}｜用户: ${entry.globalValue ?? '无'}`
        + `｜默认: ${entry.defaultValue ?? '无'}`,
    );
  }
  return lines;
}

function stringifyScopeValue(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

/**
 * 决定一次修改应该写到哪些层。规则是“写回它已经被定义的地方”：
 * 1. 任何在 .vscode/settings.json 里显式设置过该键的文件夹 → 写该文件夹；
 * 2. 否则如果 .code-workspace 里设置过 → 写工作区层；
 * 3. 否则仍然写全局，避免把默认值意外固化成某个工作区的设置。
 */
function updatePlan(key: string): Array<{
  configuration: vscode.WorkspaceConfiguration;
  target: vscode.ConfigurationTarget;
}> {
  const folderPlan = (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => ({
      configuration: vscode.workspace.getConfiguration(SECTION, folder.uri),
      target: vscode.ConfigurationTarget.WorkspaceFolder,
    }))
    .filter((step) => step.configuration.inspect(key)?.workspaceFolderValue !== undefined);
  if (folderPlan.length) return folderPlan;

  const configuration = vscode.workspace.getConfiguration(SECTION);
  return [{
    configuration,
    target: configuration.inspect(key)?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global,
  }];
}

export function profileFor(settings: ChatSettings, profileId?: string): ApiProfile {
  return settings.apiProfiles.find((profile) => profile.id === profileId)
    ?? settings.apiProfiles.find((profile) => profile.id === settings.activeApiProfileId)
    ?? settings.apiProfiles[0]!;
}

function normalizeProfiles(value: unknown, fallback: ApiProfile): ApiProfile[] {
  if (!Array.isArray(value)) return [fallback];
  const profiles: ApiProfile[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const raw = candidate as Partial<ApiProfile>;
    const id = cleanId(raw.id);
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '';
    if (!id || ids.has(id) || !baseUrl) continue;
    ids.add(id);
    profiles.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : id,
      baseUrl,
      models: uniqueStrings(Array.isArray(raw.models) ? raw.models : []).slice(0, 500),
      excludedModels: uniqueStrings(Array.isArray(raw.excludedModels) ? raw.excludedModels : []).slice(0, 500),
      requestHeaders: stringRecord(raw.requestHeaders),
    });
  }
  return profiles.length ? profiles : [fallback];
}

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return value === 'askAll' || value === 'review' || value === 'autopilot' || value === 'full';
}

export function normalizePermissionPreset(value: unknown): PermissionPreset {
  return isPermissionPreset(value) ? value : DEFAULT_PERMISSION_PRESET;
}

export function applyRuntimeControls(
  settings: ChatSettings,
  permissionPreset?: unknown,
  agentMaxSteps?: unknown,
  /**
   * 互联网参考（按对话）。只有布尔 `true` 会打开；其余一切（含 undefined、
   * 字符串 "true"、1）都按关闭处理——这一项的方向是「读不懂就不联网」。
   */
  internetReference?: unknown,
): ChatSettings {
  const nextPreset = permissionPreset === undefined
    ? settings.permissionPreset
    : normalizePermissionPreset(permissionPreset);
  const permission = resolvePermissionPreset(nextPreset);
  return {
    ...settings,
    agentMaxSteps: agentMaxSteps === undefined ? settings.agentMaxSteps : normalizeAgentMaxSteps(agentMaxSteps),
    permissionPreset: nextPreset,
    internetReference: internetReference === true,
    ...permission,
  };
}

export function normalizeGuardedPolicy(value: unknown, fallback: ChatSettings['dangerousCommandPolicy'] = 'deny'): ChatSettings['dangerousCommandPolicy'] {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : fallback;
}

function resolvePermissionPreset(
  preset: PermissionPreset,
): Pick<ChatSettings, 'fileReadPolicy' | 'fileWritePolicy' | 'commandPolicy' | 'dangerousCommandPolicy' | 'sensitiveFilePolicy'> {
  const profile = PERMISSION_PRESET_PROFILES[preset];
  return {
    fileReadPolicy: profile.fileReadPolicy,
    fileWritePolicy: profile.fileWritePolicy,
    commandPolicy: profile.commandPolicy,
    dangerousCommandPolicy: profile.dangerousCommandPolicy,
    sensitiveFilePolicy: profile.sensitiveFilePolicy,
  };
}

// 预算规则放在 vscode-free 的 agentLimits 里，存储层要用同一份规则清洗历史存档；
// 这里重新导出，保持 `settings` 作为设置相关函数的统一入口。
export {
  AGENT_MAX_STEPS_UNLIMITED,
  AGENT_STEP_PRESETS,
  AGENT_STEP_SAFETY_CAP,
  DEFAULT_AGENT_MAX_STEPS,
  MAX_TOOL_CALLS_PER_RUN,
  agentStepBudget,
  isUnlimitedSteps,
  normalizeAgentMaxSteps,
} from './agentLimits';

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'max'
    ? value
    : 'default';
}

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) : '';
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
