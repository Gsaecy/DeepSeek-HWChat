/**
 * 中继客户端：长轮询收发 + 端到端加解密。
 *
 * 它不 import vscode，也不碰 UI —— 只负责把 `SyncMessage` 加密后送出去、
 * 把收到的密文解回 `SyncMessage` 交给上层。这样这一层能在 Node 测试里真跑。
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { parseSyncMessage, type SyncMessage, type SyncPeer } from './lanProtocol';
import { buildPairingText, deriveKeys, open, seal, type RelayKeys } from './relayCrypto';

export interface RelayStatus {
  connected: boolean;
  channel: string;
  url: string;
  peers: number;
  lastError?: string;
  received: number;
  sent: number;
}

export interface RelayClientOptions {
  url: string;
  secret: string;
  device: SyncPeer;
  /** 收到一条能解开的对端消息。返回值忽略，异常只记日志。 */
  onMessage: (message: SyncMessage) => Promise<void> | void;
  onStatus?: (status: RelayStatus) => void;
  log?: (line: string, level?: 'info' | 'warn') => void;
  /** 长轮询每次挂多久（秒）。 */
  pollSeconds?: number;
}

export interface Disposable {
  dispose: () => void;
}

interface RelayResponse {
  status: number;
  body: Record<string, unknown> | undefined;
}

const MAX_BACKOFF_MS = 10_000;

