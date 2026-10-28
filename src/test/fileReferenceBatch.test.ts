import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import {
  MAX_MERGED_SEARCH_NAMES,
  buildMergedInclude,
  isBraceListSafe,
  planMergedSearch,
  referenceCacheKey,
  resolveFileReferences,
  type ReferenceCacheEntry,
  type ReferenceQuery,
  type ReferenceSearchRequest,
} from '../agent/fileReferenceBatch';

/**
 * 现场回归：一条总结消息里有几十个裸文件名，HWChat 为每个名字各搜一次
 * 17 根工作区（每次约 1.7 秒、76% 是内核 sys 时间），未命中的名字每 10 秒
 * 又重搜一遍 —— 消息只是显示在屏幕上，整机 CPU 就长期 96–99%。
 *
 * 这些用例统计的是**真实发出的搜索请求数**，不是日志文字。
 */

const ROOT = '/workspace/project';
const OTHER = '/workspace/other';

function memoryCache() {
  const map = new Map<string, ReferenceCacheEntry>();
  return {
    map,
    get: (key: string) => map.get(key),
    set: (key: string, value: string | undefined) => map.set(key, { value, at: Date.now() }),
  };
}

function countingSearch(files: string[]) {
  const requests: ReferenceSearchRequest[] = [];
  return {
    requests,
    search: async (request: ReferenceSearchRequest): Promise<string[] | undefined> => {
      requests.push(request);
      const names = new Set([...(request.include.match(/\{([^}]*)\}/)?.[1] ?? request.include.replace(/^\*\*\//, '')).split(',')]);
      // 尊重 folder：真实实现里 `folder` 会把搜索限制在该根内，替身也必须照做，
      // 否则「先搜项目根、找不到再扩大」这条行为在测试里根本不会被执行到。
      return files.filter((file) => names.has(file.split('/').pop() ?? '')
        && (!request.folder || file.startsWith(`${request.folder}/`)));
    },
  };
}

test('forty bare filenames trigger exactly one merged search', async () => {
  const files = Array.from({ length: 40 }, (_, index) => `${ROOT}/src/mod${index}.ts`);
  const queries: ReferenceQuery[] = files.map((file, index) => ({
    index,
    path: file.split('/').pop()!,
    preferred: ROOT,
  }));
  const cache = memoryCache();
  const { requests, search } = countingSearch(files);

  const resolved = await resolveFileReferences(queries, {
    roots: [ROOT],
    missTtlMs: 600_000,
    cache,
    exists: (candidate) => files.includes(candidate),
    search,
  });

  assert.equal(requests.length, 1, `40 个裸文件名只应发 1 次搜索，实际 ${requests.length} 次`);
  assert.match(requests[0]!.include, /^\*\*\/\{.*\}$/, '应当是一次花括号合并搜索');
  assert.equal(resolved.filter(Boolean).length, 40, '40 个引用都应解析成绝对路径');
  assert.ok(resolved.every((value) => value?.startsWith(ROOT)), '解析结果必须落在项目根内');
});

test('duplicate names collapse and unsafe names never enter the merged glob', () => {
  const plan = planMergedSearch([
    { index: 0, path: 'settings.ts' },
    { index: 1, path: 'settings.ts' },
    { index: 2, path: 'a[1].ts' },
    { index: 3, path: 'b,c.ts' },
    { index: 4, path: 'src/nested.ts' },
  ]);
  assert.deepEqual(plan, [{ name: 'settings.ts', indices: [0, 1] }]);
  assert.equal(isBraceListSafe('b,c.ts'), false);
  assert.equal(isBraceListSafe('a[1].ts'), false);
  assert.equal(buildMergedInclude(['a.ts']), '**/a.ts');
  assert.equal(buildMergedInclude(['a.ts', 'b.ts']), '**/{a.ts,b.ts}');
});

test('the merged search is capped so a pathological message cannot explode', () => {
  const queries: ReferenceQuery[] = Array.from({ length: 200 }, (_, index) => ({
    index,
    path: `file${index}.ts`,
  }));
  const plan = planMergedSearch(queries);
  assert.equal(plan.length, MAX_MERGED_SEARCH_NAMES);
  const include = buildMergedInclude(plan.map((item) => item.name))!;
  assert.ok(include.split(',').length <= MAX_MERGED_SEARCH_NAMES);
});

test('a miss is cached, so re-rendering the same message searches nothing', async () => {
  const cache = memoryCache();
  const { requests, search } = countingSearch([]);
  const queries = [{ index: 0, path: 'does-not-exist.ts', preferred: ROOT }];
  const options = {
    roots: [ROOT],
    missTtlMs: 600_000,
    cache,
    exists: () => false,
    search,
  };

  const first = await resolveFileReferences(queries, options);
  assert.deepEqual(first, [null]);
  // 阶段 1（项目根）+ 阶段 2（全部根）：一次核实最多两次，与名字个数无关。
  const afterFirst = requests.length;
  assert.ok(afterFirst > 0 && afterFirst <= 2, `实际 ${afterFirst} 次`);

  const second = await resolveFileReferences(queries, options);
  assert.deepEqual(second, [null]);
  assert.equal(requests.length, afterFirst, '10 分钟内重复渲染不得再搜一次');
  assert.equal(cache.map.get(referenceCacheKey(ROOT, 'does-not-exist.ts'))?.value, undefined);
});

test('a miss expires after the TTL so a newly created file becomes visible', async () => {
  const cache = memoryCache();
  let exists = false;
  const files = [`${ROOT}/src/created.ts`];
  const { requests, search } = countingSearch(files);
  const queries = [{ index: 0, path: 'created.ts', preferred: ROOT }];

  await resolveFileReferences(queries, {
    roots: [ROOT], missTtlMs: 1_000, cache, exists: () => exists, search,
  });
  const afterFirst = requests.length;
  assert.ok(afterFirst > 0);

  exists = true;
  const afterTtl = await resolveFileReferences(queries, {
    roots: [ROOT], missTtlMs: 0, cache, exists: () => exists, search,
  });
  assert.deepEqual(afterTtl, [`${ROOT}/created.ts`]);
  assert.equal(requests.length, afterFirst, '文件已存在时走 existsSync，不需要再搜');
});

test('candidates already on disk never reach the search layer', async () => {
  const cache = memoryCache();
  const { requests, search } = countingSearch([]);
  const resolved = await resolveFileReferences(
    [{ index: 0, path: 'package.json', preferred: ROOT }],
    {
      roots: [ROOT],
      missTtlMs: 600_000,
      cache,
      exists: (candidate) => candidate === join(ROOT, 'package.json'),
      search,
    },
  );
  assert.deepEqual(resolved, [join(ROOT, 'package.json')]);
  assert.equal(requests.length, 0, '确定性命中不该启动 ripgrep');
});

test('a project-root hit avoids the whole-workspace pass entirely', async () => {
  const cache = memoryCache();
  const files = [`${ROOT}/src/target.ts`];
  const { requests, search } = countingSearch(files);
  const queries: ReferenceQuery[] = [
    { index: 0, path: 'target.ts', preferred: ROOT },
    { index: 1, path: 'missing.ts', preferred: ROOT },
  ];

  const resolved = await resolveFileReferences(queries, {
    roots: [ROOT, OTHER],
    missTtlMs: 600_000,
    cache,
    exists: (candidate) => files.includes(candidate),
    search,
  });

  assert.equal(resolved[0], `${ROOT}/src/target.ts`);
  assert.equal(resolved[1], null);
  // 阶段 1（项目根）里 missing.ts 没找到 → 阶段 2 才会扩大到全部根，
  // 但阶段 2 只针对**仍未解析**的名字，一共最多 2 次搜索。
  assert.equal(requests[0]!.folder, ROOT, '第一次必须只搜项目根');
  assert.ok(requests.length <= 2, `最多两次搜索，实际 ${requests.length}`);
  assert.equal(requests.at(-1)!.folder, undefined);
});

test('references survive when the file lives only in another root', async () => {
  const cache = memoryCache();
  const files = [`${OTHER}/deep/file.ts`];
  const { requests, search } = countingSearch(files);
  const resolved = await resolveFileReferences(
    [{ index: 0, path: 'file.ts', preferred: ROOT }],
    { roots: [ROOT, OTHER], missTtlMs: 600_000, cache, exists: (candidate) => files.includes(candidate), search },
  );
  assert.equal(resolved[0], `${OTHER}/deep/file.ts`, '项目根没找到时要继续在整个工作区找');
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.folder, ROOT);
});

test('names beyond the merge cap degrade instead of triggering extra searches', async () => {
  const cache = memoryCache();
  const { requests, search } = countingSearch([]);
  const queries: ReferenceQuery[] = Array.from({ length: MAX_MERGED_SEARCH_NAMES + 10 }, (_, index) => ({
    index,
    path: `file${index}.ts`,
    preferred: ROOT,
  }));

  const resolved = await resolveFileReferences(queries, {
    roots: [ROOT],
    missTtlMs: 600_000,
    cache,
    exists: () => false,
    search,
  });

  // 全部未命中：阶段 1 + 阶段 2，与引用个数无关。
  assert.ok(requests.length <= 2, `超上限也必须收敛到 ≤2 次搜索，实际 ${requests.length}`);
  assert.equal(resolved.length, MAX_MERGED_SEARCH_NAMES + 10);
  assert.ok(resolved.every((value) => value === null));
});

test('item count is bounded per verification request', async () => {
  const cache = memoryCache();
  const { search } = countingSearch([]);
  const queries: ReferenceQuery[] = Array.from({ length: 500 }, (_, index) => ({
    index,
    path: `n${index}.ts`,
    preferred: ROOT,
  }));
  const resolved = await resolveFileReferences(queries, {
    roots: [ROOT],
    missTtlMs: 600_000,
    cache,
    exists: () => false,
    search,
    maxItems: 80,
  });
  assert.equal(resolved.length, 80);
});
