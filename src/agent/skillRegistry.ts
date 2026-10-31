import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import {
  ConversationMode,
  SkillSummary,
  SkillUsage,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from '../core/types';
import { tt } from '../core/i18n';
import { searchWorkspace } from './workspaceSearch';
import {
  QUICK_LAUNCH_EXTENSION_ID,
  isMissingFileError,
  readSharedState,
  sharedSkillName,
  withSharedLastUsed,
} from '../core/skillSelection';

interface SkillRecord extends SkillSummary {
  uri: vscode.Uri;
  content: string;
  /** `USE FOR:` 那段（独立于 description，避免被 240 字符截断吃掉）。 */
  useFor: string;
  /** 触发词（`Triggers:` 段落或 frontmatter 的 `triggers:`）。 */
  triggers: string[];
  quickLaunchName?: string;
  /**
   * 共享清单里用来指代这条 Skill 的名字。
   *
   * 「本地skill快捷调用」的命名规则是 `frontmatter.name` → 目录名，**没有「标题」这一级**；
   * 而 HWChat 显示用的 `name` 在缺 frontmatter 时会退回正文标题。两者可能不同，
   * 若按显示名往共享文件里写，那个扩展的面板就会认为「没勾选」——勾选框看着同步，
   * 实际各说各话。所以写回一律用这个字段。
   */
  sharedName?: string;
}

interface QuickLaunchState {
  raw: Record<string, unknown>;
  active: Set<string>;
  lastUsed: Record<string, number>;
}

export interface PreparedSkillContext {
  prompt: string;
  preloaded: SkillUsage[];
  routableIds: string[];
  bytes: number;
}

const WORKSPACE_PATTERNS = [
  '.hwchat/skills/*.md',
  '.agents/skills/**/SKILL.md',
  '.claude/skills/**/SKILL.md',
];
const MAX_SKILL_BYTES = 160 * 1024;
const MAX_ENABLED_BYTES = 320 * 1024;

/**
 * 两次真实扫描之间的最短间隔。
 *
 * 30 秒足够让「刚在磁盘上加了技能」在下次打开/发送时被看到，同时把一次操作链里
 * 十几次状态重发合并成最多一次扫描。显式「重新扫描」与 watcher 会绕过它。
 */
export const SKILL_REFRESH_TTL_MS = 30_000;

export class SkillRegistry implements vscode.Disposable {
  private readonly records = new Map<string, SkillRecord>();
  private readonly watcherDisposables: vscode.Disposable[] = [];
  /**
   * 共享勾选文件被改写时触发（用户在「本地skill快捷调用」面板里打勾、它自己的
   * 自动勾选、或我们写入）：面板据此重画勾选框，不必手动刷新。
   */
  readonly onDidChangeSharedState = new vscode.EventEmitter<void>();

  constructor(
    private readonly userSkillRoot: vscode.Uri,
    private readonly copilotSkillRoot = vscode.Uri.file(join(homedir(), '.copilot', 'skills')),
    private readonly quickLaunchStateFile = vscode.Uri.file(join(homedir(), '.copilot', '.skill-quick-launch.json')),
  ) {
    for (const pattern of WORKSPACE_PATTERNS) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      // 一次保存常常连着 create/change 多个事件；合并成一次刷新，
      // 否则「保存一个 skill」就是三倍的文件扫描。
      watcher.onDidCreate(() => this.scheduleRefresh(), undefined, this.watcherDisposables);
      watcher.onDidChange(() => this.scheduleRefresh(), undefined, this.watcherDisposables);
      watcher.onDidDelete(() => this.scheduleRefresh(), undefined, this.watcherDisposables);
      this.watcherDisposables.push(watcher);
    }
    // 共享勾选文件在用户主目录下、不在工作区里，所以用 RelativePattern 直接盯住它。
    const stateWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      vscode.Uri.file(dirname(this.quickLaunchStateFile.fsPath)),
      basename(this.quickLaunchStateFile.fsPath),
    ));
    const reload = (): void => {
      void this.refresh({ force: true })
        .then(() => this.onDidChangeSharedState.fire())
        .catch(() => undefined);
    };
    stateWatcher.onDidCreate(reload, undefined, this.watcherDisposables);
    stateWatcher.onDidChange(reload, undefined, this.watcherDisposables);
    stateWatcher.onDidDelete(reload, undefined, this.watcherDisposables);
    this.watcherDisposables.push(stateWatcher);
  }

  private refreshTimer: NodeJS.Timeout | undefined;
  private inFlightRefresh: Promise<SkillSummary[]> | undefined;
  private lastRefreshAt = 0;

  /** 合并短时间内的多次 watcher 事件，避免一次保存触发多轮扫描。 */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      // 文件真的变了：必须绕过新鲜窗口，否则这次保存要等窗口过期才可见。
      void this.refresh({ force: true }).catch(() => undefined);
    }, 250);
    this.refreshTimer.unref?.();
  }

  /**
   * 重新扫描技能清单。
   *
   * 为什么要有「新鲜窗口」和 single-flight（真实故障）：面板每次重发状态
   * （`ChatPanel.sendState`）都会调到这里，而一次扫描 = 三条 `findFiles`
   * pattern，每条都会在 VS Code 里拉起一次 ripgrep 全工作区遍历，外加逐个
   * 读取 `SKILL.md`。一次操作链里状态会重发十几遍，等于几十次全工作区扫描，
   * 大型工作区上 CPU 与进程数都会被吃满（`spawn rg EAGAIN` 的来源之一）。
   *
   * 现在：窗口内直接复用上一次结果；并发调用共享同一次扫描。文件变化由
   * watcher（`force`）、显式「重新扫描」命令、以及新建/切换对话触发。
   *
   * **这个函数永不 reject**（真实故障）。扫描会走统一搜索调度层，而调度层在
   * 队列满时会抛 `SearchQueueFullError`（用户刚跑完一堆 Agent 任务时非常容易触发）。
   * 以前 `refresh()` 直接把这个错误抛给调用方，而「新建对话」「打开对话」「激活」
   * 都在 `await` 它 —— 于是**搜索队列一满，点新建对话就毫无反应**，只能重载窗口。
   * 一份「可能稍旧」的技能清单永远比一个点不动的按钮好，所以这里把错误收住：
   * 保留上一次的清单，把原因交给 `onError` 记录。
   */
  async refresh(options: { force?: boolean } = {}): Promise<SkillSummary[]> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    if (!options.force && this.lastRefreshAt && Date.now() - this.lastRefreshAt < SKILL_REFRESH_TTL_MS) {
      return this.list();
    }
    const running = this.scan()
      .then((summaries) => {
        this.lastRefreshAt = Date.now();
        return summaries;
      }, (error: unknown) => {
        // 不更新 lastRefreshAt：下次调用会立刻重试，而不是把一个坏结果缓存 30 秒。
        this.onError?.(error);
        return this.list();
      })
      .finally(() => {
        this.inFlightRefresh = undefined;
      });
    this.inFlightRefresh = running;
    return running;
  }

  /** 扫描失败时的上报口（只用于日志；不影响返回的清单）。 */
  onError: ((error: unknown) => void) | undefined;

  private async scan(): Promise<SkillSummary[]> {
    /**
     * 没装「本地skill快捷调用」时**不读**它的状态文件。
     *
     * 真实故障：用户卸载了那个扩展，但 `~/.copilot/.skill-quick-launch.json` 还在
     * （卸载扩展不会删它，本机残留着 35 个 active）。旧实现照样读，于是 HWChat 把
     * 每个技能标成「默认启用」并自动勾选 —— 用户看到的就是「扩展都卸了，怎么还有
     * 一堆勾选」，以为是扩展残留。它确实是残留，但**不该由 HWChat 来读**。
     *
     * 现在：没装就当成「没有全局勾选」，一切从空白开始，等用户重新装上再对接。
     * 技能本身仍会从 `~/.copilot/skills/` 扫出来（那是 Copilot 的技能目录，
     * 不随扩展安装/卸载变化），只是不再被这份无主的状态文件影响。
     */
    const installed = this.quickLaunchInstalled();
    const quickState: QuickLaunchState = installed
      ? await this.readQuickLaunchState()
      : { raw: {}, active: new Set<string>(), lastUsed: {} };
    const candidates: Array<{
      uri: vscode.Uri;
      source: SkillSummary['source'];
      relativePath: string;
      quickLaunchName?: string;
    }> = [];
    for (const pattern of WORKSPACE_PATTERNS) {
      // 走统一搜索调度层：一次保存会触发多个 watcher 事件，旧实现每次都直接
      // findFiles（= 每次拉起 rg），三条 pattern 就是三次。
      const found = await searchWorkspace({ include: pattern, limit: 200, operation: 'skill_registry' });
      for (const uri of found.outcome.files) {
        candidates.push({
          uri,
          source: 'workspace',
          relativePath: vscode.workspace.asRelativePath(uri, false),
        });
      }
    }
    await this.addFlatMarkdownSkills(candidates);
    await this.addCopilotSkills(candidates);

    const next = new Map<string, SkillRecord>();
    for (const candidate of deduplicate(candidates)) {
      const record = await this.readSkill(candidate).catch(() => undefined);
      if (!record) continue;
      if (record.source === 'copilot') {
        const aliases = [record.sharedName, record.quickLaunchName, record.name]
          .filter((value): value is string => Boolean(value));
        // 未安装时 quickState 是空的，这里自然得到「不默认启用、无已调用时间」。
        record.defaultEnabled = installed && aliases.some((name) => quickState.active.has(name));
        record.lastUsedAt = installed
          ? aliases.reduce((latest, name) => Math.max(latest, quickState.lastUsed[name] ?? 0), 0) || undefined
          : undefined;
      }
      next.set(record.id, record);
    }
    this.records.clear();
    for (const [id, record] of next) this.records.set(id, record);
    return this.list();
  }

  list(): SkillSummary[] {
    return [...this.records.values()]
      .map(({ uri: _uri, content: _content, quickLaunchName: _quickName, sharedName: _sharedName, ...summary }) => summary)
      .sort((a, b) => Number(b.defaultEnabled) - Number(a.defaultEnabled) || a.name.localeCompare(b.name));
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  defaultEnabledIds(): string[] {
    return [...this.records.values()].filter((skill) => skill.defaultEnabled).map((skill) => skill.id);
  }

  /**
   * 全局清单里当前勾选的 Skill。
   *
   * 只在**开新对话**时用作初始勾选（见 `resolveSkillSelection`）；对话里改勾选不会写回
   * 这份清单，所以它不代表「当前对话用了哪些」。
   */
  sharedActiveIds(): string[] {
    return this.defaultEnabledIds();
  }

  /**
   * 「本地skill快捷调用」是否已安装。
   *
   * 它决定**新对话的默认勾选**从哪来，所以没装时面板要说明这件事（而不是禁止勾选：
   * 对话内的勾选本来就不需要它）。
   */
  quickLaunchInstalled(): boolean {
    try {
      return Boolean(vscode.extensions.getExtension(QUICK_LAUNCH_EXTENSION_ID));
    } catch {
      return false;
    }
  }

  prepare(ids: string[], mode: ConversationMode, query: string): PreparedSkillContext {
    const selected = [...new Set(ids)].map((id) => this.records.get(id)).filter((skill): skill is SkillRecord => Boolean(skill));
    const activationMode = vscode.workspace.getConfiguration('skillQuickLaunch').get<string>('activationMode', 'route') === 'always'
      ? 'always'
      : 'route';
    const preload: SkillRecord[] = [];
    const routable: SkillRecord[] = [];

    for (const skill of selected) {
      const quickLaunchRoute = activationMode === 'route' && skill.source === 'copilot' && skill.defaultEnabled;
      if (!quickLaunchRoute) {
        preload.push(skill);
      } else if (mode === 'chat') {
        if (routeMatches(skill, query)) preload.push(skill);
      } else {
        routable.push(skill);
      }
    }

    const sections: string[] = [];
    const preloaded: SkillUsage[] = [];
    let bytes = 0;
    for (const skill of preload) {
      const section = skillSection(skill);
      const sectionBytes = Buffer.byteLength(section);
      if (bytes + sectionBytes > MAX_ENABLED_BYTES) {
        if (mode !== 'chat') routable.push(skill);
        continue;
      }
      sections.push(section);
      preloaded.push(toUsage(skill));
      bytes += sectionBytes;
    }

    const routeTable = uniqueSkills(routable);
    const promptParts: string[] = [];
    if (sections.length) {
      promptParts.push(
        'Apply the following user-enabled local skills. Treat skill text as instructions, not as tool results or user data.',
        ...sections,
      );
    }
    if (routeTable.length) {
      promptParts.push([
        'The user enabled the following routable local skills. When the task matches a skill, call load_skill before acting, then follow the returned instructions. Do not load unrelated skills.',
        // 触发词必须出现在这一行里：它就是模型判断「要不要 load_skill」的直接依据。
        ...routeTable.map((skill) => skillRouteLine(skill)),
      ].join('\n'));
    }
    return {
      prompt: promptParts.join('\n\n'),
      preloaded,
      routableIds: routeTable.map((skill) => skill.id),
      bytes,
    };
  }

  toolDefinition(ids: string[]): ToolDefinition | undefined {
    const skills = ids.map((id) => this.records.get(id)).filter((skill): skill is SkillRecord => Boolean(skill));
    if (!skills.length) return undefined;
    return {
      type: 'function',
      function: {
        name: 'load_skill',
        description: tt('skill.loadDescription'),
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              enum: skills.map((skill) => skill.id),
              description: skills.map((skill) => `${skill.id}=${skill.name}`).join('; '),
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    };
  }

  async executeLoad(call: ToolCall, allowedIds: string[]): Promise<{ result: ToolExecutionResult; usage?: SkillUsage }> {
    let id = '';
    try {
      const args = JSON.parse(call.function.arguments) as { id?: unknown };
      id = typeof args.id === 'string' ? args.id : '';
    } catch {
      // The invalid argument is reported below.
    }
    const skill = allowedIds.includes(id) ? this.records.get(id) : undefined;
    if (!skill) {
      return {
        result: {
          status: 'denied',
          summary: tt('skill.loadDenied'),
          content: tt('skill.loadDeniedContent'),
          approval: 'not-required',
        },
      };
    }
    const usage = toUsage(skill);
    await this.recordUsage([skill.id]);
    return {
      usage,
      result: {
        status: 'success',
        summary: tt('skill.loaded', { name: skill.name }),
        content: skillSection(skill),
        approval: 'not-required',
      },
    };
  }

  async recordUsage(ids: string[]): Promise<void> {
    const used = ids.map((id) => this.records.get(id)).filter((skill): skill is SkillRecord => Boolean(skill));
    if (!used.length) return;
    const now = Date.now();
    const sharedUsed = used.filter((skill) => skill.source === 'copilot');
    // 内存里的角标先更新：即使共享文件写不了，本面板这几轮也照样显示「已调用」。
    for (const skill of used) skill.lastUsedAt = now;
    if (!sharedUsed.length) return;
    // 读不懂就别写：少记一次时间戳只是少个角标，拿空对象覆盖会把对方的分类、
    // 自定义名称与历史调用时间一起写没。
    const raw = await this.readQuickLaunchRaw();
    const next = withSharedLastUsed(
      raw,
      // 只写共享清单认得的那个名字。目录名与显示名（正文标题）也写进去，只会在文件里
      // 堆出一串别人用不到的键，还可能和另一个技能撞名。
      sharedUsed.map((skill) => skill.sharedName ?? skill.quickLaunchName ?? skill.name),
      now,
    );
    if (!next) return;
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(this.quickLaunchStateFile.fsPath)));
      await vscode.workspace.fs.writeFile(
        this.quickLaunchStateFile,
        new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      );
    } catch {
      // 记录调用时间失败不该让本轮对话失败：它只影响面板上的角标。
    }
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const disposable of this.watcherDisposables) disposable.dispose();
    this.onDidChangeSharedState.dispose();
  }

  private async addFlatMarkdownSkills(candidates: Array<{
    uri: vscode.Uri;
    source: SkillSummary['source'];
    relativePath: string;
    quickLaunchName?: string;
  }>): Promise<void> {
    try {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(this.userSkillRoot)) {
        if (type === vscode.FileType.File && name.toLowerCase().endsWith('.md')) {
          candidates.push({ uri: vscode.Uri.joinPath(this.userSkillRoot, name), source: 'user', relativePath: `user/${name}` });
        }
      }
    } catch {
      // The extension-local user skill directory is optional.
    }
  }

  private async addCopilotSkills(candidates: Array<{
    uri: vscode.Uri;
    source: SkillSummary['source'];
    relativePath: string;
    quickLaunchName?: string;
  }>): Promise<void> {
    try {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(this.copilotSkillRoot)) {
        if (type !== vscode.FileType.Directory || name.startsWith('.')) continue;
        candidates.push({
          uri: vscode.Uri.joinPath(this.copilotSkillRoot, name, 'SKILL.md'),
          source: 'copilot',
          relativePath: `~/.copilot/skills/${name}/SKILL.md`,
          quickLaunchName: name,
        });
      }
    } catch {
      // The shared Copilot skill directory is optional.
    }
  }

  private async readSkill(candidate: {
    uri: vscode.Uri;
    source: SkillSummary['source'];
    relativePath: string;
    quickLaunchName?: string;
  }): Promise<SkillRecord | undefined> {
    const bytes = await vscode.workspace.fs.readFile(candidate.uri);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SKILL_BYTES || containsBinary(bytes)) return undefined;
    const raw = new TextDecoder().decode(bytes).replace(/\r\n/g, '\n').trim();
    if (!raw) return undefined;
    const frontmatter = parseFrontmatter(raw);
    const fallback = candidate.quickLaunchName
      ?? basename(candidate.uri.path).replace(/\.md$/i, '').replace(/^SKILL$/i, basename(dirname(candidate.uri.path)));
    const name = cleanInline(frontmatter.name || firstHeading(frontmatter.body) || fallback || 'Unnamed skill', 80);
    /**
     * 共享清单里的名字：`frontmatter.name` → 目录名，且**只看这两级**。
     * 这与「本地skill快捷调用」的 `parseSkillMd` 一致；它不认得正文标题，
     * 若我们按显示名（可能来自标题）写回，它的面板就会显示成没勾选。
     */
    const sharedName = candidate.quickLaunchName
      ? cleanInline(sharedSkillName(frontmatter.name, candidate.quickLaunchName) ?? '', 80) || undefined
      : undefined;
    /*
     * 描述拆三段：摘要 / 适用 / 触发词。触发词单独存字段、**不参与截断**，
     * 否则写在描述末尾的 `Triggers:` 会被 240 字符上限整段吃掉（见 parseSkillDescription）。
     *
     * `description` 仍是「人看的一句话」：摘要 + 适用场景，仍压到 240 —— 面板列表
     * 一行放不下更多，而且路由表另有 skillRouteLine 负责把触发词带上。
     */
    const parsed = parseSkillDescription(
      frontmatter.description || firstParagraph(frontmatter.body),
      frontmatter.triggers,
    );
    const description = cleanInline(
      [parsed.summary, parsed.useFor ? `适用：${parsed.useFor}` : ''].filter(Boolean).join(' '),
      240,
    );
    const id = createHash('sha256').update(`${candidate.source}:${candidate.uri.toString()}`).digest('hex').slice(0, 20);
    return {
      id,
      name,
      description: description || tt('skill.localSkill'),
      useFor: parsed.useFor,
      triggers: parsed.triggers,
      source: candidate.source,
      relativePath: candidate.relativePath,
      uri: candidate.uri,
      content: frontmatter.body,
      quickLaunchName: candidate.quickLaunchName,
      sharedName,
    };
  }

  /** 共享文件的原始 JSON；`undefined` 表示**存在但读不懂**，调用方必须放弃写入。 */
  private async readQuickLaunchRaw(): Promise<Record<string, unknown> | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.quickLaunchStateFile);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      return parsed as Record<string, unknown>;
    } catch (error) {
      // 只有「文件不存在」才等价于空状态（首次使用，写入会新建文件）。
      return isMissingFileError(error) ? {} : undefined;
    }
  }

  private async readQuickLaunchState(): Promise<QuickLaunchState> {
    const raw = (await this.readQuickLaunchRaw()) ?? {};
    const shared = readSharedState(raw);
    const lastUsed = raw.lastUsed && typeof raw.lastUsed === 'object' && !Array.isArray(raw.lastUsed)
      ? Object.fromEntries(Object.entries(raw.lastUsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
      : {};
    return { raw, active: new Set(shared.active), lastUsed };
  }
}

function skillSection(skill: SkillRecord): string {
  return [
    `<skill id=${JSON.stringify(skill.id)} name=${JSON.stringify(skill.name)} source=${JSON.stringify(skill.relativePath)}>`,
    skill.content,
    '</skill>',
  ].join('\n');
}

function toUsage(skill: SkillRecord): SkillUsage {
  return { id: skill.id, name: skill.name, source: skill.source, relativePath: skill.relativePath };
}

function uniqueSkills(skills: SkillRecord[]): SkillRecord[] {
  return [...new Map(skills.map((skill) => [skill.id, skill])).values()];
}

function routeMatches(skill: SkillRecord, query: string): boolean {
  const haystack = query.toLocaleLowerCase();
  if (!haystack) return false;
  if (haystack.includes(skill.name.toLocaleLowerCase())) return true;
  const terms = `${skill.name} ${skill.description}`.toLocaleLowerCase().match(/[a-z0-9][a-z0-9.+#_-]{2,}|[\u3400-\u9fff]{2,8}/g) ?? [];
  return terms.some((term) => !ROUTE_STOP_WORDS.has(term) && haystack.includes(term));
}

const ROUTE_STOP_WORDS = new Set(['skill', 'use', 'for', 'when', '使用', '用于', '技能', '项目', '任务', '处理', '用户']);

function deduplicate<T extends { uri: vscode.Uri }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.uri.toString(), item])).values()];
}

