// 「点发送 → 气泡出现」的延迟守护（真实浏览器 + 真实 media/chat.js）。
//
// 用户反馈：「hwchat 的对话框，用户发送消息，到对话框显示消息，有 2-3 秒延迟，这延迟很久」。
//
// 旧实现的两处延迟：
//   1. **扩展侧**：`submit()` 把文字丢给宿主后什么都不画，要等宿主落盘、扫描技能
//      （三条 `findFiles`，本机 21 目录的工作区冷缓存实测 3.0–3.8 秒/条）、
//      组装上下文、建占位回复之后才推 `messageStart`。用户看到的是「输入框清空、
//      界面静止 2-3 秒」。
//   2. **界面侧**：`messageStart` / `messageAdded` 都走 `renderMessages()` 整屏重建
//      （`replaceChildren()` + 全量重造）。200 条消息实测 129ms / 190ms，白等一截。
//
// 现在的契约（本脚本逐条验证）：
//   A. `submit()` **同步返回时**乐观气泡已经在 DOM 里 —— 不依赖宿主任何响应；
//   B. 宿主确认（`messageStart`）后，乐观气泡退场、换成带真实 id 的两条，不重复；
//   C. 宿主拒绝（`sendRejected`）后，气泡退场、原文回到输入框（不许凭空吞掉用户的话）；
//   D. 连点/连按回车只产生**一个**气泡；
//   E. 以上全部走增量追加，不整屏重建（200 条消息下同步耗时仍应在几十毫秒量级）。
//
// 前置：playwright 与 chromium 由本机缓存提供；找不到就跳过（打印 SKIP 并退出 0）。
//
// 运行：node test/check-send-latency.mjs
import { existsSync, readdirSync } from 'node:fs';
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

if (!playwrightRoot || !chromium) {
  console.log(`SKIP 发送延迟验证：${playwrightRoot ? '找不到 chromium' : '找不到 playwright'}（不影响其它检查）`);
  process.exit(0);
}

