// 「回答形状」的守门人：我的理解（标题块）→ 结果 → 需要你做的，以及整轮一个执行折叠。
//
// 用户原话（2026-11-03）：「HWChat 现在对话显示不方便用户理解，用户输入内容，HWChat 需要
// 先思考理解，然后用简洁的话描述输出对用户消息的理解，然后执行过程只显示任务清单对应的
// 折叠就行，折叠只显示执行了多少命令，修改了多少文件，用户想看具体可以点击折叠展开。」
//
// 三件事：
//  1. 提示词里有「我的理解 / 结果 / 不要复述工具流水账」的硬规则，并且接进了系统提示词；
//  2. 渲染层把**整轮**工具步骤收进一个折叠，summary 只显示命令数与文件数；
//  3. 「我的理解」标题带独立样式；历史消息重新渲染同样生效（渲染层实现，不依赖存盘）。
//
// 运行：node test/check-reply-shape.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHAT_DIR = process.cwd();
const CHAT_JS = readFileSync(join(CHAT_DIR, 'media', 'chat.js'), 'utf8');
const CHAT_CSS = readFileSync(join(CHAT_DIR, 'media', 'chat.css'), 'utf8');
const PANEL = readFileSync(join(CHAT_DIR, 'src', 'views', 'chatPanel.ts'), 'utf8');
const SHAPE = readFileSync(join(CHAT_DIR, 'src', 'agent', 'replyShapePrompt.ts'), 'utf8');
const FOLLOW_UP = readFileSync(join(CHAT_DIR, 'src', 'agent', 'followUpPrompt.ts'), 'utf8');
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* ── 源码契约 ─────────────────────────────────────────────────────────── */

