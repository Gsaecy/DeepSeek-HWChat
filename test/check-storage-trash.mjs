// 存储「自动删除」不许直接抹掉对话的回归检查。
//
// 现场（用户 2026-10-31 反馈）：
//   「今天的某次更新，把我的归档和对话记录列表的某条记录删掉了，
//     之前对话记录有 2 条，归档记录有十几条。」
//
// 磁盘取证结果：
//   - `history-v1/manifest.json` 只剩 4 条对话 / 3 条归档；
//   - 同目录 Oct 27 遗留的 `manifest.json.*.tmp` 里是 **15 条 / 13 条归档**；
//   - `conversations/` 只剩 4 个目录，`~/.Trash` 里没有 —— 13 条是被 `rm -rf` 物理删除的。
//
// 两条独立的失效链，都必须守住：
//
//   1. **删除不可逆**：自动清理（空草稿 / 超期 / 预算回收）用完 `rm -rf` 就彻底没了，
//      用户没有任何找回手段。现在一律先 `moveToTrash`。
//   2. **归档保护依赖内存**：预算回收读的是 `summary.archived`。manifest 读不出来时
//      `rebuildManifestFromDisk()` 把一切重建成 `archived: false`；manifest 主文件坏了
//      还会回退到 `manifest.json.bak`（那是**上一次**写盘的内容，可能正好是归档之前）。
//      保护一失效，80MB 级的活跃对话就会把归档对话挤出预算。现在 `.archived` 标记落盘，
//      启动时用标记校正摘要。
//
// 运行：node test/check-storage-trash.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('src/core/storage.ts', 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 取一个**方法定义**的方法体（类里两格缩进的那一行）。
 *
 * 必须锚定行首缩进：`slimConversation(` 在 `cleanup()` 里也作为调用出现过，
 * 裸 `search` 会切到调用点上去，断言就变成了在测另一段代码。
 */
function methodBody(name) {
  const index = CODE.search(new RegExp(`\\n  (?:private |public )?(?:async )?${name}\\s*\\(`));
  assert.ok(index >= 0, `storage.ts 里找不到 ${name} 的方法定义`);
  const end = CODE.indexOf('\n  }', index);
  assert.ok(end > index, `${name} 的方法体没有正常结束`);
  return CODE.slice(index, end);
}

// 1. 三个自动删除点都必须走回收站。
const cleanup = methodBody('cleanup');
const trashed = cleanup.match(/this\.moveToTrash\(/g) ?? [];
assert.ok(
  trashed.length >= 4,
  `cleanup() 里应当有 4 处 moveToTrash（空草稿 x2、超期、预算回收），实际 ${trashed.length} 处`,
);
assert.doesNotMatch(
  cleanup,
  /rm\(\s*this\.conversationDirectory/,
  'cleanup() 不许直接 rm 对话目录：自动删除必须先进回收站',
);

// 2. 预算回收必须先瘦身再删，且瘦身要削掉 base64 / 工具输出这类可再生的缓存。
assert.match(cleanup, /await this\.slimConversation\(/, '预算回收必须先调用 slimConversation()');
const slimIndex = cleanup.indexOf('await this.slimConversation(');
const evictIndex = cleanup.search(/await this\.moveToTrash\(summary\.id, summary, 'budget'\)/);
assert.ok(slimIndex >= 0 && evictIndex > slimIndex, '必须先全部瘦身完，才允许删除整条对话');

const slim = methodBody('slimConversation');
assert.match(slim, /stripMessagePayload\(/, '瘦身必须复用 stripMessagePayload()，与保留期压缩保持同一字段集合');
assert.match(slim, /before - after/, '瘦身必须按文件真实大小记账');

const strip = CODE.slice(CODE.indexOf('function stripMessagePayload'));
for (const field of ['dataBase64', 'thumbnailDataUrl', 'delete tool.input', 'delete tool.output', 'delete message.reasoning']) {
  assert.ok(strip.includes(field), `stripMessagePayload() 应当删掉 ${field}`);
}

// 3. 归档标记必须落盘、并在启动时反过来校正摘要。
assert.match(CODE, /ARCHIVED_MARKER\s*=\s*'\.archived'/, '必须用 .archived 标记文件记录归档状态');
for (const method of ['setArchived', 'rebuildManifestFromDisk', 'reconcileManifest', 'reconcileArchiveMarkers']) {
  assert.match(
    methodBody(method),
    /ARCHIVED_MARKER|archivedMarkerPath/,
    `${method}() 必须考虑 .archived 标记`,
  );
}
assert.match(
  methodBody('reconcileArchiveMarkers'),
  /markerExists && !summary\.archived/,
  '标记存在时必须把摘要纠正为 archived: true',
);
assert.doesNotMatch(
  methodBody('reconcileArchiveMarkers'),
  /summary\.archived = false/,
  '绝不因为「没有标记」就清掉归档状态：老存档没有标记文件，那会把用户已归档的对话丢回可删状态',
);

// 4. 回收站自身必须有上限，否则「不删除」等于磁盘只增不减。
assert.match(CODE, /TRASH_KEEP_ENTRIES/, '回收站需要条数上限');
assert.match(CODE, /TRASH_KEEP_DAYS/, '回收站需要保留天数上限');
assert.match(methodBody('pruneTrash'), /rm\(/, '回收站到期才真正删除');

// 5. 用户主动删除仍然是立即删除（有明确意图，不该在回收站留一份假象）。
assert.match(
  methodBody('deleteConversation'),
  /rm\(\s*this\.conversationDirectory/,
  '用户主动删除应当立即删除，不进回收站',
);

console.log('storage trash guard: ok');