/** 一次 HTTP 请求；`abort` 用来在 stop() 时把挂着的长轮询掐断。 */
function relayRequest(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number; onAbort?: (abort: () => void) => void },
  headers: Record<string, string> = {},
): Promise<RelayResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('中继地址不合法'));
      return;
    }
    const payload = init.body === undefined ? undefined : Buffer.from(JSON.stringify(init.body), 'utf8');
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request: ClientRequest = send(target, {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
      timeout: init.timeoutMs,
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> | undefined;
        try {
          body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
        } catch {
          body = undefined;
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', (error: Error) => reject(error));
    init.onAbort?.(() => request.destroy(new Error('已停止')));
    if (payload) request.write(payload);
    request.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 消息在中继里的标识。
 *
 * 需求 / 群发言 / 协作消息自带 id；报告没有 id（它按「需求 + 平台 + 设备」覆盖更新），
 * 所以用这几个字段拼一个稳定值 —— 发送方加密时的 AAD 和接收方解密时必须完全一致。
 */
export function relayMessageId(message: SyncMessage): string {
  const withId = message as { id?: unknown };
  if (typeof withId.id === 'string' && withId.id) return withId.id.slice(0, 80);
  const report = message as { requirementId?: unknown; from?: { id?: unknown }; at?: unknown; status?: unknown };
  return [
    'report',
    typeof report.requirementId === 'string' ? report.requirementId : '',
    typeof report.from?.id === 'string' ? report.from.id : '',
    String(report.at ?? ''),
    String(report.status ?? ''),
  ].join(':').slice(0, 80);
}

export class RelayClient implements Disposable {
  private readonly keys: RelayKeys;
  private readonly base: string;
  private running = false;
  private loop: Promise<void> | undefined;
  private presenceTimer?: NodeJS.Timeout;
  private abortPoll?: () => void;
  private backoff = 0;
  private received = 0;
  private sent = 0;
  private peers = 0;
  private lastError: string | undefined;
  private since = 0;

  constructor(private readonly options: RelayClientOptions) {
    this.keys = deriveKeys(options.secret);
    this.base = options.url.replace(/\/+$/, '');
  }

  /** 扫码/粘贴配对文本后要展示给对方的那一行（也能直接做成二维码）。 */
  pairingText(): string {
    return buildPairingText(this.base, this.options.secret);
  }

  status(): RelayStatus {
    return {
      connected: this.running && !this.lastError,
      channel: this.keys.channel,
      url: this.base,
      peers: this.peers,
      received: this.received,
      sent: this.sent,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.backoff = 0;
    this.lastError = undefined;
    this.emit();
    void this.presence();
    this.presenceTimer = setInterval(() => { void this.presence(); }, 30_000);
    this.presenceTimer.unref?.();
    this.loop = this.pollLoop();
  }

  stop(): void {
    this.running = false;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = undefined;
    this.abortPoll?.();
    this.abortPoll = undefined;
    this.emit();
  }

  dispose(): void {
    this.stop();
  }

  /** 发一条消息（自动加密）。 */
  async send(message: SyncMessage): Promise<{ ok: boolean; message: string }> {
    try {
      const id = relayMessageId(message);
      const envelope = seal(this.keys, id, JSON.stringify(message));
      const response = await relayRequest(`${this.base}/v1/publish`, {
        method: 'POST',
        body: { channel: this.keys.channel, id, from: this.options.device.id, envelope },
        timeoutMs: 15_000,
      }, { authorization: `Bearer ${this.keys.relay}` });
      if (response.status !== 200 || response.body?.ok !== true) {
        const reason = typeof response.body?.error === 'string' ? response.body.error : `HTTP ${response.status}`;
        return { ok: false, message: `中转拒绝：${reason}` };
      }
      this.sent += 1;
      this.emit();
      return { ok: true, message: '已发到中转' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.emit();
      return { ok: false, message: `发不出去：${message}` };
    }
  }

  private async presence(): Promise<void> {
    try {
      const response = await relayRequest(`${this.base}/v1/presence`, {
        method: 'POST',
        body: {
          channel: this.keys.channel,
          device: {
            id: this.options.device.id,
            name: this.options.device.name,
            platform: this.options.device.platform,
            project: this.options.device.project,
          },
        },
        timeoutMs: 8_000,
      }, { authorization: `Bearer ${this.keys.relay}` });
      const devices = Array.isArray(response.body?.devices) ? response.body.devices : [];
      this.peers = Math.max(0, devices.length - 1);
      if (response.status === 403) {
        this.lastError = '频道密钥不匹配';
      } else if (response.status === 200) {
        this.lastError = undefined;
      }
      this.emit();
    } catch {
      // 在线表失败不影响收发；下一轮会重试。
    }
  }

  private emit(): void {
    this.options.onStatus?.(this.status());
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.lastError !== message) this.options.log?.(`[relay] ${message}`, 'warn');
    this.lastError = message;
    this.emit();
  }

  private async pollLoop(): Promise<void> {
    const wait = Math.max(5, Math.min(this.options.pollSeconds ?? 20, 25));
    while (this.running) {
      try {
        const query = new URLSearchParams({
          channel: this.keys.channel,
          since: String(this.since),
          wait: String(wait),
        });
        const response = await relayRequest(`${this.base}/v1/poll?${query.toString()}`, {
          method: 'GET',
          timeoutMs: (wait + 8) * 1000,
          onAbort: (abort) => { this.abortPoll = abort; },
        }, { authorization: `Bearer ${this.keys.relay}` });
        this.abortPoll = undefined;
        if (!this.running) break;
        if (response.status === 403) {
          this.fail(new Error('频道密钥不匹配（检查两台设备的配对信息是否一致）'));
          await sleep(MAX_BACKOFF_MS);
          continue;
        }
        if (response.status !== 200) {
          this.fail(new Error(`轮询失败：HTTP ${response.status}`));
          this.backoff = Math.min(this.backoff ? this.backoff * 2 : 1_000, MAX_BACKOFF_MS);
          await sleep(this.backoff);
          continue;
        }
        this.backoff = 0;
        if (this.lastError) {
          this.lastError = undefined;
          this.emit();
        }
        const messages = Array.isArray(response.body?.messages) ? response.body.messages : [];
        for (const entry of messages) {
          if (!entry || typeof entry !== 'object') continue;
          const record = entry as { seq?: unknown; id?: unknown; from?: unknown; envelope?: { iv?: unknown; ct?: unknown } };
          const seq = typeof record.seq === 'number' ? record.seq : 0;
          if (seq > this.since) this.since = seq;
          const id = typeof record.id === 'string' ? record.id : '';
          const from = typeof record.from === 'string' ? record.from : '';
          if (!id || from === this.options.device.id) continue;
          if (typeof record.envelope?.iv !== 'string' || typeof record.envelope?.ct !== 'string') continue;
          const plaintext = open(this.keys, id, { iv: record.envelope.iv, ct: record.envelope.ct });
          if (!plaintext) {
            this.options.log?.('[relay] 收到无法解密的消息（密钥不一致或已被篡改），已丢弃', 'warn');
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(plaintext);
          } catch {
            continue;
          }
          const message = parseSyncMessage(parsed);
          if (!message) continue;
          this.received += 1;
          this.emit();
          try {
            await this.options.onMessage(message);
          } catch (error) {
            this.options.log?.(`[relay] 处理消息失败：${error instanceof Error ? error.message : String(error)}`, 'warn');
          }
        }
      } catch (error) {
        this.abortPoll = undefined;
        if (!this.running) break;
        this.fail(error);
        this.backoff = Math.min(this.backoff ? this.backoff * 2 : 1_000, MAX_BACKOFF_MS);
        await sleep(this.backoff);
      }
    }
  }
}
