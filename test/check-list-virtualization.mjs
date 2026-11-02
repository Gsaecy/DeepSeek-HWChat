// 消息列表窗口化（虚拟化）的守门人。
//
// 为什么要做（用户原话：「参考 copilot 的 agent 模式，为什么 copilot 能这么流畅
// 并且占用不高不卡」）：Copilot 的聊天列表是 VS Code 的 `WorkbenchObjectTree`
// （`src/vs/platform/list/browser/listService.ts`）—— 虚拟化列表，视口外的行
// 根本没有 DOM。HWChat 以前是 webview 里手写的全量列表：状态里有多少条消息，
// DOM 里就有多少条。
//
// 实测（headless Chromium + 真实 media/chat.js，`ps` 汇总渲染进程 RSS）：
//   · 600 条 × 每条 6 个工具步骤 = 38,400 个节点 = **+231.6 MB**
//   · 每条消息平均 **0.39 MB**，且 50 → 600 条完全线性
//   · 把折叠的工具正文改成「展开才建」只降节点 53%、RSS 4%
//     ⇒ 内存大头是「每条消息真的被排版/绘制」，不是节点数量
// 所以只有「屏幕外的消息不渲染」能真正降内存。
//
// 运行：node test/check-list-virtualization.mjs
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_DIR = process.cwd();
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* ── 静态契约 ──────────────────────────────────────────────────────────── */
const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_CSS = readFileSync('media/chat.css', 'utf8');
check('有窗口化阈值与两处占位块',
  /const VIRTUAL_LIST_THRESHOLD = \d+;/.test(CHAT_JS)
  && /messageSpacer\('top'/.test(CHAT_JS) && /messageSpacer\('bottom'/.test(CHAT_JS),
  '窗口外的高度必须由占位块撑住，否则滚动条和滚动位置全错');
check('滚动时搬窗口', /elements\.messageViewport\.addEventListener\('scroll'[\s\S]{0,400}ensureVirtualWindow\(\)/.test(CHAT_JS),
  '滚动监听里必须调 ensureVirtualWindow（否则滚出去就是空白）');
check('换窗口前记录并恢复滚动锚点',
  /function captureScrollAnchor\(\)/.test(CHAT_JS) && /function restoreScrollAnchor\(anchor\)/.test(CHAT_JS)
  && /const anchor = captureScrollAnchor\(\);/.test(CHAT_JS),
  '不按锚点对齐的话，换窗口那一刻画面会跳');
check('换窗口前收走展开状态',
  /function buildMessageWindow[\s\S]{0,400}captureDetailOverrides\(\)/.test(CHAT_JS),
  '用户展开过的步骤滚出去再滚回来必须还是展开的');
check('patchMessage 不再按 children 下标取节点',
  /const current = findMessageNode\(messageId\);/.test(CHAT_JS)
  && !/elements\.messageList\.children\[index\]/.test(CHAT_JS),
  '窗口化后 children 下标不再等于消息下标');
check('占位块有独立样式', /\.message-spacer\s*\{/.test(CHAT_CSS), '没有样式就只有 0 高度');
check('行高与展开状态会被清理',
  /function pruneVirtualCaches\(\)/.test(CHAT_JS) && /pruneVirtualCaches\(\);/.test(CHAT_JS),
  '只增不减的 Map 会随编辑/重发慢漏内存');

/* ── 真实浏览器行为 ────────────────────────────────────────────────────── */
const PLAYWRIGHT_ROOTS = [
  join(CHAT_DIR, 'node_modules', 'playwright'),
  join(homedir(), 'AI projects', 'Safevault_windows', 'node_modules', 'playwright'),
];
const playwrightRoot = PLAYWRIGHT_ROOTS.find((candidate) => existsSync(join(candidate, 'package.json')));
const cacheRoot = join(homedir(), 'Library/Caches/ms-playwright');
const chromium = existsSync(cacheRoot)
  ? (readdirSync(cacheRoot).filter((name) => name.startsWith('chromium_headless_shell')).sort().pop() ?? null)
  : null;

if (!playwrightRoot || !chromium) {
  console.log(`SKIP 浏览器部分：${playwrightRoot ? '找不到 chromium' : '找不到 playwright'}`);
} else {
  const { chromium: launcher } = await import(join(playwrightRoot, 'index.mjs'));
  const executablePath = join(cacheRoot, chromium, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  if (!existsSync(executablePath)) {
    console.log('SKIP 浏览器部分：chromium 可执行文件不在预期路径');
  } else {
    const browser = await launcher.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
    await page.waitForSelector('#composer');

    const out = await page.evaluate(async () => {
      const settle = async (frames = 4) => {
        for (let i = 0; i < frames; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => setTimeout(resolve, 60));
      };
      const conv = (n) => ({
        id: 'c', title: 't', mode: 'agent', createdAt: Date.now() - 9e6, updatedAt: Date.now(),
        messageCount: n, preview: 'p', pinned: false, archived: false,
      });
      const makeMessages = (count, steps) => Array.from({ length: count }, (_, i) => ({
        id: `m${i}`, role: 'assistant', content: `第 ${i} 条。`,
        createdAt: Date.now(), updatedAt: Date.now(), status: 'complete',
        toolExecutions: Array.from({ length: steps }, (_, k) => ({
          callId: `c${i}-${k}`, name: 'read_file', summary: `src/file${k}.ts`, status: 'success',
          startedAt: Date.now(), input: JSON.stringify({ path: `src/file${k}.ts` }),
          output: 'line of output\n'.repeat(12),
        })),
      }));
      const post = (messages, extra = {}) => window.postMessage({ type: 'state', state: {
        conversations: [conv(messages.length)], archivedConversations: [], conversation: conv(messages.length),
        messages, hasMore: false,
        settings: {
          sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll',
          agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
        },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 1, showArchived: false, taskTree: null, todos: [], project: null,
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
        ...extra,
      } }, '*');
      const viewport = document.querySelector('#messageViewport');
      const list = document.querySelector('#messageList');
      const articles = () => [...list.children].filter((node) => node.dataset.messageId);
      const state = () => ({
        rendered: articles().length,
        nodes: list.querySelectorAll('*').length,
        spacers: list.querySelectorAll('.message-spacer').length,
        topSpacer: Number(list.querySelector('[data-spacer="top"]')?.style.height.replace('px', '') || 0),
        bottomSpacer: Number(list.querySelector('[data-spacer="bottom"]')?.style.height.replace('px', '') || 0),
        ids: articles().map((node) => node.dataset.messageId),
      });
      /** 视口顶部是否被某条消息盖住（没有空洞），底部同理。 */
      const covered = () => {
        const viewportRect = viewport.getBoundingClientRect();
        const nodes = articles();
        if (!nodes.length) return false;
        const first = nodes[0].getBoundingClientRect();
        const last = nodes[nodes.length - 1].getBoundingClientRect();
        return first.top <= viewportRect.top + 1 && last.bottom >= viewportRect.bottom - 1;
      };

      // ① 600 条：DOM 里只留一屏的量
      const many = makeMessages(600, 6);
      post(many);
      for (let i = 0; i < 400; i += 1) {
        if (document.querySelectorAll('#messageList .message').length > 0) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await settle();
      const wide = state();

      // ② 滚到中间：窗口要跟过去，且视口上下不能出现空洞
      viewport.scrollTop = Math.round((viewport.scrollHeight - viewport.clientHeight) * 0.5);
      await settle(6);
      const middle = state();
      const middleCovered = covered();
      const middleFirst = middle.ids[0];

      // ③ 就在中间这一屏：展开某条消息里的工具详情 → 滚走 → 滚回来，仍然展开
      const targetId = middleFirst;
      const target = list.querySelector(`[data-message-id="${targetId}"]`);
      let expand = { ok: false };
      if (target) {
        const details = target.querySelector('details.tool-execution');
        details.open = true;
        await settle(3);
        const openedBlocks = details.querySelectorAll('.tool-detail-block').length;
        viewport.scrollTop = 0;
        await settle(6);
        const leftWindow = !list.querySelector(`[data-message-id="${targetId}"]`);
        // 二分找它所在的滚动位置：用比例估算会偏，一圈圈滚又太慢。
        const wantIndex = Number(target.dataset.messageIndex);
        let low = 0;
        let high = viewport.scrollHeight;
        for (let iter = 0; iter < 30; iter += 1) {
          viewport.scrollTop = (low + high) / 2;
          await settle(3);
          const nodes = articles();
          if (!nodes.length) break;
          const startIndex = Number(nodes[0].dataset.messageIndex);
          const endIndex = Number(nodes[nodes.length - 1].dataset.messageIndex);
          if (wantIndex >= startIndex && wantIndex <= endIndex) break;
          if (wantIndex < startIndex) high = viewport.scrollTop; else low = viewport.scrollTop;
        }
        const back = list.querySelector(`[data-message-id="${targetId}"] details.tool-execution`);
        expand = {
          ok: Boolean(back && back.open && back.querySelectorAll('.tool-detail-block').length > 0),
          leftWindow,
          openedBlocks,
          backOpen: Boolean(back && back.open),
          backBlocks: back ? back.querySelectorAll('.tool-detail-block').length : 0,
        };
      }

      // ④ 滚回底部：最后一条必须在 DOM 里，而且真的贴底
      viewport.scrollTop = viewport.scrollHeight;
      await settle(6);
      const bottom = state();
      const atBottom = bottom.ids.includes('m599')
        && Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 2;
      const bottomButtonHidden = document.querySelector('#scrollToBottomButton')?.hidden === true;

      // ⑤ 短对话不做窗口化
      const short = makeMessages(30, 1);
      post(short);
      await settle(6);
      const shortState = state();

      // ⑥ 追加消息：贴底时必须立刻出现在列表里
      const appended = {
        id: 'm30', role: 'assistant', content: '新消息', createdAt: Date.now(), updatedAt: Date.now(),
        status: 'complete', toolExecutions: [],
      };
      window.postMessage({ type: 'messageAdded', conversationId: 'c', message: appended }, '*');
      await settle(6);
      const afterAppend = { ids: state().ids, rendered: state().rendered };

      return { wide, middle, middleCovered, bottom, atBottom, bottomButtonHidden, expand, shortState, afterAppend };
    });

    check('600 条消息只渲染一屏左右的节点',
      out.wide.rendered > 0 && out.wide.rendered <= 40,
      `DOM 里 ${out.wide.rendered} 条（全量应是 600）`);
    check('总节点数被压到千级',
      out.wide.nodes < 3000,
      `实测 ${out.wide.nodes} 个节点（窗口化前同样内容 38,400）`);
    check('上下都有占位块撑着',
      out.wide.spacers === 2 && out.wide.topSpacer > 0,
      `spacers=${out.wide.spacers} top=${out.wide.topSpacer}px bottom=${out.wide.bottomSpacer}px`);
    check('滚到中间时窗口跟过去且没有空洞',
      out.middleCovered && out.middle.ids[0] !== out.wide.ids[0],
      `covered=${out.middleCovered} 首条 ${out.middle.ids[0]}（底部窗口首条 ${out.wide.ids[0]}）`);
    check('滚回底部时最后一条在 DOM 且真的贴底',
      out.atBottom && out.bottomButtonHidden,
      `atBottom=${out.atBottom} 按钮隐藏=${out.bottomButtonHidden}`);
    check('展开过的步骤滚出去再滚回来仍然是展开的',
      out.expand.ok && out.expand.leftWindow && out.expand.openedBlocks > 0,
      `离开窗口=${out.expand.leftWindow} 展开后正文块=${out.expand.openedBlocks} 回来 open=${out.expand.backOpen} blocks=${out.expand.backBlocks}`);
    check('30 条的短对话不做窗口化（每条都在 DOM 里）',
      out.shortState.rendered === 30 && out.shortState.spacers === 0,
      `渲染 ${out.shortState.rendered} 条、占位块 ${out.shortState.spacers}`);
    check('追加的消息在贴底时立刻可见',
      out.afterAppend.ids.includes('m30'),
      `窗口里的最后一条是 ${out.afterAppend.ids[out.afterAppend.ids.length - 1]}`);
    check('运行期间无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));

    /* ── 真实使用流程：流式追加、翻上去看历史、补载更早消息、回到最新 ──────── */
    const flowPage = await browser.newPage({ viewport: { width: 700, height: 900 } });
    flowPage.on('pageerror', (error) => errors.push(error.message));
    await flowPage.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
    await flowPage.waitForSelector('#composer');
    const flow = await flowPage.evaluate(async () => {
      const settle = async (frames = 6) => {
        for (let i = 0; i < frames; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => setTimeout(resolve, 60));
      };
      const conv = () => ({
        id: 'c', title: 't', mode: 'agent', createdAt: Date.now(), updatedAt: Date.now(),
        messageCount: 200, preview: 'p', pinned: false, archived: false,
      });
      const make = (from, to) => Array.from({ length: to - from }, (_, i) => ({
        id: `m${from + i}`, role: 'assistant', content: `第 ${from + i} 条。`,
        createdAt: Date.now(), updatedAt: Date.now(), status: 'complete',
        toolExecutions: [{
          callId: `c${from + i}`, name: 'read_file', summary: 'src/f.ts', status: 'success',
          startedAt: Date.now(), input: '{"path":"src/f.ts"}', output: 'line\n'.repeat(12),
        }],
      }));
      window.postMessage({ type: 'state', state: {
        conversations: [conv()], archivedConversations: [], conversation: conv(), messages: make(0, 200), hasMore: true,
        settings: {
          sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll',
          agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
        },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 1, showArchived: false, taskTree: null, todos: [], project: null,
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
      } }, '*');
      const viewport = document.querySelector('#messageViewport');
      const list = document.querySelector('#messageList');
      const nodes = () => [...list.children].filter((node) => node.dataset.messageId);
      const ids = () => nodes().map((node) => node.dataset.messageId);
      const atBottom = () => Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 4;
      for (let i = 0; i < 200; i += 1) { if (nodes().length) break; await new Promise((resolve) => requestAnimationFrame(resolve)); }
      await settle();

      // ① 流式追加：新增消息立刻可见、正文持续增长、始终贴底
      window.postMessage({ type: 'messageAdded', conversationId: 'c', message: {
        id: 'm200', role: 'assistant', content: '流式开始', createdAt: Date.now(), updatedAt: Date.now(), status: 'streaming', toolExecutions: [],
      } }, '*');
      await settle();
      const appendedVisible = ids()[ids().length - 1] === 'm200' && atBottom();
      for (let i = 0; i < 5; i += 1) window.postMessage({ type: 'streamDelta', conversationId: 'c', messageId: 'm200', content: 'delta ' }, '*');
      await settle(8);
      const streaming = {
        text: list.querySelector('[data-message-id="m200"] .message-content')?.textContent || '',
        bottom: atBottom(),
      };

      // ② 用户翻上去看历史时，新消息不能把他拽走
      viewport.scrollTop = 2000;
      await settle(6);
      const beforeTop = viewport.scrollTop;
      const beforeFirst = ids()[0];
      window.postMessage({ type: 'messageAdded', conversationId: 'c', message: {
        id: 'm201', role: 'user', content: '新的一条', createdAt: Date.now(), updatedAt: Date.now(), status: 'complete', toolExecutions: [],
      } }, '*');
      await settle(6);
      const stayed = Math.abs(viewport.scrollTop - beforeTop) <= 2 && ids()[0] === beforeFirst;

      // ③ 补载更早消息：屏幕上的那条必须原地不动（button 消失带来的位移也要抵掉）
      const anchorNode = nodes().find((node) => node.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top);
      const anchorId = anchorNode?.dataset.messageId;
      const anchorTop = anchorNode ? Math.round(anchorNode.getBoundingClientRect().top - viewport.getBoundingClientRect().top) : null;
      await settle(4);
      window.postMessage({ type: 'olderMessages', messages: Array.from({ length: 40 }, (_, i) => ({
        id: `old${i}`, role: 'user', content: `更早 ${i}`, createdAt: Date.now(), updatedAt: Date.now(), status: 'complete', toolExecutions: [],
      })), hasMore: false }, '*');
      await settle(8);
      const afterNode = list.querySelector(`[data-message-id="${anchorId}"]`);
      const afterTop = afterNode ? Math.round(afterNode.getBoundingClientRect().top - viewport.getBoundingClientRect().top) : null;

      // ④ 「回到最新消息」按钮：窗口化之后不能靠平滑滚动，必须真的到底
      document.querySelector('#scrollToBottomButton')?.click();
      await settle(10);
      return {
        appendedVisible,
        streaming,
        stayed,
        prependDrift: afterTop === null ? null : Math.abs(afterTop - anchorTop),
        scrollButton: { last: ids()[ids().length - 1], bottom: atBottom() },
      };
    });
    check('流式追加的消息立刻可见并贴底', flow.appendedVisible, `末条=${flow.streaming.text.slice(0, 8)}…`);
    check('流式增量写进最后一条且保持贴底',
      flow.streaming.text.includes('delta delta') && flow.streaming.bottom,
      `正文=${JSON.stringify(flow.streaming.text.slice(-24))} 贴底=${flow.streaming.bottom}`);
    check('翻上去看历史时新消息不抢滚动位置', flow.stayed, '追消息时把用户拽回底部是常见回归');
    check('补载更早消息时画面不跳', flow.prependDrift !== null && flow.prependDrift <= 2, `位移 ${flow.prependDrift}px`);
    check('「回到最新消息」真的回到最后一条',
      flow.scrollButton.last === 'm201' && flow.scrollButton.bottom,
      `末条=${flow.scrollButton.last} 贴底=${flow.scrollButton.bottom}`);
    await flowPage.close();
    check('全流程无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
  }
}

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
