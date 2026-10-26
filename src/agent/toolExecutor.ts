import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { readSettings } from '../core/settings';
import { tt } from '../core/i18n';
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
import { commandPathViolation } from './commandPaths';
import { isPathWithin, normalizeWorkspaceGlob, resolveWorkspacePath } from './workspacePaths';
import { CommandRiskTier, classifyCommandTier, commandPolicyFor, isAutonomousPreset, sensitiveFilePolicyFor } from '../core/permissions';

export interface ToolApprovalRequest {
  callId: string;
  name: string;
  summary: string;
  detail: string;
  risk: 'read' | 'write' | 'command';
}

export type RequestApproval = (request: ToolApprovalRequest) => Promise<boolean>;

export interface ExternalExecutionOptions {
  conversationId?: string;
  /** 名称/描述命中破坏性关键词时强制确认（不适用于委托授权的 VS Code 工具）。 */
  forceApproval?: boolean;
  /** true 表示把授权交给外部系统（VS Code 工具自己的确认 UI），HWChat 不再弹窗。 */
  delegateApproval?: boolean;
}

interface ResolvedPath {
  uri: vscode.Uri;
  fsPath: string;
  relativePath: string;
  folder: vscode.WorkspaceFolder;
}

const DEFAULT_EXCLUDE = '**/{.git,node_modules,dist,build,out,.next,coverage}/**';
/** 指定了根目录前缀时，单根最多取这么多文件。 */
const ROOT_FILE_LIMIT = 1_000;
/** 未指定根目录时必须逐根查询，这是每个根目录各自的上限。 */
const PER_ROOT_FILE_LIMIT = 400;
/** 搜索时最多读取的文件数，避免“全工作区搜索”退化成无限 IO。 */
const SEARCH_FILE_BUDGET = 1_500;
const SENSITIVE_NAMES = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|service[-_]?account(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const SENSITIVE_PARTS = /(^|\/)(\.git|\.ssh|\.aws|\.kube)(\/|$)/i;

const SENSITIVE_COMMAND = /(^|[\s'"/])(?:\.env(?:\.[^\s'"]*)?|\.ssh|\.aws|\.kube|credentials?(?:\.[^\s'"]*)?|secrets?(?:\.[^\s'"]*)?|service[-_]?account(?:\.[^\s'"]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^\s'"]+\.(?:pem|key|p12|pfx))(?:[\s'"/]|$)/i;

/** 带路径参数、需要单独做敏感文件守卫的工具。 */
const PATH_TOOLS = ['list_directory', 'read_file', 'open_file', 'get_diagnostics', 'write_file', 'replace_in_file', 'rename_file', 'delete_file'];

export class ToolExecutor implements vscode.Disposable {
  constructor(
    private readonly audit: AuditLog,
    private readonly isWorkspaceTrusted: () => boolean,
  ) {}

  definitions(mode: ConversationMode): ToolDefinition[] {
    const readOnly: ToolDefinition[] = [
      this.definition('list_workspace_roots', tt('tool.listWorkspaceRoots.description'), {
        type: 'object', properties: {}, additionalProperties: false,
      }),
      this.definition('list_directory', tt('tool.listDirectory.description'), {
        type: 'object', properties: { path: { type: 'string', description: tt('tool.listDirectory.pathParam') } }, additionalProperties: false,
      }),
      this.definition('list_files', tt('tool.listFiles.description'), {
        type: 'object', properties: { glob: { type: 'string', description: tt('tool.listFiles.globParam') } }, required: ['glob'], additionalProperties: false,
      }),
      this.definition('search_files', tt('tool.searchFiles.description'), {
        type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' }, caseSensitive: { type: 'boolean' } }, required: ['query'], additionalProperties: false,
      }),
      this.definition('read_file', tt('tool.readFile.description'), {
        type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path'], additionalProperties: false,
      }),
      this.definition('open_file', tt('tool.openFile.description'), {
        type: 'object', properties: { path: { type: 'string', description: tt('tool.openFile.pathParam') }, preview: { type: 'boolean', description: tt('tool.openFile.previewParam') } }, required: ['path'], additionalProperties: false,
      }),
      this.definition('get_diagnostics', tt('tool.getDiagnostics.description'), {
        type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false,
      }),
    ];
    if (mode === 'plan') {
      return readOnly;
    }
    return [
      ...readOnly,
      this.definition('write_file', tt('tool.writeFile.description'), {
        type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false,
      }),
      this.definition('replace_in_file', tt('tool.replaceInFile.description'), {
        type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false,
      }),
      this.definition('rename_file', tt('tool.renameFile.description'), {
        type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false,
      }),
      this.definition('delete_file', tt('tool.deleteFile.description'), {
        type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
      }),
      this.definition('run_command', tt('tool.runCommand.description'), {
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
        summary: tt('tool.invalidArguments', { name: name || 'unknown_tool' }),
        content: error instanceof Error ? error.message : String(error),
        approval: 'not-required',
      };
      await this.auditResult(call, result, conversationId);
      return result;
    }
    const risk = riskFor(name);
    const tier: CommandRiskTier | undefined = risk === 'command'
      ? classifyCommandTier(String(args.command ?? ''))
      : undefined;
    const policy = policyFor(risk, settings, tier);
    const denied = this.checkAccess(name, args, mode, settings, policy, tier);
    if (denied) {
      const result = deniedResult(denied);
      await this.auditResult(call, result, conversationId);
      return result;
    }

    let approvalRequired = policy === 'ask';
    let approvalRequest: ToolApprovalRequest | undefined = approvalRequired
      ? {
        callId: call.id,
        name,
        summary: approvalSummary(name, args),
        detail: approvalDetail(name, args, tier),
        risk,
      }
      : undefined;

    // 敏感文件与危险命令各自还有独立的“逐次确认 / 禁止”策略。
    const sensitive = await this.sensitiveGuard(name, args, settings);
    if (sensitive.denied) {
      const result = deniedResult(sensitive.denied);
      await this.auditResult(call, result, conversationId);
      return result;
    }
    if (sensitive.ask && !approvalRequired) {
      approvalRequired = true;
      approvalRequest = {
        callId: call.id,
        name,
        summary: sensitive.summary!,
        detail: sensitive.detail!,
        risk,
      };
    }

    if (approvalRequest) {
      const approved = await requestApproval(approvalRequest);
      if (!approved) {
        const result = deniedResult(tt('tool.deniedByUser'));
        await this.auditResult(call, result, conversationId);
        return result;
      }
    }

    let result: ToolExecutionResult;
    try {
      switch (name) {
        case 'list_workspace_roots':
          result = await this.listWorkspaceRoots();
          break;
        case 'list_directory':
          result = await this.listDirectory(args, settings);
          break;
        case 'list_files':
          result = await this.listFiles(args);
          break;
        case 'search_files':
          result = await this.searchFiles(args, settings);
          break;
        case 'read_file':
          result = await this.readFile(args, settings);
          break;
        case 'open_file':
          result = await this.openFile(args, settings);
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
          result = deniedResult(tt('tool.unknownTool', { name }));
      }
    } catch (error) {
      result = {
        status: 'error',
        summary: tt('tool.executionFailed', { name }),
        content: truncate(redact(error instanceof Error ? error.message : String(error)), settings.maxToolOutputBytes),
        approval: approvalRequired ? 'approved' : 'not-required',
      };
    }
    result.approval = approvalRequired ? 'approved' : 'not-required';
    await this.auditResult(call, result, conversationId);
    return result;
  }

  async executeExternal(
    call: ToolCall,
    mode: ConversationMode,
    settings: ChatSettings,
    risk: ToolApprovalRequest['risk'],
    requestApproval: RequestApproval,
    summary: string,
    detail: string,
    invoke: () => Promise<ToolExecutionResult>,
    options: ExternalExecutionOptions = {},
  ): Promise<ToolExecutionResult> {
    const { conversationId, forceApproval = false, delegateApproval = false } = options;
    const policy = policyFor(risk, settings, risk === 'command' ? 'standard' : undefined);
    if (!delegateApproval && policy === 'deny') {
      const result = deniedResult(tt('tool.policyDenied', { kind: risk === 'read' ? tt('tool.policyKind.read') : risk === 'write' ? tt('tool.policyKind.write') : tt('tool.policyKind.command') }));
      await this.auditResult(call, result, conversationId);
      return result;
    }
    if (mode === 'plan' && risk !== 'read') {
      const result = deniedResult(tt('tool.planModeReadOnly'));
      await this.auditResult(call, result, conversationId);
      return result;
    }
    if (risk !== 'read' && !this.isWorkspaceTrusted()) {
      const result = deniedResult(tt('tool.untrustedWorkspace'));
      await this.auditResult(call, result, conversationId);
      return result;
    }
    // delegateApproval：VS Code 扩展工具是否弹窗由 VS Code 自己（prepareInvocation）决定，
    // HWChat 只负责记录审计，不再叠加一层确认。
    const approvalRequired = !delegateApproval
      && (policy === 'ask' || (forceApproval && !isAutonomousPreset(settings)));
    if (approvalRequired && !await requestApproval({
      callId: call.id,
      name: call.function.name,
      summary,
      detail,
      risk,
    })) {
      const result = deniedResult(tt('tool.deniedByUserTool'));
      await this.auditResult(call, result, conversationId);
      return result;
    }
    let result: ToolExecutionResult;
    try {
      result = await invoke();
      result.content = truncate(redact(result.content), settings.maxToolOutputBytes);
      result.approval = result.status === 'denied'
        ? 'denied'
        : approvalRequired
          ? 'approved'
          : 'not-required';
    } catch (error) {
      result = {
        status: 'error',
        summary: tt('tool.summaryFailed', { summary }),
        content: truncate(redact(error instanceof Error ? error.message : String(error)), settings.maxToolOutputBytes),
        approval: approvalRequired ? 'approved' : 'not-required',
      };
    }
    await this.auditResult(call, result, conversationId);
    return result;
  }

  async readAttachment(uri: vscode.Uri, settings = readSettings()): Promise<MessageContext> {
    const resolved = await this.resolvePath(uri.fsPath);
    this.assertReadable(resolved, settings);
    const stat = await vscode.workspace.fs.stat(resolved.uri);
    const mimeType = imageMimeType(resolved.fsPath);
    const maxBytes = mimeType ? Math.min(6 * 1024 * 1024, settings.maxReadBytes * 12) : settings.maxReadBytes;
    if (stat.size > maxBytes) {
      throw new Error(tt('tool.fileTooLarge', { size: formatBytes(stat.size), max: formatBytes(maxBytes) }));
    }
    const bytes = await vscode.workspace.fs.readFile(resolved.uri);
    if (mimeType) {
      return {
        label: resolved.relativePath,
        path: resolved.relativePath,
        kind: 'image',
        bytes: bytes.byteLength,
        mimeType,
        dataBase64: Buffer.from(bytes).toString('base64'),
      };
    }
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
    const { files, truncated } = await this.findWorkspaceFiles(args);
    const paths = files.map(workspaceRelativePath).sort();
    const summary = truncated ? tt('tool.filesFoundTruncated', { count: paths.length }) : tt('tool.filesFound', { count: paths.length });
    const note = truncated ? tt('tool.filesTruncatedNote') : '';
    return success(summary, (paths.join('\n') || tt('tool.noMatchingFiles')) + note);
  }

  /**
   * 解析 glob 的「根目录名前缀」，命中时把结果限制在该根目录内。
   * 与 path 参数共用同一套约定，避免带前缀的 glob 静默返回 0 条结果。
   *
   * 多根工作区必须逐根查询：findFiles 的上限是「所有根合计」，靠后的根目录
   * 会被整个吞掉，对外却只回答“找到 N 个文件”。真实会话里因此漏掉了用户的
   * 项目根，被误判成“这个目录下没有文件”。
   */
  private async findWorkspaceFiles(
    args: Record<string, unknown>,
  ): Promise<{ files: vscode.Uri[]; scoped: boolean; truncated: boolean }> {
    const requested = stringArg(args, 'glob', '**/*');
    const { glob, root } = normalizeWorkspaceGlob(requested, workspaceRoots());
    const limit = root ? ROOT_FILE_LIMIT : PER_ROOT_FILE_LIMIT;
    if (root) {
      // 必须用 RelativePattern 把查询限定在该根目录内。若只传字符串 glob，
      // 多根工作区里 findFiles 会搜遍所有根、共享同一个上限：真实会话中第 17 个
      // 根（DeepSeek-HWChat）被前 16 个根挤掉，过滤后返回 0 个文件，还因为
      // files.length 撞到上限被标成「已达上限」，调用方只能判定“这里没有文件”。
      const folder = (vscode.workspace.workspaceFolders ?? []).find(
        (candidate) => candidate.uri.fsPath === root.fsPath,
      );
      const files = folder
        ? await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), DEFAULT_EXCLUDE, limit)
        : await vscode.workspace.findFiles(glob, DEFAULT_EXCLUDE, limit);
      return {
        files: files.filter((uri) => isPathWithin(root.fsPath, uri.fsPath)),
        scoped: true,
        truncated: files.length >= limit,
      };
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) {
      const files = await vscode.workspace.findFiles(glob, DEFAULT_EXCLUDE, limit);
      return { files, scoped: false, truncated: files.length >= limit };
    }
    const merged: vscode.Uri[] = [];
    let truncated = false;
    const perRoot: vscode.Uri[][] = [];
    for (const folder of folders) {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, glob),
        DEFAULT_EXCLUDE,
        limit,
      );
      if (found.length >= limit) truncated = true;
      perRoot.push(found);
    }
    // 按根轮转交错合并，而不是「第一个根的全部 → 第二个根的全部」。
    // 否则下游的扫描预算（SEARCH_FILE_BUDGET / 输出行数）会被最靠前的根吃光，
    // 后面的根永远轮不到，工具却回答“没有匹配”——真实会话里搜索第 17 个根
    // （DeepSeek-HWChat）就得到 0 处匹配，而该字符串确实存在。
    const longest = perRoot.reduce((max, list) => Math.max(max, list.length), 0);
    for (let index = 0; index < longest; index += 1) {
      for (const list of perRoot) {
        const uri = list[index];
        if (uri) merged.push(uri);
      }
    }
    return { files: merged, scoped: false, truncated };
  }

  private async listWorkspaceRoots(): Promise<ToolExecutionResult> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const lines = folders.map((folder, index) => `${index + 1}. ${folder.name}\t${folder.uri.fsPath}`);
    return success(tt('tool.workspaceRootsFound', { count: folders.length }), lines.join('\n') || tt('tool.noWorkspaceOpen'));
  }

  private async listDirectory(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const requestedPath = typeof args.path === 'string' ? args.path.trim() : '';
    const folders = vscode.workspace.workspaceFolders ?? [];
    // 多根工作区里不传 path 时，静默只列第一个根会把调用方带偏（真实会话里发生过：
    // 用户的项目在第二个根，工具却返回了第一个根的内容）。
    if (!requestedPath && folders.length > 1) {
      const blocks: string[] = [];
      for (const folder of folders) {
        const folderPath = await this.resolvePath(folder.name);
        this.assertReadable(folderPath, settings);
        blocks.push(`## ${folder.name}${tt('tool.folderItemCountSuffix', { count: await this.directoryRowCount(folderPath) })}\n${await this.directoryRows(folderPath)}`);
      }
      return success(tt('tool.workspaceRootsListed', { count: folders.length }), blocks.join('\n\n'));
    }
    const resolved = await this.resolvePath(requestedPath || '.');
    this.assertReadable(resolved, settings);
    const stat = await vscode.workspace.fs.stat(resolved.uri);
    if ((stat.type & vscode.FileType.Directory) === 0) throw new Error(tt('tool.notDirectory', { path: resolved.relativePath }));
    return success(
      tt('tool.listed', { path: resolved.relativePath, count: await this.directoryRowCount(resolved) }),
      await this.directoryRows(resolved),
    );
  }

  private async directoryRowCount(resolved: ResolvedPath): Promise<number> {
    return (await vscode.workspace.fs.readDirectory(resolved.uri)).slice(0, 500).length;
  }

  private async directoryRows(resolved: ResolvedPath): Promise<string> {
    const entries = await vscode.workspace.fs.readDirectory(resolved.uri);
    const rows = entries
      .sort(([leftName, leftType], [rightName, rightType]) => directoryRank(leftType) - directoryRank(rightType) || leftName.localeCompare(rightName))
      .slice(0, 500)
      .map(([name, type]) => `${fileTypeLabel(type)}\t${name}`);
    return rows.join('\n') || tt('tool.directoryEmpty');
  }

  private async searchFiles(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const query = stringArg(args, 'query');
    if (!query) throw new Error(tt('tool.queryEmpty'));
    const caseSensitive = Boolean(args.caseSensitive);
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const { files, truncated } = await this.findWorkspaceFiles(args);
    const matches: string[] = [];
    let scanned = 0;
    let budgetExhausted = false;
    for (const uri of files) {
      if (scanned >= SEARCH_FILE_BUDGET) {
        budgetExhausted = true;
        break;
      }
      scanned += 1;
      const resolved = await this.resolvePath(uri.fsPath);
      if (isSensitivePath(resolved.relativePath) && sensitiveFilePolicyFor(settings) !== 'allow') continue;
      const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined);
      if (!stat || stat.size > settings.maxReadBytes) continue;
      // 单个二进制或不可读文件不能中断整次搜索：它只是没有可搜索的文本。
      let text: string;
      try {
        text = decodeText(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        if (haystack.includes(needle) && matches.length < 120) {
          matches.push(`${workspaceRelativePath(uri)}:${index + 1}: ${line.trim().slice(0, 400)}`);
        }
      });
      if (matches.length >= 120) break;
    }
    const notes: string[] = [];
    if (truncated) notes.push(tt('tool.searchRangeNote'));
    if (budgetExhausted) notes.push(tt('tool.searchBudgetNote', { count: SEARCH_FILE_BUDGET }));
    const body = matches.join('\n') || tt('tool.noMatches');
    return success(
      tt('tool.matchesFound', { count: matches.length }),
      truncate(redact(notes.length ? `${body}\n… ${notes.join(' ')}` : body), settings.maxToolOutputBytes),
    );
  }

  private async readFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'));
    this.assertReadable(resolved, settings);
    const stat = await vscode.workspace.fs.stat(resolved.uri);
    if (stat.size > settings.maxReadBytes) {
      throw new Error(tt('tool.readFileTooLarge', { size: formatBytes(stat.size), max: formatBytes(settings.maxReadBytes) }));
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
      summary: tt('tool.readSummary', { path: resolved.relativePath, size: formatBytes(stat.size) }),
      content: text,
      approval: 'not-required',
    };
  }

  private async openFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'));
    this.assertReadable(resolved, settings);
    const stat = await vscode.workspace.fs.stat(resolved.uri);
    if ((stat.type & vscode.FileType.File) === 0) throw new Error(tt('tool.openFileOnlyFiles'));
    const document = await vscode.workspace.openTextDocument(resolved.uri);
    await vscode.window.showTextDocument(document, { preview: args.preview !== false, preserveFocus: false });
    return success(tt('tool.openedInEditor', { path: resolved.relativePath }), tt('tool.openedInEditorContent'));
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
      tt('tool.diagnosticsRead', { count: entries.length }),
      truncate(redact(entries.join('\n') || tt('tool.noDiagnostics')), settings.maxToolOutputBytes),
    );
  }

  private async writeFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'));
    this.assertWritable(resolved, settings);
    const content = stringArg(args, 'content');
    const maxWriteBytes = settings.maxReadBytes * 4;
    if (Buffer.byteLength(content) > maxWriteBytes) {
      throw new Error(tt('tool.writeTooLarge'));
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(resolved.fsPath)));
    const previousStat = await Promise.resolve(vscode.workspace.fs.stat(resolved.uri)).catch(() => undefined);
    const previous = previousStat && previousStat.size <= maxWriteBytes
      ? await Promise.resolve(vscode.workspace.fs.readFile(resolved.uri)).then(decodeText).catch(() => '')
      : '';
    await vscode.workspace.fs.writeFile(resolved.uri, new TextEncoder().encode(content));
    const summary = previousStat
      ? previous ? tt('tool.updatedFile', { path: resolved.relativePath, delta: lineDelta(previous, content) }) : tt('tool.updatedFileNoDelta', { path: resolved.relativePath })
      : tt('tool.createdFile', { path: resolved.relativePath });
    return { status: 'success', summary, content: `${summary}\n${tt('tool.fileWritten')}`, approval: 'approved', changedFiles: [resolved.relativePath] };
  }

  private async replaceInFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'));
    this.assertWritable(resolved, settings);
    const oldText = stringArg(args, 'oldText');
    const newText = stringArg(args, 'newText');
    if (!oldText) throw new Error(tt('tool.oldTextEmpty'));
    const stat = await vscode.workspace.fs.stat(resolved.uri);
    if (stat.size > settings.maxReadBytes) {
      throw new Error(tt('tool.replaceTooLarge', { size: formatBytes(stat.size), max: formatBytes(settings.maxReadBytes) }));
    }
    const current = decodeText(await vscode.workspace.fs.readFile(resolved.uri));
    const occurrences = current.split(oldText).length - 1;
    if (occurrences < 1) throw new Error(tt('tool.oldTextMissing'));
    if (occurrences > 1 && !Boolean(args.replaceAll)) {
      throw new Error(tt('tool.oldTextMultiple', { count: occurrences }));
    }
    const replacements = Boolean(args.replaceAll) ? occurrences : 1;
    const estimatedBytes = Buffer.byteLength(current)
      + replacements * (Buffer.byteLength(newText) - Buffer.byteLength(oldText));
    if (estimatedBytes > settings.maxReadBytes * 4) {
      throw new Error(tt('tool.replaceTooLargeAfter'));
    }
    const next = Boolean(args.replaceAll) ? current.split(oldText).join(newText) : current.replace(oldText, newText);
    await vscode.workspace.fs.writeFile(resolved.uri, new TextEncoder().encode(next));
    const summary = tt('tool.replaceSummary', { path: resolved.relativePath, count: Boolean(args.replaceAll) ? occurrences : 1 });
    return { status: 'success', summary, content: `${summary}\n${lineDelta(current, next)}`, approval: 'approved', changedFiles: [resolved.relativePath] };
  }

  private async renameFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const from = await this.resolvePath(stringArg(args, 'from'));
    const to = await this.resolvePath(stringArg(args, 'to'));
    this.assertWritable(from, settings);
    this.assertWritable(to, settings);
    const sourceStat = await vscode.workspace.fs.stat(from.uri);
    if ((sourceStat.type & vscode.FileType.File) === 0) throw new Error(tt('tool.renameOnlyFiles'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(to.fsPath)));
    await vscode.workspace.fs.rename(from.uri, to.uri, { overwrite: false });
    const summary = tt('tool.movedFile', { from: from.relativePath, to: to.relativePath });
    return { status: 'success', summary, content: summary, approval: 'approved', changedFiles: [from.relativePath, to.relativePath] };
  }

  private async deleteFile(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'));
    this.assertWritable(resolved, settings);
    const targetStat = await vscode.workspace.fs.stat(resolved.uri);
    if ((targetStat.type & vscode.FileType.File) === 0) throw new Error(tt('tool.deleteOnlyFiles'));
    await vscode.workspace.fs.delete(resolved.uri, { recursive: false, useTrash: true });
    const summary = tt('tool.trashedFile', { path: resolved.relativePath });
    return { status: 'success', summary, content: summary, approval: 'approved', changedFiles: [resolved.relativePath] };
  }

  private async runCommand(args: Record<string, unknown>, settings: ChatSettings): Promise<ToolExecutionResult> {
    const command = stringArg(args, 'command');
    if (!command || command.length > 4_000) throw new Error(tt('tool.commandEmpty'));
    const resolvedCwd = await this.resolvePath(stringArg(args, 'cwd', '.'));
    const timeout = Math.min(settings.maxCommandSeconds, Math.max(5, numberArg(args, 'timeoutSeconds', settings.maxCommandSeconds)));
    const result = await spawnCommand(command, resolvedCwd.fsPath, timeout, settings.maxToolOutputBytes);
    const output = redact([result.stdout, result.stderr].filter(Boolean).join('\n')).trim();
    return {
      status: result.code === 0 ? 'success' : 'error',
      summary: result.timedOut ? tt('tool.commandTimeout', { seconds: timeout }) : tt('tool.commandExit', { code: result.code ?? 'unknown' }),
      content: truncate(output || tt('tool.noOutput'), settings.maxToolOutputBytes),
      approval: 'approved',
    };
  }

  private checkAccess(
    name: string,
    args: Record<string, unknown>,
    mode: ConversationMode,
    settings: ChatSettings,
    policy: PermissionPolicy,
    tier?: CommandRiskTier,
  ): string | undefined {
    if (!['list_workspace_roots', 'list_directory', 'list_files', 'search_files', 'read_file', 'open_file', 'get_diagnostics', 'write_file', 'replace_in_file', 'rename_file', 'delete_file', 'run_command'].includes(name)) {
      return tt('tool.toolNotAllowed', { name });
    }
    if (policy === 'deny') {
      return tier === 'severe'
        ? tt('tool.dangerousDenied')
        : tt('tool.policyDeniedTool', { name });
    }
    if (mode === 'plan' && ['write_file', 'replace_in_file', 'rename_file', 'delete_file', 'run_command'].includes(name)) return tt('tool.planModeReadOnlyTool');
    if (['write_file', 'replace_in_file', 'rename_file', 'delete_file', 'run_command'].includes(name) && !this.isWorkspaceTrusted()) {
      return tt('tool.untrustedWrite');
    }
    if (name === 'run_command') {
      const roots = workspaceRoots();
      const cwd = (() => {
        try {
          return resolveWorkspacePath(String(args.cwd ?? '.'), roots, { exists: existsSync }).fsPath;
        } catch {
          return undefined;
        }
      })();
      const violation = commandPathViolation(
        String(args.command ?? ''),
        roots.map((root) => root.fsPath),
        cwd,
      );
      if (violation) return violation;
    }
    return undefined;
  }

  private async resolvePath(input: string): Promise<ResolvedPath> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const resolved = resolveWorkspacePath(
      input,
      folders.map((folder) => ({ folder, name: folder.name, fsPath: folder.uri.fsPath })),
      { exists: existsSync },
    );
    const actual = await safeRealpath(resolved.fsPath);
    const realRoot = await safeRealpath(resolved.root.fsPath);
    if (!isPathWithin(realRoot, actual)) throw new Error(tt('tool.symlinkEscape'));
    return {
      uri: vscode.Uri.file(resolved.fsPath),
      fsPath: resolved.fsPath,
      relativePath: workspaceRelativePath(vscode.Uri.file(resolved.fsPath)),
      folder: resolved.root.folder,
    };
  }

  /**
   * 敏感文件 / 危险命令的独立守卫：`allow` 直接放行，`deny` 直接拒绝，
   * `ask` 返回需要确认的内容（由调用方合并到同一次审批弹窗里）。
   */
  private async sensitiveGuard(
    name: string,
    args: Record<string, unknown>,
    settings: ChatSettings,
  ): Promise<{ denied?: string; ask?: boolean; summary?: string; detail?: string }> {
    const policy = sensitiveFilePolicyFor(settings);
    if (policy === 'allow') return {};

    const targets: string[] = [];
    if (name === 'run_command') {
      if (SENSITIVE_COMMAND.test(String(args.command ?? ''))) {
        targets.push(tt('tool.sensitiveCommandArg'));
      }
    } else if (PATH_TOOLS.includes(name)) {
      const fields = name === 'rename_file' ? ['from', 'to'] : ['path'];
      for (const field of fields) {
        const value = args[field];
        if (typeof value !== 'string' || !value.trim()) continue;
        try {
          const resolved = await this.resolvePath(value);
          if (isSensitivePath(resolved.relativePath)) targets.push(resolved.relativePath);
        } catch {
          // 路径解析失败由具体工具返回更精确的错误信息。
        }
      }
    }

    const unique = [...new Set(targets)];
    if (!unique.length) return {};
    if (policy === 'deny') {
      return {
        denied: tt('tool.sensitiveBlocked', { files: unique.join(tt('common.listSeparator')) }),
      };
    }
    return {
      ask: true,
      summary: name === 'run_command' ? tt('tool.sensitiveCommandRisk') : tt('tool.sensitiveAccess', { files: unique.join(tt('common.listSeparator')) }),
      detail: name === 'run_command'
        ? tt('tool.sensitiveCommandDetail', { command: redact(String(args.command ?? '')).slice(0, 1_000) })
        : tt('tool.sensitiveAccessDetail', { files: unique.join(tt('common.listSeparator')) }),
    };
  }

  private assertReadable(path: ResolvedPath, settings: ChatSettings): void {
    if (sensitiveFilePolicyFor(settings) === 'deny' && isSensitivePath(path.relativePath)) {
      throw new Error(tt('tool.sensitiveReadBlocked', { path: path.relativePath }));
    }
  }

  private assertWritable(path: ResolvedPath, settings: ChatSettings): void {
    this.assertReadable(path, settings);
    if (!this.isWorkspaceTrusted()) throw new Error(tt('tool.untrustedNoWrite'));
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

function imageMimeType(path: string): string | undefined {
  const extension = extname(path).toLocaleLowerCase();
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  } as Record<string, string>)[extension];
}

