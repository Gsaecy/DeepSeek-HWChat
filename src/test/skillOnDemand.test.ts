import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as vscode from 'vscode';
import { SkillRegistry } from '../agent/skillRegistry';
import { setInstalledExtension } from './support/vscodeMock';

/**
 * 技能按需加载（用户 2026-11-22 明确要求）。
 *
 * 背景：启用一个 `SKILL.md` 就把全文写进系统提示词，而系统提示词**每轮都要重发**。
 * 本机技能普遍 10–40 KB，一个 40 KB 的技能在 20 步任务里等于重复发 800 KB ——
 * 这正是「Copilot Chat 用同一个模型却更流畅」的另一个来源：它只常驻清单，正文按需取。
 *
 * 现在：
 *  - agent / plan（有工具的档位）→ 只给清单（id + 摘要 + 适用 + 触发词），
 *    要求模型动手前用 `load_skill` 取全文；
 *  - chat（没有工具，模型无从加载）→ 仍然内联全文，否则技能等于没启用。
 */

const BODY_MARKER = '这是技能正文第一句，绝不该在提示词里出现。';

async function makeRegistry(): Promise<{ registry: SkillRegistry; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-skill-ondemand-'));
  const body = `---\nname: long-tail\ndescription: '处理日志与崩溃排查。USE FOR: 排查崩溃。Triggers: 崩溃, crash-log'\n---\n\n# 长技能\n\n${BODY_MARKER}\n\n${'补充说明。'.repeat(800)}\n`;
  // 用户技能是 user-skills/*.md（平铺），不是 <name>/SKILL.md（那是 copilot 源）。
  await mkdir(join(root, 'user-skills'), { recursive: true });
  await writeFile(join(root, 'user-skills', 'long-tail.md'), body, 'utf8');
  const registry = new SkillRegistry(
    vscode.Uri.file(join(root, 'user-skills')),
    vscode.Uri.file(join(root, 'copilot-skills')),
    vscode.Uri.file(join(root, 'quick-launch.json')),
  );
  await registry.refresh({ force: true });
  return { registry, root };
}

test('agent 模式：只下发清单，技能正文不进提示词', async () => {
  setInstalledExtension(undefined);
  const { registry, root } = await makeRegistry();
  try {
    const skill = registry.list().find((entry) => entry.name === 'long-tail');
    assert.ok(skill, '技能应被扫出来');

    const prepared = registry.prepare([skill!.id], 'agent', '程序崩了怎么办');

    assert.equal(prepared.prompt.includes(BODY_MARKER), false, '正文绝不能出现在系统提示词里');
    assert.match(prepared.prompt, /load_skill/, '要明确要求模型按需加载');
    assert.match(prepared.prompt, /NOT in this prompt/, '要说清正文不在提示词里，否则模型会以为已经读到');
    assert.match(prepared.prompt, /触发词：.*崩溃/, '清单必须带触发词，模型据此判断要不要加载');
    assert.ok(prepared.routableIds.includes(skill!.id), 'load_skill 必须认这个 id，否则照着清单调用会被拒');
    assert.deepEqual(prepared.preloaded, [], '没有内联就谈不上「已使用」');
    assert.ok(prepared.bytes < 2_000, `清单应远小于正文，实际 ${prepared.bytes} 字节`);
  } finally {
    registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('load_skill 取回的是全文，模型照清单调用不会落空', async () => {
  setInstalledExtension(undefined);
  const { registry, root } = await makeRegistry();
  try {
    const skill = registry.list().find((entry) => entry.name === 'long-tail');
    const prepared = registry.prepare([skill!.id], 'agent', '');
    const loaded = await registry.executeLoad({
      id: 'call-1',
      type: 'function',
      function: { name: 'load_skill', arguments: JSON.stringify({ id: skill!.id }) },
    }, prepared.routableIds);

    assert.equal(loaded.result.status, 'success');
    assert.match(loaded.result.content, /这是技能正文第一句/, '必须拿到全文');
    assert.ok(loaded.usage, '加载成功后要记一次使用，界面才会显示「已调用」');
  } finally {
    registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('chat 模式没有工具：仍然内联全文，否则技能等于没启用', async () => {
  setInstalledExtension(undefined);
  const { registry, root } = await makeRegistry();
  try {
    const skill = registry.list().find((entry) => entry.name === 'long-tail');
    const prepared = registry.prepare([skill!.id], 'chat', '');

    assert.match(prepared.prompt, /这是技能正文第一句/, 'chat 模式必须内联正文');
    assert.equal(prepared.preloaded.length, 1, '内联即视为使用');
  } finally {
    registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('清单有字节上限：技能很多时截断并说明可以按 id 加载', async () => {
  setInstalledExtension(undefined);
  const root = await mkdtemp(join(tmpdir(), 'hwchat-skill-many-'));
  try {
    for (let index = 0; index < 60; index += 1) {
      const name = `技能${index}`;
      await mkdir(join(root, 'user-skills'), { recursive: true });
      await writeFile(join(root, 'user-skills', `${name}.md`), `---\nname: ${name}\ndescription: '用于第 ${index} 类任务的说明文本，长度刻意写长一点以撑大清单。Triggers: 触发甲${index}, 触发乙${index}'\n---\n\n正文 ${index}\n`, 'utf8');
    }
    const registry = new SkillRegistry(
      vscode.Uri.file(join(root, 'user-skills')),
      vscode.Uri.file(join(root, 'copilot-skills')),
      vscode.Uri.file(join(root, 'quick-launch.json')),
    );
    await registry.refresh({ force: true });
    const ids = registry.list().map((entry) => entry.id);
    const prepared = registry.prepare(ids, 'agent', '');

    assert.ok(prepared.bytes <= 8 * 1024, `清单必须控制在 8 KB 内，实际 ${prepared.bytes}`);
    assert.match(prepared.prompt, /more skill\(s\) not listed/);
    assert.equal(prepared.routableIds.length, ids.length, '被截断的技能仍要能按 id 加载');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
