/*
 * 检索与「环境缺东西」的守护。
 *
 * 用户 2026-11-05/06 连着贴回四段失败：
 *   1. search_github_repos「macOS screen recorder ScreenCaptureKit SCStream AVAssetWriter」→ 没有匹配
 *   2. search_web「ScreenCaptureKit SCStream screen recording Swift tutorial」→ 网页检索没有结果
 *   3. 路径建议只改了第一个 /tmp，照着敲仍被拦
 *   4. `timeout: command not found` / `screencapture: capture error`
 *
 * 第 1、2 条都是**工具坏了**，不是查询写错：
 *   · GitHub 六词 AND → total_count: 0，但 ScreenCaptureKit 有 780 个；
 *   · Bing format=rss → HTTP 200 但 0 个 <item>（接口已不产结果）。
 *
 * 第 3、4 条是建议与提示不够用。这里既做静态契约，也**真的打一次网络**验证来源可用。
 *
 * 用法：node test/check-search-and-env.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';

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
const RESEARCH = read('src/agent/webResearch.ts');
const FALLBACKS = read('src/agent/searchFallbacks.ts');
const HINTS = read('src/agent/commandHints.ts');
const EXECUTOR = read('src/agent/toolExecutor.ts');
const I18N = read('src/core/i18n.ts');
const PANEL = read('src/views/chatPanel.ts');
const ABORT = read('src/agent/abortReason.ts');

/* ── 1. GitHub 检索：命中 0 必须自动放宽 ─────────────────────────── */
check('search_github_repos 在 0 命中时逐级放宽，而不是直接回「没结果」',
  /for \(const attempt of attempts\)/.test(RESEARCH) && /relaxedQueries\(text\)/.test(RESEARCH));
check('放宽结果里说明「完整关键词 0 匹配，已放宽为 …」',
  /已自动放宽为/.test(RESEARCH), '不说的话模型会以为原查询命中了');

/* ── 2. 网页检索：多来源 + 明确各来源状态 ─────────────────────────── */
check('search_web 不再只依赖一个后端', /KEYLESS_SOURCES/.test(RESEARCH) && /Promise\.all\(\[bing, \.\.\.others\]\)/.test(RESEARCH));
check(
  '来源命中会标注来源名（[Stack Overflow] …）',
  RESEARCH.includes('`[${hit.source}] ${hit.title}`'),
  '不加来源名的话，模型分不清「文档」和「问答帖」',
);
check('全空时列出**每个来源**各自的情况，并给出下一步',
  /在所有来源上都没有命中/.test(RESEARCH) && /search_github_repos/.test(RESEARCH));
check('Stack Overflow 与 HN 两个来源都定义在纯函数层',
  /id: 'stackoverflow'/.test(FALLBACKS) && /id: 'hn'/.test(FALLBACKS));
check('合并命中按 URL 去重（避免同一帖被当成多条资料）', /export function mergeHits/.test(FALLBACKS));

/* ── 3. 路径改写建议：所有出现位置都要改 ─────────────────────────── */
check('改写建议遍历所有匹配（以前只改第一个）',
  /for \(const match of command\.matchAll\(pattern\)\)/.test(EXECUTOR));
check(
  '重定向前缀 `2>/tmp/x` 也算（前缀字符集合带 `>`）',
  EXECUTOR.includes('(^|[\\s"\'=>(])'),
  '漏掉 `>` 就会出现「错误流仍写 /tmp」的半截建议',
);

/* ── 4. 环境类失败的确定性提示 ───────────────────────────────────── */
check('命令失败时会查环境提示并写进结果',
  /commandEnvironmentHint\(effectiveCommand, output\)/.test(EXECUTOR) && /environmentHint/.test(EXECUTOR));
check('macOS 没有 GNU timeout → 指明 coreutils / 后台跑',
  /noTimeoutMac/.test(HINTS) && /gtimeout/.test(I18N));
check('screencapture capture error → 屏幕录制权限（且不会自动弹窗）',
  /screenCapturePermission/.test(HINTS) && /屏幕录制/.test(I18N) && /不会自动弹窗/.test(I18N));

/* ── 5. 中止不再显示成「请求失败：aborted」────────────────────────── */
check('中止形状统一判定（AbortError / Error("aborted") / 字符串）',
  /export function isAbortLikeError/.test(ABORT));
check('中止按来源分成 timeout / network / user 三种说法',
  /export function classifyAbort/.test(ABORT) && /chat\.aborted\.(timeout|network|user)/.test(I18N));
check('面板用统一判定，并把原始错误名写进日志',
  /isAbortLikeError\(error\)/.test(PANEL) && /\[abort\] 运行中止/.test(PANEL));

/* ── 6. 真实网络：两个来源现在还能用吗 ───────────────────────────── */
mkdirSync('out/check', { recursive: true });
buildSync({
  entryPoints: ['src/agent/searchFallbacks.ts'],
  bundle: true, format: 'cjs', platform: 'node', target: 'node20',
  outfile: 'out/check/searchFallbacks.cjs', logLevel: 'silent',
});
const require = createRequire(import.meta.url);
const { KEYLESS_SOURCES, mergeHits, sourceQueries } = require(resolve('out/check/searchFallbacks.cjs'));

const query = 'ScreenCaptureKit AVAssetWriter';
for (const source of KEYLESS_SOURCES) {
  // 与 searchWeb 一致：原查询 → 最放宽的一档，任一命中即算可用。
  let passed = false;
  for (const attempt of sourceQueries(query)) {
    const url = source.url(attempt, 5);
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
      const body = await response.text();
      const hits = source.parse(body, 5);
      if (response.ok && hits.length > 0) {
        check(`${source.label} 真实可用（「${attempt}」命中 ${hits.length} 条）`, true);
        passed = true;
        break;
      }
    } catch (error) {
      // 离线环境不该判红：明确跳过而不是失败。
      console.log(`- 跳过 ${source.label} 的真实请求（${error instanceof Error ? error.message : String(error)}）`);
      passed = true;
      break;
    }
  }
  if (!passed) check(`${source.label} 真实可用`, false, '原查询与放宽查询都没有命中');
}

const merged = mergeHits([[{ url: 'https://a/1' }, { url: 'https://a/1' }], [{ url: 'https://a/1' }, { url: 'https://b/2' }]], 5);
check('合并去重真的生效', merged.length === 2, JSON.stringify(merged));

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('检索 / 环境提示这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('检索会自动放宽并多来源合并；路径建议改全；环境缺口与中止都说清了。');
}
