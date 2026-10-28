import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { droppedCompletedTodos, hasTodoReplanIntent } from '../agent/todoScope';
import { TodoItem } from '../core/types';
import { ChatPanel } from '../views/chatPanel';

/**
 * 「点继续执行，模型却重新开了一份清单」。
 *
 * 真实故障：清单跑到 6/8 被中断，用户点「继续执行」，模型没有接着第 7 条做，
 * 而是重新拆了一份 4 项的新清单 —— 前六条已验证的进度被整份换掉。
 * `TODO_LIST_PROMPT` 里本来就写着「keep that list… instead of starting a new one」，
 * 但提示词不是硬约束；这里钉住运行时的兜底：**已完成项必须原样沿用**。
 */

const EIGHT = [
  '验证托盘特性可离线编译',
  '实现单实例锁：二次启动激活已有窗口而不新开进程',
  '实现系统托盘：图标、左键唤起、右键菜单、关闭到托盘',
  '启动器分组：按字母段分组标题 + 拖拽排序并持久化',
  '布局尺寸：侧边栏宽度可拖拽调节并持久化',
  '补渲染冒烟与 Rust 单测',
  '跑完整门禁（typecheck/build/cargo check/cargo test/冒烟/诊断/泄漏扫描）',
  '同步 README、MVP、ARCHITECTURE 与周报',
];

const sixDone = (): TodoItem[] =>
  EIGHT.map((content, index) => ({ content, status: index < 6 ? 'completed' : 'pending' }));

test('droppedCompletedTodos：真实故障现场被识别为「丢掉 6 条已完成」', () => {
  // 这份新清单是从存档里读回来的原文，不是编的。
  const submitted: TodoItem[] = [
    { content: '核实本轮未提交改动的实际内容与接入点（shell.rs / shortcuts.ts / 宽度持久化）', status: 'completed' },
    { content: '重跑完整门禁：typecheck / build / cargo check / cargo test / 渲染冒烟 / 诊断 / 泄漏扫描', status: 'completed' },
    { content: '泄漏扫描：确认本机路径、用户名、真实站点域名未进入跟踪范围', status: 'completed' },
    { content: '同步 README / MVP / ARCHITECTURE / 周报，记录托盘、单实例、字母分组、布局尺寸', status: 'in_progress' },
  ];
  const dropped = droppedCompletedTodos(sixDone(), submitted);
  assert.equal(dropped.length, 6, '六条已完成项一条都没保住');
  assert.ok(dropped.some((item) => item.includes('系统托盘')));
});

test('droppedCompletedTodos：正常续跑、加项、改状态都放行', () => {
  const previous = sixDone();
  assert.deepEqual(droppedCompletedTodos(previous, previous.map((todo) => ({ ...todo }))), [], '原样重提不该被拦');
  assert.deepEqual(
    droppedCompletedTodos(previous, previous.map((todo, index) => ({ ...todo, status: index === 6 ? 'in_progress' as const : todo.status }))),
    [],
    '把下一条标成 in_progress 是正常续跑',
  );
  assert.deepEqual(
    droppedCompletedTodos(previous, [...previous, { content: '补一张截图', status: 'pending' as const }]),
    [],
    '在末尾追加新步骤不该被拦',
  );
  assert.deepEqual(
    droppedCompletedTodos(previous, previous.map((todo, index) => ({ ...todo, status: index === 5 ? 'pending' as const : todo.status }))),
    [],
    '把已完成项改回 pending 重做，文字还在，不算丢进度',
  );
});

test('droppedCompletedTodos：没有进度可丢时不拦', () => {
  assert.deepEqual(droppedCompletedTodos(undefined, [{ content: 'a', status: 'pending' }]), [], '没有旧清单');
  assert.deepEqual(droppedCompletedTodos([], [{ content: 'a', status: 'pending' }]), [], '旧清单为空');
  assert.deepEqual(
    droppedCompletedTodos([{ content: 'a', status: 'pending' }], [{ content: 'b', status: 'pending' }]),
    [],
    '旧清单一条都没完成，换掉不算丢进度',
  );
  const allDone = EIGHT.map((content) => ({ content, status: 'completed' as const }));
  assert.deepEqual(
    droppedCompletedTodos(allDone, [{ content: '完全不同的新任务', status: 'pending' }]),
    [],
    '旧清单全部完成说明该归档了，新清单就是新任务',
  );
});

test('droppedCompletedTodos：只改标点 / 空白的措辞仍认作同一条', () => {
  assert.deepEqual(
    droppedCompletedTodos(
      [{ content: '同步 README、MVP 与周报', status: 'completed' }],
      [{ content: '同步  README / MVP 与周报', status: 'pending' }],
    ),
    [],
    '模型重述同一条时常改分隔符，不该因此判成两件事',
  );
});

