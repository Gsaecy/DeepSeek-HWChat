import { fetchUrl, searchGitHubRepos, searchWeb } from './webResearch';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
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
import { gitWriteOperation } from './conversationScope';
import { detectVersionBump, versionBumpCommand } from './releasePolicy';
import { CommandQueueFullError, CommandScheduler } from './commandScheduler';
import { SearchQueueFullError, SearchResourceBusyError } from './searchScheduler';
import { disposeWorkspaceSearch, invalidateWorkspaceSearch, searchWorkspace, workspaceSearchGeneration, workspaceSearchStats } from './workspaceSearch';
import {
  OperationCancelledError,
  describeTransientResourceError,
  withTransientRetry,
} from './transientErrors';


/**
 * 一次工具调用所属的对话作用域。
 *
 * - `projectRoot`：本次对话绑定的项目根。多根工作区里它决定相对路径的归属，
 *   也决定 git 写操作允许落在哪个仓库；未绑定时 `'.'` 仍按旧行为落到第一个根。
 * - `gitWriteAllowed`：用户本轮**明确要求**（或已启用技能规则要求）git 写操作。
 *   为 false 时所有 git 写操作一律拒绝——HWChat 不主动提交。
 * - `versionBumpAllowed`：用户本轮**明确要求**（或已启用技能规则要求）升级项目版本号。
 *   为 false 时改动版本清单里的 version 字段、以及 `npm version` 这类命令一律拒绝——
 *   HWChat 也不主动升版本，只在任务完成后询问。
 * - `bindProjectRoot`：首次确定项目根时回调，由面板写回对话存档。
 * - `touchProjectRoot`：**每次**改动落盘成功都回调一次「这次动的是哪个工作区根」。首次绑定的
 *   那个之外，后续改到别的项目也要记下来，否则标题旁的徽标永远只显示第一个项目，用户看不出
 *   这条对话还动过别的项目。只在改动成功之后回调：被拒绝或失败的调用没有改动任何文件。
 *
 * 注意：`ToolExecutor` 是跨对话共享的单例，作用域必须随调用传入，
 * 不能存成实例字段，否则多线程对话之间会互相污染。
 */
export interface ToolExecutionScope {
  projectRoot?: string;
  gitWriteAllowed?: boolean;
  versionBumpAllowed?: boolean;
  bindProjectRoot?: (fsPath: string) => void;
  touchProjectRoot?: (fsPath: string) => void;
  /**
   * 本条 Agent 运行的取消信号。
   *
   * 必须一路传到工具内部：没有它，用户点「停止」之后正在执行的
   * `search_files` 仍会读完整个仓库、`run_command` 仍会跑满 120 秒。
   */
  signal?: AbortSignal;
  /** 诊断用：本次运行的标识，和工具调用 id 配对写入结构化日志。 */
  turnId?: string;
  /**
   * 命令运行期的进度回调（每秒一次 + 停滞/超时事件）。
   * 由面板接上后，界面才能区分「在跑」和「卡住」——没有这条回调时，
   * 一条永久挂起的命令在界面上和正常运行长得一模一样。
   */
  onCommandProgress?: (progress: CommandProgress) => void;
}

/**
 * 一次工具调用的结构化诊断记录。
 *
 * 字段刻意保持扁平：日志、调试面板和测试共用同一份形状。
 * 不记录命令正文、文件内容或任何凭据。
 */
export interface ToolDiagnostic {
  turnId?: string;
  toolCallId: string;
  toolName: string;
  operation: string;
  queueWaitMs?: number;
  durationMs: number;
  activeSearches?: number;
  pendingSearches?: number;
  /** 累计的搜索重试次数（EAGAIN 一类资源错误才会重试）。 */
  searchRetries?: number;
  /** 累计被队列容量拒绝的搜索次数。 */
  searchRejected?: number;
  activeCommands?: number;
  queuedCommands?: number;
  resultCount?: number;
  truncated?: boolean;
  cancelled?: boolean;
  errorCode?: string;
}

/** 一次调用内部累积的度量，最后统一交给诊断回调。 */
interface CallMetrics {
  queueWaitMs?: number;
  resultCount?: number;
  truncated?: boolean;
  cancelled?: boolean;
  errorCode?: string;
}


/** 命令运行期的进度快照。`idleSeconds` 是「距离上次收到输出」的秒数。 */
export interface CommandProgress {
  /**
   * 只有两种「需要界面说话」的事件：
   *  - `stall`：无输出已超过阈值，每 10 秒刷一次（30 → 40 → 50…）；
   *  - `timeout`：到点要终止进程。
   *
   * 以前还有一个每秒一次的 `tick`：**没有任何消费者**（`agentRunner` 的进度回调
   * 第一行就是 `if (progress.phase !== 'stall') return`），它只是每秒构造一个对象、
   * 调一次回调。卡片上的「已运行 12.3 秒」是 webview 自己按 `startedAt` 每秒算的，
   * 不需要扩展推。删除后行为不变，少掉每秒一次的无效调用。
   */
  phase: 'stall' | 'timeout';
  elapsedSeconds: number;
  timeoutSeconds: number;
  idleSeconds: number;
  outputBytes: number;
}

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

/** 指定了根目录前缀时，单根最多取这么多文件。 */
const ROOT_FILE_LIMIT = 1_000;
/** 未指定根目录时必须逐根查询，这是每个根目录各自的上限。 */
const PER_ROOT_FILE_LIMIT = 400;
/** 搜索时最多读取的文件数，避免“全工作区搜索”退化成无限 IO。 */
const SEARCH_FILE_BUDGET = 1_500;
/**
 * 单次搜索最多读取的字节数。
 *
 * 文件数上限只能挡住「很多小文件」，挡不住「1500 个 512KB 的文件」：
 * 那一次工具调用就是几百 MB 读取 + 等量的字符串处理，Extension Host 的
 * CPU 会直接顶到 100%。字节预算先于文件数预算生效。
 */
const SEARCH_BYTE_BUDGET = 24 * 1024 * 1024;
/** 一次搜索最多回传多少处命中。 */
const SEARCH_MATCH_LIMIT = 120;
/**
 * 「查询 → 命中结果」的短期缓存时长。
 *
 * 只省重复扫描（模型换个措辞前常常先重发一次相同搜索），因此可以很短：
 * 任何写入/保存/删除都会让代数 +1，旧条目立刻不可达。
 */
