// 流式输出期间「往上翻历史」的守门人。
//
// 用户原话（2026-11-03）：「HWChat 对话框，在 agent 正在输出的时候，对话框里的对话消息会闪动、
// 往上翻页也会闪动退回一点，没法一直往上翻对话历史记录」。
//
// 实测（headless Chrome + 真实 media/chat.js，120 条消息、每帧上滚 10px、同时每帧一个 delta）：
//   · 修复前：`#messageList` 整窗 replaceChildren **54 次 / 1.5 秒**（每 4 帧砸掉重建一屏），
//     锚点消息单帧最大位移 **23px**（滚动本身只有 10px，多出来的 13px 就是「退回一点」）。
//   · 修复后：整窗重建 **2 次**，单帧最大位移 **11px**（≈ 滚动步长），不再有视觉抖动。
//
// 三个真实缺陷：
//  1. `ensureWindowCoversViewport()` 的空洞判定写成「第一条的底部在视口上方」——
//     上下 overscan 一存在就永远为真，于是每次滚动都判定「有空洞」并整窗重建。
//  2. 顶部占位块高度随行高测量变化时没有补偿 scrollTop，视口内容整体位移。
//  3. `measureVirtualHeights()` 每次重建都把估算值向当前窗口均值折中一次，
//     窗口里消息配比一变估算值就漂，所有未测量行的高度跟着抖（放大了 1 和 2）。
//
// 运行：node test/check-stream-scroll.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHAT_DIR = process.cwd();
const CHAT_JS = readFileSync(join(CHAT_DIR, 'media', 'chat.js'), 'utf8');
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* ── 源码契约（不依赖浏览器）──────────────────────────────────────────── */

/** 取出某个函数体的源码，供「不许写回去」的断言使用。 */
function functionSource(name) {
  const start = CHAT_JS.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const open = CHAT_JS.indexOf('{', CHAT_JS.indexOf(')', start));
  let depth = 0;
  for (let index = open; index < CHAT_JS.length; index += 1) {
    if (CHAT_JS[index] === '{') depth += 1;
    else if (CHAT_JS[index] === '}') {
      depth -= 1;
      if (depth === 0) return CHAT_JS.slice(start, index + 1);
    }
  }
  return '';
}

const covers = functionSource('ensureWindowCoversViewport');
check(
  '空洞判定：只有整窗跑到视口外才算空洞',
  /gapTop = lastRect\.bottom < viewportRect\.top/.test(covers)
    && /gapBottom = firstRect\.top > viewportRect\.bottom/.test(covers),
  '写成 firstRect.bottom / lastRect.top 时，overscan 存在就永远判定有空洞 → 每次滚动整窗重建',
);
check(
  '换窗后按锚点复位',
  /buildMessageWindow\(target\.start, target\.end\);[\s\S]{0,120}restoreScrollAnchor\(anchor\)/.test(covers),
  '换窗不复位 = 测量一收敛画面就挪一下',
);

const spacers = functionSource('syncVirtualSpacers');
check(
  '顶部占位块变化时补偿 scrollTop',
  /previousTopHeight/.test(spacers) && /viewport\.scrollTop = /.test(spacers) && /nextTopHeight - previousTopHeight/.test(spacers),
  'overflow-anchor: none 之下，占位块一变内容就整体位移，必须手工补回来',
);

