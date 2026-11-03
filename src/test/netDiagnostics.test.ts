/**
 * 网络错误可读化 + 有限重试 + 代理隧道的回归测试。
 *
 * 现场：用户报「hwchat对话弹出：请求失败：无法连接到接口：fetch failed」。
 * `fetch failed` 是 undici 的外层错误，真实原因在 `cause` 里；不翻译就等于什么都没说。
 *
 * 这里的错误形状都是**实测**得来的（Node 22 / undici），不是照着文档猜的：
 *   · DNS 失败：TypeError('fetch failed') → cause Error{ code: 'ENOTFOUND', syscall: 'getaddrinfo' }
 *   · 连不上：  TypeError('fetch failed') → cause Error{ code: 'ECONNREFUSED' }
 *   · 超时：    DOMException{ name: 'TimeoutError', code: 23 }，**没有 cause**
 * 第三种最容易踩：如果按「没有 code 就当未知错误」处理，它会被判成可重试 → 一次
 * 120 秒的超时被重试三次就是 6 分钟，比直接报错糟糕得多。
 */
import assert from 'node:assert/strict';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { test } from 'node:test';
import {
  classifyNetworkError,
  fetchWithNetworkRetry,
  formatNetworkError,
  isRetryableNetworkError,
} from '../providers/netDiagnostics';
import { fetchViaProxy, parseProxyUrl } from '../providers/proxyFetch';

/** 造一个与实测形状一致的 undici 外层错误。 */
function undiciError(code: string): Error {
  const outer = new TypeError('fetch failed');
  (outer as { cause?: unknown }).cause = Object.assign(new Error(`connect ${code} 127.0.0.1:8080`), { code });
  return outer;
}

test('网络错误：DNS 失败被认成 dns 阶段并可重试', () => {
  const cause = classifyNetworkError(undiciError('ENOTFOUND'), 'https://api.deepseek.com/chat/completions');
  assert.equal(cause.stage, 'dns');
  assert.equal(cause.code, 'ENOTFOUND');
  assert.equal(cause.retryable, true);
  assert.equal(cause.host, 'api.deepseek.com');
  assert.match(cause.hint, /nslookup api\.deepseek\.com/);
});

test('网络错误：连不上被认成 connect 阶段，并提示「代理没开」这种最常见原因', () => {
  const cause = classifyNetworkError(undiciError('ECONNREFUSED'), 'https://api.deepseek.com/models');
  assert.equal(cause.stage, 'connect');
  assert.match(cause.hint, /代理/);
});

test('网络错误：{name:TimeoutError} 必须判为超时且**不可重试**', () => {
  // 实测形状：DOMException，code 是数字 23，没有 cause。
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError', code: 23 });
  const cause = classifyNetworkError(timeout, 'https://api.deepseek.com/models');
  assert.equal(cause.code, 'ETIMEDOUT');
  assert.equal(cause.retryable, false, '超时重试会把 120 秒的等待变成 6 分钟');
});

test('网络错误：主动取消不是网络故障', () => {
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const cause = classifyNetworkError(abort, 'https://api.deepseek.com/models');
  assert.equal(cause.code, 'ABORT_ERR');
  assert.equal(cause.retryable, false);
});

test('网络错误：证书错误归类为 tls，并指出代理中间人的可能', () => {
  const cause = classifyNetworkError(undiciError('SELF_SIGNED_CERT_IN_CHAIN'), 'https://api.deepseek.com');
  assert.equal(cause.stage, 'tls');
  assert.equal(cause.retryable, false);
  assert.match(cause.hint, /证书/);
});

test('网络错误：代理配置写错不该重试', () => {
  const socks = classifyNetworkError(Object.assign(new Error('暂不支持 socks'), { code: 'ERR_SOCKS_UNSUPPORTED' }), 'https://x.test');
  assert.equal(socks.retryable, false, '改配置才能解决，重试没有意义');
});

