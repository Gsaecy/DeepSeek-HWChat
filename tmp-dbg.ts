import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { fetchViaProxy } from './src/providers/proxyFetch';

async function main(): Promise<void> {
  const origin = createNetServer((socket) => {
    socket.once('data', (chunk) => {
      console.log('  [origin] 收到请求', JSON.stringify(chunk.toString().split('\r\n')[0]));
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}');
    });
    socket.on('error', (e) => console.log('  [origin] error', e.message));
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  const originPort = (origin.address() as { port: number }).port;
  console.log('origin port', originPort);

  const proxy = createNetServer((client) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      client.removeListener('data', onData);
      const firstLine = buffer.slice(0, buffer.indexOf('\r\n'));
      console.log('  [proxy] CONNECT 行:', JSON.stringify(firstLine));
      const authority = firstLine.split(' ')[1] ?? '';
      const [host, port] = authority.split(':');
      const upstream = netConnect({ host, port: Number(port) }, () => {
        console.log('  [proxy] 上游已连上，回 200');
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = buffer.slice(end + 4);
        if (rest) upstream.write(Buffer.from(rest, 'latin1'));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', (e) => { console.log('  [proxy] 上游错误', e.message); client.destroy(); });
    };
    client.on('data', onData);
    client.on('error', (e) => console.log('  [proxy] client error', e.message));
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyPort = (proxy.address() as { port: number }).port;
  console.log('proxy port', proxyPort);

  const timer = setTimeout(() => { console.log('!!! 超时，说明卡在某一步'); process.exit(2); }, 6000);
  try {
    const res = await fetchViaProxy(`http://127.0.0.1:${originPort}/models`, { method: 'GET' }, `http://127.0.0.1:${proxyPort}`, 5000);
    console.log('响应:', res.status, JSON.stringify(await res.text()));
  } catch (error) {
    console.log('失败:', (error as Error).message);
  }
  clearTimeout(timer);
  origin.close(); proxy.close();
}
void main();
