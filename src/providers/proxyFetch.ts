/**
 * 经 HTTP 代理（CONNECT 隧道）发请求。
 *
 * 为什么需要它（实测依据）：
 *   · Node 的全局 `fetch`（undici）**忽略** `HTTPS_PROXY` / `ALL_PROXY` 环境变量 ——
 *     把代理指向一个没人监听的端口，fetch 依然直连成功，说明它根本没读这些变量；
 *   · VS Code 的 `http.proxy` 也不覆盖扩展的 `fetch`（官方文档：*Extensions don't
 *     benefit yet from the same proxy support that VS Code supports*）；
 *   · 而用户的机器上确实跑着一个 HTTP 代理（`curl -x http://127.0.0.1:8080` 正常），
 *     直连在别的时刻又不稳定 —— 这就是「有时候 fetch failed，重试又好了」的典型现场。
 *
 * 所以给 `hwchat.proxy` 一条真正的通路：自己开 TCP → 发 `CONNECT` → 在该 socket 上
 * 做 TLS → 用 `https.request` 发原始 HTTP，再把结果包装成 fetch 兼容的最小对象，
 * 这样上层的 SSE 解析、错误读取、模型列表都无需改动。
 *
 * 只支持 `http://` 代理（CONNECT 是 HTTP 语义）；`socks5://` 明确报错，不假装支持。
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

/**
 * fetch 兼容的响应形状。
 *
 * `Response` 与代理路径返回的对象都满足它，所以上层（SSE 解析、错误读取、模型列表）
 * 不需要知道这次请求走的是直连还是隧道。
 */
export type ResponseLike = {
  ok: boolean;
  status: number;
  statusText: string;
  /** 只需要 `get`：目前用于读 `Retry-After`（503 过载时决定等多久再重试）。 */
  headers?: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

/** fetch 兼容的最小响应形状：只覆盖本项目实际用到的字段。 */
export type ProxyResponse = ResponseLike & { body: ReadableStream<Uint8Array> };

export class ProxyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ProxyError';
  }
}

interface ParsedProxy {
  host: string;
  port: number;
  /** `user:pass` 的 Base64（没有凭据时为 undefined）。 */
  authorization?: string;
}

export function parseProxyUrl(value: string): ParsedProxy {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProxyError(`代理地址不合法：${value}（应形如 http://127.0.0.1:8080）`, 'ERR_INVALID_PROXY');
  }
  if (url.protocol === 'socks5:' || url.protocol === 'socks5h:' || url.protocol === 'socks:') {
    throw new ProxyError(
      '暂不支持 socks 代理（只支持 http:// 形式的 CONNECT 代理）。如果代理软件同时提供 HTTP 端口，请填那一个。',
      'ERR_SOCKS_UNSUPPORTED',
    );
  }
  if (url.protocol !== 'http:') {
    throw new ProxyError(`不支持的代理协议 ${url.protocol}（只支持 http://）`, 'ERR_INVALID_PROXY');
  }
  const authorization = url.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
    : undefined;
  return {
    host: url.hostname,
    port: Number(url.port || 80),
    authorization,
  };
}

/** 在代理上开一条到 `host:port` 的 CONNECT 隧道。 */
async function openTunnel(proxy: ParsedProxy, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const socket = netConnect({ host: proxy.host, port: proxy.port });
  socket.setTimeout(timeoutMs);
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeAllListeners();
      socket.setTimeout(0);
    };
    socket.once('connect', () => {
      cleanup();
      resolve();
    });
    socket.once('timeout', () => {
      cleanup();
      socket.destroy();
      reject(new ProxyError(`连接代理 ${proxy.host}:${proxy.port} 超时（${timeoutMs}ms）`, 'ETIMEDOUT'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      socket.destroy();
      reject(new ProxyError(
        `连不上代理 ${proxy.host}:${proxy.port}（${error.code ?? error.message}）。代理软件在运行吗？端口填对了吗？`,
        error.code ?? 'ECONNREFUSED',
      ));
    });
  });

  const authority = `${host}:${port}`;
  /*
   * 请求头必须**恰好**以空行结束。
   *
   * 实测踩坑：多一个 `\r\n` 时，多出来的那两个字节会被代理当成隧道里的第一个数据包
   * 转给目标服务器 —— 于是 TLS ClientHello 前面多了两个换行，握手直接 ECONNRESET。
   * 所以这里显式拼行，不用「数组里塞空串再 join」那种写法。
   */
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxy.authorization) lines.push(`Proxy-Authorization: ${proxy.authorization}`);
  const headers = `${lines.join('\r\n')}\r\n\r\n`;

  return new Promise<Socket>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
      const status = Number(statusLine.split(' ')[1] ?? 0);
      if (status !== 200) {
        socket.destroy();
        reject(new ProxyError(`代理拒绝建立隧道：${statusLine}（目标 ${authority}）`, 'ERR_PROXY_CONNECT'));
        return;
      }
      // 头部之后可能已经带着隧道数据：塞回流里，否则 TLS 握手会缺开头几个字节。
      const rest = buffer.slice(end + 4);
      if (rest) socket.unshift(Buffer.from(rest, 'latin1'));
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      reject(new ProxyError(`代理隧道出错：${error.code ?? error.message}`, error.code ?? 'ERR_PROXY_CONNECT'));
    });
    socket.write(headers);
  });
}