function riskFor(name: string): ToolApprovalRequest['risk'] {
  if (['write_file', 'replace_in_file', 'rename_file', 'delete_file'].includes(name)) return 'write';
  if (name === 'run_command') return 'command';
  return 'read';
}

function policyFor(
  risk: ToolApprovalRequest['risk'],
  settings: ChatSettings,
  tier?: CommandRiskTier,
): PermissionPolicy {
  if (risk === 'write') return settings.fileWritePolicy;
  if (risk === 'command') return commandPolicyFor(settings, tier ?? 'standard');
  return settings.fileReadPolicy;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(tt('tool.argsNotObject'));
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(tt('tool.argsInvalid', { error: error instanceof Error ? error.message : String(error) }));
  }
}

function stringArg(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new Error(tt('tool.paramMustBeString', { key }));
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
  if (name === 'run_command') return tt('tool.approvalRunCommand', { command: redact(String(args.command ?? '')).slice(0, 180) });
  if (name === 'rename_file') return tt('tool.approvalMoveFile', { from: String(args.from ?? ''), to: String(args.to ?? '') });
  if (name === 'delete_file') return tt('tool.approvalDeleteFile', { path: String(args.path ?? '') });
  if (name === 'write_file' || name === 'replace_in_file') return tt('tool.approvalModifyFile', { path: String(args.path ?? '') });
  return tt('tool.approvalReadData', { name });
}

