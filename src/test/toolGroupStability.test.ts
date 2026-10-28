import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * 「鼠标停在工具步骤模块上，颜色一闪一闪」+「点击展开/收起很不灵敏」。
 *
 * 同一个根因：`toolGroupSignature()` 把工具块的**临时位置**算进了结构签名。
 * 工具位于「正文还没写到」的位置时，`offset = min(contentOffset, 正文长度)` 会随着
 * 正文每长一个字而变，于是每一帧都判定「结构变了」→ 整条消息重排 →
 * `<details>` 与 `summary` 被销毁重建 → 悬停高亮闪、点击落在正要被替换的节点上。
 *
 * 实测（headless Chromium，20 帧流式）：
 *   修复前 tool-execution 节点被换掉 20 次、hover 丢失 124/127 帧、12 次点击丢 1 次；
 *   修复后 0 次、hover 只在内容把元素推走时变化、12 次点击全生效。
 */

const CHAT_JS = readFileSync('media/chat.js', 'utf8');

interface Group { offset: number; pending: boolean; tools: { callId: string }[] }

/** 把 chat.js 里真实的 groupToolsByOffset 取出来跑（不复制一份逻辑）。 */
function loadGrouping(): (tools: unknown[], textLength: number) => Group[] | null {
  const start = CHAT_JS.indexOf('function groupToolsByOffset(');
  assert.ok(start >= 0, 'chat.js 里找不到 groupToolsByOffset');
  let depth = 0;
  let index = CHAT_JS.indexOf('{', start);
  const from = index;
  for (; index < CHAT_JS.length; index += 1) {
    if (CHAT_JS[index] === '{') depth += 1;
    else if (CHAT_JS[index] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(`${CHAT_JS.slice(start, index + 1)}\nglobalThis.__group = groupToolsByOffset;`, sandbox);
  void from;
  return (sandbox as { __group: (tools: unknown[], textLength: number) => Group[] | null }).__group;
}

const tool = (callId: string, contentOffset: number): Record<string, unknown> => ({
  callId, name: 'replace_in_file', summary: 'x', status: 'success', output: 'ok', contentOffset,
});

test('groupToolsByOffset：正文还没写到工具位置时标为 pending', () => {
  const group = loadGrouping()!;
  const groups = group([tool('t1', 400), tool('t2', 400)], 100)!;
  assert.equal(groups.length, 1, '两个工具位置相同应合成一组');
  assert.equal(groups[0]!.pending, true, '400 > 100 → 还在正文之后');
  assert.equal(groups[0]!.offset, 100, '渲染时仍要贴在末尾（正文长度）');
});

test('groupToolsByOffset：正文写到之后不再是 pending', () => {
  const group = loadGrouping()!;
  const groups = group([tool('t1', 400)], 500)!;
  assert.equal(groups[0]!.pending, false);
  assert.equal(groups[0]!.offset, 400, '真实位置');
});

test('groupToolsByOffset：边界上（offset == 正文长度）算 pending', () => {
  const group = loadGrouping()!;
  assert.equal(group([tool('t1', 100)], 100)![0]!.pending, true);
});

test('签名用 pending 抹平临时位置，正文增长不再改变结构签名', () => {
  const start = CHAT_JS.indexOf('function toolGroupSignature(');
  assert.ok(start >= 0);
  const body = CHAT_JS.slice(start, CHAT_JS.indexOf('\n  }\n', start));
  assert.match(body, /group\.pending \? 'pending' : group\.offset/, '签名里必须把 pending 组抹平成一个稳定标记');
  // 抹平之后，正文从 100 长到 900（仍未追上 400 之后的工具）不该改变这一项
  const grouping = loadGrouping()!;
  const sig = (len: number): string => (grouping([tool('t1', 400)], len)!)
    .map((group) => (group.pending ? 'pending' : group.offset)).join(',');
  assert.equal(sig(100), sig(300), '正文在工具之前增长时签名不变');
  assert.equal(sig(100), 'pending');
  assert.equal(sig(500), '400', '正文追上之后才变成真实位置（一次真实重排）');
});

test('点击 summary：pointerup 兜底 + 延后恢复渲染', () => {
  const start = CHAT_JS.indexOf("document.addEventListener('pointerup'");
  assert.ok(start >= 0, '找不到 pointerup 监听');
  const slice = CHAT_JS.slice(start, start + 2200);
  // 关键：按下时记「稳定标识 + 节点 + 矩形」，松开时按标识在当前 DOM 里重新定位。
  assert.match(slice, /pressed\?\.node\?\.isConnected === true/, '要用「按下那个节点是否还在文档里」决定是否兜底');
  assert.match(slice, /details\.open = !details\.open/, '兜底要执行与规范等价的 activation（切 open 属性）');
  assert.match(slice, /setTimeout\(releaseMessageInteraction, 400\)/, '要延后释放渲染暂停');
});

test('兜底不依赖 click 事件：实测节点被换掉时浏览器根本不派发 click', () => {
  // 这条是实测结论，不是推测：pointerdown 有、click 没有。所以兜底必须挂在 pointerup。
  assert.equal(/elements\.messageList\.addEventListener\('click'/.test(CHAT_JS), false, '不要用 click 委托兜底（事件根本不来）');
  assert.match(CHAT_JS, /function summarizePressTarget\(target\)/, '要记录按下目标');
  assert.match(CHAT_JS, /function findDetailsByKey\(root, key\)/, '要能按 data-detail-key 在重建后的 DOM 里找回同一个折叠块');
  assert.match(CHAT_JS, /const key = details\.dataset\.detailKey;/, '定位靠稳定业务标识，不靠节点引用');
});
