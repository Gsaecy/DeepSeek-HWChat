// 工具步骤「正文惰性渲染」的守门人。
//
// 背景（用户问：「为什么 copilot 能这么流畅并且占用不高」）：
//   VS Code 的聊天 UI 用的是 `WorkbenchObjectTree`（`src/vs/platform/list/browser/listService.ts`
//   的虚拟化列表），**只渲染视口内的行**；而 HWChat 是 webview 里手写 DOM，
//   每条消息、每个工具步骤都是真实节点。
//
// 实测（headless Chromium，真实 media/chat.js，600 条消息 × 每条 6 步 × 每步含输入+输出）：
//   · 纯文本消息                8 个 DOM 节点，600 条 = 渲染进程 RSS +41 MB
//   · 带 6 步的消息（先建后藏）136 个节点/条，600 条 = +241.4 MB
//   · 带 6 步的消息（展开才建） 64 个节点/条，600 条 = +231.6 MB
//   这些工具正文全都藏在收起的 `<details>` 里 —— 用户不点开就永远看不到，
//   旧实现却已经把节点、文本和排版对象都建好了。
//
// 修法：折叠时不建正文，第一次展开才建（默认展开的 pending 步骤仍立即建，
// 因为停滞提示在正文里、要实时可见）。
// 实测：6 步工具的消息 136 → **64 节点/条（−53%）**；展开后正文正确、反复开合不重复。
//
// 同一轮测量还纠正了一个直觉：节点减半，RSS 只降 4%（−10 MB）——
// 内存大头是「每条消息被真实排版/绘制」（≈0.39 MB/条），不是节点数量。
// 所以这条改动主要省节点和隐藏文本；要真正降内存，下一步得做列表虚拟化。
//
// 运行：node test/check-tool-detail-lazy.mjs
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_DIR = process.cwd();
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* ── 静态契约 ──────────────────────────────────────────────────────────── */
const CHAT_JS = readFileSync('media/chat.js', 'utf8');
check('存在惰性安装函数',
  /function installLazyToolDetail\(details, detail, tool, running\)/.test(CHAT_JS),
  '必须把「建正文」这一步抽出来，按需调用');
