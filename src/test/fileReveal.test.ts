import assert from 'node:assert/strict';
import test from 'node:test';
import { isInsideWorkspace, normalizeFileReference, revealTargetFor } from '../agent/fileReveal';

/**
 * 「在系统中显示文件」的两件小事：叫什么名字、接受什么入参。
 *
 * 名字错了是看得见的错位（Windows 上写着「在 Finder 中显示」）；
 * 入参没清洗则更隐蔽：正文里的路径是模型输出，可能是空的、`~` 开头的、
 * 带控制字符的。这些一路传到 `revealFileInOS` 后果不可控。
 */

test('文件名随平台走：macOS 是 Finder，Windows 是资源管理器', () => {
  assert.equal(revealTargetFor('darwin'), 'finder');
  assert.equal(revealTargetFor('win32'), 'explorer');
  // 其余平台不猜具体是 Nautilus 还是 Dolphin，统一叫文件管理器。
  assert.equal(revealTargetFor('linux'), 'fileManager');
  assert.equal(revealTargetFor('freebsd'), 'fileManager');
});

test('入参清洗：空路径与控制字符一律丢弃', () => {
  assert.equal(normalizeFileReference({}), undefined);
  assert.equal(normalizeFileReference({ path: '' }), undefined);
  assert.equal(normalizeFileReference({ path: '   ' }), undefined);
  assert.equal(normalizeFileReference({ path: '/tmp/a\u0000.ts' }), undefined);
  assert.equal(normalizeFileReference({ path: '/tmp/a\nb.ts' }), undefined);
  // 非字符串（模型或前端回传了数字/对象）也当没有。
  assert.equal(normalizeFileReference({ path: 42 as unknown as string }), undefined);
});

test('入参清洗：不展开家目录写法', () => {
  // 展开 `~` 等于替用户猜主目录；HWChat 在工具参数里也是同样的口径。
  assert.equal(normalizeFileReference({ path: '~/.zshrc' }), undefined);
  assert.equal(normalizeFileReference({ path: '~/a.ts' }), undefined);
});

test('入参清洗：行号列号只收正整数，其余忽略', () => {
  assert.deepEqual(normalizeFileReference({ path: '/tmp/a.ts', line: 16 }), { path: '/tmp/a.ts', line: 16 });
  assert.deepEqual(normalizeFileReference({ path: '/tmp/a.ts', line: '16', column: '4' }), { path: '/tmp/a.ts', line: 16, column: 4 });
  // 0、负数、NaN、非数字都不写进结果，而不是夹成 1——夹住会静默定位到错误的行。
  assert.deepEqual(normalizeFileReference({ path: '/tmp/a.ts', line: 0 }), { path: '/tmp/a.ts' });
  assert.deepEqual(normalizeFileReference({ path: '/tmp/a.ts', line: -5 }), { path: '/tmp/a.ts' });
  assert.deepEqual(normalizeFileReference({ path: '/tmp/a.ts', line: 'x' }), { path: '/tmp/a.ts' });
  assert.deepEqual(normalizeFileReference({ path: '/tmp/a.ts', column: Number.NaN }), { path: '/tmp/a.ts' });
});

test('入参清洗：合法路径原样保留（含空格）', () => {
  const spaced = '/Users/guohongyu/AI projects/DeepSeek-HWChat/media/chat.js';
  assert.deepEqual(normalizeFileReference({ path: `  ${spaced}  ` }), { path: spaced });
});

/**
 * 「这个文件在不在工作区里」。
 *
 * 为什么要测：`revealInExplorer` 对工作区外的文件**静默无效**——不报错也不移动。
 * 用户点了右键菜单却毫无反应，比给一条明确提示更糟。所以这道判断必须准确，
 * 尤其不能因为前缀相似就把外部文件判成内部（那会导致又一次静默失败）。
 */
test('工作区判断：子路径算在内，自己也算在内', () => {
  const roots = ['/Users/me/project'];
  assert.equal(isInsideWorkspace('/Users/me/project/a.ts', roots), true);
  assert.equal(isInsideWorkspace('/Users/me/project/src/deep/b.ts', roots), true);
  // 目录自身（比如引用了某个目录）也应算在内。
  assert.equal(isInsideWorkspace('/Users/me/project', roots), true);
});

test('工作区判断：前缀相似但不是子路径，必须判在外面', () => {
  // 这是最容易写错的一条：字符串以 `/Users/me/project` 开头，但实际是同级目录。
  const roots = ['/Users/me/project'];
  assert.equal(isInsideWorkspace('/Users/me/project-other/a.ts', roots), false);
  assert.equal(isInsideWorkspace('/Users/me/projectX/a.ts', roots), false);
  // 往上跳一级也不是。
  assert.equal(isInsideWorkspace('/Users/me/a.ts', roots), false);
  assert.equal(isInsideWorkspace('/etc/hosts', roots), false);
});

test('工作区判断：多根工作区任意一个命中即可', () => {
  const roots = ['/Users/me/a', '/Users/me/b'];
  assert.equal(isInsideWorkspace('/Users/me/b/x.ts', roots), true);
  assert.equal(isInsideWorkspace('/Users/me/c/x.ts', roots), false);
});

test('工作区判断：没有工作区、空路径、空根一律为否', () => {
  assert.equal(isInsideWorkspace('/Users/me/a.ts', []), false);
  assert.equal(isInsideWorkspace('', ['/Users/me']), false);
  // 空字符串根不能当成「根是 /」，否则任何绝对路径都会被判成在里面。
  assert.equal(isInsideWorkspace('/Users/me/a.ts', ['']), false);
});

test('工作区判断：相对路径按 cwd 解析后再比较', () => {
  const roots = [process.cwd()];
  assert.equal(isInsideWorkspace('media/chat.js', roots), true);
  assert.equal(isInsideWorkspace('../outside.ts', roots), false);
});

test('工作区判断：Windows 上大小写不敏感，macOS 上敏感', () => {
  const roots = ['C:\\Project'];
  assert.equal(isInsideWorkspace('C:\\Project\\src\\a.ts', roots, 'win32'), true);
  // Windows 路径本身不区分大小写，盘符和目录名换大小写都得认。
  assert.equal(isInsideWorkspace('c:\\project\\SRC\\a.ts', roots, 'win32'), true);
  assert.equal(isInsideWorkspace('C:\\Project\\src\\a.ts', roots, 'darwin'), false);
});
