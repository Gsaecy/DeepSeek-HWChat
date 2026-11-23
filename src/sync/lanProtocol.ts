/**
 * 局域网跨平台对齐：协议与账本的**纯逻辑**（不 import vscode，可直接单测）。
 *
 * 用户的原话（2026-11-23）：
 *   「我经常开发多端 app，比如一个 app 的 Windows 版本和 macOS 版本，但是经常两边
 *    功能对不齐，甚至有差别，没法很好的统一……让同一个 WiFi 下两个设备能在开发一个
 *    项目的不同系统版本的时候，能交流对齐」
 *   「我只需要在一个设备上发起更新功能需求，两边能一起执行更新任务」
 *
 * 这个模块解决的是**一个需求在两个平台上各做一遍、并且能核对做没做齐**：
 *  - 需求（requirement）：在一台设备上写下要做什么，广播给对端；
 *  - 报告（report）：每台设备做完 / 跳过时回一条，带文件清单与理由；
 *  - 账本（ledger）：把两者渲染成一张「需求 × 平台」的对照表，写进仓库；
 *  - 分歧（divergence）：一边做完、另一边跳过或没做 —— 这才是用户真正怕的东西。
 *
 * 所有网络输入都当作不可信数据：`parseSyncMessage` 做形状校验与长度截断。
 */

export const SYNC_PROTOCOL_VERSION = 1;
/** 单条消息上限（字节）：需求正文最多几千字，这个值足够，同时挡住畸形转发。 */
export const MAX_MESSAGE_BYTES = 80 * 1024;
export const MAX_DETAIL_CHARS = 8_000;
export const MAX_TITLE_CHARS = 120;
export const MAX_SUMMARY_CHARS = 400;
export const MAX_NOTE_CHARS = 800;
export const MAX_FILES = 60;
export const MAX_RECORDS = 300;
export const MAX_PEERS = 8;
/** 协作消息的正文上限：它是聊天，不是文档，太长会挤占对话上下文。 */
export const MAX_NOTE_BODY_CHARS = 2_000;
export const MAX_TOPIC_CHARS = 60;
/** 协作消息在本地保留多少条（用于面板回看与 `team_sync` 的 status）。 */
export const MAX_NOTES = 120;
export const ALIGNMENT_FILE = 'docs/PLATFORM-ALIGNMENT.md';

export type SyncPlatform = 'win32' | 'darwin' | 'linux';

/** 一台参与协作的设备。 */
export interface SyncPeer {
  /** 稳定标识：同一台设备每次都是同一个值。 */
  id: string;
  /** 给人看的名字，例如「MacBook · macOS」。 */
  name: string;
  platform: SyncPlatform;
  /** 参与协作的项目目录名（同一个 app 的两个版本各有一个）。 */
  project: string;
  /** 扩展版本，便于排查「两边行为不一致是不是版本不同」。 */
  version: string;
}

export type ReportStatus = 'planned' | 'in_progress' | 'done' | 'skipped';

/** 一条跨平台需求。 */
export interface SyncRequirement {
  kind: 'requirement';
  /** 需求 id：两端用它对齐，由发起方生成且稳定。 */
  id: string;
  from: SyncPeer;
  title: string;
  detail: string;
  createdAt: number;
}

/** 一条进度报告。 */
export interface SyncReport {
  kind: 'report';
  requirementId: string;
  from: SyncPeer;
  status: ReportStatus;
  summary: string;
  files: string[];
  /** 平台差异、跳过原因等；跨平台对齐最关键的一段文字。 */
  note: string;
  at: number;
}

/**
 * 一条**协作消息**：两边 agent 之间的对话，不是需求、也不是进度报告。
 *
 * 用户的原话（2026-11-23 补充）：
 *   「甚至两边设备的 agent 可以像一个团队的同事一样沟通交流项目的情况，互通有无」
 *
 * 所以它刻意比需求更轻、更像聊天：一句问题、一段发现、一个决定。
 * `replyTo` 指向被回答的那条消息，用来串成线程，也用来**防住两个 agent 互相客套**。
 */
