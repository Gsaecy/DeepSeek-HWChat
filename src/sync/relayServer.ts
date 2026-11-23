/**
 * PlaitCode 跨网中继（零依赖，单文件可部署）。
 *
 * 它**只做三件事**：收密文、按频道排队、把新密文送给在线设备。
 * 它看不到消息内容（端到端加密在两端做），也不执行任何命令 —— 越简单越安全。
 *
 * 传输用 HTTP 长轮询而不是 WebSocket：少一个依赖、少一种协议、任何反向代理都能过，
 * 对我们这种「人类说话」的频率（每秒几次都算多）足够。
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RelayOptions {
  port?: number;
  host?: string;
  /** 每个频道最多保留多少条（环形缓冲）。 */
  maxMessages?: number;
  /** 长轮询最长挂多久。 */
  maxWaitMs?: number;
  /** 每个 IP 每分钟最多多少个请求。 */
  rateLimit?: number;
  log?: (line: string) => void;
}

export interface RelayHandle {
  port: number;
  close: () => Promise<void>;
}

interface StoredMessage {
  seq: number;
  id: string;
  from: string;
  envelope: { iv: string; ct: string };
  at: number;
}

interface Channel {
  keyHash: string;
  createdAt: number;
  seq: number;
  messages: StoredMessage[];
  /** 长轮询里正在等的响应。 */
  waiters: Array<() => void>;
  /** 已收到的消息 id：重复投递直接忽略（设备重连补发会用到）。 */
  seen: Set<string>;
  /** 设备在线表：deviceId → { name, platform, project, at }。 */
  presence: Map<string, { name: string; platform: string; project: string; at: number }>;
}

export const RELAY_VERSION = '1';
const BODY_LIMIT = 96 * 1024;
const PRESENCE_TTL_MS = 90_000;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        resolve(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(undefined));
  });
}

function bearer(request: IncomingMessage): string {
  const raw = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() ?? '';
}

