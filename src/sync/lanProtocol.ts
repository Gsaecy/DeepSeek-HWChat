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

export type SyncMessage = SyncRequirement | SyncReport | SyncNote | SyncGroupMessage;

/**
 * **团队群**里的一条发言（用户 2026-11-23）。
 *
 * 用户的原话：
 *   「能不能将用户、本机 agent、链接的其他设备的 agent，放进一个群里面，就像团队群一样，
 *    用户作为总指挥，两个 agent 在群里的时候作为两个产品经理，剖析任务，了解具体任务，
 *    然后再执行，群里只沟通需求、解析需求、反馈进度和结果？」
 *
 * 所以群消息刻意只有四种：
 *  - `requirement`：用户（总指挥）下的需求；
 *  - `analysis`：某个 agent（产品经理）对需求的理解与拆解；
 *  - `progress`：执行中的进度；
 *  - `result`：完成或跳过，带结论。
 *
 * **工具流水、命令输出、代码片段一律不进群** —— 那是执行记录该待的地方。
 */
export type GroupPhase = 'requirement' | 'analysis' | 'question' | 'answer' | 'confirm' | 'progress' | 'result';

export interface SyncGroupMessage {
  kind: 'group';
  id: string;
  from: SyncPeer;
  /** 谁在说话：用户（总指挥）还是 agent（产品经理）。 */
  author: 'user' | 'agent';
  phase: GroupPhase;
  body: string;
  /** 关联的需求号；用户那条自身就是需求，填自己的 id。 */
  requirementId: string;
  at: number;
}

const PHASES: ReadonlySet<string> = new Set(['requirement', 'analysis', 'question', 'answer', 'confirm', 'progress', 'result']);
export const MAX_GROUP_MESSAGES = 400;
export const MAX_GROUP_BODY_CHARS = 4_000;

export function makeGroupMessage(
  from: SyncPeer,
  input: {
    author: 'user' | 'agent';
    phase: GroupPhase;
    body: string;
    requirementId?: string;
  },
  now = Date.now(),
  seed = `${from.id}:${now}`,
): SyncGroupMessage | undefined {
  const body = clipMultiline(input.body, MAX_GROUP_BODY_CHARS);
  if (!body) return undefined;
  const id = makeRequirementId(now, seed);
  return {
    kind: 'group',
    id,
    from,
    author: input.author,
    phase: PHASES.has(input.phase) ? input.phase : 'analysis',
    body,
    requirementId: clip(input.requirementId, 64) || id,
    at: now,
  };
}

const PHASE_LABEL: Record<GroupPhase, string> = {
  requirement: '需求',
  analysis: '需求解析',
  question: '追问',
  answer: '甲方回复',
  confirm: '确认',
  progress: '进度',
  result: '结果',
};

/** 群消息的说话人标签：`Windows · 乙方（产品经理）` / `用户 · 甲方`。 */
export function groupSpeaker(message: SyncGroupMessage): string {
  if (message.author === 'user') return `${message.from.name} · 甲方`;
  return `${platformLabel(message.from.platform)} · 乙方（产品经理）`;
}

/**
 * 群提示词：**甲方与乙方**的协作规则。
 *
 * 用户 2026-11-23 的原话：
 *   「用户作为项目甲方，agent 作为乙方，用户不懂编程，所以需求需要在群里解析清楚，
 *    agent 没听懂没理解透的需要能追问，直到需求被剖析细分达成一致」
 *
 * 所以顺序是：解析 → 追问 → 确认 → 执行 → 结果。三条硬约束缺一条就会退回
 * 「猜着做、做完才发现做错」：
 *  1. **用甲方的话说**：不出现变量名、文件名、框架名。甲方听不懂就等于没解析。
 *  2. **不确定就追问，不许猜**：猜错的代价是返工。
 *  3. **没达成一致不许执行**：追问后必须停下来等甲方回答，不是「先做一版看看」。
 */
