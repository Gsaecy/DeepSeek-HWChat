import assert from 'node:assert/strict';
import test from 'node:test';
import { BRIDGED_TOOL_PREFIX, trimToolSurface, wantsBridgedTools } from '../agent/toolSurface';

/**
 * 工具清单裁剪（用户 2026-11-22：「Copilot Chat 用同一个 DeepSeek 模型也很流畅，
 * PlaitCode 却很难用」）。
 *
 * 差别之一是清单：PlaitCode 之前把 VS Code 里**所有**扩展的语言模型工具都下发给模型
 * （上限 400，等于不设限），几十个候选 + 上万字符 schema。候选越多，选错越多，
 * 挑中一个在 PlaitCode 上下文里调不通的桥接工具就是一轮白烧。
 */

const native = ['read_file', 'search_files', 'replace_in_file', 'run_command', 'update_todos'];
const bridged = [
  `${BRIDGED_TOOL_PREFIX}open_browser_page_ab12`,
  `${BRIDGED_TOOL_PREFIX}run_in_terminal_cd34`,
];

test('默认裁剪：没要求扩展能力时不下发桥接工具', () => {
  const trimmed = trimToolSurface([...native, ...bridged], { bridgedRequested: false });
  assert.deepEqual(trimmed, native);
});

test('明确要求扩展能力时保留桥接工具', () => {
  const trimmed = trimToolSurface([...native, ...bridged], { bridgedRequested: true });
  assert.equal(trimmed, undefined, '一个都没砍就不该返回限制清单');
});

test('全部都是原生工具时不做任何限制', () => {
  assert.equal(trimToolSurface(native, { bridgedRequested: false }), undefined);
});

test('超过上限时先砍桥接工具，原生工具一个不少', () => {
  const manyBridged = Array.from({ length: 40 }, (_, index) => `${BRIDGED_TOOL_PREFIX}tool_${index}`);
  const trimmed = trimToolSurface([...native, ...manyBridged], { bridgedRequested: true, max: 10 });
  assert.ok(trimmed);
  assert.equal(trimmed!.length, 10);
  for (const name of native) assert.ok(trimmed!.includes(name), `原生工具 ${name} 必须保留`);
});

test('意图判定：浏览器 / 预览 / 终端 / 扩展 才命中', () => {
  assert.equal(wantsBridgedTools('帮我在浏览器里打开这个页面'), true);
  assert.equal(wantsBridgedTools('用终端跑一下'), true);
  assert.equal(wantsBridgedTools('这个扩展提供的命令能调吗'), true);
  assert.equal(wantsBridgedTools('open the browser preview'), true);
  // 普通编码请求不该命中 —— 否则等于没裁剪。
  assert.equal(wantsBridgedTools('把设置页的中文翻译成英文'), false);
  assert.equal(wantsBridgedTools('修复登录 bug'), false);
  assert.equal(wantsBridgedTools('打开 src/app/App.tsx'), false, '原生 open_file 能做，不需要扩展');
  assert.equal(wantsBridgedTools(''), false);
});
