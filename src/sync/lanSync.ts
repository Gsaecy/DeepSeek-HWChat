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
  MAX_GROUP_MESSAGES,
  MAX_MESSAGE_BYTES,
  MAX_NOTES,
  MAX_PEERS,
  SYNC_PROTOCOL_VERSION,
  buildLedger,
  describeSyncState,
  findDivergences,
  groupAgreement,
  makeGroupMessage,
  makeNote,
  makeReport,
  makeRequirement,
  pairingMatches,
  parseSyncMessage,
  renderGroupLine,
  renderGroupTranscript,
  renderLedger,
  shouldAutoRespond,
  type GroupPhase,
  type ReportStatus,
  type SyncGroupMessage,
  type SyncMessage,
  type SyncNote,
  type SyncPeer,
  type SyncPlatform,
  type SyncReport,
  type SyncRequirement,
} from './lanProtocol';
import {
  MOBILE_COOKIE,
  MOBILE_PATH,
  MOBILE_SESSION_TTL_MS,
  MobileGate,
  mobileCookie,
  parseCookies,
  renderMobilePage,
  type MobileApprovalView,
  type MobileStatePayload,
} from './mobileControl';

/** 手机上挂着的审批卡最多等这么久，过期就按「拒绝」收尾，免得线程一直挂着。 */
const REMOTE_APPROVAL_TTL_MS = 3 * 60_000;

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
  /**
   * 群里出现了新发言（包括自己的）：面板把它追加到对话里，用户就能像看群一样看整个过程。
   *
   * 失败不影响同步本身：记录文件照样写，用户仍能在 `docs/TEAM-CHAT.md` 里回看。
   */
  onGroupMessage?(message: SyncGroupMessage): Promise<void>;
  /**
   * 有一台陌生设备想连进来，问一下用户。
   *
   * 这是「傻瓜式」的关键：用户不用抄配对码，只要在弹窗上点一次「允许」。
   * 返回 true 之后这台设备会被记住，以后自动重连不再询问。
   */
  approvePeer?(peer: SyncPeer): Promise<boolean>;
  /** 把账本写进工作区（没有工作区时由实现方决定写到哪 / 跳过）。 */
  writeLedger(markdown: string): Promise<void>;
  /** 把团队群记录写进工作区。 */
  writeTranscript(markdown: string): Promise<void>;
  /** 日志（输出通道）。 */
  log(line: string, level?: 'info' | 'warn'): void;
  /** 状态变化时刷新状态栏。 */
  onState?: () => void;
  /**
   * 手机发来的一句话：走和群窗口完全相同的入口（判断「回答追问还是新需求」、广播、开跑）。
   *
   * 不在网络层重复实现这套判断 —— 两处判断迟早会不一致，那正是「手机说的和电脑说的不一样」的根因。
   */
  onMobileMessage?(text: string): Promise<{ ok: boolean; message: string }>;
  /** 手机上是否允许批准工具授权（用户可在设置里关掉，关掉后手机只能看和说话）。 */
  canApproveFromPhone?(): boolean;
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
  /** 团队群发言。 */
  group?: SyncGroupMessage[];
  /** 已经被用户允许过的设备 id：重连不再打扰。 */
  approved?: string[];
  /** 上次的角色与主机地址：下次开窗口自动恢复连接。 */
  role?: 'hub' | 'peer';
  hub?: string;
  port?: number;
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
  /** 团队群的全部发言（需求 / 解析 / 进度 / 结果）。 */
  private group: SyncGroupMessage[] = [];
  /** 用户点过「允许」的设备。重连时直接放行，不再弹窗。 */
  private approved = new Set<string>();
  /** 上次的角色与主机：下次激活自动恢复（用户不用重复操作）。 */
  private lastRole: 'hub' | 'peer' = 'hub';
  private lastHub = '';
  private lastPort = 0;
  private readonly peers = new Map<string, { peer: SyncPeer; address: string }>();
  private disposed = false;
  private announceTimer?: NodeJS.Timeout;
  /** 手机遥控是否开启。开着时即使没做双机同步也保留监听（单机也能用手机指挥）。 */
  private mobileEnabled = false;
  private readonly gate = new MobileGate();
  private readonly approvals = new Map<string, { view: MobileApprovalView; resolve: (allow: boolean) => void; timer: NodeJS.Timeout }>();
  private approvalSequence = 0;

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
      this.group = Array.isArray(parsed.group)
        ? parsed.group.map((item) => parseSyncMessage(item)).filter((item): item is SyncGroupMessage => item?.kind === 'group').slice(-MAX_GROUP_MESSAGES)
        : [];
      this.approved = new Set(Array.isArray(parsed.approved)
        ? parsed.approved.filter((item): item is string => typeof item === 'string').slice(0, 32)
        : []);
      this.lastRole = parsed.role === 'peer' ? 'peer' : 'hub';
      this.lastHub = typeof parsed.hub === 'string' ? parsed.hub : '';
      this.lastPort = typeof parsed.port === 'number' && parsed.port > 0 ? parsed.port : 0;
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
      group: this.group.slice(-MAX_GROUP_MESSAGES),
      approved: [...this.approved],
      role: this.lastRole,
      hub: this.lastHub,
      port: this.lastPort,
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

  /**
   * **一键连接**：这是给用户的唯一入口，不需要懂主机/从机/配对码。
   *
   * 行为按「哪边先点」自动兜底：
   *  - 同一个 WiFi 里已经有主机 → 直接加入（对端弹一次「允许吗」，点允许即可）；
   *  - 没有主机 → 自己成为主机待命，并提示另一台设备也点同一个按钮。
   *
   * 两台设备都点同一个按钮，谁先谁后都能连上 —— 这就是「傻瓜式」的核心。
   */
  async autoConnect(port?: number): Promise<{ ok: boolean; message: string; role: LanSyncRole }> {
    const targetPort = port && port > 0 ? port : (this.lastPort || this.port);
    this.port = targetPort;
    // 先在局域网里找已有主机（多试几次，给对方一点启动时间）。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await this.discover();
      if (found) {
        const joined = await this.joinHub(found, targetPort);
        if (joined.ok) {
          this.lastRole = 'peer';
          this.lastHub = found;
          this.lastPort = targetPort;
          await this.persist();
          return { ok: true, message: joined.message, role: 'peer' };
        }
        this.bridge.log(`[sync] 找到主机但加入失败：${joined.message}`, 'warn');
      }
    }
    const started = await this.startHub(targetPort);
    if (started.ok) {
      this.lastRole = 'hub';
      this.lastHub = '';
      this.lastPort = targetPort;
      await this.persist();
      return { ok: true, message: started.message, role: 'hub' };
    }
    return { ok: false, message: started.message, role: 'off' };
  }

  /** 上次连接的角色与地址（启动时自动恢复用）。 */
  lastConnection(): { role: 'hub' | 'peer'; hub: string; port: number } {
    return { role: this.lastRole, hub: this.lastHub, port: this.lastPort };
  }

  /**
   * 恢复到上次的连接状态。
   *
   * 用户不用每次开窗口都点一遍：上次是主机就继续当主机，上次加入了某台就继续连那台
   * （连不上就退回「成为主机待命」，绝不会卡在一个失败的连接上）。
   */
  async resume(port?: number): Promise<{ ok: boolean; message: string; role: LanSyncRole }> {
    const last = this.lastConnection();
    const targetPort = port && port > 0 ? port : (last.port || this.port);
    if (last.role === 'peer' && last.hub) {
      const joined = await this.joinHub(last.hub, targetPort);
      if (joined.ok) return { ok: true, message: joined.message, role: 'peer' };
      this.bridge.log(`[sync] 上次的主机没响应（${last.hub}），改为本机待命`, 'warn');
    }
    const started = await this.startHub(targetPort);
    return { ok: started.ok, message: started.message, role: started.ok ? 'hub' : 'off' };
  }

  /** 本机身份（面板拼「按本机平台做等价实现」时用）。 */
  localPeer(): SyncPeer {
    return this.bridge.peer();
  }

  /* ------------------------------------------------------------------ *
   * 手机遥控
   * ------------------------------------------------------------------ */

  /**
   * 开 / 关手机遥控。
   *
   * 关键点：**单机也要能开**。用户可能只有一台电脑，手机只是遥控器；
   * 所以这里不依赖 `role`，只要开着就保留监听。
   */
  async setMobileControl(enabled: boolean, port?: number): Promise<{ ok: boolean; message: string; url?: string }> {
    this.mobileEnabled = enabled;
    if (port && port > 0) this.port = port;
    if (!enabled) {
      this.gate.revokeAll();
      for (const id of [...this.approvals.keys()]) this.resolveApproval(id, false);
      if (this.role === 'off') this.stopListener();
      this.bridge.onState?.();
      return { ok: true, message: '手机遥控已关闭。' };
    }
    try {
      await this.ensureListener();
    } catch (error) {
      this.mobileEnabled = false;
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `手机遥控启动失败：${message}（端口 ${this.port} 可能被占用）` };
    }
    const code = this.gate.issueCode();
    this.bridge.onState?.();
    return {
      ok: true,
      message: `手机遥控已打开：同一 WiFi 下打开 ${this.mobileUrl()} 并输入 ${code.code}，或直接扫二维码。`,
      url: this.mobileUrl(),
    };
  }

  mobileAllowed(): boolean {
    return this.mobileEnabled;
  }

  /**
   * 手机要打开的那个地址。
   *
   * 一台机器常有好几个局域网地址（WiFi + 有线 + WSL/Hyper-V/VMware 虚拟网卡），
   * 取"第一个"经常取到虚拟网卡，手机根本连不上。所以按常见家庭/办公网段排序，
   * 面板上再把其余地址列出来当备选。
   */
  mobileUrl(): string {
    const all = lanAddresses();
    const score = (ip: string): number => {
      if (ip.startsWith('192.168.')) return 0;
      if (ip.startsWith('10.')) return 1;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
      if (ip.startsWith('169.254.')) return 4;
      return 3;
    };
    const address = [...all].sort((left, right) => score(left) - score(right))[0] ?? '127.0.0.1';
    return `http://${address}:${this.port}${MOBILE_PATH}`;
  }

  /** 带码的地址：拼成二维码，手机扫一下就进（不用手输 6 位）。 */
  mobileUrlWithCode(): string {
    const code = this.gate.currentCode().code;
    return `${this.mobileUrl()}?c=${code}`;
  }

  mobileInfo(): { enabled: boolean; url: string; qrText: string; code: string; expiresAt: number; sessions: number; addresses: string[] } {
    const current = this.gate.currentCode();
    return {
      enabled: this.mobileEnabled,
      url: this.mobileUrl(),
      qrText: `${this.mobileUrl()}?c=${current.code}`,
      code: current.code,
      expiresAt: current.expiresAt,
      sessions: 0,
      addresses: lanAddresses().map((address) => `http://${address}:${this.port}${MOBILE_PATH}`),
    };
  }

  /** 换一张新码（旧码立刻作废）。 */
  rotateMobileCode(): string {
    return this.gate.rotate().code;
  }

  /** 手机页面轮询的状态：成员 / 发言 / 未答追问 / 待审批。 */
  mobileState(): MobileStatePayload {
    const base = this.groupState();
    return {
      device: this.bridge.peer().name,
      role: this.role,
      peers: base.peers,
      messages: base.messages.slice(-60),
      ...(base.openQuestion ? { openQuestion: base.openQuestion } : {}),
      approvals: [...this.approvals.values()].map((entry) => entry.view),
      canApprove: this.bridge.canApproveFromPhone?.() ?? false,
    };
  }

  /** 手机上是否允许批准授权（用户在设置里可关）。 */
  remoteApprovalEnabled(): boolean {
    return this.mobileEnabled && (this.bridge.canApproveFromPhone?.() ?? false);
  }

  /**
   * 登记一张「等手机/电脑谁来批」的授权卡。
   *
   * 返回的 Promise 由**先到的一方**结算：手机点「允许」或电脑上点「允许」都行；
   * 三分钟没人处理就自动按拒绝收尾，绝不让工具线程一直挂着。
   */
  awaitApproval(
    input: { title: string; summary: string; detail: string; risk: MobileApprovalView['risk'] },
    id = `m-${++this.approvalSequence}`,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.resolveApproval(id, false), REMOTE_APPROVAL_TTL_MS);
      timer.unref?.();
      this.approvals.set(id, {
        view: { id, at: Date.now(), ...input },
        resolve,
        timer,
      });
    });
  }

  /** 结算一张授权卡；返回 false 表示它已经不在（被桌面抢先处理或过期了）。 */
  resolveApproval(id: string, allow: boolean): boolean {
    const entry = this.approvals.get(id);
    if (!entry) return false;
    this.approvals.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(allow);
    return true;
  }

  /** 当前挂着几张待批（状态栏提示用）。 */
  pendingApprovalCount(): number {
    return this.approvals.size;
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
    const rows = buildLedger(this.requirements, this.reports);    const divergences = findDivergences(rows).length;
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
    this.stopDiscovery();
    this.role = 'off';
    this.hubAddress = '';
    // 手机遥控开着的时候监听要留着：否则「断开双机同步」会顺手把手机也踢下线。
    if (!this.mobileEnabled) this.stopListener();
    this.bridge.onState?.();
  }

  private stopDiscovery(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = undefined;
    }
    this.udp?.close();
    this.udp = undefined;
  }

  private stopListener(): void {
    this.stopDiscovery();
    this.server?.close();
    this.server = undefined;
  }

  /** 监听已经开着就复用：手机遥控和双机同步共用同一个端口。 */
  private async ensureListener(): Promise<void> {
    if (this.server) return;
    await this.startListener();
  }

  private async startListener(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '0.0.0.0', () => {
        server.off('error', reject);
        // 端口填 0 时由系统分配：手机遥控因此永远不会和「上次没退干净的端口」打架。
        const address = server.address();
        if (address && typeof address === 'object' && address.port > 0) this.port = address.port;
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
      /*
       * 手机遥控走独立的一组路由（`/m`），排在配对码闸门前面：
       * 手机是用 6 位码换 Cookie 的，没有配对码可带。
       */
      if (route === MOBILE_PATH || route.startsWith(`${MOBILE_PATH}/`)) {
        await this.handleMobileRequest(request, response, route);
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
       * 配对码：**每个**请求都要带，别人在同一个 WiFi 上扫到端口也进不来。
       *
       * `/pair` 例外：它的放行判断在下面（已允许过的设备 / 对得上码 / 用户点「允许」
       * 三种途径），所以不能在这里一刀切 —— 否则「傻瓜式」的弹窗永远走不到。
       */
      if (route !== '/hwchat-sync/v1/pair' && !pairingMatches(parsed.code, this.code)) {
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
          /*
           * 放行判断，**傻瓜式**优先：
           *  1. 这台设备以前被允许过 → 直接放行（重连不再打扰）；
           *  2. 配对码对得上（老用户/固定码场景）→ 放行并记住；
           *  3. 否则问用户一次「允许吗」——用户点一次，以后就自动记住。
           * 没有 `approvePeer` 实现时退回「配对码必须对」（测试环境 / 无人值守）。
           */
          const known = this.approved.has(message.from.id);
          const codeOk = pairingMatches(parsed.code, this.code);
          let allowed = known || codeOk;
          if (!allowed && this.bridge.approvePeer) {
            allowed = await this.bridge.approvePeer(message.from).catch(() => false);
          }
          if (!allowed) {
            this.bridge.log(`[sync] 拒绝未授权的设备：${message.from.name}`);
            json(403, { ok: false, error: '未允许连接' });
            return;
          }
          if (!known) {
            this.approved.add(message.from.id);
            await this.persist();
          }
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
  private async handleMobileRequest(request: IncomingMessage, response: ServerResponse, route: string): Promise<void> {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        ...headers,
      });
      response.end(payload);
    };
    const sendHtml = (status: number, body: string): void => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        // 页面只用内联脚本，禁止别人嵌框架、禁止嗅探类型。
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      });
      response.end(body);
    };

    if (!this.mobileEnabled) {
      send(404, { ok: false, error: '手机遥控未开启' });
      return;
    }

    const client = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const cookies = parseCookies(request.headers.cookie);
    const authed = this.gate.authorize(cookies[MOBILE_COOKIE]);

    if (route === MOBILE_PATH) {
      if (request.method !== 'GET') {
        send(405, { ok: false, error: 'method not allowed' });
        return;
      }
      sendHtml(200, renderMobilePage({
        device: this.bridge.peer().name,
        authed,
        canApprove: this.bridge.canApproveFromPhone?.() ?? false,
      }));
      return;
    }

    if (route === `${MOBILE_PATH}/login`) {
      if (request.method !== 'POST') {
        send(405, { ok: false, error: 'method not allowed' });
        return;
      }
      const raw = await readBody(request);
      if (!raw) {
        send(413, { ok: false, error: 'body too large' });
        return;
      }
      let code = '';
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        code = typeof parsed.code === 'string' ? parsed.code : String(parsed.code ?? '');
      } catch {
        send(400, { ok: false, error: 'invalid json' });
        return;
      }
      const result = this.gate.redeem(code, client);
      if (!result.ok) {
        this.bridge.log(`[mobile] ${client || '未知来源'} 验证码不正确`, 'warn');
        send(401, { ok: false, error: result.error });
        return;
      }
      this.bridge.log(`[mobile] ${client || '未知来源'} 已进入团队群`);
      send(200, { ok: true }, {
        'set-cookie': mobileCookie(result.token, Math.floor(MOBILE_SESSION_TTL_MS / 1000)),
      });
      return;
    }

    if (!authed) {
      send(401, { ok: false, error: '会话已过期，请重新输入验证码。' });
      return;
    }

    if (route === `${MOBILE_PATH}/state`) {
      if (request.method !== 'GET') {
        send(405, { ok: false, error: 'method not allowed' });
        return;
      }
      send(200, this.mobileState());
      return;
    }

    if (route !== `${MOBILE_PATH}/send` && route !== `${MOBILE_PATH}/approve`) {
      send(404, { ok: false, error: 'not found' });
      return;
    }
    if (request.method !== 'POST') {
      send(405, { ok: false, error: 'method not allowed' });
      return;
    }
    /*
     * 改状态的接口要求这个自定义头：跨站表单发不出自定义头，
     * 配合 `SameSite=Strict` 就挡住了「别的网页借你的浏览器指挥这台电脑」。
     */
    if (request.headers['x-hwchat-mobile'] !== '1') {
      send(403, { ok: false, error: '缺少请求头' });
      return;
    }
    const raw = await readBody(request);
    if (!raw) {
      send(413, { ok: false, error: 'body too large' });
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      send(400, { ok: false, error: 'invalid json' });
      return;
    }

    if (route === `${MOBILE_PATH}/send`) {
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      if (!text) {
        send(400, { ok: false, error: '内容为空' });
        return;
      }
      if (!this.bridge.onMobileMessage) {
        send(503, { ok: false, error: '本机还没准备好接收手机消息，请重试。' });
        return;
      }
      const result = await this.bridge.onMobileMessage(text.slice(0, 4_000));
      send(result.ok ? 200 : 409, result);
      return;
    }

    const id = typeof parsed.id === 'string' ? parsed.id : '';
    const allow = parsed.allow === true;
    if (!id) {
      send(400, { ok: false, error: '缺少审批号' });
      return;
    }
    if (!this.remoteApprovalEnabled()) {
      send(403, { ok: false, error: '这台电脑没有允许「手机批准授权」。' });
      return;
    }
    if (!this.resolveApproval(id, allow)) {
      send(409, { ok: false, error: '这张卡已经处理过了（或在电脑上已过期）。' });
      return;
    }
    this.bridge.log(`[mobile] 来自手机的授权：${allow ? '允许' : '拒绝'} ${id}`);
    send(200, { ok: true });
  }

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
      if (message.kind === 'group') {
        /*
         * 群消息：只记录与展示，**绝不触发对端重新开跑** —— 否则「解析」「结果」
         * 会互相激发，两个 agent 能聊到把额度烧光。需求本身（kind=requirement）
         * 才是唯一的执行触发器。
         */
        if (!this.group.some((item) => item.id === message.id)) {
          this.group = [...this.group, message].slice(-MAX_GROUP_MESSAGES);
          await this.persist();
          this.bridge.log(`[sync] 群消息：${renderGroupLine(message)}`);
          await this.bridge.onGroupMessage?.(message).catch(() => undefined);
          await this.refreshTranscript();
          /*
           * 甲方回答了乙方的追问 → 本机这一侧也要接着做。
           *
           * 这是「追问直到达成一致」能闭环的地方：不重新开一轮，甲方的话会被
           * 记录却没人接，两个 agent 就永远停在「等你回答」。
           */
          if (message.author === 'user' && message.phase === 'answer' && message.from.id !== this.bridge.peer().id) {
            const requirement = this.requirementById(message.requirementId);
            if (requirement && this.role !== 'off') {
              await this.bridge.runRequirement(requirement).catch(() => false);
            }
          }
        }
      } else if (message.kind === 'note') {
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

  /**
   * 在团队群里发言（本机 agent 或用户）。
   *
   * 与 `shareNote` 的区别：这是**群记录**，会写进 `docs/TEAM-CHAT.md` 并追加到对话里，
   * 而且**不会**触发对端开跑 —— 只有用户的需求（`shareRequirement`）才触发。
   */
  async postGroup(input: {
    author: 'user' | 'agent';
    phase: GroupPhase;
    body: string;
    requirementId?: string;
  }): Promise<{ ok: boolean; message: string; group?: SyncGroupMessage }> {
    /*
     * 关联需求：没指定就用最近的一条。
     *
     * 模型经常只写 `action=analysis` 而忘了带需求号 —— 让它自己再猜一次毫无价值，
     * 而「最近一条需求」在真实使用里几乎总是对的。
     */
    const requirementId = input.requirementId
      || this.requirements[this.requirements.length - 1]?.id
      || '';
    const group = makeGroupMessage(this.bridge.peer(), { ...input, requirementId });
    if (!group) return { ok: false, message: '群消息内容为空。' };
    this.group = [...this.group, group].slice(-MAX_GROUP_MESSAGES);
    await this.persist();
    await this.refreshTranscript();
    await this.bridge.onGroupMessage?.(group).catch(() => undefined);
    this.bridge.onState?.();
    if (this.role === 'off') return { ok: true, message: '已记入团队群（未启用局域网同步，没有发给队友）。', group };

    const payload = JSON.stringify({ protocol: SYNC_PROTOCOL_VERSION, code: this.code, message: group });
    if (this.role === 'hub') {
      const targets = this.peerList().filter((entry) => entry.address);
      await Promise.allSettled(targets.map((entry) => postRaw(entry.address, '/hwchat-sync/v1/deliver', payload)));
    } else {
      await this.postJson(this.hubAddress, '/hwchat-sync/v1/message', { code: this.code, message: group }).catch(() => undefined);
    }
    return { ok: true, message: '已发到团队群。', group };
  }

  /** 群里的最近发言（`team_sync status` 与面板用）。 */
  recentGroup(limit = 12): SyncGroupMessage[] {
    return this.group.slice(-Math.max(1, limit));
  }

  /**
   * 团队群窗口要显示的全部状态（一次取完，避免面板多次调用）。
   *
   * 面板据此渲染：成员、发言、以及「乙方正在等你回答」的那条追问 ——
   * 群窗口要做的事只有三件：看谁说了什么、回答追问、发新需求。
   */
  groupState(): {
    role: LanSyncRole;
    peers: SyncPeer[];
    messages: SyncGroupMessage[];
    openQuestion?: { requirementId: string; body: string };
  } {
    const questionId = this.openQuestionRequirement();
    const question = questionId
      ? [...this.group].reverse().find((message) => message.requirementId === questionId && message.phase === 'question')
      : undefined;
    return {
      role: this.role,
      peers: [this.bridge.peer(), ...this.peerList().map((entry) => entry.peer)],
      messages: this.group,
      ...(question && questionId
        ? { openQuestion: { requirementId: questionId, body: question.body } }
        : {}),
    };
  }

  /**
   * 当前有没有「乙方问了、甲方还没回答」的需求，返回它的需求号。
   *
   * 面板用它决定：甲方下一条消息是**回答追问**（并入同一条需求），
   * 还是一条**新需求**（新开一条、再广播给对端）。判错会让追问永远收不了尾。
   */
  openQuestionRequirement(): string | undefined {
    for (let index = this.requirements.length - 1; index >= 0; index -= 1) {
      const requirement = this.requirements[index]!;
      if (groupAgreement(this.group, requirement.id) === 'awaiting-user') return requirement.id;
    }
    return undefined;
  }

  /** 按需求号取需求（收到甲方回答时要重新交给本机 agent）。 */
  requirementById(id: string): SyncRequirement | undefined {
    return this.requirements.find((item) => item.id === id);
  }

  /**
   * 把群记录写进仓库。
   *
   * 与对齐账本分工：账本是**状态表**（谁做完没做完），群记录是**过程**（谁说了什么）。
   * 两者都进仓库，人和模型都能读。
   */
  private async refreshTranscript(): Promise<void> {
    if (!this.group.length) return;
    try {
      await this.bridge.writeTranscript(renderGroupTranscript(this.group));
    } catch (error) {
      this.bridge.log(`[sync] 写群记录失败：${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }

  /** 最近的协作消息（`team_sync` 的 status 与面板展示用）。 */  recentNotes(limit = 10): SyncNote[] {
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
    for (const id of [...this.approvals.keys()]) this.resolveApproval(id, false);
    this.gate.revokeAll();
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
