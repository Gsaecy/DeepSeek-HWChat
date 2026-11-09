/**
 * webview → 扩展宿主的**入站消息**运行时校验。
 *
 * 为什么要它：`IncomingMessage` 这个联合类型只活在 TypeScript 里，编译后就没了。
 * `onDidReceiveMessage` 收到的是什么就当真是什么 —— 于是
 *  - 界面被注入脚本（依赖里有漏洞、`innerHTML` 漏了一处、注入了一条恶意消息）时，
 *    它可以发 `{ type: 'togglePin', pinned: 'false' }` 这种「类型对、形状错」的消息；
 *  - `{ type: 'attachClipboardFiles', files: null }` 直接让宿主在 `.map` 上抛错；
 *  - 未来新增的消息名写错了，宿主静默不响应，排查时看不出任何线索。
 *
 * 所以把「webview 视为可能已被攻破的一方」（架构评审 ⑫）落成一张**运行时**规格表：
 * 只认在这里登记过的类型，必填字段缺失或类型不对就整条丢弃并记一行日志。
 *
 * 规格表与 `chatPanel.ts` 里的联合类型是两份东西，靠 `src/test/incomingMessage.test.ts`
 * 对拍：联合类型里有的类型，规格表必须有；规格表里多出来的，测试也会报。少了这道
 * 对拍，两边迟早漂移（本项目已经因为「两份实现」踩过坑）。
 */

export type IncomingFieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'stringArray'
  | 'stringMap'
  | 'mode'
  | 'preset'
  | 'effort';

export interface IncomingMessageSpec {
  /** 必须存在，且类型必须完全匹配。 */
  required?: Record<string, IncomingFieldKind>;
  /** 可以不存在；存在时必须匹配（`undefined` / `null` 视为不存在）。 */
  optional?: Record<string, IncomingFieldKind>;
}

const MESSAGE_MODES: readonly string[] = ['chat', 'agent', 'plan'];
const PERMISSION_PRESETS: readonly string[] = ['askAll', 'review', 'autopilot', 'full'];
const REASONING_EFFORTS: readonly string[] = ['default', 'none', 'low', 'medium', 'high', 'max'];

/**
 * 每条消息的运行时规格。
 *
 * 只登记**被宿主真正读取**的字段：多校验一个用不到的字段，等于给以后加字段时
 * 埋一颗「界面加了、规格忘了、消息被悄悄丢掉」的雷。
 */
export const INCOMING_MESSAGE_SPECS: Record<string, IncomingMessageSpec> = {
  ready: {},
  layoutReport: { required: { report: 'object' } },
  newChat: {},
  selectConversation: { required: { id: 'string' } },
  continueConversation: { required: { id: 'string' } },
  detachConversationHistory: {},
  continueInNewChat: {},
  send: {
    required: { text: 'string' },
    optional: { mode: 'mode', skillIds: 'stringArray', permissionPreset: 'preset', agentMaxSteps: 'number', reasoningEffort: 'effort' },
  },
  sendWhileRunning: { required: { text: 'string' } },
  editTaskMessage: { required: { nodeId: 'string', text: 'string' } },
  beginEditTaskMessage: { required: { nodeId: 'string' } },
  cancelEditTaskMessage: { required: { nodeId: 'string' } },
  removeTaskMessage: { required: { nodeId: 'string' } },
  stop: {},
  resumeTodos: {},
  cancelTodos: {},
  approvalResponse: { required: { requestId: 'string', allow: 'boolean' } },
  decisionResponse: { required: { requestId: 'string', chosenIndex: 'number' } },
  deleteConversation: { required: { id: 'string' } },
  togglePin: { required: { id: 'string', pinned: 'boolean' } },
  renameConversation: { required: { title: 'string' }, optional: { id: 'string' } },
  toggleArchive: { required: { id: 'string', archived: 'boolean' } },
  showArchived: { required: { value: 'boolean' } },
  setModel: { required: { model: 'string' } },
  setProfile: { required: { profileId: 'string' } },
  refreshModels: { optional: { profileId: 'string' } },
  setMode: { required: { mode: 'mode' } },
  toggleSkill: { required: { skillId: 'string', enabled: 'boolean' } },
  installQuickLaunch: {},
  setPermissionPreset: { required: { permissionPreset: 'preset' } },
  setAgentMaxSteps: { required: { agentMaxSteps: 'number' } },
  setReasoningEffort: { required: { reasoningEffort: 'effort' } },
  setInternetReference: { required: { enabled: 'boolean' } },
  loadOlder: { required: { before: 'string' } },
  openSettings: {},
  removeContext: {},
  removeAttachment: { required: { index: 'number' } },
  openAttachment: { optional: { id: 'string', path: 'string' } },
  revealFile: { optional: { path: 'string', line: 'number', column: 'number' } },
  revealFileInExplorer: { optional: { path: 'string', line: 'number', column: 'number' } },
  openFileReference: { optional: { path: 'string', line: 'number', column: 'number' } },
  verifyFileReferences: { required: { requestId: 'string', items: 'array' } },
  attachFiles: {},
  attachMessageAttachment: { optional: { id: 'string', path: 'string' } },
  requestAttachmentData: { required: { requestId: 'string' }, optional: { id: 'string' } },
  resolveAttachmentSrc: { optional: { attachmentId: 'string' } },
  imageLoadFailed: { optional: { label: 'string', src: 'string' } },
  requestImageData: { required: { requestId: 'string', src: 'string' } },
  saveImageAs: { required: { src: 'string' } },
  openImage: { required: { src: 'string' } },
  attachClipboardFiles: { required: { files: 'array' } },
  copyText: { required: { text: 'string' }, optional: { requestId: 'string' } },
  readClipboardText: { required: { requestId: 'string' } },
  requestVoiceInput: {},
  exportConversation: {},
};

