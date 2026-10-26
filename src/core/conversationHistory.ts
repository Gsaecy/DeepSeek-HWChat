import { ChatMessage, ConversationSummary } from './types';
import { previewText } from './ids';

export function buildConversationHistoryDigest(
  conversation: ConversationSummary,
  messages: ChatMessage[],
  maxChars = 10_000,
): string {
  const userRequests = uniqueRecent(messages
    .filter((message) => message.role === 'user' && message.content.trim())
    .map((message) => previewText(message.content, 420)), 16);
  const successfulSteps = uniqueRecent(messages.flatMap((message) => (message.toolExecutions ?? [])
    .filter((tool) => tool.status === 'success')
    .map((tool) => {
      const files = tool.changedFiles?.length ? ` [${tool.changedFiles.join('、')}]` : '';
      return `${tool.summary}${files}`;
    })), 30);
  const warnings = uniqueRecent(messages.flatMap((message) => (message.toolExecutions ?? [])
    .filter((tool) => tool.status === 'error' || tool.status === 'denied')
    .map((tool) => `${tool.summary}${tool.output ? `：${previewText(tool.output, 260)}` : ''}`)), 18);
  const conclusions = uniqueRecent(messages
    .filter((message) => message.role === 'assistant' && message.status !== 'error' && message.content.trim())
    .map((message) => previewText(message.content, 600)), 8);
  const changedFiles = [...new Set(messages.flatMap((message) => (message.toolExecutions ?? [])
    .flatMap((tool) => tool.changedFiles ?? [])))].slice(-80);
  const skills = [...new Set(messages.flatMap((message) => (message.usedSkills ?? []).map((skill) => skill.name)))].slice(-20);

  const sections = [
    `来源对话：${conversation.title}`,
    `消息数：${conversation.messageCount}；累计用量：${conversation.totalTokens || 0} tokens；最后更新：${new Date(conversation.updatedAt).toISOString()}`,
    messages.length < conversation.messageCount
      ? `摘要采样：最近 ${messages.length} 条消息；更早细节可通过只读历史检索工具查询。`
      : '',
    conversation.sourceHistoryDigest
      ? `## 更早的关联任务历史\n${previewText(conversation.sourceHistoryDigest, 2_400)}`
      : '',
    formatSection('用户目标、补充与纠正', userRequests),
    formatSection('已成功执行的关键步骤', successfulSteps),
    formatSection('已修改或处理的文件', changedFiles),
    formatSection('失败、拒绝与已知坑点', warnings),
    formatSection('最近结论与交接说明', conclusions),
    formatSection('使用过的 Skill', skills),
  ].filter(Boolean).join('\n\n');
  return truncateDigest(sections, maxChars);
}

function uniqueRecent(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of [...values].reverse()) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result.reverse();
}

function formatSection(title: string, values: string[]): string {
  if (!values.length) return '';
  return [`## ${title}`, ...values.map((value) => `- ${value}`)].join('\n');
}

function truncateDigest(value: string, maxChars: number): string {
  const limit = Math.max(2_000, maxChars);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 80).trimEnd()}\n\n[任务历史摘要已截断；可使用只读历史检索工具查询细节]`;
}
