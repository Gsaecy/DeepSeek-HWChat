import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { SkillRegistry } from '../agent/skillRegistry';

/**
 * 「四阶段交付」技能文件能不能被 HWChat 真正认出来。
 *
 * 为什么要这条测试：SKILL.md 的 frontmatter 出问题**不会报错** ——
 * 名字里带冒号、`name` 与目录名不一致、摘要忘了写触发词，结果都是「技能在，
 * 但模型看不到 / 永远不被匹配」，只有靠人工翻面板才能发现。
 *
 * 这里直接用 **HWChat 自己的 SkillRegistry** 去扫一份真实的技能文件副本
 * （来源是本机 `~/.copilot/skills/four-phase-delivery/SKILL.md`）：
 *  * 名字必须是 `four-phase-delivery` 且与目录名一致；
 *  * 摘要必须带触发词（否则路由永远匹配不上）；
 *  * 正文里不许残留 frontmatter 分隔符；
 *  * 体积要在 `MAX_SKILL_BYTES` 之下（160 KB）。
 *
 * 没有这个技能文件的环境（CI、别的机器）直接跳过，不算失败。
 */

const SKILL_NAME = 'four-phase-delivery';
const SOURCE = join(homedir(), '.copilot', 'skills', SKILL_NAME, 'SKILL.md');

test('本机装了「四阶段交付」技能时，HWChat 能正确解析它', async (t) => {
  if (!existsSync(SOURCE)) {
    t.skip(`本机没有 ${SOURCE}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'hwchat-four-phase-'));
  // 按 HWChat 的真实目录约定摆一份：`<copilotSkillRoot>/<name>/SKILL.md`
  await mkdir(join(root, 'copilot-skills', SKILL_NAME), { recursive: true });
  await copyFile(SOURCE, join(root, 'copilot-skills', SKILL_NAME, 'SKILL.md'));

  const skills = new SkillRegistry(
    vscode.Uri.file(join(root, 'user-skills')),
    vscode.Uri.file(join(root, 'copilot-skills')),
    vscode.Uri.file(join(root, 'quick-launch.json')),
  );
  try {
    const list = await skills.refresh({ force: true });
    const skill = list.find((entry) => entry.name === SKILL_NAME);
    assert.ok(skill, `技能没被扫出来；实际扫到：${list.map((entry) => entry.name).join(', ') || '（空）'}`);
    assert.equal(skill!.source, 'copilot', '来源应识别为 copilot（~/.copilot/skills）');
    assert.equal(skill!.relativePath, `~/.copilot/skills/${SKILL_NAME}/SKILL.md`);

    /*
     * 摘要与触发词是两个字段（0.3.1 起）：
     *  * `description` 只放「人看的一句话」，仍受 240 字符上限约束；
     *  * `triggers` 是 `Triggers:` 段落解析出来的关键词，**不参与截断**，
     *    并会原样出现在路由表里（模型据此决定要不要 load_skill）。
     *
     * 之前把触发词混在 description 里，写在末尾就被 240 字符吃掉 ——
     * 文件看着没问题、模型却永远匹配不到。
     */
    assert.ok(skill!.description.length <= 240, '摘要应不超过 240 字符（超出部分会被丢弃）');
    assert.ok(skill!.description.includes('四阶段'), `摘要应说明这是四阶段技能：${skill!.description}`);
    assert.doesNotMatch(skill!.description, /Triggers\s*[:：]/, '摘要里不该残留 Triggers 标记（已拆到独立字段）');
    const triggers = skill!.triggers ?? [];
    for (const trigger of ['四阶段', '分段执行', '别瞎写']) {
      assert.ok(triggers.includes(trigger), `触发词字段缺少「${trigger}」：${triggers.join(', ')}`);
    }
    assert.ok((skill!.useFor ?? '').length > 0, 'USE FOR 段应解析进 useFor');

    // frontmatter 必须被剥掉，正文直接从标题开始（否则会被当成正文喂给模型）。
    const raw = await readFile(join(root, 'copilot-skills', SKILL_NAME, 'SKILL.md'), 'utf8');
    assert.ok(raw.startsWith('---\n'), '文件应以 frontmatter 开头');
    assert.ok(Buffer.byteLength(raw) < 160 * 1024, '技能体积应远小于 160 KB 上限');
    assert.equal(raw.split('\n---\n').length, 2, '只应有一段 frontmatter，正文里不许再出现分隔线');

    // 三段式正文的关键结构必须在（它们是这个技能的执行骨架）。
    for (const heading of ['## 段末三问', '## 四段与每段的交付物', '## 反模式']) {
      assert.ok(raw.includes(heading), `正文缺少「${heading}」`);
    }
  } finally {
    skills.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
