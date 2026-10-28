import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import {
  ChatSettings,
  ConversationMode,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from '../core/types';
import { redact } from './auditLog';
import type { RequestApproval, ToolExecutor } from './toolExecutor';
import { externalToolPathViolation, resolveWorkspacePath } from './workspacePaths';
import { classifyVscodeToolRisk } from '../core/permissions';

const PREFIX = 'hwchat_vscode_';
const BUILTIN_NAMES = ['open_web_preview', 'open_text_preview', 'open_markdown_preview', 'open_diff_preview'] as const;
type BuiltinName = typeof BUILTIN_NAMES[number];
/**
 * VS Code 暴露的语言模型工具全部登记为可调用工具。上限只是防御性保护，
 * 远高于正常工作区的工具数量，避免工具被静默截断。
 */
const EXTERNAL_TOOL_LIMIT = 400;

interface ExternalTool {
  name: string;
  description: string;
  inputSchema: object;
  tags: readonly string[];
}

export class VscodeToolBridge {
  /**
   * 共享同一次预热。
   *
   * 以前只置一个布尔标记就提前返回：第二个调用方（`send()`）会在其它扩展
   * 还没激活完时就去读工具列表，于是这一轮的工具定义缺项。改成记住 Promise，
   * 所有人都等同一批激活结束，且只激活一次。
   */
  private warming: Promise<void> | undefined;

  constructor(private readonly tools: ToolExecutor) {}

  definitions(): ToolDefinition[] {
    const builtins = [
      definition('open_web_preview', '直接在 VS Code 编辑区打开一个 HTTP(S) 网页预览，不修改工作区。', {
        type: 'object', properties: { url: { type: 'string', description: 'http 或 https URL' }, title: { type: 'string' } }, required: ['url'], additionalProperties: false,
      }),
      definition('open_text_preview', '直接在 VS Code 编辑器中打开工作区文件或临时文本，不运行终端命令。', {
        type: 'object', properties: { path: { type: 'string', description: '工作区相对路径、带工作区根目录名的路径，或工作区内绝对路径；与 content 二选一' }, content: { type: 'string' }, language: { type: 'string' }, title: { type: 'string' } }, additionalProperties: false,
      }),
      definition('open_markdown_preview', '在 VS Code 编辑区打开 Markdown 预览，可使用工作区文件或临时内容。', {
        type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' } }, additionalProperties: false,
      }),
      definition('open_diff_preview', '在 VS Code 编辑区打开工作区文件与临时内容的差异预览，不直接写入文件。', {
        type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false,
      }),
    ];
    return [...builtins, ...this.externalDefinitions()];
  }

  availableCount(): number {
    return this.definitions().length;
  }

  async execute(
    call: ToolCall,
    mode: ConversationMode,
    settings: ChatSettings,
    requestApproval: RequestApproval,
    conversationId: string,
  ): Promise<{ result: ToolExecutionResult } | undefined> {
    const builtin = builtinName(call.function.name);
    if (builtin) {
        // 预览类内建工具只读、不改工作区，按读取风险处理，预设允许读取时不再弹窗。
        const risk = 'read';
        const result = await this.tools.executeExternal(
          call,
          mode,
          settings,
          risk,
          requestApproval,
          `打开 VS Code 预览：${builtin.replace(/^open_|_preview$/g, '')}`,
          redact(call.function.arguments).slice(0, 1_000),
          () => this.executeBuiltin(builtin, parseInput(call.function.arguments)),
          { conversationId },
        );
        return { result };
    }
    if (call.function.name.startsWith(PREFIX)) {
      let external = this.findExternalTool(call.function.name);
      if (!external) {
        // 扩展可能还没激活；补一次激活后重试，避免工具「看得见调不到」。
        await this.warmToolContributors();
        external = this.findExternalTool(call.function.name);
      }
      const externalLabel = call.function.name.slice(PREFIX.length);
      if (!external) {
        const available = this.externalTools().length;
        const result = await this.tools.executeExternal(
          call,
          mode,
          settings,
          'read',
          requestApproval,
          `调用 VS Code 工具：${externalLabel}`,
          '该 VS Code 工具当前不可用。',
          async () => denied(`未找到 VS Code 工具（当前可用 ${available} 个）。请使用本轮工具列表中给出的工具 id 重试。`),
          { conversationId, delegateApproval: true },
        );
        return { result };
      }
      const risk = classifyVscodeToolRisk(external);
      const result = await this.tools.executeExternal(
        call,
        mode,
        settings,
        risk,
        requestApproval,
        `调用 VS Code 工具：${external.name}`,
        `${external.description}\n\n参数：${redact(call.function.arguments).slice(0, 1_000)}`,
        () => this.invokeExternal(external, call.function.arguments),
        // VS Code 工具是否需要用户授权由 VS Code / 工具自身决定，HWChat 不再叠加确认。
        { conversationId, delegateApproval: true },
      );
      return { result };
    }
    return undefined;
  }

  /**
   * 直接调用 VS Code 语言模型工具。不传 toolInvocationToken 时 VS Code 不会插入
   * 聊天轮次 UI，但仍会在工具自己声明需要确认时弹出确认框——因此「不需要授权的
   * 工具」会直接执行，只有真正需要授权的工具才会询问用户。
   */
  private async invokeExternal(tool: ExternalTool, rawArguments: string): Promise<ToolExecutionResult> {
    try {
      const input = parseInput(rawArguments);
      // 桥接工具的参数由 VS Code 侧解释，HWChat 无法插手其内部行为，因此必须
      // 在调用前就挡掉越界路径——否则 `copilot_readFile` 能读到 /etc 下的任何文件。
      const folders = vscode.workspace.workspaceFolders ?? [];
      const violation = externalToolPathViolation(
        input,
        folders.map((folder) => ({ name: folder.name, fsPath: folder.uri.fsPath })),
      );
      if (violation) {
        return denied(`VS Code 工具 ${tool.name} 被路径隔离策略拦截：${violation}`);
      }
      const response = await vscode.lm.invokeTool(tool.name, {
        input,
        toolInvocationToken: undefined,
      });
      return success(`调用 VS Code 工具：${tool.name}`, toolResultText(response) || '工具已完成，但没有返回文本结果。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/(cancel|denied|reject|not confirmed|confirmation|abort)/i.test(message)) {
        return denied(`VS Code 工具 ${tool.name} 需要用户确认，本次调用已取消或拒绝。`);
      }
      const cleaned = message
        .replace(/^Running Language Model Tool[^\n]*?(failed|error)[:,]?\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      throw new Error(cleaned || `调用 VS Code 工具 ${tool.name} 失败。`);
    }
  }

  private findExternalTool(id: string): ExternalTool | undefined {
    return this.externalTools().find((item) => externalToolId(item.name) === id);
  }

  /**
   * 激活尚未运行、但声明了语言模型工具的扩展，让它们的工具也出现在工具列表里。
   * 只尝试一次，且失败不影响其它工具。
   */
  warmToolContributors(): Promise<void> {
    if (!this.warming) this.warming = this.activateToolContributors();
    return this.warming;
  }

  private async activateToolContributors(): Promise<void> {
    const candidates = vscode.extensions.all.filter((extension) => {
      if (extension.isActive) return false;
      const packageJSON = extension.packageJSON as {
        contributes?: { languageModelTools?: unknown };
        activationEvents?: unknown;
      } | undefined;
      const contributed = packageJSON?.contributes?.languageModelTools;
      if (Array.isArray(contributed) && contributed.length > 0) return true;
      const events = packageJSON?.activationEvents;
      return Array.isArray(events) && events.some((event) => typeof event === 'string' && /^onLanguageModelTool:/.test(event));
    });
    await Promise.all(candidates.map(async (extension) => {
      try {
        await extension.activate();
      } catch {
        // 工具由扩展自身管理，激活失败只是少了可选工具，不影响其余调用。
      }
    }));
  }

  private externalTools(): ExternalTool[] {
    const available = vscode.lm?.tools ?? [];
    return available
      .filter((tool): tool is typeof tool & { name: string } => Boolean(tool?.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description || `由其他 VS Code 扩展提供的工具：${tool.name}`,
        inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {}, additionalProperties: true },
        tags: tool.tags ?? [],
      }))
      // 固定排序，保证刷新后工具 id 与顺序稳定，并且截断时不会随机丢工具。
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, EXTERNAL_TOOL_LIMIT);
  }

  private externalDefinitions(): ToolDefinition[] {
    return this.externalTools().map((tool) => definition(
      externalToolId(tool.name),
      `VS Code 扩展工具 ${tool.name}：${tool.description}${absolutePathHint(tool.inputSchema)}`,
      tool.inputSchema as Record<string, unknown>,
    ));
  }

  private async executeBuiltin(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    switch (name) {
      case 'open_web_preview': {
        const value = stringArg(args, 'url');
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('网页预览只允许 HTTP(S) 地址。');
        await vscode.commands.executeCommand('simpleBrowser.show', url.toString());
        return success(`已打开网页预览：${url.toString()}`, '网页已在 VS Code 编辑区预览。');
      }
      case 'open_text_preview': {
        const document = await this.openDocument(args);
        await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
        return success(`已打开文本预览：${document.fileName}`, '文本已在 VS Code 编辑区打开。');
      }
      case 'open_markdown_preview': {
        const document = await this.openDocument(args, 'markdown');
        await vscode.commands.executeCommand('markdown.showPreview', document.uri);
        return success(`已打开 Markdown 预览：${document.fileName}`, 'Markdown 已在 VS Code 编辑区预览。');
      }
      case 'open_diff_preview': {
        const path = stringArg(args, 'path');
        const original = this.workspaceUri(path);
        const modified = await vscode.workspace.openTextDocument({
          content: stringArg(args, 'content'),
          language: typeof args.language === 'string' ? args.language : undefined,
        });
        await vscode.commands.executeCommand('vscode.diff', original, modified.uri, stringArg(args, 'title', `预览修改：${path}`));
        return success(`已打开差异预览：${path}`, '原文件与临时修改内容已在编辑区对比显示。');
      }
      default:
        return denied(`未知 VS Code 工具：${name}`);
    }
  }

  private async openDocument(args: Record<string, unknown>, language?: string): Promise<vscode.TextDocument> {
    if (typeof args.path === 'string' && args.path.trim()) {
      return vscode.workspace.openTextDocument(this.workspaceUri(args.path));
    }
    if (typeof args.content !== 'string') throw new Error('需要提供 path 或 content。');
    return vscode.workspace.openTextDocument({
      content: args.content,
      language: typeof args.language === 'string' ? args.language : language,
    });
  }

  private workspaceUri(input: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const resolved = resolveWorkspacePath(
      input,
      folders.map((folder) => ({ folder, name: folder.name, fsPath: folder.uri.fsPath })),
      { exists: existsSync },
    );
    return vscode.Uri.file(resolved.fsPath);
  }
}