const SEARCH_RESULT_TTL_MS = 2_000;
/** 结果缓存条目上限，防止一次性长任务把它撑大。 */
const SEARCH_RESULT_CACHE_LIMIT = 32;
const SENSITIVE_NAMES = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|service[-_]?account(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const SENSITIVE_PARTS = /(^|\/)(\.git|\.ssh|\.aws|\.kube)(\/|$)/i;

const SENSITIVE_COMMAND = /(^|[\s'"/])(?:\.env(?:\.[^\s'"]*)?|\.ssh|\.aws|\.kube|credentials?(?:\.[^\s'"]*)?|secrets?(?:\.[^\s'"]*)?|service[-_]?account(?:\.[^\s'"]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^\s'"]+\.(?:pem|key|p12|pfx))(?:[\s'"/]|$)/i;

/** 带路径参数、需要单独做敏感文件守卫的工具。 */
const PATH_TOOLS = ['list_directory', 'read_file', 'open_file', 'get_diagnostics', 'write_file', 'replace_in_file', 'rename_file', 'delete_file'];

export class ToolExecutor implements vscode.Disposable {
  /** 命令独立限流：搜索和命令抢的是不同资源，不能共用一个很小的全局并发。 */
  private readonly commands = new CommandScheduler(2, 8);
  /** 正在运行的子进程：扩展停用 / 面板释放时要整组杀掉，不留孤儿进程。 */
  /** 子进程 → 它属于哪一次运行（按 AbortSignal 归组，取消时能精确杀光）。 */
  private readonly children = new Map<ChildProcess, AbortSignal | undefined>();
  /** 相同查询的结果缓存；key 里带文件变化代数，写文件后自动失效。 */
  private readonly searchResults = new Map<string, { at: number; result: ToolExecutionResult; matches: number; truncated: boolean }>();
  private searchScans = 0;
  private searchCacheHits = 0;

  constructor(
    private readonly audit: AuditLog,
    private readonly isWorkspaceTrusted: () => boolean,
    private readonly onDiagnostic: (event: ToolDiagnostic) => void = () => undefined,
  ) {}

  /**
   * 工具清单。
   *
   * `internetReference` 打开时才追加三个联网工具：这是用户显式开启的能力，
   * 关着的时候工具清单里就不该出现（否则模型会自己去查网，而用户以为它没联网）。
   */
  definitions(mode: ConversationMode, options: { internetReference?: boolean } = {}): ToolDefinition[] {
    const research: ToolDefinition[] = options.internetReference
      ? [
        this.definition('search_github_repos', tt('tool.searchGithubRepos.description'), {
          type: 'object',
          properties: {
            query: { type: 'string', description: tt('tool.searchGithubRepos.queryParam') },
            language: { type: 'string', description: tt('tool.searchGithubRepos.languageParam') },
            sort: { type: 'string', enum: ['stars', 'updated', 'best-match'], description: tt('tool.searchGithubRepos.sortParam') },
            limit: { type: 'integer', description: tt('tool.searchGithubRepos.limitParam') },
          },
          required: ['query'],
          additionalProperties: false,
        }),
        this.definition('search_web', tt('tool.searchWeb.description'), {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'integer' } },
          required: ['query'],
          additionalProperties: false,
        }),
        this.definition('fetch_url', tt('tool.fetchUrl.description'), {
          type: 'object',
          properties: { url: { type: 'string' }, maxChars: { type: 'integer' } },
          required: ['url'],
          additionalProperties: false,
        }),
      ]
      : [];
    const readOnly: ToolDefinition[] = [
      ...research,
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
    scope?: ToolExecutionScope,
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
    const policy = isResearchTool(name)
      // 联网工具不走「文件读取」策略：它读的不是你的文件，探不探网由「互联网参考」
      // 开关决定（每对话、默认关、来源与 SSRF 过滤另有硬检查）。若沿用 fileReadPolicy，
      // 默认的 askAll 档位下每搜一次都要点一次批准，一次调研十几次调用 —— 这一项
      // 的授权已经由开关本身给出，再逐次问一遍只是噪声。
      ? 'allow' as PermissionPolicy
      : policyFor(risk, settings, tier);
    const denied = this.checkAccess(name, args, mode, settings, policy, tier, scope);
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
    const sensitive = await this.sensitiveGuard(name, args, settings, scope);
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
    const metrics: CallMetrics = {};
    const startedAt = Date.now();
    try {
      switch (name) {
        case 'search_github_repos': {
          const outcome = await searchGitHubRepos(stringArg(args, 'query'), {
            language: typeof args.language === 'string' ? args.language : undefined,
            sort: typeof args.sort === 'string' ? args.sort : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          result = outcome.ok
            ? success(outcome.summary, outcome.content)
            : { status: 'error', summary: outcome.summary, content: outcome.content, approval: 'not-required' };
          break;
        }
        case 'search_web': {
          const outcome = await searchWeb(stringArg(args, 'query'), typeof args.limit === 'number' ? args.limit : undefined);
          result = outcome.ok
            ? success(outcome.summary, outcome.content)
            : { status: 'error', summary: outcome.summary, content: outcome.content, approval: 'not-required' };
          break;
        }
        case 'fetch_url': {
          const outcome = await fetchUrl(stringArg(args, 'url'), typeof args.maxChars === 'number' ? args.maxChars : undefined);
          result = outcome.ok
            ? success(outcome.summary, outcome.content)
            : { status: 'error', summary: outcome.summary, content: outcome.content, approval: 'not-required' };
          break;
        }
        case 'list_workspace_roots':
          result = await this.listWorkspaceRoots();
          break;
        case 'list_directory':
          result = await this.listDirectory(args, settings, scope);
          break;
        case 'list_files':
          result = await this.listFiles(args, scope, metrics);
          break;
        case 'search_files':
          result = await this.searchFiles(args, settings, scope, metrics);
          break;
        case 'read_file':
          result = await this.readFile(args, settings, scope);
          break;
        case 'open_file':
          result = await this.openFile(args, settings, scope);
          break;
        case 'get_diagnostics':
          result = await this.getDiagnostics(args, settings, scope);
          break;
        case 'write_file':
          result = await this.writeFile(args, settings, scope);
          break;
        case 'replace_in_file':
          result = await this.replaceInFile(args, settings, scope);
          break;
        case 'rename_file':
          result = await this.renameFile(args, settings, scope);
          break;
        case 'delete_file':
          result = await this.deleteFile(args, settings, scope);
          break;
        case 'run_command':
          result = await this.runCommand(args, settings, scope, metrics);
          break;
        default:
          result = deniedResult(tt('tool.unknownTool', { name }));
      }
    } catch (error) {
      metrics.errorCode = errorCodeFor(error);
      metrics.cancelled = error instanceof OperationCancelledError || Boolean(scope?.signal?.aborted);
      result = {
        status: 'error',
        summary: metrics.cancelled ? tt('tool.cancelled') : tt('tool.executionFailed', { name }),
        content: truncate(redact(error instanceof Error ? error.message : String(error)), settings.maxToolOutputBytes),
        approval: approvalRequired ? 'approved' : 'not-required',
      };
    } finally {
      this.reportDiagnostic(name, call.id, scope, metrics, startedAt);
    }
    result.approval = approvalRequired ? 'approved' : 'not-required';
    await this.auditResult(call, result, conversationId);
    return result;
  }

  private reportDiagnostic(
    toolName: string,
    toolCallId: string,
    scope: ToolExecutionScope | undefined,
    metrics: CallMetrics,
    startedAt: number,
  ): void {
    const search = workspaceSearchStats();
    try {
      this.onDiagnostic({
        turnId: scope?.turnId,
        toolCallId,
        toolName,
        operation: toolName,
        queueWaitMs: metrics.queueWaitMs,
        durationMs: Date.now() - startedAt,
        activeSearches: search?.active,
        pendingSearches: search?.queued,
        searchRetries: search?.retries,
        searchRejected: search?.rejected,
        activeCommands: this.commands.stats().active,
        queuedCommands: this.commands.stats().queued,
        resultCount: metrics.resultCount,
        truncated: metrics.truncated,
        cancelled: metrics.cancelled,
        errorCode: metrics.errorCode,
      });
    } catch {
      // 诊断永远不能影响工具调用本身。
    }
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

  /**
   * 读取附件。`settings` 必须由调用方给出**这条对话当前生效**的设置：
   * 以前这里默认 `readSettings()`，于是附件的敏感文件判定看的是全局默认值，
   * 与用户在当前对话里切换过的预设无关。
   */
  async readAttachment(uri: vscode.Uri, settings: ChatSettings): Promise<MessageContext> {
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

  /**
   * 扩展停用 / 工作区关闭时回收资源。
   *
   * 旧实现是空函数（注释写「executor owns no process handles」），实际后果是
   * 停用扩展后仍在运行的命令与排队的搜索继续存在——这正是「点了停止，CPU
   * 仍然 100%」的一个来源。现在：排队的命令全部取消，正在跑的命令整组杀掉，
   * 搜索调度器与它的缓存一起释放。
   */
  dispose(): void {
    this.commands.dispose();
    // 停用扩展 / 关工作区时同样不留活口：SIGKILL，不再等 1 秒。
    for (const child of this.children.keys()) {
      killProcessTree(child, 'SIGKILL');
    }
    this.children.clear();
    disposeWorkspaceSearch();
  }

  /**
   * 立刻杀光「某一次运行」拉起的全部进程，返回杀掉的数量。
   *
   * 为什么不能只靠 `AbortController.abort()`：abort 只是通知，真正杀进程发生在
   * 每个工具的取消分支里。只要有一个工具没走到取消分支（还在等自己的 IO、或命令
   * 正在调度器里排队），它的子进程就会活下来 —— 用户看到的就是「点了停止，
   * 后台还在跑」。这里按 `AbortSignal` 归组同步 SIGKILL，不依赖任何异步路径。
   */
  killRunProcesses(signal: AbortSignal | undefined): number {
    if (!signal) return 0;
    let killed = 0;
    for (const [child, owner] of this.children) {
      if (owner !== signal) continue;
      killProcessTree(child, 'SIGKILL');
      this.children.delete(child);
      killed += 1;
    }
    return killed;
  }

  private async listFiles(
    args: Record<string, unknown>,
    scope?: ToolExecutionScope,
    metrics?: CallMetrics,
  ): Promise<ToolExecutionResult> {
    const { files, truncated } = await this.findWorkspaceFiles(args, scope, metrics, 'list_files');
    const paths = files.map(workspaceRelativePath).sort();
    if (metrics) {
      metrics.resultCount = paths.length;
      metrics.truncated = truncated;
    }
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
    scope: ToolExecutionScope | undefined,
    metrics: CallMetrics | undefined,
    operation: 'list_files' | 'search_files',
  ): Promise<{ files: vscode.Uri[]; scoped: boolean; truncated: boolean }> {
    const requested = stringArg(args, 'glob', '**/*');
    const { glob, root } = normalizeWorkspaceGlob(requested, workspaceRoots());
    const limit = root ? ROOT_FILE_LIMIT : PER_ROOT_FILE_LIMIT;
    const signal = scope?.signal;
    throwIfCancelled(signal);

    if (root) {
      // 必须用 RelativePattern 把查询限定在该根目录内。若只传字符串 glob，
      // 多根工作区里 findFiles 会搜遍所有根、共享同一个上限：真实会话中第 17 个
      // 根（DeepSeek-HWChat）被前 16 个根挤掉，过滤后返回 0 个文件，还因为
      // files.length 撞到上限被标成「已达上限」，调用方只能判定“这里没有文件”。
      const search = await this.runSearch({ include: glob, limit, folder: root.fsPath, operation }, scope, metrics);
      return {
        files: search.outcome.files.filter((uri) => isPathWithin(root.fsPath, uri.fsPath)),
        scoped: true,
        truncated: search.outcome.truncated,
      };
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) {
      const search = await this.runSearch({ include: glob, limit, operation }, scope, metrics);
      return { files: search.outcome.files, scoped: false, truncated: search.outcome.truncated };
    }
    const merged: vscode.Uri[] = [];
    let truncated = false;
    const perRoot: vscode.Uri[][] = [];
    for (const folder of folders) {
      // 逐根查询（不能合并成一次）——但所有请求都进同一个调度器：
      // 串行执行、相同参数合并，多根工作区不会再「一次工具调用拉起十几个 rg」。
      throwIfCancelled(signal);
      const search = await this.runSearch({ include: glob, limit, folder: folder.uri.fsPath, operation }, scope, metrics);
      if (search.outcome.truncated) truncated = true;
      perRoot.push(search.outcome.files);
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

  /** 统一入口：任何工作区搜索都必须走调度器（并发上限 / 去重 / 短期缓存 / 退避重试）。 */
  private async runSearch(
    params: { include: string; limit: number; folder?: string; operation: string },
    scope: ToolExecutionScope | undefined,
    metrics: CallMetrics | undefined,
  ) {
    try {
      const result = await searchWorkspace(params, { signal: scope?.signal });
      if (metrics) {
        metrics.queueWaitMs = Math.max(metrics.queueWaitMs ?? 0, result.queueWaitMs);
      }
      return result;
    } catch (error) {
      if (error instanceof OperationCancelledError || scope?.signal?.aborted) throw error;
      if (error instanceof SearchQueueFullError) {
        throw codedError(tt('tool.searchQueueFull', { count: error.capacity }), error.code);
      }
      if (error instanceof SearchResourceBusyError) {
        throw codedError(tt('tool.searchResourceBusy', { code: error.resourceCode, attempts: error.attempts }), error.resourceCode);
      }
      throw error;
    }
  }

  private async listWorkspaceRoots(): Promise<ToolExecutionResult> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const lines = folders.map((folder, index) => `${index + 1}. ${folder.name}\t${folder.uri.fsPath}`);
    return success(tt('tool.workspaceRootsFound', { count: folders.length }), lines.join('\n') || tt('tool.noWorkspaceOpen'));
  }

  private async listDirectory(args: Record<string, unknown>, settings: ChatSettings, scope?: ToolExecutionScope): Promise<ToolExecutionResult> {
    const requestedPath = typeof args.path === 'string' ? args.path.trim() : '';
    const folders = vscode.workspace.workspaceFolders ?? [];
    // 多根工作区里不传 path 时，静默只列第一个根会把调用方带偏（真实会话里发生过：
    // 用户的项目在第二个根，工具却返回了第一个根的内容）。
    if (!requestedPath && folders.length > 1) {
      const blocks: string[] = [];
      for (const folder of folders) {
        const folderPath = await this.resolvePath(folder.name, scope);
        this.assertReadable(folderPath, settings);
        blocks.push(`## ${folder.name}${tt('tool.folderItemCountSuffix', { count: await this.directoryRowCount(folderPath) })}\n${await this.directoryRows(folderPath)}`);
      }
      return success(tt('tool.workspaceRootsListed', { count: folders.length }), blocks.join('\n\n'));
    }
    const resolved = await this.resolvePath(requestedPath || '.', scope);
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

  private async searchFiles(
    args: Record<string, unknown>,
    settings: ChatSettings,
    scope?: ToolExecutionScope,
    metrics?: CallMetrics,
  ): Promise<ToolExecutionResult> {
    const query = stringArg(args, 'query');
    if (!query) throw new Error(tt('tool.queryEmpty'));
    const caseSensitive = Boolean(args.caseSensitive);
    const needle = caseSensitive ? query : query.toLowerCase();
    /**
     * 相同查询直接复用上一次的命中结果。
     *
     * 只去重「文件列表」并不够：真正贵的是把文件读进来逐行匹配，旧实现每次
     * 重发同一条搜索都要再扫一遍最多 1500 个文件。key 带上文件变化代数，
     * 所以写入/保存/删除之后绝不会返回过期命中。
     */
    const cacheKey = [
      String(workspaceSearchGeneration()),
      caseSensitive ? 'cs' : 'ci',
      query,
      stringArg(args, 'glob', '**/*'),
      String(scope?.projectRoot ?? ''),
    ].join('\u0000');
    const cached = this.searchResults.get(cacheKey);
    if (cached && Date.now() - cached.at <= SEARCH_RESULT_TTL_MS) {
      this.searchCacheHits += 1;
      if (metrics) {
        metrics.resultCount = cached.matches;
        metrics.truncated = cached.truncated;
      }
      return { ...cached.result };
    }
    const { files, truncated } = await this.findWorkspaceFiles(args, scope, metrics, 'search_files');
    const matches: string[] = [];
    let scanned = 0;
    let scannedBytes = 0;
    let budgetExhausted = false;
    let byteBudgetExhausted = false;
    const policy = sensitiveFilePolicyFor(settings);
    for (const uri of files) {
      // 取消检查放在每个文件之前：Stop 之后绝不再读下一个文件。
      throwIfCancelled(scope?.signal);
      if (matches.length >= SEARCH_MATCH_LIMIT) break;
      if (scanned >= SEARCH_FILE_BUDGET) {
        budgetExhausted = true;
        break;
      }
      if (scannedBytes >= SEARCH_BYTE_BUDGET) {
        byteBudgetExhausted = true;
        break;
      }
      // 符号链接逃出工作区 / 路径解析失败时只跳过这一项：
      // 旧实现会让整次搜索因为一个逃逸链接而失败。
      const resolved = await this.resolvePath(uri.fsPath, scope).catch(() => undefined);
      if (!resolved) continue;
      if (isSensitivePath(resolved.relativePath) && policy !== 'allow') continue;
      const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined);
      if (!stat || stat.size > settings.maxReadBytes) continue;
      scanned += 1;
      scannedBytes += stat.size;
      // 单个二进制或不可读文件不能中断整次搜索：它只是没有可搜索的文本。
      let text: string;
      try {
        text = decodeText(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
      // 先对整篇文本做一次大小写归一，再判断「有没有命中」：
      // 绝大多数文件都不含目标字符串，这样连按行拆分都不用做。
      // 旧实现无条件 split + 逐行 toLocaleLowerCase（locale 版本比 toLowerCase 慢很多），
      // 1500 个文件就是几十万次无用转换——这是 Extension Host CPU 打满的直接来源之一。
      const haystackText = caseSensitive ? text : text.toLowerCase();
      if (!haystackText.includes(needle)) continue;
      const haystackLines = haystackText.split(/\r?\n/);
      const rawLines = caseSensitive ? haystackLines : text.split(/\r?\n/);
      for (let index = 0; index < haystackLines.length && matches.length < SEARCH_MATCH_LIMIT; index += 1) {
        if (!haystackLines[index]!.includes(needle)) continue;
        const line = rawLines[index] ?? '';
        matches.push(`${workspaceRelativePath(uri)}:${index + 1}: ${line.trim().slice(0, 400)}`);
      }
    }
    const notes: string[] = [];
    if (truncated) notes.push(tt('tool.searchRangeNote'));
    if (budgetExhausted) notes.push(tt('tool.searchBudgetNote', { count: SEARCH_FILE_BUDGET }));
    if (byteBudgetExhausted) {
      notes.push(tt('tool.searchByteBudgetNote', { size: formatBytes(SEARCH_BYTE_BUDGET) }));
    }
    if (metrics) {
      metrics.resultCount = matches.length;
      metrics.truncated = truncated || budgetExhausted || byteBudgetExhausted;
    }
    const body = matches.join('\n') || tt('tool.noMatches');
    const result = success(
      tt('tool.matchesFound', { count: matches.length }),
      truncate(redact(notes.length ? `${body}\n… ${notes.join(' ')}` : body), settings.maxToolOutputBytes),
    );
    this.searchScans += 1;
    this.rememberSearch(cacheKey, result, matches.length, metrics?.truncated === true);
    return result;
  }

  private rememberSearch(key: string, result: ToolExecutionResult, matches: number, truncated: boolean): void {
    if (this.searchResults.size >= SEARCH_RESULT_CACHE_LIMIT) {
      const oldest = this.searchResults.keys().next();
      if (!oldest.done) this.searchResults.delete(oldest.value);
    }
    this.searchResults.set(key, { at: Date.now(), result, matches, truncated });
  }

  private async readFile(args: Record<string, unknown>, settings: ChatSettings, scope?: ToolExecutionScope): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'), scope);
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

  private async openFile(args: Record<string, unknown>, settings: ChatSettings, scope?: ToolExecutionScope): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'), scope);
    this.assertReadable(resolved, settings);
    const stat = await vscode.workspace.fs.stat(resolved.uri);
    if ((stat.type & vscode.FileType.File) === 0) throw new Error(tt('tool.openFileOnlyFiles'));
    const document = await vscode.workspace.openTextDocument(resolved.uri);
    await vscode.window.showTextDocument(document, { preview: args.preview !== false, preserveFocus: false });
    return success(tt('tool.openedInEditor', { path: resolved.relativePath }), tt('tool.openedInEditorContent'));
  }

  private async getDiagnostics(args: Record<string, unknown>, settings: ChatSettings, scope?: ToolExecutionScope): Promise<ToolExecutionResult> {
    const path = args.path ? stringArg(args, 'path') : undefined;
    const uri = path ? (await this.resolvePath(path, scope)).uri : undefined;
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

  private async writeFile(args: Record<string, unknown>, settings: ChatSettings, scope?: ToolExecutionScope): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'), scope);
    this.assertWritable(resolved, settings);
    this.bindProjectRoot(scope, resolved);
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
    // 版本号是用户的决定：未被要求就不许改版本清单里的 version 字段。
    const bump = versionBumpBlockReason(resolved, previous, content, scope);
    if (bump) return bump;
    await vscode.workspace.fs.writeFile(resolved.uri, new TextEncoder().encode(content));
    invalidateWorkspaceSearch();
    this.recordProjectRoot(scope, resolved);
    const summary = previousStat
      ? previous ? tt('tool.updatedFile', { path: resolved.relativePath, delta: lineDelta(previous, content) }) : tt('tool.updatedFileNoDelta', { path: resolved.relativePath })
      : tt('tool.createdFile', { path: resolved.relativePath });
    return { status: 'success', summary, content: `${summary}\n${tt('tool.fileWritten')}`, approval: 'approved', changedFiles: [resolved.relativePath] };
  }

  private async replaceInFile(args: Record<string, unknown>, settings: ChatSettings, scope?: ToolExecutionScope): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'), scope);
    this.assertWritable(resolved, settings);
    this.bindProjectRoot(scope, resolved);
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
    const bump = versionBumpBlockReason(resolved, current, next, scope);
    if (bump) return bump;
    await vscode.workspace.fs.writeFile(resolved.uri, new TextEncoder().encode(next));
    invalidateWorkspaceSearch();
    this.recordProjectRoot(scope, resolved);
    const summary = tt('tool.replaceSummary', { path: resolved.relativePath, count: Boolean(args.replaceAll) ? occurrences : 1 });
    return { status: 'success', summary, content: `${summary}\n${lineDelta(current, next)}`, approval: 'approved', changedFiles: [resolved.relativePath] };
  }

  private async renameFile(args: Record<string, unknown>, settings: ChatSettings, scope?: ToolExecutionScope): Promise<ToolExecutionResult> {
    const from = await this.resolvePath(stringArg(args, 'from'), scope);
    const to = await this.resolvePath(stringArg(args, 'to'), scope);
    this.assertWritable(from, settings);
    this.assertWritable(to, settings);
    this.bindProjectRoot(scope, from);
    const sourceStat = await vscode.workspace.fs.stat(from.uri);
    if ((sourceStat.type & vscode.FileType.File) === 0) throw new Error(tt('tool.renameOnlyFiles'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(to.fsPath)));
    await vscode.workspace.fs.rename(from.uri, to.uri, { overwrite: false });
    invalidateWorkspaceSearch();
    // 跨项目移动时两端都要算：只在 from 记账会漏掉「文件被挪进了 B」。
    this.recordProjectRoot(scope, from, to);
    const summary = tt('tool.movedFile', { from: from.relativePath, to: to.relativePath });
    return { status: 'success', summary, content: summary, approval: 'approved', changedFiles: [from.relativePath, to.relativePath] };
  }

  private async deleteFile(args: Record<string, unknown>, settings: ChatSettings, scope?: ToolExecutionScope): Promise<ToolExecutionResult> {
    const resolved = await this.resolvePath(stringArg(args, 'path'), scope);
    this.assertWritable(resolved, settings);
    this.bindProjectRoot(scope, resolved);
    const targetStat = await vscode.workspace.fs.stat(resolved.uri);
    if ((targetStat.type & vscode.FileType.File) === 0) throw new Error(tt('tool.deleteOnlyFiles'));
    await vscode.workspace.fs.delete(resolved.uri, { recursive: false, useTrash: true });
    invalidateWorkspaceSearch();
    this.recordProjectRoot(scope, resolved);
    const summary = tt('tool.trashedFile', { path: resolved.relativePath });
    return { status: 'success', summary, content: summary, approval: 'approved', changedFiles: [resolved.relativePath] };
  }

  private async runCommand(
    args: Record<string, unknown>,
    settings: ChatSettings,
    scope?: ToolExecutionScope,
    metrics?: CallMetrics,
  ): Promise<ToolExecutionResult> {
    const command = stringArg(args, 'command');
    if (!command || command.length > 4_000) throw new Error(tt('tool.commandEmpty'));
    // cwd 缺省时落到「本次对话的项目根」：多根工作区里 `'.'` 以前会落到第一个根目录，
    // 于是「提交一下」可能提交掉了另一个项目。
    const explicitCwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
    const resolvedCwd = await this.resolvePath(explicitCwd ?? '.', scope);
    const gitWrite = gitWriteOperation(command);
    if (gitWrite) {
      const blocked = await this.gitWriteBlockReason(gitWrite.verb, resolvedCwd, explicitCwd, scope);
      if (blocked) return deniedResult(blocked);
    }
    // 版本号同理：`npm version` / `standard-version` 会直接改写清单并提交，未授权一律拒绝。
    const versionTool = versionBumpCommand(command);
    if (versionTool && !scope?.versionBumpAllowed) {
      return deniedResult(tt('tool.versionBumpCommandNotAuthorized', { command: versionTool }));
    }
    const timeout = Math.min(settings.maxCommandSeconds, Math.max(5, numberArg(args, 'timeoutSeconds', settings.maxCommandSeconds)));
    const commandStartedAt = Date.now();

    let result: SpawnResult;
    try {
      result = await this.commands.run(scope?.signal, async () => {
        // 命令本身也按「暂时性资源错误」重试：EAGAIN 是 fork 失败，
        // 命令根本没起来，退避后重来是安全的；一旦有输出就不再重试。
        const attempt = await withTransientRetry(
          () => spawnCommand(command, resolvedCwd.fsPath, timeout, settings.maxToolOutputBytes, scope?.onCommandProgress, {
            signal: scope?.signal,
            onSpawn: (child) => this.trackChild(child, scope?.signal),
          }),
          {
            signal: scope?.signal,
            onRetry: (info) => {
              if (metrics) metrics.errorCode = info.code;
              // 资源真的不够了：让调度器也收一收，别让排队中的命令立刻补位继续抢进程。
              this.commands.markResourcePressure(COMMAND_PRESSURE_COOLDOWN_MS);
            },
          },
        );
        return attempt.value;
      });
    } catch (error) {
      if (error instanceof CommandQueueFullError) {
        throw new Error(tt('tool.commandQueueFull', { count: error.capacity }));
      }
      throw error;
    }
    if (metrics) metrics.errorCode = undefined;
    if (result.cancelled) {
      if (metrics) metrics.cancelled = true;
      return {
        status: 'error',
        summary: tt('tool.commandCancelled'),
        content: tt('tool.commandCancelled'),
        approval: 'approved',
      };
    }
    const output = redact([result.stdout, result.stderr].filter(Boolean).join('\n')).trim();
    /**
     * 命令也要计入「涉及的项目」，但只认真正改动仓库状态的 git 写操作，且必须成功：
     * 只读命令（`git status`、`npm test`）不改任何文件，算进去会让徽标显示出这条对话
     * 根本没动过的项目，比漏掉更误导。
     */
    if (gitWrite && result.code === 0) this.recordProjectRoot(scope, resolvedCwd);
    return {
      status: result.code === 0 ? 'success' : 'error',
      summary: commandSummary(command, result, timeout, Date.now() - commandStartedAt),
      content: truncate(output || tt('tool.noOutput'), settings.maxToolOutputBytes),
      approval: 'approved',
    };
  }

  /** 诊断命令用：当前命令/子进程/搜索队列的实时计数。 */
  resourceStats(): {
    commands: ReturnType<CommandScheduler['stats']>;
    children: number;
    search: ReturnType<typeof workspaceSearchStats>;
    contentSearches: number;
    contentSearchCacheHits: number;
  } {
    return {
      commands: this.commands.stats(),
      children: this.children.size,
      search: workspaceSearchStats(),
      contentSearches: this.searchScans,
      contentSearchCacheHits: this.searchCacheHits,
    };
  }

  private trackChild(child: ChildProcess, signal?: AbortSignal): void {
    this.children.set(child, signal);
    const release = (): void => {
      this.children.delete(child);
    };
    child.once('close', release);
    child.once('error', release);
  }

  /**
   * git 写操作的准入判断，返回拒绝理由时一律不执行。
   *
   * 三道检查，缺一不可：
   * 1. 用户本轮是否明确要求（或已启用的技能规则要求）—— HWChat 不主动提交；
   * 2. 本次对话是否已绑定项目根 —— 没有绑定就不许猜，猜错的代价是提交错项目；
   * 3. git 仓库根必须就是该项目，且不能顺带罩住工作区里的其他项目。
   */
  private async gitWriteBlockReason(
    verb: string,
    cwd: ResolvedPath,
    explicitCwd: string | undefined,
    scope?: ToolExecutionScope,
  ): Promise<string | undefined> {
    if (!scope?.gitWriteAllowed) return tt('tool.gitWriteNotRequested', { operation: verb });

    let projectRoot = scope.projectRoot ? resolve(scope.projectRoot) : undefined;
    if (!projectRoot) {
      // 未绑定项目根时只接受**显式 cwd**：默认 cwd 落到第一个根目录恰恰是错的那一个。
      if (!explicitCwd) return tt('tool.gitProjectUnknown');
      projectRoot = resolve(cwd.folder.uri.fsPath);
      this.bindProjectRoot(scope, cwd);
    }

    const repoRoot = await gitRepositoryRoot(cwd.fsPath);
    if (!repoRoot) return tt('tool.gitNotRepository', { path: cwd.relativePath });

    const [repo, project] = await Promise.all([safeRealpath(repoRoot), safeRealpath(projectRoot)]);
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => resolve(folder.uri.fsPath));
    const repoIsWorkspaceRoot = roots.some((root) => root === repo);
    // 允许两种情形：仓库根就是项目根；或项目根在仓库根之内、而仓库根本身是一个工作区根。
    if (repo !== project && !(isPathWithin(repo, project) && repoIsWorkspaceRoot)) {
      return tt('tool.gitProjectMismatch', { repo, project });
    }
    // 仓库根不能顺带罩住别的工作区根，否则一次 `git add -A` 会收进其他项目的改动。
    const foreignRoot = roots.find((root) => root !== project && isPathWithin(repo, root));
    if (foreignRoot) return tt('tool.gitForeignProject', { project: foreignRoot, repo });
    return undefined;
  }

  /** 首次确定项目归属时写回对话存档；已绑定时不再改动，避免被后续读操作带偏。 */
  private bindProjectRoot(scope: ToolExecutionScope | undefined, resolved: ResolvedPath): void {
    if (!scope || scope.projectRoot || !scope.bindProjectRoot) return;
    scope.projectRoot = resolve(resolved.folder.uri.fsPath);
    scope.bindProjectRoot(scope.projectRoot);
  }

  /**
   * 记录「这次动的是哪个项目」。
   *
   * `bindProjectRoot` 只在**首次**绑定，回答的是「相对路径与 git 写操作归谁」；可一个
   * 对话经常横跨多个项目（在 A 里做功能、顺手把 B 的对接改掉）。只在首次绑定记账时，
   * 标题旁的项目徽标永远只有第一个项目，用户看不出这条对话到底动过别处。
   *
   * 只在**改动已经成功落盘之后**调用：被拒绝、被版本号策略拦下、或写失败的调用没有
   * 改动任何文件，不该让徽标凭空多出一个项目。
   */
  private recordProjectRoot(scope: ToolExecutionScope | undefined, ...items: ResolvedPath[]): void {
    if (!scope?.touchProjectRoot) return;
    for (const item of items) scope.touchProjectRoot(resolve(item.folder.uri.fsPath));
  }

  private checkAccess(
    name: string,
    args: Record<string, unknown>,
    mode: ConversationMode,
    settings: ChatSettings,
    policy: PermissionPolicy,
    tier?: CommandRiskTier,
    scope?: ToolExecutionScope,
  ): string | undefined {
    const accessError = toolAccessError(name, settings);
    if (accessError) return accessError;
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
      const preferredRoot = scope?.projectRoot
        ? roots.find((root) => resolve(root.fsPath) === resolve(scope.projectRoot!))
        : undefined;
      const cwd = (() => {
        try {
          return resolveWorkspacePath(String(args.cwd ?? '.'), roots, { exists: existsSync, preferredRoot }).fsPath;
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

  private async resolvePath(input: string, scope?: ToolExecutionScope): Promise<ResolvedPath> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map((folder) => ({ folder, name: folder.name, fsPath: folder.uri.fsPath }));
    const resolved = resolveWorkspacePath(
      input,
      roots,
      {
        exists: existsSync,
        // 本次对话已绑定项目根时，相对路径以它为准（含 `'.'`）。
        preferredRoot: scope?.projectRoot
          ? roots.find((root) => resolve(root.fsPath) === resolve(scope.projectRoot!))
          : undefined,
      },
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
    scope?: ToolExecutionScope,
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
          const resolved = await this.resolvePath(value, scope);
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

/**
 * 命令类工具在界面上的那一行摘要。
 *
 * 真实问题（用户截图，2026-10-31）：一次运行里出现 20 多行「命令退出码 0」——
 * 只写退出码，从列表里**完全看不出在干什么**，这正是「闷头做」在界面上的样子。
 * 而相邻的 `修改 X：替换 1 处文本` 带了对象，一眼就能读。
 *
 * 所以摘要带上**命令本身**（压成一行、默认截断 60 字符，够认出 `npm test` / `tsc`）
 * 与耗时。用户不必展开就能读懂整条执行流水；模型拿到的 `summary` 也更有信息量。
 *
 * 命令里可能出现 token / 密码（`curl -H "Authorization: ..."`），所以调用
 * `redactCommandForSummary` 先做一次脱敏 —— 摘要是给界面看、并随审计留下的。
 */
export function commandSummary(
  command: string,
  result: Pick<SpawnResult, 'code' | 'timedOut'>,
  timeoutSeconds: number,
  elapsedMs?: number,
): string {
  const shown = redactCommandForSummary(command);
  if (result.timedOut) return tt('tool.commandTimedOutSummary', { command: shown, seconds: timeoutSeconds });
  const code = result.code ?? 'unknown';
  const seconds = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? ` · ${(elapsedMs / 1000).toFixed(1)}s`
    : '';
  return tt('tool.commandExitSummary', { command: shown, code: String(code), seconds });
}

/** 摘要里显示命令：压成一行、去掉明显的凭据、超长截断。 */
export function redactCommandForSummary(command: string, limit = 60): string {
  const flat = String(command ?? '').replace(/\s+/g, ' ').trim();
  const redacted = flat
    /*
     * `-H "Authorization: Bearer xxx"` / `?token=xxx` / `API_KEY=xxx` 之类。
     *
     * 注意 `Bearer` / `Basic` 这类认证**方案名**后面紧跟的才是凭据：只脱掉方案名
     * 会把 `Bearer` 抹掉而把真正的 token 留在摘要里（第一版就漏了）。所以先吃掉
     * 可选的方案名，再把凭据整段替成 `***`。
     */
    .replace(
      /((?:authorization|token|api[_-]?key|secret|password|passwd|pwd)\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"'&]+/gi,
      '$1***',
    )
    .replace(/([?&](?:token|key|secret|signature|sig)=)[^&\s]+/gi, '$1***');
  return redacted.length <= limit ? redacted : `${redacted.slice(0, Math.max(1, limit - 1))}…`;
}

function riskFor(name: string): ToolApprovalRequest['risk'] {
  if (['write_file', 'replace_in_file', 'rename_file', 'delete_file'].includes(name)) return 'write';
  if (name === 'run_command') return 'command';
  return 'read';
}

/**
 * 本地工具（工作区读写与命令）。模型只能调用清单里的名字，凭空编出来的名字一律拒绝。
 *
 * 这张表与 `definitions()` 下发的清单必须一致：只要有一边漏了，就会出现
 * 「工具明明在清单里、真调用却回一句『未被允许』」的哑故障 —— `search_web`
 * 就是这么坏过一次（三个联网工具加进了 `definitions()`，忘了加进这里的白名单）。
 * `toolAccess.test.ts` 有一条不变量测试盯着：**凡是下发给模型的工具都必须能执行**。
 */
const LOCAL_TOOL_NAMES: readonly string[] = [
  'list_workspace_roots', 'list_directory', 'list_files', 'search_files', 'read_file',
  'open_file', 'get_diagnostics', 'write_file', 'replace_in_file', 'rename_file',
  'delete_file', 'run_command',
];

/**
 * 联网工具。只在「互联网参考」打开时下发，所以访问检查要**再问一次开关**：
 * 关着的时候这些名字根本没告诉过模型，真收到就是模型自己编的，不能替它联网。
 */
const RESEARCH_TOOL_NAMES: readonly string[] = ['search_github_repos', 'search_web', 'fetch_url'];

/** 是否是联网工具（联网工具不受「文件读取」策略管辖，见 `execute` 里的说明）。 */
export function isResearchTool(name: string): boolean {
  return RESEARCH_TOOL_NAMES.includes(name);
}

/**
 * 「这个工具名能不能执行」的唯一判据：能执行返回 `undefined`，否则返回拒绝原因。
 * 抽成纯函数是为了让「下发的工具清单」和「执行时的准入」可以用同一条测试对齐。
 */
export function toolAccessError(
  name: string,
  settings: Pick<ChatSettings, 'internetReference'>,
): string | undefined {
  if (LOCAL_TOOL_NAMES.includes(name)) return undefined;
  if (isResearchTool(name)) {
    // 读的是**本次运行开始时**的快照（`applyRuntimeControls`），所以这里的状态
    // 就是用户点这一轮时看到的状态，中途拨开关不会让同一轮前后不一致。
    return settings.internetReference ? undefined : tt('tool.internetReferenceRequired', { name });
  }
  return tt('tool.toolNotAllowed', { name });
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

/**
 * 版本号写入的准入判断：返回拒绝结果时一律不落盘。
 *
 * 只拦「项目版本号被改动」这一种情况：
 * - 非版本清单、新建文件、解析不出版本号 → 放行（不制造误报）；
 * - 只改依赖版本或代码 → 放行；
 * - 用户本轮明确要求（或技能规则要求）→ 放行。
 */
function versionBumpBlockReason(
  resolved: ResolvedPath,
  before: string,
  after: string,
  scope?: ToolExecutionScope,
): ToolExecutionResult | undefined {
  if (scope?.versionBumpAllowed) return undefined;
  const bump = detectVersionBump(basename(resolved.fsPath), before, after);
  if (!bump) return undefined;
  return deniedResult(tt('tool.versionBumpNotAuthorized', {
    file: resolved.relativePath,
    from: bump.from,
    to: bump.to,
  }));
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

/**
 * 取 git 仓库根。
 *
 * 用途是给 git 写操作划定边界：命令的 cwd 可能是一个仓库里的子目录，
 * 也可能根本不在仓库里（那就直接拒绝写操作）。用 `--show-toplevel` 而不是
 * 自己往上找 `.git`，是因为 worktree / submodule / `GIT_DIR` 环境变量这些
 * 情形下只有 git 自己知道真实边界。
 */
async function gitRepositoryRoot(cwd: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    // 网络盘 / 索引损坏时 git 可能长时间不返回；这里不该拖住整个工具调用。
    const timer = setTimeout(() => {
      killProcessTree(child, 'SIGKILL');
      finish(undefined);
    }, 5_000);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += String(chunk);
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => {
      const value = output.trim();
      finish(code === 0 && value ? value : undefined);
    });
  });
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error(tt('tool.binaryFile'));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * 一条命令输出的有界累积结果。
 *
 * `text` 是**保留下来**的部分，`bytes` 是它的大小，`totalBytes` 是这条流总共
 * 产出的字节数（用于「输出已截断，原始大小 N 字节」）。
 */
export interface BoundedText {
  readonly text: string;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export const EMPTY_BOUNDED_TEXT: BoundedText = Object.freeze({
  text: '',
  bytes: 0,
  totalBytes: 0,
  truncated: false,
});

/**
 * 追加一段命令输出，超过上限后**只计数、不再拼接**。
 *
 * 为什么需要它（真实性能缺陷）：旧实现每收到一个 data 事件就
 * `stdout = truncate(`${stdout}${chunk}`, max)`，而 `truncate` 先对整个
 * 字符串做一次 `Buffer.byteLength`（UTF-8 全量编码）再切片。也就是说每个
 * chunk 都要付出「当前缓冲区大小」的代价：留 200KB 输出时，一次 `npm test`
 * 或 watch 模式里每秒上千个 chunk，就是每秒几百 MB 的无谓编码与拷贝，
 * Extension Host 直接顶到 100%，而命令其实只是话多。
 *
 * 现在每个 chunk 只做与自己大小成正比的字节计数；只有越界的那一次做一次
 * 前缀截断，之后一律 O(1)。保留内容与旧实现一致：取输出**开头**的 75%
 * （与 `truncate` 相同的比例），并标记 `truncated`。
 */
export function appendBoundedText(buffer: BoundedText, chunk: string, maxBytes: number): BoundedText {
  if (!chunk) return buffer;
  const chunkBytes = Buffer.byteLength(chunk);
  const totalBytes = buffer.totalBytes + chunkBytes;
  if (buffer.truncated) {
    // 已经截断：后面的内容不再保留，只记账。内存与 CPU 都保持 O(chunk)。
    return { ...buffer, totalBytes };
  }
  const limit = Math.max(1, Math.floor(maxBytes));
  if (buffer.bytes + chunkBytes <= limit) {
    return {
      text: buffer.text + chunk,
      bytes: buffer.bytes + chunkBytes,
      totalBytes,
      truncated: false,
    };
  }
  // 只有越界的这一次需要拼接与按字节收边，之后走上面的 O(1) 分支。
  // 收边用二分找「最多多少个字符还放得下」：中文/emoji 一个字符 3~4 字节，
  // 按字符数直接切再逐段回退会在 CJK 输出上退化成上千次大字符串拷贝——
  // 那正是这次要消除的成本形态。二分只做 log2(n) 次前缀编码。
  const combined = `${buffer.text}${chunk}`;
  const headTarget = Math.max(1, Math.floor(Math.min(limit * 0.75, limit - 80)));
  let low = 0;
  let high = combined.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(combined.slice(0, mid)) <= headTarget) low = mid;
    else high = mid - 1;
  }
  // 别把代理对切成半个字符：切开后输出里会留下一个孤立代理项。
  if (low > 0) {
    const code = combined.charCodeAt(low - 1);
    if (code >= 0xd800 && code <= 0xdbff) low -= 1;
  }
  const head = combined.slice(0, low);
  return { text: head, bytes: Buffer.byteLength(head), totalBytes, truncated: true };
}

/** 把累积结果渲染成给模型看的文本（截断时补一行说明）。 */
export function renderBoundedText(buffer: BoundedText): string {
  if (!buffer.truncated) return buffer.text;
  return tt('tool.outputTruncated', { result: buffer.text, bytes: buffer.totalBytes.toLocaleString() });
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

/**
 * 按「整棵进程树」终止一个子进程。
 *
 * spawnCommand 用 `detached: true` 让 shell 成为新进程组的组长，所以只要按
 * 负 PID 发信号就能把 cargo / tail / qlmanage 这些孙进程一起带走。
 * 只杀 shell 会把它们留给 init，命令看起来结束了，CPU 却还在烧。
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== 'win32' && pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 组已经不存在 / 没有权限：退回只杀直接子进程。
    }
  }
  try {
    child.kill(signal);
  } catch {
    // 已经退出了。
  }
}

/** 取消检查：抛出去以后由调用方统一转成「已取消」的结果。 */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationCancelledError();
}

/** 附带错误码的错误：诊断日志要能区分 EAGAIN 与普通失败。 */
function codedError(message: string, code: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

/** 诊断用的错误码：优先用 Node 的 code，其次用我们自己的错误类。 */
function errorCodeFor(error: unknown): string | undefined {
  const transient = describeTransientResourceError(error);
  if (transient) return transient.code;
  if (error instanceof OperationCancelledError) return 'CANCELLED';
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code.toUpperCase();
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name) return name;
  }
  return undefined;
}

/** 无输出超过这个秒数就认为「可能卡住」，向界面提示（但不终止命令）。 */
const COMMAND_STALL_SECONDS = 30;
/** 停滞提示的刷新间隔：秒数必须跟着涨，冻在 30 秒的提示看着像界面又卡了。 */
export const COMMAND_STALL_REFRESH_SECONDS = 10;

/**
 * 是否该推一次停滞提示。
 *
 * 抽成纯函数是为了能在毫秒级单测里验证「秒数会涨」——
 * 否则要真等 40 秒才能测出这条行为，只能写没有意义的静态断言。
 */
export function shouldReportStall(
  idleSeconds: number,
  lastReportedIdle: number,
  stallAfterSeconds: number = COMMAND_STALL_SECONDS,
): boolean {
  if (idleSeconds < stallAfterSeconds) return false;
  if (lastReportedIdle < 0) return true;
  return idleSeconds - lastReportedIdle >= COMMAND_STALL_REFRESH_SECONDS;
}
/** 直接子进程退出后等 'close' 的宽限期：孙进程攥着管道时 'close' 永不触发。 */
const COMMAND_CLOSE_GRACE_MS = 1_500;
/** 超时并 SIGKILL 之后的硬结算上限：无论还有谁占着管道，这次调用都必须返回。 */
const COMMAND_HARD_SETTLE_MS = 3_000;
/** 命令侧遇到 EAGAIN 一类资源错误后的串行冷却（与搜索调度层同口径）。 */
const COMMAND_PRESSURE_COOLDOWN_MS = 5_000;

/**
 * 执行一条命令。
 *
 * 这里有三条「不许永久挂起」的硬性设计，都来自真实故障：
 * 1. `detached`：shell 成为新进程组的组长，超时按**整组**杀，不让 cargo/qlmanage
 *    这类孙进程变成孤儿（实测：只杀 shell 时，cargo 与 tail 的父进程变成 1，命令仍在跑）。
 * 2. stdin 显式接到 /dev/null：需要密码/确认的命令（sudo、ssh、不带 `-m` 的提交命令）
 *    立刻读到 EOF 失败，而不是无限等待一个永远不会到来的输入。
 * 3. 三重结算：'close' 正常结束 / 'exit' 后 1.5 秒宽限 / 超时后再 3 秒硬结算。
 *    只监听 'close' 时，孙进程活着就会让 Promise 永不 resolve——界面上表现为
 *    「准备运行命令」一直转，用户完全不知道发生了什么。
 */
export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 用户取消（AbortSignal）导致的提前结束。 */
  cancelled: boolean;
}

export interface SpawnOptions {
  /** 取消信号：触发后按整组 SIGTERM → SIGKILL，并立刻结算。 */
  signal?: AbortSignal;
  /** 子进程创建后回调，调用方据此登记「需要回收的进程」。 */
  onSpawn?: (child: ChildProcess) => void;
  /** 无输出多少秒后开始提示「可能卡住」。默认 30 秒；测试里调小即可毫秒级验证。 */
  stallSeconds?: number;
}

export function spawnCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  maxOutputBytes: number,
  onProgress?: (progress: CommandProgress) => void,
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new OperationCancelledError());
  }
  return new Promise((resolvePromise, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedEnvironment(),
    });
    const startedAt = Date.now();
    let stdout = EMPTY_BOUNDED_TEXT;
    let stderr = EMPTY_BOUNDED_TEXT;
    let outputBytes = 0;
    let lastOutputAt = startedAt;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let lastStallIdle = -1;
    let ticker: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let closeGrace: NodeJS.Timeout | undefined;
    let hardSettle: NodeJS.Timeout | undefined;

    const elapsedSeconds = () => Math.round((Date.now() - startedAt) / 100) / 10;
    const idleSeconds = () => Math.round((Date.now() - lastOutputAt) / 1000);
    const report = (progress: CommandProgress) => {
      // 通知失败绝不能影响命令本身
      try { onProgress?.(progress); } catch { /* 忽略 */ }
    };
    const stopTimers = () => {
      if (ticker) clearInterval(ticker);
      if (timer) clearTimeout(timer);
      if (closeGrace) clearTimeout(closeGrace);
      if (hardSettle) clearTimeout(hardSettle);
    };
    const killTree = (signal: NodeJS.Signals) => killProcessTree(child, signal);
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      stopTimers();
      options.signal?.removeEventListener('abort', onAbort);
      // 主动断开管道。孙进程还活着时 Node 会一直等流关闭，这是永久挂起的直接原因。
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({ code, stdout: renderBoundedText(stdout), stderr: renderBoundedText(stderr), timedOut, cancelled });
    };
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = String(chunk);
      lastOutputAt = Date.now();
      if (target === 'stdout') {
        stdout = appendBoundedText(stdout, text, maxOutputBytes);
        outputBytes = stdout.totalBytes;
      } else {
        stderr = appendBoundedText(stderr, text, maxOutputBytes);
        outputBytes = Math.max(outputBytes, stderr.totalBytes);
      }
    };
    child.stdout?.on('data', (chunk) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk) => collect('stderr', chunk));
    options.onSpawn?.(child);

    /**
     * 取消 = 立刻整组停下来。
     *
     * 旧实现根本没有接 signal：用户点「停止」只中断了模型流，正在跑的命令
     * 会照完自己的 120 秒超时，孙进程还继续占着 CPU。
     */
    const onAbort = (): void => {
      if (settled) return;
      cancelled = true;
      /*
       * 历史遗留的两处「假停止」：
       *  1. 先发 SIGTERM、1 秒后才 SIGKILL —— 忽略 SIGTERM 的进程（构建工具、
       *     `npm run dev` 这类自己管子进程的）在这一秒里继续跑，用户以为已经停了。
       *  2. 结算要等 `close` 或 4.5 秒硬兜底 —— 那段时间界面还显示「运行中」，
       *     进程其实早该死了，看起来就是「按了停止但后台还在跑」。
       *
       * 现在：直接 SIGKILL 整个进程组（没有忽略信号的可能），立刻断开管道并结算；
       * 250ms 再补一枪，覆盖「父进程刚收到信号时正在 fork 孙进程」这个竞态窗口。
       */
      killTree('SIGKILL');
      const sweep = setTimeout(() => killTree('SIGKILL'), 250);
      sweep.unref?.();
      // 孙进程还活着时 child 的 'close' 不会触发，等它就是假停止。
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(null);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (onProgress) {
      const stallAfter = Math.max(1, Math.round(options.stallSeconds ?? COMMAND_STALL_SECONDS));
      // 这个每秒一次的定时器现在只做两件便宜事：算一下空闲秒数、到点报一次停滞。
      // 没有观测量时不构造对象、不回调，也不再有每秒一次的 `tick`。
      ticker = setInterval(() => {
        if (settled) return;
        const idle = idleSeconds();
        if (idle < stallAfter) return;
        // 停滞提示每 10 秒刷一次（30 → 40 → 50…）：数字冻住比不显示更让人怀疑界面卡了。
        if (!shouldReportStall(idle, lastStallIdle, stallAfter)) return;
        lastStallIdle = idle;
        report({ phase: 'stall', elapsedSeconds: elapsedSeconds(), timeoutSeconds, idleSeconds: idle, outputBytes });
      }, 1_000);
      ticker.unref?.();
    }

    timer = setTimeout(() => {
      timedOut = true;
      report({ phase: 'timeout', elapsedSeconds: elapsedSeconds(), timeoutSeconds, idleSeconds: idleSeconds(), outputBytes });
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 1_500).unref();
      hardSettle = setTimeout(() => settle(null), COMMAND_CLOSE_GRACE_MS + COMMAND_HARD_SETTLE_MS);
      hardSettle.unref?.();
    }, timeoutSeconds * 1_000);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      stopTimers();
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('exit', (code) => {
      // 直接子进程退出 ≠ 管道关闭：孙进程可能还攥着 stdout。
      // 给 1.5 秒收尾，等不到就按已拿到的输出结算，不再无限期等待。
      closeGrace = setTimeout(() => settle(code), COMMAND_CLOSE_GRACE_MS);
      closeGrace.unref?.();
    });
    child.on('close', (code) => settle(code));
  });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTHORIZATION|CREDENTIAL)/i.test(key)),
  );
}
