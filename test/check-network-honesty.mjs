/*
 * 「卡住」不能报成「网络失败」，几 MB 的请求体不该硬挤代理。
 *
 * 用户原话（2026-11-07）：
 *
 *     为什么 hwchat 和 copilot 都是用的 DeepSeek，hwchat 经常出现这种连不上的情况
 *
 * 真实日志（同日 20:03:50）：
 *
 *     [net] 请求失败 …｜网络失败（ABORT_ERR）：经代理请求失败：ABORT_ERR / 网络错误
 *
 * 那一刻既没断网也没有服务报错：是我们自己「120 秒没收到任何字节」的判定触发了
 * abort，经代理层包装后变成 ABORT_ERR，于是报成「网络失败」。用户据此去查网络，
 * 方向从一开始就是错的。
 *
 * 守护四件事：
 *   1. 我们自己的空闲判定 → StreamStalledError（与网络错误区分）；
 *   2. 流中途卡住也要能认出来；
 *   3. 界面按 stalled 给出「调超时 / 直连」两类可执行建议；
 *   4. 代理有直连名单，且默认放行 api.deepseek.com（不影响 git 子进程）。
 *
 * 用法：node test/check-network-honesty.mjs
 */
import { readFileSync } from 'node:fs';

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
const ABORT = read('src/agent/abortReason.ts');
const PANEL = read('src/views/chatPanel.ts');
const I18N = read('src/core/i18n.ts');
const SETTINGS = read('src/core/settings.ts');
const PACKAGE = read('package.json');
const RUNNER = read('src/agent/agentRunner.ts');

/* ── 1. 卡住 ≠ 网络错误 ──────────────────────────────────────────── */
check(
  '有专门的 StreamStalledError（带阶段 / 秒数 / 请求体大小 / 是否走代理）',
  /export class StreamStalledError extends Error/.test(CLIENT)
    && /phase: 'awaiting-response' \| 'mid-stream'/.test(CLIENT)
    && /payloadBytes: number/.test(CLIENT),
  '只有一个「失败」字符串时，用户无从判断该改什么',
);
check(
  '等响应头阶段的空闲判定被标记出来',
  /let stalledByUs = false;/.test(CLIENT) && /stalledByUs = true; current\.abort\(\)/.test(CLIENT),
);
check(
  '流中途卡住也单独识别',
  /stalledMidStream = true;/.test(CLIENT)
    && /throw new StreamStalledError\('mid-stream'/.test(CLIENT),
);
check(
  '分类器把 stalled 排在 network 前面（否则会被误判）',
  /return 'stalled';/.test(ABORT) && /StreamStalledError/.test(ABORT),
);
check(
  '用户主动停止仍然是 user',
  /if \(!signalAborted && chain\.some/.test(ABORT),
);

/* ── 2. 界面给出可执行建议 ───────────────────────────────────────── */
check(
  'stalled 有独立文案，且带秒数',
  /'chat\.aborted\.stalled': \{ zh:/.test(I18N) && /\{seconds\}/.test(I18N),
);
check(
  '文案里同时给出「调大超时」和「直连名单」两条路',
  /请求超时」调大/.test(I18N) && /直连名单/.test(I18N),
);
check(
  '面板按 stalled 注入秒数',
  /abortCause === 'stalled'/.test(PANEL) && /chat\.aborted\.stalled/.test(PANEL),
);

/* ── 3. 代理直连名单 ────────────────────────────────────────────── */
check(
  '设置项 proxyBypassHosts 存在，默认 api.deepseek.com',
  /hwchat\.proxyBypassHosts/.test(PACKAGE) && /"default": \[\s*"api\.deepseek\.com"\s*\]/.test(PACKAGE),
);
check(
  '读取时有归一化（去协议/端口/路径，小写）',
  /export function normalizeHostList/.test(SETTINGS) && /proxyBypassHosts: normalizeHostList/.test(SETTINGS),
);
check(
  '请求时命中名单就直连，未命中才走代理',
  /const bypassed = \(input: string\): boolean =>/.test(CLIENT)
    && /if \(bypassed\(input\)\)/.test(CLIENT)
    && /return fetchViaProxy\(input, \{/.test(CLIENT),
);
check(
  '只影响 HWChat 自己的请求（git 子进程不受影响这一点写进说明）',
  /只影响 \*\*HWChat 自己发出的请求\*\*/.test(CLIENT) && /git push\/pull/.test(CLIENT),
);

/* ── 4. 请求体更小：降低首字节超时概率 ───────────────────────────── */
check('历史窗口从 24 条降到 12 条', /const CONTEXT_WINDOW_MESSAGES = 12;/.test(PANEL));
check('字节预算从 1 MB 降到 768 KB', /const CONTEXT_WINDOW_BYTES = 768 \* 1024;/.test(PANEL));
check('运行内工具输出从 6 条降到 3 条', /const TOOL_PAYLOAD_KEEP = 3;/.test(RUNNER));
check(
  '请求体过大时记一行体积（出了问题先看这个数）',
  /LARGE_PAYLOAD_CHARS/.test(CLIENT) && /请求体 .* MB/.test(CLIENT),
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「连不上」仍然说不清是哪一类，或者仍在硬挤代理。');
  process.exitCode = 1;
} else {
  console.log('卡住与断网分开报；DeepSeek 直连，其它流量与 git 子进程照旧。');
}