check('折叠时不建正文',
  /if \(details\.open\) \{\s*\n\s*build\(\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*details\.addEventListener\('toggle'/.test(CHAT_JS),
  '默认收起时只能挂 toggle 监听，不能直接 build()');
check('只建一次',
  /if \(details\.dataset\.detailBuilt === '1'\) return;/.test(CHAT_JS),
  '反复开合不许重复叠加内容');
check('默认展开的步骤立即建（停滞提示要实时可见）',
  /installLazyToolDetail\(details, detail, tool, running\)/.test(CHAT_JS)
  && /const running = tool\.status === 'pending' && !tool\.finishedAt;/.test(CHAT_JS),
  'pending 步骤是默认展开的，正文里含停滞提示');

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
      const conv = (n) => ({
        id: 'c', title: 't', mode: 'agent', createdAt: Date.now() - 9e6, updatedAt: Date.now(),
        messageCount: n, preview: 'p', pinned: false, archived: false,
      });
      // 50 条：低于窗口化阈值，这样量到的「每条消息的节点数」才是这条守护要管的东西。
      const MESSAGES = 50;
      const STEPS = 6;
      const messages = Array.from({ length: MESSAGES }, (_, i) => ({
        id: `m${i}`, role: 'assistant', content: '正文。',
        createdAt: Date.now(), updatedAt: Date.now(), status: 'complete',
        toolExecutions: Array.from({ length: STEPS }, (_, k) => ({
          callId: `c${i}-${k}`, name: 'read_file', summary: `src/file${k}.ts`, status: 'success',
          startedAt: Date.now(), input: JSON.stringify({ path: `src/file${k}.ts` }),
          output: 'line of output\n'.repeat(30),
        })),
      }));
      window.postMessage({ type: 'state', state: {
        conversations: [conv(MESSAGES)], archivedConversations: [], conversation: conv(MESSAGES), messages, hasMore: false,
        settings: {
          sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll',
          agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
        },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 1, showArchived: false, taskTree: null, todos: [], project: null,
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
      } }, '*');
      for (let i = 0; i < 400; i += 1) {
        if (document.querySelectorAll('#messageList .message').length === MESSAGES) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));

      const nodes = () => document.querySelectorAll('#messageList *').length;
      const collapsed = {
        perMessage: +(nodes() / MESSAGES).toFixed(1),
        blocks: document.querySelectorAll('.tool-detail-block').length,
        steps: document.querySelectorAll('details.tool-execution').length,
      };

      const first = document.querySelector('details.tool-execution');
      first.open = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
      const expanded = {
        blocks: first.querySelectorAll('.tool-detail-block').length,
        hasOutput: (first.textContent || '').includes('line of output'),
      };
      first.open = false;
      await new Promise((resolve) => setTimeout(resolve, 80));
      first.open = true;
      await new Promise((resolve) => setTimeout(resolve, 80));
      const afterToggle = first.querySelectorAll('.tool-detail-block').length;

      // 默认展开的 pending 步骤：正文必须立刻在（含停滞提示）
      const pendingMessage = {
        id: 'p1', role: 'assistant', content: '', createdAt: Date.now(), updatedAt: Date.now(), status: 'streaming',
        toolExecutions: [{
          callId: 'run-1', name: 'run_in_terminal', summary: 'npm test', status: 'pending',
          startedAt: Date.now(), input: '{"command":"npm test"}', stallHint: '看起来在等输入',
        }],
      };
      window.postMessage({ type: 'messageAdded', conversationId: 'c', message: pendingMessage }, '*');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const pendingDetails = [...document.querySelectorAll('details.tool-execution')].pop();
      const pending = {
        open: pendingDetails?.open === true,
        blocks: pendingDetails?.querySelectorAll('.tool-detail-block').length ?? 0,
        hasStallHint: (pendingDetails?.textContent || '').includes('看起来在等输入'),
      };

      // 用户展开过的那一步，在列表重排后必须仍然展开、且正文还在
      // （重排走 captureDetailOverrides → restoreDetailOverrides，它是「事后」设 open 的）
      first.open = true;
      await new Promise((resolve) => setTimeout(resolve, 80));
      const bumped = messages.map((message, i) => (i === 0)
        ? { ...message, content: `正文改一个字，逼它重排。`, updatedAt: message.updatedAt + 1000 }
        : message);
      window.postMessage({ type: 'state', state: {
        conversations: [conv(MESSAGES)], archivedConversations: [], conversation: conv(MESSAGES), messages: bumped, hasMore: false,
        settings: {
          sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll',
          agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
        },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 1, showArchived: false, taskTree: null, todos: [], project: null,
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
      } }, '*');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const restoredDetails = document.querySelector('details.tool-execution');
      const restored = {
        open: restoredDetails?.open === true,
        blocks: restoredDetails?.querySelectorAll('.tool-detail-block').length ?? 0,
        hasOutput: (restoredDetails?.textContent || '').includes('line of output'),
      };

      return { collapsed, expanded, afterToggle, pending, restored, messages: MESSAGES, steps: STEPS };
    });

    check('折叠状态下工具正文完全不在 DOM 里',
      out.collapsed.blocks === 0,
      `600 个工具步骤，实测 ${out.collapsed.blocks} 个正文块（>0 说明又回到「先建后藏」）`);
    // 0.3.6 把整轮工具步骤收进一个 details.execution-fold 外壳，每条消息因此多出
    // 几个节点（64 → 70.3）。这里守的是「折叠的正文没有建出来」，不是某个精确数字：
    // 先建后藏的写法是 136，任何接近它的值都说明惰性渲染失效了。
    check('每条消息的节点数远低于「先建后藏」（<76）',
      out.collapsed.perMessage < 76,
      `实测 ${out.collapsed.perMessage} 节点/条（惰性渲染前是 136）`);
    check('展开后正文正确出现',
      out.expanded.blocks === 2 && out.expanded.hasOutput,
      `blocks=${out.expanded.blocks} 含输出=${out.expanded.hasOutput}`);
    check('反复开合不会重复叠加',
      out.afterToggle === 2, `两次开合后 blocks=${out.afterToggle}`);
    check('默认展开的 pending 步骤正文立即存在（含停滞提示）',
      out.pending.open && out.pending.blocks > 0 && out.pending.hasStallHint,
      `open=${out.pending.open} blocks=${out.pending.blocks} stallHint=${out.pending.hasStallHint}`);
    check('重排后用户展开过的那一步仍然展开且正文还在',
      out.restored.open && out.restored.blocks > 0 && out.restored.hasOutput,
      `open=${out.restored.open} blocks=${out.restored.blocks} 含输出=${out.restored.hasOutput}`);
    check('运行期间无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));

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