test('网络错误：提示里带上环境变量代理（因为 fetch 不认它）', () => {
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
  try {
    const cause = classifyNetworkError(undiciError('ECONNREFUSED'), 'https://api.deepseek.com');
    assert.match(cause.hint, /127\.0\.0\.1:8080/, '必须告诉用户「配了代理但扩展不会用它」');
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  }
});

test('网络错误：formatNetworkError 同时给出原因与建议', () => {
  const text = formatNetworkError(classifyNetworkError(undiciError('ENOTFOUND'), 'https://api.deepseek.com'));
  assert.match(text, /域名解析失败/);
  assert.match(text, /ENOTFOUND/);
  assert.ok(text.split('\n').length >= 2, '原因与建议要分两行，别挤成一句');
});

/* ── 重试 ─────────────────────────────────────────────────────── */

test('重试：DNS 抖一下、第二次成功 → 不抛错，且只尝试两次', async () => {
  let calls = 0;
  const events: number[] = [];
  const response = await fetchWithNetworkRetry('https://api.deepseek.com/models', {}, {
    baseDelayMs: 1,
    onRetry: (event) => events.push(event.attempt),
  }, async () => {
    calls += 1;
    if (calls === 1) throw undiciError('EAI_AGAIN');
    return { ok: true, status: 200 } as unknown as Response;
  });
  assert.equal(calls, 2);
  assert.deepEqual(events, [1]);
  assert.equal((response as { status: number }).status, 200);
});

test('重试：一直失败 → 尝试满 3 次后抛出可读错误', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithNetworkRetry('https://api.deepseek.com/models', {}, { baseDelayMs: 1 }, async () => {
      calls += 1;
      throw undiciError('ECONNRESET');
    }),
    /连接被中途重置|ECONNRESET/,
  );
  assert.equal(calls, 3);
});

test('重试：超时不重试（一次都不多）', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithNetworkRetry('https://api.deepseek.com/models', {}, { baseDelayMs: 1 }, async () => {
      calls += 1;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError', code: 23 });
    }),
  );
  assert.equal(calls, 1, '超时重试会把等待时间乘以倍数');
});

test('重试：拿到响应之后的失败不重试（避免重复计费）', async () => {
  let calls = 0;
  // 这里模拟的是「HTTP 500 由调用方处理」：fetch 本身没抛，就不该进重试循环。
  const response = await fetchWithNetworkRetry('https://api.deepseek.com/models', {}, { baseDelayMs: 1 }, async () => {
    calls += 1;
    return { ok: false, status: 500 } as unknown as Response;
  });
  assert.equal(calls, 1);
  assert.equal((response as { status: number }).status, 500);
});

test('重试：取消后立即停止，不继续等待', async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = fetchWithNetworkRetry('https://api.deepseek.com/models', {}, {
    baseDelayMs: 50,
    signal: controller.signal,
  }, async () => {
    calls += 1;
    throw undiciError('ECONNRESET');
  });
  controller.abort();
  await assert.rejects(promise);
  assert.equal(calls, 1, '取消之后不该再发起新的尝试');
});

test('isRetryableNetworkError 与 classify 结论一致', () => {
  assert.equal(isRetryableNetworkError(undiciError('ENOTFOUND')), true);
  assert.equal(isRetryableNetworkError(Object.assign(new Error('x'), { name: 'TimeoutError' })), false);
});

/* ── 代理 ─────────────────────────────────────────────────────── */