export interface SyncNote {
  kind: 'note';
  id: string;
  from: SyncPeer;
  /** 主题（可选）：同一件事的往来消息用同一个主题，便于在面板上归组。 */
  topic: string;
  body: string;
  /** 回答哪一条；空串表示这是一条新的发起消息。 */
  replyTo: string;
  at: number;
}

export type SyncMessage = SyncRequirement | SyncReport | SyncNote;

const STATUSES: ReadonlySet<string> = new Set(['planned', 'in_progress', 'done', 'skipped']);
const PLATFORMS: ReadonlySet<string> = new Set(['win32', 'darwin', 'linux']);

/** 压成单行并截断：账本是表格，换行会把整张表拆坏。 */
export function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** 保留换行的截断（需求正文用：多行要点是合理的）。 */
export function clipMultiline(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\r\n?/g, '\n').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function isSyncPlatform(value: unknown): value is SyncPlatform {
  return typeof value === 'string' && PLATFORMS.has(value);
}

export function platformLabel(platform: SyncPlatform): string {
  switch (platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    default: return 'Linux';
  }
}

/**
 * 需求 id。
 *
 * 用「时间 + 种子哈希」而不是自增序号：两台设备可能同时发起，序号会撞车，
 * 而撞车意味着两边的报告被算到同一条需求上。
 */
export function makeRequirementId(now: number, seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 0x1_0000_0000;
  return `r${now.toString(36)}${hash.toString(36).padStart(4, '0').slice(0, 6)}`;
}

export function makeRequirement(from: SyncPeer, text: string, now = Date.now(), seed = from.id): SyncRequirement | undefined {
  const detail = clipMultiline(text, MAX_DETAIL_CHARS);
  if (!detail) return undefined;
  return {
    kind: 'requirement',
    id: makeRequirementId(now, seed),
    from,
    title: clip(detail.split('\n')[0] ?? detail, MAX_TITLE_CHARS),
    detail,
    createdAt: now,
  };
}

export function makeReport(
  from: SyncPeer,
  input: { requirementId: string; status: ReportStatus; summary?: string; files?: string[]; note?: string },
  now = Date.now(),
): SyncReport {
  return {
    kind: 'report',
    requirementId: clip(input.requirementId, 64) || 'unknown',
    from,
    status: STATUSES.has(input.status) ? input.status : 'planned',
    summary: clip(input.summary, MAX_SUMMARY_CHARS),
    files: (input.files ?? []).map((file) => clip(file, 200)).filter(Boolean).slice(0, MAX_FILES),
    note: clip(input.note, MAX_NOTE_CHARS),
    at: now,
  };
}

export function makeNote(
  from: SyncPeer,
  input: { body: string; topic?: string; replyTo?: string },
  now = Date.now(),
  seed = `${from.id}:${now}`,
): SyncNote | undefined {
  const body = clipMultiline(input.body, MAX_NOTE_BODY_CHARS);
  if (!body) return undefined;
  return {
    kind: 'note',
    id: makeRequirementId(now, seed),
    from,
    topic: clip(input.topic, MAX_TOPIC_CHARS),
    body,
    replyTo: clip(input.replyTo, 64),
    at: now,
  };
}

/**
 * 对端发来的协作消息，本机这一轮该怎么处理。
 *
 * 与需求的关键区别：**它可能只需要读、不需要动手**。同事说「我这边把窗口标题栏
 * 改成了自绘」，正确反应是记下来并在下次改对应地方时保持一致性 —— 而不是立刻
 * 大改一遍自己的仓库。所以提示词里明确「先判断要不要动，不要为了回应而改代码」。
 */
export function notePromptForLocal(note: SyncNote, local: SyncPeer): string {
  return [
    `队友消息（来自「${note.from.name}」的 ${platformLabel(note.from.platform)} 版本${note.topic ? `，主题：${note.topic}` : ''}）：`,
    '',
    note.body,
    '',
    '处理方式：',
    '1. 先判断这条消息**是否需要在本机动手**。只是同步进展 / 说明决定时，记下来即可，不要为了回应而改代码。',
    `2. 需要动手时，按本机这个 ${platformLabel(local.platform)} 项目的情况做等价改动，并在回复里说清改了什么。`,
    `3. 需要把结论告诉队友（对方问了问题、或本端发现了会影响另一边的情况）时，调用 team_sync 的 send 发回一条简短消息，replyTo 填 ${note.id}；不需要回就不要发，不要发「收到」「好的」这类空消息。`,
  ].join('\n');
}

