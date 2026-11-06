// 状态推送「省略消息正文」的行为验证（真实浏览器 + 真实 media/chat.js）。
//
// 现场（审计实测）：1513 条消息的对话，`sendState()` 仅首页 80 条就是 **5.39 MB**，
// 单次推送约 27ms 主线程开销，而 `sendState()` 有 22 处调用点。绝大多数调用只改了
// 设置/列表/清单 —— 消息一条没变，却每次都在搬 5 MB。
//
// 现在的协议：签名没变时宿主发 `messagesUnchanged: true` 且 `messages: []`。
// **前端必须保留自己已有的列表** —— 如果把它当成「消息被清空」，用户每次点置顶/
// 归档都会看到对话闪成空白再重画。这条只能跑真实 DOM 验。
//
// 运行：node test/check-state-payload.mjs
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
const chromium = existsSync(cacheRoot)
  ? (readdirSync(cacheRoot).filter((name) => name.startsWith('chromium_headless_shell')).sort().pop() ?? null)
  : null;

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* ── 静态契约：两侧都必须在场 ───────────────────────────────────────────── */
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const SIGNATURE = readFileSync('src/views/messageSignature.ts', 'utf8');

check('宿主侧：签名没变时省掉 messages 并置 messagesUnchanged',
  PANEL.includes('messagesUnchanged') && PANEL.includes('messagesSignatureKey('),
  'chatPanel 里必须计算签名并下发 messagesUnchanged');
check('宿主侧：webview 重建后代次 +1 且清空签名（强制全量）',
  /this\.webviewGeneration \+= 1;[\s\S]{0,120}this\.pushedMessagesKey = '';/.test(PANEL),
  'resolveWebviewView 里必须重置，否则新建的 webview 会收到「不变」而空着');
