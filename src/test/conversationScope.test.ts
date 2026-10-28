import assert from 'node:assert/strict';
import test from 'node:test';
import { grantFromFollowUp,
  argumentsMentionGitWrite,
  gitOperationsIn,
  gitWriteAuthorization,
  gitWriteOperation,
  hasGitWriteIntent,
  hasSkillGitWriteRule,
  isGitWriteCommand,
} from '../agent/conversationScope';

// ── git 写操作识别 ────────────────────────────────────────────────────────

/** 第一个 git 子命令的分类（读/写）；没有 git 子命令时为 undefined。 */
function kindOf(command: string): string | undefined {
  return gitOperationsIn(command)[0]?.kind;
}

test('git: commit / add / push / tag are write operations', () => {
  for (const command of [
    'git commit -m "feat: x"',
    'git add -A',
    'git push origin main',
    'git tag v0.2.1',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git merge feature',
    'git rebase main',
    'git stash',
    'git checkout main',
    'git restore src/app.ts',
  ]) {
    assert.ok(isGitWriteCommand(command), `${command} 应当被判为 git 写操作`);
  }
});

test('git: read-only subcommands are not treated as writes', () => {
  for (const command of [
    'git status',
    'git diff --stat',
    'git log --oneline -5',
    'git show HEAD',
    'git rev-parse --show-toplevel',
    'git ls-files',
    'git remote -v',
    'git branch -a',
    'git config --get user.name',
    'git tag -l',
    'git stash list',
  ]) {
    assert.equal(gitWriteOperation(command), undefined, `${command} 不应被判为写操作`);
  }
});

test('git: global options before the subcommand do not hide it', () => {
  const operation = gitWriteOperation('git -C "/Users/me/AI projects/x" commit -m done');
  assert.equal(operation?.kind, 'write');
  assert.equal(operation?.verb, 'commit');
  assert.equal(kindOf('git --no-pager log -1'), 'read');
});

test('git: chained commands are scanned segment by segment', () => {
  const operation = gitWriteOperation('npm test && git add -A && git commit -m ok');
  assert.equal(operation?.verb, 'add');
  assert.equal(gitWriteOperation('cd src && git status'), undefined);
});

test('git: mentioning git in output arguments is not a write', () => {
  assert.equal(gitWriteOperation("grep -n 'git commit' notes.md"), undefined);
  assert.equal(gitWriteOperation('echo "git push"'), undefined);
  assert.equal(gitWriteOperation('git log --grep="git commit"'), undefined);
});

test('git: mixed subcommands are classified by their arguments', () => {
  assert.equal(kindOf('git branch -d old'), 'write');
  assert.equal(kindOf('git branch my-new-branch'), 'write');
  assert.equal(kindOf('git branch'), 'read');
  assert.equal(kindOf('git remote add origin git@example.com:x/y.git'), 'write');
  assert.equal(kindOf('git remote -v'), 'read');
  assert.equal(kindOf('git config user.email me@example.com'), 'write');
  assert.equal(kindOf('git config --get user.email'), 'read');
});

test('git: operations of every segment are collected in order', () => {
  const operations = gitOperationsIn('git fetch && git merge origin/main');
  assert.deepEqual(operations.map((operation) => operation.verb), ['fetch', 'merge']);
});

// ── 用户是否明确要求提交 ──────────────────────────────────────────────────

test('intent: explicit Chinese and English commit requests are recognised', () => {
  for (const text of ['提交一下', '帮我提交 git', 'commit 这些改动', '推送到远程', '打 tag 发布', 'git push']) {
    assert.ok(hasGitWriteIntent(text), `${text} 应被识别为要求提交`);
  }
});

test('intent: negated requests do not grant permission', () => {
  for (const text of ['不要提交', '先别提交', '无需推送', "don't commit yet", 'do not push']) {
    assert.equal(hasGitWriteIntent(text), false, `${text} 不应授予提交权限`);
  }
});

test('intent: unrelated requests do not grant permission', () => {
  assert.equal(hasGitWriteIntent('优化一下任务清单的样式'), false);
  assert.equal(hasGitWriteIntent(''), false);
});

