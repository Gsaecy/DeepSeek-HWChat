import type { AgentTaskNode, TodoArchive, TodoItem } from './types.js';

/**
 * 任务树 / 任务清单 = agent 的项目记忆。
 *
 * 用户的要求（2026-11-06）：
 *
 *     我希望保留对话记录，除非用户主动清理，但是对话记录已经不再是 agent 的记忆了，
 *     agent 只需要读取任务树和任务清单（包括执行一半退出和执行完的），就能知道对话
 *     中的项目情况，完整的对话记录，只在读取任务树和任务清单无法确定的情况下查找读取。
 *
 * 所以这里的取舍是：
 *  - **对话记录照常落盘**（用户不删就一直在），但不再逐轮灌进请求；
 *  - 每轮注入一份「做过什么」的任务记忆（已完成的任务带一句结论、进行中/待执行的照原样）；
 *  - 细节不够时模型调 `search_conversation_history` 去翻原文 —— 那里读的是完整记录。
 *
 * 这份记忆必须是**纯函数 + 有上限**的：它每轮都要拼进 system，不能随对话长度线性增长。
 */

/** 记忆里最多列多少条已完成任务（更早的只留计数）。 */
const FINISHED_LIMIT = 40;
/** 还没结束的任务最多列多少条（防止一次排了几十条消息把记忆撑爆）。 */
const OPEN_LIMIT = 20;
/** 每条任务最多记几条约束。 */
const CONSTRAINT_LIMIT = 3;
/** 单行最多多少字。 */
const LINE_LIMIT = 100;

function oneLine(text: string, limit = LINE_LIMIT): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * 从一段话里挑出「硬约束」。
 *
 * 结论回答「做成了什么」，约束回答「不许做什么 / 必须保留什么」。只看结论时，
 * 模型下一轮很容易把用户明确禁止的改动又做回去 —— 用户 2026-11-06 的原话是
 * 「可能只保存结果不保存约束」，这就是要补的那一块。
 *
 * 判据刻意保守：只认明确的约束词，且优先取**用户原话**。宁可少记，也不要
 * 把普通描述当成约束写进记忆（那会让模型不敢动手）。
 */