/**
 * 设置页的入站消息。
 *
 * 单独一张表，因为这一侧比对话框更敏感：`save` 会带着**明文 API Key**（`apiKeys`）
 * 一起进来，`clearLocalData` 会删本地存档。同样是「webview 可能已被攻破」的前提，
 * 形状不对就整条丢弃。
 *
 * `settings` 只校验「是个对象」：字段级白名单在设置面板自己的 `save()` 里按
 * `ChatSettings` 逐项取值，这里再抄一份必然漂移。
 */
export const SETTINGS_INCOMING_MESSAGE_SPECS: Record<string, IncomingMessageSpec> = {
  ready: {},
  save: {
    required: { settings: 'object' },
    optional: { apiKeys: 'stringMap', clearApiKeyIds: 'stringArray', embeddingApiKeys: 'stringMap', clearEmbeddingKeyIds: 'stringArray' },
  },
  test: { required: { settings: 'object' }, optional: { apiKey: 'string' } },
  testImage: { required: { settings: 'object' } },
  probeEmbeddings: { required: { settings: 'object' }, optional: { apiKeys: 'stringMap', embeddingApiKey: 'string' } },
  cleanup: {},
  exportAll: {},
  rescanSkills: {},
  openSkillFolder: {},
  clearLocalData: {},
  emptyTrash: {},
  restoreTrash: {},
  openNativeSettings: {},
};

/**
 * 原型链上的键：`specs['__proto__']` 会命中原型而不是规格表。
 * 结构化克隆一般造不出这些键，但这条检查只要一行，就别留口子。
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type IncomingValidation =
  | { ok: true; type: string }
  | { ok: false; reason: string };

/** 一份规格表 + 一个入口：两个 webview 各有各的消息集合，共用同一套校验逻辑。 */
function validateAgainst(specs: Record<string, IncomingMessageSpec>, raw: unknown): IncomingValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not an object' };
  }
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string' || type === '') {
    return { ok: false, reason: 'missing message type' };
  }
  // 用 `Object.hasOwn` 而不是直接取值：`toString`、`valueOf` 这类原型方法名
  // 会被 `specs[type]` 误命中。
  const spec = Object.hasOwn(specs, type) ? specs[type] : undefined;
  if (!spec) {
    return { ok: false, reason: `unknown message type: ${type}` };
  }
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) return { ok: false, reason: `forbidden key: ${key}` };
  }
  for (const [field, kind] of Object.entries(spec.required ?? {})) {
    if (!Object.hasOwn(record, field)) return { ok: false, reason: `${type}: missing ${field}` };
    if (!kindMatches(kind, record[field])) return { ok: false, reason: `${type}: bad ${field}` };
  }
  for (const [field, kind] of Object.entries(spec.optional ?? {})) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    if (!kindMatches(kind, value)) return { ok: false, reason: `${type}: bad ${field}` };
  }
  return { ok: true, type };
}

function kindMatches(kind: IncomingFieldKind, value: unknown): boolean {
  switch (kind) {
    case 'string': return typeof value === 'string';
    // `NaN` / `Infinity` 不是「数字字段」的合理取值，一律不认。
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'stringArray': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    // `Record<string, string>`：键值都必须是字符串，且必须是普通对象（不是数组 / null / Map）。
    case 'stringMap': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      return Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string');
    }
    case 'mode': return typeof value === 'string' && MESSAGE_MODES.includes(value);
    case 'preset': return typeof value === 'string' && PERMISSION_PRESETS.includes(value);
    case 'effort': return typeof value === 'string' && REASONING_EFFORTS.includes(value);
    default: return false;
  }
}

/**
 * 校验一条对话面板的入站消息。
 *
 * 只回答「形状对不对」，不回答「该不该答应」：权限判断在各自的处理函数里。
 * 这里放行的消息仍然要走完整的授权链路。
 */
export function validateIncomingMessage(raw: unknown): IncomingValidation {
  return validateAgainst(INCOMING_MESSAGE_SPECS, raw);
}

/** 校验一条设置页的入站消息（同一套逻辑，另一份规格表）。 */
export function validateSettingsIncomingMessage(raw: unknown): IncomingValidation {
  return validateAgainst(SETTINGS_INCOMING_MESSAGE_SPECS, raw);
}