check(
  '提示词：回答必须有「我的理解」标题块',
  /### 我的理解/.test(SHAPE) && /Start every reply/.test(SHAPE),
  '模型不写这一块，用户还是看不到「它懂没懂我说的」',
);
check(
  '提示词：不许复述工具流水账（执行过程由界面折叠）',
  /Do not write an execution log/.test(SHAPE) && /collapses every tool step/.test(SHAPE),
  '模型自己再列一遍步骤，等于把折叠又展开一次',
);
check(
  '提示词：关键路径/命令必须落在结果或待办条目里',
  /Never make the user scroll back/.test(SHAPE) && /repeat the exact path or command/.test(FOLLOW_UP),
  '用户还得往上翻历史找路径',
);
check(
  '提示词：待办每条下面要有「位置 / 预期」，命令用缩进围栏',
  /Under each item, indent two spaces/.test(FOLLOW_UP) && /位置/.test(FOLLOW_UP) && /预期/.test(FOLLOW_UP),
  '条目只有一句「去做吧」，用户不知道在哪做',
);
check(
  '接线：REPLY_SHAPE_PROMPT 进了系统提示词，且排在跟进清单之前',
  /REPLY_SHAPE_PROMPT,/.test(PANEL)
    && PANEL.indexOf('REPLY_SHAPE_PROMPT,') < PANEL.indexOf('FOLLOW_UP_PROMPT,'),
  '形状规则排在长规则后面时，模型常把它当可选项',
);
check(
  '渲染：整轮只有一个执行折叠',
  /function renderExecutionFold\(/.test(CHAT_JS)
    && /body\.append\(renderExecutionFold\(collected\.slice\(\)\)\)/.test(CHAT_JS)
    && !/body\.append\(renderToolExecutions\(/.test(CHAT_JS),
  '正文里逐组插 tool-stack 就是「要在执行日志里翻找」的根源',
);
check(
  '渲染：折叠 summary 只显示命令数与文件数',
  /chat\.executionFold'/.test(CHAT_JS) && /tool\.name === 'run_command'/.test(CHAT_JS) && /changedFiles/.test(CHAT_JS),
  'summary 不含统计，用户必须展开才知道这一轮动了什么',
);
check(
  '渲染：「我的理解」标题有独立样式',
  /is-understanding/.test(CHAT_JS) && /is-understanding/.test(CHAT_CSS),
  '和普通 h3 一样就没有区分度',
);

/* ── 真实浏览器 ───────────────────────────────────────────────────────── */

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
  let browser = null;
  try {
    browser = macExecutable && existsSync(macExecutable)
      ? await launcher.launch({ executablePath: macExecutable, headless: true })
      : await launcher.launch({ channel: process.env.HWCHAT_BROWSER_CHANNEL || 'chrome', headless: true });
  } catch {
    try { browser = await launcher.launch({ channel: 'msedge', headless: true }); } catch { browser = null; }
  }

  if (!browser) {
    console.log('SKIP 浏览器部分：没有可用的 Chromium');
  } else {
    const page = await browser.newPage({ viewport: { width: 720, height: 880 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pathToFileURL(join(CHAT_DIR, 'test', 'preview-chat.html')).href);
    await page.waitForSelector('#composer');

    const flow = await page.evaluate(async () => {
      const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const settle = async (frames = 6) => { for (let i = 0; i < frames; i += 1) await raf(); await sleep(60); };
      const conv = (n) => ({ id: 'c', title: 't', mode: 'agent', createdAt: Date.now(), updatedAt: Date.now(), messageCount: n, preview: 'p', pinned: false, archived: false });
      const settings = { sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false };
      const post = (messages) => window.postMessage({ type: 'state', state: {
        conversations: [conv(messages.length)], archivedConversations: [], conversation: conv(messages.length),
        messages, hasMore: false, settings, skills: [], selectedSkillIds: [], mode: 'agent',
        workspaceTrusted: true, agentAvailable: true, availableToolCount: 1, showArchived: false,
        taskTree: null, todos: [], project: null, modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
      } }, '*');

      const tool = (id, name, extra = {}) => ({
        callId: id, name, summary: `${name} ${id}`, status: 'success',
        startedAt: Date.now(), finishedAt: Date.now(), input: '{"path":"x"}', output: 'ok', ...extra,
      });
      const answer = {
        id: 'a1', role: 'assistant', status: 'complete', createdAt: Date.now(), updatedAt: Date.now(),
        content: [
          '### 我的理解',
          '把「我的壁纸」页的滚动改回正常，并且让标题用新的排版。',
          '',
          '### 结果',
          '页面已改成 `Page` + 内嵌 `ScrollViewer`，编译 0 个错误。',
        ].join('\n'),
        toolExecutions: [
          tool('c1', 'run_command', { changedFiles: [] }),
          tool('c2', 'write_file', { changedFiles: ['Views/Pages/WallpaperListPages.cs'] }),
          tool('c3', 'run_command', { changedFiles: [] }),
        ],
      };
      const plain = { id: 'a2', role: 'assistant', status: 'complete', createdAt: Date.now(), updatedAt: Date.now(), content: '### 我的理解\n只是回答问题。\n\n### 结果\n42。', toolExecutions: [] };
      post([answer, plain]);
      await settle(10);

      const article = document.querySelector('[data-message-id="a1"]');
      const folds = article.querySelectorAll('details.execution-fold');
      const fold = folds[0];
      const summary = fold ? (fold.querySelector('summary')?.textContent || '').trim() : '';
      const stacks = article.querySelectorAll('.tool-stack');
      const steps = fold ? fold.querySelectorAll('details.tool-execution').length : 0;
      const understanding = article.querySelector('h1.is-understanding, h2.is-understanding, h3.is-understanding, h4.is-understanding');
      const understandingFirst = understanding
        ? understanding.closest('.message-content') === article.querySelector('.message-body > .message-content')
        : false;
      const plainArticle = document.querySelector('[data-message-id="a2"]');
      const plainFolds = plainArticle.querySelectorAll('details.execution-fold').length;

      // 历史消息重新渲染：同一份 state 再推一次，形状不变（不依赖存盘字段）
      post([answer, plain]);
      await settle(8);
      const rerendered = document.querySelector('[data-message-id="a1"]');
      const rerenderFolds = rerendered.querySelectorAll('details.execution-fold').length;
      const rerenderSummary = (rerendered.querySelector('details.execution-fold > summary')?.textContent || '').trim();

      return {
        folds: folds.length,
        summary,
        stacks: stacks.length,
        steps,
        understanding: Boolean(understanding),
        understandingFirst,
        plainFolds,
        rerenderFolds,
        rerenderSummary,
      };
    });

    check('整轮只有一个执行折叠', flow.folds === 1, `实际 ${flow.folds} 个`);
    check('折叠 summary 写清命令数与文件数', /2 条命令/.test(flow.summary) && /1 个文件/.test(flow.summary), `实际「${flow.summary}」`);
    check('工具步骤都收在折叠里', flow.stacks === 1 && flow.steps === 3, `tool-stack=${flow.stacks} 步骤=${flow.steps}`);
    check('「我的理解」带独立样式且是正文第一块', flow.understanding && flow.understandingFirst, '没有 is-understanding 或不在第一块');
    check('没有工具的回复不出现折叠', flow.plainFolds === 0, `实际 ${flow.plainFolds} 个`);
    check('历史消息重新渲染后形状不变', flow.rerenderFolds === 1 && /2 条命令/.test(flow.rerenderSummary), `实际 ${flow.rerenderFolds} 个 / 「${flow.rerenderSummary}」`);
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
