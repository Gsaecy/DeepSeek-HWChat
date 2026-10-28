/**
 * Skill 勾选：与「本地skill快捷调用」扩展的分工。
 *
 * 那个扩展维护一份**全局**清单（`~/.copilot/.skill-quick-launch.json` 的 `active`），
 * 表示「默认勾选哪些 Skill」。HWChat 只读它，而且只在**开新对话**时读一次，作为那条
 * 对话的初始勾选；此后在 HWChat 面板里的勾选 / 取消都只属于当前这条对话，不会改到
 * 那份全局清单。
 *
 * 为什么不是双向同步：两边想表达的东西不一样。全局清单是「以后新对话默认用哪些」，
 * 而对话里的一次取消通常是「这个任务用不上它」——把它写回全局，等于在一条对话里
 * 顺手改掉了以后所有对话的默认值，用户在另一个面板里会看到自己的默认配置被悄悄改了。
 *
 * 唯一写回共享文件的是 `lastUsed`（`withSharedLastUsed`）：那只是「这个技能最近被真正
 * 加载过」的记录，供那个扩展显示「已调用」角标，不影响任何勾选语义。
 *
 * 本文件只放**纯逻辑**（不 import vscode），方便单测。
 */

/** 「本地skill快捷调用」的扩展标识，用于判断是否安装了它。 */
export const QUICK_LAUNCH_EXTENSION_ID = 'honor-world.local-skill-quick-launch';

/** 扩展商店详情页：没装时从这里引导用户去装。 */
export const QUICK_LAUNCH_MARKETPLACE_URL =
  `https://marketplace.visualstudio.com/items?itemName=${QUICK_LAUNCH_EXTENSION_ID}`;

export interface SharedSkillState {
  /** 原始 JSON，写回 `lastUsed` 时原样保留其它字段（分类、自定义名称都归那个扩展所有）。 */
  raw: Record<string, unknown>;
  /** 全局勾选的技能名。 */
  active: string[];
  /** 用户手动取消的时间戳（那个扩展据此避免被会话记录自动勾回）。 */
  unchecked: Record<string, number>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把磁盘上的任意内容收敛成可用状态。
 *
 * 手改坏、被别的版本写进非字符串、整个文件是数组——都当成「没有勾选」，而不是抛错。
 * 读失败不该让整个 Skill 面板打不开。**注意这里只用于读**：勾选不再写回这个文件，
 * 所以「读到空」不会被反过来写成空清单。
 */
export function readSharedState(raw: unknown): SharedSkillState {
  const source = isPlainObject(raw) ? raw : {};
  const active = Array.isArray(source.active)
    ? [...new Set(source.active.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
    : [];
  const unchecked: Record<string, number> = {};
  if (isPlainObject(source.unchecked)) {
    for (const [name, value] of Object.entries(source.unchecked)) {
      if (typeof value === 'number' && Number.isFinite(value)) unchecked[name] = value;
    }
  }
  return { raw: source, active, unchecked };
}

/** 该技能是否在全局清单里被勾选（任分别名命中即算，兼容目录名与 frontmatter 名不一致）。 */
export function isSharedActive(active: readonly string[], names: readonly string[]): boolean {
  return names.some((name) => active.includes(name));
}

/**
 * 一条对话该用哪份勾选。
 *
 * - 这条对话**已经记过**自己的选择（用户在 HWChat 里勾过/取消过，或者发送过消息）→
 *   用它自己的，哪怕全局清单后来变了：对话内的改动只属于这条对话。
 * - 还没记过（新对话、旧存档没这个字段）→ 取「本地skill快捷调用」当前的全局勾选，
 *   这就是「新对话框默认读取扩展里的勾选状态」。
 *
 * 两种来源都做去重，且保留**全部** Skill（工作区来源的 Skill 不在那份全局清单里，
 * 但它们同样可以被对话单独勾选）。
 */
export function resolveSkillSelection(
  initialized: boolean | undefined,
  storedIds: readonly string[] | undefined,
  sharedActiveIds: readonly string[],
): string[] {
  const source = initialized ? storedIds ?? [] : sharedActiveIds;
  return [...new Set(source.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))];
}

/**
 * 读取失败是不是「文件根本不存在」。
 *
 * 这个区分决定成败：文件不存在属于首次使用，当成空状态新建是对的；而「存在但读不懂」
 * （内容损坏、另一个扩展正写到一半）**绝不能**当空状态——那会用一份只剩 `lastUsed`
 * 的文件覆盖掉对方的分类、自定义名称，一次误读清空用户攒的配置。
 *
 * 两个来源的错误码都要认：VS Code 的 `FileSystemError`（`FileNotFound` /
 * `EntryNotFound`）与 Node 的 `ENOENT`。
 */
export function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'FileNotFound' || code === 'EntryNotFound' || code === 'ENOENT';
}

/**
 * 只把「最近调用时间」并进原始状态，其它字段原样保留。
 *
 * `raw` 缺失（存在但读不懂）时返回 `undefined`：少记一次时间戳只是少一个角标，
 * 不值得拿对方整个配置去赌。`lastUsed` 里只留数字，脏值不往对方的文件里带。
 */
export function withSharedLastUsed(
  raw: Record<string, unknown> | undefined,
  names: readonly string[],
  now: number,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const lastUsed: Record<string, number> = {};
  const existing = raw.lastUsed;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [key, value] of Object.entries(existing as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) lastUsed[key] = value;
    }
  }
  for (const name of names) {
    const key = name?.trim();
    if (key) lastUsed[key] = now;
  }
  return { ...raw, lastUsed };
}

/**
 * 「本地skill快捷调用」用来指代一条 Skill 的名字：`frontmatter.name` → 目录名，**只这两级**。
 *
 * 那个扩展的 `parseSkillMd` 就是这么取名的，它不认得正文标题。而 HWChat 的显示名
 * 在缺 frontmatter 时会退回正文第一个标题——两者可能不同。写 `lastUsed` 时必须用
 * 它认得的名字，否则它算不出「已调用」角标。
 */
export function sharedSkillName(
  frontmatterName: string | undefined,
  directoryName: string | undefined,
): string | undefined {
  const fromFrontmatter = (frontmatterName ?? '').trim();
  if (fromFrontmatter) return fromFrontmatter;
  const fromDirectory = (directoryName ?? '').trim();
  return fromDirectory || undefined;
}