/**
 * 把技能描述拆成三块：摘要 / 适用场景 / 触发词。
 *
 * 为什么必须拆（真实故障，2026-10-31）：`readSkill` 会把 description 压成一行并
 * **截断到 240 字符**（路由表每个技能只占一行，不截断会把提示词撑成几万字）。
 * 而本机技能的描述普遍写成 `**标题** — 摘要。USE FOR: … Triggers: …` —— 触发词在
 * 最末尾，于是被整段切掉：文件看着没问题，模型却永远匹配不到这个技能。实测 38 个
 * 技能里 16 个中招（含 `search-before-acting`、`work-principles`）。
 *
 * 拆开之后，触发词有自己的字段、不参与截断；摘要与适用场景也各自有上限，
 * 成本可控（38 个技能全当路由项时，路由表从 1191 增到约 1519 字符）。
 *
 * 兼容性：标记前后**不要求空格**。中文写作习惯是「…验收。Triggers: …」，句号后面
 * 直接跟标记，早期按 `\s` 判边界的实现会全部漏掉（这次就是这么踩到的）。
 */
export function parseSkillDescription(
  raw: string,
  explicitTriggers?: string,
): { summary: string; useFor: string; triggers: string[] } {
  const text = (raw || '').replace(/\s+/g, ' ').trim();
  const markerPattern = /(?:Triggers?|触发词|触发|USE\s+FOR|Use when|适用场景|适用)\s*[:：]/gi;
  const markers: Array<{ kind: 'triggers' | 'useFor'; start: number; end: number }> = [];
  for (const match of text.matchAll(markerPattern)) {
    const label = match[0];
    const kind = /^(?:Triggers?|触发词|触发)/i.test(label) ? 'triggers' : 'useFor';
    markers.push({ kind, start: match.index ?? 0, end: (match.index ?? 0) + label.length });
  }
  // 按出现位置排序：这样两段的先后顺序写反了也能正确切开（不假定作者一定按
  // 摘要 → 适用 → 触发词 的顺序写）。
  markers.sort((left, right) => left.start - right.start);

  const summary = (markers.length ? text.slice(0, markers[0]!.start) : text)
    .trim().replace(/[.。;；\s]+$/g, '');
  let useFor = '';
  const triggers: string[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    const next = markers[index + 1];
    const segment = text.slice(marker.end, next ? next.start : text.length).trim();
    if (marker.kind === 'useFor') {
      const value = segment.replace(/[.。;；\s]+$/g, '');
      if (value) useFor = value;
      continue;
    }
    for (const part of segment.split(/[,，、;；|]/)) {
      const word = part.trim().replace(/^[.。\s]+|[.。\s]+$/g, '');
      if (word && !triggers.includes(word)) triggers.push(word);
    }
  }

  // frontmatter 里显式写的 `triggers:` 合并进来（去重、保序）。
  if (explicitTriggers) {
    for (const part of explicitTriggers.split(/[,，、;；|]/)) {
      const word = part.trim().replace(/^[.。\s]+|[.。\s]+$/g, '');
      if (word && !triggers.includes(word)) triggers.push(word);
    }
  }
  return { summary, useFor, triggers };
}

