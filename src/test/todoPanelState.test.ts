import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { TODO_LIST_PROMPT } from '../agent/todoPrompt';

/** media/todo-panel-state.js 暴露的接口。 */
interface TodoPanelState {
  todoSignature: (todos: unknown) => string;
  shouldRevealTodoPanel: (input: { signature?: string; previousSignature?: string; archiveFocused?: boolean }) => boolean;
  capsuleRadius: (height: number) => number;
  planPanelToggle: (input: { panel?: string; open?: boolean; archiveFocused?: boolean }) => {
    allowed: boolean;
    open: boolean;
    collapsePeers: boolean;
    exitArchiveFocus: boolean;
  };
  nextArchiveFocus: (input: { currentId?: string | null; clickedId?: string | null }) => string | null;
}

/**
 * 在 Node 里跑 webview 的纯函数脚本。
 *
 * media/ 下的文件是给 webview 用的普通脚本（不是模块），只能放进 vm 上下文执行，
 * 再把挂在全局上的名字取回来。这样「新清单要自动展开」这条规则就有了真正的测试。
 */
function loadPanelState(): TodoPanelState {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/todo-panel-state.js', 'utf8'), sandbox);
  const api = sandbox.HWChatTodoPanelState as TodoPanelState | undefined;
  assert.ok(api, 'media/todo-panel-state.js 必须挂载 HWChatTodoPanelState');
  return api;
}

test('清单签名只看条目内容，不看状态', () => {
  const api = loadPanelState();
  const pending = api.todoSignature([{ content: '读代码', status: 'pending' }, { content: '改实现', status: 'pending' }]);
  const done = api.todoSignature([{ content: '读代码', status: 'completed' }, { content: '改实现', status: 'completed' }]);
  // 同一份清单只是进度变了：签名必须相同，否则每完成一步面板都会被顶开。
  assert.equal(pending, done);
  assert.notEqual(pending, api.todoSignature([{ content: '读代码', status: 'pending' }]));
});

test('清单签名的边界：空清单 / 非法输入都返回空串', () => {
  const api = loadPanelState();
  assert.equal(api.todoSignature([]), '');
  assert.equal(api.todoSignature(undefined), '');
  assert.equal(api.todoSignature(null), '');
  assert.equal(api.todoSignature('nope'), '');
  // 内容缺失按空串处理，不抛异常（清单来自模型，必须当不可信输入）。
  assert.equal(api.todoSignature([{ status: 'pending' }]), '');
});

test('新清单出现时自动展开面板（这就是「唤起」）', () => {
  const api = loadPanelState();
  assert.equal(api.shouldRevealTodoPanel({ signature: 'a\u0000b', previousSignature: '' }), true);
  assert.equal(api.shouldRevealTodoPanel({ signature: 'c', previousSignature: 'a\u0000b' }), true);
});

test('同一份清单更新状态时不重复展开，空清单不动面板', () => {
  const api = loadPanelState();
  assert.equal(api.shouldRevealTodoPanel({ signature: 'a\u0000b', previousSignature: 'a\u0000b' }), false);
  assert.equal(api.shouldRevealTodoPanel({ signature: '', previousSignature: 'a' }), false);
  assert.equal(api.shouldRevealTodoPanel({}), false);
});

test('归档后再来一份内容相同的新清单，仍然算新清单', () => {
  const api = loadPanelState();
  // 归档时清单被清空（签名变空串），所以下次同样的内容会被识别成新清单。
  let previous = api.todoSignature([{ content: '跑测试', status: 'completed' }]);
  previous = api.todoSignature([]);
  const next = api.todoSignature([{ content: '跑测试', status: 'pending' }]);
  assert.equal(api.shouldRevealTodoPanel({ signature: next, previousSignature: previous }), true);
});

test('胶囊圆角是圆角矩形而不是整圆胶囊', () => {
  const api = loadPanelState();
  // 整圆胶囊的半径会是 height / 2（16px 高 => 8px）；这里必须明显更小。
  assert.equal(api.capsuleRadius(16), 5);
  assert.ok(api.capsuleRadius(16) < 16 / 2);
  // 缩到最小尺寸时圆角跟着变小，且不小于 2px（否则看起来是直角）。
  assert.equal(api.capsuleRadius(6), 2);
  assert.equal(api.capsuleRadius(1), 2);
  // 脏输入不产出 NaN。
  assert.equal(api.capsuleRadius(Number.NaN), 2);
  assert.equal(api.capsuleRadius(-5), 2);
});

test('同一时刻只允许一颗胶囊展开：点同一颗收起，点另一颗换过去', () => {
  const api = loadPanelState();
  assert.equal(api.nextArchiveFocus({ currentId: null, clickedId: 'b' }), 'b');
  // 展开中的那颗再点一次 = 完全收起
  assert.equal(api.nextArchiveFocus({ currentId: 'b', clickedId: 'b' }), null);
  // 点另一颗：直接换到它，不会出现两颗同时展开
  assert.equal(api.nextArchiveFocus({ currentId: 'b', clickedId: 'c' }), 'c');
  // 脏输入不产生「展开一个不存在的 id」
  assert.equal(api.nextArchiveFocus({ currentId: 'b', clickedId: '' }), null);
  assert.equal(api.nextArchiveFocus({}), null);
});