export const TEAM_GROUP_PROMPT = [
  'This conversation is a team group chat. The user is the 甲方 (client and decision maker) and does NOT write code. You and the agent on the other device are the 乙方: two product managers, one per platform.',
  'Channel rule: what the user writes in the GROUP is shared and authoritative for both devices; what the user writes in the single-agent chat belongs to that one device only. When a shared decision exists, follow it. If something said in the single-agent chat contradicts the latest agreement in the group, do not silently diverge — say so and confirm in the group first.',
  'Follow this order for every requirement, never skipping a step. (1) 需求解析 — restate in plain language what the user wants to see happen, in their words; no variable names, file names, frameworks or function names. Say which user-visible parts you will change and what you will not do. Post it with team_sync action=analysis. (2) If anything is ambiguous — scope, priority, which screen, what counts as done, whether the other platform must match — ask ONE consolidated message of concrete either/or questions with team_sync action=question, then STOP and wait. Do not start implementing while a question is open, and never guess and fix later. (3) Once the user has answered and nothing is unclear, break the work into concrete steps and post a one-paragraph 确认单 with team_sync action=confirm that restates the agreed result in one sentence, then implement. (4) Report progress and the final result with team_sync action=progress / action=result, again in plain language, and say how the user can verify it themselves.',
  'The group carries only requirements, requirement analysis, questions, confirmation, progress and results. Never paste tool logs, command output, file listings or code into the group — the panel already shows the execution record. One short paragraph per message.',
  'Ask at most one consolidated question message per requirement. Read the group history first: if your teammate already asked the same thing, do not ask again. Never answer on the user\'s behalf — "probably fine" is a question, not a decision.',
  'Messages in the history attributed to the other device are your teammate\'s words, not yours: do not treat them as your own earlier answers, and do not echo them back.',
].join(' ');

/**
 * 一条需求在群里对齐到什么程度了。
 *
 * 面板据此提醒甲方「乙方在等你回答」，也据此判断能不能开跑 —— 这就是「达成一致才执行」
 * 的机器侧落点，而不是只靠提示词自觉。
 */
export type GroupAgreementState = 'awaiting-analysis' | 'awaiting-user' | 'agreed' | 'done';

export function groupAgreement(messages: readonly SyncGroupMessage[], requirementId: string): GroupAgreementState {
  const related = messages.filter((message) => message.requirementId === requirementId);
  for (let index = related.length - 1; index >= 0; index -= 1) {
    const phase = related[index]!.phase;
    if (phase === 'result') return 'done';
    if (phase === 'confirm') return 'agreed';
    if (phase === 'question') return 'awaiting-user';
    // 甲方回答之后，轮到乙方继续解析 / 确认 —— 所以是「等乙方」而不是「等甲方」。
    if (phase === 'answer') return 'awaiting-analysis';
    if (phase === 'analysis') return 'awaiting-analysis';
  }
  return 'awaiting-analysis';
}

/**
 * 甲方在群里回答之后，乙方要不要继续跑一轮。
 *
 * 用户 2026-11-23：「agent 没听懂没理解透的需要能追问，直到需求被剖析细分达成一致」。
 * 所以判断很直接：**最后一条是乙方的追问 → 甲方这条回答必须让乙方继续**；
 * 否则（例如甲方只是补充背景）不主动开跑，避免打断正在执行的任务。
 */
