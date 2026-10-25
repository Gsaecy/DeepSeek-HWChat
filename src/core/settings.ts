import * as vscode from 'vscode';
import { ApiProfile, ChatSettings, PermissionPreset, ReasoningEffort } from './types';

const SECTION = 'hwchat';

export function readSettings(): ChatSettings {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const legacyBaseUrl = configuration.get<string>('baseUrl', 'https://api.deepseek.com');
  const legacyModel = configuration.get<string>('model', 'deepseek-chat');
  const legacyHeaders = configuration.get<Record<string, string>>('requestHeaders', {});
  const apiProfiles = normalizeProfiles(configuration.get<unknown>('apiProfiles'), {
    id: 'default',
    name: 'DeepSeek',
    baseUrl: legacyBaseUrl,
    models: uniqueStrings([legacyModel, 'deepseek-chat', 'deepseek-reasoner']),
    requestHeaders: legacyHeaders,
  });
  const configuredProfileId = configuration.get<string>('activeApiProfileId', apiProfiles[0]!.id);
  const activeProfile = apiProfiles.find((profile) => profile.id === configuredProfileId) ?? apiProfiles[0]!;
  const permissionPreset = normalizePermissionPreset(configuration.get<string>('permissionPreset', 'review'));
  const permission = resolvePermissionPreset(permissionPreset, {
    fileReadPolicy: configuration.get<ChatSettings['fileReadPolicy']>('fileReadPolicy', 'allow'),
    fileWritePolicy: configuration.get<ChatSettings['fileWritePolicy']>('fileWritePolicy', 'ask'),
    commandPolicy: configuration.get<ChatSettings['commandPolicy']>('commandPolicy', 'ask'),
    allowSensitiveFiles: configuration.get<boolean>('allowSensitiveFiles', false),
    allowDangerousCommands: configuration.get<boolean>('allowDangerousCommands', false),
  });
  return {
    apiProfiles,
    activeApiProfileId: activeProfile.id,
    baseUrl: activeProfile.baseUrl,
    model: legacyModel || activeProfile.models[0] || 'deepseek-chat',
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
    reasoningEffort: normalizeReasoningEffort(configuration.get<string>('reasoningEffort', 'default')),
    permissionPreset,
    ...permission,
    maxReadBytes: clamp(configuration.get<number>('maxReadBytes', 512_000), 16_384, 5_242_880),
    maxToolOutputBytes: clamp(configuration.get<number>('maxToolOutputBytes', 200_000), 16_384, 2_097_152),
    maxCommandSeconds: clamp(configuration.get<number>('maxCommandSeconds', 120), 5, 900),
    auditRetentionDays: clamp(configuration.get<number>('auditRetentionDays', 30), 0, 365),
  };
}

export async function updateSettings(values: Partial<ChatSettings>): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(SECTION);
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
    ['allowSensitiveFiles', values.allowSensitiveFiles],
    ['allowDangerousCommands', values.allowDangerousCommands],
    ['maxReadBytes', values.maxReadBytes],
    ['maxToolOutputBytes', values.maxToolOutputBytes],
    ['maxCommandSeconds', values.maxCommandSeconds],
    ['auditRetentionDays', values.auditRetentionDays],
  ];
  for (const [key, value] of entries) {
    if (value !== undefined) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }
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
      requestHeaders: stringRecord(raw.requestHeaders),
    });
  }
  return profiles.length ? profiles : [fallback];
}

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return value === 'askAll' || value === 'review' || value === 'autopilot' || value === 'full' || value === 'custom';
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
  const permission = resolvePermissionPreset(nextPreset, settings);
  return {
    ...settings,
    agentMaxSteps: agentMaxSteps === undefined ? settings.agentMaxSteps : normalizeAgentMaxSteps(agentMaxSteps),
    permissionPreset: nextPreset,
    ...permission,
  };
}

function resolvePermissionPreset(
  preset: PermissionPreset,
  custom: Pick<ChatSettings, 'fileReadPolicy' | 'fileWritePolicy' | 'commandPolicy' | 'allowSensitiveFiles' | 'allowDangerousCommands'>,
): typeof custom {
  if (preset === 'askAll') {
    return { fileReadPolicy: 'ask', fileWritePolicy: 'ask', commandPolicy: 'ask', allowSensitiveFiles: false, allowDangerousCommands: false };
  }
  if (preset === 'review') {
    return { fileReadPolicy: 'allow', fileWritePolicy: 'ask', commandPolicy: 'ask', allowSensitiveFiles: false, allowDangerousCommands: false };
  }
  if (preset === 'autopilot') {
    return { fileReadPolicy: 'allow', fileWritePolicy: 'allow', commandPolicy: 'allow', allowSensitiveFiles: false, allowDangerousCommands: false };
  }
  if (preset === 'full') {
    return { fileReadPolicy: 'allow', fileWritePolicy: 'allow', commandPolicy: 'allow', allowSensitiveFiles: true, allowDangerousCommands: true };
  }
  return custom;
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
