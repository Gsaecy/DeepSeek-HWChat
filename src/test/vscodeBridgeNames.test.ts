/**
 * 桥接的 VS Code 工具：裸名调用也要能通。
 *
 * 现场（用户 2026-11-04）：
 *
 *     open_browser_page {"url":"http://127.0.0.1:5199/pet.html"}
 *     → 工具 open_browser_page 未被允许。
 *
 * 清单里下发的是 `hwchat_vscode_open_browser_page_<hash>`，而模型在历史里看到的是
 * 自然名字（「调用 VS Code 工具：open_browser_page」），照着它调用就落到原生执行器，
 * 得到一句「未被允许」。名字对不上不该让用户承担。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { VscodeToolBridge } from '../agent/vscodeTools';
import type { ToolExecutor } from '../agent/toolExecutor';
import { getInvokeToolCalls, resetInvokeToolCalls, setLmTools } from './support/vscodeMock';
import type { ChatSettings, ToolCall } from '../core/types';

const settings = { internetReference: false, fileReadPolicy: 'allowAll' } as unknown as ChatSettings;

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** 只关心「有没有把请求真正交给 VS Code」，其余依赖（审批等）用替身。 */
function bridge(): { vscode: VscodeToolBridge; executor: { executeExternal: (...args: unknown[]) => Promise<unknown> } } {
  const seen: Array<{ name: string }> = [];
  const executor = {
    async executeExternal(_call: ToolCall, _mode: unknown, _settings: unknown, _risk: unknown, _request: unknown, summary: string, _detail: string, invoke: () => Promise<unknown>) {
      seen.push({ name: summary });
      return invoke();
    },
  };
  return { vscode: new VscodeToolBridge(executor as unknown as ToolExecutor), executor: executor as never };
}

const approvals = async () => true;

test('裸名 open_browser_page 会被路由到真正的 VS Code 工具', async () => {
  setLmTools([{ name: 'open_browser_page', description: '打开浏览器页面', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }]);
  resetInvokeToolCalls();
  const { vscode } = bridge();

  const dispatched = await vscode.execute(call('open_browser_page', { url: 'http://127.0.0.1:5199/pet.html' }), 'agent', settings, approvals, 'conv-1');
  assert.ok(dispatched, '应当由桥接层接管，而不是落到原生执行器回「未被允许」');
  assert.equal(dispatched!.result.status, 'success');
  assert.deepEqual(getInvokeToolCalls().map((entry) => entry.name), ['open_browser_page']);

  setLmTools([]);
  resetInvokeToolCalls();
});

test('带前缀的 id 仍然照常工作（回归）', async () => {
  setLmTools([{ name: 'open_browser_page', description: '打开浏览器页面', inputSchema: { type: 'object', properties: {} } }]);
  resetInvokeToolCalls();
  const { vscode } = bridge();

  const definitions = vscode.definitions();
  const id = definitions.find((item) => item.function.name.includes('open_browser_page'))!.function.name;
  const dispatched = await vscode.execute(call(id, { url: 'http://127.0.0.1:1/' }), 'agent', settings, approvals, 'conv-1');
  assert.equal(dispatched!.result.status, 'success');
  assert.equal(getInvokeToolCalls().length, 1);

  setLmTools([]);
  resetInvokeToolCalls();
});

test('不存在的裸名不会被误当成工具（仍交给下游拒绝）', async () => {
  setLmTools([{ name: 'open_browser_page', description: '', inputSchema: { type: 'object', properties: {} } }]);
  const { vscode } = bridge();
  const dispatched = await vscode.execute(call('no_such_vscode_tool'), 'agent', settings, approvals, 'conv-1');
  assert.equal(dispatched, undefined, '未命中就返回 undefined，由原生执行器给出准确拒绝');
  setLmTools([]);
});

test('宿主自己的命名空间不参与裸名匹配（避免遮蔽内建工具）', async () => {
  setLmTools([{ name: 'hwchat_internal_thing', description: '', inputSchema: { type: 'object', properties: {} } }]);
  const { vscode } = bridge();
  const dispatched = await vscode.execute(call('hwchat_internal_thing'), 'agent', settings, approvals, 'conv-1');
  assert.equal(dispatched, undefined);
  setLmTools([]);
});
