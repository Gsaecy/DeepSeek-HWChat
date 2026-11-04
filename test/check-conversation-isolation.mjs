/*
 * 对话之间不许串内容（真实浏览器 + 真实 media/chat.js）。
 *
 * 现场（用户 2026-11-04 报「不同的对话相互混乱污染了」，附四张截图）：
 * 对话 A 正在实时输出（status 仍是 `streaming`），用户切到对话 B；
 * 切过去之后 A 那条**还没写完的回复**被缝进了 B 的消息列表最末尾 ——
 * 之后再也不会消失（A 的 `messageComplete` 因为有会话校验被丢弃）。
 *
 * 根因：`mergeIncomingMessages(incoming, local)` 会保留「本地正在流式、但不在
 * incoming 里」的消息（本意是：整页推送只带首页 80 条，不能把正在流式的那条丢掉）。
 * 但它不知道**正在看的是哪条对话**，于是换了对话也照样把上一条对话的流式消息带过来。
 *
 * 同一个函数还有第二处同类问题：乐观气泡（`optimisticMessages`）是全局的，
 * 发送后立刻切对话，那句话会被 push 进另一条对话的列表里。
 *
 * 用法：node test/check-conversation-isolation.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_DIR = process.cwd();
const PLAYWRIGHT_ROOTS = [
  join(CHAT_DIR, 'node_modules', 'playwright'),
  join(homedir(), 'AI projects', 'Safevault_windows', 'node_modules', 'playwright'),
];
const playwrightRoot = PLAYWRIGHT_ROOTS.find((candidate) => existsSync(join(candidate, 'package.json')));
const cacheRoot = join(homedir(), 'Library/Caches/ms-playwright');
const chromiumDir = existsSync(cacheRoot)
  ? (readdirSync(cacheRoot).filter((name) => name.startsWith('chromium_headless_shell')).sort().pop() ?? null)
  : null;

let checks = 0;
let failures = 0;
function check(label, pass, detail) {
  checks += 1;
  if (pass) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const STORAGE = readFileSync('src/core/storage.ts', 'utf8');
const PANEL_FOR_LOAD = readFileSync('src/views/chatPanel.ts', 'utf8');

/* ── 静态契约 ─────────────────────────────────────────────────────────── */
check(
  '切换对话时把本地消息列表整个换掉（不参与合并）',
  /const switchedConversation = previousConversationId !== incoming\.conversation\?\.id;/.test(CHAT_JS)
  && /mergeIncomingMessages\(incoming\.messages \|\| \[\], switchedConversation \? \[\] : state\.messages\)/.test(CHAT_JS),
  '跨对话时必须传空列表，否则上一条对话的流式消息会被当成「本地正在流式」保留下来',
);
check(
  '切换对话时丢掉上一条对话的乐观气泡与「等宿主确认」标记',
  /if \(switchedConversation\) \{[\s\S]{0,200}optimisticMessages = \[\];[\s\S]{0,120}sendAwaitingHost = false;/.test(CHAT_JS),
  '乐观气泡是全局的：切过去会把「刚发的那句话」push 进另一条对话',
);
check(
  '同一条对话内的流式消息仍然保留（整页推送只带 80 条）',
  /const trailing = \(local \|\| \[\]\)\.filter\(\(item\) => !incomingIds\.has\(item\.id\) && item\.status === 'streaming' && !item\.optimistic\);/.test(CHAT_JS),
  '这条是原意，不能为了修跨对话而删掉',
);
check(
  '宿主只在补正文时刷新侧边栏预览',
  /if \(patch\.content !== undefined && updated\.content\) \{[\s\S]{0,80}summary\.preview = previewText\(updated\.content\);/.test(STORAGE),
  '旧实现任何 updateMessage 都会用 updated.content 覆盖预览 —— 用户消息改「已执行」时会把预览变成那句旧话',
);

check(
  '记住「列表里真正画着的是哪条对话」',
  /let renderedConversationId = '';/.test(CHAT_JS) && /renderedConversationId = conversationId;/.test(CHAT_JS),
  '重绘会被选字/交互推迟，而 state.conversation 是立刻换的；没有这个值就分不清',
);
check(
  '换对话时强制整段重绘（不吃延迟守卫）',
  /forceMessages: switchedConversation/.test(CHAT_JS)
  && /renderMessages\('replace', \{ force: forceMessages \}\)/.test(CHAT_JS),
  'renderAll 必须把 force 传下去，否则标题换了列表不动',
);
check(
  '换对话时清掉「正在选字 / 正在交互 / 待重绘」三个标记',
  /interactingWithMessages = false;[\s\S]{0,120}selectingMessageText = false;[\s\S]{0,120}deferredMessageRenderMode = null;/.test(CHAT_JS),
  '这三个标记只为保护同一份列表里的操作，换对话后继续留着会永久推迟重绘',
);
check(
  '追加消息前校验列表属于当前对话',
  /if \(state\.conversation\?\.id !== renderedConversationId\) \{[\s\S]{0,200}renderMessages\('replace', \{ force: true \}\);/.test(CHAT_JS),
  '推迟期间来的 messageStart 会把新对话的消息追加到旧对话的列表末尾',
);
check(
  '签名不许在没对齐时谎报「画面已最新」',
  /function syncRenderedSignature\(\) \{\s*if \(state\.conversation\?\.id !== renderedConversationId\) return;/.test(CHAT_JS),
  '谎报之后每次推送都会跳重重绘，界面永久停在另一条对话上',
);
check(
  '补载历史按对话校验（两侧都要）',
  /message\.conversationId !== state\.conversation\?\.id\) break;/.test(CHAT_JS)
  && /if \(this\.activeConversationId !== conversationId\)/.test(PANEL_FOR_LOAD)
  && /type: 'olderMessages',\s*\n\s*conversationId,/.test(PANEL_FOR_LOAD),
  'A 的一页被拼到 B 的列表前面，看起来就是两个对话混在一起',
);
check(
  '切换对话时读摘要失败也要推状态',
  /\[selectConversation\] 读取摘要失败/.test(PANEL_FOR_LOAD)
  && /catch \(error\) \{\s*\/\/[\s\S]{0,300}await this\.sendState\(\);/.test(PANEL_FOR_LOAD),
  '宿主已切、界面停在旧对话，之后发的消息就会落到另一条对话里',
);

/* ── 真实浏览器行为 ───────────────────────────────────────────────────── */
if (!playwrightRoot || !chromiumDir) {
  console.log(`\nSKIP 真实浏览器部分：${playwrightRoot ? '找不到 chromium' : '找不到 playwright'}`);
} else {
  const { chromium: launcher } = await import(join(playwrightRoot, 'index.mjs'));
  const executablePath = join(cacheRoot, chromiumDir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  if (!existsSync(executablePath)) {
    console.log('\nSKIP 真实浏览器部分：chromium 可执行文件不在预期路径');
  } else {
    const browser = await launcher.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
    await page.waitForSelector('#composer');

    const outcome = await page.evaluate(async () => {
      const now = Date.now();
      const conversationA = { id: 'convA', title: '对话 A', mode: 'agent', createdAt: now - 90000, updatedAt: now, messageCount: 2, preview: 'A 的回答', pinned: false, archived: false };
      const conversationB = { id: 'convB', title: '对话 B', mode: 'agent', createdAt: now - 80000, updatedAt: now, messageCount: 2, preview: 'B 正在输出', pinned: false, archived: false };
      const base = {
        conversations: [conversationA, conversationB], archivedConversations: [],
        settings: {
          sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'deepseek-flash',
          permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
        },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 0, showArchived: false, taskTree: null, todos: [],
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {}, pendingAttachments: [],
        hasMore: false,
      };
      const a1 = { id: 'a1', role: 'user', content: 'A 的问题', createdAt: now - 6000, updatedAt: now - 6000, status: 'complete' };
      const a2 = { id: 'a2', role: 'assistant', content: 'A 的回答', createdAt: now - 5000, updatedAt: now - 5000, status: 'complete' };
      const b1 = { id: 'b1', role: 'user', content: 'B 的问题', createdAt: now - 4000, updatedAt: now - 4000, status: 'complete' };
      const b2 = { id: 'b2', role: 'assistant', content: 'B 正在输出', createdAt: now - 3000, updatedAt: now - 3000, status: 'streaming' };
      const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const push = async (state) => { window.postMessage({ type: 'state', state }, '*'); await settle(); await settle(); };
      const ids = () => [...document.querySelectorAll('#messageList .message')].map((node) => node.dataset.messageId);
      const texts = () => [...document.querySelectorAll('#messageList .message .message-content')].map((node) => node.textContent || '');

      // 1) 看对话 A
      await push({ ...base, conversation: conversationA, messages: [a1, a2] });
      const onA = ids();

      // 2) 看对话 B（B 的回复正在流式输出）
      await push({ ...base, conversation: conversationB, messages: [b1, b2], streamingConversationId: 'convB' });
      window.postMessage({ type: 'streamDelta', conversationId: 'convB', messageId: 'b2', content: '，还在写…', reasoning: '' }, '*');
      await settle();
      const onB = ids();

      // 3) 切回对话 A。A 的整页推送里当然没有 B 的 b2。
      await push({ ...base, conversation: conversationA, messages: [a1, a2] });
      const backOnA = ids();
      const backTexts = texts();

      // 4) 切对话时那条流式消息结束了（宿主会做会话校验，直接丢弃）：
      //    如果它已经被缝进 A，就会一直卡在 A 里。
      window.postMessage({ type: 'messageComplete', conversationId: 'convB', message: { ...b2, status: 'complete', content: 'B 正在输出，还在写…' } }, '*');
      await settle();
      const afterComplete = ids();

      // 5) 乐观气泡：在 A 里发一句，宿主还没确认就切到 B。
      await push({ ...base, conversation: conversationA, messages: [a1, a2] });
      const input = document.getElementById('promptInput');
      input.value = 'A 里刚发出的这句';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const form = input.closest('form') || document.getElementById('composer');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await settle();
      const afterSendA = ids();
      await push({ ...base, conversation: conversationB, messages: [b1, b2] });
      const bAfterSwitch = ids();
      const bTexts = texts();

        // 6) 冻结窗口：用户在 A 的正文里选着字（或正按住消息区），此时切到 B，
      //    并且 B 在 3 秒守卫窗口内就发出了新消息 —— 旧实现会把 B 的新消息追加到
      //    A 的列表末尾，画面签名还会谎报「已最新」，于是永久停住。
      await push({ ...base, conversation: conversationA, messages: [a1, a2] });
      const body = document.querySelector('[data-message-id="a2"] .message-body')
        || document.querySelector('[data-message-id="a2"] .message-content');
      const guard = await (async () => {
        body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('[data-message-id="a2"] .message-content'));
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        window.postMessage({ type: 'state', state: { ...base, conversation: conversationB, messages: [b1, b2] } }, '*');
        await settle(); await settle();
        const immediately = ids();
        window.postMessage({
          type: 'messageStart', conversationId: 'convB',
          userMessage: { id: 'b3', role: 'user', content: 'B 的新问题', createdAt: now, updatedAt: now, status: 'complete' },
          assistant: { id: 'b4', role: 'assistant', content: '', createdAt: now, updatedAt: now, status: 'streaming' },
          pendingAttachments: [],
        }, '*');
        await settle();
        const afterStart = ids();
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const afterTimer = ids();
        selection.removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
        await settle();
        return { immediately, afterStart, afterTimer, final: ids(), texts: texts() };
      })();

      return {
        guard,
        onA, onB, backOnA, backTexts, afterComplete,
        afterSendA, bAfterSwitch, bTexts,
        leakedIntoA: backOnA.includes('b2'),
        stillStuckInA: afterComplete.includes('b2'),
        optimisticLeakedIntoB: bAfterSwitch.some((id) => id.startsWith('optimistic')),
        optimisticTextInB: bTexts.some((text) => text.includes('A 里刚发出的这句')),
      };
    });

    check('第一次进入对话 A 只显示 A 的两条', outcome.onA.join(',') === 'a1,a2', `实际：${outcome.onA.join(',')}`);
    check('进入对话 B 只显示 B 的两条', outcome.onB.join(',') === 'b1,b2', `实际：${outcome.onB.join(',')}`);
    check('切回 A 后列表里没有 B 的流式消息', !outcome.leakedIntoA, `实际：${outcome.backOnA.join(',')}`);
    check('切回 A 后正文里没有 B 的内容', !outcome.backTexts.some((text) => text.includes('B 正在输出')), `实际：${JSON.stringify(outcome.backTexts)}`);
    check('B 结束后 A 里依然没有 B 的消息', !outcome.stillStuckInA, `实际：${outcome.afterComplete.join(',')}`);
    check('A 里发送后乐观气泡出现在 A', outcome.afterSendA.some((id) => id.startsWith('optimistic')), `实际：${outcome.afterSendA.join(',')}`);
    check('切到 B 后没有 A 的乐观气泡', !outcome.optimisticLeakedIntoB, `实际：${outcome.bAfterSwitch.join(',')}`);
    check('切到 B 后看不到 A 里那句没确认的话', !outcome.optimisticTextInB);
    // 冻结窗口场景：任何时刻都不允许出现「A 的消息 + B 的消息」混在一个列表里
    const aIds = new Set(['a1', 'a2']);
    const mixedIn = (list) => list.some((id) => aIds.has(id));
    check('选着字切到 B：立即就是 B 的列表（不吃延迟守卫）',
      !mixedIn(outcome.guard.immediately) && outcome.guard.immediately.includes('b1'),
      `实际：${outcome.guard.immediately.join(',')}`);
    check('冻结窗口内 B 发新消息：不追加到 A 的列表里',
      !mixedIn(outcome.guard.afterStart) && outcome.guard.afterStart.includes('b3'),
      `实际：${outcome.guard.afterStart.join(',')}`);
    check('3 秒后依然是纯 B 的列表（签名没被污染）',
      !mixedIn(outcome.guard.afterTimer), `实际：${outcome.guard.afterTimer.join(',')}`);
    check('收起选区后也不会翻回 A',
      !mixedIn(outcome.guard.final), `实际：${outcome.guard.final.join(',')}`);
    check('冻结窗口里也没有 A 的正文',
      !outcome.guard.texts.some((text) => text.includes('A 的长回复') || text.includes('A 的问题')),
      `实际：${JSON.stringify(outcome.guard.texts.slice(0, 4))}`);
    check('浏览器控制台没有报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' / '));

    await browser.close();
  }
}

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('对话隔离：失败。上面每一项都对应一个真实的串内容路径。');
  process.exitCode = 1;
} else {
  console.log('对话隔离：切换对话不会把另一条对话的实时消息或待确认气泡带过来。');
}