function builtinName(name: string): BuiltinName | undefined {
  if ((BUILTIN_NAMES as readonly string[]).includes(name)) return name as BuiltinName;
  const prefixed = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : '';
  return (BUILTIN_NAMES as readonly string[]).includes(prefixed) ? prefixed as BuiltinName : undefined;
}

function definition(name: string, description: string, parameters: Record<string, unknown>): ToolDefinition {
  return { type: 'function', function: { name, description, parameters } };
}

function externalToolId(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 38);
  return `${PREFIX}${safe || 'tool'}_${shortHash(name)}`;
}

/**
 * VS Code 侧的文件类工具只接受绝对路径，传相对路径会直接回
 * `Invalid input path: … Be sure to use an absolute path.`。
 * 工具说明里点明这一点，调用方就不必先撞一次错再猜。
 */
function absolutePathHint(inputSchema: unknown): string {
  const properties = isObject(inputSchema) ? inputSchema.properties : undefined;
  if (!isObject(properties)) return '';
  const keys = Object.keys(properties).filter((key) => /^(?:path|filepath|repositorypath|gitfolderpath)$/i.test(key));
  return keys.length ? `（注意：${keys.join('、')} 必须传工作区内绝对路径）` : '';
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseInput(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw || '{}') as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具参数必须是 JSON 对象。');
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 必须是非空字符串。`);
  return value.trim();
}

function success(summary: string, content: string): ToolExecutionResult {
  return { status: 'success', summary, content, approval: 'not-required' };
}

function denied(summary: string): ToolExecutionResult {
  return { status: 'denied', summary, content: summary, approval: 'denied' };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toolResultText(result: vscode.LanguageModelToolResult): string {
  return result.content.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart) return part.value;
    if (part instanceof vscode.LanguageModelDataPart) return `[工具返回 ${part.mimeType} 数据，${part.data.byteLength} 字节]`;
    if (typeof part === 'string') return part;
    try { return JSON.stringify(part); } catch { return String(part); }
  }).filter(Boolean).join('\n');
}
