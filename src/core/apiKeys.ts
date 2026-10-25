import * as vscode from 'vscode';

const LEGACY_KEY = 'hwchat.apiKey';

export function apiKeyStorageKey(profileId: string): string {
  return `hwchat.apiKey.${profileId}`;
}

export async function getApiKey(
  secrets: vscode.SecretStorage,
  profileId: string,
  allowLegacyFallback = false,
): Promise<string | undefined> {
  const value = await secrets.get(apiKeyStorageKey(profileId));
  if (value || !allowLegacyFallback) return value;
  return secrets.get(LEGACY_KEY);
}

export async function storeApiKey(
  secrets: vscode.SecretStorage,
  profileId: string,
  value: string,
): Promise<void> {
  await secrets.store(apiKeyStorageKey(profileId), value.trim());
  if (profileId === 'default') await secrets.delete(LEGACY_KEY);
}

export async function deleteApiKey(
  secrets: vscode.SecretStorage,
  profileId: string,
): Promise<void> {
  await secrets.delete(apiKeyStorageKey(profileId));
  if (profileId === 'default') await secrets.delete(LEGACY_KEY);
}

export async function hasApiKey(
  secrets: vscode.SecretStorage,
  profileId: string,
  allowLegacyFallback = false,
): Promise<boolean> {
  return Boolean(await getApiKey(secrets, profileId, allowLegacyFallback));
}
