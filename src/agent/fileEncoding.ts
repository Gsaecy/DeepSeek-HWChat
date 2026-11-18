/**
 * 文本文件的**编码识别与写回**。
 *
 * 为什么需要它（真实故障，2026-11-18）：`replace_in_file` / `write_file` 一直用
 * UTF-8 读、再用 UTF-8 写。碰到 GBK 保存的中文文件（Windows 上很常见）时：
 *
 *  - 读出来是一串替换字符 U+FFFD，模型看到的正文是乱码；
 *  - 更糟的是**写回**：那串 U+FFFD 被重新编码成 EF BF BD，文件里的中文就永久毁了。
 *
 * 所以这里做三件事：
 *  1. 读：BOM 优先（UTF-8 / UTF-16 LE / UTF-16 BE），否则按严格 UTF-8 试一次，
 *     失败就按 GBK（简体中文 Windows 的默认代码页）解，至少让模型看到正确正文；
 *  2. 写：**保持原编码**。UTF-8 / UTF-8 BOM / UTF-16 都能原样写回；
 *  3. 写不了的编码（GBK —— Node 没有内置的 GBK 编码器）一律**拒绝写**，
 *     并给出可执行的说明。宁可让用户自己转一次编码，也不能悄悄毁掉中文正文。
 *
 * 纯计算、不 import vscode，便于把判定写成单元测试。
 */

export type TextFileEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'gbk';

export interface DecodedTextFile {
  /** 不含 BOM 的正文。 */
  text: string;
  encoding: TextFileEncoding;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function decodeWith(label: string, bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** 读一个文本文件：返回正文与它的编码（BOM 已剥掉，写回时再按 encoding 补上）。 */
export function decodeTextFile(bytes: Uint8Array): DecodedTextFile {
  if (startsWith(bytes, UTF8_BOM)) {
    const body = decodeWith('utf-8', bytes.subarray(3));
    return { text: body ?? '', encoding: 'utf8-bom' };
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    const body = decodeWith('utf-16le', bytes.subarray(2));
    if (body !== undefined) return { text: body, encoding: 'utf16le' };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    const body = decodeWith('utf-16be', bytes.subarray(2));
    if (body !== undefined) return { text: body, encoding: 'utf16be' };
  }
  /*
   * 没有 BOM：严格按 UTF-8 试一次。
   *
   * 用 `fatal: true` 是这里的关键 —— 非致命的 UTF-8 解码会把坏字节变成 U+FFFD，
   * 那正是「读出来是乱码、写回去把中文毁掉」的起点；这里必须让坏字节抛错，
   * 才能识别出「这其实不是 UTF-8」。
   */
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' };
  } catch {
    // 不是合法的 UTF-8：按 GBK 解（中文 Windows 的默认代码页）。
    const gbk = decodeWith('gbk', bytes);
    if (gbk !== undefined) return { text: gbk, encoding: 'gbk' };
    return { text: decodeWith('utf-8', bytes) ?? '', encoding: 'gbk' };
  }
}

/** 这个编码能不能原样写回（GBK 缺编码器，只能拒绝写）。 */
export function canEncodeTextFile(encoding: TextFileEncoding): boolean {
  return encoding !== 'gbk';
}

/** 按指定编码生成字节；不能编码时返回 undefined（调用方应拒绝写）。 */
export function encodeTextFile(text: string, encoding: TextFileEncoding): Uint8Array | undefined {
  switch (encoding) {
    case 'utf8':
      return new TextEncoder().encode(text);
    case 'utf8-bom': {
      const body = new TextEncoder().encode(text);
      const out = new Uint8Array(body.byteLength + 3);
      out.set(UTF8_BOM, 0);
      out.set(body, 3);
      return out;
    }
    case 'utf16le':
    case 'utf16be': {
      const out = new Uint8Array(text.length * 2 + 2);
      out[0] = encoding === 'utf16le' ? 0xff : 0xfe;
      out[1] = encoding === 'utf16le' ? 0xfe : 0xff;
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        const low = code & 0xff;
        const high = (code >> 8) & 0xff;
        out[2 + index * 2] = encoding === 'utf16le' ? low : high;
        out[3 + index * 2] = encoding === 'utf16le' ? high : low;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** 给用户看的编码名。 */
export function encodingLabel(encoding: TextFileEncoding): string {
  switch (encoding) {
    case 'utf8':
      return 'UTF-8';
    case 'utf8-bom':
      return 'UTF-8 (BOM)';
    case 'utf16le':
      return 'UTF-16 LE';
    case 'utf16be':
      return 'UTF-16 BE';
    default:
      return 'GBK';
  }
}

/**
 * 网页正文的解码。
 *
 * 真实情况：不少中文站点仍以 GBK / GB2312 输出，按 UTF-8 解出来的资料是一串乱码，
 * 模型拿着它去回答用户，等于没有参考资料。`content-type` 里的 charset 与 HTML 里的
 * `<meta charset>` 都要认，`gb2312` / `gb18030` 统一按 GBK 解（GBK 是它们的超集）。
 */
export function decodeWebText(bytes: Uint8Array, contentType = '', headSample = ''): string {
  const declared = declaredCharset(contentType)
    ?? declaredCharset(headSample)
    ?? sniffMetaCharset(bytes);
  const label = normalizeCharset(declared);
  if (label) {
    const text = decodeWith(label, bytes);
    if (text !== undefined && !text.includes('\uFFFD')) return text;
  }
  const utf8 = decodeWith('utf-8', bytes) ?? '';
  if (!utf8.includes('\uFFFD')) return utf8;
  // 声明缺失或与内容不符：按 GBK 再试一次（中文站点最常见）。
  const gbk = decodeWith('gbk', bytes);
  return gbk !== undefined && !gbk.includes('\uFFFD') ? gbk : utf8;
}

function declaredCharset(value: string): string | undefined {
  const match = /charset\s*=\s*["']?([\w-]+)/i.exec(value ?? '');
  return match?.[1]?.toLowerCase();
}

/** 前若干字节里找 `<meta charset=...>`；HTML 规范要求它出现在前 1024 字节内。 */
function sniffMetaCharset(bytes: Uint8Array): string | undefined {
  const sample = decodeWith('latin1', bytes.subarray(0, 2048)) ?? '';
  return declaredCharset(sample);
}

/** `gb2312` / `gb18030` 都是 GBK 的子集或超集，统一用 GBK 解，避免标签不被支持。 */
function normalizeCharset(declared: string | undefined): string | undefined {
  if (!declared) return undefined;
  const value = declared.trim().toLowerCase();
  if (value === 'gb2312' || value === 'gbk' || value === 'gb18030' || value === 'x-gbk') return 'gbk';
  if (value === 'utf8') return 'utf-8';
  return value;
}
