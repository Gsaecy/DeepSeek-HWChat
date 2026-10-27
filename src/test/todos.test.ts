import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTodos, completedCount, hasMultipleInProgress, settleInterruptedTodos, isResumableTodos, clearedTodoState } from '../core/todos';

test('待办：按传入顺序保留，不排序', () => {
  const todos = normalizeTodos([
    { content: '先读代码', status: 'completed' },
    { content: '再改实现', status: 'in_progress' },
    { content: '最后跑测试', status: 'pending' },
  ]);
  assert.deepEqual(todos.map((todo) => todo.content), ['先读代码', '再改实现', '最后跑测试']);
  assert.deepEqual(todos.map((todo) => todo.status), ['completed', 'in_progress', 'pending']);
});

test('待办：未知状态降级为 pending，不产生无样式状态', () => {
  const todos = normalizeTodos([
    { content: 'A', status: 'done' },
    { content: 'B' },
    { content: 'C', status: 42 },
    { content: 'D', status: 'IN_PROGRESS' },
  ]);
  assert.deepEqual(todos.map((todo) => todo.status), ['pending', 'pending', 'pending', 'pending']);
});

test('待办：丢弃无效条目但保留其余顺序', () => {
  const todos = normalizeTodos([
    { content: '有效 1', status: 'pending' },
    { content: '   ', status: 'pending' },
    { status: 'pending' },
    { content: '有效 2', status: 'completed' },
    null,
    'not-an-object',
    { content: 123, status: 'pending' },
  ]);
  assert.deepEqual(todos.map((todo) => todo.content), ['有效 1', '有效 2']);
});

test('待办：单条内容压成一行并截断到 200 字符', () => {
  const [wrapped] = normalizeTodos([{ content: '第一行\n第二行\t第三行', status: 'pending' }]);
  assert.equal(wrapped!.content, '第一行 第二行 第三行');

  const [long] = normalizeTodos([{ content: 'あ'.repeat(500), status: 'pending' }]);
  assert.equal(long!.content.length, 200);
});

test('待办：条数上限 40，防止一次调用把面板撑爆', () => {
  const many = Array.from({ length: 120 }, (_, index) => ({ content: `步骤 ${index + 1}`, status: 'pending' }));
  const todos = normalizeTodos(many);
  assert.equal(todos.length, 40);
  assert.equal(todos[39]!.content, '步骤 40');
});

test('待办：非数组输入返回空清单', () => {
  assert.deepEqual(normalizeTodos(undefined), []);
  assert.deepEqual(normalizeTodos(null), []);
  assert.deepEqual(normalizeTodos({ content: 'A', status: 'pending' }), []);
  assert.deepEqual(normalizeTodos('[]'), []);
});

test('待办：完成数与多执行中判定', () => {
  const todos = normalizeTodos([
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'completed' },
    { content: 'C', status: 'in_progress' },
    { content: 'D', status: 'pending' },
  ]);
  assert.equal(completedCount(todos), 2);
  assert.equal(hasMultipleInProgress(todos), false);

  const twoActive = normalizeTodos([
    { content: 'A', status: 'in_progress' },
    { content: 'B', status: 'in_progress' },
  ]);
  assert.equal(hasMultipleInProgress(twoActive), true);
});

test('中断归位：执行中的条目降级成待办，已完成与待办原样保留', () => {
  const todos = normalizeTodos([
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'in_progress' },
    { content: 'C', status: 'pending' },
    { content: 'D', status: 'in_progress' },
  ]);
  const settled = settleInterruptedTodos(todos);
  assert.equal(settled.changed, true);
  assert.deepEqual(settled.todos.map((todo) => todo.status), ['completed', 'pending', 'pending', 'pending']);
  // 顺序就是执行顺序，归位不能重排。
  assert.deepEqual(settled.todos.map((todo) => todo.content), ['A', 'B', 'C', 'D']);
});

test('中断归位：没有执行中的条目时不改动、不要求落库', () => {
  const todos = normalizeTodos([
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'pending' },
  ]);
  const settled = settleInterruptedTodos(todos);
  assert.equal(settled.changed, false);
  assert.deepEqual(settled.todos, todos);
});

test('中断归位：空清单与未定义输入返回空清单', () => {
  assert.deepEqual(settleInterruptedTodos(undefined), { todos: [], changed: false });
  assert.deepEqual(settleInterruptedTodos([]), { todos: [], changed: false });
});

test('可继续判定：中断或未完成、且还有没打勾的项才给按钮', () => {
  const todos = normalizeTodos([
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'pending' },
  ]);
  assert.equal(isResumableTodos(todos, true, false), true);
  assert.equal(isResumableTodos(todos, false, true), true);
  assert.equal(isResumableTodos(todos, true, true), true);
});

test('可继续判定：正在正常跑（无中断标记）时不给按钮', () => {
  const todos = normalizeTodos([
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'in_progress' },
  ]);
  // 运行中的清单要停走输入框旁的停止按钮；这里多给一组按钮只会让人不知道该点哪个。
  assert.equal(isResumableTodos(todos, false, false), false);
});

test('可继续判定：全部完成、空清单、未定义都不给按钮', () => {
  const done = normalizeTodos([
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'completed' },
  ]);
  // 全绿清单会被后端归档、面板本身消失，这里再返回 true 只会让按钮闪一下。
  assert.equal(isResumableTodos(done, true, false), false);
  assert.equal(isResumableTodos([], true, false), false);
  assert.equal(isResumableTodos(undefined, true, false), false);
});

test('取消任务：清空清单且不留任何标记，因此不会归档成胶囊', () => {
  const cleared = clearedTodoState();
  assert.equal(cleared.todos, null);
  assert.equal(cleared.todosInterrupted, null);
  assert.equal(cleared.todosIncomplete, null);
  // 只允许这三个键：多一个字段就意味着「取消」偷偷留了痕迹。
  assert.deepEqual(Object.keys(cleared).sort(), ['todos', 'todosIncomplete', 'todosInterrupted']);
});
