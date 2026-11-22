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
import { DeepSeekClient, type StreamChatResult } from '../providers/deepseekClient';
import { redact } from './auditLog';
import type { AgentSteering } from './steering';
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
export type AgentStopReason = 'complete' | 'stepLimit' | 'loopDetected' | 'stalled' | 'noProgress' | 'cancelled';

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
/**
 * 一次运行里，允许被「重复空转守卫」拦下多少次。
 *
 * 拦下的每一次都会告诉模型「换方法」，正常情况下它第一次就会改。连着撞到这么多次
 * 说明它已经不会自己换路子了，只能停下来把决定权交回用户。
 */
export const MAX_FUTILE_SKIPS = 4;
/**
 * 模型「想收尾」但任务清单还没做完时，最多催几次。
 *
 * 每次催都会把「清单还有未完成项」重新摆到它面前并明确要求继续。正常模型第一次就会
 * 接着做；如果连着几次都只写总结不动手，说明它已经认定做完了（或者不会做），
 * 这时候继续催只会烧 token，交给用户判断更诚实。
 */
export const MAX_TODO_NUDGES = 3;

function stopNoticeFor(
  reason: AgentStopReason,
  context: { maxSteps: number; loopToolName: string },
): string {
  switch (reason) {
    case 'stepLimit':
      return tt('agent.stepLimit', { steps: context.maxSteps });
    case 'loopDetected':
      return tt('agent.loopDetected', { count: MAX_IDENTICAL_TOOL_CALLS, tool: context.loopToolName || 'unknown_tool' });
    case 'stalled':
      return tt('agent.stalled', {
        count: MAX_IDENTICAL_TOOL_CALLS,
        skips: MAX_FUTILE_SKIPS,
        tool: context.loopToolName || 'unknown_tool',
      });
    case 'noProgress':
      return tt('agent.noProgress', { rounds: MAX_FAILED_ROUNDS_WITHOUT_PROGRESS });
    default:
      return '';
  }
}

/**
 * 反复空转的检测器。
 *
 * 只统计「紧挨着的完全相同的调用」（工具名 + 规范化后的参数）：这类重复
 * 在真实会话里几乎只有一种含义——模型没有拿到新信息却在下同一个指令。
 * 把它们挡在第三次之前执行，既不会误伤「反复读不同文件」这种正常行为，
 * 也堵死了「搜索失败 → 原样重试」的死循环。
 *
 * 但**只看相邻**远远不够。真实故障（用户 2026-11-22）：一个「翻译一下」的任务跑出
 * 207 个工具调用 —— `read_file Icon.tsx` 53 次、`read_file Gate.tsx` 31 次、
 * 同样的 `powershell Get-Content` 51 次，中间夹着别的调用，于是相邻判定永远不触发，
 * 一直在原地打转却停不下来。
 *
 * 所以再加一层按**输出**判定的守卫：同一个调用（工具 + 参数）连续三次返回**逐字节
 * 相同**的结果，就说明再执行一次也不会有新信息 —— 后面的调用直接拦下并告诉模型换方法。
 * 用输出而不是次数，是为了不误伤「读 → 改 → 再读」这种正常来回：文件改过之后
 * 输出就变了，计数自动归零。
 */
export class ToolLoopGuard {
  private lastSignature: string | undefined;
  private repeatCount = 0;
  /** 每个调用签名最近一次的输出指纹，以及「连续多少次输出一模一样」。 */
  private readonly outputs = new Map<string, { fingerprint: string; same: number }>();

  observe(call: ToolCall): { blocked: boolean; count: number; tool: string } {
    const signature = callSignature(call);
    if (signature === this.lastSignature) this.repeatCount += 1;
    else {
      this.lastSignature = signature;
      this.repeatCount = 1;
    }
    return { blocked: this.repeatCount >= MAX_IDENTICAL_TOOL_CALLS, count: this.repeatCount, tool: call.function.name };
  }

