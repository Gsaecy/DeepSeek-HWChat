/*
 * 「预览打不开 / 服务没真正启动」的守护。
 *
 * 现场（用户 2026-11-04）：
 *
 *     如果他生成命令说用 python3 启动，它不会真正的启动，会导致无法预览
 *
 * 审计日志证明了两个真问题：
 *   1. `open_web_preview` 在 8765 / 8766 / 5180 / 8795 / 8790 上被打开过，而那些端口
 *      **没有任何启动记录** —— 预览的其实是一个空端口；
 *   2. `run_command` 的前台路径到点 SIGKILL 整个进程组，所以前台跑的
 *      `python3 -m http.server` 超时后连服务一起消失。
 *
 * 所以这里既要静态钉住「探针在打开之前」「服务命令自动转后台」，
 * 也要**真的起一个 python3 http.server** 验证探针在真实环境下说的是真话。
 *
 * 用法：node test/check-preview-guard.mjs
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { buildSync } from 'esbuild';

/*
 * 探针要拿**真实源码**验证，不是在这份脚本里再抄一遍实现。
 * 项目只产出 `out/extension.js` 一个 bundle，所以这里单独打包这一个模块。
 */
mkdirSync('out/check', { recursive: true });
buildSync({
  entryPoints: ['src/agent/previewProbe.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/check/previewProbe.cjs',
  logLevel: 'silent',
});
const require = createRequire(import.meta.url);
const { isLocalPreviewHost, previewEndpoint, probePreviewEndpoint } = require(resolve('out/check/previewProbe.cjs'));

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
const TOOLS = read('src/agent/vscodeTools.ts');
const EXECUTOR = read('src/agent/toolExecutor.ts');
const PLAYBOOKS = read('src/agent/toolPlaybooks.ts');
const PANEL = read('src/views/chatPanel.ts');
const I18N = read('src/core/i18n.ts');
const PROBE = read('src/agent/previewProbe.ts');

/* ── 1. 探针必须挡在 simpleBrowser.show 之前 ───────────────────────── */
const previewCase = TOOLS.slice(TOOLS.indexOf("case 'open_web_preview'"), TOOLS.indexOf("case 'open_text_preview'"));
check(
  '打开的代码里先探测再打开（探针在 simpleBrowser.show 之前）',
  previewCase.indexOf('probePreviewEndpoint') > 0
    && previewCase.indexOf('probePreviewEndpoint') < previewCase.indexOf('simpleBrowser.show'),
  '顺序反了等于没用：先打开再去探测，用户已经看到报错页了',
);
check(
  '探不通时返回 error 并附带下一步，而不是静默打开',
  /if \(!probe\.reachable\)[\s\S]{0,200}return failed\(/.test(previewCase),
);
check(
  '只探本机/内网地址（公网打不开通常是网络问题）',
  /isLocalPreviewHost\(endpoint\.host\)/.test(previewCase),
);
check(
  '探的是 TCP 连接（不依赖静态服务器回什么状态码）',
  /net\.connect|socket\.connect/.test(PROBE) && /ECONNREFUSED/.test(PROBE),
);

/* ── 2. 常驻服务命令必须由宿主转后台 ─────────────────────────────── */
check(
  'runCommand 用 shouldAutoBackground 兜住「模型忘了写 background」',
  /if \(args\.background === true \|\| autoBackground\)/.test(EXECUTOR)
    && /const autoBackground = args\.background === true \? undefined : shouldAutoBackground\(command\)/.test(EXECUTOR),
);
check(
  '自动转后台时明确告诉模型「为什么」（前台会被整组杀掉）',
  /tool\.runCommand\.autoBackground'/.test(EXECUTOR),
);
check(
  '自己已后台化的命令不再包一层（避免误报「没能常驻」）',
  /backgroundsItself/.test(read('src/agent/serverCommands.ts')),
);

/* ── 3. 提示词只能作补充，且要写清「贴命令 ≠ 启动」 ───────────────── */
check(
  '预览任务指令里写明「写进回复等于没启动」',
  /写进回复让用户自己敲，等于没有启动/.test(PLAYBOOKS),
);
check(
  '预览任务指令里写明探针语义（回「没有服务」就回去启动）',
  /没有服务在监听/.test(PLAYBOOKS),
);
check(
  '通用系统提示词同样写了这一条',
  /Printing a start command in the reply is not starting anything/.test(PANEL),
);

/* ── 4. 文案中英都齐 ─────────────────────────────────────────────── */
for (const key of [
  'tool.preview.notOpened',
  'tool.preview.refused',
  'tool.preview.failed',
  'tool.preview.nextStep',
  'tool.runCommand.autoBackground',
  'tool.runCommand.autoBackgroundStarted',
]) {
  const line = I18N.split('\n').find((row) => row.includes(`'${key}'`)) ?? '';
  check(`文案 ${key} 中英都有`, /\bzh:/.test(line) && /\ben:/.test(line), line.slice(0, 120));
}

/* ── 5. 真实环境：起一个 python3 http.server，探针必须说真话 ───────── */
check('地址解析：8790 端口取对', JSON.stringify(previewEndpoint('http://127.0.0.1:8790/')) === '{"host":"127.0.0.1","port":8790}');
check('127.0.0.1 属于本机（要探测）', isLocalPreviewHost('127.0.0.1') === true);
check('example.com 不属于本机（不探测）', isLocalPreviewHost('example.com') === false);

const port = 8790 + Math.floor(Math.random() * 200);
const site = '.';
const server = spawn('python3', ['-m', 'http.server', String(port), '--directory', site], {
  stdio: 'ignore',
  detached: true,
});

async function waitForReachable(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probePreviewEndpoint(`http://127.0.0.1:${port}/`, 400);
    if (probe.reachable) return probe;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return { reachable: false, code: 'TIMEOUT' };
}

try {
  const up = await waitForReachable(8_000);
  check(`python3 -m http.server ${port} 起来后探针为可达`, up.reachable === true, JSON.stringify(up));
  const again = await probePreviewEndpoint(`http://127.0.0.1:${port}/`);
  check('真实 python 静态服务上重复探测仍然可达', again.reachable === true);
} finally {
  if (server.pid) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      try {
        process.kill(server.pid, 'SIGKILL');
      } catch {
        /* 已经退出 */
      }
    }
  }
}

// 进程刚被 SIGKILL 时端口关掉需要几毫秒，轮询到「真的没人监听」再断言。
let down = await probePreviewEndpoint(`http://127.0.0.1:${port}/`, 800);
for (let attempt = 0; attempt < 25 && down.reachable; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  down = await probePreviewEndpoint(`http://127.0.0.1:${port}/`, 800);
}
check(`服务停掉后探针报「没有服务」（${down.code ?? 'reachable'}）`, down.reachable === false && down.code === 'ECONNREFUSED');

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「预览打不开」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('预览前会探端口、服务命令会自动转后台：不会再出现「命令跑过了但端口空着」。');
}
