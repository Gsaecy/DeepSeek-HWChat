import { TodoArchive, TodoItem } from './types';
import { normalizeTodos, settleInterruptedTodos } from './todos';

/**
 * 任务清单归档。
 *
 * 一次对话里模型可能先后给出多份任务清单（一轮大任务一份）。清单全部完成后就不再需要
 * 占着输入框上方那一整块折叠面板，但也不该被直接丢掉——用户仍要能回看「刚才做了哪几步」。
 * 所以这里把它压成一条胶囊：面板只留胶囊，点一下才展开清单。
 *
 * 本模块只做纯数据处理（不认识 UI），配色也只算一个 0..1 的比例，方便单测。
 */

/** 一份对话最多保留多少条归档胶囊。太多会让输入框上方变成一排细线，反而不如不显示。 */
export const MAX_TODO_ARCHIVES = 12;

/** 单条归档里最多保留的条目数，与 `todos.ts` 的上限保持一致。 */
const MAX_ARCHIVED_ITEMS = 40;

/** 胶囊配色的三个锚点：绿 → 浅蓝 → 深蓝。 */
const COLOR_STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [46, 160, 67]],    // #2ea043 绿
  [0.5, [74, 168, 224]], // #4aa8e0 浅蓝
  [1, [30, 79, 216]],    // #1e4fd8 深蓝
];

/** 清单是否全部完成（空清单不算完成，避免把「没写过」当成「写完了」）。 */
export function allTodosCompleted(todos: readonly TodoItem[] | undefined): boolean {
  if (!todos?.length) return false;
  return todos.every((todo) => todo.status === 'completed');
}

/**
 * 把一份已完成的清单压成归档记录。
 * 未完成的清单返回 `undefined`：执行中被停止的任务必须留在面板上，不能悄悄归档。
 */
export function createTodoArchive(todos: readonly TodoItem[] | undefined, createdAt = Date.now()): TodoArchive | undefined {
  if (!allTodosCompleted(todos)) return undefined;
  return {
    id: `todo-archive-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
    todos: (todos as TodoItem[]).map((todo) => ({ content: todo.content, status: todo.status })),
  };
}

/**
 * 追加一条归档，超出上限时丢最早的那条。
 *
 * 顺序即显示顺序（最早的绿色在左，最新的深蓝在右），所以只能从头部裁剪。
 */
export function appendTodoArchive(
  existing: readonly TodoArchive[] | undefined,
  archive: TodoArchive | undefined,
  limit = MAX_TODO_ARCHIVES,
): TodoArchive[] {
  const list = [...(existing ?? [])];
  if (!archive) return list.slice(-limit);
  list.push(archive);
  return list.slice(-limit);
}

/** 0（最早，绿）到 1（最新，深蓝）之间的比例；只有一条时取 0，保持绿色起点。 */
export function archiveColorRatio(index: number, total: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 1) return 0;
  return Math.min(1, Math.max(0, index / (total - 1)));
}

/** 按比例在绿 → 浅蓝 → 深蓝之间插值，返回 `#rrggbb`。 */
export function archiveColorHex(ratio: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  let upper = 1;
  while (upper < COLOR_STOPS.length - 1 && clamped > COLOR_STOPS[upper]![0]) upper += 1;
  const [fromAt, fromColor] = COLOR_STOPS[upper - 1]!;
  const [toAt, toColor] = COLOR_STOPS[upper]!;
  const span = toAt - fromAt;
  const local = span <= 0 ? 0 : (clamped - fromAt) / span;
  const channel = (index: 0 | 1 | 2): string => Math.round(fromColor[index] + (toColor[index] - fromColor[index]) * local)
    .toString(16)
    .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/**
 * 把存档里的归档列表归一化。
 *
 * manifest 是磁盘上的数据，可能来自更老的版本、也可能被手工改坏，因此：
 * - 整体不是数组就当作没有归档；
 * - 每条都要能被 `normalizeTodos` 接受，条目为空则丢弃整条；
 * - 时间戳非法就用 0（排序稳定，不会因为一条脏数据把整排胶囊打乱）。
 */
export function normalizeTodoArchives(input: unknown): TodoArchive[] {
  if (!Array.isArray(input)) return [];
  const archives: TodoArchive[] = [];
  for (const raw of input.slice(-MAX_TODO_ARCHIVES)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const todos = normalizeTodos(record.todos).slice(0, MAX_ARCHIVED_ITEMS);
    if (!todos.length) continue;
    const createdAt = Number(record.createdAt);
    archives.push({
      id: typeof record.id === 'string' && record.id ? record.id : `todo-archive-${archives.length}`,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      todos,
    });
  }
  return archives.slice(-MAX_TODO_ARCHIVES);
}

/** 一轮运行结束时，清单的处置方式。 */
export type TodoSettlement =
  | { action: 'none' }
  | { action: 'archive'; archives: TodoArchive[] }
  | { action: 'interrupt'; todos: TodoItem[] };

/**
 * 决定一份清单在运行结束时是归档还是留成待办。
 *
 * 成功、失败、被停止都走这一处判断：全部完成 → 归档成胶囊；否则 → 清单留在面板上，
 * 把 `in_progress` 降级成 `pending` 交给用户决定（接着做完 / 换新任务覆盖）。
 * 抽成纯函数是为了让「失败也不清空清单」这条规则能被单测直接钉住。
 */
export function planTodoSettlement(
  todos: readonly TodoItem[] | undefined,
  archives: readonly TodoArchive[] | undefined,
  createdAt = Date.now(),
): TodoSettlement {
  if (!todos?.length) return { action: 'none' };
  const archive = createTodoArchive(todos, createdAt);
  if (archive) return { action: 'archive', archives: appendTodoArchive(archives, archive) };
  return { action: 'interrupt', todos: settleInterruptedTodos(todos).todos };
}