function approvalDetail(name: string, args: Record<string, unknown>, tier?: CommandRiskTier): string {
  const prefix = tier === 'severe'
    ? tt('tool.detailSeverePrefix')
    : '';
  if (name === 'write_file') return `${prefix}${tt('tool.detailWriteFile', { path: String(args.path ?? ''), chars: String(args.content ?? '').length.toLocaleString() })}`;
  if (name === 'replace_in_file') return `${prefix}${tt('tool.detailReplaceInFile', { path: String(args.path ?? ''), old: String(args.oldText ?? '').length.toLocaleString(), new: String(args.newText ?? '').length.toLocaleString() })}`;
  if (name === 'rename_file') return `${prefix}${tt('tool.detailRenameFile', { from: String(args.from ?? ''), to: String(args.to ?? '') })}`;
  if (name === 'delete_file') return `${prefix}${tt('tool.detailDeleteFile', { path: String(args.path ?? '') })}`;
  if (name === 'run_command') return `${prefix}${tt('tool.detailRunCommand', { cwd: String(args.cwd ?? '.'), command: redact(String(args.command ?? '')).slice(0, 1_000) })}`;
  return `${prefix}${JSON.stringify(args, null, 2).slice(0, 1_000)}`;
}

function isSensitivePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return SENSITIVE_NAMES.test(normalized) || SENSITIVE_PARTS.test(normalized);
}

function workspaceRelativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}

/** 当前工作区根目录的轻量视图，供路径解析与 glob 前缀消解共用。 */
function workspaceRoots(): Array<{ name: string; fsPath: string }> {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
  }));
}

function directoryRank(type: vscode.FileType): number {
  return (type & vscode.FileType.Directory) !== 0 ? 0 : 1;
}

function fileTypeLabel(type: vscode.FileType): string {
  if ((type & vscode.FileType.Directory) !== 0) return tt('tool.dirTag');
  if ((type & vscode.FileType.SymbolicLink) !== 0) return tt('tool.linkTag');
  return tt('tool.fileTag');
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
  if (bytes.includes(0)) throw new Error(tt('tool.binaryFile'));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = value.slice(0, Math.max(1, Math.floor(maxBytes * 0.75)));
  while (Buffer.byteLength(result) > maxBytes - 80) result = result.slice(0, -256);
  return tt('tool.outputTruncated', { result, bytes: Buffer.byteLength(value).toLocaleString() });
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
  return tt('tool.lineDelta', { lines: afterLines, delta: `${delta >= 0 ? '+' : ''}${delta}` });
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
