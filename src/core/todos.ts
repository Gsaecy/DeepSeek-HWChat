import { TodoItem, TodoStatus } from './types';

/**
 * 待办清单的归一化与校验。
 *
 * 清单完全由模型生成，必须当作不可信输入：
 * - 条数、单条长度、总长度都要有上限，否则一条工具调用就能把面板和存档撑爆；
 * - 状态只接受三个已知值，其余一律降级成 pending，避免面板出现没有样式的空状态；
 * - 空内容直接丢弃，但保留原有顺序（顺序就是执行顺序，不能排序）。
 */

const MAX_ITEMS = 40;
const MAX_CONTENT_LENGTH = 200;

const STATUS_SET: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

function normalizeStatus(value: unknown): TodoStatus {
  return typeof value === 'string' && STATUS_SET.has(value) ? value as TodoStatus : 'pending';
}

function normalizeContent(value: unknown): string {
  if (typeof value !== 'string') return '';
  // 单条内容压成一行：清单是一行一条，换行会把左侧文字撑成多行、破坏序号对齐。
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_LENGTH);
}

/**
 * 把工具参数里的 `todos` 归一化成安全的清单。
 * 返回空数组表示这次调用没有产生有效条目（调用方应给出提示而不是渲染空面板）。
 */
export function normalizeTodos(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) return [];
  const todos: TodoItem[] = [];
  for (const raw of input.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const content = normalizeContent(record.content);
    if (!content) continue;
    todos.push({ content, status: normalizeStatus(record.status) });
  }
  return todos;
}

/** 已完成数量，用于标题右侧的进度摘要。 */
export function completedCount(todos: readonly TodoItem[]): number {
  return todos.filter((todo) => todo.status === 'completed').length;
}

/**
 * 把「执行中」的条目落回「待办」。
 *
 * 停止、报错、关窗口之后都不会再有人推进这份清单，但存档里可能还留着 `in_progress`。
 * 面板拿到 `in_progress` 会一直播三点跳动动画，等于谎报「还在跑」。
 * 这里不引入「失败」状态（清单只有三种状态，成败由消息本身说明），只把 `in_progress`
 * 降级成 `pending`：用户接着做时模型会重新标 `in_progress`，照常完成并归档。
 *
 * `changed` 用于调用方决定要不要落库——没有执行中的条目就不要白写一次 manifest。
 */
export function settleInterruptedTodos(todos: readonly TodoItem[] | undefined): { todos: TodoItem[]; changed: boolean } {
  if (!todos?.length) return { todos: [], changed: false };
  let changed = false;
  const settled = todos.map((todo) => {
    if (todo.status !== 'in_progress') return { content: todo.content, status: todo.status };
    changed = true;
    return { content: todo.content, status: 'pending' as const };
  });
  return { todos: settled, changed };
}

/**
 * 模型有时会漏掉「同一时刻只有一个执行中」这条约定。
 * 这里不做强制改写（那是模型的责任，悄悄改掉反而掩盖问题），
 * 只提供一个判定给调用方决定是否需要提示。
 */
export function hasMultipleInProgress(todos: readonly TodoItem[]): boolean {
  return todos.filter((todo) => todo.status === 'in_progress').length > 1;
}

/**
 * 清单是否处于「可以接着干」的状态。
 *
 * 判定刻意不看有没有 `in_progress`：中断结算会把它降级成 `pending`，所以「还剩没打勾的项」
 * 才是唯一可靠的依据。全部打勾的清单会在结算时归档、根本不会以这个状态留在面板上。
 *
 * `interrupted` / `incomplete` 两者都要认：前者是进程被杀 / 用户停止，后者是模型正常收尾
 * 但漏了打勾。对用户来说「还有活没干完」是一回事，顶栏按钮应该一样给出。
 */
export function isResumableTodos(
  todos: readonly TodoItem[] | undefined,
  interrupted: boolean,
  incomplete: boolean,
): boolean {
  if (!todos?.length) return false;
  if (!interrupted && !incomplete) return false;
  return todos.some((todo) => todo.status !== 'completed');
}

/**
 * 「取消任务」的落库值：清空清单，**不归档**、不留任何标记。
 *
 * 与 `settleTodosAfterRun` 的归档路径刻意不同：归档代表「这份清单完成了历史使命」，
 * 会变成面板底部的胶囊长期保留；用户点「取消」表达的是「别记着了」，所以连胶囊都不能留。
 */
export function clearedTodoState(): {
  todos: null;
  todosInterrupted: null;
  todosIncomplete: null;
} {
  return { todos: null, todosInterrupted: null, todosIncomplete: null };
}

/**
 * 把当前清单渲染成给模型看的上下文。
 *
 * 真实故障：用户点「继续执行」，模型只收到一句「继续执行当前任务清单里尚未完成的
 * 条目」，却**看不到清单本身** —— `requestMessages()` 会跳过所有 `role: 'tool'`
 * 消息（`update_todos` 的返回值就在里面），清单又只存在对话摘要的 `todos` 字段里。
 * 于是它要么猜、要么从头再来，清单就卡在原地。
 *
 * 输出刻意做成「带状态的结构化列表 + 明确的下一条」，而不是把原始 JSON 塞进去：
 * 模型据此就能接着说「第 N 条还没做完」，也不需要自己推断哪个是下一个。
 * 全部完成 / 没有清单时返回空串，调用方据此跳过注入。
 */
export function renderTodoContext(
  todos: readonly TodoItem[] | undefined,
  flags: { interrupted?: boolean; incomplete?: boolean } = {},
): string {
  const items = (todos ?? []).filter((todo) => todo && typeof todo.content === 'string' && todo.content.trim());
  if (!items.length) return '';
  const remaining = items.filter((todo) => todo.status !== 'completed');
  if (!remaining.length) return '';

  const mark = (status: TodoStatus): string => status === 'completed' ? '[x]' : status === 'in_progress' ? '[>]' : '[ ]';
  const lines = items.map((todo, index) => `${index + 1}. ${mark(todo.status)} ${todo.content.trim()}`);
  const nextIndex = items.findIndex((todo) => todo.status !== 'completed');
  const state = flags.interrupted
    ? 'This list was interrupted before it finished.'
    : flags.incomplete
      ? 'This list is still unfinished at the end of the previous turn.'
      : 'This list is still in progress.';

  return [
    '<task_list>',
    state,
    ...lines,
    `Legend: [x] completed, [>] in progress, [ ] pending. ${remaining.length} of ${items.length} item(s) are not finished.`,
    nextIndex >= 0
      ? `Next item to work on: #${nextIndex + 1} "${items[nextIndex]!.content.trim()}". Continue from there; do not restart items already marked [x].`
      : '',
    'Keep using update_todos with the whole list (never an empty array). Only mark an item completed after its work is verified.',
    'This is the SAME list the user is continuing. Re-submit these exact items (keep every [x] with its original wording) and change only their status; put any new step at the end. Do NOT create or re-plan a new list — dropping a completed item is rejected by the tool.',
    '</task_list>',
  ].filter(Boolean).join('\n');
}
