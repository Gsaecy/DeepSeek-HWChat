// 请求超时与「服务端过载」重试的守门人。
//
// 用户报告（2026-11-03，同一轮里两次失败）：
//   ① 「请求失败：请求超时（120 秒）。」—— 8 个工具步骤都跑完了，说明网络和接口都是通的；
//   ② 紧接着再发「继续」→「503 Service is too busy … (request_id: …)」。
//
// 实测出来的两个真问题（都在 headless/本地真实 HTTP 服务上跑过，不是读代码猜的）：
//   ① `requestTimeoutSeconds` 原来是**整条请求的总时长**：定时器只设一次，120 秒一到就
//      abort。复现（本机真实 SSE 服务，每 200ms 一帧、超时设 1 秒）：
//        修复前 1030ms → 「请求超时」；修复后 1444ms → 正常收完 7 帧。
//      也就是说「模型写得久」会被当成「网络断了」。
//   ② 拿到 503 就直接判失败（11ms 内结束）。这类响应意味着请求没被处理，重试既安全又必要；
//      修复后同一场景重试 4 次（400+1200+3600ms）再给出带建议的提示。
//
// 运行：node test/check-request-timeout.mjs
import { readFileSync } from 'node:fs';

const CLIENT = readFileSync('src/providers/deepseekClient.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');
const TESTS = readFileSync('src/test/deepseekClient.test.ts', 'utf8');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* ── ① 超时必须是「空闲」语义，不是总时长 ─────────────────────────────── */
check('流式读取每一段数据都重新计时',
  /await withDeadline\(reader\.read\(\), idleMs/.test(CLIENT),
  'read() 上没有截止时间，就等于回到了「整条流最多活 N 秒」');
check('流式阶段不再有覆盖整条请求的定时器',
  !/const timer = setTimeout\(\(\) => timeout\.abort\(\), settings\.requestTimeoutSeconds \* 1000\);\s*\n\s*const signal = mergeAbortSignals\(options\.signal, timeout\.signal\);\s*\n\s*\n\s*let response/.test(CLIENT),
  '旧写法把定时器设在请求开始处、只在 finally 清掉，等于总时长上限');
check('每次重试都用新的 AbortController',
  /const newAttempt = \(\)/.test(CLIENT) && /const controller = new AbortController\(\);/.test(CLIENT),
  '被 abort 过的 signal 永远 aborted，复用它会让每次重试立刻超时');
check('超时先判自己再中止底层请求',
  /reject\(new Error\(message\)\);\s*\n\s*onTimeout\?\.\(\);/.test(CLIENT),
  '先 cancel 会让挂起的 read 以 {done:true} 兑现，超时被吞掉、调用方以为成功（实测踩到）');
check('超时文案说清是「多久没有数据」',
  /连续 \{seconds\} 秒没有收到任何数据/.test(I18N) && /no data received for \{seconds\} seconds/.test(I18N),
  '只说「请求超时」会让人以为请求太长，实际上是「没动静」');

/* ── ② 瞬时状态码要重试，请求本身有问题的不要 ─────────────────────────── */
check('存在可重试状态码集合',
  /const TRANSIENT_STATUS = new Set\(\[[^\]]*503/.test(CLIENT) && /export function shouldRetryStatus/.test(CLIENT),
  '没有这条，503 会立刻把整轮判失败');
check('重试用尽后给出「这是临时状态」的提示',
  /api\.transientHint/.test(CLIENT) && /api\.transientHint/.test(I18N),
  '只说 503 会让用户以为是自己配置坏了');
check('指数退避 + 尊重 Retry-After，且有上限',
  /export function transientRetryDelayMs/.test(CLIENT)
  && /Math\.min\(10_000, retryAfter\)/.test(CLIENT)
  && /Math\.min\(8_000, 400 \* \(3 \*\*/.test(CLIENT),
  '不设上限的话一个 Retry-After: 3600 会把界面冻一小时');
check('代理链路也透出响应头（否则读不到 Retry-After）',
  /headers\?: \{ get\(name: string\): string \| null \}/.test(readFileSync('src/providers/proxyFetch.ts', 'utf8')),
  'ResponseLike 上没有 headers，代理模式下拿不到 Retry-After');
check('重试次数有明确常量，不是魔法数字散落',
  /export const TRANSIENT_STATUS_ATTEMPTS = \d+;/.test(CLIENT), '需要可被测试引用');

/* ── ③ 行为必须被真实测试钉住 ─────────────────────────────────────────── */
for (const [label, pattern] of [
  ['流式回复只要还有数据就继续', /流式回复只要还有数据就继续，不会因为总时长超过 N 秒被掐断/],
  ['真的卡住仍然超时', /真的卡住（连续 N 秒一个字节都没有）仍然超时/],
  ['503 自动重试', /503 这类服务端过载会自动重试/],
  ['401 不重试', /401 \/ 400 这类请求本身有问题的不重试/],
]) {
  check(`回归测试：${label}`, pattern.test(TESTS), '缺测试就等于没修');
}

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
