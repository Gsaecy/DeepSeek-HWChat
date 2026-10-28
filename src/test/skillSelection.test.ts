/**
 * Skill 勾选的归属：**扩展给默认值，对话自己说了算**。
 *
 * 需求原文：「安装后 HWChat 会识别它的勾选状态……如果用户在 HWChat 里取消 skill 勾选，
 * 取消效果只应用在当前的对话框。新对话框默认读取本地skill快捷调用扩展里的勾选状态并
 * 应用到新对话框。」
 *
 * 这条需求把「谁拥有勾选」钉成了两层，两层都不能越界：
 *
 * 1. 全局清单（`~/.copilot/.skill-quick-launch.json` 的 `active`）只在**开新对话**时被
 *    读一次，作为初始值；
 * 2. 对话一旦有了自己的记录（发过消息、勾过/取消过），就再也不受全局清单影响——否则
 *    用户在对话里取消的技能会被全局清单顶回来，勾选框「自己弹回去」。
 *
 * 反过来也一样：对话里的取消**不能**写回全局清单，那等于在一条对话里顺手改掉以后所有
 * 对话的默认值。所以本测试还钉住「源码里没有写回勾选的那条路径」。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  QUICK_LAUNCH_EXTENSION_ID,
  QUICK_LAUNCH_MARKETPLACE_URL,
  isMissingFileError,
  isSharedActive,
  readSharedState,
  resolveSkillSelection,
  sharedSkillName,
  withSharedLastUsed,
} from '../core/skillSelection';
import { messageEntry } from '../core/i18n';

/** 源码可能从项目根或仓库根运行，两处都试。 */
function repositoryFile(...segments: string[]): string {
  const candidates = [
    path.join(process.cwd(), ...segments),
    path.join(process.cwd(), 'DeepSeek-HWChat', ...segments),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found, `找不到 ${segments.join('/')}`);
  return readFileSync(found, 'utf8');
}

/* ── 读取全局清单 ────────────────────────────────────────────── */

test('读取：非法或损坏的内容一律当成空勾选，不抛错', () => {
  assert.deepEqual(readSharedState(undefined).active, []);
  assert.deepEqual(readSharedState(null).active, []);
  assert.deepEqual(readSharedState([]).active, []);
  assert.deepEqual(readSharedState('nope').active, []);
  assert.deepEqual(readSharedState({ active: 'not-an-array' }).active, []);
  assert.deepEqual(
    readSharedState({ active: ['a', 1, null, '', '  ', 'a', 'b'] }).active,
    ['a', 'b'],
  );
  assert.deepEqual(readSharedState({ unchecked: { a: 'x', b: 5 } }).unchecked, { b: 5 });
});

test('别名命中任意一个都算已勾选（兼容目录名与 frontmatter 名不一致）', () => {
  assert.equal(isSharedActive(['3d-chadlini-render'], ['chadlini-render', '3d-chadlini-render']), true);
  assert.equal(isSharedActive(['chadlini-render'], ['chadlini-render', '3d-chadlini-render']), true);
  assert.equal(isSharedActive(['other'], ['chadlini-render', '3d-chadlini-render']), false);
});

/* ── 初始勾选：新对话读全局，老对话只听自己的 ─────────────────── */

test('新对话：默认取「本地skill快捷调用」的全局勾选', () => {
  assert.deepEqual(resolveSkillSelection(undefined, undefined, ['a', 'b']), ['a', 'b']);
  // 旧存档没有这个字段（老版本落库的对话）也算「没记录过」，按新对话处理。
  assert.deepEqual(resolveSkillSelection(false, ['stale'], ['a']), ['a']);
  // 全局清单是空的（扩展没装 / 一个都没勾）：新对话从空白开始，而不是沿用别人的存档。
  assert.deepEqual(resolveSkillSelection(false, ['stale'], []), []);
});

test('已有对话：只用自己的记录，全局清单后来怎么变都不改写它', () => {
  assert.deepEqual(resolveSkillSelection(true, ['a'], ['a', 'b']), ['a'], '全局新增的不能塞进老对话');
  assert.deepEqual(resolveSkillSelection(true, ['a', 'b'], ['a']), ['a', 'b'], '全局删除的不能从老对话里拿走');
  // 用户在对话里全部取消：存的是空数组，必须仍然是空——这正是「取消只作用于当前对话」。
  assert.deepEqual(resolveSkillSelection(true, [], ['a', 'b']), []);
});

