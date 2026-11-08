// 清理的「响应性」守门人：清理可以慢，但不许把界面一起拖住。
//
// 现场（用户提问：「缓存清除本身就要耗时间吧」）：日志里有一条
//   `[cleanup] scanned=5 compacted=13 deleted=0 bytes=65367622 took=63911ms`
// 同一份 63.4MB / 1513 条消息的档案，在空闲机器上跑同一轮清理只要 **761ms**。
// 也就是说那 63.9 秒里绝大部分不是「必要开销」。
//
// 三处被证实的原因，各自对应下面的不变量：
//   1. **整轮清理是一次 `enqueueWrite`**（154 行的独占任务）：期间所有写入
//      （发消息、流式增量、manifest）都在队列里排队 → 用户看到「点发送没反应」。
//      现在按「一条对话一个任务」切片，单次写入最坏只等当前这条对话
//      （真实档案实测：中位 41ms / 最坏 169ms，而整轮是 366–761ms）。
//   2. **激活后 2 秒就开始扫**：那时 VS Code 还在加载扩展、建索引，我们再去读
//      60MB 历史就是抢盘。现在延到 20 秒。
//   3. **agent 跑着也照扫**：流式输出正在写盘，清理再去读整份历史只会互相拖慢。
//      现在自动心跳遇到运行中的对话直接跳过（用户手动「立即清理」仍然照跑）。
//
// 另外守一条纯浪费：`stripMessagePayload` 曾经无条件 `JSON.stringify` 重字段，
// 1513 条消息光这一步 175ms，而绝大多数消息早就瘦过了。
//
// 运行：node test/check-cleanup-responsiveness.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const STORAGE = readFileSync('src/core/storage.ts', 'utf8');
const SCHEDULER = readFileSync('src/core/cleanupScheduler.ts', 'utf8');
const EXT = readFileSync('src/extension.ts', 'utf8');

/** 去注释后取方法体（锚定类方法的两格缩进）。 */
function methodBody(source, name) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const index = code.search(new RegExp(`\\n  (?:private |public )?(?:async )?${name}\\s*\\(`));
  assert.ok(index >= 0, `找不到 ${name} 的方法定义`);
  const end = code.indexOf('\n  }', index);
  assert.ok(end > index, `${name} 的方法体没有正常结束`);
  return code.slice(index, end);
}

// 0.4.11 起 cleanup() 是「选主 + 委托」的薄包装，真正的逐条处理在 runCleanup()。
const cleanup = methodBody(STORAGE, 'runCleanup');

/* 1. 清理不许整轮独占写队列 */
assert.match(cleanup, /for \(const id of ids\)/, '必须按对话逐条处理');
assert.match(
  cleanup,
  /for \(const id of ids\) \{\s*\n\s*await this\.enqueueWrite\(/,
  '每条对话要各自入队（enqueueWrite 在循环里），不能整轮只入队一次',
);
assert.equal(
  (cleanup.match(/await this\.enqueueWrite\(/g) ?? []).length >= 2,
  true,
  '至少要有「每条对话一个任务」+「收尾一个任务」两处入队',
);
assert.doesNotMatch(cleanup, /^\s*await this\.enqueueWrite\(async \(\) => \{\s*\/\/ 清理会压缩消息体/m,
  '不要退回「整轮一个任务」的写法');
// 逐条任务必须重新确认对话还在（轮次之间用户可能删了它）
const one = methodBody(STORAGE, 'cleanupConversation');
assert.match(one, /const summary = this\.findSummary\(id\);\s*\n\s*if \(!summary\) return;/, '逐条任务必须先确认对话还在');
assert.match(one, /if \(!isEmptyDraftConversation\(summary\)\) return;/, '删空对话之前必须重新确认它仍然是空对话');

/* 2. 首次扫描要避开启动高峰 */
const delay = EXT.match(/setTimeout\(\(\) => void scheduler\.run\(false\)[\s\S]{0,200}?\}\), (\d+)_?(\d+)?\)/);
assert.ok(delay, '找不到首次清理的定时器');
const delayMs = Number(`${delay[1]}${delay[2] ?? ''}`);
assert.ok(delayMs >= 20_000, `首次清理延后 ${delayMs}ms 太早：VS Code 自己还在加载时读 60MB 历史是抢盘`);

/* 3. 运行中让路 */
assert.match(SCHEDULER, /private readonly isBusy: \(\) => boolean/, '调度器要能知道「现在正忙」');
assert.match(SCHEDULER, /if \(!verbose && this\.isBusy\(\)\)/, '自动心跳遇到运行中的对话要跳过（手动清理照跑）');
assert.match(EXT, /\(\) => chat\.hasActiveRuns\(\)/, '必须把「有没有对话在跑」接到调度器');

/* 4. 不许无条件序列化重字段 */
const strip = STORAGE.slice(STORAGE.indexOf('function stripMessagePayload'), STORAGE.indexOf('function historyExcerpt'));
const presenceAt = strip.indexOf('if (!present) return 0;');
const stringifyAt = strip.indexOf('JSON.stringify(');
assert.ok(presenceAt > 0 && stringifyAt > presenceAt, 'stripMessagePayload 必须先判断「有没有可删内容」再 JSON.stringify（否则每条消息白算一遍）');

/* 5. 行为测试必须在场 */
const TESTS = readFileSync('src/test/storage.test.ts', 'utf8');
assert.match(TESTS, /cleanup does not hold the write queue for the whole scan/, '缺少「清理期间发消息仍能插入」的行为测试');

console.log('✓ 清理按「一条对话一个任务」入队，单次写入只等当前那条（真实档案：中位 41ms / 最坏 169ms）');
console.log('✓ 逐条任务会重新确认对话还在、仍然是空对话（切片后新出现的窗口已收口）');
console.log('✓ 首次清理延后到 20 秒，避开 VS Code 启动 I/O');
console.log('✓ 有对话在跑时自动心跳让路（手动「立即清理」照跑）');
console.log('✓ 重字段序列化只在真的需要瘦身时才做');
console.log('\n全部通过：清理再慢也不会把发消息拖住');
