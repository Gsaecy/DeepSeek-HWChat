import net from 'node:net';

/**
 * 打开网页预览前，先确认那个地址上真的有东西在监听。
 *
 * 现场（用户 2026-11-04）：模型先假设端口，直接 `open_web_preview {"url":"http://127.0.0.1:8790/"}`，
 * 可 8790 上根本没有服务 —— Simple Browser 打开的就是一个报错页，用户看到的是
 * 「预览打不开」，却不知道是服务没起来。审计日志里 8796/8765/8766/5180/8790 都这样开过。
 *
 * 这里只做一次 TCP 连接探测（不发请求、不读页面），所以：
 *  - 对任何框架的 HTTP 服务都成立，不依赖它回什么状态码；
 *  - 开销是一次 connect，通常 < 5ms，最坏等 `timeoutMs`。
 */

export interface PreviewProbeResult {
  reachable: boolean;
  /** 连接失败时的 Node 错误码：`ECONNREFUSED`（没服务）/ `ETIMEDOUT` / `ENOTFOUND` 等。 */
  code?: string;
  host?: string;
  port?: number;
}

/** 从 URL 里取 `host` / `port`；端口缺省按协议补 80 / 443。 */
export function previewEndpoint(rawUrl: string): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  // `URL` 会把 IPv6 写成 `[::1]`，net.connect 需要裸地址。
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
  return { host, port };
}

export async function probePreviewEndpoint(rawUrl: string, timeoutMs = 1_500): Promise<PreviewProbeResult> {
  const endpoint = previewEndpoint(rawUrl);
  if (!endpoint) return { reachable: false, code: 'EINVAL' };
  const { host, port } = endpoint;
  return new Promise<PreviewProbeResult>((resolvePromise) => {
    let settled = false;
    const socket = new net.Socket();
    const finish = (result: PreviewProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise({ ...result, host, port });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true, host, port }));
    socket.once('timeout', () => finish({ reachable: false, code: 'ETIMEDOUT', host, port }));
    socket.once('error', (error: NodeJS.ErrnoException) => finish({ reachable: false, code: error.code ?? 'EUNKNOWN', host, port }));
    socket.connect(port, host);
  });
}

/**
 * 只对「本机服务」做探测：公网地址打不开通常是网络问题，探测只会拖慢预览，
 * 而且它并不需要由我们启动。
 */
export function isLocalPreviewHost(host: string): boolean {
  const value = host.toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '0.0.0.0') return true;
  if (/^127\./.test(value)) return true;
  if (/^10\./.test(value)) return true;
  if (/^192\.168\./.test(value)) return true;
  return /^172\.(?:1[6-9]|2\d|3[01])\./.test(value);
}

/**
 * 端口探不通时，给模型一段**可以直接照做**的下一步。
 *
 * 只说「打不开」模型会换个地址再猜；说清「先启动、用 background: true、端口取这个」
 * 才能让它一轮修好。
 */
export function previewUnreachableAdvice(
  probe: PreviewProbeResult,
  deps: { t: (key: string, values?: Record<string, string | number>) => string; url: string },
): string {
  const host = probe.host ?? '127.0.0.1';
  const port = probe.port ?? 0;
  const reason = probe.code === 'ECONNREFUSED'
    ? deps.t('tool.preview.refused', { host, port })
    : deps.t('tool.preview.failed', { host, port, code: probe.code ?? 'EUNKNOWN' });
  return [
    deps.t('tool.preview.notOpened', { url: deps.url }),
    reason,
    deps.t('tool.preview.nextStep', { port }),
  ].join('\n');
}
