import assert from 'node:assert/strict';
import test from 'node:test';
import {
  argumentsMentionVersionBump,
  detectVersionBump,
  hasSkillVersionRule,
  hasVersionBumpIntent,
  isVersionManifest,
  projectVersionOf,
  versionBumpAuthorization,
  versionBumpCommand,
  VERSION_RULE_PROMPT,
} from '../agent/releasePolicy';

// ── 文件侧：项目版本号是否被改动 ──────────────────────────────────────────

const pkg = (version: string): string => JSON.stringify({ name: 'demo', version }, null, 2);

test('version file: package.json version change is detected', () => {
  const bump = detectVersionBump('package.json', pkg('0.2.2'), pkg('0.2.3'));
  assert.deepEqual(bump, { from: '0.2.2', to: '0.2.3' });
});

test('version file: unchanged version or identical content is not a bump', () => {
  assert.equal(detectVersionBump('package.json', pkg('0.2.2'), pkg('0.2.2')), undefined);
});

test('version file: creating a new manifest is not a bump of an existing version', () => {
  // before 为空表示新建文件：没有「原来那个版本号」被改掉。
  assert.equal(detectVersionBump('package.json', '', pkg('9.9.9')), undefined);
  assert.equal(detectVersionBump('package.json', undefined, pkg('9.9.9')), undefined);
});

test('version file: editing other fields of package.json is not a bump', () => {
  const before = JSON.stringify({ name: 'demo', version: '0.2.2', description: 'old' });
  const after = JSON.stringify({ name: 'demo', version: '0.2.2', description: 'new' });
  assert.equal(detectVersionBump('package.json', before, after), undefined);
});

test('version file: dependency versions in package-lock are ignored', () => {
  const before = JSON.stringify({ name: 'demo', version: '0.2.2', packages: { '': { version: '0.2.2' }, 'node_modules/x': { version: '1.0.0' } } });
  const after = JSON.stringify({ name: 'demo', version: '0.2.2', packages: { '': { version: '0.2.2' }, 'node_modules/x': { version: '1.4.0' } } });
  assert.equal(detectVersionBump('package-lock.json', before, after), undefined);
});

test('version file: root package version in package-lock is detected', () => {
  const before = JSON.stringify({ name: 'demo', version: '0.2.2', packages: { '': { version: '0.2.2' } } });
  const after = JSON.stringify({ name: 'demo', version: '0.3.0', packages: { '': { version: '0.3.0' } } });
  assert.deepEqual(detectVersionBump('package-lock.json', before, after), { from: '0.2.2', to: '0.3.0' });
});

test('version file: Cargo.toml / pyproject.toml / pubspec.yaml / csproj / Info.plist', () => {
  assert.deepEqual(
    detectVersionBump('Cargo.toml', '[package]\nname = "x"\nversion = "0.1.0"\n', '[package]\nname = "x"\nversion = "0.2.0"\n'),
    { from: '0.1.0', to: '0.2.0' },
  );
  assert.deepEqual(
    detectVersionBump('pyproject.toml', '[project]\nversion = "1.0.0"\n', '[project]\nversion = "1.1.0"\n'),
    { from: '1.0.0', to: '1.1.0' },
  );
  assert.deepEqual(
    detectVersionBump('pubspec.yaml', 'name: demo\nversion: 1.0.0+1\n', 'name: demo\nversion: 1.0.1+2\n'),
    { from: '1.0.0+1', to: '1.0.1+2' },
  );
  assert.deepEqual(
    detectVersionBump('App.csproj', '<Project><Version>1.0.0</Version></Project>', '<Project><Version>1.2.0</Version></Project>'),
    { from: '1.0.0', to: '1.2.0' },
  );
  assert.deepEqual(
    detectVersionBump(
      'Info.plist',
      '<key>CFBundleShortVersionString</key>\n<string>1.0</string>',
      '<key>CFBundleShortVersionString</key>\n<string>1.1</string>',
    ),
    { from: '1.0', to: '1.1' },
  );
});

test('version file: Cargo.toml dependency table is not the project version', () => {
  const before = '[package]\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1.0" }\n';
  const after = '[package]\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1.2" }\n';
  assert.equal(detectVersionBump('Cargo.toml', before, after), undefined);
});

test('version file: unrelated files and unparsable manifests are never blocked', () => {
  assert.equal(isVersionManifest('src/index.ts'), false);
  assert.equal(detectVersionBump('src/index.ts', 'a', 'b'), undefined);
  // JSON 解析失败（例如模型写坏了）时宁可不拦，也不要把正常修复挡住。
  assert.equal(detectVersionBump('package.json', pkg('0.2.2'), '{ broken'), undefined);
  assert.equal(projectVersionOf('package.json', '{ broken'), undefined);
});

