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

interface SkillRecord extends SkillSummary {
  uri: vscode.Uri;
  content: string;
  quickLaunchName?: string;
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

export class SkillRegistry implements vscode.Disposable {
  private readonly records = new Map<string, SkillRecord>();
  private readonly watcherDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly userSkillRoot: vscode.Uri,
    private readonly copilotSkillRoot = vscode.Uri.file(join(homedir(), '.copilot', 'skills')),
    private readonly quickLaunchStateFile = vscode.Uri.file(join(homedir(), '.copilot', '.skill-quick-launch.json')),
  ) {
    for (const pattern of WORKSPACE_PATTERNS) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(() => void this.refresh(), undefined, this.watcherDisposables);
      watcher.onDidChange(() => void this.refresh(), undefined, this.watcherDisposables);
      watcher.onDidDelete(() => void this.refresh(), undefined, this.watcherDisposables);
      this.watcherDisposables.push(watcher);
    }
  }

  async refresh(): Promise<SkillSummary[]> {
    const quickState = await this.readQuickLaunchState();
    const candidates: Array<{
      uri: vscode.Uri;
      source: SkillSummary['source'];
      relativePath: string;
      quickLaunchName?: string;
    }> = [];
    for (const pattern of WORKSPACE_PATTERNS) {
      for (const uri of await vscode.workspace.findFiles(pattern, '**/{node_modules,.git}/**', 200)) {
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
        const aliases = [record.quickLaunchName, record.name].filter((value): value is string => Boolean(value));
        record.defaultEnabled = aliases.some((name) => quickState.active.has(name));
        record.lastUsedAt = aliases.reduce((latest, name) => Math.max(latest, quickState.lastUsed[name] ?? 0), 0) || undefined;
      }
      next.set(record.id, record);
    }
    this.records.clear();
    for (const [id, record] of next) this.records.set(id, record);
    return this.list();
  }

  list(): SkillSummary[] {
    return [...this.records.values()]
      .map(({ uri: _uri, content: _content, quickLaunchName: _quickName, ...summary }) => summary)
      .sort((a, b) => Number(b.defaultEnabled) - Number(a.defaultEnabled) || a.name.localeCompare(b.name));
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  defaultEnabledIds(): string[] {
    return [...this.records.values()].filter((skill) => skill.defaultEnabled).map((skill) => skill.id);
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
        ...routeTable.map((skill) => `- ${skill.id} | ${skill.name} | ${skill.description}`),
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
    const state = await this.readQuickLaunchState();
    const now = Date.now();
    let sharedStateChanged = false;
    for (const skill of used) {
      skill.lastUsedAt = now;
      if (skill.source === 'copilot') {
        state.lastUsed[skill.quickLaunchName ?? skill.name] = now;
        state.lastUsed[skill.name] = now;
        sharedStateChanged = true;
      }
    }
    if (!sharedStateChanged) return;
    state.raw.lastUsed = state.lastUsed;
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(this.quickLaunchStateFile.fsPath)));
    await vscode.workspace.fs.writeFile(
      this.quickLaunchStateFile,
      new TextEncoder().encode(`${JSON.stringify(state.raw, null, 2)}\n`),
    );
  }

  dispose(): void {
    for (const disposable of this.watcherDisposables) disposable.dispose();
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
    const description = cleanInline(frontmatter.description || firstParagraph(frontmatter.body), 240);
    const id = createHash('sha256').update(`${candidate.source}:${candidate.uri.toString()}`).digest('hex').slice(0, 20);
    return {
      id,
      name,
      description: description || tt('skill.localSkill'),
      source: candidate.source,
      relativePath: candidate.relativePath,
      uri: candidate.uri,
      content: frontmatter.body,
      quickLaunchName: candidate.quickLaunchName,
    };
  }

  private async readQuickLaunchState(): Promise<QuickLaunchState> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.quickLaunchStateFile);
      const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const active = Array.isArray(raw.active)
        ? new Set(raw.active.filter((value): value is string => typeof value === 'string'))
        : new Set<string>();
      const lastUsed = raw.lastUsed && typeof raw.lastUsed === 'object' && !Array.isArray(raw.lastUsed)
        ? Object.fromEntries(Object.entries(raw.lastUsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
        : {};
      return { raw, active, lastUsed };
    } catch {
      return { raw: { active: [], lastUsed: {} }, active: new Set(), lastUsed: {} };
    }
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

function parseFrontmatter(value: string): { name?: string; description?: string; body: string } {
  if (!value.startsWith('---\n')) return { body: value };
  const end = value.indexOf('\n---\n', 4);
  if (end < 0 || end > 8_192) return { body: value };
  const metadata = value.slice(4, end);
  const fields: Record<string, string> = {};
  for (const line of metadata.split('\n')) {
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (match) fields[match[1]!.toLowerCase()] = match[2]!.replace(/^['"]|['"]$/g, '').trim();
  }
  return { name: fields.name, description: fields.description, body: value.slice(end + 5).trim() };
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
