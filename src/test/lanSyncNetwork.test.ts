import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LanSyncService } from '../sync/lanSync';
import type { SyncNote, SyncPeer, SyncRequirement } from '../sync/lanProtocol';

/**
 * 端到端：真的起两个监听取件，验证「配对 → 广播需求 → 对端执行 → 对端回报 → 主机落账」。
 *
 * 这是这个功能最容易「看起来写完了其实不通」的地方（第一版就把加入方的地址算成了
 * 主机自己，需求永远送不到对端）。所以这里不打桩，用真实 HTTP + 真实端口。
 */

const HUB_PORT = 48_321;
const PEER_PORT = 48_322;

const winPeer: SyncPeer = { id: 'p-win', name: 'PC · Windows', platform: 'win32', project: 'app-win', version: 'test' };
const macPeer: SyncPeer = { id: 'p-mac', name: 'Mac · macOS', platform: 'darwin', project: 'app-mac', version: 'test' };

async function makeService(peer: SyncPeer, options: {
  onRequirement?: (requirement: SyncRequirement) => Promise<boolean>;
  onNote?: (note: SyncNote) => Promise<boolean>;
} = {}): Promise<{ service: LanSyncService; dir: string; ledgers: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'hwchat-sync-'));
  const ledgers: string[] = [];
  const service = new LanSyncService(join(dir, 'state.json'), {
    peer: () => peer,
    runRequirement: options.onRequirement ?? (async () => true),
    runNote: options.onNote ?? (async () => true),
    writeLedger: async (markdown) => { ledgers.push(markdown); },
    writeTranscript: async () => undefined,
    log: () => undefined,
  });
  await service.load();
  return { service, dir, ledgers };
}

test('端到端：配对后主机发需求，对端真的收到并执行；对端回报后主机账本更新', async () => {
  const hub = await makeService(winPeer);
  const peer = await makeService(macPeer);

  // 两边用同一个配对码（真实流程里由用户填）。
  await hub.service.setPairingCode('TEST-CODE');
  await peer.service.setPairingCode('TEST-CODE');

  const received: SyncRequirement[] = [];
  // 对端收到需求：记录一下（真实环境里这里会开跑一轮 agent）。
  const peerWithHook = new LanSyncService(join(peer.dir, 'state2.json'), {
    peer: () => macPeer,
    runRequirement: async (requirement) => { received.push(requirement); return true; },
    runNote: async () => true,
    writeLedger: async () => undefined,
    writeTranscript: async () => undefined,
    log: () => undefined,
  });
  await peerWithHook.load();
  await peerWithHook.setPairingCode('TEST-CODE');

  try {
    const started = await hub.service.startHub(HUB_PORT);
    assert.equal(started.ok, true, started.message);
    const joined = await peerWithHook.joinHub(`http://127.0.0.1:${HUB_PORT}`, PEER_PORT);
    assert.equal(joined.ok, true, joined.message);

    const shared = await hub.service.shareRequirement('加一个托盘图标，点击恢复窗口');
    assert.equal(shared.ok, true, shared.message);
    assert.ok(shared.requirement);

    // 对端应当收到同一条需求（等一小会儿让网络请求完成）。
    await waitFor(() => received.length > 0, 3_000);
    assert.equal(received[0]?.id, shared.requirement!.id, '两端必须用同一个需求号');
    assert.match(received[0]!.detail, /托盘图标/);

    // 对端回报 done，主机的账本要出现这一行。
    await peerWithHook.report({
      requirementId: shared.requirement!.id,
      status: 'done',
      summary: '已用 NSStatusBar 实现',
      files: ['Sources/App/Tray.swift'],
    });
    await waitFor(() => hub.ledgers.length > 0 && hub.ledgers[hub.ledgers.length - 1]!.includes('NSStatusBar'), 3_000);
    const ledger = hub.ledgers[hub.ledgers.length - 1]!;
    assert.match(ledger, /托盘图标/, '账本要有这条需求');
    assert.match(ledger, /macOS/, '账本要标出是哪个平台完成的');
  } finally {
    hub.service.dispose();
    peerWithHook.dispose();
    peer.service.dispose();
    await rm(hub.dir, { recursive: true, force: true });
    await rm(peer.dir, { recursive: true, force: true });
  }
});

test('端到端：配对码不一致时加入失败，需求不会外泄', async () => {
  const hub = await makeService(winPeer);
  const peer = await makeService(macPeer);
  await hub.service.setPairingCode('RIGHT-CODE');
  await peer.service.setPairingCode('WRONG-CODE');
  const received: SyncRequirement[] = [];
  const spy = new LanSyncService(join(peer.dir, 'spy.json'), {
    peer: () => macPeer,
    runRequirement: async (requirement) => { received.push(requirement); return true; },
    runNote: async () => true,
    writeLedger: async () => undefined,
    writeTranscript: async () => undefined,
    log: () => undefined,
  });
  await spy.load();
  await spy.setPairingCode('WRONG-CODE');

  try {
    assert.equal((await hub.service.startHub(HUB_PORT + 10)).ok, true);
    const joined = await spy.joinHub(`http://127.0.0.1:${HUB_PORT + 10}`, PEER_PORT + 10);
    assert.equal(joined.ok, false, '配对码不同必须拒绝');
    assert.match(joined.message, /配对码|无响应/);
    await hub.service.shareRequirement('不该被看到的机密需求');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(received.length, 0, '没配对的设备不该收到需求');
  } finally {
    hub.service.dispose();
    spy.dispose();
    peer.service.dispose();
    await rm(hub.dir, { recursive: true, force: true });
    await rm(peer.dir, { recursive: true, force: true });
  }
});

