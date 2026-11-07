import assert from 'node:assert/strict';
import test from 'node:test';
import { constraintsOf, mergeTaskNodes, newlyCompletedTodos, renderTaskMemory, taskMark, todoBaseline } from '../core/taskMemory';
import { pruneToolPayloads } from '../agent/agentRunner';
import type { AgentTaskNode, ChatRequestMessage } from '../core/types';

/**
 * 「任务树 = agent 的记忆」的守护。
 *
 * 用户的要求（2026-11-06）：
 *     对话记录已经不再是 agent 的记忆了，agent 只需要读取任务树和任务清单
 *     （包括执行一半退出和执行完的），就能知道对话中的项目情况，完整的对话记录，
 *     只在读取任务树和任务清单无法确定的情况下查找读取。
 */

function node(partial: Partial<AgentTaskNode> & Pick<AgentTaskNode, 'id' | 'title' | 'status'>): AgentTaskNode {
  return { relation: 'pending', ...partial } as AgentTaskNode;
}

test('合并：上一轮做完的任务不会被这一轮的新树冲掉', () => {
  const firstRun = [
    node({ id: 't1', title: '改录制胶囊', status: 'complete', summary: '已挪到顶部栏' }),
    node({ id: 't2', title: '加 Esc 停止', status: 'active' }),
  ];
  const secondRun = [
    node({ id: 't3', title: '拖动区域也显示胶囊', status: 'active' }),
    // 同一 id 再下发一次：状态以新的为准，但结论与消息绑定不能丢。
    node({ id: 't2', title: '加 Esc 停止录制', status: 'complete' }),
  ];
  const merged = mergeTaskNodes(firstRun, secondRun);
  assert.deepEqual(merged.map((item) => item.id), ['t1', 't2', 't3']);
  assert.equal(merged[0]!.summary, '已挪到顶部栏', '上一轮的结论必须保留');
  assert.equal(merged[1]!.status, 'complete');
  assert.equal(merged[1]!.title, '加 Esc 停止录制', '标题用最新的（用户可能改过）');
});

test('合并：上限优先丢「没有信息量」的节点', () => {
  const nodes: AgentTaskNode[] = [];
  for (let index = 0; index < 45; index += 1) {
    nodes.push(node({ id: `done-${index}`, title: `已完成 ${index}`, status: 'complete', summary: `结果 ${index}` }));
  }
  nodes.push(node({ id: 'cancelled', title: '取消掉的任务', status: 'cancelled' }));
  const merged = mergeTaskNodes(nodes, []);
  assert.ok(merged.length <= 40, `上限没生效：${merged.length}`);
  assert.ok(!merged.some((item) => item.id === 'cancelled'), '先丢已取消的');
  assert.equal(merged.at(-1)?.id, 'done-44', '最近的记录必须还在');
});

test('记忆块：进行中 / 已完成带结论 / 已完成的清单 / 归档清单', () => {
  const memory = renderTaskMemory({
    nodes: [
      node({ id: 't1', title: '改录制胶囊', status: 'complete', summary: '挪到顶部栏，拖动区域也覆盖' }),
      node({ id: 't2', title: '加 Esc 停止录制', status: 'active' }),
      node({ id: 't3', title: '补测试', status: 'queued' }),
    ],
    todos: [
      { content: '改胶囊', status: 'completed' },
      { content: '加 Esc', status: 'in_progress' },
    ],
    todoArchives: [{ id: 'a1', createdAt: Date.UTC(2026, 10, 5), todos: [
      { content: '读代码', status: 'completed' },
      { content: '改代码', status: 'completed' },
    ] }],
    currentTitle: '加 Esc 停止录制',
  });
  assert.match(memory, /<project_memory>/);
  assert.match(memory, /Current task: 加 Esc 停止录制/);
  assert.match(memory, /<open_tasks>[\s\S]*\[>\] 加 Esc 停止录制/);
  assert.match(memory, /<finished_tasks>[\s\S]*\[x\] 改录制胶囊 — 挪到顶部栏，拖动区域也覆盖/);
  assert.match(memory, /<completed_task_list>[\s\S]*\[x\] 改胶囊/);
  assert.ok(!memory.includes('[>] 加 Esc\n'), '未完成条目交给清单注入，不在这里重复');
  assert.match(memory, /<archived_task_lists>[\s\S]*2\/2 完成/);
  assert.match(memory, /search_conversation_history/, '要告诉模型「记不清就查原文」');
  assert.match(memory, /Do not redo anything marked \[x\]/);
});

