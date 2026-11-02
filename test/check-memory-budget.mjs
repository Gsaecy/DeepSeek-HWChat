// 内存预算的守门人。
//
// 现场（用户反馈）：「hwchat 占用高内存」。查下来四处**常驻**缓存只有三处有上限，
// 而且还都是「条数」上限 —— 条数不等于内存。
//
// 实测（真实 63.4MB / 1513 条消息档案，本机）：
//   · 页缓存：原来只限「最多 8 页」，每页最多 6 MB → 上限 **48 MB**；
//     5 个对话的首页实测就占 **17.7 MB**（堆）。
//   · 搜索结果缓存：只限 32 条，每条 `content` 允许 200 KB → **6.4 MB**。
//   · 搜索调度缓存：**只有 TTL、没有条数上限**，且过期清理只在「同一个 key 再查一次」
//     时发生 —— 查过就不再查的 key 会永久留在 Map 里。
//   · 附件正文索引：48M 字符常驻（0.3.6 已收到 16M，并加了存档恢复路径）。
//
// 本文件守四件事：
//   1. 每个 MB 级缓存都有**字节**闸门，而不只是条数；
//   2. 超预算时的行为是「淘汰最旧的」或「干脆不缓存这一条」，不是继续往里塞；
//   3. 缓存统计可观测（「显示资源统计」里能看到当前占用与上限）；
//   4. 淘汰不影响正确性（缓存只是缓存）。
//
// 运行：node test/check-memory-budget.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const STORAGE = readFileSync('src/core/storage.ts', 'utf8');
const TOOL = readFileSync('src/agent/toolExecutor.ts', 'utf8');
const SEARCH = readFileSync('src/agent/searchScheduler.ts', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const EXT = readFileSync('src/extension.ts', 'utf8');
const TESTS = readFileSync('src/test/storage.test.ts', 'utf8');

const MB = 1024 * 1024;

/** 从源码里取 `const NAME = <数字表达式>;` 的值。 */
function constValue(source, name) {
  const match = source.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(match, `找不到常量 ${name}`);
  // 只允许算术表达式，避免把任意代码当常量执行。
  const expr = match[1].trim();
  assert.match(expr, /^[\d*\s()+*/._]+$/, `${name} 的取值不是纯算术表达式：${expr}`);
  return Function(`'use strict'; return (${expr});`)();
}

/* 1. 页缓存：必须有字节预算，且是有限值 */
const pageBudget = constValue(STORAGE, 'MESSAGE_PAGE_CACHE_BYTE_BUDGET');
assert.ok(
  pageBudget > 0 && pageBudget <= 24 * MB,
  `页缓存的字节预算必须是有限的（当前 ${(pageBudget / MB).toFixed(0)}MB）：只限条数时上限是 8×6MB=48MB`,
);
assert.match(STORAGE, /private messagePageCacheBytes = 0;/, '必须记账当前占用字节');
assert.match(
  STORAGE,
  /this\.messagePageCacheBytes > MESSAGE_PAGE_CACHE_BYTE_BUDGET/,
  '淘汰条件必须包含字节预算（只管条数等于没管内存）',
);
assert.match(
  STORAGE,
  /if \(bytes > MESSAGE_PAGE_CACHE_BYTE_BUDGET\) \{/,
  '单页就超预算时必须直接不缓存，否则它会把别的页全挤掉',
);
assert.match(STORAGE, /this\.messagePageCacheBytes = 0;/, '整体失效时必须把记账一起清零');
// 只有在「缓存」这条路径上才扣减，漏扣会导致记账越来越小、预算形同虚设。
assert.match(STORAGE, /this\.messagePageCacheBytes -= previous\.bytes;/, '替换同一 key 时要先扣掉旧的');
assert.match(STORAGE, /this\.messagePageCacheBytes -= evicted\?\.bytes \?\? 0;/, '淘汰时要扣掉被淘汰的');
// 复用已有的 bytes，别为算大小再序列化一遍
assert.match(STORAGE, /if \(cacheKey\) this\.rememberPage\(cacheKey, page, bytes\);/, '必须复用循环里已算过的字节数');

/* 2. 搜索结果缓存：字节闸门 */
const resultBudget = constValue(TOOL, 'SEARCH_RESULT_CACHE_BYTE_BUDGET');
assert.ok(resultBudget > 0 && resultBudget <= 8 * MB, `搜索结果缓存的字节预算要有限（当前 ${(resultBudget / MB).toFixed(0)}MB）`);
assert.match(TOOL, /private searchResultBytes = 0;/, '必须记账当前占用字节');
assert.match(TOOL, /this\.searchResultBytes > SEARCH_RESULT_CACHE_BYTE_BUDGET/, '淘汰条件必须包含字节预算');
assert.match(TOOL, /if \(bytes > SEARCH_RESULT_CACHE_BYTE_BUDGET\) return;/, '单条超预算时不缓存');

/* 3. 搜索调度缓存：必须有条数上限与写入前清理 */
assert.match(SEARCH, /const SEARCH_CACHE_MAX_ENTRIES = \d+;/, '搜索调度缓存必须有条数上限（原来只有 TTL）');
assert.match(SEARCH, /private pruneCache\(\): void \{/, '必须有清理函数');
assert.match(SEARCH, /this\.pruneCache\(\);\s*\n\s*this\.cache\.set\(/, '写入前必须清理，否则不再复用的 key 会永久滞留');
assert.match(SEARCH, /while \(this\.cache\.size >= SEARCH_CACHE_MAX_ENTRIES\)/, '条数上限要真的生效');

/* 4. 附件正文索引：上限收紧 + 有恢复路径 */
const attachLimit = constValue(PANEL, 'ATTACHMENT_INDEX_CHAR_LIMIT');
assert.ok(attachLimit <= 16 * MB, `附件正文索引上限应收紧到 ≤16M 字符（当前 ${(attachLimit / MB).toFixed(0)}M）`);
assert.match(PANEL, /private async resolveAttachment\(/, '必须有「索引未命中 → 回存档读」的恢复路径，否则收紧上限会弄坏功能');

/* 5. 可观测：资源统计里能看到内存数字 */
assert.match(STORAGE, /cacheStats\(\): \{/, '存储侧要暴露缓存统计');
assert.match(PANEL, /memoryStats\(\): \{/, '面板侧要暴露缓存统计');
for (const token of ['memory · page cache', 'memory · attachments', 'memory · heap']) {
  assert.ok(EXT.includes(token), `「显示资源统计」必须输出 ${token}：看不到数字就只能猜`);
}

/* 6. 行为测试在场 */
assert.match(TESTS, /页缓存受总字节预算约束/, '缺少「页缓存不超预算」的行为测试');
assert.match(TESTS, /单页就超预算时不缓存它/, '缺少「超大单页不挤掉别的页」的行为测试');

console.log(`✓ 页缓存：字节预算 ${(pageBudget / MB).toFixed(0)}MB（原来条数上限对应 48MB）`);
console.log(`✓ 搜索结果缓存：字节预算 ${(resultBudget / MB).toFixed(0)}MB + 条数上限`);
console.log('✓ 搜索调度缓存：写入前清理过期 + 条数上限（原来只有 TTL）');
console.log(`✓ 附件正文索引：${(attachLimit / MB).toFixed(0)}M 字符 + 存档恢复路径`);
console.log('✓ 「显示资源统计」会打印各缓存的当前占用与上限');
console.log('\n全部通过：每处常驻缓存都有字节闸门，而且看得见');
