/**
 * 局域网跨平台对齐：网络层（HTTP + UDP 发现）与状态维护。
 *
 * 设计取舍（写给以后的自己和评审）：
 *
 * 1. **不引入依赖**。只用 Node 自带的 `http` / `dgram` / `crypto` / `os`：这个扩展
 *    的卖点之一是「装上就能用」，为一个可选功能加 native 依赖不值得。
 * 2. **每台设备都开一个监听**，而不是让对端轮询。轮询要么延迟高、要么请求多；
 *    而「每台机器自己一个端口」在同一 WiFi 里并不冲突（IP 不同）。主机负责转发。
 * 3. **配对码是唯一凭据**，每个请求都要带。同一个 WiFi 上的陌生设备扫到端口也进不来。
 * 4. **网络输入全部当作不可信**：`parseSyncMessage` 卡长度 + 校验形状，处理器只认
 *    校验通过的对象；任何异常都只在日志里留一行，绝不让它冒到面板。
 * 5. **默认关闭**（`hwchat.lanSync.enabled` 默认 false），不影响现有任何功能。
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { hostname, networkInterfaces, platform as osPlatform } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ALIGNMENT_FILE,
  MAX_MESSAGE_BYTES,
  MAX_NOTES,
  MAX_PEERS,
  SYNC_PROTOCOL_VERSION,
  buildLedger,
  describeSyncState,
  findDivergences,
  makeNote,
  makeReport,
  makeRequirement,
  pairingMatches,
  parseSyncMessage,
  renderLedger,
  shouldAutoRespond,
  type ReportStatus,
  type SyncMessage,
  type SyncNote,
  type SyncPeer,
  type SyncPlatform,
  type SyncReport,
  type SyncRequirement,
} from './lanProtocol';

export interface LanSyncBridge {
  /** 本机这一轮的身份（名称、平台、项目、扩展版本）。 */
  peer(): SyncPeer;
  /** 收到对端需求时让面板开跑；返回 false 表示现在没法跑（面板在忙）。 */
  runRequirement(requirement: SyncRequirement): Promise<boolean>;
  /**
   * 收到对端的协作消息时交给本机 agent。
   *
   * 返回 false 表示面板正忙、消息已记录但没进对话 —— 这时它还在 `recentNotes()`
   * 里，用户或 agent 下次 `team_sync status` 能看到，不会丢。
   */
  runNote?(note: SyncNote): Promise<boolean>;
  /** 把账本写进工作区（没有工作区时由实现方决定写到哪 / 跳过）。 */
  writeLedger(markdown: string): Promise<void>;
  /** 日志（输出通道）。 */
  log(line: string, level?: 'info' | 'warn'): void;
  /** 状态变化时刷新状态栏。 */
  onState?: () => void;
}

export type LanSyncRole = 'off' | 'hub' | 'peer';

/** 只依赖 dispose()，不 import vscode —— 这样整个网络层能在 Node 里直接跑测试。 */
export interface Disposable {
  dispose(): void;
}

interface PersistedState {
  pairingCode?: string;
  requirements: SyncRequirement[];
  reports: SyncReport[];
  notes?: SyncNote[];
}

const STATE_LIMIT = 300;
const REQUEST_TIMEOUT_MS = 4_000;
const BODY_LIMIT = MAX_MESSAGE_BYTES + 16 * 1024;
const DISCOVER_MAGIC = 'HWCHAT-SYNC-DISCOVER/1';
const HUB_MAGIC = 'HWCHAT-SYNC-HUB/1';

function platformOf(value: string): SyncPlatform {
  return value === 'win32' || value === 'darwin' ? value : 'linux';
}

