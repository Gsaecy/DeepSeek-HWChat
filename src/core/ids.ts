import { randomUUID } from 'node:crypto';

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function createOrderedId(prefix: string, timestamp: number): string {
  return `${prefix}_${String(timestamp).padStart(13, '0')}_${randomUUID()}`;
}

import { clipText } from './textSafety';

export function shortTitle(value: string, fallback = '新对话'): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > 48 ? `${clipText(normalized, 47)}…` : normalized;
}

export function previewText(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${clipText(normalized, maxLength - 1)}…` : normalized;
}
