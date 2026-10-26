import * as vscode from 'vscode';
import {
  ChatSettings,
  ConversationMode,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from '../core/types';
import { redact } from './auditLog';
import type { RequestApproval, ToolExecutor } from './toolExecutor';
import { resolveWorkspacePath } from './workspacePaths';

const PREFIX = 'hwchat_vscode_';
const BUILTIN_NAMES = ['open_web_preview', 'open_text_preview', 'open_markdown_preview', 'open_diff_preview'] as const;
type BuiltinName = typeof BUILTIN_NAMES[number];
const EXTERNAL_TOOL_LIMIT = 100;
const DANGEROUS_NAME = /(delete|remove|drop|destroy|reset|force|publish|deploy|release|purchase|payment|send[_-]?email|post[_-]?message)/i;

interface ExternalTool {
  name: string;
  description: string;
  inputSchema: object;
  tags: readonly string[];
}

export class VscodeToolBridge {
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
        const risk = builtin === 'open_web_preview' ? 'command' : 'read';
        const result = await this.tools.executeExternal(
          call,
          mode,
          settings,
          risk,
          requestApproval,
          `打开 VS Code 预览：${builtin.replace(/^open_|_preview$/g, '')}`,
          redact(call.function.arguments).slice(0, 1_000),
          () => this.executeBuiltin(builtin, parseInput(call.function.arguments)),
          conversationId,
        );
        return { result };
    }
    if (call.function.name.startsWith(PREFIX)) {
      const externalLabel = call.function.name.slice(PREFIX.length);
      const external = this.externalTools().find((item) => externalToolId(item.name) === call.function.name);
      if (!external) {
        const result = await this.tools.executeExternal(
          call,
          mode,
          settings,
          'read',
          requestApproval,
          `调用 VS Code 工具：${externalLabel}`,
          '工具已不可用。',
          async () => denied(`未找到 VS Code 工具：${externalLabel}`),
          conversationId,
        );
        return { result };
      }
      const risk = externalRisk(external);
      const forceApproval = DANGEROUS_NAME.test(`${external.name} ${external.description} ${external.tags.join(' ')}`);
      const result = await this.tools.executeExternal(
        call,
        mode,
        settings,
        risk,
        requestApproval,
        `调用 VS Code 工具：${external.name}`,
        `${external.description}\n\n参数：${redact(call.function.arguments).slice(0, 1_000)}`,
        async () => {
          const response = await vscode.lm.invokeTool(external.name, {
            input: parseInput(call.function.arguments),
            toolInvocationToken: undefined,
          });
          return success(`调用 VS Code 工具：${external.name}`, toolResultText(response) || '工具已完成，但没有返回文本结果。');
        },
        conversationId,
        forceApproval,
      );
      return { result };
    }
    return undefined;
  }

  private externalTools(): ExternalTool[] {
    const available = vscode.lm?.tools ?? [];
    return available
      .filter((tool): tool is typeof tool & { name: string } => Boolean(tool?.name))
      .slice(0, EXTERNAL_TOOL_LIMIT)
      .map((tool) => ({
        name: tool.name,
        description: tool.description || `由其他 VS Code 扩展提供的工具：${tool.name}`,
        inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {}, additionalProperties: true },
        tags: tool.tags ?? [],
      }));
  }

  private externalDefinitions(): ToolDefinition[] {
    return this.externalTools().map((tool) => definition(
      externalToolId(tool.name),
      `VS Code 扩展工具 ${tool.name}：${tool.description}`,
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
    const resolved = resolveWorkspacePath(input, folders.map((folder) => ({ folder, name: folder.name, fsPath: folder.uri.fsPath })));
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

function externalRisk(tool: ExternalTool): 'read' | 'write' | 'command' {
  const text = `${tool.name} ${tool.description} ${tool.tags.join(' ')}`;
  if (/(run|execute|command|terminal|shell|process|task|network|https?|web|fetch|request|upload|download|remote|cloud)/i.test(text)) return 'command';
  if (/(write|edit|create|delete|remove|move|rename|apply|install|update|publish|deploy|send|post)/i.test(text)) return 'write';
  if (/(read|get|list|search|find|view|preview|inspect|diagnostic)/i.test(text)) return 'read';
  return 'command';
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