test('hasTodoReplanIntent：续跑指令不触发逃生门', () => {
  const resume = readFileSync('src/core/i18n.ts', 'utf8');
  const zh = /zh: '(继续执行当前任务清单[^']*)'/.exec(resume);
  const en = /en: '(Continue the unfinished[^']*)'/.exec(resume);
  assert.ok(zh && en, 'i18n 里必须仍有续跑指令的中英文案');
  assert.equal(hasTodoReplanIntent(zh[1]!), false, '续跑指令本身绝不能被当成「重新规划」');
  assert.equal(hasTodoReplanIntent(en[1]!), false);
});

test('hasTodoReplanIntent：用户明确要求重做时才放行', () => {
  for (const text of [
    '重新规划一下清单',
    '把之前的清单丢掉，重新来',
    '换一份清单重新排',
    'discard the old list and start over',
    'replan the task list',
  ]) {
    assert.equal(hasTodoReplanIntent(text), true, `应识别为重规划：${text}`);
  }
  for (const text of ['帮我修一下登录 bug', '继续执行', '把清单里第 7 条做完']) {
    assert.equal(hasTodoReplanIntent(text), false, `不该误判为重规划：${text}`);
  }
});

/** 真的走一遍 `updateTodos()`：假 storage 记录有没有被写。 */
async function submitTodoList(
  previous: TodoItem[] | undefined,
  submitted: unknown[],
  allowReplan = false,
): Promise<{ status: string; content: string; writes: number; todos: TodoItem[] | undefined }> {
  let todos = previous ? previous.map((todo) => ({ ...todo })) : previous;
  let writes = 0;
  const storage = {
    getConversation: async () => ({ id: 'c1', todos }),
    updateConversation: async (_id: string, patch: { todos?: TodoItem[] | null }) => {
      writes += 1;
      if (patch.todos !== undefined) todos = patch.todos ?? [];
    },
  };
  const skills = { sharedActiveIds: () => [], onDidChangeSharedState: { event: () => ({ dispose() { /* noop */ } }) } };
  const panel = new ChatPanel(
    {} as never, {} as never, storage as never, {} as never, {} as never,
    skills as never, {} as never, {} as never,
  );
  // 面板推送走 post，这里没有 webview，直接吞掉。
  (panel as unknown as { post: () => Promise<void> }).post = async () => undefined;
  const call = panel as unknown as {
    updateTodos: (id: string, call: { function: { name: string; arguments: string } }, allow?: boolean) =>
      Promise<{ status: string; content: string }>;
  };
  const result = await call.updateTodos('c1', {
    function: { name: 'update_todos', arguments: JSON.stringify({ todos: submitted }) },
  }, allowReplan);
  return { status: result.status, content: result.content, writes, todos };
}

test('updateTodos：丢掉已完成项的清单被拒绝，且不写库', async () => {
  const outcome = await submitTodoList(sixDone(), [
    { content: '核实改动内容', status: 'completed' },
    { content: '重跑门禁', status: 'completed' },
    { content: '泄漏扫描', status: 'completed' },
    { content: '同步文档', status: 'in_progress' },
  ]);
  assert.equal(outcome.status, 'error', '这是被拒绝的调用，不能报 success');
  assert.equal(outcome.writes, 0, '拒绝就必须一个字都不写');
  assert.equal(outcome.todos?.length, 8, '旧清单原样保住');
  assert.match(outcome.content, /实现系统托盘/, '要指出具体丢了哪几条');
  assert.match(outcome.content, /再提交一次/, '要给出能成功的下一步，否则模型只能反复重试');
});

test('updateTodos：原样沿用现有清单的续跑正常落库', async () => {
  const outcome = await submitTodoList(sixDone(), sixDone().map((todo, index) => ({
    content: todo.content,
    status: index === 6 ? 'in_progress' : todo.status,
  })));
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.writes, 1);
  assert.equal(outcome.todos?.length, 8);
  assert.equal(outcome.todos?.[6]?.status, 'in_progress');
});

test('updateTodos：用户明确要求重规划时放行', async () => {
  const outcome = await submitTodoList(sixDone(), [
    { content: '完全按新方案重做', status: 'pending' },
  ], true);
  assert.equal(outcome.status, 'success', 'allowReplan 下不该拦');
  assert.equal(outcome.writes, 1);
});

test('updateTodos：第一份清单（没有旧清单）不受守卫影响', async () => {
  const outcome = await submitTodoList(undefined, [
    { content: '读代码', status: 'in_progress' },
    { content: '改实现', status: 'pending' },
  ]);
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.todos?.length, 2);
});
