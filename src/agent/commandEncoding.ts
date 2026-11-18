/**
 * 命令输出的**编码识别**。
 *
 * 为什么需要它：Windows 上 `cmd.exe` 与 `findstr` / `dir` / `chcp` 这一类内置工具
 * 按控制台代码页（中文系统是 936 = GBK）输出，而 Node 的 `String(buffer)` 一律按
 * UTF-8 解。于是「系统找不到指定的路径」变成 `ϵͳ�Ҳ���ָ����·����`：
 *
 * - 模型读不懂这条报错，只会换个写法再撞一次 —— 现场就是连续三条命令全失败，
 *   最后被判「连续 3 轮工具调用全部失败」直接停机；
 * - 用户看到的执行记录也是一串乱码，没法判断到底错在哪。
 *
 * 做法：每个输出流各自一个解码器。默认按 UTF-8（带 `stream: true`，跨 chunk 的
 * 半个多字节字符会被接上，不会误报）；一旦解出替换字符（U+FFFD），说明这段字节
 * 根本不是 UTF-8，就切到系统本地编码（Windows 优先 GBK）继续解这一段与后续内容。
 *
 * 纯计算、不 import vscode，便于把判定写成单元测试。
 */

/** UTF-8 解不出来时依次尝试的本地编码。GBK 覆盖简体中文 Windows 的绝大多数输出。 */
const LEGACY_LABELS = ['gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'] as const;

function createLegacyDecoder(): TextDecoder | undefined {
  for (const label of LEGACY_LABELS) {
    try {
      return new TextDecoder(label);
    } catch {
      // 这个运行时的 ICU 不带该编码，试下一个。
    }
  }
  return undefined;
}

export class CommandOutputDecoder {
  private readonly utf8 = new TextDecoder('utf-8', { fatal: false });
  private legacy: TextDecoder | undefined;
  private legacyTried = false;

  /** 解一段字节。`stream: true` 保证跨 chunk 的半个字符不会变成替换字符。 */
  decode(chunk: Buffer | Uint8Array | string): string {
    if (typeof chunk === 'string') return chunk;
    if (this.legacy) return this.legacy.decode(chunk, { stream: true });
    const text = this.utf8.decode(chunk, { stream: true });
    if (!text.includes('\uFFFD')) return text;
    if (!this.legacyTried) {
      this.legacyTried = true;
      this.legacy = createLegacyDecoder();
    }
    /*
     * 本地编码也解不了（极少见）：保持 UTF-8，输出里会留替换字符，但至少不会把
     * 已经解对的内容再弄坏。
     */
    return this.legacy ? this.legacy.decode(chunk, { stream: true }) : text;
  }

  /** 收尾：把跨 chunk 暂存的那半个字符吐出来。 */
  flush(): string {
    if (this.legacy) {
      try {
        return this.legacy.decode();
      } catch {
        return '';
      }
    }
    try {
      return this.utf8.decode();
    } catch {
      return '';
    }
  }
}
