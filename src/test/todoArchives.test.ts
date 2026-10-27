import assert from 'node:assert/strict';
import test from 'node:test';
import { TodoArchive, TodoItem } from '../core/types';
import {
  MAX_TODO_ARCHIVES,
  allTodosCompleted,
  appendTodoArchive,
  archiveColorHex,
  archiveColorRatio,
  createTodoArchive,
  normalizeTodoArchives,
  planTodoSettlement,
} from '../core/todoArchives';

function todos(...statuses: TodoItem['status'][]): TodoItem[] {
  return statuses.map((status, index) => ({ content: `步骤 ${index + 1}`, status }));
}

test('归档：只有全部完成的清单才算完成', () => {
  assert.equal(allTodosCompleted(todos('completed', 'completed')), true);
  assert.equal(allTodosCompleted(todos('completed', 'in_progress')), false);
  assert.equal(allTodosCompleted(todos('pending')), false);
  // 空清单不能算「完成」，否则没写过清单的对话也会冒出一颗胶囊。
  assert.equal(allTodosCompleted([]), false);
  assert.equal(allTodosCompleted(undefined), false);
});

test('归档：未完成的清单不生成归档（半成品留在面板上）', () => {
  assert.equal(createTodoArchive(todos('completed', 'pending'), 1), undefined);
  const archive = createTodoArchive(todos('completed', 'completed'), 1_700_000_000_000);
  assert.ok(archive);
  assert.equal(archive!.todos.length, 2);
  assert.equal(archive!.createdAt, 1_700_000_000_000);
  assert.match(archive!.id, /^todo-archive-/);
});

test('归档：追加保持时间顺序，超出上限丢最早的一条', () => {
  const makeArchive = (index: number): TodoArchive => ({
    id: `a-${index}`,
    createdAt: index,
    todos: todos('completed'),
  });
  let list: TodoArchive[] = [];
  for (let index = 0; index < MAX_TODO_ARCHIVES + 3; index += 1) {
    list = appendTodoArchive(list, makeArchive(index));
  }
  assert.equal(list.length, MAX_TODO_ARCHIVES);
  // 最早的三条被挤掉，队尾是最新的那条。
  assert.equal(list[0]?.id, 'a-3');
  assert.equal(list.at(-1)?.id, `a-${MAX_TODO_ARCHIVES + 2}`);
  // 传 undefined 时不新增，只做裁剪。
  assert.equal(appendTodoArchive(list, undefined).length, MAX_TODO_ARCHIVES);
});

test('归档：颜色从绿经浅蓝到深蓝，单条时保持绿色起点', () => {
  assert.equal(archiveColorRatio(0, 1), 0);
  assert.equal(archiveColorRatio(0, 4), 0);
  assert.equal(archiveColorRatio(3, 4), 1);
  // 首尾锚点与中间点
  assert.equal(archiveColorHex(0), '#2ea043');
  assert.equal(archiveColorHex(0.5), '#4aa8e0');
  assert.equal(archiveColorHex(1), '#1e4fd8');
  // 越界比例被夹住，不会算出 #NaN
  assert.equal(archiveColorHex(-3), '#2ea043');
  assert.equal(archiveColorHex(Number.POSITIVE_INFINITY), '#2ea043');
  assert.equal(archiveColorHex(99), '#1e4fd8');
  for (let step = 0; step <= 10; step += 1) {
    assert.match(archiveColorHex(step / 10), /^#[0-9a-f]{6}$/);
  }
});

test('归档：磁盘上的脏数据被归一化，不会把面板打崩', () => {
  assert.deepEqual(normalizeTodoArchives(undefined), []);
  assert.deepEqual(normalizeTodoArchives('nope'), []);
  const normalized = normalizeTodoArchives([
    null,
    { id: 'ok', createdAt: 5, todos: [{ content: '做完了', status: 'completed' }] },
    { id: 'empty', createdAt: 6, todos: [] },
    { createdAt: 'bad', todos: [{ content: '状态非法也保留', status: 'DONE' }] },
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0]?.id, 'ok');
  assert.equal(normalized[0]?.createdAt, 5);
  // 缺 id 时补一个稳定值，缺合法时间按 0 处理；非法状态降级成 pending。
  assert.match(normalized[1]?.id ?? '', /^todo-archive-/);
  assert.equal(normalized[1]?.createdAt, 0);
  assert.equal(normalized[1]?.todos[0]?.status, 'pending');
});

test('运行结束：清单全绿才归档，胶囊追加在已有归档之后', () => {
  const existing: TodoArchive[] = [
    { id: 'old', createdAt: 1, todos: [{ content: '旧任务', status: 'completed' }] },
  ];
  const todos: TodoItem[] = [
    { content: '读代码', status: 'completed' },
    { content: '改实现', status: 'completed' },
  ];
  const settlement = planTodoSettlement(todos, existing, 42);
  assert.equal(settlement.action, 'archive');
  if (settlement.action !== 'archive') return;
  assert.equal(settlement.archives.length, 2);
  assert.equal(settlement.archives[1]?.createdAt, 42);
  assert.equal(settlement.archives[1]?.todos.length, 2);
});

test('运行结束：执行失败/被停止的清单不被归档，降级成待办且一条不丢', () => {
  const todos: TodoItem[] = [
    { content: '读代码', status: 'completed' },
    { content: '改实现', status: 'in_progress' },
    { content: '补测试', status: 'pending' },
  ];
  const settlement = planTodoSettlement(todos, [], 42);
  assert.equal(settlement.action, 'interrupt');
  if (settlement.action !== 'interrupt') return;
  // 失败不清空清单：条目数、顺序都要保留，只有「执行中」被降级。
  assert.equal(settlement.todos.length, 3);
  assert.deepEqual(settlement.todos.map((todo) => todo.content), ['读代码', '改实现', '补测试']);
  assert.deepEqual(settlement.todos.map((todo) => todo.status), ['completed', 'pending', 'pending']);
});

test('运行结束：没有清单时不做任何处置', () => {
  assert.deepEqual(planTodoSettlement(undefined, []), { action: 'none' });
  assert.deepEqual(planTodoSettlement([], []), { action: 'none' });
});