const measure = functionSource('measureVirtualHeights');
check(
  '估算值不再每次重建都折中一次',
  /ESTIMATE_REBASE_RATIO/.test(measure) && !/\(virtualList\.estimate \+ average\) \/ 2/.test(measure),
  '每窗取平均会把「这一窗的消息配比」当成整体规律，估算值一直漂',
);
check(
  '全量状态不再整份覆盖流式中的正文',
  /function mergeIncomingMessages\(/.test(CHAT_JS)
    && /incoming\.messagesUnchanged !== true\) state\.messages = mergeIncomingMessages\(/.test(CHAT_JS),
  '直接赋值 incoming.messages 会把存档里更旧的正文换回来（实测 90→65 字符的回缩）',
);

/* ── 真实浏览器行为 ────────────────────────────────────────────────────── */

const PW_ROOTS = [
  join(CHAT_DIR, 'node_modules', 'playwright'),
  join(CHAT_DIR, 'node_modules', 'playwright-core'),
  join(homedir(), 'AI projects', 'Safevault_windows', 'node_modules', 'playwright'),
];
const pwRoot = PW_ROOTS.find((candidate) => existsSync(join(candidate, 'package.json')));
const cacheRoot = join(homedir(), 'Library/Caches/ms-playwright');
const macShell = existsSync(cacheRoot)
  ? (readdirSync(cacheRoot).filter((name) => name.startsWith('chromium_headless_shell')).sort().pop() ?? null)
  : null;
const macExecutable = macShell ? join(cacheRoot, macShell, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell') : null;

if (!pwRoot) {
  console.log('SKIP 浏览器部分：找不到 playwright / playwright-core');
} else {
  const { chromium: launcher } = await import(pathToFileURL(join(pwRoot, 'index.mjs')).href);
  const launchOptions = macExecutable && existsSync(macExecutable)
    ? { executablePath: macExecutable }
    : { channel: process.env.HWCHAT_BROWSER_CHANNEL || 'chrome' };
  let browser = null;
  try {
    browser = await launcher.launch({ ...launchOptions, headless: true });
  } catch {
    try {
      browser = await launcher.launch({ channel: 'msedge', headless: true });
    } catch {
      browser = null;
    }
  }

  if (!browser) {
    console.log('SKIP 浏览器部分：没有可用的 Chromium（装 playwright 或本地 Chrome/Edge）');
  } else {
    const page = await browser.newPage({ viewport: { width: 720, height: 880 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pathToFileURL(join(CHAT_DIR, 'test', 'preview-chat.html')).href);
    await page.waitForSelector('#composer');

    const flow = await page.evaluate(async () => {
      const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const settle = async (frames = 6) => {
        for (let i = 0; i < frames; i += 1) await raf();
        await sleep(60);
      };
      const conv = (n) => ({
        id: 'c', title: 't', mode: 'agent', createdAt: Date.now() - 9e6, updatedAt: Date.now(),
        messageCount: n, preview: 'p', pinned: false, archived: false,
      });
      const makeMessages = (count) => Array.from({ length: count }, (_, i) => ({
        id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 条。`.repeat(25),
        createdAt: Date.now(), updatedAt: Date.now(), status: 'complete', toolExecutions: [],
      }));
      const settings = {
        sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll',
        agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
      };
      const post = (messages, extra = {}) => window.postMessage({ type: 'state', state: {
        conversations: [conv(messages.length)], archivedConversations: [], conversation: conv(messages.length),
        messages, hasMore: false, settings, skills: [], selectedSkillIds: [], mode: 'agent',
        workspaceTrusted: true, agentAvailable: true, availableToolCount: 1, showArchived: false,
        taskTree: null, todos: [], project: null, modelOptionsByProfile: {}, quickLaunchInstalled: true,
        fileRoots: {}, ...extra,
      } }, '*');
      const viewport = document.querySelector('#messageViewport');
      const list = document.querySelector('#messageList');
      const articles = () => [...list.children].filter((node) => node.dataset.messageId);
      const covered = () => {
        const viewportRect = viewport.getBoundingClientRect();
        const nodes = articles();
        if (!nodes.length) return false;
        const first = nodes[0].getBoundingClientRect();
        const last = nodes[nodes.length - 1].getBoundingClientRect();
        return first.top <= viewportRect.top + 1 && last.bottom >= viewportRect.bottom - 1;
      };
      const atBottom = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2;

      /**
       * 场景：滚到中间，然后「每帧上滚 step 像素 + 每帧一个流式 delta」，量三件事。
       *  · rebuilds：整窗 replaceChildren 次数（闪动的直接证据）
       *  · maxDrift：同一条消息相邻两帧的位移减去滚动步长（视觉抖动的直接证据）
       *  · backwards：scrollTop 反向跳的次数（「退回一点」的直接证据）
       */
      const measureScroll = async (count, { step = 10, frames = 130, tools = false } = {}) => {
        const messages = makeMessages(count);
        messages[count - 1] = {
          ...messages[count - 1], id: 'streaming', role: 'assistant', status: 'streaming', content: 'start',
        };
        post(messages);
        await settle(10);
        viewport.scrollTop = Math.round(viewport.scrollHeight * 0.42);
        await settle(8);

        const firstIndex = Number(articles()[0]?.dataset.messageIndex || 0);
        const anchorId = `m${firstIndex + 2}`;
        let rebuilds = 0;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if ([...record.removedNodes].filter((node) => node.nodeType === 1).length > 3) rebuilds += 1;
          }
        });
        observer.observe(list, { childList: true });

        const trace = [];
        let sampling = true;
        const loop = (async () => {
          while (sampling) {
            const node = list.querySelector(`[data-message-id="${anchorId}"]`);
            trace.push({
              top: node ? Math.round(node.getBoundingClientRect().top) : null,
              scrollTop: Math.round(viewport.scrollTop),
            });
            await raf();
          }
        })();
        for (let tick = 0; tick < frames; tick += 1) {
          window.postMessage({ type: 'streamDelta', conversationId: 'c', messageId: 'streaming', content: `片${tick} `.repeat(6) }, '*');
          if (tools && tick % 4 === 0) {
            const target = messages.find((message) => message.id === 'streaming');
            target.toolExecutions = [...(target.toolExecutions || []), {
              callId: `t${tick}`, name: 'run_command', summary: `cmd ${tick}`,
              status: tick % 8 ? 'running' : 'success', startedAt: Date.now(),
              input: '{"command":"x"}', output: tick % 8 ? '' : 'ok\n',
            }];
            window.postMessage({ type: 'toolExecutions', conversationId: 'c', messageId: 'streaming', tools: target.toolExecutions }, '*');
          }
          viewport.scrollTop = Math.max(0, viewport.scrollTop - step);
          await raf();
        }
        sampling = false;
        await loop;
        observer.disconnect();

        let maxDrift = 0;
        let backwards = 0;
        let measuredFrames = 0;
        for (let i = 1; i < trace.length; i += 1) {
          const previous = trace[i - 1];
          const current = trace[i];
          if (current.scrollTop > previous.scrollTop + 2) backwards += 1;
          /*
           * 只比较「用户确实上滚了一个 step」的相邻帧：滚动停下来的那几帧内容当然不动，
           * 拿它们算位移差会把正常静止当成抖动。用视口坐标的位移减去滚动量，
           * 剩下的才是内容自己挪动的距离。
           */
          if (previous.scrollTop - current.scrollTop === step && previous.top !== null && current.top !== null) {
            measuredFrames += 1;
            maxDrift = Math.max(maxDrift, Math.abs((current.top - previous.top) - step));
          }
        }
        const coveredWhileScrolling = covered();
        return {
          rebuilds, maxDrift, backwards, measuredFrames, coveredWhileScrolling,
          virtual: Boolean(list.querySelector('.message-spacer')),
        };
      };

      const big = await measureScroll(120);
      const small = await measureScroll(30, { tools: true });

      // 跳跃滚动（拖滚动条 / Ctrl+End）之后视口不能留空白
      const jumps = [];
      for (const ratio of [0.05, 0.5, 0.95]) {
        viewport.scrollTop = Math.round((viewport.scrollHeight - viewport.clientHeight) * ratio);
        await settle(8);
        jumps.push(covered());
      }

      // 贴底状态下流式输出仍然要跟着到底
      const tailMessages = makeMessages(20);
      tailMessages[19] = { ...tailMessages[19], id: 'streaming', role: 'assistant', status: 'streaming', content: 'start' };
      post(tailMessages);
      await settle(10);
      viewport.scrollTop = viewport.scrollHeight;
      await settle(4);
      for (let tick = 0; tick < 12; tick += 1) {
        window.postMessage({ type: 'streamDelta', conversationId: 'c', messageId: 'streaming', content: 'more text '.repeat(20) }, '*');
        await settle(2);
      }
      await settle(6);
      const followsBottom = atBottom();

      /*
       * 宿主推全量状态时，正文不能比本地流式的更旧就整份替换回去 ——
       * 实测修复前正文长度 90 → 65 再涨回来（气泡里的字往回缩一下）。
       */
      const flicker = makeMessages(8);
      flicker.push({ id: 'live', role: 'assistant', content: 'start', createdAt: Date.now(), updatedAt: Date.now(), status: 'streaming', toolExecutions: [] });
      const pushLagging = (content) => window.postMessage({ type: 'state', state: {
        conversations: [conv(9)], archivedConversations: [], conversation: conv(9),
        messages: [...flicker.slice(0, -1), { ...flicker[flicker.length - 1], content, updatedAt: Date.now() }],
        hasMore: false, settings, skills: [], selectedSkillIds: [], mode: 'agent',
        workspaceTrusted: true, agentAvailable: true, availableToolCount: 1, showArchived: false,
        taskTree: null, todos: [], project: null, modelOptionsByProfile: {}, quickLaunchInstalled: true,
        fileRoots: {},
      } }, '*');
      pushLagging('start');
      await settle(8);
      let live = 'start';
      const lengths = [];
      for (let i = 0; i < 30; i += 1) {
        const chunk = `片${i} `.repeat(6);
        live += chunk;
        window.postMessage({ type: 'streamDelta', conversationId: 'c', messageId: 'live', content: chunk }, '*');
        // 宿主每 6 个 delta 推一次状态，存档里的正文落后 60 个字符（落盘有延迟）
        if (i % 6 === 5) pushLagging(live.slice(0, Math.max(0, live.length - 60)));
        await settle(1);
        lengths.push(document.querySelector('[data-message-id="live"]')?.textContent?.length ?? -1);
      }
      await settle(4);
      let shrinks = 0;
      let biggestShrink = 0;
      for (let i = 1; i < lengths.length; i += 1) {
        const delta = lengths[i] - lengths[i - 1];
        if (delta < 0) { shrinks += 1; biggestShrink = Math.min(biggestShrink, delta); }
      }

      return { big, small, jumps, followsBottom, shrinks, biggestShrink };
    });

    check(
      '往上翻历史时不再整窗重建（120 条，1.5 秒）',
      flow.big.rebuilds <= 4,
      `整窗重建 ${flow.big.rebuilds} 次（修复前实测 54 次）`,
    );
    check(
      '往上翻历史时画面不抖（120 条，每帧上滚 10px）',
      flow.big.maxDrift <= 3,
      `单帧多出来的位移 ${flow.big.maxDrift}px（修复前 13px）`,
    );
    check(
      '往上翻历史时 scrollTop 不被拽回（120 条）',
      flow.big.backwards <= 3,
      `反向跳 ${flow.big.backwards} 次`,
    );
    check('滚动期间视口不留空白（120 条）', flow.big.coveredWhileScrolling, '视口上下必须都被消息盖住');
    check(
      '少于阈值时（30 条 + 工具流）同样不重建、不抖动',
      flow.small.rebuilds === 0 && flow.small.maxDrift <= 3,
      `重建 ${flow.small.rebuilds} 次、抖动 ${flow.small.maxDrift}px`,
    );
    check('跳跃滚动后视口仍被盖住（5% / 50% / 95%）', flow.jumps.every(Boolean), JSON.stringify(flow.jumps));
    check('贴底时流式输出仍然跟着到底', flow.followsBottom, '用户没离开底部时不该停止跟随');
    check(
      '宿主推旧的全量状态时，流式正文不被抹回去',
      flow.shrinks === 0,
      `正文缩短 ${flow.shrinks} 次（最大 ${flow.biggestShrink} 字符）—— 修复前实测 90→65`,
    );
    check('全流程无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));

    await page.close();
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