// ── 命令侧：升版本工具 ────────────────────────────────────────────────────

test('version command: package manager version subcommands are detected', () => {
  assert.equal(versionBumpCommand('npm version patch'), 'npm version');
  assert.equal(versionBumpCommand('pnpm version 0.2.3'), 'pnpm version');
  assert.equal(versionBumpCommand('yarn version --new-version 0.2.3'), 'yarn version');
  assert.equal(versionBumpCommand('poetry version minor'), 'poetry version');
  assert.equal(versionBumpCommand('cargo set-version 0.3.0'), 'cargo set-version');
});

test('version command: direct bump tools and npx wrapper', () => {
  assert.equal(versionBumpCommand('standard-version'), 'standard-version');
  assert.equal(versionBumpCommand('npx standard-version --release-as patch'), 'standard-version');
  assert.equal(versionBumpCommand('bumpversion patch'), 'bumpversion');
});

test('version command: ordinary commands are not version bumps', () => {
  for (const command of [
    'npm install',
    'npm test',
    'npm run build',
    'npm --version',
    'pnpm -v',
    'git commit -m "bump version"',
    'git tag v0.2.3',
    'echo "npm version patch"',
    'grep -r "version" package.json',
  ]) {
    assert.equal(versionBumpCommand(command), undefined, `${command} 不应被判为升版本命令`);
  }
});

test('version command: found anywhere in a command chain', () => {
  assert.equal(versionBumpCommand('npm test && npm version patch'), 'npm version');
  assert.equal(versionBumpCommand('cd build; npm version minor'), 'npm version');
});

test('version command: bridged tool arguments are scanned too', () => {
  assert.equal(argumentsMentionVersionBump(JSON.stringify({ commandLine: 'npm version patch' })), true);
  assert.equal(argumentsMentionVersionBump(JSON.stringify({ command: 'npm test' })), false);
  assert.equal(argumentsMentionVersionBump('{"command":"npm version patch"}'), true);
  assert.equal(argumentsMentionVersionBump(''), false);
});

// ── 用户意图 ──────────────────────────────────────────────────────────────

test('intent: explicit version bump requests are recognised', () => {
  for (const text of [
    '版本号升级为0.2.1，而不是0.3.0',
    '把版本号改成 0.2.3',
    '更新版本号为 0.2.0',
    '升级版本号',
    '帮我升一下版本',
    'bump version to 0.3.0',
    'upgrade the version please',
  ]) {
    assert.equal(hasVersionBumpIntent(text), true, `${text} 应当被识别为升版本要求`);
  }
});

test('intent: negations do not grant permission', () => {
  for (const text of [
    '不要升级版本',
    '不要自己升级版本号',
    '先不改版本号',
    '无需更新版本',
    "don't bump the version",
    'do not change the version',
  ]) {
    assert.equal(hasVersionBumpIntent(text), false, `${text} 不应授予升版本权限`);
  }
});

test('intent: ordinary sentences mentioning a version do not grant permission', () => {
  for (const text of [
    '',
    '这个版本 0.2.2 有个 bug',
    '看一下 README 里的版本说明',
    '继续修复上一个问题',
    '提交 git',
  ]) {
    assert.equal(hasVersionBumpIntent(text), false, `${text} 不应被当成升版本要求`);
  }
});

test('intent: skill rules count as permission, plain mentions do not', () => {
  assert.equal(hasSkillVersionRule('完成任务后升级版本号并提交 git'), true);
  assert.equal(hasSkillVersionRule('把版本信息展示在页脚'), false);
  assert.equal(hasSkillVersionRule(''), false);
});

test('authorization: user text wins, skill rule is the fallback', () => {
  assert.equal(versionBumpAuthorization({ userText: '升级版本号到 0.3.0' }), 'user');
  assert.equal(versionBumpAuthorization({ skillPrompt: '完成后升级版本号' }), 'skill');
  assert.equal(versionBumpAuthorization({ userText: '修个 bug' }), undefined);
});

// ── 提示词规则本身 ────────────────────────────────────────────────────────

test('prompt: states the never-bump rule and both asking moments', () => {
  // 「不主动升版本」+ 短任务/长任务两种询问时机，缺一条都会让模型退回旧行为。
  assert.match(VERSION_RULE_PROMPT, /never bump/i);
  assert.match(VERSION_RULE_PROMPT, /short task/i);
  assert.match(VERSION_RULE_PROMPT, /long task|phase boundary/i);
  assert.match(VERSION_RULE_PROMPT, /npm version/);
});
