import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LanSyncService } from '../sync/lanSync';
import type { SyncPeer } from '../sync/lanProtocol';

/**
 * 手机遥控的端到端：真起监听、真发 HTTP、真拿 Cookie。
 *
 * 这里不打桩，因为最容易错的就是「协议自己写的、页面自己写的，两边对不上」：
 * 路径写成 `/m/send` 还是 `/m/api/send`、Cookie 名对不对、缺了自定义头会不会被放行 ——
 * 这些只有真发一次请求才看得见。
 *
 * 端口传 0 由系统分配：Windows 上刚关掉的监听会留在 TIME_WAIT，
 * 固定端口第二次跑就会 `EADDRINUSE`，那是测试自己造出来的假失败。
 */

const phonePeer: SyncPeer = { id: 'p-win', name: 'PC · Windows', platform: 'win32', project: 'app', version: 'test' };

async function makeService(received: string[]): Promise<{ service: LanSyncService; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'plaitcode-mobile-'));
  const service = new LanSyncService(join(dir, 'state.json'), {
    peer: () => phonePeer,
    runRequirement: async () => true,
    writeLedger: async () => undefined,
    writeTranscript: async () => undefined,
    log: () => undefined,
    onMobileMessage: async (text) => {
      received.push(text);
      return { ok: true, message: '已发到团队群' };
    },
    canApproveFromPhone: () => true,
  });
  await service.load();
  return { service, dir };
}

/** 打开手机遥控，返回手机要访问的地址（端口由系统分配）。 */
async function start(service: LanSyncService): Promise<string> {
  const result = await service.setMobileControl(true, 0);
  assert.equal(result.ok, true, result.message);
  return service.mobileInfo().url;
}

test('手机遥控：没开时不算开启，也不给访问地址', async () => {
  const { service, dir } = await makeService([]);
  try {
    assert.equal(service.mobileAllowed(), false);
    assert.equal(service.mobileInfo().enabled, false);
  } finally {
    service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('手机遥控：验证码进门 → 读状态 → 发言 → 批准授权，全链路真请求', async () => {
  const received: string[] = [];
  const { service, dir } = await makeService(received);
  try {
    const base = await start(service);
    assert.match(base, /^http:\/\/[\d.]+:\d+\/m$/);

    // 1) 页面
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /PlaitCode/);

    // 2) 错码进不来
    const wrongCode = service.mobileInfo().code === '000000' ? '111111' : '000000';
    const wrong = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: wrongCode }),
    });
    assert.equal(wrong.status, 401);

    // 3) 正确码 → 拿到会话 Cookie
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: service.mobileInfo().code }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.match(cookie, /^plaitcode_m=[0-9a-f]+$/);

    // 4) 没 Cookie 读不到状态
    assert.equal((await fetch(`${base}/state`)).status, 401);

    // 5) 带 Cookie 读到状态
    const state = await fetch(`${base}/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
    const payload = await state.json() as { device: string; messages: unknown[]; canApprove: boolean };
    assert.equal(payload.device, phonePeer.name);
    assert.deepEqual(payload.messages, []);
    assert.equal(payload.canApprove, true);

    // 6) 发消息：缺自定义头被拒（跨站表单伪造不了这个头）
    const noHeader = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '加一个托盘图标' }),
    });
    assert.equal(noHeader.status, 403);
    assert.deepEqual(received, []);

    const sent = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-plaitcode-mobile': '1' },
      body: JSON.stringify({ text: '加一个托盘图标' }),
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(received, ['加一个托盘图标']);

    // 7) 空的正文不进群
    const empty = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-plaitcode-mobile': '1' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(empty.status, 400);

    // 8) 手机会出现在待批列表里，批准后桌面那段 Promise 真的被放行
    const pending = service.awaitApproval({ title: '运行命令', summary: 'npm test', detail: '', risk: 'command' }, 'approval-7');
    const listed = await fetch(`${base}/state`, { headers: { cookie } });
    const withApproval = await listed.json() as { approvals: Array<{ id: string }> };
    assert.deepEqual(withApproval.approvals.map((item) => item.id), ['approval-7']);

    const approve = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-plaitcode-mobile': '1' },
      body: JSON.stringify({ id: 'approval-7', allow: true }),
    });
    assert.equal(approve.status, 200);
    assert.equal(await pending, true);

    // 9) 重复批准同一张卡 → 409（手机和电脑同时点也不会互相打架）
    const duplicate = await fetch(`${base}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-plaitcode-mobile': '1' },
      body: JSON.stringify({ id: 'approval-7', allow: false }),
    });
    assert.equal(duplicate.status, 409);
  } finally {
    service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('手机遥控：关掉之后会话失效、页面消失', async () => {
  const { service, dir } = await makeService([]);
  try {
    const base = await start(service);
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: service.mobileInfo().code }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.equal((await fetch(`${base}/state`, { headers: { cookie } })).status, 200);

    await service.setMobileControl(false);
    // 监听收掉了：连不上（或者 404），两种都算「进不去」
    await assert.rejects(fetch(`${base}/state`, { headers: { cookie } }));
  } finally {
    service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