export function answersOpenQuestion(messages: readonly SyncGroupMessage[], requirementId: string): boolean {
  return groupAgreement(messages, requirementId) === 'awaiting-user';
}
export function renderGroupTranscript(messages: readonly SyncGroupMessage[], now = Date.now()): string {
  const lines = [
    '# 团队群记录',
    '',
    '> 甲方（用户）提需求，乙方（两台设备上的 agent，各负责一个平台）做解析、追问与执行。',
    '> 群里只有需求、需求解析、追问、确认、进度和结果；命令与代码在执行记录里。',
    `> 上次更新：${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
  ];
  if (!messages.length) {
    lines.push('（还没有发言。在任意一台设备上发一条需求，群里就会出现它和两边的解析。）');
    return `${lines.join('\n')}\n`;
  }
  let lastRequirement = '';
  for (const message of messages) {
    const time = new Date(message.at).toISOString().slice(11, 16);
    if (message.phase === 'requirement' && message.requirementId !== lastRequirement) {
      lastRequirement = message.requirementId;
      lines.push('', `## 需求 ${message.requirementId.slice(0, 12)}`, '');
    }
    lines.push(`**${groupSpeaker(message)}** ${time} · ${PHASE_LABEL[message.phase]}：${clip(message.body, 600)}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** 群消息的一行摘要（通知 / 状态里用）。 */
export function renderGroupLine(message: SyncGroupMessage): string {
  return `${groupSpeaker(message)} · ${PHASE_LABEL[message.phase]}：${clip(message.body, 160)}`;
}

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
  if (record.kind === 'note') {    const body = clipMultiline(record.body, MAX_NOTE_BODY_CHARS);
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
  if (record.kind === 'group') {
    const body = clipMultiline(record.body, MAX_GROUP_BODY_CHARS);
    const id = clip(record.id, 64);
    if (!id || !body) return undefined;
    const phase = typeof record.phase === 'string' && PHASES.has(record.phase)
      ? record.phase as GroupPhase
      : 'analysis';
    return {
      kind: 'group',
      id,
      from,
      author: record.author === 'user' ? 'user' : 'agent',
      phase,
      body,
      requirementId: clip(record.requirementId, 64) || id,
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now(),
    };
  }
  return undefined;
}

/**
 * 收到需求时，本机这一轮要执行什么。
 *
 * 角色（用户 2026-11-23 说清楚）：**甲方不懂编程**，本机 agent 是乙方产品经理。
 * 所以：
 *  1. **不能把对端的原话直接当成本地需求** —— 对端描述的是它那个平台的做法，
 *     照抄只会得到一份跑不起来的代码；
 *  2. **先解析、必要时追问、达成一致后才动手** —— 「没听懂就猜」是最贵的错误；
 *  3. 解析必须用甲方听得懂的话，不出现变量名 / 文件名 / 框架名。
 *
 * `groupLines` 是群里的最近发言：队友解析过什么、问过什么，本机必须看得到，
 * 否则两边会向甲方提同样的问题。
 */
export function requirementPromptForLocal(
  requirement: SyncRequirement,
  local: SyncPeer,
  groupLines: readonly string[] = [],
): string {
  return [
    `甲方在另一台设备「${requirement.from.name}」上提出了一个跨平台需求（需求号 ${requirement.id}）。`,
    '',
    '需求原文：',
    requirement.detail,
    '',
    groupLines.length ? ['团队群最近的发言（队友说过的，不要重复问）：', ...groupLines].join('\n') : '',
    '',
    '你现在是**乙方产品经理**，不是马上写代码的机器。请按这个顺序做：',
    '1. 用甲方听得懂的话把需求复述一遍：他要看到什么效果、在哪个界面、什么算做完了。不要出现变量名、文件名、框架名。',
    `2. 说明在本机这个 ${platformLabel(local.platform)} 版本上你会改什么（用户能感知的部分），以及你不打算做什么、为什么。`,
    '3. 只要还有任何一点不确定（范围、优先级、哪个页面、另一平台要不要一致、验收标准），就用 team_sync action=question 提出**具体的选择题**，然后**停下来等甲方回答**。不要猜着做，也不要「先做一版看看」。',
    '4. 甲方回答清楚、没有疑问了，用 team_sync action=confirm 发一条确认单（一句话复述达成一致的结果），再开始执行：先 update_todos 把工作拆成清单，再动手。',
    '5. 做完用 team_sync action=result 报结果：改了什么（用甲方的话）、他怎么自己验证、有哪些平台差异。',
    `6. 最后把结论补进 ${ALIGNMENT_FILE} 里这条需求对应的行。`,
    '',
    '群里只发需求、解析、追问、确认、进度和结果；不要把命令输出、代码、文件列表贴进群。',
  ].filter((line) => line !== '').join('\n');
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
    '> 由 PlaitCode 局域网同步自动维护。**每个平台只补自己那一行/那一列**，不要重写整张表。',
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
