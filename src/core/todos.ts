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
 * 模型有时会漏掉「同一时刻只有一个执行中」这条约定。
 * 这里不做强制改写（那是模型的责任，悄悄改掉反而掩盖问题），
 * 只提供一个判定给调用方决定是否需要提示。
 */
export function hasMultipleInProgress(todos: readonly TodoItem[]): boolean {
  return todos.filter((todo) => todo.status === 'in_progress').length > 1;
}
