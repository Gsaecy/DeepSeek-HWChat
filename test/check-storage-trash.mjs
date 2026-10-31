// 存储安全规则：「只有用户能销毁对话，HWChat 不会自己吞掉」。
//
// 现场（用户 2026-10-31）：
//   「今天的某次更新，把我的归档和对话记录列表的某条记录删掉了，
//     之前对话记录有 2 条，归档记录有十几条。」
//
// 磁盘取证：`history-v1/manifest.json` 只剩 4 条 / 3 条归档，而 Oct 27 残留的
// `manifest.json.*.tmp` 里是 **15 条 / 13 条归档**；`conversations/` 只剩 4 个目录，
// `~/.Trash` 里没有 —— 13 条被 `rm -rf` 物理删除，HWChat 存储已无法恢复。
//
// 之后的规则由用户明确下来：
//   「用户可以在设置里自己清除归档的内容，但 HWChat 不能自己吞掉对话。」
//
// 这条规则在本文件里被拆成可机械检查的不变量：
//   1. 自动清理不删除、不搬走任何带内容的对话（只瘦身缓存、只整理空对话）；
//   2. 带内容的对话只在用户「清空回收站 / 清除本地数据」时才会被销毁；
//   3. 搬运失败时宁可删不掉，也不能丢内容；
//   4. 归档状态落盘，manifest 损坏或过期都不会让归档变成可删；
//   5. 启动时对比上次的归档清单，无故消失立刻告警。
//
// 运行：node test/check-storage-trash.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('src/core/storage.ts', 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 取一个**方法定义**的方法体（类里两格缩进的那一行）。
 *
 * 必须锚定行首缩进：同名方法在别处也作为调用出现，裸 `search` 会切到调用点上，
 * 断言就变成了在测另一段代码。
 */
function methodBody(name) {
  const index = CODE.search(new RegExp(`\\n  (?:private |public )?(?:async )?${name}\\s*\\(`));
  assert.ok(index >= 0, `storage.ts 里找不到 ${name} 的方法定义`);
  const end = CODE.indexOf('\n  }', index);
  assert.ok(end > index, `${name} 的方法体没有正常结束`);
  return CODE.slice(index, end);
}

// 1. 自动清理不许让任何带内容的对话离开列表。
const cleanup = methodBody('cleanup');
assert.doesNotMatch(cleanup, /this\.destroyConversation\(/, 'cleanup() 不许销毁对话目录');
assert.doesNotMatch(
  cleanup,
  /this\.moveToTrash\([^)]*'(expired|budget)'\)/,
  'cleanup() 不许按「超期」「超预算」把对话搬走：那正是用户报告丢数据的路径',
);
assert.match(cleanup, /overBudget/, '超预算只能报告，不能作为删除理由');
assert.match(cleanup, /isEmptyDraftConversation/, 'cleanup() 只允许整理空对话（0 条消息，没有内容可丢）');

// 2. 用户删除 = 进回收站；只有清空回收站才是真删。
const del = methodBody('deleteConversation');
assert.match(del, /this\.moveToTrash\(/, '用户删除必须先进回收站');
assert.match(del, /trashFailed/, '搬不进回收站必须抛错并保持原样');

const purge = methodBody('purgeTrash');
assert.match(purge, /this\.destroyTrashEntry\(/, 'purgeTrash() 才是用户清空回收站的入口');
assert.match(purge, /entryIds/, 'purgeTrash() 要支持只清指定几条');

// 3. `conversations/` 下没有任何一条路径会直接 rm 对话目录：
//    删除一律是「搬进回收站」，只有清空回收站/清除全部数据才销毁。
assert.equal(
  [...CODE.matchAll(/rm\(\s*this\.conversationDirectory/g)].length,
  0,
  '不许直接 rm 对话目录：先搬进回收站，销毁只发生在回收站里',
);
assert.equal(
  [...CODE.matchAll(/rm\(\s*this\.conversationsPath/g)].length,
  1,
  '`rm(conversationsPath)` 只允许在 clearAll（用户点「清除本地数据」）里出现一次',
);
const clearAll = methodBody('clearAll');
assert.match(clearAll, /rm\(\s*this\.conversationsPath/, 'clearAll 就是那个唯一入口');
assert.equal(
  [...CODE.matchAll(/rm\(\s*join\(this\.trashPath/g)].length,
  1,
  '回收站里的销毁只允许出现在 destroyTrashEntry()',
);
assert.match(methodBody('destroyTrashEntry'), /rm\(\s*join\(this\.trashPath/, 'destroyTrashEntry() 是回收站销毁入口');

// 4. 搬运失败宁可删不掉，也不能丢内容。
const move = methodBody('moveToTrash');
assert.match(move, /Promise<boolean>/, 'moveToTrash 必须返回是否搬成功');
assert.match(move, /if \(!moved\) \{[\s\S]*?return false;/, '搬运失败时必须直接返回 false');
assert.doesNotMatch(
  move,
  /cp\([\s\S]*?\.catch\(\(\) => undefined\)[\s\S]*?await rm\(source/,
  '拷贝失败后不许继续删源目录',
);
assert.match(methodBody('copyDirectoryVerified'), /copied === expectedMessages/, '拷贝必须核对消息文件数才算成功');

// 5. 回收站不再有「到期自动清理」：清理工具不能替用户决定销毁。
assert.doesNotMatch(cleanup, /pruneTrash|purgeTrash/, '自动清理不许动回收站');
assert.doesNotMatch(CODE, /TRASH_KEEP_ENTRIES|TRASH_KEEP_DAYS/, '回收站不许有「保留 N 天/N 条自动删除」的上限');

// 6. 归档状态落盘，四个读写路径都要认标记文件。
assert.match(CODE, /ARCHIVED_MARKER\s*=\s*'\.archived'/, '必须用 .archived 标记文件记录归档状态');
for (const method of ['setArchived', 'rebuildManifestFromDisk', 'reconcileManifest', 'reconcileArchiveMarkers']) {
  assert.match(
    methodBody(method),
    /ARCHIVED_MARKER|archivedMarkerPath/,
    `${method}() 必须考虑 .archived 标记`,
  );
}
assert.match(methodBody('reconcileArchiveMarkers'), /markerExists && !summary\.archived/, '标记存在时必须把摘要纠正为 archived: true');
assert.doesNotMatch(
  methodBody('reconcileArchiveMarkers'),
  /summary\.archived = false/,
  '绝不因为「没有标记」就清掉归档状态：老存档没有标记文件，那会把已归档的对话丢回可删状态',
);

// 7. 启动时的归档守护：无故消失必须告警。
assert.match(CODE, /interface SafetySnapshot/, '必须有归档守护快照');
assert.match(methodBody('checkArchivedIntegrity'), /previous\.archived\.filter/, '启动时必须对比上次的归档清单');
assert.match(methodBody('checkArchivedIntegrity'), /!live\.has\(item\.id\) && !trashed\.has\(item\.id\)/, '判定标准：既不在磁盘、也不在回收站');
for (const method of ['setArchived', 'deleteConversation', 'clearAll', 'restoreFromTrash']) {
  assert.match(methodBody(method), /persistSafetySnapshot\(/, `${method}() 之后必须刷新守护快照，否则会误报`);
}

console.log('storage safety guard: ok');
