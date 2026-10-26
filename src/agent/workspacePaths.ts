import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export interface WorkspaceRootLike {
  name: string;
  fsPath: string;
}

export interface ResolvedWorkspacePath<T extends WorkspaceRootLike = WorkspaceRootLike> {
  root: T;
  fsPath: string;
}

export function resolveWorkspacePath<T extends WorkspaceRootLike>(input: string, roots: readonly T[]): ResolvedWorkspacePath<T> {
  if (!roots.length) throw new Error('当前没有打开的工作区。');
  const value = input?.trim() || '.';
  const absoluteCandidate = isAbsolute(value) ? resolve(value) : undefined;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');

  if (!absoluteCandidate && roots.length > 1) {
    for (const root of roots) {
      const selectedPath = workspaceRootSelector(normalized, root);
      if (selectedPath === undefined) continue;
      const rootPath = resolve(root.fsPath);
      const candidate = resolve(rootPath, selectedPath || '.');
      if (isPathWithin(rootPath, candidate)) return { root, fsPath: candidate };
    }
  }

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]!;
    const rootPath = resolve(root.fsPath);
    let relativeInput = value;
    if (!absoluteCandidate && index > 0) continue;
    const candidate = absoluteCandidate ?? resolve(rootPath, relativeInput);
    if (isPathWithin(rootPath, candidate)) return { root, fsPath: candidate };
  }
  throw new Error('路径必须位于当前 VS Code 工作区内。');
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function workspaceRootSelector(input: string, root: WorkspaceRootLike): string | undefined {
  const selectors = [...new Set([root.name.trim(), basename(root.fsPath).trim()].filter(Boolean))];
  for (const selector of selectors) {
    if (input === selector) return '';
    if (input.startsWith(`${selector}/`)) return input.slice(selector.length + 1);
  }
  return undefined;
}
