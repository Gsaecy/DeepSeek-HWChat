import { spawn } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { readSettings } from '../core/settings';
import {
  ChatSettings,
  ConversationMode,
  MessageContext,
  PermissionPolicy,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from '../core/types';
import { AuditLog, redact } from './auditLog';

export interface ToolApprovalRequest {
  callId: string;
  name: string;
  summary: string;
  detail: string;
  risk: 'read' | 'write' | 'command';
}

export type RequestApproval = (request: ToolApprovalRequest) => Promise<boolean>;

interface ResolvedPath {
  uri: vscode.Uri;
  fsPath: string;
  relativePath: string;
  folder: vscode.WorkspaceFolder;
}

const DEFAULT_EXCLUDE = '**/{.git,node_modules,dist,build,out,.next,coverage}/**';
const SENSITIVE_NAMES = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|service[-_]?account(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const SENSITIVE_PARTS = /(^|\/)(\.git|\.ssh|\.aws|\.kube)(\/|$)/i;
const DANGEROUS_COMMAND = /(^|[;&|])\s*(sudo|rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|:\(\)\s*\{|git\s+(?:reset\s+--hard|clean\s+-f|push\s+--force)|chmod\s+777|curl[^\n|]*\|\s*(?:sh|bash)|wget[^\n|]*\|\s*(?:sh|bash))/i;
const OUTSIDE_WORKSPACE_COMMAND = /(^|[\s'"=])(?:~(?:\/|\s|$)|\.\.(?:\/|\\)|\$(?:\{)?HOME\}?\b|\/(?:Users|home|etc|private|var|root|Volumes)(?:\/|\s|$)|[A-Za-z]:\\)/i;
const SENSITIVE_COMMAND = /(^|[\s'"/])(?:\.env(?:\.[^\s'"]*)?|\.ssh|\.aws|\.kube|credentials?(?:\.[^\s'"]*)?|secrets?(?:\.[^\s'"]*)?|service[-_]?account(?:\.[^\s'"]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^\s'"]+\.(?:pem|key|p12|pfx))(?:[\s'"/]|$)/i;

export class ToolExecutor implements vscode.Disposable {
  constructor(
    private readonly audit: AuditLog,
    private readonly isWorkspaceTrusted: () => boolean,
  ) {}

  definitions(mode: ConversationMode): ToolDefinition[] {
    const readOnly: ToolDefinition[] = [
      this.definition('list_files', '列出工作区内匹配的文件路径，不读取文件内容。', {
        type: 'object', properties: { glob: { type: 'string', description: '相对工作区的 glob，例如 src/**/*.ts' } }, required: ['glob'], additionalProperties: false,
      }),
      this.definition('search_files', '在工作区文本文件中搜索字符串，返回匹配文件和行号。', {
        type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' }, caseSensitive: { type: 'boolean' } }, required: ['query'], additionalProperties: false,
      }),
      this.definition('read_file', '读取工作区内一个文本文件。敏感文件默认禁止。', {
        type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path'], additionalProperties: false,
      }),
      this.definition('get_diagnostics', '读取 VS Code 当前已知的语法和类型诊断。', {
        type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false,
      }),
    ];
    if (mode === 'plan') {
      return readOnly;
    }
    return [
      ...readOnly,
      this.definition('write_file', '创建或完整替换一个工作区文本文件。写入前必须经过权限检查。', {
        type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false,
      }),
      this.definition('replace_in_file', '在一个工作区文本文件中进行精确文本替换，适合小范围修改。', {
        type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false,
      }),
      this.definition('rename_file', '重命名或移动工作区内的单个文件。', {
        type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false,
      }),
      this.definition('delete_file', '将工作区内的单个文件移到系统废纸篓。不能删除目录。', {
        type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
      }),
      this.definition('run_command', '在工作区根目录或指定子目录运行命令，并返回截断后的输出。不得借此访问工作区外路径。', {
        type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutSeconds: { type: 'number' } }, required: ['command'], additionalProperties: false,
      }),
    ];
  }

  async execute(
    call: ToolCall,
    mode: ConversationMode,
    settings: ChatSettings,
    requestApproval: RequestApproval,
    conversationId?: string,
  ): Promise<ToolExecutionResult> {
    const name = call.function.name;
    let args: Record<string, unknown>;
    try {
      args = parseArguments(call.function.arguments);
    } catch (error) {
      const result: ToolExecutionResult = {
        status: 'error',
        summary: `${name || 'unknown_tool'} 参数无效`,
        content: error instanceof Error ? error.message : String(error),
        approval: 'not-required',
      };
      await this.auditResult(call, result, conversationId);
      return result;
    }
    const risk = riskFor(name);
    const policy = policyFor(risk, settings);
    const denied = this.checkAccess(name, args, mode, settings, policy);
    if (denied) {
      const result = deniedResult(denied);
      await this.auditResult(call, result, conversationId);
      return result;
    }

    const approvalRequired = policy === 'ask' || (risk === 'command' && DANGEROUS_COMMAND.test(String(args.command ?? '')));
    if (approvalRequired) {
      const approved = await requestApproval({
        callId: call.id,
        name,
        summary: approvalSummary(name, args),
        detail: approvalDetail(name, args),
        risk,
      });
      if (!approved) {
        const result = deniedResult('用户拒绝了这次操作。');
        await this.auditResult(call, result, conversationId);
        return result;
      }
    }

    let result: ToolExecutionResult;
    try {
      switch (name) {
        case 'list_files':
          result = await this.listFiles(args);
          break;
        case 'search_files':
          result = await this.searchFiles(args, settings);
          break;
        case 'read_file':
          result = await this.readFile(args, settings);
          break;
        case 'get_diagnostics':
          result = await this.getDiagnostics(args, settings);
          break;
        case 'write_file':
          result = await this.writeFile(args, settings);
          break;
        case 'replace_in_file':
          result = await this.replaceInFile(args, settings);
          break;
        case 'rename_file':
          result = await this.renameFile(args, settings);
          break;
        case 'delete_file':
          result = await this.deleteFile(args, settings);
          break;
        case 'run_command':
          result = await this.runCommand(args, settings);
          break;
        default:
          result = deniedResult(`未知工具：${name}`);
      }
    } catch (error) {
      result = {
        status: 'error',
        summary: `${name} 执行失败`,
        content: truncate(redact(error instanceof Error ? error.message : String(error)), settings.maxToolOutputBytes),
        approval: approvalRequired ? 'approved' : 'not-required',
      };
    }
    result.approval = approvalRequired ? 'approved' : 'not-required';
    await this.auditResult(call, result, conversationId);
    return result;
  }

  async readAttachment(uri: vscode.Uri, settings = readSettings()): Promise<MessageContext & { content: string }> {
    const resolved = await this.resolvePath(uri.fsPath);
    this.assertReadable(resolved, settings);
    const stat = await vscode.workspace.fs.stat(resolved.uri);
    if (stat.size > settings.maxReadBytes) {
      throw new Error(`文件过大（${formatBytes(stat.size)}），上限为 ${formatBytes(settings.maxReadBytes)}。`);
    }
    const bytes = await vscode.workspace.fs.readFile(resolved.uri);
    const content = decodeText(bytes);
    return {
      label: resolved.relativePath,
      path: resolved.relativePath,
      kind: 'file',
      bytes: bytes.byteLength,
      content,
    };
  }

  dispose(): void {
    // The executor owns no process handles; running commands are bounded by their local timeout.
  }

  private async listFiles(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const glob = stringArg(args, 'glob', '**/*');
    const files = await vscode.workspace.findFiles(glob, DEFAULT_EXCLUDE, 200);
    const paths = files.map(workspaceRelativePath).sort();
    return success(`找到 ${paths.length} 个文件`, paths.join('\n') || '没有匹配文件。');
  }

  private async searchFiles(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const query = stringArg(args, 'query');
    if (!query) throw new Error('query 不能为空。');
    const glob = stringArg(args, 'glob', '**/*');
    const caseSensitive = Boolean(args.caseSensitive);
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const files = await vscode.workspace.findFiles(glob, DEFAULT_EXCLUDE, 200);
    const matches: string[] = [];
    for (const uri of files) {
      const resolved = await this.resolvePath(uri.fsPath);
      if (isSensitivePath(resolved.relativePath) && !settings.allowSensitiveFiles) continue;
      const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined);
      if (!stat || stat.size > settings.maxReadBytes) continue;
      const text = decodeText(await vscode.workspace.fs.readFile(uri));
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        if (haystack.includes(needle) && matches.length < 120) {
          matches.push(`${workspaceRelativePath(uri)}:${index + 1}: ${line.trim().slice(0, 400)}`);
        }
      });
      if (matches.length >= 120) break;
    }
    return success(
      `找到 ${matches.length} 处匹配`,
      truncate(redact(matches.join('\n') || '没有匹配。'), settings.maxToolOutputBytes),
    );
  }

  private async readFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'));
    this.assertReadable(resolved, settings);
    const stat = await vscode.workspace.fs.stat(resolved.uri);
    if (stat.size > settings.maxReadBytes) {
      throw new Error(`文件过大（${formatBytes(stat.size)}），已超过 ${formatBytes(settings.maxReadBytes)} 上限；请提高读取上限或先用搜索定位内容。`);
    }
    let text = decodeText(await vscode.workspace.fs.readFile(resolved.uri));
    const startLine = Math.max(1, numberArg(args, 'startLine', 1));
    const endLine = Math.max(startLine, numberArg(args, 'endLine', Number.MAX_SAFE_INTEGER));
    if (startLine > 1 || endLine < Number.MAX_SAFE_INTEGER) {
      const lines = text.split(/\r?\n/);
      text = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join('\n');
    }
    text = truncate(redact(text), settings.maxToolOutputBytes);
    return {
      status: 'success',
      summary: `读取 ${resolved.relativePath}（${formatBytes(stat.size)}）`,
      content: text,
      approval: 'not-required',
    };
  }

  private async getDiagnostics(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const path = args.path ? stringArg(args, 'path') : undefined;
    const uri = path ? (await this.resolvePath(path)).uri : undefined;
    const diagnosticEntries: Array<[vscode.Uri, vscode.Diagnostic[]]> = uri
      ? [[uri, vscode.languages.getDiagnostics(uri)]]
      : vscode.languages.getDiagnostics();
    const entries = diagnosticEntries
      .flatMap(([itemUri, diagnostics]) => diagnostics.map((diagnostic: vscode.Diagnostic) => {
        const location = `${workspaceRelativePath(itemUri)}:${diagnostic.range.start.line + 1}`;
        return `${location} [${diagnostic.severity}] ${diagnostic.message}`;
      }));
    return success(
      `读取 ${entries.length} 条诊断`,
      truncate(redact(entries.join('\n') || '没有已知诊断。'), settings.maxToolOutputBytes),
    );
  }

  private async writeFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'));
    this.assertWritable(resolved, settings);
    const content = stringArg(args, 'content');
    const maxWriteBytes = settings.maxReadBytes * 4;
    if (Buffer.byteLength(content) > maxWriteBytes) {
      throw new Error('写入内容过大，超过单文件安全上限。');
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(resolved.fsPath)));
    const previousStat = await Promise.resolve(vscode.workspace.fs.stat(resolved.uri)).catch(() => undefined);
    const previous = previousStat && previousStat.size <= maxWriteBytes
      ? await Promise.resolve(vscode.workspace.fs.readFile(resolved.uri)).then(decodeText).catch(() => '')
      : '';
    await vscode.workspace.fs.writeFile(resolved.uri, new TextEncoder().encode(content));
    const summary = previousStat
      ? previous ? `更新 ${resolved.relativePath}：${lineDelta(previous, content)}` : `更新 ${resolved.relativePath}`
      : `创建 ${resolved.relativePath}`;
    return { status: 'success', summary, content: `${summary}\n文件已写入。`, approval: 'approved', changedFiles: [resolved.relativePath] };
  }

  private async replaceInFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'));
    this.assertWritable(resolved, settings);
    const oldText = stringArg(args, 'oldText');
    const newText = stringArg(args, 'newText');
    if (!oldText) throw new Error('oldText 不能为空。');
    const stat = await vscode.workspace.fs.stat(resolved.uri);
    if (stat.size > settings.maxReadBytes) {
      throw new Error(`文件过大（${formatBytes(stat.size)}），精确替换上限为 ${formatBytes(settings.maxReadBytes)}。`);
    }
    const current = decodeText(await vscode.workspace.fs.readFile(resolved.uri));
    const occurrences = current.split(oldText).length - 1;
    if (occurrences < 1) throw new Error('oldText 在文件中不存在，未执行修改。');
    if (occurrences > 1 && !Boolean(args.replaceAll)) {
      throw new Error(`oldText 出现 ${occurrences} 次，请提供更精确的文本或明确 replaceAll=true。`);
    }
    const replacements = Boolean(args.replaceAll) ? occurrences : 1;
    const estimatedBytes = Buffer.byteLength(current)
      + replacements * (Buffer.byteLength(newText) - Buffer.byteLength(oldText));
    if (estimatedBytes > settings.maxReadBytes * 4) {
      throw new Error('替换后的文件预计超过单文件安全上限。');
    }
    const next = Boolean(args.replaceAll) ? current.split(oldText).join(newText) : current.replace(oldText, newText);
    await vscode.workspace.fs.writeFile(resolved.uri, new TextEncoder().encode(next));
    const summary = `修改 ${resolved.relativePath}：替换 ${Boolean(args.replaceAll) ? occurrences : 1} 处文本`;
    return { status: 'success', summary, content: `${summary}\n${lineDelta(current, next)}`, approval: 'approved', changedFiles: [resolved.relativePath] };
  }

  private async renameFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const from = await this.resolvePath(stringArg(args, 'from'));
    const to = await this.resolvePath(stringArg(args, 'to'));
    this.assertWritable(from, settings);
    this.assertWritable(to, settings);
    const sourceStat = await vscode.workspace.fs.stat(from.uri);
    if ((sourceStat.type & vscode.FileType.File) === 0) throw new Error('rename_file 只能移动普通文件。');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(to.fsPath)));
    await vscode.workspace.fs.rename(from.uri, to.uri, { overwrite: false });
    const summary = `移动 ${from.relativePath} → ${to.relativePath}`;
    return { status: 'success', summary, content: summary, approval: 'approved', changedFiles: [from.relativePath, to.relativePath] };
  }

  private async deleteFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'));
    this.assertWritable(resolved, settings);
    const targetStat = await vscode.workspace.fs.stat(resolved.uri);
    if ((targetStat.type & vscode.FileType.File) === 0) throw new Error('delete_file 只能删除普通文件，目录删除被禁止。');
    await vscode.workspace.fs.delete(resolved.uri, { recursive: false, useTrash: true });
    const summary = `已将 ${resolved.relativePath} 移到废纸篓`;
    return { status: 'success', summary, content: summary, approval: 'approved', changedFiles: [resolved.relativePath] };
  }

  private async runCommand(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const command = stringArg(args, 'command');
    if (!command || command.length > 4_000) throw new Error('命令为空或过长。');
    const resolvedCwd = await this.resolvePath(stringArg(args, 'cwd', '.'));
    const timeout = Math.min(settings.maxCommandSeconds, Math.max(5, numberArg(args, 'timeoutSeconds', settings.maxCommandSeconds)));
    const result = await spawnCommand(command, resolvedCwd.fsPath, timeout, settings.maxToolOutputBytes);
    const output = redact([result.stdout, result.stderr].filter(Boolean).join('\n')).trim();
    return {
      status: result.code === 0 ? 'success' : 'error',
      summary: result.timedOut ? `命令超时（${timeout} 秒）` : `命令退出码 ${result.code ?? 'unknown'}`,
      content: truncate(output || '(无输出)', settings.maxToolOutputBytes),
      approval: 'approved',
    };
  }

  private checkAccess(
    name: string,
    args: Record<string, unknown>,
    mode: ConversationMode,
    settings: ChatSettings,
    policy: PermissionPolicy,
  ): string | undefined {
    if (!['list_files', 'search_files', 'read_file', 'get_diagnostics', 'write_file', 'replace_in_file', 'rename_file', 'delete_file', 'run_command'].includes(name)) {
      return `工具 ${name} 未被允许。`;
    }
    if (policy === 'deny') return `当前权限策略禁止 ${name}。`;
    if (mode === 'plan' && ['write_file', 'replace_in_file', 'rename_file', 'delete_file', 'run_command'].includes(name)) return '规划模式只允许只读分析。';
    if (['write_file', 'replace_in_file', 'rename_file', 'delete_file', 'run_command'].includes(name) && !this.isWorkspaceTrusted()) {
      return '当前工作区未受信任，文件写入和命令执行已禁用。请先信任工作区。';
    }
    if (name === 'run_command' && DANGEROUS_COMMAND.test(String(args.command ?? '')) && !settings.allowDangerousCommands) {
      return '命令被安全策略拦截：包含高风险或破坏性操作。';
    }
    if (name === 'run_command' && OUTSIDE_WORKSPACE_COMMAND.test(String(args.command ?? ''))) {
      return '命令被路径隔离策略拦截：不能引用工作区外路径、HOME 或上级目录。';
    }
    if (name === 'run_command' && !settings.allowSensitiveFiles && SENSITIVE_COMMAND.test(String(args.command ?? ''))) {
      return '命令被隐私策略拦截：不能通过终端访问敏感文件。';
    }
    return undefined;
  }

  private async resolvePath(input: string): Promise<ResolvedPath> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) throw new Error('当前没有打开的工作区。');
    const value = input?.trim() || '.';
    const absoluteCandidate = isAbsolute(value) ? resolve(value) : undefined;
    const normalized = value.replaceAll('\\', '/');
    for (let index = 0; index < folders.length; index += 1) {
      const folder = folders[index]!;
      const root = resolve(folder.uri.fsPath);
      let relativeInput = value;
      if (!absoluteCandidate && folders.length > 1) {
        if (normalized === folder.name) relativeInput = '.';
        else if (normalized.startsWith(`${folder.name}/`)) relativeInput = normalized.slice(folder.name.length + 1);
        else if (index > 0) continue;
      }
      const candidate = absoluteCandidate ?? resolve(root, relativeInput);
      if (!isWithin(root, candidate)) continue;
      const actual = await safeRealpath(candidate);
      const realRoot = await safeRealpath(root);
      if (!isWithin(realRoot, actual)) throw new Error('路径通过符号链接离开了工作区。');
      return {
        uri: vscode.Uri.file(candidate),
        fsPath: candidate,
        relativePath: workspaceRelativePath(vscode.Uri.file(candidate)),
        folder,
      };
    }
    throw new Error('路径必须位于当前工作区内。');
  }

  private assertReadable(path: ResolvedPath, settings: ChatSettings): void {
    if (!settings.allowSensitiveFiles && isSensitivePath(path.relativePath)) {
      throw new Error(`已阻止读取敏感文件：${path.relativePath}。可在设置中显式允许。`);
    }
  }

  private assertWritable(path: ResolvedPath, settings: ChatSettings): void {
    this.assertReadable(path, settings);
    if (!this.isWorkspaceTrusted()) throw new Error('当前工作区未受信任，不能写入文件。');
  }

  private async auditResult(call: ToolCall, result: ToolExecutionResult, conversationId?: string): Promise<void> {
    await this.audit.record({
      timestamp: Date.now(),
      conversationId,
      callId: call.id,
      tool: call.function.name,
      status: result.status,
      approval: result.approval,
      summary: result.summary,
      changedFiles: result.changedFiles,
    });
  }

  private definition(name: string, description: string, parameters: Record<string, unknown>): ToolDefinition {
    return { type: 'function', function: { name, description, parameters } };
  }
}

