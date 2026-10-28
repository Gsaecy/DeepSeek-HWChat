import {
  ChatRequestMessage,
  ChatSettings,
  ConversationMode,
  SkillUsage,
  ToolCall,
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
  UsageInfo,
} from '../core/types';
import { DeepSeekClient } from '../providers/deepseekClient';
import { redact } from './auditLog';
import type { AgentTaskUpdate } from './taskQueue';
import type { RequestApproval, ToolExecutionScope, ToolExecutor } from './toolExecutor';
import { tt } from '../core/i18n';
import { agentStepBudget } from '../core/settings';
import { OperationCancelledError } from './transientErrors';

export interface AgentRunCallbacks {
  onDelta: (delta: { content?: string; reasoning?: string; usage?: UsageInfo }) => void | Promise<void>;
  onToolsChanged: (tools: ToolExecution[]) => void | Promise<void>;
  requestApproval: RequestApproval;
  onSkillUsed?: (skill: SkillUsage) => void | Promise<void>;
  onTaskUpdate?: (update: AgentTaskUpdate) => void | Promise<void>;
  onRoundComplete?: (usage?: UsageInfo) => void | Promise<void>;
  /**
   * 命令长时间无输出时的主动提醒（每条命令只触发一次）。
   * 存在的理由：卡住的命令在界面上和正常运行的命令长得一样，
   * 只靠工具卡片变色不足以让用户注意到。
   */
  onCommandStall?: (info: { callId: string; idleSeconds: number; timeoutSeconds: number; summary: string }) => void | Promise<void>;
  /**
   * 运行期的**展示态**更新（目前只有「卡住 N 秒」这类提示）。
   *
   * 与 `onToolsChanged` 分开是因为两者的代价差一个数量级：`onToolsChanged` 表示工具
   * 状态真的变了，调用方会落盘整条消息；而停滞提示每 10 秒就刷一次，如果也走落盘，
   * 一条卡住几分钟的命令会白写十几次盘（实测每次 2.29ms + 首页缓存失效 2ms）。
   * 没有提供时退回 `onToolsChanged`，老调用方行为不变。
   */
  onToolHint?: (tools: ToolExecution[]) => void | Promise<void>;
}

/** 一次 Agent 运行为什么停下来。 */
export type AgentStopReason = 'complete' | 'stepLimit' | 'loopDetected' | 'noProgress' | 'toolBudget' | 'cancelled';

export interface AgentRunResult {
  content: string;
  reasoning: string;
  usage?: UsageInfo;
  tools: ToolExecution[];
  stoppedByStepLimit: boolean;
  stopReason: AgentStopReason;
}

/** 一轮里最多执行多少个工具调用；超出的部分返回说明并结束本轮。 */
export const MAX_TOOL_CALLS_PER_ROUND = 12;
/** 一次运行里最多执行多少个工具调用（绝对上限，独立于步数）。 */
export const MAX_TOOL_CALLS_PER_RUN = 200;
/** 连续多少次「完全相同的工具调用」就判定为死循环。 */
export const MAX_IDENTICAL_TOOL_CALLS = 3;
/** 连续多少轮「所有工具都失败」就停下，不再让模型空转。 */
export const MAX_FAILED_ROUNDS_WITHOUT_PROGRESS = 3;

function stopNoticeFor(reason: AgentStopReason, context: { maxSteps: number; loopToolName: string }): string {
  switch (reason) {
    case 'stepLimit':
      return tt('agent.stepLimit', { steps: context.maxSteps });
    case 'loopDetected':
      return tt('agent.loopDetected', { count: MAX_IDENTICAL_TOOL_CALLS, tool: context.loopToolName || 'unknown_tool' });
    case 'noProgress':
      return tt('agent.noProgress', { rounds: MAX_FAILED_ROUNDS_WITHOUT_PROGRESS });
    case 'toolBudget':
      return tt('agent.toolCallBudget', { count: MAX_TOOL_CALLS_PER_RUN, round: MAX_TOOL_CALLS_PER_ROUND });
    default:
      return '';
  }
}

