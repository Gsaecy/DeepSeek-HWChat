import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * 正文里「文件引用」的识别。
 *
 * 这一层的风险**不在漏认，而在误认**：正文里到处都是 `v0.2.4`、`e.g.`、
 * `example.com` 这类带点的东西，一旦被判成文件，界面就会给它们加上
 * 「在 Finder 中显示」的右键菜单——点下去是一个不存在的文件。
 * 所以下面一半的用例是「这些绝不能认」。
 */

interface ParsedReference {
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
}

interface ResolvedReference {
  absolute: string;
  relative: string;
  display: string;
  line?: number;
}

interface FileRefModule {
  looksLikeFilePath: (token: unknown, options?: { allowSpaces?: boolean }) => boolean;
  parseReference: (token: unknown, options?: { allowSpaces?: boolean }) => ParsedReference | null;
  resolveReference: (
    reference: ParsedReference | null,
    context: { roots?: string[]; preferred?: string },
  ) => ResolvedReference | null;
  scanPlainText: (text: unknown) => Array<{ index: number; length: number; text: string; reference: ParsedReference }>;
  splitLineSuffix: (token: string) => ParsedReference;
  locationSuffix: (reference: { line?: number; column?: number; endLine?: number }) => string;
}

function loadFileRef(): FileRefModule {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/file-reference.js', 'utf8'), sandbox);
  const loaded = sandbox.HWChatFileRef as FileRefModule | undefined;
  assert.ok(loaded, 'media/file-reference.js 应挂载 HWChatFileRef');
  return loaded;
}

const fileRef = loadFileRef();

/**
 * 模块跑在 vm 沙箱里，返回的对象原型在另一个 realm，
 * `assert.deepEqual`（strict 版会比较原型）会对内容相同的对象报错。
 * 这里统一过一遍 JSON，只比较结构。
 */
function plain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

const ROOT = '/Users/guohongyu/AI projects/DeepSeek-HWChat';
const CONTEXT = { roots: [ROOT], preferred: ROOT };

/* ── 1. 认得出 ───────────────────────────────────────────── */

test('常见写法的文件引用都能认出来', () => {
  const cases = [
    'src/core/ids.ts',
    './media/chat.js',
    'README.md',
    'package.json',
    '.gitignore',
    'LICENSE',
    'Makefile',
    'config/db.yaml',
    'resources/logo.png',
    'C:\\Users\\a\\b.ts',
    '/etc/hosts.conf',
  ];
  for (const token of cases) {
    assert.ok(fileRef.parseReference(token), `${token} 应被识别为文件`);
  }
});

test('行号 / 列号 / #L 区间后缀被拆出来，且不污染扩展名', () => {
  assert.deepEqual(plain(fileRef.parseReference('media/chat.js:745')), { path: 'media/chat.js', line: 745 });
  assert.deepEqual(plain(fileRef.parseReference('src/a.ts:12:5')), { path: 'src/a.ts', line: 12, column: 5 });
  assert.deepEqual(plain(fileRef.parseReference('src/a.ts#L12-L20')), { path: 'src/a.ts', line: 12, endLine: 20 });
  // 句末的句点不是路径的一部分。
  assert.deepEqual(plain(fileRef.parseReference('src/a.ts.')), { path: 'src/a.ts' });
});

test('行号后缀显示成写进正文的样子', () => {
  assert.equal(fileRef.locationSuffix({ line: 16 }), ':16');
  assert.equal(fileRef.locationSuffix({ line: 16, column: 4 }), ':16:4');
  assert.equal(fileRef.locationSuffix({ line: 12, endLine: 20 }), ':12-20');
  assert.equal(fileRef.locationSuffix({}), '');
});

/* ── 2. 绝不能误认 ───────────────────────────────────────── */

test('这些都不是文件，不能变成引用', () => {
  const cases: Array<[string, string]> = [
    ['v0.2.4', '版本号'],
    ['0.2.3', '版本号'],
    ['e.g.', '拉丁缩写'],
    ['i.e.', '拉丁缩写'],
    ['example.com', '域名'],
    ['hongyuguo.com', '域名'],
    ['https://example.com/a.ts', '网址'],
    ['http://localhost:3000/index.html', '带端口的网址'],
    ['--force', '命令行开关'],
    ['-rf', '命令行开关'],
    ['~/.zshrc', '家目录写法'],
    ['node_modules/.bin/tsc', '没有扩展名、也不在固定文件名表里'],
    ['src/core', '纯目录'],
    ['10:30', '时间'],
    ['a|b.ts', '含非法字符'],
    ['<div>', '标签'],
  ];
  for (const [token, why] of cases) {
    assert.equal(fileRef.parseReference(token), null, `${token}（${why}）不该被当成文件`);
  }
});

