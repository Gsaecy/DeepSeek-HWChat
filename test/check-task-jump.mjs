// 任务树点击 → 跳到该任务输出位置（用户 2026-11-06 需求）。
//
// 需求原文：「我需要点击任务树正在执行的条目窗口跳转到正在执行的输出光标的位置，
// 因为有时候合并执行的话，后来发的消息先执行完，再执行中间的，会导致输出光标不在最底下，
// 我需要能快捷达到当下执行输出的位置」。
//
// 运行：node test/check-task-jump.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_DIR = process.cwd();
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_CSS = readFileSync('media/chat.css', 'utf8');
const TYPES = readFileSync('src/core/types.ts', 'utf8');
const QUEUE = readFileSync('src/agent/taskQueue.ts', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

/* ── 静态契约 ──────────────────────────────────────────────────────────── */
check('节点带上「回复消息 id」', /assistantMessageId\?: string;/.test(TYPES), '只给 userMessageId 会跳到用户那句话');
check('队列下发回复消息 id', /assistantMessageId: this\.bindingOf\(node\.id\)\?\.assistantMessageId/.test(QUEUE));
check('运行结束后的「恢复待办」树也带上', /assistantMessageId: assistantOf\.get\(id\)/.test(PANEL));
check('整行可点且有可访问性属性', /row\.dataset\.jumpMessageId = target/.test(CHAT_JS) && /row\.setAttribute\('role', 'button'\)/.test(CHAT_JS));
check('键盘 Enter / 空格也能跳', /event\.key !== 'Enter' && event\.key !== ' '\) return/.test(CHAT_JS));
check('行内操作不会顺带触发跳转', /closest\('\.task-node-actions'\)\) return/.test(CHAT_JS));
check('流式消息滚到光标而不是消息顶部', /const cursor = node\.querySelector\('\.stream-cursor'\)/.test(CHAT_JS));
check('提示语按「那条回复是否在写」判断（不是只看对话在跑）',
  /message\.id === target && message\.status === 'streaming'/.test(CHAT_JS));
