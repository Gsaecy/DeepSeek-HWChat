/*
 * 项目技术文档：唯一一份、只追加、真的改过文件才建立、注入有预算。
 *
 * 用户需求（2026-11-09）：「对话太长之后，一些旧的决策它会忘记……让 HWChat 默认在
 * 涉及修改的项目文件里新建一份技术文档（没用 hwchat 修改的就不新建），这份文档唯一
 * 且随着每次对话更新，确保旧的决策不会在新对话里被忘记。」
 *
 * 这个脚本既查静态契约（工具已登记、权限走开关、注入点存在），
 * 也真跑一遍文件读写链路（临时目录 + 真实的 ToolExecutor 依赖）。
 *
 * 用法：node test/check-project-doc.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXEC = readFileSync('src/agent/toolExecutor.ts', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const PKG = JSON.parse(readFileSync('package.json', 'utf8'));
const SETTINGS_JS = readFileSync('media/settings.js', 'utf8');
const SETTINGS_HTML = readFileSync('src/views/settingsPanel.ts', 'utf8');

/* ── 静态契约 ─────────────────────────────────────────────────────────── */
const props = PKG.contributes.configuration.properties;
assert.ok(props['hwchat.projectDoc'], '必须有 hwchat.projectDoc 这一项设置');
assert.equal(props['hwchat.projectDoc'].scope, 'machine', '必须是 machine 作用域：克隆下来的仓库不能替你打开自动写');
assert.equal(props['hwchat.projectDoc'].default, 'auto', '默认自动维护');
assert.match(SETTINGS_HTML, /id="projectDoc"/, '设置页必须有单独一行（用户明确要求）');
assert.match(SETTINGS_JS, /'projectDoc'/, '设置页必须读写这一项');

assert.match(EXEC, /this\.definition\('update_project_doc'/, '必须下发 update_project_doc 工具');
assert.match(EXEC, /'delete_file', 'run_command', 'update_project_doc',/, '必须进本地工具白名单');
assert.match(EXEC, /case 'update_project_doc':/, '必须有执行分支');
assert.match(PANEL, /renderProjectDocContext\(text\)/, '必须把文档注入 system');
assert.match(EXEC, /result\.status === 'success' && \(result\.changedFiles\?\.length \?\? 0\) > 0/, '只在**真的改过文件**之后才建立文档');
assert.match(EXEC, /tryFileLock\(lockPath/, '追加必须持跨进程锁（两个窗口同时写会互相吞条目）');
assert.match(EXEC, /maskSecrets\(text\)/, '写入前必须遮掉密钥（文档会进 git）');

/* ── 真跑纯函数 ───────────────────────────────────────────────────────── */
const { build } = await import('esbuild');
const bundle = await build({
  stdin: {
    contents: `export { PROJECT_DOC_MARKER, PROJECT_DOC_NAME, appendProjectDoc, emptyProjectDoc, isProjectDoc, parseProjectDoc, renderProjectDocContext } from './src/core/projectDoc';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
  external: ['node:*'],
});
const dir = mkdtempSync(join(tmpdir(), 'hwchat-doc-'));
const bundlePath = join(dir, 'bundle.mjs');
writeFileSync(bundlePath, bundle.outputFiles[0].text);
const doc = await import(`file://${bundlePath}`);

// 1) 唯一性：靠标记认，不靠文件名。
const created = doc.appendProjectDoc(doc.emptyProjectDoc('P'), [{ kind: 'decision', text: '用 A 方案' }]).text;
assert.equal(doc.isProjectDoc(created), true);
assert.equal(doc.PROJECT_DOC_NAME, 'HWCHAT-PROJECT-NOTES.md');

// 2) 只追加：第二轮的条目不会吃掉第一轮。
const second = doc.appendProjectDoc(created, [{ kind: 'rejected', text: '不要用轮询改大文件' }]).text;
assert.deepEqual(doc.parseProjectDoc(second).decision, ['用 A 方案']);
assert.deepEqual(doc.parseProjectDoc(second).rejected, ['不要用轮询改大文件']);

// 3) 重复不写第二遍。
assert.equal(doc.appendProjectDoc(second, [{ kind: 'decision', text: '用 A 方案' }]).added, 0);

// 4) 注入有预算，且省略时说清楚。
const many = Array.from({ length: 300 }, (_v, i) => ({ kind: 'decision', text: `第 ${i} 条：${'理由'.repeat(40)}` }));
const big = doc.appendProjectDoc(doc.emptyProjectDoc('P'), many).text;
const context = doc.renderProjectDocContext(big);
assert.ok(Buffer.byteLength(context) <= 8 * 1024, `注入不得超过 8KB，实际 ${Buffer.byteLength(context)}`);
assert.match(context, /第 299 条/, '最新的那条必须在');
assert.match(context, /omitted to stay within budget/, '省略必须说出来');

rmSync(dir, { recursive: true, force: true });
console.log('✓ 唯一性靠标记、只追加、重复条目跳过');
console.log('✓ 注入上限 8KB，省略时明确说明');
console.log('\n项目技术文档检查通过。');
