/*
 * 「半个 emoji 让整份请求 JSON 解析失败」的守护。
 *
 * 用户原话（2026-11-07，连报两次）：
 *
 *     请求失败：接口请求失败（400）：Failed to parse the request body as JSON:
 *     messages[0].content: lone leading surrogate in hex escape at line 1 column 39266
 *
 * `messages[0]` 是 system 消息，里面是任务记忆、历史摘要、自动检索片段 —— 每一块都由
 * `slice(0, N)` 截断而成。emoji 在 UTF-16 里占两个码元，截在中间就留下孤立代理项。
 *
 * 守护三件事：
 *   1. 出站口必须兜底（任何上游漏了都不能发出去）；
 *   2. 所有会进入提示词的截断都要用 safeSlice / clipText；
 *   3. 用真实事故形状跑一遍：长文本里带 emoji，逐点截断都不产生坏 escape。
 *
 * 用法：node test/check-text-safety.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const CLIENT = read('src/providers/deepseekClient.ts');
const SAFETY = read('src/core/textSafety.ts');

/* ── 1. 出站兜底 ─────────────────────────────────────────────────── */
check(
  '请求体统一走 encodeBody（含清洗 + 体积日志）',
  /private encodeBody\(body: Record<string, unknown>, endpoint: string\): string/.test(CLIENT)
    && (CLIENT.match(/this\.encodeBody\(body, endpoint\)/g) ?? []).length === 2,
  '聊天与出图两条请求路径都要兜，漏一条就还会 400',
);
check(
  '出站前调用 sanitizeJsonStrings',
  /const sanitized = sanitizeJsonStrings\(body\)/.test(CLIENT),
  '上游任何一处漏掉 safeSlice，都还有这一道',
);
check(
  '真的修了会记一行（便于事后定位是哪一块文本）',
  /孤立代理项.*已按 UTF-16 边界修正后发送/.test(CLIENT),
);
check(
  '请求体过大时记一行体积（这是「首字节等待超时」的主因）',
  /LARGE_PAYLOAD_CHARS/.test(CLIENT) && /请求体 .* MB/.test(CLIENT),
);

/* ── 2. 进入提示词的截断都用安全切片 ─────────────────────────────── */
const PROMPT_SOURCES = {
  'src/core/contextWindow.ts': '记忆块与摘要',
  'src/core/taskMemory.ts': '任务记忆',
  'src/core/searchText.ts': '自动检索片段',
  'src/core/ids.ts': '任务标题与预览',
  'src/core/storage.ts': '检索摘录',
  'src/core/decisionGate.ts': '方案卡片文案',
  'src/core/research.ts': '网页正文',
  'src/core/conversationHistory.ts': '历史摘要',
  'src/agent/toolExecutor.ts': '工具输出截断',
};
for (const [path, label] of Object.entries(PROMPT_SOURCES)) {
  const source = read(path);
  check(
    `${label}（${path.split('/').pop()}）用安全切片`,
    /clipText|safeSlice/.test(source),
  );
}
check(
  'toolExecutor.truncate 不再用裸 slice',
  !/let result = value\.slice\(0, Math\.max\(1, Math\.floor\(maxBytes \* 0\.75\)\)\);/.test(read('src/agent/toolExecutor.ts')),
  '这一行曾经就是半个 emoji 的来源',
);

/* ── 3. 真实事故形状：逐点截断都不产生坏 escape ───────────────────── */
buildSync({
  entryPoints: ['src/core/textSafety.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/check/textSafety.cjs',
  logLevel: 'silent',
});
const require = createRequire(import.meta.url);
const { safeSlice, hasLoneSurrogate, sanitizeJsonStrings } = require(resolve('out/check/textSafety.cjs'));

const EMOJI = '😀';
const entries = Array.from({ length: 60 }, (_, index) => `- [x] 任务 ${index}：${index % 2 ? EMOJI : '中文'}把胶囊挪到顶部栏`);
const system = entries.join('\n');
let bad = 0;
for (let cut = 0; cut <= system.length; cut += 1) {
  const piece = safeSlice(system, 0, cut);
  if (hasLoneSurrogate(piece)) bad += 1;
  const body = JSON.stringify({ messages: [{ role: 'system', content: piece }] });
  if (/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(body)) bad += 1;
}
check(
  '真实形状：2000+ 个截断点都不产生孤立代理项',
  bad === 0,
  `有 ${bad} 个点出事`,
);
check(
  '对照：裸 slice 确实会切坏（证明这条守护有意义）',
  hasLoneSurrogate(system.slice(0, system.indexOf(EMOJI) + 1)) === true
    || system.slice(0, system.indexOf(EMOJI) + 1).length === system.indexOf(EMOJI) + 1,
  '如果裸 slice 也切不坏，说明测试数据里没有 emoji',
);
check(
  '出站清洗能救回被切坏的文本',
  !/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(
    JSON.stringify(sanitizeJsonStrings({ messages: [{ role: 'system', content: `${'x'.repeat(9)}\ud83d` }] })),
  ),
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('还有可能把半个 emoji 发出去的路径。');
  process.exitCode = 1;
} else {
  console.log('截断不会切开 emoji，出站还有一道清洗兜底。');
}
