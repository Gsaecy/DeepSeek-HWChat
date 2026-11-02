/**
 * 接口连通性的分段诊断。
 *
 * 用途：当用户看到「无法连接到接口」时，一条命令就能说清到底卡在哪一环
 * （DNS / TCP / TLS / HTTP），而不是继续猜。
 *
 * 刻意不做的两件事：
 * - 不发真实对话请求：诊断不该消耗 token，也不该需要 API Key；
 * - 不修改任何设置：只读探针。
 *
 * 每一段都单独计时、单独失败。前一段失败后面就不再跑（DNS 挂了去连 TCP 只会
 * 多等一个超时），报告里会把「没跑」和「通过/失败」区分开。
 */
import { lookup } from 'node:dns/promises';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface ProbeStage {
  /** 阶段标识：url / dns / tcp / tls / http。 */
  id: 'url' | 'dns' | 'tcp' | 'tls' | 'http';
  label: string;
  /** 'ok' 通过、'fail' 失败、'skipped' 前一步失败没跑。 */
  state: 'ok' | 'fail' | 'skipped';
  ms: number;
  detail: string;
}

export interface ProbeReport {
  target: string;
  host: string;
  ok: boolean;
  stages: ProbeStage[];
  /** 第一个失败的阶段（ok 时为 undefined）。 */
  failing?: ProbeStage;
  /** 一句话结论。 */
  summary: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

const skip = (id: ProbeStage['id'], label: string): ProbeStage => ({
  id, label, state: 'skipped', ms: 0, detail: '前一步失败，未执行',
});

const FAIL_HINTS: Record<ProbeStage['id'], string> = {
  url: '接口地址不合法：需要以 http:// 或 https:// 开头（设置 → 连接）。',
  dns: '域名解析失败：网络或 DNS 有问题；若在用代理，确认代理规则放行了该域名。',
  tcp: '端口连不通：目标不可达或被防火墙丢弃；若填的是本机代理端口，先确认代理在运行。',
  tls: 'TLS 握手失败：多见于代理中间人证书，需把代理根证书装进系统信任链。',
  http: '能连上但 HTTP 层失败：看状态码（401 表示只是没带 Key，属正常；5xx 是服务端问题）。',
};

/**
 * 跑一遍分段诊断。
 *
 * `expectStatus`: 允许把业务上「正常但非 2xx」的状态码当成通过 —— 例如不带 Key
 * 请求 `/models` 会得到 401，这恰恰说明网络是通的。
 */
export async function probeEndpoint(
  baseUrl: string,
  options: { timeoutMs?: number; expectStatus?: number[] } = {},
): Promise<ProbeReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expectStatus = options.expectStatus ?? [];
  const stages: ProbeStage[] = [];

