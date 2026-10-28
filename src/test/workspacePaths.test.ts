import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseProjectRoot, externalToolPathViolation, involvedProjectRoots, normalizeWorkspaceGlob, PROJECT_BADGE_LIMIT, projectNameOf, resolveWorkspacePath, rootsFromChangedFiles } from '../agent/workspacePaths';

const roots = [
  { name: 'Safevault_android', fsPath: '/Users/test/AI projects/Safevault_android' },
  { name: 'MaiKer_Win', fsPath: '/Users/test/AI projects/MaiKer_Win' },
];

/** 只把列出的路径视为存在，模拟真实文件系统探测。 */
function probe(existing: readonly string[]) {
  const set = new Set(existing);
  return (fsPath: string) => set.has(fsPath);
}

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

test('resolves a relative path that only exists in a later workspace root', () => {
  // 旧实现只把相对路径解析到第一个根目录，导致读取第二个根里的文件时抛出 ENOENT。
  const resolved = resolveWorkspacePath('src/agent/commandPaths.ts', roots, {
    exists: probe(['/Users/test/AI projects/MaiKer_Win/src/agent/commandPaths.ts']),
  });
  assert.equal(resolved.root.name, 'MaiKer_Win');
  assert.equal(resolved.fsPath, '/Users/test/AI projects/MaiKer_Win/src/agent/commandPaths.ts');
});

test('prefers the first root when the relative path exists only there', () => {
  const resolved = resolveWorkspacePath('src/index.ts', roots, {
    exists: probe(['/Users/test/AI projects/Safevault_android/src/index.ts']),
  });
  assert.equal(resolved.root.name, 'Safevault_android');
});

test('rejects a relative path that exists in several roots and asks for a prefix', () => {
  assert.throws(
    () =>
      resolveWorkspacePath('src/index.ts', roots, {
        exists: probe([
          '/Users/test/AI projects/Safevault_android/src/index.ts',
          '/Users/test/AI projects/MaiKer_Win/src/index.ts',
        ]),
      }),
    /同时存在.*Safevault_android、MaiKer_Win.*根目录名/,
  );
});

test('falls back to the first root when the path exists nowhere, so new files can be created', () => {
  const resolved = resolveWorkspacePath('src/new-file.ts', roots, { exists: probe([]) });
  assert.equal(resolved.root.name, 'Safevault_android');
  assert.equal(resolved.fsPath, '/Users/test/AI projects/Safevault_android/src/new-file.ts');
});

test('does not treat the bare workspace root as ambiguous', () => {
  const resolved = resolveWorkspacePath('.', roots, {
    exists: probe(roots.map((root) => root.fsPath)),
  });
  assert.equal(resolved.root.name, 'Safevault_android');
  assert.equal(resolved.fsPath, '/Users/test/AI projects/Safevault_android');
});

test('keeps legacy first-root behavior when no existence probe is supplied', () => {
  const resolved = resolveWorkspacePath('src/agent/commandPaths.ts', roots);
  assert.equal(resolved.root.name, 'Safevault_android');
});

test('an explicit root prefix still wins over existence probing', () => {
  const resolved = resolveWorkspacePath('MaiKer_Win/src/index.ts', roots, {
    exists: probe(['/Users/test/AI projects/Safevault_android/src/index.ts']),
  });
  assert.equal(resolved.root.name, 'MaiKer_Win');
});

// ── 项目根（preferredRoot）：对话只能落在自己的项目里 ─────────────────────

test('preferredRoot: `.` resolves to the conversation project, not the first root', () => {
  // 真实缺陷：不传 cwd 时 `'.'` 落到第一个根，于是「提交一下」提交掉了另一个项目。
  const resolved = resolveWorkspacePath('.', roots, { preferredRoot: roots[1]! });
  assert.equal(resolved.root.name, 'MaiKer_Win');
  assert.equal(resolved.fsPath, '/Users/test/AI projects/MaiKer_Win');
});

