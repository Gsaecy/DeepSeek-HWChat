import * as vscode from 'vscode';
import { ApiProfile, ChatSettings, PermissionPreset, ReasoningEffort } from './types';
import { PERMISSION_PRESET_PROFILES } from './permissions';
import { LanguageSetting, normalizeLanguageSetting } from './i18n';

const SECTION = 'hwchat';
const REASONING_FALLBACK_KEY = 'settings.reasoningEffort';

// A VS Code window can keep the previous contribution registry alive for a
// short time after an extension upgrade. Keep the composer controls usable in
// that window while still mirroring the value to the normal configuration.
let fallbackState: vscode.Memento | undefined;

export function initializeSettingsStorage(state: vscode.Memento): void {
  fallbackState = state;
}

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
  // 权限类设置必须走 resolveScopedPermissionValue：多根工作区里无 resource 的
  // getConfiguration 读不到各文件夹 .vscode/settings.json，会让写进去的预设失效。
  // 五项具体策略完全由预设推导，不再读取单项策略列——自定义档位移除后它们
  // 已无判定作用，继续读取只会造成“设置里写着禁止、实际按预设放行”的错觉。
  const permissionPreset = resolvePermissionPresetValue();
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
    defaultMode: configuration.get<ChatSettings['defaultMode']>('defaultMode', 'agent'),
    agentMaxSteps: normalizeAgentMaxSteps(configuration.get<number>('agentMaxSteps', 0)),
    reasoningEffort: readReasoningEffort(configuration),
    permissionPreset,
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
    ['agentMaxSteps', values.agentMaxSteps],
    ['reasoningEffort', values.reasoningEffort],
    ['permissionPreset', values.permissionPreset],
    ['fileReadPolicy', values.fileReadPolicy],
    ['fileWritePolicy', values.fileWritePolicy],
    ['commandPolicy', values.commandPolicy],
    ['dangerousCommandPolicy', values.dangerousCommandPolicy],
    ['sensitiveFilePolicy', values.sensitiveFilePolicy],
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
    if (key === 'reasoningEffort') {
      const normalized = normalizeReasoningEffort(value);
      await fallbackState?.update(REASONING_FALLBACK_KEY, normalized);
      for (const step of plan) {
        try {
          await step.configuration.update(key, normalized, step.target);
        } catch (error) {
          if (!isUnregisteredConfigurationError(error)) {
            throw error;
          }
        }
      }
      continue;
    }
    for (const step of plan) {
      await step.configuration.update(key, value, step.target);
    }
  }
}

/** 权限取值越“严格”数值越大：多处同级声明冲突时取最严格的一个。 */
const PRESET_RESTRICTIVENESS: Record<PermissionPreset, number> = {
  full: 0,
  autopilot: 1,
  review: 2,
  askAll: 3,
};

/**
 * 权限类设置的作用域解析。
 *
 * VS Code 的合并视图只有在传入 resource 时才会应用 `workspaceFolderValue`
 * （vscode.d.ts 明确写着它来自“请求的资源所属的工作区文件夹”）。多根工作区里
 * `getConfiguration(section)` 不传资源，各文件夹的 `.vscode/settings.json`
 * 就完全读不到——用户按文档在某个根写了 `"hwchat.permissionPreset": "review"`，
 * 实际仍在用户设置的 autopilot 下运行，危险命令不会弹确认。
 *
 * 这里显式按“最具体优先”解析，同级冲突时取最严格的一个：
 *   1. 各工作区文件夹里的显式值（最具体）
 *   2. .code-workspace / 工作区设置
 *   3. 用户设置
 * 全部未设置时返回 undefined，由调用方套默认值。
 */
function resolveScopedPermissionValue<T>(
  key: string,
  isValid: (value: unknown) => value is T,
  strictest: (values: readonly T[]) => T,
): T | undefined {
  const folderValues: T[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const value = vscode.workspace.getConfiguration(SECTION, folder.uri).inspect<unknown>(key)?.workspaceFolderValue;
    if (isValid(value)) folderValues.push(value);
  }
  if (folderValues.length) return strictest(folderValues);

  const inspected = vscode.workspace.getConfiguration(SECTION).inspect<unknown>(key);
  const workspaceValue = inspected?.workspaceValue;
  if (isValid(workspaceValue)) return workspaceValue;
  const globalValue = inspected?.globalValue;
  if (isValid(globalValue)) return globalValue;
  return undefined;
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
 * 解释“生效的权限值来自哪一层”。多根工作区里权限失效最常见的原因就是文件夹级
 * 声明没被读到，这个报告把每一层的原始值都摊开，便于用户和日志直接对账。
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
  const lines = [`权限预设：${report.preset}`];
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

function strictestOf<T>(values: readonly T[], rank: (value: T) => number): T {
  return values.reduce((best, candidate) => (rank(candidate) > rank(best) ? candidate : best));
}

function resolvePermissionPresetValue(): PermissionPreset {
  const explicit = resolveScopedPermissionValue(
    'permissionPreset',
    isPermissionPreset,
    (values) => strictestOf(values, (value) => PRESET_RESTRICTIVENESS[value]),
  );
  return normalizePermissionPreset(explicit ?? 'review');
}

function readReasoningEffort(configuration: vscode.WorkspaceConfiguration): ReasoningEffort {
  const inspection = configuration.inspect<string>('reasoningEffort');
  const explicitValue = inspection?.workspaceFolderValue
    ?? inspection?.workspaceValue
    ?? inspection?.globalValue;
  const fallbackValue = fallbackState?.get<string>(REASONING_FALLBACK_KEY);
  return normalizeReasoningEffort(explicitValue ?? fallbackValue ?? inspection?.defaultValue ?? 'default');
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

function isUnregisteredConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a registered configuration|没有注册配置|未注册配置|configuration.*registered/i.test(message);
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
  return isPermissionPreset(value) ? value : 'review';
}

export function applyRuntimeControls(
  settings: ChatSettings,
  permissionPreset?: unknown,
  agentMaxSteps?: unknown,
): ChatSettings {
  const nextPreset = permissionPreset === undefined
    ? settings.permissionPreset
    : normalizePermissionPreset(permissionPreset);
  const permission = resolvePermissionPreset(nextPreset);
  return {
    ...settings,
    agentMaxSteps: agentMaxSteps === undefined ? settings.agentMaxSteps : normalizeAgentMaxSteps(agentMaxSteps),
    permissionPreset: nextPreset,
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

export function normalizeAgentMaxSteps(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return value === 'none' || value === 'low' || value === 'high' || value === 'max'
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
