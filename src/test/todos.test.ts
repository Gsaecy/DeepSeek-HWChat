import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTodos, completedCount, hasMultipleInProgress } from '../core/todos';

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
