/**
 * 模态确认框只能有一个「取消」。
 *
 * 现场缺陷：切到「完全访问」时的确认框里并排出现了两个「取消」——左边一个是
 * VS Code 自己追加的（`modal: true` 的对话框总会带一个本地化 Cancel），右边
 * 一个是我们又传进去的 `tt('common.cancel')`。两个按钮文字一样、行为也一样
 * （都返回 undefined），但没人能猜出为什么要给两遍，而且把主按钮挤到第三个位置。
 *
 * 修法是把我们自己的那个去掉，只留原生取消。这条断言直接扫源码里的
 * `show*Message(...)` 调用，凡是带 `modal: true` 的都不允许再传一个取消类按钮，
 * 免得以后在新对话框里又抄一遍。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 取消类文案的四种写法：i18n 键两种、直写字面量两种。 */
const CANCEL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bcommon\.cancel\b/, label: "tt('common.cancel')" },
  { pattern: /\bprivacyCancel\b/, label: "tt('ext.privacyCancel')" },
  { pattern: /(['"`])取消\1/, label: "'取消'" },
  { pattern: /(['"`])Cancel\1/, label: "'Cancel'" },
];

function sourceRoot(): string {
  const candidates = [
    path.join(process.cwd(), 'src'),
    path.join(process.cwd(), 'DeepSeek-HWChat', 'src'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found, '找不到 src 目录');
  return found;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // 测试目录里的字符串不是产品行为（本文件自己就写着 '取消'）。
      if (entry.name === 'test') continue;
      files.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** 从 `(` 起做括号配平，取出这次调用的完整参数文本（跳过字符串里的括号）。 */
function argumentList(source: string, openParen: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, index);
    }
  }
  throw new Error('括号不配对，无法解析这次调用');
}

function modalCalls(): Array<{ file: string; args: string }> {
  const root = sourceRoot();
  const calls: Array<{ file: string; args: string }> = [];
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8');
    const pattern = /\.show(?:Warning|Information|Error)Message\s*\(/g;
    for (const match of source.matchAll(pattern)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      const args = argumentList(source, open);
      if (/modal:\s*true/.test(args)) {
        calls.push({ file: path.relative(root, file), args });
      }
    }
  }
  return calls;
}

test('扫描确实覆盖到了模态确认框（否则下面的断言等于没写）', () => {
  const calls = modalCalls();
  assert.ok(calls.length >= 6, `只扫到 ${calls.length} 个模态框，扫描逻辑可能失效了`);
  // 权限放宽的确认框必须在扫描范围内：它就是缺陷现场。
  assert.ok(
    calls.some((call) => call.args.includes('permissionConfirm')),
    '没有扫到权限预设的确认框',
  );
});

test('模态确认框不再自带「取消」，只由 VS Code 追加一个', () => {
  for (const call of modalCalls()) {
    for (const { pattern, label } of CANCEL_PATTERNS) {
      assert.doesNotMatch(
        call.args,
        pattern,
        `${call.file} 的模态对话框中又传了一个取消按钮（${label}）：`
          + 'modal: true 会自动追加一个本地化的 Cancel，再传就成了两个「取消」。',
      );
    }
  }
});

test('权限确认框仍然给出一个明确的确认按钮', () => {
  // 去掉重复取消时不能顺手把主按钮也删掉，否则对话框只剩一个取消可点。
  const permissionCalls = modalCalls().filter((call) => call.args.includes('permissionConfirm'));
  assert.ok(permissionCalls.length >= 1);
  for (const call of permissionCalls) {
    assert.match(call.args, /notice\.permissionConfirm/, `${call.file} 少了确认按钮`);
  }
});