test('preferredRoot: a new file is created inside the conversation project', () => {
  const resolved = resolveWorkspacePath('src/new-file.ts', roots, {
    exists: probe([]),
    preferredRoot: roots[1]!,
  });
  assert.equal(resolved.root.name, 'MaiKer_Win');
  assert.equal(resolved.fsPath, '/Users/test/AI projects/MaiKer_Win/src/new-file.ts');
});

test('preferredRoot: a relative path existing in several roots resolves to the project', () => {
  const resolved = resolveWorkspacePath('src/index.ts', roots, {
    exists: probe([
      '/Users/test/AI projects/Safevault_android/src/index.ts',
      '/Users/test/AI projects/MaiKer_Win/src/index.ts',
    ]),
    preferredRoot: roots[1]!,
  });
  assert.equal(resolved.root.name, 'MaiKer_Win');
});

test('preferredRoot: a root that is no longer in the workspace is ignored', () => {
  const stale = { name: 'Removed', fsPath: '/Users/test/AI projects/Removed' };
  const resolved = resolveWorkspacePath('.', roots, { preferredRoot: stale });
  // 旧绑定不能让解析整体失败，退回第一个根；git 侧另有闸门会拒绝跨项目写操作。
  assert.equal(resolved.root.name, 'Safevault_android');
});

test('preferredRoot: an explicit root prefix still wins over the project root', () => {
  const resolved = resolveWorkspacePath('Safevault_android/src/index.ts', roots, {
    preferredRoot: roots[1]!,
  });
  assert.equal(resolved.root.name, 'Safevault_android');
});

// ── glob 的根目录名前缀必须与 path 参数同一套约定 ─────────────────────────
test('strips a root-name prefix from a glob and reports the matched root', () => {
  const normalized = normalizeWorkspaceGlob('MaiKer_Win/src/**/*.ts', roots);
  assert.equal(normalized.glob, 'src/**/*.ts');
  assert.equal(normalized.root?.name, 'MaiKer_Win');
});

test('leaves a glob without a root prefix untouched', () => {
  const normalized = normalizeWorkspaceGlob('src/**/*.ts', roots);
  assert.equal(normalized.glob, 'src/**/*.ts');
  assert.equal(normalized.root, undefined);
});

test('does not strip a prefix that only looks similar to a root name', () => {
  const normalized = normalizeWorkspaceGlob('MaiKer_Win_backup/src/*.ts', roots);
  assert.equal(normalized.glob, 'MaiKer_Win_backup/src/*.ts');
  assert.equal(normalized.root, undefined);
});

test('falls back to a match-everything glob when the input is empty', () => {
  assert.equal(normalizeWorkspaceGlob('   ', roots).glob, '**/*');
});

// ── 裸 `**` 必须归一：findFiles 的 include 里 `**` 匹配不到任何文件 ──────────
// 真实故障：`DeepSeek-HWChat/**` 剥掉前缀后剩 `**`，交给 findFiles 后 0 个文件，
// 工具却回答“没有匹配文件”，调用方只能误判为该目录下没有文件。
test('rewrites a bare ** left over from stripping a root prefix', () => {
  const normalized = normalizeWorkspaceGlob('MaiKer_Win/**', roots);
  assert.equal(normalized.glob, '**/*');
  assert.equal(normalized.root?.name, 'MaiKer_Win');
});

test('rewrites a bare ** even without a root prefix', () => {
  assert.equal(normalizeWorkspaceGlob('**', roots).glob, '**/*');
});

test('keeps a trailing ** that still has a directory before it', () => {
  const normalized = normalizeWorkspaceGlob('MaiKer_Win/src/**', roots);
  assert.equal(normalized.glob, 'src/**');
  assert.equal(normalized.root?.name, 'MaiKer_Win');
});