/**
 * 连续相同工具调用的检测器。
 *
 * 只统计「紧挨着的完全相同的调用」（工具名 + 规范化后的参数）：这类重复
 * 在真实会话里几乎只有一种含义——模型没有拿到新信息却在下同一个指令。
 * 把它们挡在第三次之前执行，既不会误伤「反复读不同文件」这种正常行为，
 * 也堵死了「搜索失败 → 原样重试」的死循环。
 */
export class ToolLoopGuard {
  private lastSignature: string | undefined;
  private repeatCount = 0;

  observe(call: ToolCall): { blocked: boolean; count: number; tool: string } {
    const signature = `${call.function.name}\u0000${canonicalToolArguments(call.function.arguments)}`;
    if (signature === this.lastSignature) this.repeatCount += 1;
    else {
      this.lastSignature = signature;
      this.repeatCount = 1;
    }
    return { blocked: this.repeatCount >= MAX_IDENTICAL_TOOL_CALLS, count: this.repeatCount, tool: call.function.name };
  }
}

/** 参数规范化：JSON 键顺序不同也视为同一次调用。 */
export function canonicalToolArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    return JSON.stringify(sortKeys(parsed));
  } catch {
    return raw.trim().replace(/\s+/g, ' ');
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
  }
  return value;
}

export class AgentRunner {
  constructor(
    private readonly client: DeepSeekClient,
    private readonly tools: ToolExecutor,
  ) {}