/**
 * 这条协作消息要不要**自动**让对端 agent 跑一轮。
 *
 * 防的是两个 agent 互相客套直到烧完额度：只回应「明确在问问题」或「明确要求对方
 * 处理」的消息；回复（`replyTo` 非空）不触发自动回复，除非正文里真的有问号或
 * 明确的请求动词 —— 也就是「一问一答」最多再走一步，不会无限接龙。
 */
export function shouldAutoRespond(note: SyncNote): boolean {
  const body = note.body.trim();
  if (!body) return false;
  const asksSomething = /[?？]/.test(body)
    || /(?:请|麻烦|能否|是否|需要你|帮我确认|同步一下)/.test(body)
    || /\b(?:please|could you|can you|do you|would you|need you|confirm|check)\b/i.test(body);
  if (!note.replyTo) return asksSomething;
  // 已经是回复：只有对方又问了一个新问题才继续，避免「收到→不客气」接龙。
  return asksSomething;
}

/** 协作消息的本地展示（面板 / `team_sync status` / 日志共用）。 */
export function renderNotes(notes: readonly SyncNote[], limit = 10): string[] {
  return notes.slice(-Math.max(1, limit)).map((note) => {
    const time = new Date(note.at).toISOString().slice(5, 16).replace('T', ' ');
    const reply = note.replyTo ? ` (回复 ${note.replyTo})` : '';
    return `[${time}] ${note.from.name}${note.topic ? ` · ${note.topic}` : ''}${reply}：${clip(note.body, 300)}`;
  });
}

function normalizePeer(value: unknown): SyncPeer | undefined {  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = clip(record.id, 64);
  if (!id) return undefined;
  return {
    id,
    name: clip(record.name, 60) || id,
    platform: isSyncPlatform(record.platform) ? record.platform : 'linux',
    project: clip(record.project, 80),
    version: clip(record.version, 20),
  };
}

/**
 * 解析并校验一条网络消息。
 *
 * 返回 `undefined` 表示「不是我们认识的形状」，调用方静默丢弃 —— 同一个 WiFi 上
 * 可能有别的设备在探测这个端口，报错没有价值，只会刷日志。
 */
export function parseSyncMessage(raw: unknown): SyncMessage | undefined {
  let value = raw;
  if (typeof raw === 'string') {
    // 先卡长度：`JSON.parse` 在几十 MB 的字符串上会直接吃满 CPU。
    if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) return undefined;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const from = normalizePeer(record.from);
  if (!from) return undefined;
  if (record.kind === 'requirement') {
    const detail = clipMultiline(record.detail, MAX_DETAIL_CHARS);
    const id = clip(record.id, 64);
    if (!id || !detail) return undefined;
    return {
      kind: 'requirement',
      id,
      from,
      title: clip(record.title, MAX_TITLE_CHARS) || clip(detail.split('\n')[0] ?? detail, MAX_TITLE_CHARS),
      detail,
      createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    };
  }
  if (record.kind === 'report') {    const requirementId = clip(record.requirementId, 64);
    if (!requirementId) return undefined;
    const status = typeof record.status === 'string' && STATUSES.has(record.status)
      ? record.status as ReportStatus
      : 'planned';
    const files = Array.isArray(record.files)
      ? record.files.map((item) => clip(item, 200)).filter(Boolean).slice(0, MAX_FILES)
      : [];
    return {
      kind: 'report',
      requirementId,
      from,
      status,
      summary: clip(record.summary, MAX_SUMMARY_CHARS),
      files,
      note: clip(record.note, MAX_NOTE_CHARS),
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now(),
    };
  }
  if (record.kind === 'note') {
    const body = clipMultiline(record.body, MAX_NOTE_BODY_CHARS);
    const id = clip(record.id, 64);
    if (!id || !body) return undefined;
    return {
      kind: 'note',
      id,
      from,
      topic: clip(record.topic, MAX_TOPIC_CHARS),
      body,
      replyTo: clip(record.replyTo, 64),
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now(),
    };
  }
  return undefined;
}

