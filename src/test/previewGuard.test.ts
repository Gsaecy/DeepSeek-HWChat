/**
 * 「预览打不开」与「服务其实没起来」的两道宿主闸门。
 *
 * 现场（用户 2026-11-04）：「如果他生成命令说用 python3 启动，它不会真正的启动，
 * 会导致无法预览」。查审计日志确认了两件事：
 *
 *  1. `open_web_preview` 曾在 8765 / 8766 / 5180 / 8795 / 8790 这些**没有任何启动记录**的
 *     端口上被调用过 —— 打开的就是一个空端口。
 *  2. `run_command` 的前台路径到点会 SIGKILL 整个进程组，所以前台跑的
 *     `python3 -m http.server` 到超时后连服务一起消失。
 *
 * 这里用真实 TCP 连接验证探针，用真实命令文本验证「常驻服务」判据。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import {
  isLocalPreviewHost,
  previewEndpoint,
  previewUnreachableAdvice,
  probePreviewEndpoint,
} from '../agent/previewProbe';
import { backgroundsItself, isLongRunningServerCommand, shouldAutoBackground } from '../agent/serverCommands';

const t = (key: string, values?: Record<string, string | number>): string =>
  `${key}${values ? `(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : ''}`;

async function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port };
}

test('真的在监听 → 探针为可达（不依赖它回什么状态码）', async () => {
  const { server, port } = await startServer();
  try {
    const probe = await probePreviewEndpoint(`http://127.0.0.1:${port}/index.html`);
    assert.equal(probe.reachable, true);
    assert.equal(probe.port, port);
  } finally {
    server.close();
  }
});

test('端口关掉之后 → 探针报 ECONNREFUSED（这就是「预览打不开」的真身）', async () => {
  const { server, port } = await startServer();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  const probe = await probePreviewEndpoint(`http://127.0.0.1:${port}/`, 800);
  assert.equal(probe.reachable, false);
  assert.equal(probe.code, 'ECONNREFUSED');
  assert.equal(probe.port, port);
});

test('地址解析：默认端口按协议补，非 HTTP(S) 不探', () => {
  assert.deepEqual(previewEndpoint('http://127.0.0.1:8790/'), { host: '127.0.0.1', port: 8790 });
  assert.deepEqual(previewEndpoint('http://localhost/'), { host: 'localhost', port: 80 });
  assert.deepEqual(previewEndpoint('https://example.com/x'), { host: 'example.com', port: 443 });
  assert.deepEqual(previewEndpoint('http://[::1]:5173/'), { host: '::1', port: 5173 });
  assert.equal(previewEndpoint('file:///tmp/x.html'), undefined);
  assert.equal(previewEndpoint('not a url'), undefined);
});

test('只有本机/内网地址才探测：公网打不开通常是网络问题', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '192.168.1.9', '10.0.0.2', '172.16.3.4']) {
    assert.equal(isLocalPreviewHost(host), true, host);
  }
  for (const host of ['example.com', '172.32.0.1', '8.8.8.8']) {
    assert.equal(isLocalPreviewHost(host), false, host);
  }
});

test('「常驻服务」判据：认得出用户实际用过的那些命令', () => {
  const servers = [
    'python3 -m http.server 8790 --directory website/instindex/web',
    'python -m http.server 8765',
    'cd website/instindex/web && python3 -m http.server 8795 >/dev/null 2>&1',
    'npx http-server -p 8080',
    'pnpm dev',
    'npm run dev -- --port 5199',
    'vite --port 5173',
    'uvicorn app:app --port 8000',
    'php -S localhost:8000',
  ];
  for (const command of servers) {
    assert.ok(isLongRunningServerCommand(command), `应判为常驻服务：${command}`);
  }
  const finite = [
    'npm test',
    'python3 verify.py',
    'git status',
    'curl -s http://127.0.0.1:8790/ | head -5',
    'npx vitest run',
    'ls -la',
  ];
  for (const command of finite) {
    assert.equal(isLongRunningServerCommand(command), undefined, `不该判为常驻服务：${command}`);
  }
});

test('自己已经后台化的命令不再包一层（否则会误报「没能常驻」）', () => {
  assert.equal(backgroundsItself('nohup python3 -m http.server 8790 &'), true);
  assert.equal(backgroundsItself('python3 -m http.server 8790 > /dev/null 2>&1 &'), true);
  assert.equal(backgroundsItself('setsid python3 -m http.server 8790'), true);
  assert.equal(backgroundsItself('python3 -m http.server 8790'), false);
  assert.equal(backgroundsItself('npm run dev && echo ok'), false, '`&&` 不是后台');
  assert.equal(backgroundsItself('npm run dev 2>&1'), false, '重定向不是后台');

  assert.ok(shouldAutoBackground('python3 -m http.server 8790'));
  assert.equal(shouldAutoBackground('nohup python3 -m http.server 8790 &'), undefined);
  assert.equal(shouldAutoBackground('npm test'), undefined);
});

test('打不开时给的下一步必须能照着做：端口、background:true、别把命令写进回复', () => {
  const advice = previewUnreachableAdvice(
    { reachable: false, code: 'ECONNREFUSED', host: '127.0.0.1', port: 8790 },
    { t, url: 'http://127.0.0.1:8790/' },
  );
  assert.match(advice, /tool\.preview\.notOpened\(url=http:\/\/127\.0\.0\.1:8790\/\)/);
  assert.match(advice, /tool\.preview\.refused\(host=127\.0\.0\.1,port=8790\)/);
  assert.match(advice, /tool\.preview\.nextStep\(port=8790\)/);
});
