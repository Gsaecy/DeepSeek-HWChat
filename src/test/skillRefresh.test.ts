/**
 * 技能清单的扫描频次回归测试。
 *
 * 现场（真实故障）：面板每次重发状态都调 `SkillRegistry.refresh()`，而一次扫描
 * 等于三条 `findFiles` pattern —— 每条在 VS Code 里都是一次真实的 ripgrep 工作区
 * 遍历，再逐个读取 SKILL.md。一次界面操作链里状态会重发十几遍，大型工作区上
 * 搜索子进程与 CPU 就是这样堆起来的（`spawn rg EAGAIN` 的来源之一）。
 *
 * 这里用真实临时目录 + 统一搜索调度层的完成计数来断言**真实扫描次数**，
 * 而不是只看函数被调用了几次。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { SKILL_REFRESH_TTL_MS, SkillRegistry } from '../agent/skillRegistry';
import { invalidateWorkspaceSearch, workspaceSearchStats } from '../agent/workspaceSearch';
import { fireWorkspaceWatchers, setWorkspaceRoots } from './support/vscodeMock';

/**
 * 一次扫描只允许发**一次**工作区遍历。
 *
 * 旧实现是三条 pattern 各发一次 `findFiles`（= 三次全工作区遍历）。本机 21 个目录 /
 * 64GB 的多根工作区实测 3.2 秒/条，三条串行约 9.6 秒 —— 用户看到的「启动一直在转、
 * 一分钟才加载好」有它一份。三条 pattern 的文件集合互不相交，合并成一个花括号 glob
 * 后结果完全一致（实测合并 3.35s）。
 */
const WORKSPACE_TRAVERSALS_PER_SCAN = 1;

let root: string;
let skills: SkillRegistry;

const searchCount = (): number => workspaceSearchStats()?.completed ?? 0;

async function writeSkill(relativeDir: string, name: string, body: string): Promise<void> {
  const file = join(root, relativeDir, 'SKILL.md');
  await mkdir(join(root, relativeDir), { recursive: true });
  await writeFile(file, `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`, 'utf8');
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'hwchat-skills-'));
  await writeSkill('.agents/skills/alpha', 'Alpha Skill', 'alpha body');
  setWorkspaceRoots([root]);
  invalidateWorkspaceSearch();
  skills = new SkillRegistry(
    vscode.Uri.file(join(root, 'user-skills')),
    vscode.Uri.file(join(root, 'copilot-skills')),
    vscode.Uri.file(join(root, 'quick-launch.json')),
  );
});

after(async () => {
  skills.dispose();
  await rm(root, { recursive: true, force: true });
});

test('skills: one scan costs exactly one workspace traversal', async () => {
  invalidateWorkspaceSearch();
  const before = searchCount();
  const list = await skills.refresh({ force: true });
  const after = searchCount();

  assert.ok(list.some((skill) => skill.name === 'Alpha Skill'), '扫描应发现工作区技能');
  assert.equal(after - before, WORKSPACE_TRAVERSALS_PER_SCAN, '一次扫描只许发一次工作区遍历（三条 pattern 已合并成一个 glob）');
});

test('skills: repeated refreshes inside the freshness window do not scan again', async () => {
  await skills.refresh({ force: true });
  const before = searchCount();

  for (let index = 0; index < 10; index += 1) {
    await skills.refresh();
  }
  const after = searchCount();

  assert.equal(after - before, 0, '窗口内重复刷新不应再发任何搜索');
  assert.ok(skills.list().some((skill) => skill.name === 'Alpha Skill'), '复用结果仍要返回完整清单');
});

test('skills: concurrent refreshes share a single scan (single-flight)', async () => {
  invalidateWorkspaceSearch();
  const before = searchCount();
  const results = await Promise.all(Array.from({ length: 5 }, () => skills.refresh({ force: true })));
  const after = searchCount();

  assert.equal(after - before, WORKSPACE_TRAVERSALS_PER_SCAN, '五个并发刷新只应真正扫描一次');
  for (const list of results) {
    assert.ok(list.some((skill) => skill.name === 'Alpha Skill'));
  }
});