  /**
   * 这个调用是否已经「证明」跑不出新东西：同样的参数连续多次拿到同样的结果。
   *
   * 判定在**执行前**进行，所以用的是已经记录过的历史结果。
   */
  futile(call: ToolCall): boolean {
    const entry = this.outputs.get(callSignature(call));
    return Boolean(entry && entry.same >= MAX_IDENTICAL_TOOL_CALLS);
  }

  /** 记录一次真实执行的结果，供 `futile()` 判定。 */
  record(call: ToolCall, status: string, content: string): void {
    const key = callSignature(call);
    const fingerprint = `${status}\u0000${content}`;
    const entry = this.outputs.get(key);
    if (!entry) {
      this.outputs.set(key, { fingerprint, same: 1 });
      return;
    }
    this.outputs.set(key, entry.fingerprint === fingerprint
      ? { fingerprint, same: entry.same + 1 }
      : { fingerprint, same: 1 });
  }
}

function callSignature(call: ToolCall): string {
  return `${call.function.name}\u0000${canonicalToolArguments(call.function.arguments)}`;
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
    takeTaskUpdate?: (phase: 'replan' | 'complete', info?: { paused?: boolean }) => Promise<AgentTaskUpdate[]> | AgentTaskUpdate[];
    /**
     * 运行中新消息的暂停通道（见 `steering.ts`）。
     *
     * 只打断**正在生成的回答**：工具执行仍只听主 `signal`，不会被一条中途发来的
     * 消息连坐。暂停后回到循环顶部，由 `takeTaskUpdate('replan')` 把新消息交给模型
     * 重新分析并调整任务清单。
     */
    steering?: AgentSteering;
    /**
     * 任务队列里还有没有「没被读过的用户消息」。
     *
     * 步数预算用尽时如果还有，就不能直接收尾结束 —— 那几条消息会被跳过。
     * 续跑同一条消息的 Agent 需要它（见下方 `while` 循环顶部）。
     */
    hasPendingTasks?: () => boolean | Promise<boolean>;
    /**
     * 任务清单里还有没有没打勾的项。
     *
     * 步数预算用尽时，只要清单还没做完就**续一份预算继续跑**，而不是原地收尾等用户
     * 回「继续」。用户 2026-11-22 的原话：「没有执行完对话框里面的任务就停下来了，
     * 每次都是这样，能不能让 agent 执行完再停止」。
     *
     * 续跑仍然有上限（`MAX_BUDGET_EXTENSIONS`），并且死循环 / 重复空转 / 连续无进展
     * / 用户取消这几道闸都还在，所以「跑完再停」不等于「停不下来」。
     */
    hasUnfinishedTodos?: () => boolean | Promise<boolean>;
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
    /** 「重复空转守卫」拦下的次数。有进展就归零；撞满 `MAX_FUTILE_SKIPS` 才停。 */
    let futileSkips = 0;
    /** 因为「清单还没做完」而催模型继续的次数（见 `MAX_TODO_NUDGES`）。 */
    let todoNudges = 0;
    /**
     * 上一段是「因为用户发来新消息而暂停」结束的。
     *
     * 循环顶部要把它告诉 `takeTaskUpdate`：面板据此把那条消息交给模型做综合分析
     * （即使它被判定成独立任务，也要读到并给出判断）。
     */
    let pauseHandled = false;
    while (true) {
      if (step >= maxSteps) {
        /*
         * 步数用尽，但队列里还压着用户消息：**不能收尾**。
         *
         * 真实故障（用户 2026-11-05）：「如果合并执行的消息中间还有消息，会被跳过」。
         * 旧实现整轮共用一份 `maxSteps`：前面那条分支跑满预算，后面排队的消息一步都
         * 轮不到，循环直接退出，它们就成了「未执行」。这里给它一份新预算继续跑 ——
         * 用户发的每一句都要被读过，除非他自己删掉。
         *
         * 任务清单还没做完时同理（用户 2026-11-22：「没有执行完对话框里面的任务就停下来了」）：
         * 面板上还挂着没打勾的项目，就说明这一次运行的目标没达成，续一份预算接着做，
         * 而不是把「还剩 5 项」交回给用户手动点继续。
         */
        const canExtend = budgetExtensions < MAX_BUDGET_EXTENSIONS;
        const pending = canExtend && (await options.hasPendingTasks?.() ?? false);
        const unfinished = !pending && canExtend && (await options.hasUnfinishedTodos?.() ?? false);
        if (!pending && !unfinished) break;
        budgetExtensions += 1;
        step = 0;
        stopReason = 'complete';
        stopNotice = '';
        if (unfinished) {
          requestMessages.push({ role: 'user', content: tt('agent.continueForTodos') });
        }
      }
      /*
       * 上一段工具执行期间收到的暂停请求：那时没有正在生成的回答，暂停已经成立，
       * 在这里消费掉并把「刚才暂停过」传给面板。不消费的话，下一轮请求会因为
       * 信号已 abort 而立刻失败，白白多一次往返。
       */
      let paused = pauseHandled;
      pauseHandled = false;
      if (options.steering?.consume()) paused = true;
      step += 1;
      this.assertRunning(options.signal);
      const beforeRound = await options.takeTaskUpdate?.('replan', { paused }) ?? [];
      for (const update of beforeRound) {
        await options.callbacks.onTaskUpdate?.(update);
        requestMessages.push(update.request);
      }
      /*
       * 这一轮单独统计正文：用户中途发来新消息时，本轮没有 `round` 结果，
       * 只能把已经流出去的文字补回历史，模型下一轮才知道自己停在哪里。
       */
      let roundContent = '';
      let roundReasoning = '';
      const linked = options.steering ? linkAbortSignals(options.signal, options.steering.signal) : undefined;
      let round: StreamChatResult;
      try {
        round = await this.client.streamChat(options.settings, requestMessages, {
          signal: linked?.signal ?? options.signal,
          tools: definitions,
          onDelta: async (delta) => {
            if (delta.content) {
              roundContent += delta.content;
              content += delta.content;
            }
            if (delta.reasoning) {
              roundReasoning += delta.reasoning;
              reasoning += delta.reasoning;
            }
            await options.callbacks.onDelta({
              content: delta.content,
              reasoning: delta.reasoning,
              usage: delta.usage,
            });
          },
        });
      } catch (error) {
        if (options.signal.aborted) throw error;
        /*
         * 用户在这次生成中途发来新消息 —— 这是「暂停」，不是失败。
         *
         * 判定条件刻意不看错误类型：暂停可能发生在「还没拿到响应头」的阶段，那时
         * 网络层已经把 AbortError 包装成了普通的连接错误。真出现硬错误也不要紧 ——
         * 暂停已被消费，下一轮会把同一个错误如实报出来。
         *
         * 半截正文必须留在历史里：下一轮模型据此知道自己停在哪，用户看到的气泡
         * 也不是被截断后从零重来；不补这一条，模型会把已经展示过的内容再写一遍。
         */
        if (options.steering?.hasPending()) {
          options.steering.consume();
          pauseHandled = true;
          if (roundContent) {
            requestMessages.push({
              role: 'assistant',
              content: roundContent,
              reasoning_content: roundReasoning || undefined,
            });
          }
          // 被打断的这一轮不算一步：暂停不该消耗用户的步数预算。
          step = Math.max(0, step - 1);
          consecutiveFailedRounds = 0;
          continue;
        }
        throw error;
      } finally {
        linked?.dispose();
      }
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
        /*
         * 模型想收尾，但任务清单还没做完 —— 不能就这么结束。
         *
         * 用户 2026-11-22：「没有执行完对话框里面的任务就停下来了，每次都是这样」，
         * 而且他已经在工具条上选了「最大步数：不限制」。所以卡点不在步数预算：
         * 是模型自己不再调用工具、直接写总结收尾，清单里还留着没打勾的项。
         * 这里把清单状态摆回去，明确要求继续做剩下的条目；最多催 `MAX_TODO_NUDGES` 次，
         * 免得模型认死理时把一次运行拖成无限循环。
         */
        if (options.mode !== 'chat' && todoNudges < MAX_TODO_NUDGES && (await options.hasUnfinishedTodos?.() ?? false)) {
          todoNudges += 1;
          requestMessages.push({
            role: 'assistant',
            content: round.content,
            reasoning_content: round.reasoning || undefined,
          });
          requestMessages.push({ role: 'user', content: tt('agent.unfinishedTodos') });
          continue;
        }
        /*
         * 收尾那一刻用户刚好发来消息：暂停请求可能还没被消费。
         *
         * 不能直接结束 —— 那条消息会被留到下一轮，用户看到的是「我发了消息，任务却
         * 停了」。这里再取一次，能取到就接着做；取不到（消息其实还没入队）才真的收尾。
         */
        if (options.steering?.hasPending()) {
          options.steering.consume();
          const late = await options.takeTaskUpdate?.('replan', { paused: true }) ?? [];
          if (late.length) {
            requestMessages.push({
              role: 'assistant',
              content: round.content,
              reasoning_content: round.reasoning || undefined,
            });
            for (const update of late) {
              await options.callbacks.onTaskUpdate?.(update);
              requestMessages.push(update.request);
            }
            continue;
          }
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
      /*
       * 「这一轮算不算失败」要分开看两件事：
       *  - `error`：工具真的失败了（命令报错、文件不存在、网络断了）→ 计入失败连击；
       *  - `denied`：被策略拒绝、审批拒绝、或因为暂停/合并被跳过 → **不算失败**。
       *
       * 以前两者一视同仁：模型碰上两条命令失败 + 一条敏感文件拒绝就凑满 3 轮停机
       * （真实故障 2026-11-18），而拒绝本身是确定性的、与「环境坏了」不是一回事。
       */
      let roundHadError = false;
      let roundHadSuccess = false;
      /** 这一轮有没有任何工具吐出过内容（输出说明工具在工作，不算「卡死」）。 */
      let roundHadOutput = false;
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
        /*
         * 换着花样原地打转：同一个调用已经连续 3 次拿到一模一样的输出。
         *
         * 与上面的「相邻重复」不同，这里能抓住中间夹着别的调用的绕圈子 ——
         * 真实故障里 `read_file Icon.tsx` / `read_file Gate.tsx` / 同一条
         * `Get-Content` 交替出现几十次，相邻判定永远不触发，一跑就是 200 多个调用。
         * 拦下这一次并明确要求换方法；模型连续撞满 `MAX_FUTILE_SKIPS` 次才停机。
         */
        if (loopGuard.futile(call)) {
          futileSkips += 1;
          loopToolName = call.function.name;
          await this.recordSkippedCall(call, executions, requestMessages, options, 'agent.repeatSkipped');
          if (futileSkips >= MAX_FUTILE_SKIPS) {
            stopReason = 'stalled';
            stopAfterRound = true;
            break;
          }
          continue;
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
        // 记下这次的结果指纹：同一个调用反复拿到相同输出时，后面的调用会被拦下。
        loopGuard.record(call, result.status, result.content);
        // 真的拿到了新结果（成功）就说明模型在推进，重复空转的计数归零。
        // `update_todos` 不算：它只是记账，不产出信息，否则模型可以靠反复更新清单把计数刷回 0。
        if (result.status === 'success' && call.function.name !== 'update_todos') futileSkips = 0;
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
        const filePath = payloadPathFor(call.function.name, call.function.arguments);
        requestMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify({
            status: result.status,
            summary: result.summary,
            result: recall ? `${result.content}\n\n${recall}` : result.content,
            changedFiles: result.changedFiles,
            /*
             * 文件类工具的路径要留在载荷里：`pruneToolPayloads` 靠它「钉住」每个文件
             * 最近一次的读取结果。否则模型读到第 4 个文件时，第 1 个文件的内容就被折掉了，
             * 它只能回去再读一遍 —— 这正是同一个文件被读几十次的原因。
             */
            ...(filePath ? { path: filePath } : {}),
          }),
        });
        /*
         * 先按条数折（保留最近 3 条），再按总预算折最旧的 —— 用户选的方案 A。
         * 预算按 token 上限反推字节（4 字符 ≈ 1 token），与对话长度进度条同口径。
         */
        pruneToolPayloads(requestMessages, TOOL_PAYLOAD_KEEP, DEFAULT_CONTEXT_TOKEN_BUDGET * 4);
        /*
         * 只有**环境性**失败才计入失败连击：
         *  - `error`：工具真的失败了（命令报错、文件不存在、网络断了）；
         *  - `denied`：被策略拒绝、审批拒绝、或因为暂停/合并被跳过；
         *  - `error` + `decisive`：服务器给了确定答案（HTTP 404 等），换个地址才有用。
         * 后两种都是「模型该换策略」，不是「环境坏了」，把它们算进连击会让
         * 「连猜三个 URL」直接停机（真实故障 2026-11-19）。
         */
        if (result.status === 'error') {
          if (!result.decisive) roundHadError = true;
          if (!result.noOutput) roundHadOutput = true;
        } else if (result.status !== 'denied') {
          roundHadSuccess = true;
          roundHadOutput = true;
        }

        // 工具刚被取消：不要等到下一轮才反应，立刻停下。
        this.assertRunning(options.signal);

        /*
         * 用户在这个工具刚跑完时发来新消息：**立刻停下这一批**。
         *
         * 真实反馈（2026-11-18）：「我发新消息，任务没暂停然后综合新收到的消息再分析
         * 再执行」。只打断生成是不够的 —— 模型常常一口气发起十几个命令，那时没有
         * 正在生成的回答，暂停要等到整批跑完（实测 16 条命令）才生效。这里在**每个
         * 工具结束后**看一眼：有新消息就记下剩余的调用「已跳过」，把新消息交给模型
         * 先做综合分析，再回来继续。
         */
        if (options.steering?.hasPending() && options.steering.consume()) {
          for (const skippedCall of round.toolCalls.slice(callIndex + 1)) {
            await this.recordSkippedCall(skippedCall, executions, requestMessages, options, 'agent.pausedSkipped');
          }
          await options.callbacks.onToolsChanged(cloneExecutions(executions));
          for (const update of await options.takeTaskUpdate?.('replan', { paused: true }) ?? []) {
            await options.callbacks.onTaskUpdate?.(update);
            requestMessages.push(update.request);
          }
          // 暂停不是失败：否则连发几条消息就会被判成「连续 3 轮全部失败」而停机。
          roundHadError = false;
          roundHadSuccess = true;
          roundHadOutput = true;
          break;
        }

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
          // 被打断不是失败：否则「新消息合并」会悄悄把连续失败计数推向 3 轮停机。
          roundHadError = false;
          roundHadSuccess = true;
          roundHadOutput = true;
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

      /*
       * 什么算「这一轮没有进展」：
       *  - 这一轮**有真实 error**（不是被拒绝、不是 `decisive` 的确定答案）；
       *  - 而且**没有任何成功步骤**；
       *  - 而且**连输出都没有**（有输出说明工具在工作，模型能据此改进）。
       *
       * 第三条是 2026-11-19 补的：Windows 上退出码经常不可靠（PowerShell 的 `$?`、
       * 被 `-ErrorAction SilentlyContinue` 吞掉的错误、`2>&1 | cmdlet` 的原生 stderr），
       * 三轮「其实每次都拿到了正确输出」的命令就这样被判「全部失败」停机。
       */
      consecutiveFailedRounds = roundHadError && !roundHadSuccess && !roundHadOutput
        ? consecutiveFailedRounds + 1
        : 0;
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
 * 合并两个取消信号，并允许调用方在本次请求结束后拆掉监听。
 *
 * 不能只 `addEventListener` 不管：`options.signal` 活整轮运行，一次长任务有上百轮
 * 生成，监听器会一直攒着（Node 的 EventTarget 超过 10 个就开始告警）。
 */
function linkAbortSignals(primary: AbortSignal, secondary: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  if (primary.aborted || secondary.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  const abort = (): void => controller.abort();
  primary.addEventListener('abort', abort, { once: true });
  secondary.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener('abort', abort);
      secondary.removeEventListener('abort', abort);
    },
  };
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
import { DEFAULT_CONTEXT_TOKEN_BUDGET } from '../core/contextBudget';

const TOOL_PAYLOAD_KEEP = 3;

/**
 * 折叠一条工具载荷（保留结论与改动文件，丢掉原文）。
 * 返回 true 表示这次真的折了。
 */
function foldToolPayloadAt(messages: ChatRequestMessage[], at: number): boolean {
  const message = messages[at];
  if (!message || typeof message.content !== 'string') return false;
  let payload: { status?: string; summary?: string; result?: unknown; changedFiles?: unknown; folded?: boolean; path?: string };
  try {
    payload = JSON.parse(message.content) as typeof payload;
  } catch {
    return false;
  }
  if (payload.folded) return false;
  messages[at] = {
    ...message,
    content: JSON.stringify({
      status: payload.status,
      summary: payload.summary,
      folded: true,
      result: '（早期工具输出已折叠：结论见任务树，需要原文请重新执行该工具）',
      changedFiles: payload.changedFiles,
      // 路径要留下：钉住逻辑靠它认出「这是哪个文件的最新一次读取」。
      ...(payload.path ? { path: payload.path } : {}),
    }),
  };
  return true;
}

/**
 * 请求体的总字节数（按真正会发出去的内容估）。
 *
 * 只用 `content` 的长度近似：请求里最大的部分就是正文与工具输出，
 * 角色名、id 这些开销可以忽略；要的是「量级对不对」，不是精确到字节。
 */
export function requestBytes(messages: readonly ChatRequestMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content !== 'string') continue;
    total += Buffer.byteLength(message.content);
  }
  return total;
}