  async run(options: {
    settings: ChatSettings;
    messages: ChatRequestMessage[];
    mode: ConversationMode;
    signal: AbortSignal;
    conversationId: string;
    /** 本次对话的项目边界与 git 授权；缺失时按旧行为（不额外限制）。 */
    scope?: ToolExecutionScope;
    callbacks: AgentRunCallbacks;
    extraTools?: ToolDefinition[];
    executeExtraTool?: (call: import('../core/types').ToolCall) => Promise<{ result: ToolExecutionResult; skill?: SkillUsage } | undefined>;
    takeTaskUpdate?: (phase: 'replan' | 'complete') => Promise<AgentTaskUpdate[]> | AgentTaskUpdate[];
  }): Promise<AgentRunResult> {
    const requestMessages = [...options.messages];
    const executions: ToolExecution[] = [];
    let content = '';
    let reasoning = '';
    let usage: UsageInfo | undefined;
    const definitions = options.mode === 'chat' ? [] : [...this.tools.definitions(options.mode), ...(options.extraTools ?? [])];
    /**
     * 单轮执行预算。
     *
     * 「无限制」是工具条上的第四档，表示 `0` → 这里换算成 `Infinity`：循环只在模型
     * 不再调用工具时结束，或由 `ToolLoopGuard`（同一调用重复）、连续无进展轮数、
     * 单次运行工具预算、用户取消这几道闸提前终止。负数 / 非数字这类脏值仍然回落
     * 到默认预算，不会被解释成无限。
     */
    const maxSteps = agentStepBudget(options.settings.agentMaxSteps);
    const turnId = `${options.conversationId}#${Date.now().toString(36)}`;
    const loopGuard = new ToolLoopGuard();
    let step = 0;
    let totalToolCalls = 0;
    let consecutiveFailedRounds = 0;
    let stopReason: AgentStopReason = 'complete';
    let stopNotice = '';
    let loopToolName = '';

    while (step < maxSteps) {
      step += 1;
      this.assertRunning(options.signal);
      const beforeRound = await options.takeTaskUpdate?.('replan') ?? [];
      for (const update of beforeRound) {
        await options.callbacks.onTaskUpdate?.(update);
        requestMessages.push(update.request);
      }
      const round = await this.client.streamChat(options.settings, requestMessages, {
        signal: options.signal,
        tools: definitions,
        onDelta: async (delta) => {
          if (delta.content) content += delta.content;
          if (delta.reasoning) reasoning += delta.reasoning;
          await options.callbacks.onDelta({
            content: delta.content,
            reasoning: delta.reasoning,
            usage: delta.usage,
          });
        },
      });
      usage = addUsage(usage, round.usage);
      await options.callbacks.onRoundComplete?.(round.usage);

      if (!round.toolCalls.length || options.mode === 'chat') {
        const guidance = await options.takeTaskUpdate?.('complete') ?? [];
        if (guidance.length) {
          requestMessages.push({
            role: 'assistant',
            content: round.content,
            reasoning_content: round.reasoning || undefined,
          });
          for (const update of guidance) {
            await options.callbacks.onTaskUpdate?.(update);
            requestMessages.push(update.request);
          }
          continue;
        }
        return { content, reasoning, usage, tools: executions, stoppedByStepLimit: false, stopReason: 'complete' };
      }

      // 这一轮的文字属于「行动说明」：后面还会调用工具，模型随后会继续说话。
      // 如果不在这里给累积正文补一个段落分隔，下一轮的第一句就会紧贴上一句末尾，
      // 多轮下来整段挤成一行、看不出层次（正文默认 white-space: pre-wrap，只认真实换行）。
      // 这里只影响展示与存档；发给模型的历史用的是 round.content，不受影响。
      if (content && !content.endsWith('\n\n')) {
        const separator = content.endsWith('\n') ? '\n' : '\n\n';
        content += separator;
        await options.callbacks.onDelta({ content: separator });
      }

      requestMessages.push({
        role: 'assistant',
        content: round.content,
        reasoning_content: round.reasoning || undefined,
        tool_calls: round.toolCalls,
      });

      // 一轮里工具调用也有上限：模型偶尔会一次吐出几十个调用，
      // 无上限执行等于把「单轮预算」变成了摆设。
      const accepted = round.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
      const overflow = round.toolCalls.slice(MAX_TOOL_CALLS_PER_ROUND);
      let roundFailed = accepted.length > 0;
      let stopAfterRound = false;

      for (let callIndex = 0; callIndex < accepted.length; callIndex += 1) {
        const call = accepted[callIndex]!;
        // 取消优先于一切：用户点了停止，就绝不再发起新的工具调用。
        this.assertRunning(options.signal);

        if (totalToolCalls >= MAX_TOOL_CALLS_PER_RUN) {
          stopReason = 'toolBudget';
          stopAfterRound = true;
          for (const skippedCall of accepted.slice(callIndex)) {
            await this.recordSkippedCall(skippedCall, executions, requestMessages, options, 'agent.toolBudgetSkipped');
          }
          break;
        }

        const repeat = loopGuard.observe(call);
        if (repeat.blocked) {
          loopToolName = repeat.tool;
          stopReason = 'loopDetected';
          stopAfterRound = true;
          await this.recordSkippedCall(call, executions, requestMessages, options, 'agent.loopSkipped', repeat.count);
          break;
        }

        totalToolCalls += 1;
        const execution: ToolExecution = {
          callId: call.id,
          name: call.function.name || 'unknown_tool',
          summary: toolPendingSummary(call.function.name),
          input: toolInputForHistory(call.function.name, call.function.arguments),
          status: 'pending',
          startedAt: Date.now(),
          risk: toolRisk(call.function.name),
        };
        executions.push(execution);
        await options.callbacks.onToolsChanged(cloneExecutions(executions));

        // 把本次调用接到进度回调上：命令卡住时卡片必须立刻说话。
        // 关键点在于「卡住的命令永远不会结束」，所以提示只能靠运行期推送，
        // 不能指望结束事件——那正是这次故障里永远不会到来的那个事件。
        // 卡片上的秒数每 10 秒刷新一次，但 toast 只弹一次：
        // 弹窗每次重弹会变成噪音，用户会学会无视它。
        let stallToastSent = false;
        const callScope: ToolExecutionScope = {
          ...(options.scope ?? {}),
          // 取消信号与诊断标识必须随调用传下去：工具内部（搜索、命令）靠它
          // 在用户点「停止」时立刻收手，而不是跑完自己的预算。
          signal: options.signal,
          turnId,
          onCommandProgress: (progress) => {
            if (execution.finishedAt) return;
            const hint = options.callbacks.onToolHint ?? options.callbacks.onToolsChanged;
            if (progress.phase === 'timeout') {
              execution.stallHint = tt('tool.commandTimeoutRunning', { seconds: progress.timeoutSeconds });
              void hint(cloneExecutions(executions));
              return;
            }
            execution.stallHint = tt('tool.commandStallHint', { seconds: progress.idleSeconds });
            void hint(cloneExecutions(executions));
            // 卡片文字每次刷新都更新，toast 只补一次：它要传达的是「你得动手了」，
            // 不是那个每秒都在变的秒数。
            if (stallToastSent) return;
            stallToastSent = true;
            void options.callbacks.onCommandStall?.({
              callId: call.id,
              idleSeconds: progress.idleSeconds,
              timeoutSeconds: progress.timeoutSeconds,
              summary: execution.summary,
            });
          },
        };

        const extra = options.executeExtraTool ? await options.executeExtraTool(call) : undefined;
        const result = extra?.result ?? await this.tools.execute(
            call,
            options.mode,
            options.settings,
            async (request) => {
              execution.status = 'pending';
              execution.summary = request.summary;
              execution.risk = request.risk;
              await options.callbacks.onToolsChanged(cloneExecutions(executions));
              return options.callbacks.requestApproval(request);
            },
            options.conversationId,
            callScope,
          );
        if (extra?.skill) {
          await options.callbacks.onSkillUsed?.(extra.skill);
        }
        execution.status = result.status;
        execution.summary = result.summary;
        execution.output = truncateLocal(result.content);
        execution.approval = result.approval;
        execution.changedFiles = result.changedFiles;
        // 结果落定后清掉运行期提示，避免「超时，正在结束进程…」留在最终卡片上。
        execution.stallHint = undefined;
        execution.finishedAt = Date.now();
        await options.callbacks.onToolsChanged(cloneExecutions(executions));
        requestMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify({
            status: result.status,
            summary: result.summary,
            result: result.content,
            changedFiles: result.changedFiles,
          }),
        });
        if (result.status !== 'error' && result.status !== 'denied') roundFailed = false;

        // 工具刚被取消：不要等到下一轮才反应，立刻停下。
        this.assertRunning(options.signal);

        const guidance = await options.takeTaskUpdate?.('replan') ?? [];
        if (guidance.length) {
          for (const skippedCall of round.toolCalls.slice(callIndex + 1)) {
            await this.recordSkippedCall(skippedCall, executions, requestMessages, options, 'agent.mergedGuidance');
          }
          await options.callbacks.onToolsChanged(cloneExecutions(executions));
          for (const update of guidance) {
            await options.callbacks.onTaskUpdate?.(update);
            requestMessages.push(update.request);
          }
          break;
        }
      }

