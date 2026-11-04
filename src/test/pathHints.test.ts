/**
 * 路径不存在时的「真实结构」提示。
 *
 * 现场（用户 2026-11-04）：
 *
 *     read_file {"path":"Personal Workstation OS/website/instindex/web/i18n.js"}
 *     → Error: ENOENT: no such file or directory, stat '…/web/i18n.js'
 *
 * 文件其实在 `…/web/assets/i18n.js`。只回一行 ENOENT 的话，模型只能再猜一次；
 * 猜错就撞「连续 3 轮无进展」停机，用户看到的是「工具老是失败」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
  nearestExistingDirectory,
  renderMissingPathHint,
  sortDirectoryHints,
  type MissingPathHint,
} from '../agent/pathHints';

/** 假 i18n：把 key 与插值原样拼出来，方便断言内容而不是文案。 */
const t = (key: string, values?: Record<string, string | number>): string =>
  `${key}${values ? `(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : ''}`;

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hwchat-pathhint-'));
  mkdirSync(join(root, 'web/assets'), { recursive: true });
  writeFileSync(join(root, 'web/assets/i18n.js'), 'export const a = 1;\n');
  return root;
}

test('往上退一层就找到真实目录（i18n.js 在 assets 里）', () => {
  const root = fixture();
  try {
    const found = nearestExistingDirectory(join(root, 'web/i18n.js'), root, existsSync);
    assert.equal(found?.directory, join(root, 'web'));
    assert.equal(found?.depth, 1, 'web/i18n.js → web 是 1 段');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('连退多层也对，且只退到真实存在的那一层', () => {
  const root = fixture();
  try {
    const found = nearestExistingDirectory(join(root, 'web/a/b/c/d.txt'), root, existsSync);
    assert.equal(found?.directory, join(root, 'web'), 'web/a/b/c 全都不存在');
    assert.equal(found?.depth, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('不越过工作区根：根外或根本不存在的根一律不给提示', () => {
  const root = fixture();
  try {
    assert.equal(nearestExistingDirectory('/definitely/not/here/x.js', root, existsSync), undefined);
    assert.equal(
      nearestExistingDirectory(join(root, 'web/i18n.js'), join(root, 'missing-root'), existsSync),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录排前面：一眼能看出还有哪些子目录可进', () => {
  const sorted = sortDirectoryHints([
    { name: 'index.html', directory: false },
    { name: 'assets', directory: true },
    { name: 'readme.md', directory: false },
    { name: 'assets-old', directory: true },
  ]);
  assert.deepEqual(sorted.map((entry) => entry.name), ['assets', 'assets-old', 'index.html', 'readme.md']);
});

test('什么都没有时返回 undefined，不输出空壳提示', () => {
  assert.equal(renderMissingPathHint({ requestedPath: 'x' }, { t }), undefined);
});

test('提示里同时给出「最近目录 + 同名文件 + 下一步」', () => {
  const hint: MissingPathHint = {
    requestedPath: 'web/i18n.js',
    nearestDir: 'web',
    nearestDepth: 1,
    entries: [
      { name: 'assets', directory: true },
      { name: 'index.html', directory: false },
    ],
    hiddenCount: 3,
    sameName: ['web/assets/i18n.js'],
  };
  const text = renderMissingPathHint(hint, { t });
  assert.ok(text);
  assert.match(text, /tool\.pathNotFound\.head\(path=web\/i18n\.js\)/);
  assert.match(text, /nearest\(dir=web,depth=1\)/);
  assert.match(text, /^ {2}assets\/$/m, '目录带斜杠后缀');
  assert.match(text, /^ {2}index\.html$/m);
  assert.match(text, /nearestMore\(count=3\)/);
  assert.match(text, /sameName\(count=1\)/);
  assert.match(text, /^ {2}web\/assets\/i18n\.js$/m);
  assert.match(text, /tool\.pathNotFound\.advice/);
  assert.ok(text.indexOf('sameName') < text.indexOf('advice'), '结论放在最后一行');
});

test('只有最近目录、没有同名文件时也不提「同名」这一节', () => {
  const text = renderMissingPathHint({ requestedPath: 'a.js', nearestDir: '.', nearestDepth: 1, entries: [] }, { t });
  assert.ok(text);
  assert.doesNotMatch(text, /sameName/);
});