/** 会产出「文件内容」这一类的工具：它们的载荷值得在上下文里保留。 */
const FILE_PAYLOAD_TOOLS = new Set(['read_file', 'write_file', 'replace_in_file', 'rename_file']);

/**
 * 工具调用对应的文件路径（没有就返回空串）。
 *
 * 只用来给载荷「钉住」用，所以只认带 `path` 参数的工具；解析失败一律当作没有路径。
 */
function payloadPathFor(name: string, rawArguments: string): string {
  if (!FILE_PAYLOAD_TOOLS.has(name)) return '';
  try {
    const parsed = JSON.parse(rawArguments || '{}') as { path?: unknown };
    return typeof parsed?.path === 'string' ? parsed.path.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 折叠早期工具输出，**先按条数，再按总预算**。
 *
 * 用户 2026-11-09 选了方案 A：「超预算时先折叠最旧的工具输出、保留结论与最近几轮」。
 *
 * 为什么不能只按条数（`keep = 3`）：一次运行里单条工具输出上限 200KB，
 * 三条就是 600KB；再加上历史窗口，请求体可以很大 —— 而「几条」和「多大」不是一回事。
 * 所以按条数折完之后再看总字节：仍然超预算就**从最旧的继续折**，
 * 但**永远保留最新那一条**（它通常正是模型下一步要用的）。
 *
 * 2026-11-22 追加一条：**每个文件最近一次的载荷不折**。
 *
 * 真实故障：一个「翻译」任务里 `read_file Icon.tsx` 被读了 53 次。原因不是模型蠢 ——
 * 它读到第 4 个文件时，第 1 个文件的内容已经被这条规则折掉了，回头要改第 1 个文件就得
 * 再读一遍，读完之后第 2 个又被折掉…… 无限循环。现在按路径钉住最近 `PINNED_PATHS`
 * 个文件的**最后一次**读取结果，让「读过的文件」在工作集里稳定存在；
 * 真的超出总预算时才会把钉住的也折掉（最后一步兜底）。
 */
const PINNED_PATHS = 4;
/** 被钉住的载荷总字节上限：工作集可以留在上下文里，但不能把预算吃光。 */
const MAX_PINNED_BYTES = 64 * 1024;

export function pruneToolPayloads(
  messages: ChatRequestMessage[],
  keep = TOOL_PAYLOAD_KEEP,
  budgetBytes = 0,
): number {
  const toolIndexes: number[] = [];
  /** 最近出现的文件路径 → 它最后一次出现的位置。 */
  const latestByPath = new Map<string, number>();
  /** 每个路径在这段历史里被读过几次（=2 说明模型回头再读过，是真工作集）。 */
  const readsByPath = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'tool') continue;
    toolIndexes.push(index);
    const path = payloadPathOf(message);
    if (!path) continue;
    latestByPath.delete(path);
    latestByPath.set(path, index);
    readsByPath.set(path, (readsByPath.get(path) ?? 0) + 1);
  }
  /*
   * 钉住哪些载荷：**被回头读过的最优先**，其次按最近出现的顺序。
   *
   * 排序依据用「读过的次数」而不是单纯的时间，是因为「回头再读」正是模型在告诉你
   * 「这是我正在改的文件」；把它的内容留住，才不会出现「读第 4 个文件 → 第 1 个被折掉
   * → 回头再读第 1 个 → 第 2 个又被折掉」的无限循环。
   */
  const pinned = new Set<number>();
  const candidates = [...latestByPath.entries()]
    .sort((a, b) => (readsByPath.get(b[0]) ?? 0) - (readsByPath.get(a[0]) ?? 0) || b[1] - a[1]);
  let pinnedBytes = 0;
  for (const [, index] of candidates) {
    if (pinned.size >= PINNED_PATHS) break;
    const size = toolPayloadBytes(messages[index]!);
    if (pinnedBytes + size > MAX_PINNED_BYTES) continue;
    pinnedBytes += size;
    pinned.add(index);
  }
  let folded = 0;
  const cutoff = toolIndexes.length - Math.max(0, keep);
  for (let index = 0; index < Math.max(0, cutoff); index += 1) {
    const at = toolIndexes[index]!;
    if (pinned.has(at)) continue;
    if (foldToolPayloadAt(messages, at)) folded += 1;
  }
  if (budgetBytes <= 0) return folded;
  /*
   * 预算这一轮从**最旧的**还没折的开始折，直到装得下；最新一条永远不动。
   * 钉住的先跳过，实在还超预算再折它们（兜底优先于「保留工作集」）。
   */
  for (const allowPinned of [false, true]) {
    for (let index = 0; index < toolIndexes.length - 1; index += 1) {
      if (requestBytes(messages) <= budgetBytes) return folded;
      const at = toolIndexes[index]!;
      if (!allowPinned && pinned.has(at)) continue;
      if (foldToolPayloadAt(messages, at)) folded += 1;
    }
  }
  return folded;
}

/** 一条 tool 消息的载荷字节数（解析失败按 0 算）。 */
function toolPayloadBytes(message: ChatRequestMessage): number {
  return typeof message.content === 'string' ? Buffer.byteLength(message.content) : 0;
}

/** 从一条 tool 消息里读出它的文件路径（没有就返回空串）。 */
function payloadPathOf(message: ChatRequestMessage): string {
  if (typeof message.content !== 'string') return '';
  try {
    const payload = JSON.parse(message.content) as { path?: unknown };
    return typeof payload?.path === 'string' ? payload.path : '';
  } catch {
    return '';
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