      for (const skippedCall of overflow) {
        await this.recordSkippedCall(skippedCall, executions, requestMessages, options, 'agent.toolBudgetSkipped');
      }
      if (overflow.length) stopReason = 'toolBudget';
      if (overflow.length || stopAfterRound) break;

      consecutiveFailedRounds = roundFailed ? consecutiveFailedRounds + 1 : 0;
      if (consecutiveFailedRounds >= MAX_FAILED_ROUNDS_WITHOUT_PROGRESS) {
        stopReason = 'noProgress';
        break;
      }
    }

    // 循环自然结束 = 步数用尽；因合并 guidance 等原因 break 出来的情况保持 complete，
    // 否则「无限制」下永远不会走到这里，而普通对话合并指引时会被误报成「步数上限」。
    if (stopReason === 'complete' && step >= maxSteps) {
      stopReason = 'stepLimit';
    }
    stopNotice = stopNoticeFor(stopReason, { maxSteps, loopToolName });
    if (stopNotice) {
      content += stopNotice;
      await options.callbacks.onDelta({ content: stopNotice });
    }
    return {
      content,
      reasoning,
      usage,
      tools: executions,
      stoppedByStepLimit: stopReason === 'stepLimit',
      stopReason,
    };
  }

  /** 取消检查：抛出后由面板统一识别为「用户停止」，不会触发失败提示。 */
  private assertRunning(signal: AbortSignal): void {
    if (signal.aborted) throw new OperationCancelledError(tt('agent.cancelled'));
  }

  /**
   * 为「不再执行的调用」补一条工具结果。
   *
   * 必须补：模型上一轮返回了 tool_calls，历史里就缺不得对应的 tool 消息，
   * 否则下一次请求会被服务端判成非法消息序列。
   */
  private async recordSkippedCall(
    skippedCall: ToolCall,
    executions: ToolExecution[],
    requestMessages: ChatRequestMessage[],
    options: { callbacks: AgentRunCallbacks },
    reasonKey: string,
    count?: number,
  ): Promise<void> {
    const summary = count === undefined
      ? tt(reasonKey)
      : tt(reasonKey, { count });
    const skipped: ToolExecution = {
      callId: skippedCall.id,
      name: skippedCall.function.name || 'unknown_tool',
      summary,
      input: toolInputForHistory(skippedCall.function.name, skippedCall.function.arguments),
      output: summary,
      status: 'denied',
      approval: 'not-required',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      risk: toolRisk(skippedCall.function.name),
    };
    executions.push(skipped);
    requestMessages.push({
      role: 'tool',
      tool_call_id: skippedCall.id,
      name: skippedCall.function.name,
      content: JSON.stringify({ status: 'denied', summary, result: summary }),
    });
    await options.callbacks.onToolsChanged(cloneExecutions(executions));
  }
}