  // ── 1. 地址解析 ─────────────────────────────────────────────
  let url: URL;
  const urlStarted = performance.now();
  try {
    url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`不支持的协议 ${url.protocol}`);
    stages.push({ id: 'url', label: '接口地址', state: 'ok', ms: 0, detail: url.origin });
  } catch (error) {
    stages.push({
      id: 'url', label: '接口地址', state: 'fail', ms: Math.round(performance.now() - urlStarted),
      detail: error instanceof Error ? error.message : String(error),
    });
    return finish(baseUrl, '', stages);
  }

  const host = url.hostname;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

  // ── 2. DNS ─────────────────────────────────────────────────
  const dnsStarted = performance.now();
  let address: string;
  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (!resolved.length) throw new Error('没有解析到任何地址');
    address = resolved[0]!.address;
    const list = resolved.map((item) => `${item.address}${item.family === 6 ? ' (IPv6)' : ''}`).join(', ');
    stages.push({
      id: 'dns', label: '域名解析', state: 'ok', ms: Math.round(performance.now() - dnsStarted),
      // 列出全部地址：只有其中一个不通时，报出「解析到几个、用了哪个」才能判断。
      detail: `${resolved.length} 个地址：${list}`,
    });
  } catch (error) {
    stages.push({
      id: 'dns', label: '域名解析', state: 'fail', ms: Math.round(performance.now() - dnsStarted),
      detail: `${host}：${error instanceof Error ? error.message : String(error)}`,
    });
    stages.push(skip('tcp', 'TCP 连接'), skip('tls', 'TLS 握手'), skip('http', 'HTTP 请求'));
    return finish(baseUrl, host, stages);
  }

  // ── 3. TCP ────────────────────────────────────────────────
  const tcpStarted = performance.now();
  const tcp = await new Promise<{ ok: boolean; detail: string; local?: string }>((resolve) => {
    const socket = netConnect({ host, port });
    const done = (ok: boolean, detail: string, local?: string): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, detail, local });
    };
    socket.setTimeout(timeoutMs, () => done(false, `${timeoutMs}ms 内没有连上 ${host}:${port}`));
    socket.once('connect', () => done(true, `${host}:${port}`, `${socket.localAddress}:${socket.localPort}`));
    socket.once('error', (error: NodeJS.ErrnoException) => done(false, `${error.code ?? ''} ${error.message}`.trim()));
  });
  stages.push({
    id: 'tcp', label: 'TCP 连接', state: tcp.ok ? 'ok' : 'fail',
    ms: Math.round(performance.now() - tcpStarted),
    detail: tcp.ok ? `${tcp.detail}（本机 ${tcp.local}）` : tcp.detail,
  });
  if (!tcp.ok) {
    stages.push(skip('tls', 'TLS 握手'), skip('http', 'HTTP 请求'));
    return finish(baseUrl, host, stages);
  }

  // ── 4. TLS（仅 https）───────────────────────────────────────
  if (url.protocol === 'https:') {
    const tlsStarted = performance.now();
    const handshake = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: true });
      const done = (ok: boolean, detail: string): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve({ ok, detail });
      };
      socket.setTimeout(timeoutMs, () => done(false, `${timeoutMs}ms 内握手未完成`));
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        const protocol = socket.getProtocol?.() ?? 'unknown';
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : undefined;
        done(true, `${protocol}｜证书颁发给 ${cert?.subject?.CN ?? '(未知)'}｜有效期至 ${validTo ? validTo.toISOString().slice(0, 10) : '(未知)'}`);
      });
      socket.once('error', (error: NodeJS.ErrnoException) => done(false, `${error.code ?? ''} ${error.message}`.trim()));
    });
    stages.push({
      id: 'tls', label: 'TLS 握手', state: handshake.ok ? 'ok' : 'fail',
      ms: Math.round(performance.now() - tlsStarted), detail: handshake.detail,
    });
    if (!handshake.ok) {
      stages.push(skip('http', 'HTTP 请求'));
      return finish(baseUrl, host, stages);
    }
  } else {
    stages.push({ id: 'tls', label: 'TLS 握手', state: 'skipped', ms: 0, detail: 'http 地址不需要 TLS' });
  }

  // ── 5. HTTP ───────────────────────────────────────────────
  const httpStarted = performance.now();
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, '')}/models`;
  try {
    // 不带 Authorization：401 恰恰证明网络通；用 GET 而不是 POST，避免任何副作用。
    const response = await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    const acceptable = response.ok || expectStatus.includes(response.status) || response.status === 401 || response.status === 403;
    stages.push({
      id: 'http', label: 'HTTP 请求', state: acceptable ? 'ok' : 'fail',
      ms: Math.round(performance.now() - httpStarted),
      detail: `GET ${endpoint} → ${response.status}${response.status === 401 ? '（未带 Key，能收到 401 说明网络正常）' : ''}`,
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } })?.cause;
    stages.push({
      id: 'http', label: 'HTTP 请求', state: 'fail',
      ms: Math.round(performance.now() - httpStarted),
      detail: `${cause?.code ?? ''} ${error instanceof Error ? error.message : String(error)}`.trim(),
    });
  }
  return finish(baseUrl, host, stages);
}

function finish(target: string, host: string, stages: ProbeStage[]): ProbeReport {
  const failing = stages.find((stage) => stage.state === 'fail');
  return {
    target,
    host,
    ok: !failing,
    stages,
    failing,
    summary: failing
      ? `卡在「${failing.label}」：${failing.detail}\n${FAIL_HINTS[failing.id]}`
      : `网络正常：${stages.filter((stage) => stage.state === 'ok').map((stage) => `${stage.label} ${stage.ms}ms`).join(' / ')}`,
  };
}

/** 把报告排成给人看的几行（写输出面板 / 拼通知用）。 */
export function formatProbeReport(report: ProbeReport): string[] {
  const lines = [`接口诊断：${report.target}`];
  for (const stage of report.stages) {
    const mark = stage.state === 'ok' ? '✓' : stage.state === 'fail' ? '✗' : '−';
    lines.push(`  ${mark} ${stage.label}${stage.ms ? ` ${stage.ms}ms` : ''}：${stage.detail}`);
  }
  lines.push(`  结论：${report.summary}`);
  return lines;
}