check('窗口外的消息先搬虚拟窗口再滚', /buildMessageWindow\(start, start \+ span\)/.test(CHAT_JS));
check('跳完关掉 autoFollow（不被下一次增量拽回底部）', /state\.autoFollow = false;\s*\n\s*const viewport = elements\.messageViewport;/.test(CHAT_JS));
check('落点高亮 2 秒后撤掉', /classList\.add\('is-jump-target'\)/.test(CHAT_JS) && /2_000/.test(CHAT_JS));
check('样式：可点手型 + 落点高亮 + 尊重减弱动效', /\.task-node\.is-jumpable \{ cursor: pointer; \}/.test(CHAT_CSS) && /\.message\.is-jump-target/.test(CHAT_CSS) && /jump-target-fade/.test(CHAT_CSS));
check('文案中英都齐', /'taskQueue\.jumpToOutput'/.test(I18N) && /'taskQueue\.jumpToCursor'/.test(I18N));

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
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
    await page.waitForSelector('#composer');

    const out = await page.evaluate(async () => {
      const now = Date.now();
      const conv = { id: 'c', title: 't', mode: 'agent', createdAt: now, updatedAt: now, messageCount: 6, preview: 'p', pinned: false, archived: false };
      // 让列表足够高、必须滚动才能定位到目标。
      const filler = (n) => Array.from({ length: n }, (_, i) => `第 ${i} 行。`).join('\n');
      const messages = [
        { id: 'u1', role: 'user', content: '第一条：先更新网站', createdAt: now, updatedAt: now, status: 'complete', executionStatus: 'done' },
        { id: 'a1', role: 'assistant', content: filler(40), createdAt: now, updatedAt: now, status: 'complete' },
        { id: 'u2', role: 'user', content: '中间这条：软件使用录屏后崩溃闪退', createdAt: now, updatedAt: now, status: 'complete', executionStatus: 'running' },
        // 现在正在输出的那条（合并执行时它在中间，光标不在最底下）
        { id: 'a2', role: 'assistant', content: filler(60), createdAt: now, updatedAt: now, status: 'streaming' },
        { id: 'u3', role: 'user', content: '最后发的：宝塔面板登录', createdAt: now, updatedAt: now, status: 'complete', executionStatus: 'done' },
        { id: 'a3', role: 'assistant', content: filler(30), createdAt: now, updatedAt: now, status: 'complete' },
      ];
      window.postMessage({ type: 'state', state: {
        conversations: [conv], archivedConversations: [], conversation: conv, messages, hasMore: false,
        settings: { sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll', agentMaxSteps: 0, reasoningEffort: 'default', internetReference: false },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 1, showArchived: false, todos: [], project: null,
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {}, streaming: true,
        taskTree: { active: true, currentNodeId: 'n2', nodes: [
          { id: 'n1', title: '先更新网站', status: 'complete', relation: 'root', userMessageId: 'u1', assistantMessageId: 'a1' },
          { id: 'n2', title: '软件使用录屏后崩溃闪退', status: 'active', relation: 'queued', userMessageId: 'u2', assistantMessageId: 'a2' },
          { id: 'n3', title: '宝塔面板登录', status: 'complete', relation: 'queued', userMessageId: 'u3', assistantMessageId: 'a3' },
        ] },
      } }, '*');
      for (let i = 0; i < 400; i += 1) {
        if (document.querySelectorAll('#taskTreeList .task-node').length === 3) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      await new Promise((r) => setTimeout(r, 150));

      const viewport = document.querySelector('#messageViewport');
      const before = viewport.scrollTop;
      const row = document.querySelectorAll('#taskTreeList .task-node')[1];
      const jumpable = row.classList.contains('is-jumpable');
      const title = row.title;
      row.click();
      await new Promise((r) => setTimeout(r, 260));

      const target = document.querySelector('[data-message-id="a2"]');
      const cursor = target?.querySelector('.stream-cursor');
      const vpRect = viewport.getBoundingClientRect();
      const cursorRect = cursor?.getBoundingClientRect();
      return {
        before,
        jumpable,
        title,
        scrolled: viewport.scrollTop !== before,
        cursorVisible: Boolean(cursorRect && cursorRect.top >= vpRect.top - 4 && cursorRect.bottom <= vpRect.bottom + 4),
        highlighted: target?.classList.contains('is-jump-target') === true,
        // 不在底部时应出现「回到底部」按钮（`updateScrollToBottom` 的语义）。
        backToBottomVisible: document.querySelector('#scrollToBottomButton')?.hidden === false,
      };
    });

    check('任务树一行可点（带 is-jumpable）', out.jumpable === true, JSON.stringify(out));
    check('正在执行的那行提示「跳到正在输出的光标」', /光标/.test(out.title ?? ''), out.title);
    check('点击后视口真的滚动到了目标位置', out.scrolled === true, JSON.stringify(out));
    check('落在**输出光标**上（而不是消息顶部）', out.cursorVisible === true, JSON.stringify(out));
    check('落点被高亮标出来', out.highlighted === true, JSON.stringify(out));
    check('跳转后出现「回到底部」按钮（说明不再自动贴底）', out.backToBottomVisible === true, JSON.stringify(out));
    check('没有脚本错误', errors.length === 0, errors.join('; '));

    await browser.close();
  }
}

let failed = 0;
for (const item of results) {
  if (item.pass) console.log(`✓ ${item.name}`);
  else {
    failed += 1;
    console.log(`✗ ${item.name}${item.detail ? `\n    ${item.detail}` : ''}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} 项通过`);
if (failed) {
  console.log('「点任务树跳到输出位置」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('点任务树里的一行就落到那条任务的输出光标上，并短暂高亮。');
}