test('skills: force bypasses the freshness window and sees new files', async () => {
  await skills.refresh({ force: true });
  await writeSkill('.agents/skills/beta', 'Beta Skill', 'beta body');
  invalidateWorkspaceSearch();

  const cached = await skills.refresh();
  assert.ok(!cached.some((skill) => skill.name === 'Beta Skill'), '窗口内不应重新扫描');

  const forced = await skills.refresh({ force: true });
  assert.ok(forced.some((skill) => skill.name === 'Beta Skill'), '显式强制刷新必须看到新技能');
});

test('skills: a file watcher event forces a rescan after the debounce', async () => {
  await skills.refresh({ force: true });
  await writeSkill('.claude/skills/gamma', 'Gamma Skill', 'gamma body');
  invalidateWorkspaceSearch();

  fireWorkspaceWatchers('change');
  // watcher 刻意合并 250ms 内的多次事件。
  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.ok(skills.list().some((skill) => skill.name === 'Gamma Skill'), 'watcher 事件必须触发一次真实重扫');
});

test('skills: the freshness window is shorter than a human "I just added a skill" wait', () => {
  assert.ok(SKILL_REFRESH_TTL_MS > 0 && SKILL_REFRESH_TTL_MS <= 60_000);
});

test('skills: 200 rapid file events collapse into at most one rescan', async () => {
  await skills.refresh({ force: true });
  invalidateWorkspaceSearch();
  const before = searchCount();

  for (let index = 0; index < 200; index += 1) {
    fireWorkspaceWatchers(index % 2 === 0 ? 'create' : 'change');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  // 等 debounce（250ms）后的扫描做完。
  await new Promise((resolve) => setTimeout(resolve, 400));

  const after = searchCount();
  assert.ok(
    after - before <= WORKSPACE_TRAVERSALS_PER_SCAN,
    `200 次文件事件最多只应触发一次扫描（${WORKSPACE_TRAVERSALS_PER_SCAN} 次遍历），实际 ${after - before} 次`,
  );
});

test('skills: hydrate never traverses the workspace', async () => {
  invalidateWorkspaceSearch();
  const before = searchCount();
  const list = await skills.hydrate();
  const after = searchCount();

  assert.equal(after - before, 0, '水合不许发任何工作区搜索：它就是「不遍历」的那条路径');
  // 本地目录里的技能会照常出现；workspace 里的要靠缓存或后台扫描。
  assert.ok(Array.isArray(list));
});

test('skills: hydrate still reuses the last scanned workspace skills from cache', async () => {
  await skills.refresh({ force: true });
  assert.ok(skills.list().some((skill) => skill.name === 'Alpha Skill'));

  // 新实例 = 新进程：内存里什么都没有，只能靠磁盘缓存。
  const fresh = new SkillRegistry(
    vscode.Uri.file(join(root, 'user-skills')),
    vscode.Uri.file(join(root, 'copilot-skills')),
    vscode.Uri.file(join(root, 'quick-launch.json')),
  );
  invalidateWorkspaceSearch();
  const before = searchCount();
  const hydrated = await fresh.hydrate();
  const after = searchCount();
  fresh.dispose();

  assert.equal(after - before, 0, '水合不许遍历工作区');
  assert.ok(hydrated.some((skill) => skill.name === 'Alpha Skill'), '上次扫到的 workspace 技能必须能从缓存水合出来');
});

test('skills: hydrate does not mark the registry as scanned', async () => {
  const fresh = new SkillRegistry(
    vscode.Uri.file(join(root, 'user-skills')),
    vscode.Uri.file(join(root, 'copilot-skills')),
    vscode.Uri.file(join(root, 'quick-launch.json')),
  );
  assert.equal(fresh.hasScanned, false);
  await fresh.hydrate();
  fresh.dispose();
  // 水合并不可信：后台的真实扫描必须照样跑，否则新建的工作区技能永远看不到。
  assert.equal(fresh.hasScanned, false);
});
