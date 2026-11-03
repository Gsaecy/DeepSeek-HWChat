// 「任务清单还在不在、做完的清单还能不能变成胶囊」——这条链路的守门人。
//
// 用户问题（2026-11-03）：「顺便检查一下，现在还会不会生成任务清单列表以及执行完的
// 任务清单归档成胶囊」。最近几版改动很大（回答形状改了、工具步骤收进 execution-fold、
// 消息列表窗口化），所以这里把整条链路逐段钉住，而不是靠肉眼点一遍：
//
//   提示词要求写清单 → 模型调用 update_todos → 面板落库并推 todos
//   → 全部完成当场归档（planCompletedList）→ 推 todoArchives
//   → 前端 renderTodoArchives 画胶囊 → 点胶囊展开那份清单
//   → 一轮结束时 planTodoSettlement 兜底（中断 / 未完成另算）
//
// 运行：node test/check-todo-capsule.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_DIR = process.cwd();
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* ── 静态契约：后端链路 ────────────────────────────────────────────────── */
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const TODO_PROMPT = readFileSync('src/agent/todoPrompt.ts', 'utf8');
const ARCHIVES = readFileSync('src/core/todoArchives.ts', 'utf8');
const CHAT_JS = readFileSync('media/chat.js', 'utf8');

check('提示词要求多步任务先写清单',
  /call update_todos with the full plan before doing the work/.test(TODO_PROMPT),
  '不写这条，模型就不会用清单');
check('提示词说明「全绿由界面归档成胶囊」',
  /archives it into the capsule rail/.test(TODO_PROMPT),
  '模型不知道清单会被自动归档时，会自己清空或另起一份');
check('update_todos 作为工具下发给模型',
  /todoToolDefinition\(\)/.test(PANEL) && /call\.function\.name === 'update_todos'/.test(PANEL),
  '工具没下发，清单永远不会出现');
check('全部完成时**当场**归档（不等这轮结束）',
  /planCompletedList\(todos, archives, Date\.now\(\)\)/.test(PANEL)
  && /keepList = !completedPlan/.test(PANEL),
  '等到运行结束才归档时，收尾阶段进程被杀就永远挂着一份「已完成」');
