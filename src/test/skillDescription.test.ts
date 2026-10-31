import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parseSkillDescription, SkillRegistry, skillRouteLine } from '../agent/skillRegistry';
import { QUICK_LAUNCH_EXTENSION_ID } from '../core/skillSelection';
import { setInstalledExtension } from './support/vscodeMock';

/**
 * 技能描述拆段：摘要 / 适用场景 / 触发词。
 *
 * 真实故障（2026-10-31）：`readSkill` 把 description 压成一行并**截断到 240 字符**，
 * 而本机技能普遍写成 `**标题** — 摘要。USE FOR: … Triggers: …`，触发词在末尾 →
 * 整段被切掉，模型永远匹配不到。38 个技能里 16 个中招（含 search-before-acting、
 * work-principles）。所以把这两段拆成独立字段，触发词不参与截断。
 *
 * 另外一个坑：英文标记前面**不一定有空格**（中文写作习惯是「…验收。Triggers: …」），
 * 早期按 `\s` 判边界的实现会全部漏掉。
 */

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

test('拆段：中文摘要 + USE FOR + Triggers（标记紧跟在句号后，没有空格）', () => {
  const raw = '**「先上网再动手」SKILL** — 先搜权威网站再动手。USE FOR: 不常见的 bug / 卡住的难题。Triggers: 先查资料, 官方文档, 别猜。';
  const parsed = parseSkillDescription(raw);
  assert.equal(parsed.summary, '**「先上网再动手」SKILL** — 先搜权威网站再动手');
  assert.equal(parsed.useFor, '不常见的 bug / 卡住的难题');
  assert.deepEqual(parsed.triggers, ['先查资料', '官方文档', '别猜']);
});

test('拆段：全角冒号、各种分隔符都认', () => {
  const parsed = parseSkillDescription('摘要。Triggers：甲，乙、丙；丁|戊');
  assert.deepEqual(parsed.triggers, ['甲', '乙', '丙', '丁', '戊']);
});

test('拆段：只有 Triggers（没有 USE FOR）也能拆', () => {
  const parsed = parseSkillDescription('摘要一句话。Triggers: a, b');
  assert.equal(parsed.summary, '摘要一句话');
  assert.equal(parsed.useFor, '');
  assert.deepEqual(parsed.triggers, ['a', 'b']);
});

test('拆段：只有 USE FOR（没有 Triggers）也能拆', () => {
  const parsed = parseSkillDescription('摘要。USE FOR: 做玻璃、修玻璃');
  assert.equal(parsed.summary, '摘要');
  assert.equal(parsed.useFor, '做玻璃、修玻璃');
  assert.deepEqual(parsed.triggers, []);
});

test('拆段：frontmatter 里显式的 triggers 会合并进来（去重、保序）', () => {
  const parsed = parseSkillDescription('摘要。Triggers: 甲, 乙', '乙, 丙');
  assert.deepEqual(parsed.triggers, ['甲', '乙', '丙']);
});

test('拆段：没有任何标记时，原文就是摘要（不凭空造字段）', () => {
  const parsed = parseSkillDescription('就是一个普通描述，没有分段标记。');
  assert.equal(parsed.summary, '就是一个普通描述，没有分段标记');
  assert.equal(parsed.useFor, '');
  assert.deepEqual(parsed.triggers, []);
});

test('拆段：空值与空白不产生空触发词', () => {
  assert.deepEqual(parseSkillDescription('   ').triggers, []);
  assert.deepEqual(parseSkillDescription('摘要。Triggers: 甲, , 乙,').triggers, ['甲', '乙']);
});

test('路由行：触发词必须出现（这是本次修复的核心）', () => {
  const line = skillRouteLine({
    id: 'abc123',
    name: 'search-before-acting',
    description: '先上网再动手',
    useFor: '不常见的 bug',
    triggers: ['先查资料', '官方文档', '别猜'],
  });
  assert.match(line, /^- abc123 \| search-before-acting \| 先上网再动手/);
  assert.match(line, /适用：不常见的 bug/);
  assert.match(line, /触发词：先查资料, 官方文档, 别猜/);
});

