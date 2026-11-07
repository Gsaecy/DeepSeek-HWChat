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
export type AgentStopReason = 'complete' | 'stepLimit' | 'loopDetected' | 'noProgress' | 'cancelled';

export interface AgentRunResult {
  content: string;
  reasoning: string;
  usage?: UsageInfo;
  tools: ToolExecution[];
  stoppedByStepLimit: boolean;
  stopReason: AgentStopReason;
}

/**
 * 一轮里最多执行多少个工具调用。
 *
 * 超出的部分不执行，但**不再中断整次运行**：它们会以「未执行」的 tool 结果回报给
 * 模型，循环继续下一轮（见循环里的 overflow 段）。这是防止模型一次吐出几十个调用
 * 的节流阀，不是运行预算。
 */
export const MAX_TOOL_CALLS_PER_ROUND = 12;
/**
 * 一次运行里累计的工具调用上限：不设限（见 `agentLimits.ts` 里的历史说明）。
 * 保留导出只是为了让「运行总量」这个概念还有个唯一的落点。
 */
export { MAX_TOOL_CALLS_PER_RUN } from '../core/agentLimits';
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
    /**
     * 本轮允许下发给模型的工具名（宿主按任务类型指定）。
     *
     * 为什么在 runner 里做：这里是**唯一**把三路工具（原生 / 桥接 / 额外工具）
     * 合并成一份清单的地方。在别处过滤总会漏掉某一路，而"清单里没有"比"调用后被拒"
     * 强得多 —— 模型连选错的机会都没有。
     */
    toolAllowList?: readonly string[];
    executeExtraTool?: (call: import('../core/types').ToolCall) => Promise<{ result: ToolExecutionResult; skill?: SkillUsage } | undefined>;
    takeTaskUpdate?: (phase: 'replan' | 'complete') => Promise<AgentTaskUpdate[]> | AgentTaskUpdate[];
    /**
     * 任务队列里还有没有「没被读过的用户消息」。
     *
     * 步数预算用尽时如果还有，就不能直接收尾结束 —— 那几条消息会被跳过。
     * 续跑同一条消息的 Agent 需要它（见下方 `while` 循环顶部）。
     */
    hasPendingTasks?: () => boolean | Promise<boolean>;
    /**
     * 工具**失败**时，按这段报错的原文去完整记录里回查相关旧片段。
     *
     * 用户 2026-11-07 追问的缺口：「检索仍要靠模型主动调用」。开局那次自动检索看不到
     * 运行中途才出现的线索 —— 比如某个命令刚报出一个以前踩过的错。这里在失败结果后面
     * 顺手补一段 `<auto_recall>`，模型不必自己想起来去查。
     *
     * 返回空串表示没有相关记录，调用方不会多写任何东西。
     */
    recallForFailure?: (toolName: string, errorText: string) => Promise<string>;
  }): Promise<AgentRunResult> {
    const requestMessages = [...options.messages];
    const executions: ToolExecution[] = [];
    let content = '';
    let reasoning = '';
    let usage: UsageInfo | undefined;
    /*
     * 联网工具只在「互联网参考」打开时下发。
     *
     * 关着的时候工具清单里就不该出现它们：模型不会、也不该自己去查网；
     * 打开时才把 search_github_repos / search_web / fetch_url 交给它。
     */
    const merged = options.mode === 'chat'
      ? []
      : [
        ...this.tools.definitions(options.mode, { internetReference: options.settings.internetReference }),
        ...(options.extraTools ?? []),
      ];
    /*
     * 宿主指定的工具清单（按任务类型）。`undefined` = 不限制。
     * 注意是**按名字**过滤而不是按来源：同名工具只可能来自一路，所以不会误伤。
     */
    const allow = options.toolAllowList;
    const definitions = allow === undefined
      ? merged
      : merged.filter((tool) => allow.includes(tool.function.name));
    /**
     * 单轮执行预算。
     *
     * 「无限制」是工具条上的第四档，表示 `0` → 这里换算成 `Infinity`：循环只在模型
     * 不再调用工具时结束，或由 `ToolLoopGuard`（同一调用重复）、连续无进展轮数、
     * 用户取消这几道闸提前终止。负数 / 非数字这类脏值仍然回落
     * 到默认预算，不会被解释成无限。
     */
    const maxSteps = agentStepBudget(options.settings.agentMaxSteps);
    const turnId = `${options.conversationId}#${Date.now().toString(36)}`;
    const loopGuard = new ToolLoopGuard();
    let step = 0;
    let consecutiveFailedRounds = 0;
    let stopReason: AgentStopReason = 'complete';
    let stopNotice = '';
    let loopToolName = '';

    /** 因「队列里还有消息」而追加的预算次数上限：防御模型无限调用工具导致的死循环。 */
    const MAX_BUDGET_EXTENSIONS = 10;
    let budgetExtensions = 0;
    while (true) {
      if (step >= maxSteps) {
        /*
         * 步数用尽，但队列里还压着用户消息：**不能收尾**。
         *
         * 真实故障（用户 2026-11-05）：「如果合并执行的消息中间还有消息，会被跳过」。
         * 旧实现整轮共用一份 `maxSteps`：前面那条分支跑满预算，后面排队的消息一步都
         * 轮不到，循环直接退出，它们就成了「未执行」。这里给它一份新预算继续跑 ——
         * 用户发的每一句都要被读过，除非他自己删掉。
         */
        const pending = budgetExtensions < MAX_BUDGET_EXTENSIONS && (await options.hasPendingTasks?.() ?? false);
        if (!pending) break;
        budgetExtensions += 1;
        step = 0;
        stopReason = 'complete';
        stopNotice = '';
      }
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
            /*
             * 独立分支（用户排队的那条消息）= 一个新的小任务：**重新给一份步数预算**。
             *
             * 真实故障（用户 2026-11-05）：「如果合并执行的消息中间还有消息，会被跳过」。
             * 旧实现里整轮（含之后所有排队分支）共用同一个 `maxSteps`：前面那条分支跑满
             * 24 步，后面排队的两条消息就一步都轮不到 —— 循环到点退出，它们被标成
             * 「未执行」跳过了。每条消息各自有预算，才谈得上「先来先做、不跳过」。
             */
            if (update.relation === 'queued') {
              step = 0;
              stopReason = 'complete';
            }
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

        const repeat = loopGuard.observe(call);
        if (repeat.blocked) {
          loopToolName = repeat.tool;
          stopReason = 'loopDetected';
          stopAfterRound = true;
          await this.recordSkippedCall(call, executions, requestMessages, options, 'agent.loopSkipped', repeat.count);
          break;
        }

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
        /*
         * 失败的工具结果先回查一次旧记录，再把结论一起交给模型。
         *
         * 放在 tool 消息内部而不是新加一条 user/system 消息：不改变对话角色结构
         * （部分服务端不接受中途插 system），也不影响上下文缓存的前缀。
         */
        const recall = result.status === 'error' && options.recallForFailure
          ? await options.recallForFailure(call.function.name, result.content).catch(() => '')
          : '';
        requestMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify({
            status: result.status,
            summary: result.summary,
            result: recall ? `${result.content}\n\n${recall}` : result.content,
            changedFiles: result.changedFiles,
          }),
        });
        pruneToolPayloads(requestMessages);
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

      /*
       * 一轮里超出上限的调用：记一条「未执行」的 tool 结果回报给模型，然后**继续下一轮**。
       *
       * 以前这里是 `break`：模型一次吐出 13 个调用，整次运行就停在这里，用户得回
       * 「继续」才往下走——正是「跑着跑着被打断」的来源之一。现在超出的只是跳过，
       * 模型下一轮能看见哪些没执行、据此重新组织（这些 tool 结果必须写进
       * `requestMessages`，否则历史里会出现「有 tool_call 没有对应 tool 消息」的非法序列）。
       */
      for (const skippedCall of overflow) {
        await this.recordSkippedCall(skippedCall, executions, requestMessages, options, 'agent.toolBudgetSkipped');
      }
      if (overflow.length) await options.callbacks.onToolsChanged(cloneExecutions(executions));
      if (stopAfterRound) break;

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