function riskFor(name: string): ToolApprovalRequest['risk'] {
  if (['write_file', 'replace_in_file', 'rename_file', 'delete_file'].includes(name)) return 'write';
  if (name === 'run_command') return 'command';
  return 'read';
}

function policyFor(risk: ToolApprovalRequest['risk'], settings: ChatSettings): PermissionPolicy {
  if (risk === 'write') return settings.fileWritePolicy;
  if (risk === 'command') return settings.commandPolicy;
  return settings.fileReadPolicy;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具参数必须是 JSON 对象。');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`工具参数无效：${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringArg(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串。`);
  return value;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function success(summary: string, content: string): ToolExecutionResult {
  return { status: 'success', summary, content, approval: 'not-required' };
}

function deniedResult(summary: string): ToolExecutionResult {
  return { status: 'denied', summary, content: summary, approval: 'denied' };
}

function approvalSummary(name: string, args: Record<string, unknown>): string {
  if (name === 'run_command') return `运行命令：${redact(String(args.command ?? '')).slice(0, 180)}`;
  if (name === 'rename_file') return `移动文件：${String(args.from ?? '')} → ${String(args.to ?? '')}`;
  if (name === 'delete_file') return `删除文件：${String(args.path ?? '')}`;
  if (name === 'write_file' || name === 'replace_in_file') return `修改文件：${String(args.path ?? '')}`;
  return `读取工作区数据：${name}`;
}

function approvalDetail(name: string, args: Record<string, unknown>): string {
  if (name === 'write_file') return `目标：${String(args.path ?? '')}\n写入内容：${String(args.content ?? '').length.toLocaleString()} 字符`;
  if (name === 'replace_in_file') return `目标：${String(args.path ?? '')}\n精确替换：${String(args.oldText ?? '').length.toLocaleString()} -> ${String(args.newText ?? '').length.toLocaleString()} 字符`;
  if (name === 'rename_file') return `来源：${String(args.from ?? '')}\n目标：${String(args.to ?? '')}`;
  if (name === 'delete_file') return `目标：${String(args.path ?? '')}\n文件将移到系统废纸篓。`;
  if (name === 'run_command') return `工作目录：${String(args.cwd ?? '.')}\n命令：${redact(String(args.command ?? '')).slice(0, 1_000)}`;
  return JSON.stringify(args, null, 2).slice(0, 1_000);
}

function isSensitivePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return SENSITIVE_NAMES.test(normalized) || SENSITIVE_PARTS.test(normalized);
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function workspaceRelativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}