/**
 * 收到需求时，本机这一轮要执行什么。
 *
 * 关键点：**不能把对端的原话直接当成本地需求**。对端描述的是它那个平台的做法
 * （「在 Windows 上注册托盘图标」），直接照做只会得到一份跑不起来的代码。
 * 所以明确三件事：这是同一个功能的另一端、按本地平台实现等价能力、做完把差异报回来。
 */
export function requirementPromptForLocal(requirement: SyncRequirement, local: SyncPeer): string {
  return [
    `跨平台对齐需求（来自另一台设备「${requirement.from.name}」的 ${platformLabel(requirement.from.platform)} 版本，需求号 ${requirement.id}）。`,
    '',
    '原需求原文：',
    requirement.detail,
    '',
    '要求：',
    `1. 在**本机这个 ${platformLabel(local.platform)} 项目**里实现**等价**的功能，不要照抄另一端的平台专有做法；平台确实做不到的部分，说明原因而不是硬凑。`,
    '2. 动手前先用 update_todos 给出本地的任务清单；完成后核对清单，未完成项不要打勾。',
    `3. 结束时把「本端改了什么、有哪些平台差异」补进 ${ALIGNMENT_FILE} 里这条需求对应的行。`,
  ].join('\n');
}

export interface LedgerRow {
  requirement: SyncRequirement;
  /** 平台 → 该平台最新一条报告。 */
  reports: Partial<Record<SyncPlatform, SyncReport>>;
}

/**
 * 把需求与报告合并成「需求 × 平台」的行。
 *
 * 同一需求、同一平台的多条报告只留**最新一条**：模型一轮里可能先报 planned
 * 再报 done，账本要的是最终状态，不是流水账。
 */
export function buildLedger(requirements: readonly SyncRequirement[], reports: readonly SyncReport[]): LedgerRow[] {
  const byId = new Map<string, LedgerRow>();
  for (const requirement of requirements) {
    if (!byId.has(requirement.id)) byId.set(requirement.id, { requirement, reports: {} });
  }
  const latest = new Map<string, SyncReport>();
  for (const report of reports) {
    const key = `${report.requirementId}\u0000${report.from.platform}`;
    const previous = latest.get(key);
    if (!previous || report.at >= previous.at) latest.set(key, report);
  }
  for (const report of latest.values()) {
    const row = byId.get(report.requirementId);
    if (row) row.reports[report.from.platform] = report;
  }
  return [...byId.values()]
    .sort((left, right) => right.requirement.createdAt - left.requirement.createdAt)
    .slice(0, MAX_RECORDS);
}

/** 一个需求里「做完了却没对齐」的平台组合。 */
export interface Divergence {
  requirement: SyncRequirement;
  doneOn: SyncPlatform[];
  missingOn: SyncPlatform[];
  skippedOn: SyncPlatform[];
  /** 跳过原因（来自报告 note），用来解释「为什么这边没有」。 */
  skippedNotes: string[];
}

/**
 * 找出没对齐的需求。
 *
 * 判定只看**确凿的事实**：至少一个平台 `done`，同时有另一个平台 `skipped`。
 *
 * 为什么不把「另一端没有报告」也算成分歧：没报告的成因太多（对端还没加入、
 * 刚连上还没跑、用户根本没启动那台机器），把它算进去会让账本天天报警，
 * 用户很快就会忽略这个提示。没有报告在表格里显示为「—」，同样看得见；
 * 而 `skipped` 是对方**明确写下理由**的结论 —— 那才是真正的「两边不一样」。
 */
export function findDivergences(rows: readonly LedgerRow[]): Divergence[] {
  const platforms: SyncPlatform[] = ['win32', 'darwin', 'linux'];
  const result: Divergence[] = [];
  for (const row of rows) {
    const doneOn = platforms.filter((platform) => row.reports[platform]?.status === 'done');
    const skippedOn = platforms.filter((platform) => row.reports[platform]?.status === 'skipped');
    if (!doneOn.length || !skippedOn.length) continue;
    const missingOn = platforms.filter((platform) => !row.reports[platform]);
    result.push({
      requirement: row.requirement,
      doneOn,
      missingOn,
      skippedOn,
      skippedNotes: skippedOn
        .map((platform) => row.reports[platform]?.note ?? '')
        .filter(Boolean),
    });
  }
  return result;
}

