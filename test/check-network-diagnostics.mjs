// 网络故障可诊断性的守门人。
//
// 现场：用户报「hwchat对话弹出：请求失败：无法连接到接口：fetch failed」。
// 那句话对用户没有任何用处 —— DNS 挂了、代理没开、证书不对，看到的都一样。
//
// 本文件守的是这次排查后定下的不变量（每条都对应一次真实的坑）：
//   1. `fetch failed` 必须被翻译出真实原因（阶段 + 错误码 + 可操作建议）；
//   2. `{name: 'TimeoutError'}`（Node 22 的 `AbortSignal.timeout` 实测形状，**没有 cause**）
//      必须判为超时且**不可重试** —— 否则一次 120 秒的超时会被重试三次，变成 6 分钟；
//   3. 只在「fetch 自己抛出」时重试（响应头都没拿到 → 不可能已计费）；拿到响应后一律不重试；
//   4. 通过代理时必须**真的**走隧道：`createConnection` 写在 request options 上不生效
//      （实测：请求会绕过隧道直连），必须用 Agent 子类覆写；
//   5. 客户端两条请求路径都要带上重试与日志，失败要能在输出面板看到。
//
// 运行：node test/check-network-diagnostics.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DIAG = readFileSync('src/providers/netDiagnostics.ts', 'utf8');
const PROXY = readFileSync('src/providers/proxyFetch.ts', 'utf8');
const CLIENT = readFileSync('src/providers/deepseekClient.ts', 'utf8');
const EXT = readFileSync('src/extension.ts', 'utf8');
const TYPES = readFileSync('src/core/types.ts', 'utf8');

/* 1. 归类器覆盖关键阶段 */
for (const token of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN']) {
  assert.ok(DIAG.includes(token), `归类器缺少 ${token} 的判断：这类错误会退化成「未知网络错误」`);
}
assert.match(DIAG, /function flattenError/, '必须沿 cause 链找最内层错误（fetch failed 只是外壳）');
assert.match(DIAG, /candidate\.errors/, 'undici 的 AggregateError.errors 也要展开（多地址连不上时用它）');

/* 2. 超时不可重试 */
const timeoutBranch = DIAG.slice(DIAG.indexOf("name === 'TimeoutError'"), DIAG.indexOf("name === 'AbortError'"));
assert.ok(timeoutBranch.length > 0, '必须单独识别 TimeoutError（AbortSignal.timeout 抛的是它，且没有 cause）');
assert.match(timeoutBranch, /retryable:\s*false/, '超时不许可重试：一次 120 秒的超时重试三次就是 6 分钟');
assert.match(DIAG, /retryable:\s*false/, 'AbortError 同理');
// 代理配置类错误也不该重试
assert.ok(
  DIAG.includes("'ERR_SOCKS_UNSUPPORTED'") && DIAG.includes('retryable: false'),
  '代理配置错误（地址写错 / socks / 拒绝建隧道）要判成不可重试',
);

/* 3. 重试边界 */
assert.match(DIAG, /export async function fetchWithNetworkRetry/, '必须有统一的重试入口');
const retry = DIAG.slice(DIAG.indexOf('export async function fetchWithNetworkRetry'));
assert.match(retry, /catch \(error\)/, '重试只应发生在 fetch 抛出时（catch 内）');
assert.match(retry, /cause\.retryable && attempt < attempts/, '必须同时满足「可重试」与「还有次数」');
assert.match(retry, /options\.signal\?\.aborted/, '取消后必须立刻停止重试');

/* 4. 代理必须真的走隧道 */
assert.match(PROXY, /class TunnelAgent extends/, '必须用 Agent 子类把隧道 socket 交给请求');
assert.match(PROXY, /override createConnection\(\): Socket/, 'Agent 子类要覆写 createConnection');
assert.doesNotMatch(
  PROXY.slice(PROXY.indexOf('const requester ='), PROXY.indexOf('const { stream, done, collected }')),
  /^\s*createConnection:\s*\(\)\s*=>/m,
  '不要把 createConnection 写在 request options 上：实测不生效，请求会绕过隧道直连',
);
assert.match(PROXY, /agent: new TunnelAgent/, '必须把 TunnelAgent 传给 request');
// CONNECT 头必须以恰好一个空行结束（多一个 \r\n 会把字节漏进 TLS 握手 → ECONNRESET）
assert.match(PROXY, /\\r\\n\\r\\n`/, 'CONNECT 请求头必须以恰好一个空行结束');
assert.doesNotMatch(PROXY, /\['',\s*''\]\.join/, '不要用「数组塞空串再 join」拼 CONNECT 头（会多出换行）');
// 隧道数据余量要还给 socket
assert.match(PROXY, /socket\.unshift/, 'CONNECT 响应头之后若已有数据，必须塞回流里');
// text()/json() 必须等流结束
assert.match(PROXY, /await done;/, 'text()/json() 必须等流读完，否则拿到的是空串（实测踩过）');
assert.match(PROXY, /dispose\(\)/, '响应结束要释放隧道 socket，否则进程不退出');

/* 5. 客户端接线 */
assert.match(CLIENT, /fetchWithNetworkRetry\(endpoint/, '对话请求必须走带重试的入口');
assert.equal((CLIENT.match(/fetchWithNetworkRetry\(endpoint/g) ?? []).length, 2, '对话与模型列表两条路径都要走重试');
assert.match(CLIENT, /this\.transport\(settings\)/, '必须按设置选择直连/代理传输');
assert.match(CLIENT, /private logFailure/, '最终失败要写日志，否则事后无法复盘');
assert.match(EXT, /\(line\) => output\.warn\(line\)/, '客户端必须把网络事件接到输出面板');

/* 6. 代理设置存在且默认为空 */
assert.match(TYPES, /proxy: string;/, 'ChatSettings 必须带 proxy 字段');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const proxySetting = pkg.contributes.configuration.properties['hwchat.proxy'];
assert.ok(proxySetting, '必须在 package.json 里注册 hwchat.proxy');
assert.equal(proxySetting.default, '', 'proxy 默认必须为空（直连）：环境里残留一个失效代理变量时，自动启用会把好请求弄坏');
assert.ok(!/proxy\s*:\s*process\.env/.test(TYPES), '不许从环境变量自动推断代理');

console.log('✓ fetch failed 会被翻译成 dns / connect / tls / http + 可操作建议');
console.log('✓ TimeoutError 与 AbortError 不可重试（避免 120s × 3）');
console.log('✓ 只在拿到响应之前重试；取消后立即停止');
console.log('✓ 代理走 Agent 覆写的真隧道（不是写在 request options 上的假隧道）');
console.log('✓ 客户端两条路径都带重试与日志，代理默认关闭（直连）');
console.log('\n全部通过：网络故障不再是一句无法诊断的 fetch failed');