test('网址里的主机名不会被拆出一条假路径', () => {
  // 去掉协议头之后 `example.com/a.ts` 长得完全像一条相对路径，
  // 所以正文扫描必须先按网址整段抹掉——这条用例专门盯这个陷阱。
  assert.equal(fileRef.parseReference('https://example.com/a.ts'), null);
  const hits = fileRef.scanPlainText('先看 https://example.com/a.ts 再改 src/a.ts');
  assert.deepEqual(plain(hits.map((hit) => hit.text)), ['src/a.ts'], '网址里的 a.ts 不能被捞出来');
});

test('路径里带空格只在反引号里才认（正文里没有边界可用）', () => {
  const spaced = '/Users/guohongyu/AI projects/DeepSeek-HWChat/media/chat.js';
  assert.equal(fileRef.parseReference(spaced), null, '正文里裸写带空格的路径不该被认');
  assert.equal(fileRef.parseReference(spaced, { allowSpaces: true })?.path, spaced, '反引号里应该认');
});

/* ── 3. 相对 → 绝对 ──────────────────────────────────────── */

test('相对路径按项目根拼成绝对路径', () => {
  const resolved = fileRef.resolveReference(fileRef.parseReference('src/core/ids.ts'), CONTEXT);
  assert.ok(resolved);
  assert.equal(resolved.absolute, `${ROOT}/src/core/ids.ts`);
  assert.equal(resolved.relative, 'src/core/ids.ts');
});

test('写了引用格式时显示相对路径，没写时显示完整路径', () => {
  const reference = fileRef.parseReference('src/core/ids.ts');
  const resolved = fileRef.resolveReference(reference, CONTEXT);
  assert.ok(resolved);
  // 界面按这两条规则取标签：compact 用 relative（短），否则用 absolute（完整、可在系统里找）。
  assert.equal(resolved.relative, 'src/core/ids.ts');
  assert.equal(resolved.absolute, `${ROOT}/src/core/ids.ts`);
});

test('绝对路径原样保留，落在工作区外的也能解析', () => {
  const inside = fileRef.resolveReference(fileRef.parseReference(`${ROOT}/media/chat.js`, { allowSpaces: true }), CONTEXT);
  assert.ok(inside, '反引号里的带空格绝对路径应该解析出来');
  assert.equal(inside.absolute, `${ROOT}/media/chat.js`);
  assert.equal(inside.relative, 'media/chat.js');

  const outside = fileRef.resolveReference(fileRef.parseReference('/tmp/build.log'), CONTEXT);
  assert.ok(outside);
  assert.equal(outside.absolute, '/tmp/build.log');
  // 工作区外没有相对写法，只能整条显示——这正是「在 vs code 之外找文件」要的。
  assert.equal(outside.relative, '');
  assert.equal(outside.display, '/tmp/build.log');
});

test('没有工作区根时，相对路径解析不出来（返回 null 而不是瞎拼）', () => {
  assert.equal(fileRef.resolveReference(fileRef.parseReference('src/a.ts'), {}), null);
  assert.equal(fileRef.resolveReference(null, CONTEXT), null);
});

test('Windows 盘符路径归一成斜杠，绝对路径判断正确', () => {
  const resolved = fileRef.resolveReference(fileRef.parseReference('C:\\Users\\a\\b.ts'), CONTEXT);
  assert.ok(resolved);
  assert.equal(resolved.absolute, 'C:/Users/a/b.ts');
});

/* ── 4. 正文裸路径扫描 ───────────────────────────────────── */

test('正文里的裸路径能被找出来，位置对得上', () => {
  const text = '改动在 src/core/ids.ts 与 README.md 两处';
  const hits = fileRef.scanPlainText(text);
  const texts = hits.map((hit) => hit.text);
  assert.deepEqual(plain(texts), ['src/core/ids.ts', 'README.md']);
  for (const hit of hits) {
    assert.equal(text.slice(hit.index, hit.index + hit.length), hit.text, '偏移必须能对回原文');
  }
});

test('中文直接贴着路径也能捞出路径本身，不把汉字带进路径', () => {
  const text = '修改src/core/ids.ts。';
  const hits = fileRef.scanPlainText(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.text, 'src/core/ids.ts');
  assert.equal(hits[0]?.index, 2);
  assert.equal(hits[0]?.reference.path, 'src/core/ids.ts');
});

test('同一句里夹在汉字之间的多个路径都能捞出来', () => {
  const hits = fileRef.scanPlainText('见src/a.ts和README.md这两个');
  assert.deepEqual(plain(hits.map((hit) => hit.text)), ['src/a.ts', 'README.md']);
});

test('正文扫描跳过网址与版本号', () => {
  assert.deepEqual(plain(fileRef.scanPlainText('见 https://example.com/a.ts 与 v0.2.4')), []);
  assert.deepEqual(plain(fileRef.scanPlainText('e.g. 这样')), []);
});

test('正文扫描不跨越括号：括号里的路径认得出，括号本身不算路径', () => {
  const hits = fileRef.scanPlainText('（见 src/a.ts）');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.text, 'src/a.ts');
});
