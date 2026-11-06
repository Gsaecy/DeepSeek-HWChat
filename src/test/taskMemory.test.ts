import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTaskNodes, renderTaskMemory, taskMark } from '../core/taskMemory';
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

test('运行内：最近 6 条工具输出留全文，更早的压成一行', () => {
  const messages: ChatRequestMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '做点事' },
  ];
  for (let index = 0; index < 10; index += 1) messages.push(toolMessage(index));
  const folded = pruneToolPayloads(messages);
  assert.equal(folded, 4);
  const tools = messages.filter((message) => message.role === 'tool') as Array<{ content: string; tool_call_id?: string }>;
  assert.equal(tools.length, 10, '只折叠内容，不删除消息（tool_call_id 必须配对）');
  for (const [index, tool] of tools.entries()) {
    const payload = JSON.parse(tool.content) as { result: string; summary?: string; folded?: boolean };
    if (index < 4) {
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
