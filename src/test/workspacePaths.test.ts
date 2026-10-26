import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkspacePath } from '../agent/workspacePaths';

const roots = [
  { name: 'Safevault_android', fsPath: '/Users/test/AI projects/Safevault_android' },
  { name: 'MaiKer_Win', fsPath: '/Users/test/AI projects/MaiKer_Win' },
];

test('resolves absolute files inside any VS Code workspace root', () => {
  const resolved = resolveWorkspacePath('/Users/test/AI projects/MaiKer_Win/docs/TECHNICAL.md', roots);
  assert.equal(resolved.root.name, 'MaiKer_Win');
  assert.equal(resolved.fsPath, '/Users/test/AI projects/MaiKer_Win/docs/TECHNICAL.md');
});

test('resolves paths prefixed by a multi-root workspace folder name', () => {
  const resolved = resolveWorkspacePath('MaiKer_Win/docs/TECHNICAL.md', roots);
  assert.equal(resolved.root.name, 'MaiKer_Win');
  assert.equal(resolved.fsPath, '/Users/test/AI projects/MaiKer_Win/docs/TECHNICAL.md');
});

test('rejects paths outside all workspace roots', () => {
  assert.throws(
    () => resolveWorkspacePath('/Users/test/Documents/private.txt', roots),
    /当前 VS Code 工作区内/,
  );
});
