import * as vscode from 'vscode';

const LEGACY_KEY = 'hwchat.apiKey';

export function apiKeyStorageKey(profileId: string): string {
  return `hwchat.apiKey.${profileId}`;
}

/**
 * 语义检索（向量）用的**独立**密钥。
 *
 * 为什么单独存（用户 2026-11-07 的反馈：「也没看到向量 key 输入框」）：
 * 向量接口常常不是同一个账号 —— 聊天用 DeepSeek（没有 embeddings），向量用
 * holysheep / 智谱。让用户把两个 Key 挤在同一个配置档里既做不到也不安全。
 * 所以这里给「向量」单独一把 Key，按配置档 id 分开存。
 */
export function embeddingKeyStorageKey(profileId: string): string {
  return `hwchat.embeddingKey.${profileId}`;
}

export async function getEmbeddingKey(secrets: vscode.SecretStorage, profileId: string): Promise<string | undefined> {
  const value = await secrets.get(embeddingKeyStorageKey(profileId));
  return value?.trim() || undefined;
}

export async function storeEmbeddingKey(secrets: vscode.SecretStorage, profileId: string, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    await secrets.delete(embeddingKeyStorageKey(profileId));
    return;
  }
  await secrets.store(embeddingKeyStorageKey(profileId), trimmed);
}

export async function hasEmbeddingKey(secrets: vscode.SecretStorage, profileId: string): Promise<boolean> {
  return Boolean(await getEmbeddingKey(secrets, profileId));
}

/**
 * 取「该用哪把 Key 算向量」：先看专用 Key，再退回该配置档的聊天 Key。
 *
 * 退回是合理的默认（智谱这类同一个 Key 既能聊天也能算向量）；但专用 Key 优先，
 * 这样「聊天用 DeepSeek、向量用 holysheep」也能配得出来。
 */
export async function resolveEmbeddingKey(secrets: vscode.SecretStorage, profileId: string): Promise<string | undefined> {
  return (await getEmbeddingKey(secrets, profileId))
    ?? (await getApiKey(secrets, profileId, profileId === 'default'));
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
