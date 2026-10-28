import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import {
  DEFAULT_SEARCH_EXCLUDED_DIRS,
  invalidateWorkspaceSearch,
  searchWorkspace,
  workspaceSearchStats,
} from '../agent/workspaceSearch';
import { setWorkspaceRoots } from './support/vscodeMock';
import { AuditLog } from '../agent/auditLog';
import { ToolExecutor } from '../agent/toolExecutor';
import { ChatSettings } from '../core/types';

/**
 * 算法级 A/B 基准（不是真机 CPU 采样）。
 *
 * 对比的是同一份 fixture 上的两条路径：
 * - 「旧」：每次调用都直接 `workspace.findFiles` + 逐行 `toLocaleLowerCase`；
 * - 「新」：走统一调度层（去重/缓存）+ 整篇小写后提前跳过。
 *
 * 断言只钉确定性事实（真实搜索次数、命中结果一致），耗时只打印不判定——
 * CI 机器负载不可控，拿时间做断言只会变成随机失败。
 * 运行：`node --test out/test/perfSearch.test.js`
 */

let workspaceRoot: string;
let root: string;
let executor: ToolExecutor;
const EXCLUDE = `**/{${DEFAULT_SEARCH_EXCLUDED_DIRS.join(',')}}/**`;
const QUERY = 'needleSymbol';