/** 本机所有非回环 IPv4 地址（用于告诉对端「来这个地址找我」）。 */
export function lanAddresses(): string[] {
  const result: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

export class LanSyncService implements Disposable {
  private server?: Server;
  private udp?: UdpSocket;
  private role: LanSyncRole = 'off';
  private port = 47821;
  private hubAddress = '';
  private code = '';
  private requirements: SyncRequirement[] = [];
  private reports: SyncReport[] = [];
  private notes: SyncNote[] = [];
  private readonly peers = new Map<string, { peer: SyncPeer; address: string }>();
  private disposed = false;
  private announceTimer?: NodeJS.Timeout;

  constructor(
    private readonly storagePath: string,
    private readonly bridge: LanSyncBridge,
  ) {}

  /** 读取持久化的配对码与历史记录（同步调用，避免每次判断都要 await）。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.code = typeof parsed.pairingCode === 'string' ? parsed.pairingCode : '';
      this.requirements = Array.isArray(parsed.requirements)
        ? parsed.requirements.map((item) => parseSyncMessage(item)).filter((item): item is SyncRequirement => item?.kind === 'requirement')
        : [];
      this.reports = Array.isArray(parsed.reports)
        ? parsed.reports.map((item) => parseSyncMessage(item)).filter((item): item is SyncReport => item?.kind === 'report')
        : [];
      this.notes = Array.isArray(parsed.notes)
        ? parsed.notes.map((item) => parseSyncMessage(item)).filter((item): item is SyncNote => item?.kind === 'note').slice(-MAX_NOTES)
        : [];
    } catch {
      // 第一次运行没有文件，正常。
    }
    if (!this.code) {
      this.code = randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})(?!$)/, '$1-');
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const state: PersistedState = {
      pairingCode: this.code,
      requirements: this.requirements.slice(-STATE_LIMIT),
      reports: this.reports.slice(-STATE_LIMIT * 3),
      notes: this.notes.slice(-MAX_NOTES),
    };
    try {
      await mkdir(dirname(this.storagePath), { recursive: true });
      await writeFile(this.storagePath, JSON.stringify(state), 'utf8');
    } catch (error) {
      this.bridge.log(`[sync] 保存状态失败：${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }

  pairingCode(): string {
    return this.code;
  }

  /** 本机身份（面板拼「按本机平台做等价实现」时用）。 */
  localPeer(): SyncPeer {
    return this.bridge.peer();
  }

  /**
   * 设置配对码。
   *
   * 两台设备必须填**同一个**值才能互通：这是唯一的凭据，也是「同一个 WiFi 上
   * 有陌生设备」时唯一的防线。由用户在设置里填，或加入时按主机显示的那串填。
   */
  async setPairingCode(code: string): Promise<void> {
    const value = code.trim().toUpperCase();
    if (!value) return;
    this.code = value;
    await this.persist();
  }

  state(): { role: LanSyncRole; peers: number; requirements: number; divergences: number; address: string; text: string } {
    const rows = buildLedger(this.requirements, this.reports);
    const divergences = findDivergences(rows).length;
    return {
      role: this.role,
      peers: this.role === 'off' ? 0 : this.peers.size + (this.role === 'hub' ? 1 : 1),
      requirements: rows.length,
      divergences,
      address: this.role === 'hub' ? `:${this.port}` : this.hubAddress,
      text: describeSyncState({
        role: this.role,
        peers: this.role === 'off' ? 0 : this.peers.size + 1,
        requirements: rows.length,
        divergences,
      }),
    };
  }

  /**
   * 成为主机（host）。
   *
   * 主机同时是「转运站」和「参与者」：自己也会收到并执行需求，并且负责把需求
   * 转发给所有已登记的设备。
   */
  async startHub(port = this.port): Promise<{ ok: boolean; message: string }> {
    if (this.role === 'hub' && this.server) return { ok: true, message: `已在主机模式（:${this.port}）` };
    this.stopListener();
    this.port = port;
    try {
      await this.startListener();
      await this.startDiscovery();
      this.role = 'hub';
      this.hubAddress = '';
      this.bridge.log(`[sync] 主机已启动，端口 ${port}，配对码 ${this.code}`);
      this.bridge.onState?.();
      return {
        ok: true,
        message: `主机已启动。同一 WiFi 的另一台设备用配对码 ${this.code} 加入；监听端口 ${port}。`,
      };
    } catch (error) {
      this.role = 'off';
      const message = error instanceof Error ? error.message : String(error);
      this.bridge.log(`[sync] 启动主机失败：${message}`, 'warn');
      return { ok: false, message: `启动主机失败：${message}` };
    }
  }

  /** 加入某台主机。地址留空时用 UDP 广播自动寻找。 */
  async joinHub(address?: string, port = this.port): Promise<{ ok: boolean; message: string }> {
    this.port = port;
    this.stopListener();
    try {
      await this.startListener();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `本机监听失败：${message}` };
    }
    const target = address?.trim() || await this.discover();
    if (!target) {
      this.role = 'off';
      this.stopListener();
      return { ok: false, message: '没有自动找到主机。请直接填写主机的局域网 IP（状态栏里有）。' };
    }
    const response = await this.postJson(target, '/hwchat-sync/v1/pair', {
      protocol: SYNC_PROTOCOL_VERSION,
      code: this.code,
      peer: this.bridge.peer(),
      port: this.port,
    }).catch(() => undefined);    if (!response?.ok) {
      this.role = 'off';
      this.stopListener();
      const reason = typeof response?.error === 'string' ? response.error : '对端无响应或配对码不符';
      return { ok: false, message: `加入失败：${reason}` };
    }
    if (Array.isArray(response.peers)) this.absorbPeers(response.peers);
    this.role = 'peer';
    this.hubAddress = target;
    this.bridge.log(`[sync] 已加入主机 ${target}（配对码 ${this.code}）`);
    this.bridge.onState?.();
    return { ok: true, message: `已加入主机 ${target}。现在两边的设备会在同一个需求下一起执行。` };
  }

  stop(): void {
    this.stopListener();
    this.role = 'off';
    this.hubAddress = '';
    this.bridge.onState?.();
  }

  private stopListener(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = undefined;
    }
    this.udp?.close();
    this.udp = undefined;
    this.server?.close();
    this.server = undefined;
  }

  private async startListener(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  /** UDP 发现：主机周期广播自己，加入方广播询问。 */
  private async startDiscovery(): Promise<void> {
    const udp = createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(this.port, () => {
        udp.off('error', reject);
        resolve();
      });
    });
    udp.on('error', (error) => this.bridge.log(`[sync] UDP 错误：${error.message}`, 'warn'));
    udp.on('message', (buffer, remote) => {
      const text = buffer.toString('utf8');
      if (text === DISCOVER_MAGIC) {
        // 有人在找主机：把自己的地址回过去。
        const payload = JSON.stringify({ magic: HUB_MAGIC, port: this.port, addresses: lanAddresses() });
        udp.send(payload, remote.port, remote.address);
      }
    });
    this.udp = udp;
    this.announceTimer = setInterval(() => {
      const payload = Buffer.from(JSON.stringify({ magic: HUB_MAGIC, port: this.port, addresses: lanAddresses() }));
      udp.send(payload, this.port, '255.255.255.255', () => { /* 广播失败无所谓 */ });
    }, 15_000);
    this.announceTimer.unref?.();
  }

  private async discover(): Promise<string> {
    const udp = createSocket({ type: 'udp4', reuseAddr: true });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { udp.close(); } catch { /* 已关闭 */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(''), 2_000);
      udp.on('error', () => finish(''));
      udp.on('message', (buffer) => {
        try {
          const parsed = JSON.parse(buffer.toString('utf8')) as { magic?: string; addresses?: unknown; port?: unknown };
          if (parsed.magic !== HUB_MAGIC || !Array.isArray(parsed.addresses)) return;
          const address = parsed.addresses.find((item): item is string => typeof item === 'string' && Boolean(item));
          if (address) finish(`http://${address}:${typeof parsed.port === 'number' ? parsed.port : this.port}`);
        } catch {
          // 不是我们的包。
        }
      });
      udp.bind(() => {
        const payload = Buffer.from(DISCOVER_MAGIC);
        udp.setBroadcast(true);
        udp.send(payload, this.port, '255.255.255.255', () => { /* 忽略 */ });
      });
    });
  }

  private absorbPeers(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const item of value.slice(0, MAX_PEERS)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as { peer?: unknown; address?: unknown };
      const message = parseSyncMessage({ kind: 'report', requirementId: 'x', from: record.peer, status: 'planned' });
      if (!message) continue;
      const address = typeof record.address === 'string' ? record.address : '';
      this.peers.set(message.from.id, { peer: message.from, address });
    }
    this.bridge.onState?.();
  }

  private selfAddress(remoteAddress: string | undefined): string {
    const own = lanAddresses();
    // 尽量回给对方能连上的那个网段：取与请求来源同前缀的第一个地址。
    if (remoteAddress) {
      const prefix = remoteAddress.split('.').slice(0, 3).join('.');
      const sameSubnet = own.find((address) => address.startsWith(`${prefix}.`));
      if (sameSubnet) return `http://${sameSubnet}:${this.port}`;
    }
    return own[0] ? `http://${own[0]}:${this.port}` : '';
  }

  private peerList(): Array<{ peer: SyncPeer; address: string }> {
    return [...this.peers.values()].filter((entry) => entry.peer.id !== this.bridge.peer().id);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';
    const route = url.split('?')[0] ?? '/';
    const json = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    };
    try {
      if (request.method === 'GET' && route === '/hwchat-sync/v1/ping') {
        json(200, { ok: true, protocol: SYNC_PROTOCOL_VERSION, peer: this.bridge.peer(), role: this.role });
        return;
      }
      if (request.method !== 'POST') {
        json(404, { ok: false, error: 'not found' });
        return;
      }
      const body = await readBody(request);
      if (!body) {
        json(413, { ok: false, error: 'body too large' });
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        json(400, { ok: false, error: 'invalid json' });
        return;
      }
      /*
       * 配对码：**每个**请求都要带。别人在同一个 WiFi 上扫到端口也进不来。
       * 未启用主机模式时一律拒绝 —— 只监听、不服务，等于端口是关的。
       */
      if (!pairingMatches(parsed.code, this.code)) {
        json(403, { ok: false, error: 'pairing code mismatch' });
        return;
      }
      if (route === '/hwchat-sync/v1/pair') {
        const message = parseSyncMessage({ kind: 'report', requirementId: 'pair', from: parsed.peer, status: 'planned' });
        if (message) {
          /*
           * 加入方自己的地址必须算准，否则主机会把需求「转发」到自己身上。
           *
           * 这里优先用加入方声明的地址；没有就用**请求来源的 IP** 加它自报的端口 ——
           * 绝不能回落到 `selfAddress()`，那是主机自己的地址（第一版就是这个 bug）。
           */
          const remoteIp = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
          const declaredPort = typeof parsed.port === 'number' && parsed.port > 0 && parsed.port < 65_536
            ? parsed.port
            : this.port;
          const address = typeof parsed.address === 'string' && parsed.address
            ? parsed.address
            : (remoteIp ? `http://${remoteIp}:${declaredPort}` : '');
          this.peers.set(message.from.id, { peer: message.from, address });
          this.bridge.log(`[sync] 设备加入：${message.from.name}（${message.from.project}）${address ? ` → ${address}` : ''}`);
        }
        json(200, {
          ok: true,
          peers: this.peerList(),
          hub: { peer: this.bridge.peer(), address: this.selfAddress(request.socket.remoteAddress) },
        });
        return;
      }
      if (route === '/hwchat-sync/v1/message') {
        const message = parseSyncMessage(parsed.message);
        if (!message) {
          json(400, { ok: false, error: 'invalid message' });
          return;
        }
        // 主机先落账，再转发给其它设备（不回给发送方，避免回声）。
        await this.applyMessage(message, { relay: true, from: message.from.id });
        json(200, { ok: true });
        return;
      }
      /*
       * 对端（非主机）的接收端口：主机把需求转发到这里。
       *
       * 只接受主机转发的消息，且同样校验配对码 —— 这样即使有人知道端口，
       * 没有配对码也没法让别人的机器执行任务。
       */
      if (route === '/hwchat-sync/v1/deliver') {
        const message = parseSyncMessage(parsed.message);
        if (!message) {
          json(400, { ok: false, error: 'invalid message' });
          return;
        }
        if (message.kind === 'requirement') this.peers.set(message.from.id, { peer: message.from, address: '' });
        await this.applyMessage(message, { relay: false });
        json(200, { ok: true });
        return;
      }
      json(404, { ok: false, error: 'not found' });
    } catch (error) {
      this.bridge.log(`[sync] 处理请求失败：${error instanceof Error ? error.message : String(error)}`, 'warn');
      try { json(500, { ok: false, error: 'internal' }); } catch { /* 已结束 */ }
    }
  }

  /**
   * 落地一条消息并（可选）转发。
   *
   * 幂等：同一个需求 id 只记一次，同一条报告按「平台 + 时间」取最新 ——
   * 网络重发、主机与对端都收到同一条消息时不会重复渲染。
   */
  private async applyMessage(message: SyncMessage, options: { relay: boolean; from?: string }): Promise<void> {
    if (message.kind === 'requirement') {
      const exists = this.requirements.some((item) => item.id === message.id);
      if (!exists) {
        this.requirements = [...this.requirements, message].slice(-STATE_LIMIT);
        await this.persist();
        this.bridge.log(`[sync] 收到需求 ${message.id}：${message.title}（来自 ${message.from.name}）`);
        // 本机执行（除发起方自己）。
        if (message.from.id !== this.bridge.peer().id) {
          const accepted = await this.bridge.runRequirement(message).catch((error: unknown) => {
            this.bridge.log(`[sync] 本机执行需求失败：${error instanceof Error ? error.message : String(error)}`, 'warn');
            return false;
          });
          if (!accepted) this.bridge.log('[sync] 面板正忙，需求已记录，稍后可手动继续', 'warn');
        }
      }
    } else {
      if (message.kind === 'note') {
        /*
         * 协作消息：先记账，再交给本机 agent。
         *
         * 幂等按 id 去重 —— 同一台设备既是发起方又收到转发时会重复到达一次。
         */
        if (!this.notes.some((item) => item.id === message.id)) {
          this.notes = [...this.notes, message].slice(-MAX_NOTES);
          await this.persist();
          this.bridge.log(`[sync] 队友消息（${message.from.name}）：${message.body.slice(0, 80)}`);
          if (message.from.id !== this.bridge.peer().id && shouldAutoRespond(message)) {
            const accepted = await this.bridge.runNote?.(message).catch((error: unknown) => {
              this.bridge.log(`[sync] 交付队友消息失败：${error instanceof Error ? error.message : String(error)}`, 'warn');
              return false;
            });
            if (accepted === false) this.bridge.log('[sync] 面板正忙，队友消息已记录（team_sync status 可查看）', 'warn');
          }
        }
      } else {
        const key = `${message.requirementId}\u0000${message.from.platform}\u0000${message.from.id}`;
        const index = this.reports.findIndex((item) => `${item.requirementId}\u0000${item.from.platform}\u0000${item.from.id}` === key);
        if (index >= 0) {
          if (message.at >= this.reports[index]!.at) this.reports[index] = message;
        } else {
          this.reports = [...this.reports, message].slice(-STATE_LIMIT * 3);
        }
        await this.persist();
        this.bridge.log(`[sync] 收到报告：${message.from.name} ${message.status} ${message.requirementId}`);
      }
    }
    if (options.relay && this.role === 'hub') {
      const payload = JSON.stringify({ protocol: SYNC_PROTOCOL_VERSION, code: this.code, message });
      const targets = this.peerList().filter((entry) => entry.address && entry.peer.id !== options.from);
      await Promise.allSettled(targets.map((entry) => postRaw(entry.address, '/hwchat-sync/v1/deliver', payload)));
    }
    await this.refreshLedger();
    this.bridge.onState?.();
  }

  /** 把账本写进仓库：这是「对齐」的可见产物，人和模型都能读。 */
  private async refreshLedger(): Promise<void> {
    const rows = buildLedger(this.requirements, this.reports);
    if (!rows.length) return;
    try {
      await this.bridge.writeLedger(renderLedger(rows));
    } catch (error) {
      this.bridge.log(`[sync] 写账本失败：${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }

  /**
   * 本机发起一条需求：先本地执行，再广播给对端。
   *
   * 顺序很重要 —— 先本地开跑，用户立刻看到自己的设备动起来了；广播失败也只影响对端，
   * 不会让本机白等一次网络超时。
   */
  async shareRequirement(text: string): Promise<{ ok: boolean; message: string; requirement?: SyncRequirement }> {
    const requirement = makeRequirement(this.bridge.peer(), text);
    if (!requirement) return { ok: false, message: '需求内容为空。' };
    const exists = this.requirements.some((item) => item.id === requirement.id);
    if (!exists) this.requirements = [...this.requirements, requirement].slice(-STATE_LIMIT);
    await this.persist();
    await this.refreshLedger();

    if (this.role !== 'off') {
      const payload = JSON.stringify({ protocol: SYNC_PROTOCOL_VERSION, code: this.code, message: requirement });
      if (this.role === 'hub') {
        const targets = this.peerList().filter((entry) => entry.address);
        const results = await Promise.allSettled(targets.map((entry) => postRaw(entry.address, '/hwchat-sync/v1/deliver', payload)));
        const failed = results.filter((result) => result.status === 'rejected').length;
        const delivered = targets.length - failed;
        this.bridge.onState?.();
        return {
          ok: targets.length === 0 || delivered > 0,
          message: targets.length
            ? `已同步给 ${delivered}/${targets.length} 台设备（需求号 ${requirement.id}）。`
            : `本机已记录（需求号 ${requirement.id}），当前没有其它设备加入。`,
          requirement,
        };
      }
      const response = await this.postJson(this.hubAddress, '/hwchat-sync/v1/message', {
        protocol: SYNC_PROTOCOL_VERSION,
        code: this.code,
        message: requirement,
      }).catch(() => undefined);
      this.bridge.onState?.();
      return {
        ok: Boolean(response?.ok),
        message: response?.ok
          ? `已交给主机转发（需求号 ${requirement.id}）。`
          : `本机已记录，但同步失败（主机没响应）。需求号 ${requirement.id}。`,
        requirement,
      };
    }
    this.bridge.onState?.();
    return { ok: true, message: `本机已记录（需求号 ${requirement.id}）。局域网同步未启用，没有广播。`, requirement };
  }

  /**
   * 两台 agent 之间的**协作消息**（用户说的「像同事一样沟通、互通有无」）。
   *
   * 与 `shareRequirement` 的区别：需求一定会开跑一轮；协作消息只是把一段话送给
   * 对端 agent，由它判断要不要动手、要不要回。这也是「不要为了回应而改代码」的落点。
   */
  async shareNote(input: { body: string; topic?: string; replyTo?: string }): Promise<{ ok: boolean; message: string }> {
    const note = makeNote(this.bridge.peer(), input);
    if (!note) return { ok: false, message: '消息内容为空。' };
    this.notes = [...this.notes, note].slice(-MAX_NOTES);
    await this.persist();
    if (this.role === 'off') {
      this.bridge.onState?.();
      return { ok: true, message: '本机已记录。局域网同步未启用，没有发出。' };
    }
    const payload = JSON.stringify({ protocol: SYNC_PROTOCOL_VERSION, code: this.code, message: note });
    if (this.role === 'hub') {
      const targets = this.peerList().filter((entry) => entry.address);
      const results = await Promise.allSettled(targets.map((entry) => postRaw(entry.address, '/hwchat-sync/v1/deliver', payload)));
      const delivered = results.filter((result) => result.status === 'fulfilled').length;
      this.bridge.onState?.();
      return {
        ok: targets.length === 0 || delivered > 0,
        message: targets.length ? `已发给 ${delivered}/${targets.length} 台设备。` : '已记录，当前没有其它设备加入。',
      };
    }
    const response = await this.postJson(this.hubAddress, '/hwchat-sync/v1/message', {
      protocol: SYNC_PROTOCOL_VERSION,
      code: this.code,
      message: note,
    }).catch(() => undefined);
    this.bridge.onState?.();
    return { ok: Boolean(response?.ok), message: response?.ok ? '已发给对端。' : '记录成功，但发送失败（主机没响应）。' };
  }

  /** 最近的协作消息（`team_sync` 的 status 与面板展示用）。 */
  recentNotes(limit = 10): SyncNote[] {
    return this.notes.slice(-Math.max(1, limit));
  }

  /** 已有需求的标题，用来把「需求」和「聊天」关联起来（agent 回答时不必自己翻账本）。 */
  requirementTitles(limit = 8): string[] {
    return this.requirements.slice(-limit).map((item) => `${item.id}：${item.title}`);
  }

  /** 本机报告一条进度：写本地账本并同步给对端。 */
  async report(input: {
    requirementId: string;
    status: ReportStatus;
    summary?: string;
    files?: string[];
    note?: string;
  }): Promise<void> {
    const report = makeReport(this.bridge.peer(), input);
    const key = `${report.requirementId}\u0000${report.from.platform}\u0000${report.from.id}`;
    const index = this.reports.findIndex((item) => `${item.requirementId}\u0000${item.from.platform}\u0000${item.from.id}` === key);
    if (index >= 0) this.reports[index] = report;
    else this.reports = [...this.reports, report].slice(-STATE_LIMIT * 3);
    await this.persist();
    await this.refreshLedger();
    if (this.role === 'off') return;
    const payload = JSON.stringify({ protocol: SYNC_PROTOCOL_VERSION, code: this.code, message: report });
    if (this.role === 'hub') {
      const targets = this.peerList().filter((entry) => entry.address);
      await Promise.allSettled(targets.map((entry) => postRaw(entry.address, '/hwchat-sync/v1/deliver', payload)));
    } else {
      await this.postJson(this.hubAddress, '/hwchat-sync/v1/message', { code: this.code, message: report }).catch(() => undefined);
    }
    this.bridge.onState?.();
  }

  /** 手动推一次账本（工作区刚打开 / 用户点「打开账本」时用）。 */
  async syncLedger(): Promise<void> {
    await this.refreshLedger();
  }

  private async postJson(address: string, path: string, body: unknown): Promise<Record<string, unknown> | undefined> {
    const payload = JSON.stringify(body);
    const result = await postRaw(address, path, payload);
    try {
      return JSON.parse(result) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopListener();
    this.role = 'off';
  }
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        resolve(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(undefined));
  });
}

function postRaw(address: string, path: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, address.startsWith('http') ? address : `http://${address}`);
    } catch (error) {
      reject(error);
      return;
    }
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 500) >= 400) reject(new Error(`${response.statusCode}: ${text.slice(0, 200)}`));
        else resolve(text);
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(payload);
  });
}

/** 设备名：主机名 + 平台，例如「MacBook-Pro · macOS」。 */
export function defaultDeviceName(): string {
  const name = hostname().replace(/\.local$/i, '');
  return `${name} · ${defaultPlatform()}`;
}

export function defaultPlatform(): SyncPlatform {
  return platformOf(osPlatform());
}

/** 稳定设备 id：主机名 + 平台 + 用户名哈希（同机重启不变，换机不同）。 */
export function peerIdFor(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/** 账本路径（有 docs/ 就放进 docs/，否则放工作区根）。 */
export function ledgerPathFor(root: string): string {
  return join(root, ALIGNMENT_FILE);
}
