import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { TodoArchive, TodoItem } from '../core/types';
import {
  allTodosCompleted,
  appendTodoArchive,
  archiveColorHex,
  archiveColorRatio,
  createTodoArchive,
  normalizeTodoArchives,
  planCompletedList,
  planTodoSettlement,
  sameTodoList,
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

test('归档：追加保持时间顺序，且不设数量上限', () => {
  const makeArchive = (index: number): TodoArchive => ({
    id: `a-${index}`,
    createdAt: index,
    todos: todos('completed'),
  });
  let list: TodoArchive[] = [];
  // 40 份远超原先 12 份的上限：胶囊栏可以横向滚动，没有理由再挤掉最早的归档。
  for (let index = 0; index < 40; index += 1) {
    list = appendTodoArchive(list, makeArchive(index));
  }
  assert.equal(list.length, 40, '一份都不能丢');
  assert.equal(list[0]?.id, 'a-0', '最早的一份仍然保留');
  assert.equal(list.at(-1)?.id, 'a-39', '最新的一份在队尾');
  // 传 undefined 时不新增，也不改动已有列表。
  assert.equal(appendTodoArchive(list, undefined).length, 40);
  assert.equal(appendTodoArchive(undefined, undefined).length, 0, '没有旧归档也不该报错');
});

test('归档：颜色从浅蓝到深蓝，单条时取浅蓝起点', () => {
  assert.equal(archiveColorRatio(0, 1), 0);
  assert.equal(archiveColorRatio(0, 4), 0);
  assert.equal(archiveColorRatio(3, 4), 1);
  // 首尾锚点与中间点
  assert.equal(archiveColorHex(0), '#7cbef0');
  assert.equal(archiveColorHex(0.5), '#4d87e4');
  assert.equal(archiveColorHex(1), '#1e4fd8');
  // 越界比例被夹住，不会算出 #NaN
  assert.equal(archiveColorHex(-3), '#7cbef0');
  assert.equal(archiveColorHex(Number.POSITIVE_INFINITY), '#7cbef0');
  assert.equal(archiveColorHex(99), '#1e4fd8');
  for (let step = 0; step <= 10; step += 1) {
    assert.match(archiveColorHex(step / 10), /^#[0-9a-f]{6}$/);
  }
});

test('归档：胶囊是一段连续渐变，相邻两颗之间的色差相等', () => {
  const total = 6;
  const channels = Array.from({ length: total }, (_, index) => {
    const hex = archiveColorHex(archiveColorRatio(index, total));
    return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  });
  // 三通道都单调递减 = 从浅蓝一路变深（不再经过绿色）。
  for (let step = 1; step < total; step += 1) {
    for (const band of [0, 1, 2]) {
      assert.ok(
        channels[step]![band]! < channels[step - 1]![band]!,
        `第 ${step + 1} 颗的第 ${band} 通道应比前一颗更深`,
      );
    }
  }
  // 相邻间距彼此相差不超过 1（四舍五入误差）：这才会看起来像一段过渡渐变，
  // 而不是「两块绿 + 一块蓝」那种跳色。
  const steps = channels.slice(1).map((color, at) => (channels[at]![0] ?? 0) - (color[0] ?? 0));
  for (const value of steps) assert.ok(Math.abs(value - steps[0]!) <= 1, `相邻间距不一致：${steps.join('/')}`);
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
  // 失败与停止都算「被掐断」，标记必须保持一致。
  for (const outcome of ['failed', 'stopped'] as const) {
    const settlement = planTodoSettlement(todos, [], 42, outcome);
    assert.equal(settlement.action, 'interrupt', outcome);
    if (settlement.action !== 'interrupt') return;
    // 失败不清空清单：条目数、顺序都要保留，只有「执行中」被降级。
    assert.equal(settlement.todos.length, 3);
    assert.deepEqual(settlement.todos.map((todo) => todo.content), ['读代码', '改实现', '补测试']);
    assert.deepEqual(settlement.todos.map((todo) => todo.status), ['completed', 'pending', 'pending']);
  }
});

test('运行结束：正常跑完却没全打勾 → 标「未完成」而不是「已中断」', () => {
  // 复现 0.2.2 现场：最后一步实际做完了，但模型漏了打勾，运行正常结束。
  const todos: TodoItem[] = [
    { content: '准备', status: 'completed' },
    { content: '提交并推送', status: 'in_progress' },
  ];
  const settlement = planTodoSettlement(todos, [], 42, 'completed');
  assert.equal(settlement.action, 'incomplete');
  if (settlement.action !== 'incomplete') return;
  // 引擎不替模型打勾：遗留项只降级成 pending，绝不谎报 completed。
  assert.deepEqual(settlement.todos.map((todo) => todo.status), ['completed', 'pending']);
  assert.deepEqual(settlement.todos.map((todo) => todo.content), ['准备', '提交并推送']);
});

test('运行结束：正常跑完且全绿仍然归档，与运行结局无关', () => {
  const settlement = planTodoSettlement(todos('completed', 'completed'), [], 42, 'completed');
  assert.equal(settlement.action, 'archive');
});

test('运行结束：没有清单时不做任何处置', () => {
  assert.deepEqual(planTodoSettlement(undefined, []), { action: 'none' });
  assert.deepEqual(planTodoSettlement([], []), { action: 'none' });
  assert.deepEqual(planTodoSettlement([], [], 42, 'failed'), { action: 'none' });
});

/**
 * 「做完就归档」：全部完成的清单不能再占着面板。
 *
 * 背景（用户反馈）：任务执行完、清单显示 6/6 已完成，面板却一直挂着占位置。
 * 原来的归档只发生在「这一轮运行结束」时，于是有两种漏网：
 * - 模型标完最后一项后还要写很久总结，这段时间清单一直占着输入框上方；
 * - 进程被杀 / 窗口关掉正好夹在「最后一项打勾」和「运行结束」之间，收尾那一步不会
 *   执行，这份已完成的清单就永远留在面板上。
 */
test('全部完成：立刻归档，且不该再留在面板上', () => {
  const list = todos('completed', 'completed', 'completed');
  const plan = planCompletedList(list, [], 42);
  assert.ok(plan, '全绿清单必须有归档计划');
  assert.equal(plan!.archived, true);
  assert.equal(plan!.archives.length, 1);
  assert.deepEqual(plan!.archives[0]!.todos.map((todo) => todo.status), ['completed', 'completed', 'completed']);
});

test('没全绿：不归档，清单继续留在面板上', () => {
  assert.equal(planCompletedList(todos('completed', 'pending'), []), undefined);
  assert.equal(planCompletedList(todos('in_progress'), []), undefined);
  // 空清单同样不该冒出一颗胶囊。
  assert.equal(planCompletedList([], []), undefined);
  assert.equal(planCompletedList(undefined, []), undefined);
});

test('同一份清单重复提交：不重复追加胶囊，但调用方仍应把它从面板撤掉', () => {
  const list = todos('completed', 'completed');
  const first = planCompletedList(list, [], 42);
  assert.equal(first!.archives.length, 1);

  // 模型收尾时常把同一份进度再发一次：不该多出第二颗一模一样的胶囊。
  const again = planCompletedList(list.map((todo) => ({ ...todo })), first!.archives, 43);
  assert.ok(again);
  assert.equal(again!.archived, false);
  assert.equal(again!.archives.length, 1);
});

test('清单内容变了（哪怕仍然全绿）就算新的一份，照常归档', () => {
  const first = planCompletedList(todos('completed', 'completed'), [], 42);
  const nextList: TodoItem[] = [
    { content: '步骤 1', status: 'completed' },
    { content: '换了个步骤名', status: 'completed' },
  ];
  const second = planCompletedList(nextList, first!.archives, 43);
  assert.equal(second!.archived, true);
  assert.equal(second!.archives.length, 2);
});

test('归档不设上限：已有的归档一份都不会被挤掉', () => {
  const many: TodoArchive[] = Array.from({ length: 30 }, (_, index) => ({
    id: `a-${index}`,
    createdAt: index,
    todos: [{ content: `旧清单 ${index}`, status: 'completed' as const }],
  }));
  const plan = planCompletedList(todos('completed'), many, 999);
  assert.equal(plan!.archives.length, 31, '30 份旧归档 + 新归档全部保留');
  assert.equal(plan!.archives[plan!.archives.length - 1]!.createdAt, 999, '最新一条在末尾');
  assert.ok(plan!.archives.some((archive) => archive.id === 'a-0'), '最早的一条也必须还在');
});

test('清单比对：顺序与内容都要一致才算同一份', () => {
  const a: TodoItem[] = [
    { content: '一', status: 'completed' },
    { content: '二', status: 'completed' },
  ];
  assert.equal(sameTodoList(a, a.map((todo) => ({ ...todo }))), true);
  assert.equal(sameTodoList(a, [a[1]!, a[0]!]), false, '换了顺序就是另一份');
  assert.equal(sameTodoList(a, [a[0]!]), false, '条数不同');
  assert.equal(sameTodoList(a, [{ content: '一', status: 'pending' }, a[1]!]), false, '状态不同');
  assert.equal(sameTodoList([], []), false, '空清单不算同一份（也不该被归档）');
});

test('接线：清单写入口与读取入口都走了「完成即归档」', () => {
  const chatPanel = readFileSync(join(process.cwd(), 'src', 'views', 'chatPanel.ts'), 'utf8');
  // update_todos 写完立刻判断；viewTodos 在读的时候补一次（进程被杀留下的残局）。
  assert.equal((chatPanel.match(/planCompletedList\(/g) ?? []).length, 2, '应该在写入与读取两处各调一次');
  assert.ok(chatPanel.includes('const keepList = !completedPlan;'), '写入口要据此把清单从面板撤掉');
  assert.ok(chatPanel.includes('todos: keepList ? todos : null'), '归档后存档里不该留着这份清单');
});