test('两种来源都去重、滤掉脏值', () => {
  assert.deepEqual(resolveSkillSelection(true, ['a', 'a', ''], ['x']), ['a']);
  assert.deepEqual(resolveSkillSelection(false, undefined, ['a', 'a', 'b']), ['a', 'b']);
  assert.deepEqual(resolveSkillSelection(true, undefined, ['x']), []);
});

/* ── 共享清单里的名字 ─────────────────────────────────────────── */

test('共享清单里的名字：frontmatter 优先，没有才退回目录名，且不看正文标题', () => {
  // 那个扩展的口径：parseSkillMd 只取 frontmatter.name，缺省用目录名。
  assert.equal(sharedSkillName('app-store-rules', 'apple-rules-dir'), 'app-store-rules');
  assert.equal(sharedSkillName(undefined, 'apple-rules-dir'), 'apple-rules-dir');
  assert.equal(sharedSkillName('   ', 'apple-rules-dir'), 'apple-rules-dir');
  assert.equal(sharedSkillName(undefined, undefined), undefined);
  assert.equal(sharedSkillName('', ''), undefined);
});

/* ── 唯一写回共享文件的东西：lastUsed ─────────────────────────── */

test('记录调用时间：只写共享清单认得的名字，其它字段原样保留', () => {
  const raw = {
    active: ['keep'],
    custom: { mine: { title: '名', desc: '描述' } },
    categoryTitles: { misc: '未分类' },
    lastUsed: { keep: 5, junk: 'not-a-number' },
  };
  const next = withSharedLastUsed(raw, ['chadlini-render'], 99);

  assert.deepEqual(next?.lastUsed, { keep: 5, 'chadlini-render': 99 });
  assert.deepEqual(next?.active, ['keep'], '写时间戳不能顺手改勾选');
  assert.deepEqual(next?.custom, raw.custom);
  assert.deepEqual(next?.categoryTitles, raw.categoryTitles);
  assert.deepEqual(raw.lastUsed, { keep: 5, junk: 'not-a-number' }, '纯函数不该改入参');
});

test('读不懂共享文件时绝不写入：宁可少记一次，也不清空别人的配置', () => {
  assert.equal(withSharedLastUsed(undefined, ['a'], 1), undefined);
  // 只有「文件不存在」才算空状态；读权限不足之类不能当成首次使用。
  assert.equal(isMissingFileError({ code: 'FileNotFound' }), true);
  assert.equal(isMissingFileError({ code: 'EntryNotFound' }), true);
  assert.equal(isMissingFileError(Object.assign(new Error('x'), { code: 'ENOENT' })), true);
  assert.equal(isMissingFileError({ code: 'EACCES' }), false);
  assert.equal(isMissingFileError(new Error('boom')), false);
  assert.equal(isMissingFileError(undefined), false);
});

/* ── 两个项目的契约 ───────────────────────────────────────────── */