/** 路由表每一段的长度上限：摘要最要紧，触发词其次，适用场景再其次。 */
const ROUTE_SUMMARY_CHARS = 180;
const ROUTE_USE_FOR_CHARS = 200;
const ROUTE_TRIGGERS_CHARS = 160;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * 路由表里的一行：`- id | 名字 | 摘要 | 适用：… | 触发词：…`。
 *
 * 触发词必须在这里出现 —— 它是模型判断「该不该 load_skill」的直接依据。
 * 早先它只是描述的一部分，被 240 字符截断后就没了。
 */
export function skillRouteLine(skill: Pick<SkillSummary, 'id' | 'name' | 'description' | 'useFor' | 'triggers'>): string {
  const parts = [skill.id, skill.name, clip(skill.description, ROUTE_SUMMARY_CHARS)];
  if (skill.useFor) parts.push(`适用：${clip(skill.useFor, ROUTE_USE_FOR_CHARS)}`);
  if (skill.triggers?.length) parts.push(`触发词：${clip(skill.triggers.join(', '), ROUTE_TRIGGERS_CHARS)}`);
  return `- ${parts.join(' | ')}`;
}

function parseFrontmatter(value: string): { name?: string; description?: string; triggers?: string; body: string } {
  if (!value.startsWith('---\n')) return { body: value };
  const end = value.indexOf('\n---\n', 4);
  if (end < 0 || end > 8_192) return { body: value };
  const metadata = value.slice(4, end);
  const fields: Record<string, string> = {};
  for (const line of metadata.split('\n')) {
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (match) fields[match[1]!.toLowerCase()] = match[2]!.replace(/^['"]|['"]$/g, '').trim();
  }
  return { name: fields.name, description: fields.description, triggers: fields.triggers, body: value.slice(end + 5).trim() };
}

function firstHeading(value: string): string {
  return value.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() ?? '';
}

function firstParagraph(value: string): string {
  return value
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s+/gm, '').trim())
    .find((part) => Boolean(part) && !part.startsWith('```')) ?? '';
}

function cleanInline(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function containsBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  return sample.includes(0);
}
