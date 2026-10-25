import { dirname } from 'node:path';
import { access, mkdir, readFile, rename, copyFile, unlink, writeFile } from 'node:fs/promises';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Writes JSON with a same-directory temp file and a recoverable backup. */
export async function writeJsonAtomic<T>(filePath: string, value: T, backupCurrent = true): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backupPath = `${filePath}.bak`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, payload, 'utf8');
  if (backupCurrent && await exists(filePath)) {
    await copyFile(filePath, backupPath).catch(() => undefined);
  }
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(code) || !await exists(filePath)) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    const replacedPath = `${filePath}.${process.pid}.${Date.now()}.replaced`;
    await rename(filePath, replacedPath);
    try {
      await rename(tempPath, filePath);
      await unlink(replacedPath).catch(() => undefined);
    } catch (replaceError) {
      await rename(replacedPath, filePath).catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw replaceError;
    }
  }
}

export async function readJsonWithBackup<T>(filePath: string): Promise<T | undefined> {
  for (const candidate of [filePath, `${filePath}.bak`]) {
    try {
      const value = JSON.parse(await readFile(candidate, 'utf8')) as T;
      if (candidate.endsWith('.bak')) {
        await writeJsonAtomic(filePath, value, false).catch(() => undefined);
      }
      return value;
    } catch {
      // A partial write or an interrupted upgrade should not make history vanish.
    }
  }
  return undefined;
}

export async function removeIfPresent(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => undefined);
}