/**
 * 运行内只保留最近几次工具输出的全文，更早的压成一行。
 *
 * 真实数据（2026-11-06，用户存档）：一次运行 105 次工具调用，存档里工具文本
 * 就有 12.07 MB；而 agent 每一轮都会把「本轮到目前为止的所有工具结果」重发一遍，
 * 于是单轮 prompt 出现过 1.37M / 4.99M / 10.6M / **20.28M** tokens。
 *
 * 工具输出是**过程**，不是结论：任务树已经记下「做了什么、结果如何」，
 * 细节随时可以用同样的工具再查一次（文件也还在磁盘上）。所以这里做的是
 * 「最近的留全，早的留摘要」，和跨轮记忆采用同一条原则。
 */
const TOOL_PAYLOAD_KEEP = 3;

export function pruneToolPayloads(messages: ChatRequestMessage[], keep = TOOL_PAYLOAD_KEEP): number {
  const toolIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'tool') toolIndexes.push(index);
  }
  const cutoff = toolIndexes.length - Math.max(0, keep);
  if (cutoff <= 0) return 0;
  let folded = 0;
  for (let index = 0; index < cutoff; index += 1) {
    const at = toolIndexes[index]!;
    const message = messages[at];
    if (!message || typeof message.content !== 'string') continue;
    let payload: { status?: string; summary?: string; result?: unknown; changedFiles?: unknown; folded?: boolean };
    try {
      payload = JSON.parse(message.content) as typeof payload;
    } catch {
      continue;
    }
    if (payload.folded) continue;
    messages[at] = {
      ...message,
      content: JSON.stringify({
        status: payload.status,
        summary: payload.summary,
        folded: true,
        result: '（早期工具输出已折叠：结论见任务树，需要原文请重新执行该工具）',
        changedFiles: payload.changedFiles,
      }),
    };
    folded += 1;
  }
  return folded;
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
