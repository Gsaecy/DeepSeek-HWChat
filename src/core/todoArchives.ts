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

/**
 * 归档胶囊**不设数量上限**。
 *
 * 以前这里卡在 12 条，理由是「太多会让输入框上方变成一排细线」。现在胶囊栏已经
 * 支持横向滚动（滚轮 / 拖动 / 触摸惯性），一排排不下也不再挤坏版面，限量的理由
 * 就不成立了 —— 而限量带来的后果是真实的：一个跑到第 13 份清单的长任务里，
 * 最早那几份归档会被静默挤掉，用户回头就找不到「刚才做了哪几步」。
 *
 * 存储上仍然是有界的：单条归档最多 40 项（`MAX_ARCHIVED_ITEMS`），而一条归档对应
 * 一份**已完成**的清单，所以 manifest 的增长与用户实际完成的任务数同阶。
 */

/** 单条归档里最多保留的条目数，与 `todos.ts` 的上限保持一致。 */
const MAX_ARCHIVED_ITEMS = 40;

/**
 * 胶囊配色的两个锚点：浅蓝 → 深蓝。
 *
 * 颜色按「在列表里的位置」均匀取样（见 archiveColorRatio），所以相邻两颗胶囊
 * 落在色带上的间距相等，看起来是从浅蓝到深蓝的一段连续渐变，而不是几块跳色。
 * 只用蓝色系：底色越深 = 越新，左边最浅、右边最深。
 */
const COLOR_STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [124, 190, 240]], // #7cbef0 浅蓝
  [1, [30, 79, 216]],   // #1e4fd8 深蓝
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
 * 顺序即显示顺序（最早的浅蓝在左，最新的深蓝在右），所以只能从头部裁剪。
 */
export function appendTodoArchive(
  existing: readonly TodoArchive[] | undefined,
  archive: TodoArchive | undefined,
): TodoArchive[] {
  const list = [...(existing ?? [])];
  if (archive) list.push(archive);
  return list;
}

/** 0（最早，浅蓝）到 1（最新，深蓝）之间的比例；只有一条时取 0，保持浅蓝起点。 */
export function archiveColorRatio(index: number, total: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 1) return 0;
  return Math.min(1, Math.max(0, index / (total - 1)));
}

/** 按比例在浅蓝 → 深蓝之间插值，返回 `#rrggbb`。 */
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
  for (const raw of input) {
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
  return archives;
}

/**
 * 两份清单的内容与状态是否完全一致（逐条按顺序比对）。
 *
 * 用来挡住「同一份已完成的清单被反复提交」：模型偶尔会在同一轮里再发一次一样的清单
 * （比如收尾时重述进度），若每次都归档，胶囊栏会凭空多出一排一模一样的胶囊。
 */
export function sameTodoList(
  left: readonly TodoItem[] | undefined,
  right: readonly TodoItem[] | undefined,
): boolean {
  if (!left?.length || !right?.length || left.length !== right.length) return false;
  return left.every((todo, index) => {
    const other = right[index]!;
    return todo.content === other.content && todo.status === other.status;
  });
}

/** 「这份已完成的清单该怎么处置」的结论。 */
export interface CompletedListPlan {
  /** 归档后的完整列表（重复提交时与入参相同）。 */
  archives: TodoArchive[];
  /** 这次是否真的新增了一颗胶囊。 */
  archived: boolean;
}

/**
 * 一份**已全部完成**的清单：立刻压成胶囊，不再占着面板。
 *
 * 为什么不等到「一轮运行结束」再归档：模型标完最后一项之后往往还要写很久总结、跑验证，
 * 那段时间清单一直挂在输入框上方占着位置；窗口被杀或扩展重载时更糟——收尾那一步不会
 * 执行，这份「6/6 已完成」的清单会永远留在面板上（用户看到的就是「做完了却没归档」）。
 *
 * 未完成的清单返回 `undefined`：执行到一半的清单必须留在面板上，不能悄悄归档。
 * 与最后一条胶囊完全相同的清单也返回 `archived: false`，但调用方**仍然应该把它从面板
 * 上撤掉**——它已经归档过了。
 */
export function planCompletedList(
  todos: readonly TodoItem[] | undefined,
  archives: readonly TodoArchive[] | undefined,
  createdAt = Date.now(),
): CompletedListPlan | undefined {
  if (!allTodosCompleted(todos)) return undefined;
  const list = [...(archives ?? [])];
  const last = list[list.length - 1];
  if (last && sameTodoList(last.todos, todos)) return { archives: list, archived: false };
  const archive = createTodoArchive(todos, createdAt);
  if (!archive) return undefined;
  return { archives: appendTodoArchive(list, archive), archived: true };
}

/**
 * 一轮运行是怎么结束的。
 *
 * `completed` —— Agent 循环正常跑完（没抛错、没被停止）；
 * `stopped`   —— 用户点了停止；
 * `failed`    —— 请求报错、网络断开等异常收尾。
 *
 * 为什么要区分：这三种情况在旧代码里都算「清单没全绿」，于是统一标成「已中断」。
 * 但「正常跑完、只是模型漏了给最后一项打勾」并不是中断，标成中断会让用户以为
 * 任务被半路掐断了（0.2.2 实测复现）。
 */
export type TodoRunOutcome = 'completed' | 'stopped' | 'failed';

/** 一轮运行结束时，清单的处置方式。 */
export type TodoSettlement =
  | { action: 'none' }
  | { action: 'archive'; archives: TodoArchive[] }
  | { action: 'interrupt'; todos: TodoItem[] }
  | { action: 'incomplete'; todos: TodoItem[] };

/**
 * 决定一份清单在运行结束时是归档还是留成待办。
 *
 * 全部完成 → 归档成胶囊；否则清单留在面板上，把 `in_progress` 降级成 `pending`
 * 交给用户决定（接着做完 / 换新任务覆盖）。剩下两种情况按运行结局区分：
 * - 正常跑完却还有没打勾的项 → `incomplete`，界面标「未完成」，不谎称被中断；
 * - 被停止 / 报错 → `interrupt`，界面标「已中断」。
 *
 * 这里刻意不把遗留的 `in_progress` 自动改成 `completed`：清单是模型对「做完了没」的
 * 陈述，引擎替它打勾等于伪造进度。真要收尾只能由模型自己再调一次 `update_todos`
 * （system prompt 里有对应硬规则）。
 *
 * 抽成纯函数是为了让这几条规则能被单测直接钉住。
 */
export function planTodoSettlement(
  todos: readonly TodoItem[] | undefined,
  archives: readonly TodoArchive[] | undefined,
  createdAt = Date.now(),
  outcome: TodoRunOutcome = 'completed',
): TodoSettlement {
  if (!todos?.length) return { action: 'none' };
  const archive = createTodoArchive(todos, createdAt);
  if (archive) return { action: 'archive', archives: appendTodoArchive(archives, archive) };
  const settled = settleInterruptedTodos(todos).todos;
  return outcome === 'completed'
    ? { action: 'incomplete', todos: settled }
    : { action: 'interrupt', todos: settled };
}