before(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'hwchat-bench-'));
  root = join(workspaceRoot, 'project');
  const body = Array.from({ length: 40 }, (_, index) => `export const value${index} = ${index};`).join('\n');
  const filler = `${body}\n${'// padding line to make the scan realistic\n'.repeat(20)}`;
  for (let index = 0; index < 400; index += 1) {
    const path = join(root, 'src', `mod${index}.ts`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, index % 40 === 0 ? `${filler}\nexport const ${QUERY} = true;\n` : filler, 'utf8');
  }
  for (let index = 0; index < 200; index += 1) {
    const path = join(root, 'node_modules', 'dep', `lib${index}.js`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${filler}\nexport const ${QUERY} = false;\n`, 'utf8');
  }
  setWorkspaceRoots([root]);
  executor = new ToolExecutor(new AuditLog(join(workspaceRoot, 'audit.jsonl')), () => true);
});

after(async () => {
  executor.dispose();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function settings(): ChatSettings {
  return {
    apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid', models: ['deepseek-chat'], requestHeaders: {} }],
    activeApiProfileId: 'default', baseUrl: 'https://example.invalid', model: 'deepseek-chat',
    temperature: 0, maxTokens: 0, systemPrompt: '', sendOnEnter: true, historyRetentionDays: 30,
    taskCacheRetentionHours: 24, cacheBudgetMB: 100, cleanupIntervalMinutes: 10, maxMessagesInContext: 20,
    requestHeaders: {}, requestTimeoutSeconds: 30, defaultMode: 'agent', agentMaxSteps: 24,
    reasoningEffort: 'default', permissionPreset: 'review', fileReadPolicy: 'allow',
    fileWritePolicy: 'allow', commandPolicy: 'allow', dangerousCommandPolicy: 'ask',
    sensitiveFilePolicy: 'deny', maxReadBytes: 512_000, maxToolOutputBytes: 200_000,
    maxCommandSeconds: 120, auditRetentionDays: 30, language: 'auto',
  };
}

async function searchFiles(query: string): Promise<{ summary: string; content: string }> {
  return executor.execute(
    { id: `bench-${Math.random()}`, type: 'function', function: { name: 'search_files', arguments: JSON.stringify({ query }) } },
    'agent',
    settings(),
    async () => true,
    'bench-conversation',
    { projectRoot: root },
  );
}

/** 旧实现的扫描：每行都做一次 locale 感知的小写转换。 */
async function legacyScan(files: vscode.Uri[]): Promise<number> {
  const needle = QUERY.toLowerCase();
  let matches = 0;
  for (const uri of files) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: false }).decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.toLocaleLowerCase().includes(needle)) matches += 1;
    }
  }
  return matches;
}

async function measure(run: () => Promise<number>): Promise<{ matches: number; wallMs: number; cpuMs: number }> {
  const cpuBefore = process.cpuUsage();
  const startedAt = process.hrtime.bigint();
  const matches = await run();
  const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const cpu = process.cpuUsage(cpuBefore);
  return { matches, wallMs, cpuMs: (cpu.user + cpu.system) / 1000 };
}

test('perf A/B: ten identical searches go from ten real scans to one', async () => {
  // 旧路径：每次调用都真的搜一次、扫一次。
  const legacy = await measure(async () => {
    let matches = 0;
    for (let index = 0; index < 10; index += 1) {
      const files = await vscode.workspace.findFiles('**/*', EXCLUDE, 1_000);
      matches += await legacyScan(files);
    }
    return matches;
  });

  invalidateWorkspaceSearch();
  const before = executor.resourceStats();
  const modern = await measure(async () => {
    let matches = 0;
    for (let index = 0; index < 10; index += 1) {
      const result = await searchFiles(QUERY);
      matches += Number(/找到 (\d+) 处匹配|Found (\d+) matches/.exec(result.summary)?.slice(1).find(Boolean) ?? 0);
    }
    return matches;
  });
  const after = executor.resourceStats();
  const realScans = after.contentSearches - before.contentSearches;
  const cacheHits = after.contentSearchCacheHits - before.contentSearchCacheHits;
  const realListings = (workspaceSearchStats()?.completed ?? 0);

  console.log(`[bench] legacy: real listings=10 wall=${legacy.wallMs.toFixed(0)}ms cpu=${legacy.cpuMs.toFixed(0)}ms matches=${legacy.matches}`);
  console.log(`[bench] new:    real listings=${realListings} content scans=${realScans} cache hits=${cacheHits} wall=${modern.wallMs.toFixed(0)}ms cpu=${modern.cpuMs.toFixed(0)}ms matches=${modern.matches}`);

  assert.equal(realScans, 1, '十次相同查询只应真正扫描一次');
  assert.equal(cacheHits, 9, '其余九次必须由结果缓存提供');
  assert.equal(modern.matches, legacy.matches, '去重与缓存不能改变搜索结果');
});

test('perf A/B: the wider default exclusion list removes virtualenv/cache/toolchain files', async () => {
  // 注意别用 `build` 之类的名字做子目录：它本身就在旧排除列表里，会污染对比。
  const extraDirs = ['.venv/lib', '__pycache__/mod', 'DerivedData/arm64', '.turbo/cache'];
  for (const directory of extraDirs) {
    for (let index = 0; index < 150; index += 1) {
      const path = join(root, directory, `f${index}.txt`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `generated artifact ${index}\n`, 'utf8');
    }
  }
  const OLD_EXCLUDE = '**/{.git,node_modules,dist,build,out,.next,coverage}/**';

  const cpuBeforeOld = process.cpuUsage();
  const startedOld = process.hrtime.bigint();
  const oldList = await vscode.workspace.findFiles('**/*', OLD_EXCLUDE, 10_000);
  const oldMs = Number(process.hrtime.bigint() - startedOld) / 1e6;
  const oldCpu = process.cpuUsage(cpuBeforeOld);

  invalidateWorkspaceSearch();
  const startedNew = process.hrtime.bigint();
  const newList = await searchWorkspace({ include: '**/*', limit: 10_000 });
  const newMs = Number(process.hrtime.bigint() - startedNew) / 1e6;

  console.log(`[bench] old excludes: files=${oldList.length} wall=${oldMs.toFixed(0)}ms cpu=${((oldCpu.user + oldCpu.system) / 1000).toFixed(0)}ms`);
  console.log(`[bench] new excludes: files=${newList.outcome.files.length} wall=${newMs.toFixed(0)}ms`);

  assert.ok(oldList.length >= newList.outcome.files.length + 600, '新排除列表应少扫至少 600 个生成物文件');
  for (const directory of ['.venv/', '__pycache__/', 'DerivedData/', '.turbo/']) {
    assert.equal(newList.outcome.files.some((uri) => uri.fsPath.includes(directory)), false, `${directory} 不应被扫描`);
  }
});

test('perf A/B: default exclusions keep dependency directories out of the scan', async () => {
  invalidateWorkspaceSearch();
  const result = await searchWorkspace({ include: '**/*', limit: 5_000 });
  const withDeps = result.outcome.files.filter((uri) => uri.fsPath.includes('node_modules')).length;
  assert.equal(withDeps, 0, '依赖目录不应进入扫描列表');
  assert.ok(result.outcome.files.length >= 400);
  console.log(`[bench] files scanned by HWChat: ${result.outcome.files.length} (node_modules excluded)`);
});
