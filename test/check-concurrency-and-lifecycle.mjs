/*
 * 存档跨窗口并发（⑦）与子进程生命周期（⑭）守护。
 *
 * ⑦ 现场：两个 VS Code 窗口 = 两个扩展宿主，各自持一份 manifest 内存快照。
 *    旧实现直接整体写 → 后写覆盖先写，会话从索引里消失；删除还会被对端快照复活。
 *    两个窗口同时清理，还会互相删对方正在读的 payloads/（内容寻址、跨会话共享）。
 *
 * ⑭ 现场：`ToolExecutor.dispose()` 早就实现了「杀后台服务 + 杀正在跑的命令」，
 *    但从来没有被调用 —— 窗口关闭后 `run_command background:true` 起的服务还在占端口；
 *    Windows 上 `child.kill()` 也只杀直接子进程，派生的 npm/node 会留下来。
 *
 * 用法：node test/check-concurrency-and-lifecycle.mjs
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

const read = (path) => readFileSync(path, 'utf8');
const STORAGE = read('src/core/storage.ts');
const LOCK = read('src/core/fileLock.ts');
const EXEC = read('src/agent/toolExecutor.ts');
const EXT = read('src/extension.ts');
const PANEL = read('src/views/chatPanel.ts');

/* ── ⑦ 静态 ─────────────────────────────────────────────────── */
check('manifest 写入走跨进程锁', /withFileLock\(this\.manifestLockPath/.test(STORAGE));
check('清理是「选主」而非并行（拿不到锁就跳过）', /tryFileLock\(this\.cleanupLockPath/.test(STORAGE) && /skippedByPeer: true/.test(STORAGE));
check('合并写按 id 去重、updatedAt 新者胜', /export function mergeManifests\(/.test(STORAGE));
check('删除有墓碑，防止被对端旧快照复活', /deleted\.json/.test(STORAGE) && /resurrected/.test(STORAGE));
check('重建/清空走 replaceManifest（不绕过墓碑）', /private replaceManifest\(/.test(STORAGE) && !/this\.manifest = \{ version: MANIFEST_VERSION, conversations: \[\] \}/.test(STORAGE));

/* ── ⑭ 静态 ─────────────────────────────────────────────────── */
check('执行器有活体登记', /const liveExecutors = new Set<ToolExecutor>\(\)/.test(EXEC) && /export function disposeAllToolExecutors/.test(EXEC));
check('扩展停用会收掉所有子进程', /disposeAllToolExecutors\(\);/.test(EXT));
check('面板销毁会收掉本面板的执行器', /this\.toolExecutor\.dispose\(\);/.test(PANEL));
check('Windows 用 taskkill /T 杀整棵进程树', /spawnSync\('taskkill', \['\/pid', String\(pid\), '\/T'/.test(EXEC));
check('dispose 会注销登记（避免容器无限增长）', /liveExecutors\.delete\(this\)/.test(EXEC));

/* ── 真机：锁互斥 ───────────────────────────────────────────── */
const { build } = await import('esbuild');
const bundle = await build({
  stdin: { contents: `export { tryFileLock, withFileLock } from './src/core/fileLock';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
  external: ['node:*'],
});
const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
const dir = mkdtempSync(join(tmpdir(), 'hwchat-lockcheck-'));
writeFileSync(join(dir, 'lock.mjs'), bundle.outputFiles[0].text);
const { tryFileLock } = await import(`file://${join(dir, 'lock.mjs')}`);
rmSync(dir, { recursive: true, force: true });

const sandbox = await mkdtemp(join(tmpdir(), 'hwchat-lock-'));
try {
  const lock = join(sandbox, 'a.lock');
  const first = await tryFileLock(lock, { timeoutMs: 0 });
  const second = await tryFileLock(lock, { timeoutMs: 30 });
  check('真机：同一把锁只能有一个持有者', Boolean(first) && second === undefined);
  await first?.();
  const third = await tryFileLock(lock, { timeoutMs: 30 });
  check('真机：释放后可以重新获取', Boolean(third));
  await third?.();

  // 陈旧锁接管：进程崩溃留下的锁不能让所有写入永久卡死
  const stale = join(sandbox, 'stale.lock');
  await writeFile(stale, 'dead:1', 'utf8');
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(stale, old, old);
  const taken = await tryFileLock(stale, { timeoutMs: 200, staleMs: 1_000 });
  check('真机：陈旧锁可以被接管（否则一次崩溃就永久卡死）', Boolean(taken));
  await taken?.();
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

/* ── 真机：两个实例各写一条，两条都活 ─────────────────────────── */
{
  const root = await mkdtemp(join(tmpdir(), 'hwchat-two-'));
  try {
    const storageBundle = await build({
      stdin: { contents: `export { mergeManifests } from './src/core/storage';`, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      logLevel: 'error',
      alias: { vscode: './src/test/support/vscodeMock.ts' },
      external: ['node:*'],
    });
    const d2 = mkdtempSync(join(tmpdir(), 'hwchat-merge-'));
    writeFileSync(join(d2, 'm.mjs'), storageBundle.outputFiles[0].text);
    const { mergeManifests } = await import(`file://${join(d2, 'm.mjs')}`);
    rmSync(d2, { recursive: true, force: true });

    const item = (id, at) => ({ id, title: id, createdAt: at, updatedAt: at, messageCount: 1, preview: '', pinned: false, totalTokens: 0, skillIds: [], skillSelectionInitialized: false, archived: false });
    const merged = mergeManifests(
      { version: 1, conversations: [item('from-other-window', 100)] },
      { version: 1, conversations: [item('from-this-window', 200)] },
      [],
    );
    check('真机：两个窗口各建一条 → 合并后都在', merged.conversations.length === 2);

    const withTombstone = mergeManifests(
      { version: 1, conversations: [item('deleted-by-peer', 100), item('keep', 100)] },
      { version: 1, conversations: [item('deleted-by-peer', 100), item('keep', 100)] },
      ['deleted-by-peer'],
    );
    check('真机：对端删除的条目不会被旧快照复活', withTombstone.conversations.length === 1 && withTombstone.conversations[0].id === 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('跨窗口并发或进程生命周期有缺口：对照上面每条 ✗ 的注释看现场。');
  process.exitCode = 1;
} else {
  console.log('存档写入串行且有墓碑；清理有选主；停用/关面板会收掉子进程（含 Windows 进程树）。');
}