export async function createRelayServer(options: RelayOptions = {}): Promise<RelayHandle> {
  const maxMessages = Math.max(20, options.maxMessages ?? 500);
  const maxWaitMs = Math.max(1_000, Math.min(options.maxWaitMs ?? 22_000, 25_000));
  const rateLimit = Math.max(10, options.rateLimit ?? 240);
  const log = options.log ?? ((): void => undefined);
  const channels = new Map<string, Channel>();
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const channelFor = (id: string, key: string): Channel | undefined => {
    const existing = channels.get(id);
    if (existing) return existing.keyHash === sha256(key) ? existing : undefined;
    // 第一次用某个频道：谁能出示这个频道的密钥，谁就是创建者。
    if (!/^[0-9a-f]{16,64}$/.test(id)) return undefined;
    const created: Channel = {
      keyHash: sha256(key),
      createdAt: Date.now(),
      seq: 0,
      messages: [],
      waiters: [],
      seen: new Set(),
      presence: new Map(),
    };
    channels.set(id, created);
    log(`[relay] 新频道 ${id.slice(0, 8)}…`);
    return created;
  };

  const allowed = (ip: string): boolean => {
    const now = Date.now();
    const entry = buckets.get(ip);
    if (!entry || now >= entry.resetAt) {
      buckets.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= rateLimit;
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const ip = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (!allowed(ip)) {
        json(response, 429, { ok: false, error: 'too many requests' });
        return;
      }
      const rawUrl = request.url ?? '/';
      const route = rawUrl.split('?')[0] ?? '/';
      const query = new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1));

      if (request.method === 'GET' && (route === '/health' || route === '/')) {
        json(response, 200, {
          ok: true,
          service: 'plaitcode-relay',
          version: RELAY_VERSION,
          channels: channels.size,
          uptime: Math.round(process.uptime()),
        });
        return;
      }

      if (!route.startsWith('/v1/')) {
        json(response, 404, { ok: false, error: 'not found' });
        return;
      }

      if (request.method === 'GET' && route === '/v1/poll') {
        const id = query.get('channel') ?? '';
        const key = bearer(request);
        const channel = channelFor(id, key);
        if (!channel) {
          json(response, 403, { ok: false, error: 'channel denied' });
          return;
        }
        const since = Number(query.get('since') ?? 0) || 0;
        const wait = Math.min(Math.max(Number(query.get('wait') ?? 20) * 1000 || 20_000, 0), maxWaitMs);
        const collect = (): StoredMessage[] => channel.messages.filter((item) => item.seq > since);
        const immediate = collect();
        if (immediate.length || wait === 0) {
          json(response, 200, { ok: true, messages: immediate.slice(-200), seq: channel.seq });
          return;
        }
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          const index = channel.waiters.indexOf(finish);
          if (index >= 0) channel.waiters.splice(index, 1);
          clearTimeout(timer);
          if (response.writableEnded) return;
          json(response, 200, { ok: true, messages: collect().slice(-200), seq: channel.seq });
        };
        const timer = setTimeout(finish, wait);
        timer.unref?.();
        channel.waiters.push(finish);
        // 客户端断开（刷新页面、切网络）时要立刻释放，否则连接会越堆越多。
        request.on('close', () => {
          if (done) return;
          done = true;
          const index = channel.waiters.indexOf(finish);
          if (index >= 0) channel.waiters.splice(index, 1);
          clearTimeout(timer);
        });
        return;
      }

      if (request.method === 'POST' && route === '/v1/publish') {
        const raw = await readBody(request);
        if (!raw) {
          json(response, 413, { ok: false, error: 'body too large' });
          return;
        }
        let parsed: { channel?: unknown; id?: unknown; from?: unknown; envelope?: { iv?: unknown; ct?: unknown } };
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          json(response, 400, { ok: false, error: 'invalid json' });
          return;
        }
        const id = typeof parsed.channel === 'string' ? parsed.channel : '';
        const messageId = typeof parsed.id === 'string' ? parsed.id.slice(0, 80) : '';
        const from = typeof parsed.from === 'string' ? parsed.from.slice(0, 80) : '';
        const iv = typeof parsed.envelope?.iv === 'string' ? parsed.envelope.iv : '';
        const ct = typeof parsed.envelope?.ct === 'string' ? parsed.envelope.ct : '';
        if (!messageId || !from || !iv || !ct || ct.length > 64 * 1024) {
          json(response, 400, { ok: false, error: 'invalid message' });
          return;
        }
        const channel = channelFor(id, bearer(request));
        if (!channel) {
          json(response, 403, { ok: false, error: 'channel denied' });
          return;
        }
        if (channel.seen.has(messageId)) {
          json(response, 200, { ok: true, duplicate: true, seq: channel.seq });
          return;
        }
        channel.seq += 1;
        channel.seen.add(messageId);
        if (channel.seen.size > maxMessages * 4) {
          // 只保留最近的一段，防止内存被长期占用。
          channel.seen = new Set([...channel.seen].slice(-maxMessages * 2));
        }
        channel.messages.push({ seq: channel.seq, id: messageId, from, envelope: { iv, ct }, at: Date.now() });
        if (channel.messages.length > maxMessages) channel.messages = channel.messages.slice(-maxMessages);
        for (const wake of [...channel.waiters]) wake();
        json(response, 200, { ok: true, seq: channel.seq });
        return;
      }

      if (route === '/v1/presence') {
        const key = bearer(request);
        let id = query.get('channel') ?? '';
        let device: { id?: unknown; name?: unknown; platform?: unknown; project?: unknown } | undefined;
        if (request.method === 'POST') {
          const raw = await readBody(request);
          if (!raw) {
            json(response, 413, { ok: false, error: 'body too large' });
            return;
          }
          let parsed: { channel?: unknown; device?: typeof device };
          try {
            parsed = JSON.parse(raw) as typeof parsed;
          } catch {
            json(response, 400, { ok: false, error: 'invalid json' });
            return;
          }
          id = typeof parsed.channel === 'string' ? parsed.channel : '';
          device = parsed.device;
        }
        const channel = channelFor(id, key);
        if (!channel) {
          json(response, 403, { ok: false, error: 'channel denied' });
          return;
        }
        if (device) {
          const deviceId = typeof device.id === 'string' ? device.id.slice(0, 80) : '';
          if (!deviceId) {
            json(response, 400, { ok: false, error: 'invalid device' });
            return;
          }
          channel.presence.set(deviceId, {
            name: typeof device.name === 'string' ? device.name.slice(0, 120) : deviceId,
            platform: typeof device.platform === 'string' ? device.platform : 'unknown',
            project: typeof device.project === 'string' ? device.project.slice(0, 120) : '',
            at: Date.now(),
          });
        }
        const now = Date.now();
        for (const [deviceId, entry] of channel.presence) {
          if (now - entry.at > PRESENCE_TTL_MS) channel.presence.delete(deviceId);
        }
        json(response, 200, {
          ok: true,
          devices: [...channel.presence.entries()].map(([deviceId, entry]) => ({ id: deviceId, ...entry })),
        });
        return;
      }

      json(response, 404, { ok: false, error: 'not found' });
    })().catch((error: unknown) => {
      log(`[relay] 请求处理失败：${error instanceof Error ? error.message : String(error)}`);
      if (!response.writableEnded) json(response, 500, { ok: false, error: 'internal error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : (options.port ?? 8787);
  log(`[relay] 监听 ${options.host ?? '0.0.0.0'}:${port}`);

  return {
    port,
    close: () => new Promise<void>((resolve) => {
      for (const channel of channels.values()) {
        for (const wake of [...channel.waiters]) wake();
      }
      server.close(() => resolve());
      // 长轮询会把 close 拖住，给一个上限。
      setTimeout(() => resolve(), 1_500).unref?.();
    }),
  };
}