function cloneExecutions(executions: ToolExecution[]): ToolExecution[] {
  return executions.map((execution) => ({ ...execution, changedFiles: execution.changedFiles ? [...execution.changedFiles] : undefined }));
}

function toolPendingSummary(name: string): string {
  const labels: Record<string, string> = {
    list_workspace_roots: tt('agent.progress.list_workspace_roots'),
    list_directory: tt('agent.progress.list_directory'),
    list_files: tt('agent.progress.list_files'),
    search_files: tt('agent.progress.search_files'),
    read_file: tt('agent.progress.read_file'),
    open_file: tt('agent.progress.open_file'),
    get_diagnostics: tt('agent.progress.get_diagnostics'),
    write_file: tt('agent.progress.write_file'),
    replace_in_file: tt('agent.progress.replace_in_file'),
    rename_file: tt('agent.progress.rename_file'),
    delete_file: tt('agent.progress.delete_file'),
    run_command: tt('agent.progress.run_command'),
    load_skill: tt('agent.progress.load_skill'),
    search_conversation_history: tt('agent.progress.search_conversation_history'),
    update_todos: tt('agent.progress.update_todos'),
  };
  return labels[name] ?? tt('agent.progress.generic', { name });
}

function toolRisk(name: string): ToolExecution['risk'] {
  if (name === 'run_command') return 'command';
  if (name === 'write_file' || name === 'replace_in_file' || name === 'rename_file' || name === 'delete_file') return 'write';
  return 'read';
}

function addUsage(total: UsageInfo | undefined, current: UsageInfo | undefined): UsageInfo | undefined {
  if (!current) return total;
  return {
    promptTokens: (total?.promptTokens ?? 0) + (current.promptTokens ?? 0),
    completionTokens: (total?.completionTokens ?? 0) + (current.completionTokens ?? 0),
    totalTokens: (total?.totalTokens ?? 0) + (current.totalTokens ?? 0),
  };
}

function toolInputForHistory(name: string, rawArguments: string): string {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawArguments || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return truncateLocal(redact(rawArguments || '{}'));
    }
    args = { ...parsed as Record<string, unknown> };
  } catch {
    return truncateLocal(redact(rawArguments || '{}'));
  }
  if (name === 'write_file' && typeof args.content === 'string') {
    args.content = tt('agent.contentOmitted', { bytes: Buffer.byteLength(args.content).toLocaleString() });
  }
  if (name === 'replace_in_file') {
    for (const key of ['oldText', 'newText'] as const) {
      if (typeof args[key] === 'string') {
        args[key] = summarizeText(args[key]);
      }
    }
  }
  return truncateLocal(redact(JSON.stringify(args, null, 2)));
}

function summarizeText(value: string): string {
  const redacted = redact(value);
  if (redacted.length <= 600) return redacted;
  return tt('agent.valueTruncated', { value: redacted.slice(0, 600), bytes: Buffer.byteLength(value).toLocaleString() });
}

function truncateLocal(value: string, maxBytes = 200_000): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = value.slice(0, Math.floor(maxBytes * 0.75));
  while (Buffer.byteLength(result) > maxBytes - 64) result = result.slice(0, -256);
  return tt('agent.detailsTruncated', { result });
}