test('协作消息：主机发一条，对端 agent 收到；纯陈述不触发自动开跑', async () => {
  const hub = await makeService(winPeer);
  const notes: SyncNote[] = [];
  const statements: SyncNote[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'hwchat-sync-note-'));
  const peer = new LanSyncService(join(dir, 'state.json'), {
    peer: () => macPeer,
    runRequirement: async () => true,
    runNote: async (note) => { notes.push(note); return true; },
    writeLedger: async () => undefined,
    writeTranscript: async () => undefined,
    log: () => undefined,
  });
  await peer.load();
  await hub.service.setPairingCode('NOTE-CODE');
  await peer.setPairingCode('NOTE-CODE');

  try {
    assert.equal((await hub.service.startHub(HUB_PORT + 20)).ok, true);
    assert.equal((await peer.joinHub(`http://127.0.0.1:${HUB_PORT + 20}`, PEER_PORT + 20)).ok, true);

    // 纯陈述：记录但不自动跑。
    await hub.service.shareNote({ body: '我把标题栏改成自绘了', topic: '窗口' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(notes.length, 0, '纯陈述不该让对端开跑（防接龙）');
    assert.equal(peer.recentNotes(5).length, 1, '但必须记录下来，status 能看到');

    // 提问：触发对端自动跑一轮来回答。
    await hub.service.shareNote({ body: '你那边的窗口边距是多少？', topic: '窗口' });
    await waitFor(() => notes.length > 0, 3_000);
    assert.match(notes[0]!.body, /窗口边距/);
    statements.push(...peer.recentNotes(5));
    assert.equal(statements.length, 2, '两条都要在本地留存');
  } finally {
    hub.service.dispose();
    peer.dispose();
    await rm(dir, { recursive: true, force: true });
    await rm(hub.dir, { recursive: true, force: true });
  }
});

test('一键连接：陌生设备弹一次「允许」即可加入，之后重连不再询问', async () => {
  /*
   * 这是「傻瓜式」的核心：用户不抄配对码，只在弹窗上点一次「允许」。
   * 允许之后这台设备被记住，重连不再打扰。
   */
  const dir = await mkdtemp(join(tmpdir(), 'hwchat-sync-approve-'));
  const dir2 = await mkdtemp(join(tmpdir(), 'hwchat-sync-approve2-'));
  const asked: string[] = [];
  const hub = new LanSyncService(join(dir, 'state.json'), {
    peer: () => winPeer,
    runRequirement: async () => true,
    runNote: async () => true,
    writeLedger: async () => undefined,
    writeTranscript: async () => undefined,
    log: () => undefined,
    approvePeer: async (peer) => { asked.push(peer.id); return true; },
  });
  await hub.load();
  await hub.setPairingCode('HUB-ONLY-CODE');

  const strangerA = new LanSyncService(join(dir2, 'a.json'), {
    peer: () => macPeer,
    runRequirement: async () => true,
    runNote: async () => true,
    writeLedger: async () => undefined,
    writeTranscript: async () => undefined,
    log: () => undefined,
  });
  await strangerA.load();
  await strangerA.setPairingCode('DIFFERENT-CODE');

  try {
    const started = await hub.startHub(HUB_PORT + 30);
    assert.equal(started.ok, true, started.message);

    const first = await strangerA.joinHub(`http://127.0.0.1:${HUB_PORT + 30}`, PEER_PORT + 30);
    assert.equal(first.ok, true, `点「允许」之后必须能加入：${first.message}`);
    assert.deepEqual(asked, [macPeer.id], '主机应该只问一次');

    // 记住之后再连：不再弹窗。
    strangerA.stop();
    const again = await strangerA.joinHub(`http://127.0.0.1:${HUB_PORT + 30}`, PEER_PORT + 30);
    assert.equal(again.ok, true);
    assert.equal(asked.length, 1, '允许过的设备重连不该再打扰用户');
  } finally {
    hub.dispose();
    strangerA.dispose();
    await rm(dir, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});

test('一键连接：用户点「拒绝」时连不进来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hwchat-sync-reject-'));
  const dir2 = await mkdtemp(join(tmpdir(), 'hwchat-sync-reject2-'));
  const hub = new LanSyncService(join(dir, 'state.json'), {
    peer: () => winPeer,
    runRequirement: async () => true,
    runNote: async () => true,
    writeLedger: async () => undefined,
    writeTranscript: async () => undefined,
    log: () => undefined,
    approvePeer: async () => false,
  });
  await hub.load();
  await hub.setPairingCode('HUB-CODE');
  const stranger = new LanSyncService(join(dir2, 'a.json'), {
    peer: () => macPeer,
    runRequirement: async () => true,
    runNote: async () => true,
    writeLedger: async () => undefined,
    writeTranscript: async () => undefined,
    log: () => undefined,
  });
  await stranger.load();
  await stranger.setPairingCode('OTHER');
  try {
    assert.equal((await hub.startHub(HUB_PORT + 40)).ok, true);
    const joined = await stranger.joinHub(`http://127.0.0.1:${HUB_PORT + 40}`, PEER_PORT + 40);
    assert.equal(joined.ok, false, '用户拒绝就必须连不上');
  } finally {
    hub.dispose();
    stranger.dispose();
    await rm(dir, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('等待超时：预期的情况没有发生');
}