test('记忆块：什么都没有时不注入', () => {
  assert.equal(renderTaskMemory({}), '');
  assert.equal(renderTaskMemory({ nodes: [], todos: [], todoArchives: [] }), '');
});

test('标记：状态到标记的映射固定', () => {
  assert.equal(taskMark('complete'), '[x]');
  assert.equal(taskMark('active'), '[>]');
  assert.equal(taskMark('queued'), '[ ]');
  assert.equal(taskMark('error'), '[!]');
});

/* ── 运行内工具输出折叠 ───────────────────────────────────────────── */

function toolMessage(index: number, size = 1000): ChatRequestMessage {
  return {
    role: 'tool',
    tool_call_id: `call_${index}`,
    content: JSON.stringify({ status: 'success', summary: `第 ${index} 次调用`, result: 'x'.repeat(size) }),
  } as ChatRequestMessage;
}

test('运行内：最近 3 条工具输出留全文，更早的压成一行', () => {
  const messages: ChatRequestMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '做点事' },
  ];
  for (let index = 0; index < 10; index += 1) messages.push(toolMessage(index));
  const folded = pruneToolPayloads(messages);
  assert.equal(folded, 7);
  const tools = messages.filter((message) => message.role === 'tool') as Array<{ content: string; tool_call_id?: string }>;
  assert.equal(tools.length, 10, '只折叠内容，不删除消息（tool_call_id 必须配对）');
  for (const [index, tool] of tools.entries()) {
    const payload = JSON.parse(tool.content) as { result: string; summary?: string; folded?: boolean };
    if (index < 7) {
      assert.ok(payload.folded, `第 ${index} 条应当被折叠`);
      assert.match(payload.result, /已折叠/);
      assert.equal(payload.summary, `第 ${index} 次调用`, '摘要要留着，任务树才对得上');
    } else {
      assert.ok(!payload.folded, `第 ${index} 条应当保留全文`);
      assert.equal(payload.result.length, 1000);
    }
    assert.equal(tool.tool_call_id, `call_${index}`);
  }
  // 幂等：再折一次不应重复计数。
  assert.equal(pruneToolPayloads(messages), 0);
});

test('运行内：工具数量没超过阈值时不动', () => {
  const messages: ChatRequestMessage[] = [toolMessage(0), toolMessage(1)];
  assert.equal(pruneToolPayloads(messages), 0);
  assert.equal((JSON.parse((messages[0] as { content: string }).content) as { result: string }).result.length, 1000);
});

/* ── 约束：光有结论不够 ───────────────────────────────────────────── */

test('约束：从用户原话里摘出「不要 / 必须 / 保持」这类硬规则', () => {
  const constraints = constraintsOf([
    '录制状态和停止按钮胶囊，能显示在顶部栏吗？不要动胶囊的样式，必须保留 Esc 快捷键。',
    '顺手把标题栏也改一下',
  ]);
  assert.equal(constraints.length, 2);
  assert.match(constraints[0]!, /不要动胶囊的样式/);
  assert.match(constraints[1]!, /必须保留 Esc 快捷键/);
});

test('约束：普通描述不会被当成约束（否则模型不敢动手）', () => {
  assert.deepEqual(constraintsOf(['把胶囊挪到顶部栏', '看下这个文件', '跑一下测试']), []);
  assert.deepEqual(constraintsOf([]), []);
});

test('约束：英文说法同样识别', () => {
  const constraints = constraintsOf(['Move the capsule up. Do not change the capsule style. Must keep the Esc shortcut.']);
  assert.equal(constraints.length, 2);
  assert.match(constraints.join(' '), /Do not change the capsule style/i);
});