const STATUS_LABEL: Record<ReportStatus, string> = {
  planned: '计划中',
  in_progress: '进行中',
  done: '已完成',
  skipped: '已跳过',
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** 渲染账本（写进仓库的那份 Markdown）。 */
export function renderLedger(rows: readonly LedgerRow[], now = Date.now()): string {
  const divergences = findDivergences(rows);
  const lines = [
    '# 跨平台对齐账本',
    '',
    '> 由 HWChat 局域网同步自动维护。**每个平台只补自己那一行/那一列**，不要重写整张表。',
    `> 上次更新：${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
  ];
  if (!rows.length) {
    lines.push('（还没有跨平台需求。在一台设备上发起需求后，这里会出现记录。）');
    return `${lines.join('\n')}\n`;
  }
  lines.push('## 需求对照', '', '| 需求 | 发起 | Windows | macOS | Linux | 最近更新 |', '|---|---|---|---|---|---|');
  for (const row of rows) {
    const cell = (platform: SyncPlatform): string => {
      const report = row.reports[platform];
      if (!report) return '—';
      const detail = report.summary || report.note;
      return detail ? `${STATUS_LABEL[report.status]}：${detail}` : STATUS_LABEL[report.status];
    };
    const updated = Math.max(
      row.requirement.createdAt,
      ...Object.values(row.reports).map((report) => report?.at ?? 0),
    );
    lines.push(
      `| ${escapeCell(row.requirement.title)} | ${platformLabel(row.requirement.from.platform)} `
      + `| ${escapeCell(cell('win32'))} | ${escapeCell(cell('darwin'))} | ${escapeCell(cell('linux'))} `
      + `| ${new Date(updated).toISOString().slice(5, 16).replace('T', ' ')} |`,
    );
  }
  if (divergences.length) {
    lines.push('', '## 需要对齐的差异', '');
    for (const divergence of divergences) {
      const done = divergence.doneOn.map(platformLabel).join('、');
      const problem = [
        divergence.skippedOn.length ? `${divergence.skippedOn.map(platformLabel).join('、')} 已跳过` : '',
        divergence.missingOn.length ? `${divergence.missingOn.map(platformLabel).join('、')} 没有报告` : '',
      ].filter(Boolean).join('；');
      const reason = divergence.skippedNotes.length ? ` 原因：${divergence.skippedNotes.join('；')}` : '';
      lines.push(`- **${divergence.requirement.title}**：${done} 已完成，但 ${problem}。${reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 一条报告的人话摘要（发到通知/日志里）。 */
export function renderReportSummary(report: SyncReport, requirementTitle: string): string {
  const parts = [`${platformLabel(report.from.platform)} · ${STATUS_LABEL[report.status]}`, requirementTitle];
  if (report.summary) parts.push(report.summary);
  return parts.filter(Boolean).join(' · ');
}

/**
 * 配对码比对。
 *
 * 用**长度无关的逐字符累加**而不是 `===`：字符串比较在第一个不同字符处就会返回，
 * 时间差可以被用来逐位猜配对码。局域网场景风险不高，但这是便宜的正确做法。
 */
export function pairingMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !expected) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

/** 生成一个给人念得出来的配对码（去掉容易混淆的 0/O/1/I）。 */
export function generatePairingCode(random: (bytes: number) => Buffer): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = random(8);
  let code = '';
  for (let index = 0; index < 8; index += 1) {
    code += alphabet[bytes[index]! % alphabet.length];
    if (index === 3) code += '-';
  }
  return code;
}

/** 协作状态的一句话描述（状态栏 / 提示框共用）。 */
export function describeSyncState(input: {
  role: 'off' | 'hub' | 'peer';
  peers: number;
  requirements: number;
  divergences: number;
  address?: string;
}): string {
  if (input.role === 'off') return '局域网同步：未启用';
  const role = input.role === 'hub' ? `主机 ${input.address ?? ''}`.trim() : '已加入主机';
  return `局域网同步：${role} · ${input.peers} 台设备 · ${input.requirements} 条需求 · ${input.divergences} 处待对齐`;
}