check('归档后推送 todoArchives（前端靠它画胶囊）',
  /type: 'todoArchives'/.test(PANEL) && /todoArchiveViews\(/.test(PANEL),
  '不推这条，胶囊栏永远是空的');
check('一轮结束时还有兜底结算',
  /planTodoSettlement\(/.test(PANEL) && /export function planTodoSettlement/.test(ARCHIVES),
  '模型漏打最后一个勾时，需要它把清单收成 interrupted/incomplete 而不是留在面板上');
check('归档带颜色与计数（前端直接用）',
  /color: archiveColorHex\(archiveColorRatio\(/.test(PANEL) && /completed: completedCount\(/.test(PANEL),
  '');

/* ── 静态契约：前端渲染 ────────────────────────────────────────────────── */
check('前端会创建胶囊节点',
  /capsule\.className = 'todo-capsule'/.test(CHAT_JS) && /capsule\.style\.backgroundColor = archive\.color/.test(CHAT_JS),
  '');
check('胶囊栏在空归档时隐藏',
  /elements\.todoArchiveBar\.hidden = !archives\.length/.test(CHAT_JS),
  '没有归档却显示一条空栏，会让人以为丢了内容');
check('点胶囊展开那份清单',
  /todoPanelState\.nextArchiveFocus\(\{ currentId: state\.expandedArchiveId, clickedId: archive\.id \}\)/.test(CHAT_JS)
  && /renderTodoItems\(elements\.todoArchiveList, archive\.todos\)/.test(CHAT_JS),
  '点了没反应等于归档不可读');

/* ── 真实浏览器：清单 → 胶囊 → 展开 ──────────────────────────────────── */
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
      const settle = async (frames = 5) => {
        for (let i = 0; i < frames; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => setTimeout(resolve, 60));
      };
      const conversation = () => ({
        id: 'conv1', title: '任务清单', mode: 'agent', createdAt: Date.now() - 60000,
        updatedAt: Date.now(), messageCount: 1, preview: '预览', pinned: false, archived: false,
      });
      const push = (extra) => window.postMessage({
        type: 'state',
        state: {
          conversations: [conversation()], archivedConversations: [], conversation: conversation(),
          messages: [{ id: 'm1', role: 'assistant', content: '结果', createdAt: Date.now(), updatedAt: Date.now(), status: 'complete' }],
          hasMore: false,
          settings: {
            sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll',
            agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
          },
          skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
          availableToolCount: 1, showArchived: false, taskTree: null, todos: [], project: null,
          modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
          ...extra,
        },
      }, '*');

      // ① 清单：3 项（1 完成 / 1 进行中 / 1 待办）
      push({ todos: [
        { content: '读取配置', status: 'completed' },
        { content: '改写入口', status: 'in_progress' },
        { content: '跑测试', status: 'pending' },
      ] });
      await settle(6);
      const panel = document.querySelector('#todoPanel');
      const items = [...document.querySelectorAll('#todoList > *')];
      const listState = {
        visible: panel ? !panel.hidden : false,
        count: items.length,
        statuses: items.map((item) => item.querySelector('[class*="status"]')?.className || item.className),
        texts: items.map((item) => item.textContent || ''),
      };

      // ② 胶囊：两份归档
      push({
        todos: [],
        todoArchives: [
          {
            id: 'a1', createdAt: Date.now() - 3600_000, total: 3, completed: 3, color: '#5b8fd6',
            todos: [{ content: '旧一', status: 'completed' }, { content: '旧二', status: 'completed' }, { content: '旧三', status: 'completed' }],
          },
          {
            id: 'a2', createdAt: Date.now() - 60_000, total: 2, completed: 2, color: '#1f4e9c',
            todos: [{ content: '新一', status: 'completed' }, { content: '新二', status: 'completed' }],
          },
        ],
      });
      await settle(6);
      const bar = document.querySelector('#todoArchiveBar');
      const capsules = [...document.querySelectorAll('#todoArchiveBar .todo-capsule')];
      const archiveState = {
        barHidden: bar ? bar.hidden : true,
        count: capsules.length,
        colors: capsules.map((node) => node.style.backgroundColor),
        labels: capsules.map((node) => node.getAttribute('aria-label') || ''),
      };

      // ③ 点第二颗：面板展开那份清单
      capsules[1]?.click();
      await settle(6);
      const archivePanel = document.querySelector('#todoArchivePanel');
      const archived = [...document.querySelectorAll('#todoArchiveList > *')];
      const opened = {
        hidden: archivePanel ? archivePanel.hidden : true,
        open: archivePanel ? archivePanel.open !== false : false,
        count: archived.length,
        texts: archived.map((item) => item.textContent || ''),
        summary: (document.querySelector('#todoArchiveSummary')?.textContent || '').trim(),
        // 展开会重渲染胶囊栏，之前抓到的节点已经不在文档里了 —— 必须重新查。
        activeCapsules: [...document.querySelectorAll('#todoArchiveBar .todo-capsule')]
          .filter((node) => node.classList.contains('active')).length,
      };

      // ④ 再点一次：收起
      // 同样要重新查：上面展开那一步已经把胶囊节点换新了。
      [...document.querySelectorAll('#todoArchiveBar .todo-capsule')][1]?.click();
      await settle(5);
      const closedHidden = document.querySelector('#todoArchivePanel')?.hidden === true;

      // ⑤ 清空归档：整条栏隐藏
      push({ todos: [], todoArchives: [] });
      await settle(5);
      const clearedHidden = document.querySelector('#todoArchiveBar')?.hidden === true;

      return { listState, archiveState, opened, closedHidden, clearedHidden };
    });

    check('清单列表渲染出来了（3 项，状态齐全）',
      out.listState.visible && out.listState.count === 3
      && out.listState.statuses.some((value) => /completed/.test(value))
      && out.listState.statuses.some((value) => /in_progress|progress/.test(value))
      && out.listState.statuses.some((value) => /pending/.test(value)),
      `visible=${out.listState.visible} count=${out.listState.count} statuses=${JSON.stringify(out.listState.statuses)}`);
    check('清单条目的文字来自模型给的内容',
      out.listState.texts.join(' ').includes('读取配置') && out.listState.texts.join(' ').includes('跑测试'),
      JSON.stringify(out.listState.texts).slice(0, 120));

    check('归档变成胶囊（2 颗，栏可见）',
      out.archiveState.barHidden === false && out.archiveState.count === 2,
      `barHidden=${out.archiveState.barHidden} count=${out.archiveState.count}`);
    check('胶囊颜色各不相同（越新越深）',
      out.archiveState.colors[0] !== out.archiveState.colors[1] && out.archiveState.colors.every(Boolean),
      JSON.stringify(out.archiveState.colors));
    check('胶囊带「N/N 完成」的无障碍名称',
      out.archiveState.labels.every((label) => /\d+\s*\/\s*\d+/.test(label)),
      JSON.stringify(out.archiveState.labels));

    check('点胶囊展开那份清单',
      out.opened.hidden === false && out.opened.count === 2
      && out.opened.texts.join(' ').includes('新一') && out.opened.texts.join(' ').includes('新二'),
      `hidden=${out.opened.hidden} count=${out.opened.count} texts=${JSON.stringify(out.opened.texts)}`);
    check('展开的面板带「已归档 · N/N 完成」摘要',
      /归档/.test(out.opened.summary) && /\d+\s*\/\s*\d+/.test(out.opened.summary),
      JSON.stringify(out.opened.summary));
    check('同一时刻只有一颗胶囊是选中态',
      out.opened.activeCapsules === 1, `active=${out.opened.activeCapsules}`);
    check('再点一次收起', out.closedHidden, '收起失败会一直占着输入框上方');
    check('归档清空后整条胶囊栏隐藏', out.clearedHidden, '');
    check('渲染期间无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));

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
