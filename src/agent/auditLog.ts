import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
/**
 * 同一保留天数下，两次「真正压缩」之间的最短间隔。
 *
 * 每次压缩都要把整份审计日志读进内存、逐行 `JSON.parse`：本机 5MB 日志实测 36ms
 * CPU。而这个函数在「保存设置」「清理完成回调」等路径上被频繁调用，几乎每次都是
 * 白白重算（文件没变、也没超上限）。加上这个窗口后：
 *  - 文件仍然超过 5MB 时窗口失效（`stat` 一次即可判断），上限语义不变；
 *  - 显式操作可以 `force` 立即压缩。
 */
export const AUDIT_CLEANUP_FRESH_MS = 60_000;

export interface AuditRecord {
  timestamp: number;
  conversationId?: string;
  callId?: string;
  tool: string;
  status: string;
  approval: string;
  summary: string;
  path?: string;
  changedFiles?: string[];
}

export class AuditLog {
  private tail: Promise<void> = Promise.resolve();
  private readonly sessionStartedAt = Date.now();
  private lastCleanupAt = 0;
  private lastRetentionDays: number | null = null;

  constructor(private readonly filePath: string) {}

  record(record: AuditRecord): Promise<void> {
    const safe = {
      ...record,
      summary: redact(record.summary).slice(0, 1_000),
      path: record.path ? redact(record.path).slice(0, 500) : undefined,
      changedFiles: record.changedFiles?.map((value) => redact(value).slice(0, 500)),
    };
    const line = `${JSON.stringify(safe)}\n`;
    return this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, 'utf8');
    });
  }

  cleanup(retentionDays: number, options: { force?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      // 便宜的门槛判断（一次 stat，约 0.05ms）挡掉绝大多数重复压缩。
      if (!options.force && this.lastRetentionDays === retentionDays && Date.now() - this.lastCleanupAt < AUDIT_CLEANUP_FRESH_MS) {
        const size = await stat(this.filePath).then((value) => value.size).catch(() => 0);
        if (size <= MAX_AUDIT_BYTES) {
          return;
        }
      }
      this.lastCleanupAt = Date.now();
      this.lastRetentionDays = retentionDays;
      const source = await readFile(this.filePath, 'utf8').catch(() => '');
      if (!source) {
        return;
      }
      const cutoff = retentionDays <= 0
        ? this.sessionStartedAt
        : Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
      const sourceLines = source
        .split('\n')
        .filter(Boolean);
      const retained = sourceLines.filter((line) => {
        try {
          return Number((JSON.parse(line) as { timestamp?: number }).timestamp ?? 0) >= cutoff;
        } catch {
          return false;
        }
      });
      const kept: string[] = [];
      let keptBytes = 0;
      for (let index = retained.length - 1; index >= 0; index -= 1) {
        const line = retained[index]!;
        const lineBytes = Buffer.byteLength(line) + 1;
        if (lineBytes > MAX_AUDIT_BYTES) continue;
        if (keptBytes + lineBytes > MAX_AUDIT_BYTES) break;
        kept.unshift(line);
        keptBytes += lineBytes;
      }
      const currentSize = await stat(this.filePath).then((value) => value.size).catch(() => 0);
      if (kept.length === sourceLines.length && currentSize <= MAX_AUDIT_BYTES) {
        return;
      }
      const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const payload = kept.length ? `${kept.join('\n')}\n` : '';
      await writeFile(temp, payload, 'utf8');
      await rename(temp, this.filePath).catch(async () => {
        await writeFile(this.filePath, payload, 'utf8');
        await unlink(temp).catch(() => undefined);
      });
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await unlink(this.filePath).catch(() => undefined);
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED_KEY]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\s&]+)/g, (match, key: string) => (
      /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)/i.test(key)
        ? `${key}=[REDACTED]`
        : match
    ))
    .replace(/([?&](?:token|secret|password|api[_-]?key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:token|secret|password|api[_-]?key)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
}
