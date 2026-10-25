import { ChatSettings, UsageInfo } from '../core/types';
import { DeepSeekClient } from '../providers/deepseekClient';
import { fallbackTaskRelation, TaskRelation } from './taskQueue';

export interface TaskRelationResult {
  relation: TaskRelation;
  usage?: UsageInfo;
}

export async function classifyTaskRelation(
  client: DeepSeekClient,
  settings: ChatSettings,
  currentTask: string,
  incomingTask: string,
  signal: AbortSignal,
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
          'Reply with exactly RELATED when it should be merged into the active task.',
          'Reply with exactly QUEUED when it is an independent task that should wait.',
          'Corrections, constraints, follow-up details, stop/replace instructions, and requests about the same files or goal are RELATED.',
        ].join(' '),
      },
      { role: 'user', content: `CURRENT TASK:\n${currentTask}\n\nINCOMING MESSAGE:\n${incomingTask}` },
    ],
    {
      signal,
      onDelta: (delta) => { content += delta.content ?? ''; },
    },
  );
  const normalized = `${content}\n${result.content}`.trim().toLocaleUpperCase();
  const relation = normalized.includes('RELATED')
    ? 'related'
    : normalized.includes('QUEUED')
      ? 'queued'
      : fallbackTaskRelation(currentTask, incomingTask);
  return { relation, usage: result.usage };
}