test('胶囊展开时锁住任务树和任务清单，收起后才解锁', () => {
  const api = loadPanelState();
  // 聚焦期间：任务树、任务清单点了都不展开（allowed=false），也不会被连带收起别的东西。
  for (const panel of ['taskTree', 'todoPanel']) {
    const blocked = api.planPanelToggle({ panel, open: true, archiveFocused: true });
    assert.equal(blocked.allowed, false, `${panel} 在胶囊聚焦期间必须被锁住`);
    assert.equal(blocked.open, false);
    assert.equal(blocked.collapsePeers, false);
    assert.equal(blocked.exitArchiveFocus, false);
  }
  // 收起永远允许，否则会卡在「打不开也关不掉」。
  for (const panel of ['taskTree', 'todoPanel']) {
    const closing = api.planPanelToggle({ panel, open: false, archiveFocused: true });
    assert.equal(closing.allowed, true);
    assert.equal(closing.open, false);
  }
  // 没聚焦时一切照常。
  const free = api.planPanelToggle({ panel: 'todoPanel', open: true, archiveFocused: false });
  assert.equal(free.allowed, true);
  assert.equal(free.open, true);
  assert.equal(free.collapsePeers, false);
});

test('归档面板打开时连带收起另两个；收起时退出聚焦', () => {
  const api = loadPanelState();
  const opening = api.planPanelToggle({ panel: 'todoArchivePanel', open: true, archiveFocused: false });
  assert.equal(opening.allowed, true);
  assert.equal(opening.collapsePeers, true, '打开归档清单必须收起任务树和任务清单');
  assert.equal(opening.exitArchiveFocus, false);

  const closing = api.planPanelToggle({ panel: 'todoArchivePanel', open: false, archiveFocused: true });
  assert.equal(closing.allowed, true);
  assert.equal(closing.open, false);
  assert.equal(closing.exitArchiveFocus, true, '收起归档清单必须解锁另外两个面板');
});

test('未知面板名不拦，按原样放行（避免前端新增面板时被规则卡死）', () => {
  const api = loadPanelState();
  const plan = api.planPanelToggle({ panel: 'somethingElse', open: true, archiveFocused: true });
  assert.equal(plan.allowed, true);
  assert.equal(plan.open, true);
});

test('胶囊聚焦期间，新到的任务清单不会被自动顶开', () => {
  const api = loadPanelState();
  // 正常情况下换一份新清单要展开……
  assert.equal(api.shouldRevealTodoPanel({ signature: 'x', previousSignature: 'y' }), true);
  // ……但归档清单正展开时不能展开，否则就同时开了两个面板。
  assert.equal(api.shouldRevealTodoPanel({ signature: 'x', previousSignature: 'y', archiveFocused: true }), false);
  assert.equal(api.shouldRevealTodoPanel({ signature: 'x', previousSignature: '', archiveFocused: true }), false);
});