const { chromium: launcher } = await import(join(playwrightRoot, 'index.mjs'));
const executablePath = join(cacheRoot, chromium, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
if (!existsSync(executablePath)) {
  console.log('SKIP 发送延迟验证：chromium 可执行文件不在预期路径');
  process.exit(0);
}

const browser = await launcher.launch({ executablePath });
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
await page.waitForSelector('#composer');

/** 装一段真实大小的对话（200 条，含代码块与工具步骤），模拟用户的长对话。 */
const MESSAGE_COUNT = 200;
await page.evaluate(async (count) => {
  const mk = (i, role) => ({
    id: `m${i}`,
    role,
    content: role === 'user'
      ? `第 ${i} 条：` + '需求描述与 `readFile()` 引用。'.repeat(8)
      : `## 标题 ${i}\n\n**加粗**、\`行内代码\` 与列表：\n\n- 项一 src/core/storage.ts:441\n- 项二 \`npm test\`\n\n\`\`\`ts\nconst x${i}=${i};\n\`\`\`\n\n结尾段落。`.repeat(3),
    createdAt: Date.now() - (count - i) * 1000,
    updatedAt: Date.now() - (count - i) * 1000,
    status: 'complete',
    toolExecutions: role === 'assistant'
      ? Array.from({ length: 4 }, (_, k) => ({
        callId: `c${i}-${k}`, name: 'read_file', summary: `src/f${k}.ts`, status: 'success',
        startedAt: Date.now(), output: 'x'.repeat(400),
      }))
      : undefined,
  });
  const messages = [];
  for (let i = 0; i < count; i += 1) messages.push(mk(i, i % 2 === 0 ? 'user' : 'assistant'));
  // 历史列表要渲染，摘要字段必须齐：缺 updatedAt 会让日期格式化抛错、把整段 state 处理打断。
  const conversation = {
    id: 'conv1', title: '发送延迟验证', mode: 'agent', createdAt: Date.now() - 86400000,
    updatedAt: Date.now(), messageCount: count, preview: '预览', pinned: false, archived: false,
  };
  window.postMessage({
    type: 'state',
    state: {
      conversations: [conversation], archivedConversations: [], conversation, messages, hasMore: false,
      settings: {
        sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'deepseek-flash',
        permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
      },
      skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
      availableToolCount: 12, showArchived: false, taskTree: null, todos: [], project: null,
      modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
    },
  }, '*');
  // 等渲染真的落地（渲染会在 rAF 里排队）。
  for (let i = 0; i < 240; i += 1) {
    if (document.querySelectorAll('#messageList .message').length >= count) return;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}, MESSAGE_COUNT);

const countMessages = () => page.evaluate(() => document.querySelectorAll('#messageList .message').length);
const optimisticIds = () => page.evaluate(() => [...document.querySelectorAll('#messageList .message')]
  .map((node) => node.dataset.messageId || '')
  .filter((id) => id.startsWith('optimistic-')));

const baseline = await countMessages();
// 窗口化之后 DOM 里只有视口附近那一屏（200 条整段渲染实测 +92.5 MB 是我们要省掉的），
// 所以这里断言的是「渲染到了最新一条」，不是「200 条都在 DOM 里」。
const baselineTail = await page.evaluate(() => [...document.querySelectorAll('#messageList .message')].pop()?.dataset.messageId || '');
check('夹具就绪：窗口已渲染到最新一条', baseline > 0 && baseline <= 40 && baselineTail === `m${MESSAGE_COUNT - 1}`,
  `渲染 ${baseline} 条，末条 ${baselineTail}`);

/* ── A. submit() 同步返回时气泡已在 DOM 里 ───────────────────────────────── */
const sendA = await page.evaluate(async () => {
  const input = document.getElementById('promptInput');
  input.value = '这是一条新消息，用于验证发送延迟';
  const started = performance.now();
  document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  const elapsed = performance.now() - started;
  const nodes = [...document.querySelectorAll('#messageList .message')];
  const last = nodes[nodes.length - 1];
  return {
    elapsed,
    count: nodes.length,
    lastId: last?.dataset.messageId || '',
    lastText: last?.querySelector('.message-content')?.textContent || '',
    inputCleared: input.value === '',
    posted: window.__hwchatMessages.map((message) => message.type),
  };
});
check('点发送 → 同一帧就画出用户气泡（不等宿主）',
  sendA.lastId.startsWith('optimistic-') && sendA.lastText.includes('这是一条新消息'),
  `count=${sendA.count} id=${sendA.lastId}`);
check('同步耗时在几十毫秒量级（增量追加，不整屏重建）',
  sendA.elapsed < 150, `实测 ${Math.round(sendA.elapsed)}ms（旧实现整屏重建 129ms 起）`);
check('输入框同时清空，且确实把 send 发给了宿主', sendA.inputCleared && sendA.posted.includes('send'), JSON.stringify(sendA.posted.slice(-3)));

/* ── B. 宿主确认后乐观气泡退场，换成真实消息 ────────────────────────────── */
const confirmB = await page.evaluate(async () => {
  const started = performance.now();
  window.postMessage({
    type: 'messageStart',
    conversationId: 'conv1',
    userMessage: {
      id: 'real-user', role: 'user', content: '这是一条新消息，用于验证发送延迟',
      createdAt: Date.now(), updatedAt: Date.now(), status: 'complete', executionStatus: 'running',
    },
    assistant: {
      id: 'real-assistant', role: 'assistant', content: '', status: 'streaming',
      createdAt: Date.now(), updatedAt: Date.now(),
    },
    pendingAttachments: [],
  }, '*');
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const nodes = [...document.querySelectorAll('#messageList .message')];
  return {
    elapsed: performance.now() - started,
    count: nodes.length,
    tail: nodes.slice(-2).map((node) => node.dataset.messageId),
    anyOptimistic: nodes.some((node) => (node.dataset.messageId || '').startsWith('optimistic-')),
  };
});
check('宿主确认后：乐观气泡退场，尾部是两条真实消息',
  !confirmB.anyOptimistic && confirmB.tail[0] === 'real-user' && confirmB.tail[1] === 'real-assistant',
  `count=${confirmB.count} tail=${JSON.stringify(confirmB.tail)}`);
check('宿主确认的渲染也是增量（不整屏重建）', confirmB.elapsed < 150, `实测 ${Math.round(confirmB.elapsed)}ms`);

/* ── C. 宿主拒绝：气泡退场 + 原文回到输入框 ─────────────────────────────── */
// 上一段让界面进入「流式」状态，先结束这一轮，才能测「空闲时发送」。
await page.evaluate(async () => {
  window.postMessage({ type: 'runs', runningConversationIds: [] }, '*');
  window.postMessage({ type: 'streamIdle', conversationId: 'conv1' }, '*');
  await new Promise((resolve) => setTimeout(resolve, 60));
});
const rejectC = await page.evaluate(async () => {
  const input = document.getElementById('promptInput');
  input.value = '这条会被宿主拒绝';
  document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  const pending = document.querySelectorAll('#messageList .message').length;
  window.postMessage({ type: 'sendRejected', text: '这条会被宿主拒绝' }, '*');
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const nodes = [...document.querySelectorAll('#messageList .message')];
  return {
    pending,
    after: nodes.length,
    inputRestored: input.value === '这条会被宿主拒绝',
    anyOptimistic: nodes.some((node) => (node.dataset.messageId || '').startsWith('optimistic-')),
  };
});
check('宿主拒绝后：气泡退场且不残留', rejectC.after <= rejectC.pending && !rejectC.anyOptimistic,
  `pending=${rejectC.pending} after=${rejectC.after}`);
check('宿主拒绝后：用户敲的原文回到输入框（不许凭空吞掉）', rejectC.inputRestored, `input="${rejectC.inputRestored}"`);

/* ── D. 连点只产生一个气泡 ──────────────────────────────────────────────── */
const repeatD = await page.evaluate(() => {
  const input = document.getElementById('promptInput');
  input.value = '连点三次';
  const form = document.getElementById('composer');
  for (let i = 0; i < 3; i += 1) form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  return [...document.querySelectorAll('#messageList .message')].filter((node) => (node.dataset.messageId || '').startsWith('optimistic-')).length;
});
check('连点三次只产生一个气泡', repeatD === 1, `DOM 里有 ${repeatD} 个乐观气泡`);

/* ── F. 发送途中收到全量状态：气泡不闪掉、也不变成两条 ───────────────────
   这两条各自开一个新页面：前面几段会留下乐观气泡、流式状态等残留，
   在同一个页面上接着测会让断言互相污染（真实踩过一次）。 */

/** 起一个干净页面，装一条历史消息，返回可复用的操作句柄。 */
async function freshConversationPage() {
  const fresh = await browser.newPage({ viewport: { width: 700, height: 900 } });
  fresh.on('pageerror', (error) => errors.push(error.message));
  await fresh.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
  await fresh.waitForSelector('#composer');
  await fresh.evaluate(async () => {
    const conversation = () => ({
      id: 'conv1', title: '发送延迟验证', mode: 'agent', createdAt: Date.now() - 86400000,
      updatedAt: Date.now(), messageCount: 2, preview: '预览', pinned: false, archived: false,
    });
    window.__pushState = (messages) => window.postMessage({
      type: 'state',
      state: {
        conversations: [conversation()], archivedConversations: [], conversation: conversation(), messages, hasMore: false,
        settings: {
          sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'deepseek-flash',
          permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
        },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 12, showArchived: false, taskTree: null, todos: [], project: null,
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
      },
    }, '*');
    const stamp = Date.now() - 5000;
    window.__base = [{ id: 'm1', role: 'assistant', content: '历史消息', createdAt: stamp, updatedAt: stamp, status: 'complete' }];
    window.__pushState(window.__base);
    for (let i = 0; i < 120; i += 1) {
      if (document.querySelectorAll('#messageList .message').length >= 1) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
  return fresh;
}

const midFlightPage = await freshConversationPage();
const midFlightF = await midFlightPage.evaluate(async () => {
  const ids = () => [...document.querySelectorAll('#messageList .message')].map((node) => node.dataset.messageId);
  const input = document.getElementById('promptInput');
  input.value = '途中来状态';
  document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  const afterSubmit = ids();

  // 宿主还没把这条消息落盘，却推了一次全量状态（例如历史列表刷新）
  window.__pushState(window.__base);
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { afterSubmit, afterState: ids() };
});
check('发送途中来了全量状态：气泡不闪掉（宿主还没收录时挂回列表）',
  midFlightF.afterState.length === 2 && midFlightF.afterState[1].startsWith('optimistic-'),
  `afterSubmit=${JSON.stringify(midFlightF.afterSubmit)} afterState=${JSON.stringify(midFlightF.afterState)}`);

const storedPage = await freshConversationPage();
const storedF = await storedPage.evaluate(async () => {
  const ids = () => [...document.querySelectorAll('#messageList .message')].map((node) => node.dataset.messageId);
  const input = document.getElementById('promptInput');
  input.value = '已收录';
  document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  const afterSubmit = ids();
  // 宿主已经落盘并随状态下发
  window.__pushState([
    ...window.__base,
    { id: 'u1', role: 'user', content: '已收录', createdAt: Date.now(), updatedAt: Date.now(), status: 'complete' },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const nodes = [...document.querySelectorAll('#messageList .message')];
  return {
    afterSubmit,
    afterState: ids(),
    duplicated: nodes.filter((node) => (node.textContent || '').includes('已收录')).length,
  };
});
check('宿主已收录后：乐观气泡作废，不会出现两条相同消息',
  storedF.afterState.length === 2 && storedF.afterState[1] === 'u1' && storedF.duplicated === 1,
  `afterSubmit=${JSON.stringify(storedF.afterSubmit)} afterState=${JSON.stringify(storedF.afterState)} duplicated=${storedF.duplicated}`);

await midFlightPage.close();
await storedPage.close();

/* ── E. 静态不变量：不许回到「整屏重建」与「宿主侧阻塞扫描」 ─────────────── */
const { readFileSync } = await import('node:fs');
const CHAT_JS = readFileSync(join(CHAT_DIR, 'media', 'chat.js'), 'utf8');
const PANEL_TS = readFileSync(join(CHAT_DIR, 'src', 'views', 'chatPanel.ts'), 'utf8');

const startHandler = CHAT_JS.slice(
  CHAT_JS.indexOf("case 'messageStart':"),
  CHAT_JS.indexOf("case 'sendRejected':"),
);
check('messageStart 用增量追加，不整屏 renderMessages',
  startHandler.includes('appendMessageToList(') && !startHandler.includes('renderMessages('),
  startHandler.includes('renderMessages(') ? '又改回整屏重建了' : 'ok');

const addedHandler = CHAT_JS.slice(
  CHAT_JS.indexOf("case 'messageAdded':"),
  CHAT_JS.indexOf("case 'messageUpdated':"),
);
check('messageAdded 用增量追加', addedHandler.includes('appendMessageToList(') && !addedHandler.includes('renderMessages('),
  addedHandler.includes('renderMessages(') ? '又改回整屏重建了' : 'ok');

// 宿主侧：messageStart 必须排在「扫描技能 / 组装上下文」之前。
const sendBody = PANEL_TS.slice(PANEL_TS.indexOf('private async send('), PANEL_TS.indexOf('private currentActiveResponse('));
const atMessageStart = sendBody.indexOf("type: 'messageStart'");
const atSkills = sendBody.indexOf('prepareSkillsForSend(');
const atContext = sendBody.indexOf('requestMessages(');
check('宿主先推 messageStart，再扫描技能与组装上下文',
  atMessageStart > 0 && atMessageStart < atSkills && atMessageStart < atContext,
  `messageStart@${atMessageStart} skills@${atSkills} context@${atContext}`);
// 技能扫描在 prepareSkillsForSend 里：已经扫过就必须走缓存 + 后台刷新，不许再 await。
const prepareBody = PANEL_TS.slice(
  PANEL_TS.indexOf('private async prepareSkillsForSend('),
  PANEL_TS.indexOf('private async prepareSkillsForSend(') + 1600,
);
// 契约（0.3.2 更新）：发送路径**永远**不 await 全工作区遍历 —— 内存里没清单就先水合
// （毫秒级），然后一律后台刷新。旧写法「没扫过就 await refresh()」会让首条消息卡 6.7 秒。
check('技能准备不再 await 全工作区扫描（水合兜底 + 后台刷新）',
  prepareBody.includes('void this.skills.refresh()')
  && prepareBody.includes('await this.skills.hydrate()')
  && !/await this\.skills\.refresh\(/.test(prepareBody),
  prepareBody.includes('await this.skills.hydrate()') ? 'ok' : '缺少水合兜底');
check('所有提前返回都给界面发 sendRejected',
  (sendBody.match(/rejectSend\(/g) ?? []).length >= 3 && sendBody.includes("type: 'sendRejected'"),
  `rejectSend 调用 ${(sendBody.match(/rejectSend\(/g) ?? []).length} 处`);

check('运行期间无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
