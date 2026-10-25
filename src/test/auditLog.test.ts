import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuditLog, redact } from '../agent/auditLog';

async function withAudit(run: (audit: AuditLog, filePath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-audit-'));
  const filePath = join(root, 'audit.jsonl');
  try {
    await run(new AuditLog(filePath), filePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('zero-day audit retention keeps only records from the current session', async () => {
  await withAudit(async (audit, filePath) => {
    const old = JSON.stringify({ timestamp: Date.now() - 60_000, tool: 'read_file' });
    await writeFile(filePath, `${old}\n`, 'utf8');
    await audit.record({
      timestamp: Date.now(),
      tool: 'run_command',
      status: 'success',
      approval: 'approved',
      summary: 'npm test',
    });

    await audit.cleanup(0);
    const source = await readFile(filePath, 'utf8');
    assert.doesNotMatch(source, /read_file/);
    assert.match(source, /run_command/);
  });
});

test('audit cleanup caps the file while retaining newest records', async () => {
  await withAudit(async (audit, filePath) => {
    const now = Date.now();
    const lines = Array.from({ length: 6_000 }, (_, index) => JSON.stringify({
      timestamp: now,
      tool: 'read_file',
      status: 'success',
      approval: 'not-required',
      summary: `${String(index).padStart(4, '0')}:${'x'.repeat(900)}`,
    }));
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');

    await audit.cleanup(30);
    const source = await readFile(filePath, 'utf8');
    assert.ok((await stat(filePath)).size <= 5 * 1024 * 1024);
    assert.doesNotMatch(source, /0000:/);
    assert.match(source, /5999:/);
  });
});

test('redacts common credential formats before audit storage', () => {
  const value = redact('Authorization: Bearer abc.def sk-secretvalue API_KEY=plainsecret "password":"hidden"');
  assert.doesNotMatch(value, /abc\.def|sk-secretvalue|plainsecret|hidden/);
  assert.match(value, /REDACTED/);
});