async function safeRealpath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    const parent = dirname(value);
    if (parent === value) return resolve(value);
    return resolve(await safeRealpath(parent), value.slice(parent.length + 1));
  }
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error('该文件似乎是二进制文件，未加入模型上下文。');
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = value.slice(0, Math.max(1, Math.floor(maxBytes * 0.75)));
  while (Buffer.byteLength(result) > maxBytes - 80) result = result.slice(0, -256);
  return `${result}\n… [输出已截断，原始大小 ${Buffer.byteLength(value).toLocaleString()} 字节]`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function lineDelta(before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/).length;
  const afterLines = after.split(/\r?\n/).length;
  const delta = afterLines - beforeLines;
  return `${afterLines} 行（${delta >= 0 ? '+' : ''}${delta}）`;
}

function spawnCommand(command: string, cwd: string, timeoutSeconds: number, maxOutputBytes: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: sanitizedEnvironment() });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = String(chunk);
      if (target === 'stdout') stdout = truncate(`${stdout}${text}`, maxOutputBytes);
      else stderr = truncate(`${stderr}${text}`, maxOutputBytes);
    };
    child.stdout?.on('data', (chunk) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk) => collect('stderr', chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_500).unref();
    }, timeoutSeconds * 1_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTHORIZATION|CREDENTIAL)/i.test(key)),
  );
}
