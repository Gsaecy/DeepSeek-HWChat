/*
 * 路径身份：同一个目录不许因为拼写不同被当成两个。
 *
 * 线上事故（2026-11-08，新用户在一台全新 Windows 上第一次用 HWChat）：
 *
 *     已阻止 git 操作：仓库 E:\AI Projects\maiker_windows 里还包含另一个工作区项目
 *     e:\AI Projects\maiker_windows
 *
 * 提示里两边是**同一个目录**，只差盘符大小写。守卫用 `===` 比字符串，于是
 * `git pull` 被自己的扩展拦住 —— 用户的第一印象就是「基本的 git 都做不到」。
 *
 * 这个脚本从两头钉住它：
 *   1. 源码里不许再出现「把路径当字符串比」的写法（会再犯的那一类）；
 *   2. 真实文件系统上，大小写不同的拼写必须被判成同一个目录。
 *
 * 用法：node test/check-path-identity.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const SOURCES = [
  'src/core/pathIdentity.ts',
  'src/agent/workspacePaths.ts',
  'src/agent/toolExecutor.ts',
  'src/agent/workspaceSearch.ts',
  'src/agent/commandPaths.ts',
  'src/agent/pathHints.ts',
  'src/core/permissions.ts',
  'src/agent/conversationScope.ts',
  'src/core/storage.ts',
  'src/views/chatPanel.ts',
];
const code = Object.fromEntries(SOURCES.map((path) => [path, stripComments(read(path))]));
const allCode = Object.values(code).join('\n');

/* ── 1. 不许再把路径当字符串比较 ─────────────────────────────── */
const RAW_COMPARISONS = [
  /resolve\(([^()]*(?:\([^()]*\))?[^()]*)\)\s*===\s*resolve\(/,
  /resolve\(([^()]*(?:\([^()]*\))?[^()]*)\)\s*!==\s*resolve\(/,
  /\.fsPath\s*===/,
  /===\s*[A-Za-z_$][\w$]*\.fsPath/,
  // 路径数组的 includes / indexOf 同样是字符串相等：盘符大小写不同就判成「不在里面」。
  /\b(roots|rootPaths|paths|projectRoots|folders|targets)\.(includes|indexOf)\(/,
];
for (const pattern of RAW_COMPARISONS) {
  const hit = pattern.exec(allCode);
  check(`没有「把路径当字符串比」的写法 ${pattern}`, hit === null, hit ? `命中：${hit[0]}` : '');
}

const IDENTITY = code['src/core/pathIdentity.ts'] ?? '';
check(
  '路径身份有统一出口 pathKey / samePath（在 core/pathIdentity，不依赖 vscode）',
  /export function pathKey\(/.test(IDENTITY) && /export function samePath\(/.test(IDENTITY),
);
check(
  'agent 侧继续 re-export，调用方不会各引各的',
  /export \{ isPathWithin, pathKey, samePath \}/.test(code['src/agent/workspacePaths.ts'] ?? ''),
);
check(
  'Linux 上不折叠大小写（/tmp/A 与 /tmp/a 是两个目录）',
  /process\.platform === 'win32' \|\| process\.platform === 'darwin'/.test(IDENTITY),
);
check(
  'git 判定抽成了纯函数 gitScopeVerdict',
  /export function gitScopeVerdict\(/.test(code['src/agent/workspacePaths.ts'] ?? '')
    && /gitScopeVerdict\(\{ roots, repo, project \}\)/.test(code['src/agent/toolExecutor.ts'] ?? ''),
);
check(
  '只有 workspacePaths 可以定义包含判断（不许再抄第二份）',
  !/function (within|inside|contains|isInside)\(/.test(allCode.replace(code['src/agent/workspacePaths.ts'] ?? '', ''))
    && !/relative\(\s*resolve\(/.test(allCode.replace(code['src/agent/workspacePaths.ts'] ?? '', '')),
  '重复实现会在某个平台上悄悄大小写敏感',
);
check(
  '仓库根自己绝不算「外来项目」',
  /!same\(root, repo\)/.test(code['src/agent/workspacePaths.ts'] ?? ''),
);

/* ── 2. 真实文件系统：大小写不同必须是同一个目录 ───────────────── */
const sandbox = join(tmpdir(), `hwchat-path-identity-${process.pid}`);
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(join(sandbox, 'MaiKer_Win'), { recursive: true });

const caseInsensitiveFs = (() => {
  try {
    return existsSync(join(sandbox, 'maiker_win'));
  } catch {
    return false;
  }
})();

const { gitScopeVerdict, isPathWithin, samePath } = await (async () => {
  const { build } = await import('esbuild');
  const bundle = await build({
    stdin: {
      contents: `export { isPathWithin, samePath } from './src/core/pathIdentity';\nexport { gitScopeVerdict } from './src/agent/workspacePaths';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'error',
    alias: { vscode: './src/test/support/vscodeMock.ts' },
  });
  const source = bundle.outputFiles[0].text;
  const path = join(sandbox, 'bundle.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, source);
  return import(`file://${path}`);
})();

const upper = join(sandbox, 'MaiKer_Win');
const lower = join(sandbox, 'maiker_win');

check('测试环境是大小写不敏感的文件系统（否则本条无意义）', caseInsensitiveFs, '当前卷区分大小写，跳过语义判断');
if (caseInsensitiveFs) {
  check('samePath：只差大小写 → 同一个目录', samePath(upper, lower) === true);
  check('isPathWithin：只差大小写 → 判定在内部', isPathWithin(upper, lower) === true);
  check(
    'gitScopeVerdict：仓库根/工作区根/项目根只差大小写 → 允许（就是这次拦人的场景）',
    gitScopeVerdict({ roots: [lower], repo: upper, project: upper }).kind === 'ok',
    JSON.stringify(gitScopeVerdict({ roots: [lower], repo: upper, project: upper })),
  );
}

/* 与平台无关的语义：这两条必须永远成立 */
check(
  'gitScopeVerdict：真的另一个工作区项目仍然要拦',
  gitScopeVerdict({ roots: [upper, join(upper, 'other-project')], repo: upper, project: upper }).kind === 'foreign',
);
check(
  'gitScopeVerdict：仓库不在项目里 → 报不匹配',
  gitScopeVerdict({ roots: [upper], repo: join(sandbox, 'elsewhere'), project: upper }).kind === 'mismatch',
);

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('路径身份仍有缺口：Windows / macOS 上会把同一个目录当成两个。');
  process.exitCode = 1;
} else {
  console.log('路径身份统一走 samePath；大小写不同的拼写不会再被当成两个目录。');
}