// ── 技能规则等同于用户要求 ────────────────────────────────────────────────

test('skill: a commit rule in the skill text grants permission', () => {
  assert.ok(hasSkillGitWriteRule('完成后执行：git add -A && git commit -m "chore: sync"'));
  assert.equal(hasSkillGitWriteRule('只读取文件并给出建议，不要改动任何东西'), false);
  assert.equal(hasSkillGitWriteRule(''), false);
});

test('skill: authorization reports where the permission came from', () => {
  assert.equal(gitWriteAuthorization({ userText: '提交吧' }), 'user');
  assert.equal(gitWriteAuthorization({ skillPrompt: 'task done → git commit' }), 'skill');
  assert.equal(gitWriteAuthorization({ userText: '看下代码', skillPrompt: '只读分析' }), undefined);
});

// ── 桥接工具的 JSON 参数 ──────────────────────────────────────────────────

test('bridge tools: git writes hidden inside JSON arguments are detected', () => {
  assert.ok(argumentsMentionGitWrite(JSON.stringify({ command: 'git commit -m x' })));
  assert.ok(argumentsMentionGitWrite(JSON.stringify({ steps: [{ run: 'git push' }] })));
  assert.equal(argumentsMentionGitWrite(JSON.stringify({ command: 'git status' })), false);
  assert.equal(argumentsMentionGitWrite(''), false);
  // 解析失败时按原文判断，宁可多拦一次。
  assert.ok(argumentsMentionGitWrite('{broken json git commit}'));
});

/**
 * 「改到一半补一句『提交』，结果被守卫连拦两次」——真实的拦截故障。
 *
 * 授权只在运行开始时按第一条消息算一次，后续跟进消息（任务树里的
 * 「相关指导 / 排队任务」）完全没参与判定；而「先让它改，改完说一句提交」
 * 恰恰是最常见的用法。
 */
test('grantFromFollowUp：跟进消息说「提交」就补上 git 授权', () => {
  const before = { gitWriteAllowed: false, versionBumpAllowed: false };
  const after = grantFromFollowUp(before, { gitWriteAllowed: true });
  assert.equal(after.gitWriteAllowed, true);
  assert.equal(after.versionBumpAllowed, false, '不该顺带给出别的权限');
  assert.equal(before.gitWriteAllowed, false, '不能就地改调用方的对象');
});

test('grantFromFollowUp：只做加法，后面一句闲聊不会撤回已给的授权', () => {
  const granted = { gitWriteAllowed: true, versionBumpAllowed: true };
  const after = grantFromFollowUp(granted, {});
  assert.deepEqual(after, { gitWriteAllowed: true, versionBumpAllowed: true });
});

test('grantFromFollowUp：先给版本授权、后给 git 授权，两者独立累积', () => {
  const step1 = grantFromFollowUp({ gitWriteAllowed: false, versionBumpAllowed: false }, { versionBumpAllowed: true });
  const step2 = grantFromFollowUp(step1, { gitWriteAllowed: true });
  assert.deepEqual(step2, { gitWriteAllowed: true, versionBumpAllowed: true });
});

/**
 * 「为什么提交被拦住了」不是授权请求。
 *
 * 用户经常把守卫报错原样贴回来问，而报错文字里就带着 `git commit`；
 * 只看关键词就会把一句提问当成「帮我提交」，等于凭一句话放开写权限。
 */
test('hasGitWriteIntent：提问「为什么被拦」不授予写权限', () => {
  assert.equal(hasGitWriteIntent('为什么会提示已阻止 git commit？'), false);
  assert.equal(hasGitWriteIntent('怎么又被拦截了，git push 为什么不行'), false);
  assert.equal(hasGitWriteIntent('是不是拦截了 git commit'), false);
});

test('hasGitWriteIntent：正常要求提交照旧放行', () => {
  assert.equal(hasGitWriteIntent('提交'), true);
  assert.equal(hasGitWriteIntent('提交一下'), true);
  assert.equal(hasGitWriteIntent('帮我 push 到远端'), true);
  assert.equal(hasGitWriteIntent('不要提交'), false);
});
