/**
 * 跨网络中继的密钥派生与端到端加密。
 *
 * 原则：**中转只看到密文和路由信息**。设备之间共享一个 `pairingSecret`（32 字节，
 * 只在扫码那一刻传递一次），从它派生出三把互不相同的值：
 *
 *  - `channel`：频道号（中转用它寻址，反推不出 secret）；
 *  - `relay`：中转鉴权用（中转只存它的哈希）；
 *  - `enc`：AES-256-GCM 密钥（永远不出设备）。
 *
 * 这样即使中转被拖库，攻击者拿到的也只是哈希和密文。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface RelayKeys {
  /** 频道号：32 位十六进制，由 secret 单向派生。 */
  channel: string;
  /** 中转鉴权密钥：放在 `Authorization: Bearer` 里。 */
  relay: string;
  /** 端到端加密密钥（32 字节）。 */
  enc: Buffer;
}

const CHANNEL_PREFIX = 'plaitcode/channel/1:';
const RELAY_PREFIX = 'plaitcode/relay/1:';
const ENC_PREFIX = 'plaitcode/enc/1:';

function hash(prefix: string, secret: string): Buffer {
  return createHash('sha256').update(prefix).update(secret, 'utf8').digest();
}

/** 生成一个新的配对密钥（只在二维码里出现一次）。 */
export function newPairingSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function deriveKeys(secret: string): RelayKeys {
  const trimmed = secret.trim();
  if (trimmed.length < 16) throw new Error('配对密钥太短');
  return {
    channel: hash(CHANNEL_PREFIX, trimmed).toString('hex').slice(0, 32),
    relay: hash(RELAY_PREFIX, trimmed).toString('base64url'),
    enc: hash(ENC_PREFIX, trimmed),
  };
}

export interface SealedEnvelope {
  /** 12 字节随机 IV，base64。 */
  iv: string;
  /** 密文 + GCM tag，base64。 */
  ct: string;
}

/**
 * 加密一条消息。
 *
 * AAD 绑定「频道 + 消息 id」：中转即使把某条密文挪到别的频道或换个 id，
 * 解密会直接失败，而不是安静地张冠李戴。
 */
export function seal(keys: RelayKeys, messageId: string, plaintext: string): SealedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.enc, iv);
  cipher.setAAD(Buffer.from(`${keys.channel}:${messageId}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ct: Buffer.concat([ct, cipher.getAuthTag()]).toString('base64') };
}

/** 解密；密钥不对、被篡改、频道/id 对不上都返回 undefined（绝不抛给上层）。 */
export function open(keys: RelayKeys, messageId: string, envelope: SealedEnvelope): string | undefined {
  try {
    const raw = Buffer.from(envelope.ct, 'base64');
    if (raw.length < 17) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${keys.channel}:${messageId}`, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** 设备怎么把另一台设备拉进同一个频道：一行文本，既能贴给人也能做成二维码。 */
export function buildPairingText(relayUrl: string, secret: string): string {
  const url = relayUrl.replace(/\/+$/, '');
  return `plaitcode://join?u=${encodeURIComponent(url)}&s=${encodeURIComponent(secret)}`;
}

export function parsePairingText(text: string): { url: string; secret: string } | undefined {
  const value = text.trim();
  if (!value.startsWith('plaitcode://join')) return undefined;
  const query = value.slice(value.indexOf('?') + 1);
  const params = new URLSearchParams(query);
  const url = (params.get('u') ?? '').trim();
  const secret = (params.get('s') ?? '').trim();
  if (!/^https?:\/\//.test(url) || secret.length < 16) return undefined;
  return { url: url.replace(/\/+$/, ''), secret };
}
