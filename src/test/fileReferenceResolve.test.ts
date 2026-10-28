import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseReferenceMatch,
  filenameSearchName,
  isBareBasename,
  isGlobSafeName,
  pickUniqueMatch,
  referenceCandidatePaths,
} from '../agent/fileReferenceResolve';

/**
 * 「正文里这个文件到底是哪个文件」。
 *
 * 这一层的风险在**误认**：模型正文里写 `extension.js` 时，它可能指
 * `out/extension.js`，也可能只是在说「这个打包产物」而根本不存在。
 * 原来只按扩展名认下来、直接拼到项目根上，于是渲染出一个点开就报
 * 「文件不存在」的引用。下面这些用例盯的就是这条界线的两边。
 */

const ROOT = '/work/project';
const OTHER = '/work/other';

/** 用一张「磁盘上有什么」的表代替真实文件系统。 */
function fakeExists(files: readonly string[]): (candidate: string) => boolean {
  const set = new Set(files);
  return (candidate) => set.has(candidate);
}

test('裸文件名：根目录上有就直接用，不去搜', () => {
  const value = chooseReferenceMatch({
    path: 'package.json',
    roots: [ROOT],
    preferred: ROOT,
    platform: 'darwin',
    exists: fakeExists([`${ROOT}/package.json`]),
    // 就算给了搜索结果也不该采用：确定性候选已经命中。
    searchMatches: [`${ROOT}/deep/package.json`],
  });
  assert.equal(value, `${ROOT}/package.json`);
});

test('裸文件名：根上找不到时，唯一命中才认（extension.js → out/extension.js）', () => {
  const value = chooseReferenceMatch({
    path: 'extension.js',
    roots: [ROOT],
    preferred: ROOT,
    platform: 'darwin',
    exists: fakeExists([`${ROOT}/out/extension.js`]),
    searchMatches: [`${ROOT}/out/extension.js`],
  });
  assert.equal(value, `${ROOT}/out/extension.js`);
});

test('裸文件名：同名多份就不认（猜错文件比不给引用更糟）', () => {
  const value = chooseReferenceMatch({
    path: 'index.ts',
    roots: [ROOT],
    preferred: ROOT,
    platform: 'darwin',
    exists: fakeExists([`${ROOT}/a/index.ts`, `${ROOT}/b/index.ts`]),
    searchMatches: [`${ROOT}/a/index.ts`, `${ROOT}/b/index.ts`],
  });
  assert.equal(value, undefined);
});

test('裸文件名：整棵树都找不到就不认', () => {
  const value = chooseReferenceMatch({
    path: 'nope.ts',
    roots: [ROOT],
    preferred: ROOT,
    platform: 'darwin',
    exists: fakeExists([]),
    searchMatches: [],
  });
  assert.equal(value, undefined);
});

test('带目录的相对路径：只认确定位置，不拿搜索结果兜底', () => {
  const value = chooseReferenceMatch({
    path: 'src/a.ts',
    roots: [ROOT],
    preferred: ROOT,
    platform: 'darwin',
    exists: fakeExists([`${ROOT}/lib/src/a.ts`]),
    // `src/a.ts` 在项目里没命中，但别处的同名文件不能顶替：
    // 用户写的目录是有意义的，换一个文件等于骗人。
    searchMatches: [`${ROOT}/lib/src/a.ts`],
  });
  assert.equal(value, undefined);
});

test('多根工作区：项目根优先于排在前面的根', () => {
  const value = chooseReferenceMatch({
    path: 'src/a.ts',
    roots: [OTHER, ROOT],
    preferred: ROOT,
    platform: 'darwin',
    exists: fakeExists([`${OTHER}/src/a.ts`, `${ROOT}/src/a.ts`]),
  });
  assert.equal(value, `${ROOT}/src/a.ts`);
});

test('项目根里没有就顺着其它根继续找', () => {
  const value = chooseReferenceMatch({
    path: 'src/a.ts',
    roots: [OTHER, ROOT],
    preferred: ROOT,
    platform: 'darwin',
    exists: fakeExists([`${OTHER}/src/a.ts`]),
  });
  assert.equal(value, `${OTHER}/src/a.ts`);
});

test('绝对路径：存在才认，且必须落在工作区内', () => {
  const inside = chooseReferenceMatch({
    path: `${ROOT}/a.ts`,
    roots: [ROOT],
    platform: 'darwin',
    exists: fakeExists([`${ROOT}/a.ts`]),
  });
  assert.equal(inside, `${ROOT}/a.ts`);

  const outside = chooseReferenceMatch({
    path: '/etc/hosts',
    roots: [ROOT],
    platform: 'darwin',
    exists: fakeExists(['/etc/hosts']),
  });
  assert.equal(outside, undefined);
});

test('绝对路径不存在就不认（不因为是绝对路径就放行）', () => {
  const value = chooseReferenceMatch({
    path: `${ROOT}/ghost.ts`,
    roots: [ROOT],
    platform: 'darwin',
    exists: fakeExists([]),
  });
  assert.equal(value, undefined);
});

test('globs 元字符的名字不拿去搜（方括号会被当成字符集）', () => {
  assert.equal(filenameSearchName('a[1].ts'), undefined);
  assert.equal(filenameSearchName('a?.ts'), undefined);
  assert.equal(filenameSearchName('a.ts'), 'a.ts');
  assert.equal(isGlobSafeName('a.ts'), true);
  assert.equal(isGlobSafeName('a{b}.ts'), false);
});

test('裸文件名的判定：带目录、绝对路径、点目录都不算', () => {
  assert.equal(isBareBasename('a.ts'), true);
  assert.equal(isBareBasename('src/a.ts'), false);
  assert.equal(isBareBasename(`${ROOT}/a.ts`), false);
  assert.equal(isBareBasename('.'), false);
  assert.equal(isBareBasename('..'), false);
  // 没有扩展名也还是裸文件名——认不认它是扩展名白名单那层的事。
  assert.equal(isBareBasename('Makefile'), true);
});

test('候选顺序：项目根在前，重复的根只出现一次', () => {
  const candidates = referenceCandidatePaths('src/a.ts', [ROOT, ROOT, OTHER], ROOT);
  assert.deepEqual(candidates, [`${ROOT}/src/a.ts`, `${OTHER}/src/a.ts`]);
});

test('候选顺序：没有项目根时按工作区根的顺序', () => {
  const candidates = referenceCandidatePaths('./src/a.ts', [OTHER, ROOT]);
  assert.deepEqual(candidates, [`${OTHER}/src/a.ts`, `${ROOT}/src/a.ts`]);
});

test('唯一命中：Windows 上大小写不同的同一路径只算一个', () => {
  assert.equal(pickUniqueMatch(['C:\\A\\a.ts', 'c:\\a\\a.ts'], 'win32'), 'C:\\A\\a.ts');
  // POSIX 上它们是两个不同文件，所以不唯一。
  assert.equal(pickUniqueMatch(['/A/a.ts', '/a/a.ts'], 'darwin'), undefined);
});

test('空输入不猜', () => {
  assert.equal(chooseReferenceMatch({ path: '   ', roots: [ROOT], exists: () => true }), undefined);
  assert.equal(chooseReferenceMatch({ path: 'a.ts', roots: [], preferred: '', exists: () => false }), undefined);
});