// ── 桥接工具的路径隔离 ───────────────────────────────────────────────────
// 真实缺陷：`hwchat_vscode_copilot_readFile` 传 /etc/hosts 直接返回了工作区外的
// 文件内容，`copilot_listDirectory` 传 /etc 列出了整个系统目录。原生 read_file 被
// 锁在工作区内，桥接通道却能读任何路径，两条通道安全等级不一致。
test('external tools: absolute path outside every root is rejected', () => {
  const violation = externalToolPathViolation({ filePath: '/etc/hosts' }, roots);
  assert.match(String(violation), /filePath/);
  assert.match(String(violation), /不在当前工作区内/);
});

test('external tools: absolute path inside a root is allowed', () => {
  assert.equal(
    externalToolPathViolation({ path: '/Users/test/AI projects/MaiKer_Win/src/index.ts' }, roots),
    undefined,
  );
});

test('external tools: directory traversal outside every root is rejected', () => {
  assert.match(String(externalToolPathViolation({ path: '../../../etc/passwd' }, roots)), /不在当前工作区内/);
});

test('external tools: traversal that stays inside a root is allowed', () => {
  assert.equal(externalToolPathViolation({ path: 'MaiKer_Win/src/../package.json' }, roots), undefined);
});

test('external tools: HOME reference is rejected', () => {
  assert.match(String(externalToolPathViolation({ path: '~/.zshrc' }, roots)), /HOME/);
  assert.match(String(externalToolPathViolation({ path: '$HOME/.ssh/id_rsa' }, roots)), /HOME/);
});

test('external tools: content-like arguments are not treated as paths', () => {
  // 正文里出现 /etc/passwd 是正常内容，不能误杀。
  assert.equal(
    externalToolPathViolation({ filePath: 'MaiKer_Win/notes.md', content: 'see /etc/passwd here' }, roots),
    undefined,
  );
  assert.equal(externalToolPathViolation({ command: 'cat /etc/hosts' }, roots), undefined);
});

test('external tools: path arrays are checked element by element', () => {
  assert.match(
    String(externalToolPathViolation({ files: ['MaiKer_Win/a.ts', '/etc/hosts'] }, roots)),
    /不在当前工作区内/,
  );
});

test('project root: the stored binding wins while that folder is still in the workspace', () => {
  assert.equal(
    chooseProjectRoot({ roots: roots.map((root) => root.fsPath), stored: roots[1]?.fsPath }),
    roots[1]?.fsPath,
  );
});

test('project root: an archived binding whose folder was removed is ignored', () => {
  // 工作区根被移除后，存档里还留着旧路径。必须当作没绑定，否则徽标会显示一个不存在的项目。
  assert.equal(
    chooseProjectRoot({ roots: roots.map((root) => root.fsPath), stored: '/Users/test/AI projects/Gone' }),
    undefined,
  );
});

test('project root: the active editor decides when nothing is bound yet', () => {
  assert.equal(
    chooseProjectRoot({
      roots: roots.map((root) => root.fsPath),
      activeFile: `${roots[1]?.fsPath}/src/index.ts`,
    }),
    roots[1]?.fsPath,
  );
});

test('project root: a single root needs no hint', () => {
  assert.equal(chooseProjectRoot({ roots: ['/Users/test/only'] }), '/Users/test/only');
});

test('project root: a multi-root workspace without any hint stays unbound', () => {
  // 这就是标题旁显示红色「项目待建立」的那种情况：不能猜一个目录名，
  // 因为此时 git 写操作会被拒绝，界面必须如实反映「还没归属」。
  assert.equal(chooseProjectRoot({ roots: roots.map((root) => root.fsPath) }), undefined);
});

test('project root: no workspace folders at all is unbound', () => {
  assert.equal(chooseProjectRoot({ roots: [] }), undefined);
});

test('project badge name: uses the folder name, and the filesystem root has none', () => {
  assert.equal(projectNameOf(roots[1]?.fsPath as string), 'MaiKer_Win');
  assert.equal(projectNameOf(`${roots[1]?.fsPath}/`), 'MaiKer_Win');
  assert.equal(projectNameOf(undefined), null);
  assert.equal(projectNameOf('/'), null);
});

/* ── 涉及多个项目 ─────────────────────────────────────────────── */

