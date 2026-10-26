import {
  ChatRequestMessage,
  ChatSettings,
  ConversationMode,
  SkillUsage,
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
  UsageInfo,
} from '../core/types';
import { DeepSeekClient } from '../providers/deepseekClient';
import { redact } from './auditLog';
import type { AgentTaskUpdate } from './taskQueue';
import type { RequestApproval, ToolExecutor } from './toolExecutor';
import { tt } from '../core/i18n';

export interface AgentRunCallbacks {
  onDelta: (delta: { content?: string; reasoning?: string; usage?: UsageInfo }) => void | Promise<void>;
  onToolsChanged: (tools: ToolExecution[]) => void | Promise<void>;
  requestApproval: RequestApproval;
  onSkillUsed?: (skill: SkillUsage) => void | Promise<void>;
  onTaskUpdate?: (update: AgentTaskUpdate) => void | Promise<void>;
  onRoundComplete?: (usage?: UsageInfo) => void | Promise<void>;
}

export interface AgentRunResult {
  content: string;
  reasoning: string;
  usage?: UsageInfo;
  tools: ToolExecution[];
  stoppedByStepLimit: boolean;
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
    let step = 0;
    while (options.settings.agentMaxSteps === 0 || step < options.settings.agentMaxSteps) {
      step += 1;
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
        return { content, reasoning, usage, tools: executions, stoppedByStepLimit: false };
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

      for (let callIndex = 0; callIndex < round.toolCalls.length; callIndex += 1) {
        const call = round.toolCalls[callIndex]!;
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
          );
        if (extra?.skill) {
          await options.callbacks.onSkillUsed?.(extra.skill);
        }
        execution.status = result.status;
        execution.summary = result.summary;
        execution.output = truncateLocal(result.content);
        execution.approval = result.approval;
        execution.changedFiles = result.changedFiles;
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

        const guidance = await options.takeTaskUpdate?.('replan') ?? [];
        if (guidance.length) {
          for (const skippedCall of round.toolCalls.slice(callIndex + 1)) {
            const skipped: ToolExecution = {
              callId: skippedCall.id,
              name: skippedCall.function.name || 'unknown_tool',
              summary: tt('agent.mergedGuidance'),
              input: toolInputForHistory(skippedCall.function.name, skippedCall.function.arguments),
              output: tt('agent.mergedGuidanceOutput'),
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
              content: JSON.stringify({
                status: 'denied',
                summary: skipped.summary,
                result: skipped.output,
              }),
            });
          }
          await options.callbacks.onToolsChanged(cloneExecutions(executions));
          for (const update of guidance) {
            await options.callbacks.onTaskUpdate?.(update);
            requestMessages.push(update.request);
          }
          break;
        }
      }
    }

    const maxSteps = options.settings.agentMaxSteps;
    if (maxSteps > 0) {
      const notice = tt('agent.stepLimit', { steps: maxSteps });
      content += notice;
      await options.callbacks.onDelta({ content: notice });
      return { content, reasoning, usage, tools: executions, stoppedByStepLimit: true };
    }
    return { content, reasoning, usage, tools: executions, stoppedByStepLimit: false };
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