/**
 * 把 Node 的 IncomingMessage 变成可读流，并给一个「读完了」的 promise。
 *
 * `collected()` 必须是**异步**的：首版实现同步拼接已收到的 chunk，实测拿到的是空串
 * —— 数据还没从 socket 流出来就已经取过了。`text()` / `json()` 必须等 `done`。
 */
function toBodyStream(response: IncomingMessage, dispose: () => void): {
  stream: ReadableStream<Uint8Array>;
  done: Promise<void>;
  collected: () => string;
} {
  const chunks: Buffer[] = [];
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        controller.enqueue(new Uint8Array(chunk));
      });
      response.on('end', () => {
        try { controller.close(); } catch { /* 已关闭 */ }
        resolveDone();
        // 隧道的 socket 是我们自己建的，不主动关掉进程就一直挂着（实测：测试进程不退出）。
        dispose();
      });
      response.on('error', (error) => {
        try { controller.error(error); } catch { /* 已关闭 */ }
        rejectDone(error);
        dispose();
      });
      response.on('close', () => {
        // 没有 'end' 就被关掉（连接被掐）：让等待方知道，不要永远挂着。
        resolveDone();
        dispose();
      });
    },
    cancel() {
      response.destroy();
      dispose();
    },
  });
  return { stream, done, collected: () => Buffer.concat(chunks).toString('utf8') };
}

/**
 * 经代理发起一次请求，返回 fetch 兼容的最小响应。
 *
 * `init` 只用 `method` / `headers` / `body` / `signal`：这几个就够本项目的对话与
 * 模型列表两条路径了；其余 fetch 选项不假装支持（用不到就不实现）。
 */
export async function fetchViaProxy(
  target: string,
  init: { method?: string; headers?: Headers; body?: string; signal?: AbortSignal },
  proxyValue: string,
  timeoutMs = 120_000,
): Promise<ProxyResponse> {
  const proxy = parseProxyUrl(proxyValue);
  const url = new URL(target);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const socket = await openTunnel(proxy, url.hostname, port, Math.min(timeoutMs, 20_000));

  let transport: Socket | TLSSocket = socket;
  if (url.protocol === 'https:') {
    transport = await new Promise<TLSSocket>((resolve, reject) => {
      // servername 必须显式给：此时我们连的是代理 IP，SNI 需要的是目标域名。
      const secure = tlsConnect({ socket, servername: url.hostname });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', (error: NodeJS.ErrnoException) => {
        socket.destroy();
        reject(new ProxyError(`经代理的 TLS 握手失败：${error.code ?? error.message}`, error.code ?? 'ERR_TLS'));
      });
    });
  }

  const headers: Record<string, string> = {};
  init.headers?.forEach((value, key) => {
    headers[key] = value;
  });
  if (init.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(init.body));

  /*
   * 用自定义 Agent 把已经建好的隧道交给请求。
   *
   * 踩过的坑：直接把 `createConnection: () => transport` 写在 request options 上
   * **是不生效的** —— 请求会绕过隧道直连目标（测试里用一个「只说 200、不转发」的
   * 黑洞代理抓到了：源站仍然收到了请求）。必须通过 Agent 子类覆写
   * `createConnection`，这才是 Node 文档支持的方式。
   */
  class TunnelAgent extends (url.protocol === 'https:' ? HttpsAgent : HttpAgent) {
    override createConnection(): Socket {
      return transport;
    }
  }

  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = requester({
      protocol: url.protocol,
      hostname: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers,
      agent: new TunnelAgent({ keepAlive: false, maxSockets: 1 }),
      timeout: timeoutMs,
    }, resolve);
    request.on('timeout', () => {
      request.destroy(new ProxyError(`经代理请求超时（${timeoutMs}ms）`, 'ETIMEDOUT'));
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      reject(new ProxyError(`经代理请求失败：${error.code ?? error.message}`, error.code ?? 'ERR_PROXY_REQUEST'));
    });
    init.signal?.addEventListener('abort', () => {
      request.destroy(new ProxyError('请求已取消', 'ABORT_ERR'));
    }, { once: true });
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });

  const dispose = (): void => {
    transport.destroy();
    socket.destroy();
  };
  const { stream, done, collected } = toBodyStream(response, dispose);
  const status = response.statusCode ?? 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: response.statusMessage ?? '',
    headers: {
      get(name: string) {
        const value = response.headers[name.toLocaleLowerCase()];
        if (value === undefined) return null;
        return Array.isArray(value) ? value.join(', ') : value;
      },
    },
    body: stream,
    async text() {
      // 上层要么读流（SSE），要么调 text()（错误体），两条路互斥；这里等读完再返回。
      await done;
      return collected();
    },
    async json() {
      await done;
      return JSON.parse(collected()) as unknown;
    },
  };
}