const many = [
  { name: 'DeepSeek-HWChat', fsPath: '/Users/test/AI projects/DeepSeek-HWChat' },
  { name: 'Local_skill_quick_access', fsPath: '/Users/test/AI projects/Local_skill_quick_access' },
  { name: 'MaiKer_Win', fsPath: '/Users/test/AI projects/MaiKer_Win' },
];

test('involved projects: primary first, then the order they were touched', () => {
  // 主项目永远是第一个：它决定相对路径和 git 写操作归谁，徽标不能把它挤到后面。
  assert.deepEqual(
    involvedProjectRoots({
      roots: many.map((root) => root.fsPath),
      primary: many[0]!.fsPath,
      touched: [many[1]!.fsPath, many[2]!.fsPath],
    }),
    [many[0]!.fsPath, many[1]!.fsPath, many[2]!.fsPath],
  );
});

test('involved projects: the primary is not repeated when it is also in touched', () => {
  assert.deepEqual(
    involvedProjectRoots({
      roots: many.map((root) => root.fsPath),
      primary: many[0]!.fsPath,
      touched: [many[0]!.fsPath, many[1]!.fsPath, many[1]!.fsPath],
    }),
    [many[0]!.fsPath, many[1]!.fsPath],
  );
});

test('involved projects: roots that are no longer in the workspace are dropped', () => {
  // 工作区根被移除之后，存档里的旧路径不能凭空变成徽标上的一个项目。
  assert.deepEqual(
    involvedProjectRoots({
      roots: many.map((root) => root.fsPath),
      primary: '/Users/test/AI projects/Deleted',
      touched: ['/Users/test/AI projects/Deleted', many[2]!.fsPath],
    }),
    [many[2]!.fsPath],
  );
});

test('involved projects: an unbound conversation with no history shows nothing', () => {
  assert.deepEqual(involvedProjectRoots({ roots: many.map((root) => root.fsPath) }), []);
});

test('involved projects: the badge list is capped, primary still first', () => {
  const paths = Array.from({ length: PROJECT_BADGE_LIMIT + 3 }, (_value, index) => `/Users/test/AI projects/P${index}`);
  const list = involvedProjectRoots({
    roots: paths,
    primary: paths[0],
    touched: paths.slice(1),
  });
  assert.equal(list.length, PROJECT_BADGE_LIMIT);
  assert.equal(list[0], paths[0]);
});

test('involved projects: single-root workspaces never derive from changed files', () => {
  // 单根工作区里 `asRelativePath` 不带文件夹名前缀，前缀匹配会把文件名当项目名。
  assert.deepEqual(rootsFromChangedFiles({ roots: [many[0] as { name: string; fsPath: string }], files: ['src/a.ts'] }), []);
});

test('involved projects: legacy conversations recover projects from changed-file prefixes', () => {
  // 升级前的对话没有 `projectRoots` 字段，但 `changedFiles` 里带着根目录名前缀。
  assert.deepEqual(
    rootsFromChangedFiles({
      roots: many,
      files: [
        'DeepSeek-HWChat/src/views/chatPanel.ts',
        'Local_skill_quick_access/CHANGELOG.md',
        'DeepSeek-HWChat/src/core/types.ts',
      ],
    }),
    [many[0]!.fsPath, many[1]!.fsPath],
  );
});

test('involved projects: a file name equal to a project name is not a project', () => {
  // 无扩展名的文件 `DeepSeek-HWChat` 的第一段恰好等于文件夹名，但后面没有分隔符。
  assert.deepEqual(rootsFromChangedFiles({ roots: many, files: ['DeepSeek-HWChat'] }), []);
  // 名字相近的项目不能被当成同一个。
  assert.deepEqual(rootsFromChangedFiles({ roots: many, files: ['DeepSeek-HWChat-older/src/a.ts'] }), []);
  // 绝对路径不参与推断。
  assert.deepEqual(rootsFromChangedFiles({ roots: many, files: ['/Users/test/AI projects/MaiKer_Win/src/a.ts'] }), []);
});
