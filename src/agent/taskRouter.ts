import { ChatSettings, UsageInfo } from '../core/types';
import { DeepSeekClient } from '../providers/deepseekClient';
import { fallbackTaskRelation, TaskRelation } from './taskQueue';

export interface TaskRelationResult {
  relation: TaskRelation;
  usage?: UsageInfo;
}

/**
 * 把分类模型的回复解析成关联判定（`undefined` 表示没看懂，交给关键词兜底）。
 *
 * 必须显式处理否定形式：`UNRELATED` 里就包含子串 `RELATED`，`NOT RELATED` 同理。
 * 早期实现直接写 `normalized.includes('RELATED')`，于是模型回答「不相关」时
 * 反而被判成「已合并」—— 任务树里把不相干的任务标成「已合并」，正是这里来的。
 */
export function parseTaskRelation(reply: string): TaskRelation | undefined {
  const text = reply.toLocaleUpperCase();
  if (/\bUNRELATED\b/.test(text)) return 'queued';
  if (/\bNOT\s+RELATED\b/.test(text)) return 'queued';
  if (/\bIRRELEVANT\b/.test(text)) return 'queued';
  if (/\bQUEUED\b/.test(text)) return 'queued';
  if (/\bRELATED\b/.test(text)) return 'related';
  return undefined;
}

export async function classifyTaskRelation(
  client: DeepSeekClient,
  settings: ChatSettings,
  currentTask: string,
  incomingTask: string,
  signal: AbortSignal,
  resumeScope = false,
): Promise<TaskRelationResult> {
  let content = '';
  const result = await client.streamChat(
    {
      ...settings,
      temperature: 0,
      maxTokens: 24,
      reasoningEffort: 'none',
    },
    [
      {
        role: 'system',
        content: [
          'Classify whether an incoming coding-agent message changes or guides the current task.',
          'Reply with exactly one word, RELATED or QUEUED. Never add a negation.',
          'RELATED: corrections, constraints, follow-up details, stop/replace instructions, or more detail about the same deliverable.',
          'QUEUED: a different deliverable — a separate feature, component, or goal — even when it lives in the same project, the same files, or the same technology.',
          ...(resumeScope
            ? ['CURRENT TASK is a resumed work list copied from a paused task list, so it names several work items rather than one deliverable. A message that names a different deliverable is QUEUED, even when it touches the same project.']
            : []),
          'When unsure whether it is the same deliverable, answer QUEUED.',
        ].join(' '),
      },
      { role: 'user', content: `CURRENT TASK:\n${currentTask}\n\nINCOMING MESSAGE:\n${incomingTask}` },
    ],
    {
      signal,
      onDelta: (delta) => { content += delta.content ?? ''; },
    },
  );
  const normalized = `${content}\n${result.content}`.trim();
  const relation = parseTaskRelation(normalized) ?? fallbackTaskRelation(currentTask, incomingTask);
  return { relation, usage: result.usage };
}