const CONSTRAINT_MARKERS = /(不要|不许|不准|不能|禁止|别|必须|务必|只能|只允许|保持|保留|不改|不动|不要动|无需|不需要|除非|一定|must not|must|do not|don't|never|only|keep|without changing|leave .* alone)/i;

export function constraintsOf(texts: readonly (string | undefined)[], limit = CONSTRAINT_LIMIT): string[] {
  const found: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const raw of text.split(/\n+/)) {
      /*
       * 一句话里常常并排写好几条规则（「不要动胶囊样式，必须保留 Esc」），
       * 按标点拆成小句再判断，记忆里才会是一条一条的。
       * 英文句号只在「句号 + 空格」处断，避免把 `package.json` 拆坏。
       */
      for (const clause of raw.replace(/^[-*>\s]+/, '').replace(/`/g, '').split(/[，,；;。！？]|\.\s+|\s+·\s+/)) {
        const line = clause.replace(/^\s*[和与及而且并且但但是\s]+/, '').replace(/[.。;；,，\s]+$/, '').trim();
        if (!line || line.length < 4) continue;
        if (!CONSTRAINT_MARKERS.test(line)) continue;
        const clipped = oneLine(line, 70);
        if (found.includes(clipped)) continue;
        found.push(clipped);
        if (found.length >= limit) return found;
      }
    }
  }
  return found;
}

/** 任务状态 → 记忆里那一行的标记。 */
export function taskMark(status: AgentTaskNode['status']): string {
  switch (status) {
    case 'complete': return '[x]';
    case 'active': return '[>]';
    case 'error': return '[!]';
    case 'cancelled': return '[-]';
    case 'merged': return '[=]';
    default: return '[ ]';
  }
}

/**
 * 合并任务树：按 id 覆盖，保留顺序，裁到上限。
 *
 * 为什么按 id 合并而不是整棵替换：任务树每一轮都是新建的（`AgentTaskQueue`），
 * 直接替换会把上一轮做完的任务全丢掉 —— 那就没有「记忆」可言了。
 * 已完成 / 出错的节点是历史，永远保留（直到裁剪）；进行中的状态以新的为准。
 */
export function mergeTaskNodes(
  existing: readonly AgentTaskNode[] | undefined,
  incoming: readonly AgentTaskNode[] | undefined,
): AgentTaskNode[] {
  const merged = new Map<string, AgentTaskNode>();
  const order: string[] = [];
  const push = (node: AgentTaskNode): void => {
    if (!node?.id) return;
    const previous = merged.get(node.id);
    if (previous) {
      // 新一轮的标题可能被用户改过；结论 / 绑定信息也不能因为重新下发而丢。
      merged.set(node.id, {
        ...previous,
        ...node,
        summary: node.summary ?? previous.summary,
        constraints: node.constraints?.length ? node.constraints : previous.constraints,
        userMessageId: node.userMessageId ?? previous.userMessageId,
        assistantMessageId: node.assistantMessageId ?? previous.assistantMessageId,
      });
      return;
    }
    order.push(node.id);
    merged.set(node.id, { ...node });
  };
  for (const node of existing ?? []) push(node);
  for (const node of incoming ?? []) push(node);
  const nodes = order.map((id) => merged.get(id)!).filter(Boolean);
  // 超上限时优先丢「已经没有信息量」的节点：先丢已取消/已合并，再丢最旧的已完成。
  while (nodes.length > FINISHED_LIMIT) {
    const droppable = nodes.findIndex((node) => node.status === 'cancelled' || node.status === 'merged');
    const index = droppable >= 0 ? droppable : nodes.findIndex((node) => node.status === 'complete' && node.summary);
    if (index < 0) break;
    nodes.splice(index, 1);
  }
  return nodes;
}

export interface TaskMemoryInput {
  nodes?: readonly AgentTaskNode[];
  todos?: readonly TodoItem[];
  todoArchives?: readonly TodoArchive[];
  /** 当前正在跑的任务标题（这一轮由面板知道，存档里的 active 可能还没刷新）。 */
  currentTitle?: string;
}

/**
 * 把任务树 + 清单渲染成 system 里的 `<project_memory>`。
 *
 * 没有任何任务也没有清单时返回空串（新对话不用背一段空记忆）。
 */
export function renderTaskMemory(input: TaskMemoryInput): string {
  const nodes = (input.nodes ?? []).filter((node) => node?.title?.trim());
  const finished = nodes.filter((node) => node.status === 'complete' || node.status === 'error' || node.status === 'cancelled' || node.status === 'merged');
  const open = nodes.filter((node) => !finished.includes(node));
  const todos = (input.todos ?? []).filter((todo) => todo?.content?.trim());
  /*
   * 未完成的条目由 `renderTodoContext` 负责注入（它带「下一条是什么 / 不要重开」的指令）；
   * 这里只把**已经做完**的条目当成记忆的一部分，避免同一份清单在 system 里出现两次。
   */
  const completedTodos = todos.filter((todo) => todo.status === 'completed');
  const archives = (input.todoArchives ?? []).filter((archive) => archive?.todos?.length);
  if (!nodes.length && !completedTodos.length && !archives.length) return '';

  const current = (input.currentTitle ?? '').trim();
  const shownFinished = finished.slice(-FINISHED_LIMIT);
  const hiddenFinished = finished.length - shownFinished.length;
  const constraintText = (node: AgentTaskNode): string => (node.constraints?.length
    ? ` ｜ 约束：${node.constraints.map((item) => oneLine(item, 70)).join('；')}`
    : '');
  const finishedLines = shownFinished.map((node) => {
    const mark = taskMark(node.status);
    const outcome = node.summary?.trim() ? ` — ${oneLine(node.summary)}` : '';
    return `- ${mark} ${oneLine(node.title)}${outcome}${constraintText(node)}`;
  });
  const shownOpen = open.slice(-OPEN_LIMIT);
  const hiddenOpen = open.length - shownOpen.length;
  const openLines = shownOpen.map((node) => `- ${taskMark(node.status)} ${oneLine(node.title)}${node.status === 'active' ? '（进行中）' : ''}${constraintText(node)}`);
  const todoLines = completedTodos.map((todo) => `- [x] ${oneLine(todo.content, 70)}`);
  const archiveLines = archives.slice(-3).map((archive) => {
    const done = archive.todos.filter((todo) => todo.status === 'completed').length;
    const latest = oneLine(archive.todos[archive.todos.length - 1]?.content ?? '', 50);
    return `- ${new Date(archive.createdAt).toISOString().slice(0, 10)}：${done}/${archive.todos.length} 完成，最后一项「${latest}」`;
  });

  return [
    '<project_memory>',
    'This is how this conversation remembers earlier work. The full chat record is kept on disk but is no longer sent word by word, so treat this block as your memory of the project: it lists every task of this conversation with its outcome.',
    current ? `Current task: ${oneLine(current)}` : '',
    openLines.length
      ? `<open_tasks>\n${hiddenOpen > 0 ? `(${hiddenOpen} older open task(s) not listed.)\n` : ''}${openLines.join('\n')}\n</open_tasks>`
      : '',
    finishedLines.length
      ? `<finished_tasks>\n${hiddenFinished > 0 ? `(${hiddenFinished} older finished task(s) not listed.)\n` : ''}${finishedLines.join('\n')}\n</finished_tasks>`
      : '',
    todoLines.length ? `<completed_task_list>\n${todoLines.join('\n')}\n</completed_task_list>` : '',
    archiveLines.length ? `<archived_task_lists>\n${archiveLines.join('\n')}\n</archived_task_lists>` : '',
    'Do not redo anything marked [x] unless the user asks for it, and always honour the 约束 (constraints) — they are rules the user already gave, so a change that violates them is wrong even if it looks like an improvement.',
    'When a detail in this block is not enough to act safely (exact error text, file path, earlier wording), call `search_conversation_history` to read the full record instead of guessing.',
    '</project_memory>',
  ].filter(Boolean).join('\n');
}