check('前端侧：messagesUnchanged 时保留已有列表',
  // 允许实现把消息列表交给合并函数（保住本地正在流式的正文），但「messagesUnchanged 时不动列表」
  // 这个前提必须还在：直接赋值 `incoming.messages` 会把列表当成清空。
  // 唯一例外是换了对话（`switchedConversation`）：那时必须整份替换，否则会把上一条
  // 对话的流式消息缝进来 —— 见 check-conversation-isolation.mjs。
  /if \(incoming\.messagesUnchanged !== true \|\| switchedConversation\) \{[\s\S]{0,200}state\.messages = mergeIncomingMessages\(incoming\.messages \|\| \[\], switchedConversation \? \[\] : state\.messages\);/.test(CHAT_JS)
  && !/state\.messages = incoming\.messages/.test(CHAT_JS),
  'chat.js 不许把 messagesUnchanged 当成「清空」');
check('签名函数是独立纯模块（可单测）',
  SIGNATURE.includes('export function messagesSignatureKey('),
  '签名逻辑要能被单测覆盖');

/* ── 列表载荷：todoArchives 是纯死重（占 96%）─────────────────────────── */
check('宿主侧：历史列表去掉 todoArchives 与 taskNodes',
  /historySummary\(summary: ConversationSummary\): Omit<ConversationSummary, 'todoArchives' \| 'taskNodes'>/.test(PANEL)
  && /const \{ todoArchives: _archives, taskNodes: _taskNodes, \.\.\.rest \} = summary;/.test(PANEL),
  '实测 5 条对话的列表 JSON 174.8 KB，其中 167.7 KB 是 todoArchives；任务记忆同理，侧边栏两样都不用');
check('宿主侧：state 的两个列表都走精简',
  /conversations: this\.historyList\(conversations\)/.test(PANEL)
  && /archivedConversations: this\.historyList\(archivedConversations\)/.test(PANEL)
  && /conversations: this\.historyList\(all\.filter/.test(PANEL),
  'runSendState 与 postHistorySnapshot 都必须用精简摘要，漏一处就白改');

/* ── 附件：索引被淘汰后必须能从存档恢复 ─────────────────────────────────── */
check('附件：统一的解析入口（索引 → 指针 → 存档）',
  /private async resolveAttachment\(id: string \| undefined\): Promise<MessageContext \| undefined>/.test(PANEL),
  '两条路径（取数据、加进输入框）都要走同一条恢复逻辑');
check('附件：取数据路径用恢复后的结果',
  /const known = await this\.resolveAttachment\(message\.id\);/.test(PANEL),
  'provideAttachmentData 不许只查内存索引');
check('附件：加进输入框路径也用恢复结果',
  /const known = await this\.resolveAttachment\(id\);/.test(PANEL),
  'attachMessageAttachment 不许只查内存索引');
check('附件：不参与淘汰的指针表存在且有上限',
  /private readonly attachmentLocations = new Map/.test(PANEL) && /ATTACHMENT_LOCATION_LIMIT/.test(PANEL),
  '指针表只存位置，必须能在正文被淘汰后仍然可用');
check('附件：正文索引上限已收紧到 16M 字符',
  /ATTACHMENT_INDEX_CHAR_LIMIT = 16 \* 1024 \* 1024/.test(PANEL),
  '48M 字符常驻内存太大；恢复路径已就位，收紧才安全');

/* ── 真实浏览器行为 ─────────────────────────────────────────────────────── */
if (!playwrightRoot || !chromium) {
  console.log(`SKIP 真实浏览器部分：${playwrightRoot ? '找不到 chromium' : '找不到 playwright'}（静态检查已完成）`);
} else {
  const { chromium: launcher } = await import(join(playwrightRoot, 'index.mjs'));
  const executablePath = join(cacheRoot, chromium, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  if (!existsSync(executablePath)) {
    console.log('SKIP 真实浏览器部分：chromium 可执行文件不在预期路径');
  } else {
    const browser = await launcher.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
    await page.waitForSelector('#composer');

    const N = 200;
    const outcome = await page.evaluate(async (count) => {
      const conversation = {
        id: 'conv1', title: '状态推送验证', mode: 'agent', createdAt: Date.now() - 86400000,
        updatedAt: Date.now(), messageCount: count, preview: '预览', pinned: false, archived: false,
      };
      const messages = Array.from({ length: count }, (_, i) => ({
        id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${i} 条：` + '内容描述。'.repeat(20),
        createdAt: Date.now() - (count - i) * 1000, updatedAt: Date.now() - (count - i) * 1000,
        status: 'complete',
      }));
      const base = {
        conversations: [conversation], archivedConversations: [], conversation,
        settings: {
          sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'deepseek-flash',
          permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
        },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 12, showArchived: false, taskTree: null, todos: [], project: null,
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
      };
      const countNodes = () => document.querySelectorAll('#messageList .message').length;
      // 窗口化之后「DOM 里有几条」不再等于「状态里有几条」：能证明列表没丢的
      // 是「最后一条渲染出来的消息是谁」。这里全程按 id 断言。
      const tailId = () => [...document.querySelectorAll('#messageList .message')].pop()?.dataset.messageId ?? '';
      const tailText = () => [...document.querySelectorAll('#messageList .message .message-content')].pop()?.textContent ?? '';

      // 1) 首次推送：带消息
      window.postMessage({ type: 'state', state: { ...base, messages, hasMore: true } }, '*');
      for (let i = 0; i < 240; i += 1) {
        if (countNodes() >= count) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const afterFull = countNodes();
      const fullTail = tailId();

      // 2) 只改设置：messages 为空 + messagesUnchanged
      const startedSkip = performance.now();
      window.postMessage({
        type: 'state',
        state: { ...base, messages: [], messagesUnchanged: true, hasMore: true },
      }, '*');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const afterSkip = countNodes();
      const skipTail = tailId();
      const skipMs = performance.now() - startedSkip;

      // 3) 再来一次（模拟连点置顶/归档）
      window.postMessage({ type: 'state', state: { ...base, messages: [], messagesUnchanged: true, hasMore: true } }, '*');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const repeatTail = tailId();

      // 4) 真的变了：必须重新渲染出新消息
      const next = [...messages, {
        id: 'm-new', role: 'user', content: '新来的一条', createdAt: Date.now(), updatedAt: Date.now(), status: 'complete',
      }];
      window.postMessage({ type: 'state', state: { ...base, messages: next, hasMore: true } }, '*');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return {
        afterFull,
        afterSkip,
        afterRepeat: countNodes() - 1,
        afterRealChange: countNodes(),
        lastText: tailText(),
        fullTail,
        skipTail,
        repeatTail,
        changeTail: tailId(),
        skipMs,
      };
    }, N);

    check('首次全量推送后渲染到最新一条',
      outcome.afterFull > 0 && outcome.fullTail === `m${N - 1}`, `渲染 ${outcome.afterFull} 条，末条 ${outcome.fullTail || '无'}`);
    check('messagesUnchanged 时列表**不被清空**',
      outcome.afterSkip > 0 && outcome.skipTail === `m${N - 1}`, `推送后仍有 ${outcome.afterSkip} 条，末条 ${outcome.skipTail || '无'}（清空即回归）`);
    check('连续多次 messagesUnchanged 也不会丢内容',
      outcome.afterRepeat > 0 && outcome.repeatTail === `m${N - 1}`, `连续两次后仍有 ${outcome.afterRepeat} 条，末条 ${outcome.repeatTail || '无'}`);
    check('内容真的变了仍能推送并渲染',
      outcome.changeTail === 'm-new' && outcome.lastText.includes('新来的一条'),
      `${outcome.afterRealChange} 条，末条「${outcome.lastText.slice(0, 12)}」`);
    // 省下的是**传输与解析**（实测 5.39 MB / 约 27ms 主线程），不是把状态处理变成 0：
    // 这里只守住「不会因为省略了消息反而变慢」，避免有人给这条路径加同步重活。
    check('省略消息后单次推送不慢于全量的量级',
      outcome.skipMs < 60, `实测 ${Math.round(outcome.skipMs)}ms（省下的是 5.39 MB 传输与约 27ms 解析）`);
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