test('记忆块：约束跟着任务一起出现，并明确要求遵守', () => {
  const memory = renderTaskMemory({
    nodes: [
      node({
        id: 't1',
        title: '改录制胶囊',
        status: 'complete',
        summary: '挪到顶部栏',
        constraints: ['不要动胶囊的样式', '必须保留 Esc 快捷键'],
      }),
    ],
  });
  assert.match(memory, /\[x\] 改录制胶囊 — 挪到顶部栏 ｜ 约束：不要动胶囊的样式；必须保留 Esc 快捷键/);
  assert.match(memory, /always honour the 约束/);
});

test('合并：新一轮没带约束时，旧约束不能被抹掉', () => {
  const merged = mergeTaskNodes(
    [node({ id: 't1', title: '改录制胶囊', status: 'complete', constraints: ['不要动胶囊的样式'] })],
    [node({ id: 't1', title: '改录制胶囊', status: 'complete', summary: '改完了' })],
  );
  assert.deepEqual(merged[0]?.constraints, ['不要动胶囊的样式']);
});

test('记忆块：未结束任务过多时也要有上限', () => {
  const nodes: AgentTaskNode[] = [];
  for (let index = 0; index < 30; index += 1) {
    nodes.push(node({ id: `q-${index}`, title: `排队任务 ${index}`, status: 'queued' }));
  }
  const memory = renderTaskMemory({ nodes });
  assert.match(memory, /排队任务 29/, '最近的任务要在');
  assert.ok(!/排队任务 0\b/.test(memory), '最早的那批要折叠');
  assert.match(memory, /older open task\(s\) not listed/);
});

/* ── 清单归属：按节点时间窗取差集 ─────────────────────────────────── */

test('清单归属：节点期间新完成的条目才算它的变动', () => {
  const baseline = todoBaseline([
    { content: '读代码', status: 'completed' },
    { content: '改代码', status: 'pending' },
  ]);
  assert.deepEqual(baseline, ['读代码']);
  const done = newlyCompletedTodos(baseline, [
    { content: '读代码', status: 'completed' },
    { content: '改代码', status: 'completed' },
    { content: '补测试', status: 'completed' },
    { content: '同步文档', status: 'pending' },
  ]);
  assert.deepEqual(done.map((todo) => todo.content), ['改代码', '补测试']);
});

test('清单归属：同一条目不会同时算给两个节点', () => {
  const todos = [
    { content: '读代码', status: 'completed' as const },
    { content: '改代码', status: 'completed' as const },
  ];
  const first = newlyCompletedTodos([], todos);
  // 第二个节点开始时，前面做完的已经进了基线。
  const second = newlyCompletedTodos(todoBaseline(todos), todos);
  assert.deepEqual(first.map((todo) => todo.content), ['读代码', '改代码']);
  assert.deepEqual(second, [], '已经归属过的条目不能再算一次');
});

test('清单归属：只有一行结论、没有清单时不硬造条目', () => {
  assert.deepEqual(newlyCompletedTodos([], []), []);
});

test('清单归属：排队节点开始时才拍基线（入队时的旧基线不算数）', () => {
  const atEnqueue = [
    { content: '读代码', status: 'completed' as const },
  ];
  const atStart = [
    { content: '读代码', status: 'completed' as const },
    { content: '改代码', status: 'completed' as const },
  ];
  // 若沿用入队基线，「改代码」会被误算给这条排队任务（其实是前面那条任务做的）。
  const wrong = newlyCompletedTodos(todoBaseline(atEnqueue), atStart);
  assert.deepEqual(wrong.map((todo) => todo.content), ['改代码']);
  const right = newlyCompletedTodos(todoBaseline(atStart), atStart);
  assert.deepEqual(right, [], '按真正开始时的基线算，这条排队任务此刻还没做任何事');
});

test('合并：节点再多也不会无限增长（硬上限）', () => {
  const nodes: AgentTaskNode[] = [];
  for (let index = 0; index < 60; index += 1) {
    nodes.push(node({ id: `q-${index}`, title: `排队 ${index}`, status: 'queued' }));
  }
  const merged = mergeTaskNodes(nodes, []);
  assert.ok(merged.length <= 40, `硬上限没生效：${merged.length}`);
  assert.equal(merged.at(-1)?.id, 'q-59', '最近的留着');
});
