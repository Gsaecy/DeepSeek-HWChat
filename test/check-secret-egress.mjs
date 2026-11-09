/*
 * 敏感数据出站治理（2026-11-08 外部评审 ⑥/⑮）。
 *
 * 评审的核心判断：原来的防法是「按工具设防」，不是「按数据设防」。
 * 同一段密钥会经三条通道离开本机：
 *
 *   1. 聊天模型（read_file / 命令输出 / 对话正文）
 *   2. 向量服务（embeddingInput(message.content)）
 *   3. 审计与日志
 *
 * 现在宿主侧只有一份判据（src/core/secretScan.ts），四条通道共用；
 * media/secret-scan.js 保留给界面（webview 不能 import TS），
 * 本脚本用同一组语料比对两者，防止悄悄漂移。
 *
 * 用法：node test/check-secret-egress.mjs
 */
import { readFileSync } from 'node:fs';

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

const read = (path) => readFileSync(path, 'utf8');
const EXEC = read('src/agent/toolExecutor.ts');
const PANEL = read('src/views/chatPanel.ts');
const AUDIT = read('src/agent/auditLog.ts');
const CORE = read('src/core/secretScan.ts');

/* ── 1. 四条通道都接上了同一份判据 ─────────────────────────────── */
check('宿主侧有唯一判据 core/secretScan.ts', /export function scanSecrets/.test(CORE));
check(
  '通道一 read_file：命中凭据先确认再发给模型',
  /scanSecrets\(text\)/.test(EXEC) && /tool\.readSecretSummary/.test(EXEC) && /tool\.readSecretDetail/.test(EXEC),
);
check(
  '通道二 向量索引：命中凭据的消息不进索引',
  /hasSecrets\(message\.content\)/.test(PANEL) && /跳过 .*疑似含凭据/.test(PANEL),
);
check(
  '通道三 审计：按已知密钥值脱敏 + PEM 整块 + 厂商前缀',
  /registerKnownSecret/.test(AUDIT) && /REDACTED_PRIVATE_KEY/.test(AUDIT) && /gh\[pousr\]/.test(AUDIT),
);
check(
  '通道三补：真实密钥在客户端解析处登记',
  /registerKnownSecret\(apiKey\)/.test(read('src/providers/deepseekClient.ts')),
);
/*
 * 「桥接工具输出也参与污点」那两条断言随污点机制一起删掉了。
 *
 * 原因（用户 2026-11-09 决定）：污点会把预设里的 allow 悄悄改成 ask，导致选了
 * Autopilot 仍然被逐条确认 —— 用户判定这就是「权限预设失效」。现在权限只由预设决定，
 * 这条链路不再存在，所以不再断言它。
 * 出站治理本身没有放松：下面三条通道（模型 / 向量 / 审计）的断言一条没动。
 */
check(
  '出站治理不依赖权限降级（预设是唯一权威）',
  !/untrustedIngested/.test(PANEL) && !/untrustedIngested/.test(read('src/agent/agentRunner.ts')),
);

/* ── 2. 判据真跑：正例 / 反例 ─────────────────────────────────── */
const { build } = await import('esbuild');
const bundle = await build({
  stdin: {
    contents: `export { scanSecrets, hasSecrets, maskSecrets } from './src/core/secretScan';
export { redact, registerKnownSecret } from './src/agent/auditLog';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
  external: ['node:*'],
});
const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir = mkdtempSync(join(tmpdir(), 'hwchat-secret-'));
writeFileSync(join(dir, 'bundle.mjs'), bundle.outputFiles[0].text);
const api = await import(`file://${join(dir, 'bundle.mjs')}`);
rmSync(dir, { recursive: true, force: true });

const POSITIVE = [
  'key = sk-proj-AbCd1234EfGh5678IjKl',
  'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'aws AKIAIOSFODNN7EXAMPLE',
  'pw DB_PASSWORD=hunter2hunter2',
  'jwt eyJhbGciOi.eyJzdWIiOi.sigpart123456',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
];
const NEGATIVE = [
  'password: process.env.DB_PASSWORD',
  'api_key = "your_api_key_here"',
  'token: sk-xxxxxxxxxxxx',
  'password: <YOUR_PASSWORD>',
  'secret = config.db.secret',
  'see docs at https://example.com/guide',
  'commit 3f2a1c9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a',
];

check(
  '真机：正例全部命中',
  POSITIVE.every((sample) => api.hasSecrets(sample)),
  POSITIVE.filter((sample) => !api.hasSecrets(sample)).join(' | '),
);
check(
  '真机：反例全部不命中（占位符 / 引用 / commit hash）',
  NEGATIVE.every((sample) => !api.hasSecrets(sample)),
  NEGATIVE.filter((sample) => api.hasSecrets(sample)).join(' | '),
);
const masked = api.maskSecrets('const key = "sk-proj-AbCd1234EfGh5678IjKl"; // keep me');
check('真机：遮罩不回显原值、保留其余文本', !masked.includes('AbCd1234') && /keep me/.test(masked), masked);

const secret = 'sk-live-ZZZZ1111YYYY2222XXXX';
api.registerKnownSecret(secret);
const encoded = [secret, Buffer.from(secret, 'utf8').toString('base64'), encodeURIComponent(secret)];
check(
  '真机：已知密钥的原文 / base64 / URL 编码形态都被脱敏',
  encoded.every((form) => !api.redact(`x ${form} y`).includes(secret.slice(0, 12))),
);

/* ── 3. 与界面层判据不漂移 ────────────────────────────────────── */
const webviewSource = read('media/secret-scan.js');
const sandbox = {};
new Function('globalThis', webviewSource).call(sandbox, sandbox);
const webview = sandbox.HWChatSecretScan;
check('界面层判据可加载', Boolean(webview?.scanSecrets));
if (webview?.scanSecrets) {
  const corpus = [...POSITIVE, ...NEGATIVE];
  const mismatch = corpus.filter((sample) => {
    const coreKinds = [...new Set(api.scanSecrets(sample).map((item) => item.kind))].sort().join(',');
    const uiKinds = [...new Set(webview.scanSecrets(sample).map((item) => item.kind))].sort().join(',');
    return coreKinds !== uiKinds;
  });
  check(
    '宿主与界面判据在同一组语料上给出相同结论（防漂移）',
    mismatch.length === 0,
    mismatch.map((sample) => `${JSON.stringify(sample.slice(0, 40))} → core≠webview`).join('\n    '),
  );
}

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('敏感数据出站治理有缺口：四条通道里有一条没接上，或两处判据已经漂移。');
  process.exitCode = 1;
} else {
  console.log('一份判据管住四条通道：read_file / 向量索引 / 审计 / 界面提示，且宿主与界面结论一致。');
}