test('chat.js 真的接上了唤起逻辑，且胶囊里没有图标和悬停提示', () => {
  const source = readFileSync('media/chat.js', 'utf8');
  // 新清单到达时必须把面板展开，这是「任务清单没唤起」的直接修复点。
  assert.match(source, /if \(reveal\) elements\.todoPanel\.open = true;/);
  assert.match(source, /shouldRevealTodoPanel\(/);
  // 圆角由脚本按高度算，不能写死 999px。
  assert.match(source, /--capsule-radius/);
  // 胶囊内不放假元素、不挂 title（鼠标悬停不显示任何内容）。
  assert.doesNotMatch(source, /todo-capsule-mark/);
  assert.doesNotMatch(source, /capsule\.title\s*=/);
  // 无障碍名称仍要保留（读屏可用，但不是悬停提示）。
  assert.match(source, /capsule\.setAttribute\('aria-label'/);
});

test('chat.css 的胶囊是指定圆角的纯色块，并用边框指示展开与悬停', () => {
  const css = readFileSync('media/chat.css', 'utf8');
  assert.match(css, /\.todo-capsule\s*\{[^}]*border-radius: var\(--capsule-radius/);
  // 旧的整体圆胶囊与图标样式必须清掉，避免死代码把圆角覆盖回去。
  assert.doesNotMatch(css, /\.todo-capsule-mark/);
  const block = css.match(/\.todo-capsule\s*\{[^}]*\}/);
  assert.ok(block, '必须存在 .todo-capsule 规则');
  assert.doesNotMatch(block![0], /border-radius: 999px/);

  // 展开中：红色边框；悬停：浅红色边框。两者都用内阴影画边框，
  // 这样不会因为出现边框而改变胶囊尺寸，也不会被归档条的 overflow 裁掉。
  const active = css.match(/\.todo-capsule\.active\s*\{([^}]*)\}/);
  assert.ok(active, '必须有 .todo-capsule.active 规则');
  const activeBody = active[1] ?? '';
  assert.match(activeBody, /inset 0 0 0 2px var\(--capsule-border-active\)/);

  const hover = css.match(/\.todo-capsule:hover\s*\{([^}]*)\}/);
  assert.ok(hover, '必须有 .todo-capsule:hover 规则');
  const hoverBody = hover[1] ?? '';
  assert.match(hoverBody, /inset 0 0 0 1\.5px var\(--capsule-border-hover\)/);
  // 悬停不再改变纯色（以前用 brightness），只换边框颜色。
  assert.doesNotMatch(hoverBody, /filter:/);

  // 两个颜色变量必须真的定义：展开=实红（--danger），悬停=红与白的混合色（更浅）。
  assert.match(css, /--capsule-border-active:\s*var\(--danger\)/);
  assert.match(css, /--capsule-border-hover:\s*color-mix\(in srgb, var\(--danger\) 55%, #fff\)/);

  // 顺序约束：.active 必须在 :hover 之后，否则悬停会把展开态的实红盖成浅红。
  assert.ok(css.indexOf('.todo-capsule.active') > css.indexOf('.todo-capsule:hover'));
});

test('提示词要求多步任务必须维护清单，且不许用清空表示完成', () => {
  assert.match(TODO_LIST_PROMPT, /update_todos/);
  assert.match(TODO_LIST_PROMPT, /in_progress/);
  assert.match(TODO_LIST_PROMPT, /never signal completion by clearing/i);
  // 与工具描述口径一致：完成时保留整份清单，由界面负责归档。
  assert.match(TODO_LIST_PROMPT, /archives it/i);
});

test('chat.js 三个面板走同一个互斥入口，并记住/还原进入胶囊前的展开状态', () => {
  const source = readFileSync('media/chat.js', 'utf8');
  // 鼠标点击和键盘回车/空格触发的都是 click，所以一处监听就覆盖了全部展开入口。
  assert.match(source, /for \(const key of \['taskTree', 'todoPanel', 'todoArchivePanel'\]\)/);
  assert.match(source, /todoPanelState\.planPanelToggle\(/);
  assert.match(source, /todoPanelState\.nextArchiveFocus\(/);
  // 点开胶囊里的归档清单要收起另外两个，并记住它们原来开着没开。
  assert.match(source, /function collapsePeers\(\)/);
  assert.match(source, /state\.archiveRestore = \{ taskTree: Boolean\(elements\.taskTree\.open\), todoPanel: Boolean\(elements\.todoPanel\.open\) \}/);
  // 收起归档后要还原，别把用户原来的视图吞掉。
  assert.match(source, /function exitArchiveFocus\(\)/);
  assert.match(source, /if \(restore\.taskTree && !elements\.taskTree\.hidden\) elements\.taskTree\.open = true;/);
  assert.match(source, /if \(restore\.todoPanel && !elements\.todoPanel\.hidden\) elements\.todoPanel\.open = true;/);
  // 归档面板的展开状态与 expandedArchiveId 是同一个状态，不会出现「胶囊红着但面板是收的」。
  assert.match(source, /elements\.todoArchivePanel\.open = true;/);
  // 清单在聚焦期间必须保持收起。
  assert.match(source, /if \(isArchiveFocused\(\)\) elements\.todoPanel\.open = false;/);
});

test('chat.css 的 .panel-stack 给面板区封顶，输入框不会被挤出窗口', () => {
  const css = readFileSync('media/chat.css', 'utf8');
  const block = css.match(/\.panel-stack\s*\{([^}]*)\}/);
  assert.ok(block, '必须有 .panel-stack 规则');
  const body = block![1] ?? '';
  // 上限同时受视口（vh）和固定值约束，侧边栏很矮时也不会占满整屏。
  assert.match(body, /max-height:\s*min\(38vh,\s*300px\)/);
  assert.match(body, /overflow-y:\s*auto/);
  // 锁住的面板要有可见反馈。
  assert.match(css, /\.panel-locked > summary\s*\{[^}]*cursor: not-allowed/);
});

test('面板区容器把三个面板包在一起（否则高度上限不生效）', () => {
  const html = readFileSync('src/views/chatPanel.ts', 'utf8');
  assert.match(html, /id="panelStack" class="panel-stack"/);
  const open = html.indexOf('id="panelStack"');
  const bar = html.indexOf('id="todoArchiveBar"');
  // 三个面板都在容器里、胶囊栏在容器外（胶囊永远可见，不跟着面板区滚走）。
  assert.ok(open > 0 && bar > open);
  for (const id of ['id="taskTree"', 'id="todoPanel"', 'id="todoArchivePanel"']) {
    const at = html.indexOf(id);
    assert.ok(at > open && at < bar, `${id} 必须在 panelStack 之内、todoArchiveBar 之前`);
  }
});