test('路由行：摘要很长也不会把触发词挤掉（各自独立截断）', () => {
  const line = skillRouteLine({
    id: 'x',
    name: '长描述技能',
    description: '很长的摘要'.repeat(120),
    useFor: '很长的适用场景'.repeat(60),
    triggers: ['关键触发词甲', '关键触发词乙'],
  });
  assert.ok(line.length < 700, `路由行应有上限，实际 ${line.length}`);
  assert.match(line, /触发词：关键触发词甲, 关键触发词乙/, '触发词必须完整保留在末尾');
  assert.match(line, /…/, '超长部分应显式省略，而不是静默丢弃');
});

test('路由行：没有适用/触发时不写空段', () => {
  const line = skillRouteLine({ id: 'x', name: 'n', description: 'd' });
  assert.equal(line, '- x | n | d');
});

test('真实技能语料：凡是写了 Triggers 的技能，触发词都必须解析出来', async (t) => {
  const root = join(homedir(), '.copilot', 'skills');
  if (!existsSync(root)) {
    t.skip('本机没有 ~/.copilot/skills');
    return;
  }
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  const failures: string[] = [];
  let checked = 0;
  for (const dir of dirs) {
    const file = join(root, dir.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const text = await readFile(file, 'utf8');
    const match = /^description:\s*(.*)$/m.exec(text);
    if (!match) continue;
    const raw = match[1]!.trim().replace(/^['"]|['"]$/g, '');
    if (!/(?:Triggers?|触发词|触发)\s*[:：]/i.test(raw)) continue;
    checked += 1;
    const parsed = parseSkillDescription(raw);
    if (!parsed.triggers.length) failures.push(dir.name);
    // 摘要里不该再残留标记（否则路由行会重复一遍）
    if (/(?:Triggers?|触发词)\s*[:：]/i.test(parsed.summary)) failures.push(`${dir.name}（摘要残留标记）`);
    if (clean(parsed.summary).length === 0) failures.push(`${dir.name}（摘要被吃空）`);
  }
  assert.ok(checked >= 1, '语料里应至少有一个写了 Triggers 的技能');
  assert.deepEqual(failures, [], `这些技能的触发词没解析出来：${failures.join('、')}`);
});

test('端到端：长描述技能的触发词确实进了模型看到的路由表', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-skill-route-'));
  // 让技能走**路由表**而不是整段预加载：只有在「快捷调用扩展已安装 + 该技能在
  // 启用清单里」时才会这样（见 readSkill 里的 defaultEnabled）。真实环境里这两种
  // 形态都存在，路由表这一条正是本次修复要保证的。
  setInstalledExtension({ id: QUICK_LAUNCH_EXTENSION_ID });
  // 复刻真实语料形状：描述 600+ 字，Triggers 在最后（旧实现会被 240 字符截断吃掉）
  const longSummary = '这是一段很长的摘要，描述这个技能覆盖的领域与常见现象。'.repeat(12);
  const body = `---\nname: long-tail\ndescription: '${longSummary} USE FOR: 处理日志、排查崩溃。Triggers: 关键触发词甲, 关键触发词乙, crash-log'\n---\n\n# 长描述技能\n\n正文。\n`;
  await mkdir(join(root, 'copilot-skills', 'long-tail'), { recursive: true });
  await writeFile(join(root, 'copilot-skills', 'long-tail', 'SKILL.md'), body, 'utf8');
  await writeFile(join(root, 'quick-launch.json'), JSON.stringify({ active: ['long-tail'] }), 'utf8');

  const registry = new SkillRegistry(
    vscode.Uri.file(join(root, 'user-skills')),
    vscode.Uri.file(join(root, 'copilot-skills')),
    vscode.Uri.file(join(root, 'quick-launch.json')),
  );
  try {
    const list = await registry.refresh({ force: true });
    const skill = list.find((entry) => entry.name === 'long-tail');
    assert.ok(skill, '技能应被扫出来');
    assert.deepEqual(skill!.triggers, ['关键触发词甲', '关键触发词乙', 'crash-log'], '触发词应单独解析出来');
    assert.equal(skill!.useFor, '处理日志、排查崩溃');
    assert.ok(skill!.description.length <= 240, '面板描述仍受 240 上限约束');

    // 关键：路由表（模型真正看到的那段提示词）必须带触发词。
    const prepared = registry.prepare([skill!.id], 'agent', '');
    assert.match(prepared.prompt, /触发词：关键触发词甲, 关键触发词乙, crash-log/);
    assert.match(prepared.prompt, /适用：处理日志、排查崩溃/);
  } finally {
    setInstalledExtension(undefined);
    registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