test('两个项目的契约：扩展标识与共享文件路径必须一致', (t) => {
  const siblingRoot = [
    path.join(process.cwd(), '..', 'Local_skill_quick_access'),
    path.join(process.cwd(), 'Local_skill_quick_access'),
  ].find((candidate) => existsSync(path.join(candidate, 'package.json')));
  if (!siblingRoot) {
    t.skip('本地没有 Local_skill_quick_access 检出一份，跳过跨项目契约检查');
    return;
  }
  const manifest = JSON.parse(readFileSync(path.join(siblingRoot, 'package.json'), 'utf8')) as {
    name?: string;
    publisher?: string;
  };
  // 装错/改名两边就互相看不见了：这是判断「那个扩展在不在」的唯一依据。
  assert.equal(`${manifest.publisher}.${manifest.name}`, QUICK_LAUNCH_EXTENSION_ID);

  // 共享文件是唯一的交接点，路径文件名两边必须写同一份。
  // 扫整个 src：常量放在哪个模块里会变，写死文件名反而让这条断言变成脆的装饰。
  const siblingSources = readdirSync(path.join(siblingRoot, 'src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(path.join(siblingRoot, 'src', name), 'utf8'))
    .join('\n');
  assert.ok(siblingSources.includes("'.copilot', '.skill-quick-launch.json'"), '共享状态文件名不一致');
});

test('扩展标识与商店链接对得上', () => {
  assert.equal(QUICK_LAUNCH_EXTENSION_ID, 'honor-world.local-skill-quick-launch');
  assert.match(QUICK_LAUNCH_EXTENSION_ID, /^[a-z0-9-]+\.[a-z0-9-]+$/);
  assert.equal(
    QUICK_LAUNCH_MARKETPLACE_URL,
    'https://marketplace.visualstudio.com/items?itemName=honor-world.local-skill-quick-launch',
  );
});

/* ── 接线：勾选按对话存，源码里不该再有写回全局清单的路径 ──────── */

test('界面接线：勾选只发意图，初始值来自全局清单', () => {
  const chatJs = repositoryFile('media', 'chat.js');
  const chatPanel = repositoryFile('src', 'views', 'chatPanel.ts');
  const css = repositoryFile('media', 'chat.css');

  assert.ok(chatJs.includes("post('toggleSkill', { skillId: skill.id, enabled: input.checked })"));
  assert.ok(!chatJs.includes("post('setSkills'"), '界面仍在推整份 skillIds');
  assert.ok(chatPanel.includes("case 'toggleSkill'"));

  // 初始值只在新对话/无记录的对话上取；有记录的对话用自己的 skillIds。
  assert.ok(chatPanel.includes('resolveSkillSelection('));
  assert.ok(chatPanel.includes('sharedActiveIds()'));

  // 取消只作用于当前对话 → 源码里不能再有「写回共享 active」的路径。
  assert.ok(!chatPanel.includes('setSharedEnabled'), '仍在把勾选写回全局清单');
  const selectionSource = repositoryFile('src', 'core', 'skillSelection.ts');
  assert.ok(!selectionSource.includes('applySharedToggle'), '仍在构造写回共享勾选的逻辑');

  // 未安装提示仍然存在（解释默认值从哪来），但不再拦着用户勾。
  assert.ok(chatPanel.includes('id="skillsInstallHint"'));
  assert.ok(/\.skills-install-hint\[hidden\]\s*\{[^}]*display:\s*none/.test(css));
});

test('未安装提示的中英文案都在', () => {
  for (const key of ['chat.skillsInstallTitle', 'chat.skillsInstallBody', 'chat.skillsInstallAction']) {
    const entry = messageEntry(key);
    assert.ok(entry, `缺少文案：${key}`);
    assert.notEqual(entry.zh, entry.en, `中英文案相同：${key}`);
  }
});

test('星标面板对接安装状态：没装就提示安装，装了显示扩展的勾选', () => {
  const chatJs = repositoryFile('media', 'chat.js');
  const chatPanel = repositoryFile('src', 'views', 'chatPanel.ts');
  const extensionSource = repositoryFile('src', 'extension.ts');

  // 1. 没装：只要展开面板就必须看到安装提示（不是等用户勾了某个 skill 才出现）。
  assert.ok(
    /elements\.skillsInstallHint\.hidden = Boolean\(state\.quickLaunchInstalled\)/.test(chatJs),
    '安装提示必须由 quickLaunchInstalled 直接驱动',
  );
  assert.ok(chatJs.includes("t('chat.skillsSourceMissing')"), '缺未安装时的说明文案');
  assert.ok(chatJs.includes("t('chat.skillsSourceInstalled')"), '缺已安装时的说明文案');

  // 2. 装了：勾选状态来自扩展，且改动只落在当前对话。
  assert.ok(chatPanel.includes('quickLaunchInstalled: this.quickLaunchInstalled()'), '下发安装状态');
  assert.ok(chatJs.includes('state.quickLaunchInstalled = message.quickLaunchInstalled'), '安装状态变化要能实时更新面板');

  // 3. 装完 / 卸掉要立刻生效，不能要求重载窗口。
  //    官方 API：`extensions.onDidChange` 在扩展安装 / 卸载 / 启用 / 停用时触发。
  assert.ok(extensionSource.includes('vscode.extensions.onDidChange'), '缺少扩展安装状态变化的监听');
  assert.ok(chatPanel.includes('async refreshSkills('), '缺少安装状态变化后的刷新入口');

  // 4. 「打开扩展详情」必须优先在 VS Code 内打开详情页，而不是直接扔给浏览器。
  assert.ok(chatPanel.includes("'extension.open'"), '缺少在 VS Code 内打开扩展详情页');
  assert.ok(chatPanel.includes('QUICK_LAUNCH_EXTENSION_ID'), '缺少扩展标识');
});
