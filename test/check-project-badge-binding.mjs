/*
 * 项目徽标「已绑定」的判据（用户 2026-11-09，Windows 现场）。
 *
 * 现场：Windows 版 VS Code 装上最新扩展后，**新建对话**时本该显示「项目待建立」的位置
 * 直接显示了 `Personal Workstation OS`。
 *
 * 根因：徽标复用了 `chooseProjectRoot` 的「只有一个根时无需提示」推断
 * （`roots.length === 1 ? roots[0] : undefined`）。那条推断是给**路径解析与 git 归属**
 * 用的（单根确实没有歧义），却被当成了「这条对话已归属该项目」。
 * 多根工作区不会触发那条推断，所以这个错只在单根环境露出来（Windows 上只打开一个文件夹）。
 *
 * 判据现在分开了：路径解析允许推断，徽标只认证据（显式绑定的 projectRoot / 动过的项目）。
 *
 * 用法：node test/check-project-badge-binding.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');

/* `workspacePaths` 间接依赖 i18n（会 import vscode），所以打包时把 vscode 换成测试桩。 */
const { build } = await import('esbuild');
const bundle = await build({
  stdin: {
    contents: `export { badgeBinding, chooseProjectRoot } from './src/agent/workspacePaths';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
  alias: { vscode: './src/test/support/vscodeMock.ts' },
  external: ['node:*'],
});
const dir = mkdtempSync(join(tmpdir(), 'hwchat-badge-'));
writeFileSync(join(dir, 'bundle.mjs'), bundle.outputFiles[0].text);
const { badgeBinding, chooseProjectRoot } = await import(`file://${join(dir, 'bundle.mjs')}`);
rmSync(dir, { recursive: true, force: true });

/* ── 静态契约 ─────────────────────────────────────────────────────────── */
assert.match(PANEL, /badgeBinding\(\{/, '徽标必须走 badgeBinding，而不是直接复用 projectRootFor 的推断结果');
/*
 * 精确到「整个 projectBadgeFor 里一次都不许出现 projectRootFor」：
 * 那条推断（单根直接返回该根）就是这次的根因，只要它还出现在徽标路径上，
 * 不管写在 `const primary =` 还是别处，都会把猜出来的目录名画成既成事实。
 */
const badgeBody = PANEL.slice(PANEL.indexOf('private projectBadgeFor('), PANEL.indexOf('private projectBadgeFor(') + 2200);
assert.doesNotMatch(badgeBody, /projectRootFor\(/, '徽标里不许再出现 projectRootFor：它会在单根工作区"猜"出一个根');
assert.match(badgeBody, /badgeBinding\(\{/, '徽标必须走 badgeBinding');

/* ── 行为 ─────────────────────────────────────────────────────────────── */
const single = ['/Users/test/AI projects/Personal Workstation OS'];
const multi = ['/Users/test/AI projects/A', '/Users/test/AI projects/B'];

// 1) 单根工作区的新对话：路径能解析，但徽标不认。
assert.equal(chooseProjectRoot({ roots: [...single] }), single[0], '路径解析仍应定出唯一根');
assert.equal(badgeBinding({ roots: single }).bound, false, '没有任何证据时徽标必须是「项目待建立」');
assert.equal(badgeBinding({ roots: single }).roots.length, 0);

// 2) 多根工作区的新对话：同样未绑定。
assert.equal(badgeBinding({ roots: multi }).bound, false);

// 3) 显式绑定（存档里的 projectRoot）。
assert.equal(badgeBinding({ roots: single, stored: single[0] }).bound, true);
assert.equal(badgeBinding({ roots: multi, stored: multi[1] }).bound, true);

// 4) 动过文件就绑定（老对话没有 projectRoot 字段也能显示）。
assert.equal(badgeBinding({ roots: multi, touched: [multi[0]] }).bound, true);

// 5) 存档里的根已经不在工作区里：不算绑定，也不能显示这个名字。
const stale = badgeBinding({ roots: multi, stored: '/Users/test/AI projects/Gone' });
assert.equal(stale.bound, false);
assert.equal(stale.primary, undefined);

console.log('✓ 单根工作区的新对话仍显示「项目待建立」（Windows 现场）');
console.log('✓ 路径解析与徽标绑定分开：前者允许推断，后者只认证据');
console.log('✓ 显式绑定 / 动过文件 / 存档失效三种情形都正确');
console.log('\n项目徽标绑定检查通过。');