test('代理：解析 http 代理（含凭据）与拒绝 socks / 非法地址', () => {
  assert.deepEqual(parseProxyUrl('http://127.0.0.1:8080'), { host: '127.0.0.1', port: 8080, authorization: undefined });
  const withAuth = parseProxyUrl('http://user:p%40ss@proxy.local:8080');
  assert.equal(withAuth.host, 'proxy.local');
  assert.equal(withAuth.port, 8080);
  assert.equal(withAuth.authorization, `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  assert.throws(() => parseProxyUrl('socks5://127.0.0.1:8080'), /暂不支持 socks/);
  assert.throws(() => parseProxyUrl('not-a-url'), /不合法/);
});

/**
 * 起一个真的 CONNECT 代理：收到 `CONNECT host:port` 就建一条 TCP 隧道并双向 pipe。
 * 这样「隧道能不能用」是**跑出来的**，不是看代码形状猜的。
 */
async function startConnectProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  /** 记下所有还开着的 socket：`server.close()` 只停止接收新连接，不会掐已建立的。 */
  const sockets = new Set<import('node:net').Socket>();
  const server = createNetServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      client.removeListener('data', onData);
      const firstLine = buffer.slice(0, buffer.indexOf('\r\n'));
      const [, authority] = firstLine.split(' ');
      const [host, port] = (authority ?? '').split(':');
      const upstream = netConnect({ host, port: Number(port) }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = buffer.slice(end + 4);
        if (rest) upstream.write(Buffer.from(rest, 'latin1'));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      // 客户端断开时把上游也关掉：否则 `origin.close()` 会一直等这个连接，
      // 表现就是测试超时（实测过一次，排查成本很高）。
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}

/** 起一个只在隧道里可达的源站，并记录它收到的请求行。 */
async function startOrigin(response: string): Promise<{ port: number; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (chunk: Buffer) => {
      requests.push(chunk.toString('latin1').split('\r\n')[0] ?? '');
      socket.end(response);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}

test('代理：经真实 CONNECT 隧道拿到明文 HTTP 响应', async () => {
  const origin = await startOrigin('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}');
  const proxy = await startConnectProxy();
  try {
    const response = await fetchViaProxy(`http://127.0.0.1:${origin.port}/models`, { method: 'GET' }, proxy.url, 5000);
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.equal(await response.text(), '{"ok":true}');
    assert.deepEqual(origin.requests, ['GET /models HTTP/1.1'], '请求必须真的到达源站');
  } finally {
    await proxy.close();
    await origin.close();
  }
});

test('代理：请求确实经过隧道（绕过代理时源站收不到）', async () => {
  const origin = await startOrigin('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi');
  // 一个「黑洞代理」：只说 200，不转发任何字节。走代理就必然拿不到源站的响应。
  const blackhole = createNetServer((client) => {
    client.once('data', () => client.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
  const blackholePort = (blackhole.address() as { port: number }).port;
  try {
    // 只要请求真的穿过隧道，源站就永远收不到东西 → 这里应当超时/挂住而不是拿到 200。
    const raced = await Promise.race([
      fetchViaProxy(`http://127.0.0.1:${origin.port}/models`, { method: 'GET' }, `http://127.0.0.1:${blackholePort}`, 1200)
        .then(() => 'response').catch(() => 'error'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);
    assert.notEqual(raced, 'response', '黑洞代理却拿到了响应：说明请求根本没走隧道');
    assert.deepEqual(origin.requests, [], '源站不该收到任何请求');
  } finally {
    await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    await origin.close();
  }
});

test('代理：代理端口没人监听时给出能看懂的报错', async () => {
  // 取一个确定没人监听的端口：先起再关，拿到系统分配的端口号。
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  await assert.rejects(
    fetchViaProxy('https://api.deepseek.com/models', {}, `http://127.0.0.1:${port}`, 3000),
    /连不上代理 127\.0\.0\.1:\d+（ECONNREFUSED）|代理软件在运行吗/,
  );
});

test('代理：目标拒绝隧道时如实报错，不假装成功', async () => {
  const rejecting = createNetServer((socket) => {
    socket.once('data', () => {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => rejecting.listen(0, '127.0.0.1', resolve));
  const address = rejecting.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await assert.rejects(
      fetchViaProxy('https://api.deepseek.com/models', {}, `http://127.0.0.1:${port}`, 3000),
      /代理拒绝建立隧道：HTTP\/1\.1 403/,
    );
  } finally {
    await new Promise<void>((resolve) => rejecting.close(() => resolve()));
  }
});
