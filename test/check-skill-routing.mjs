// 技能路由表的回归检查：触发词必须能到模型手里。
//
// 现场（2026-10-31 真实故障）：`readSkill` 把 description 压成一行并截断到 240 字符，
// 而技能普遍写成 `**标题** — 摘要。USE FOR: … Triggers: …` —— 触发词在末尾，
// 于是被整段切掉：文件看着没问题，模型却永远匹配不到。本机 38 个技能里 16 个中招。
//
// 修法：把 `USE FOR:` / `Triggers:` 拆成独立字段（useFor / triggers），
// 路由表行由 `skillRouteLine()` 拼装，触发词不参与摘要截断。
//
// 这里守的就是「不许再退回那种写法」：
//  1. 解析器存在且没有被 240 截断逻辑吃掉；
//  2. 路由行包含触发词与适用场景；
//  3. 分段标记的边界不依赖空格（中文写作是「…验收。Triggers: …」）；
//  4. 两段顺序写反也能切开。
//
// 运行：node test/check-skill-routing.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REGISTRY = readFileSync('src/agent/skillRegistry.ts', 'utf8');

let failures = 0;
function check(name, pass, detail) {
  if (pass) return;
  failures += 1;
  console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

check('存在独立的分段解析器（不被 240 截断影响）',
  /export function parseSkillDescription\(/.test(REGISTRY),
  '缺 parseSkillDescription 就说明又退回「把触发词塞在描述里」');

check('描述字段与触发词字段分开写进记录',
  /useFor: parsed\.useFor/.test(REGISTRY) && /triggers: parsed\.triggers/.test(REGISTRY),
  'readSkill 必须把 useFor / triggers 单独存起来');

check('路由行由 skillRouteLine 生成，并带上触发词',
  /skillRouteLine\(skill\)/.test(REGISTRY)
  && /触发词：\$\{clip\(skill\.triggers\.join/.test(REGISTRY),
  '路由表是模型唯一的发现入口，少了触发词就等于技能不存在');

check('路由行也带上适用场景',
  /适用：\$\{clip\(skill\.useFor/.test(REGISTRY),
  'USE FOR 是判断「该不该用」的语义依据');

check('分段标记不要求前置空格（中文句号后直接跟标记）',
  !/\(\?:\^\|\\\\s\)\(?:Triggers\?/.test(REGISTRY),
  '按 \\s 判边界会漏掉「…验收。Triggers: …」这种写法');

check('两段标记按出现位置排序（顺序写反也能切开）',
  /markers\.sort\(/.test(REGISTRY),
  '不排序时 Triggers 写在 USE FOR 前面会把适用场景整段吞掉');

check('摘要仍受 240 上限约束（面板一行放得下）',
  /const description = cleanInline\([\s\S]*?\n\s*240,\s*\n\s*\);/.test(REGISTRY),
  '摘要是给人看的一句话，不该无限长');

check('frontmatter 支持显式 triggers: 字段',
  /frontmatter\.triggers/.test(REGISTRY) && /triggers\?: string/.test(REGISTRY),
  '显式字段是以后写新技能的推荐方式');

if (failures) {
  console.log(`\n${failures} 项不满足`);
  process.exit(1);
}
console.log('技能路由检查通过：触发词独立成字段，且确实进了模型看到的路由表。');
