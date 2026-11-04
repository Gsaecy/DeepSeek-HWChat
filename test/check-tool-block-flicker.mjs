// 工具步骤（命令窗口）在流式更新时的「闪动」守门人。
//
// 现场（用户 2026-11-04）：「agent 在输出的时候，展开具体命令，命令显示窗口会闪动」。
//
// 成因是两个各自独立的视觉抖动：
//   1. **展开态先空后满**：整条消息重建后，`restoreDetailOverrides()` 才把用户展开的步骤
//      设成 `open`，而正文是惰性建的；给 `<details open>` 赋值的 `toggle` 事件**异步**派发，
//      于是新节点先以「展开但空白」插进 DOM，下一帧内容才出现 —— 闪一下。
//   2. **内部滚动被重置**：命令参数/输出所在的 `pre` 是独立滚动容器，整条替换会把它重置到
//      顶部；用户正读输出中段时，agent 每推一次工具状态画面就跳一下。
//
// 运行：node test/check-tool-block-flicker.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_DIR = process.cwd();
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const CHAT_JS = readFileSync('media/chat.js', 'utf8');

/* ── 静态契约 ──────────────────────────────────────────────────────────── */
check(
  '惰性正文把 build 挂到节点上（供「恢复展开」时同步调用）',
  /details\.__buildDetail = build;/.test(CHAT_JS),
  '没有这个钩子，恢复 open 时正文只能等异步 toggle 才建',
);
check(
  '恢复展开态时**同步**建正文',
  /details\.open = value;\s*\n\s*\/\/[^\n]*\n\s*if \(value\) details\.__buildDetail\?\.\(\);/.test(CHAT_JS),
  '只设 open 不建正文 = 先空白后补内容，就是那一下闪动',
);
check(
  '整条替换前后保留内部 pre 的滚动位置',
  /captureInnerScroll\(current\)/.test(CHAT_JS) && /restoreInnerScroll\(next, innerScrolls\)/.test(CHAT_JS),
  '长命令输出滚动过之后，一次状态更新就跳回顶部',
);
check(
  '数量对不上就放弃还原（不张冠李戴）',
  /nodes\.length !== saved\.length\) return;/.test(CHAT_JS),
);

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
    const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
    await page.waitForSelector('#composer');

    const out = await page.evaluate(async () => {
      const conv = { id: 'c', title: 't', mode: 'agent', createdAt: Date.now() - 9e6, updatedAt: Date.now(), messageCount: 1, preview: 'p', pinned: false, archived: false };
      const tools = () => [{
        callId: 'run-1',
        name: 'run_command',
        summary: '`cargo check --manifest-path src-tauri/Cargo.toml` → 超时（120 秒）',
        status: 'success',
        risk: 'command',
        startedAt: Date.now() - 1500,
        finishedAt: Date.now(),
        input: JSON.stringify({ command: `cd "${'/Users/me/AI projects/Personal Workstation OS'}" && cargo check --manifest-path src-tauri/Cargo.toml` }),
        output: Array.from({ length: 120 }, (_, i) => `line ${i}: checking crate …`).join('\n'),
      }];
      const message = { id: 'm1', role: 'assistant', content: '开始编译。', createdAt: Date.now(), updatedAt: Date.now(), status: 'complete', toolExecutions: tools() };
      window.postMessage({ type: 'state', state: {
        conversations: [conv], archivedConversations: [], conversation: conv, messages: [message], hasMore: false,
        settings: { sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 1, showArchived: false, taskTree: null, todos: [], project: null,
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
      } }, '*');
      for (let i = 0; i < 300; i += 1) {
        if (document.querySelector('#messageList details.tool-execution')) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 120));

      // 用户展开「命令」这一步，并往下滚一段（模拟在输出中段阅读）。
      const details = document.querySelector('#messageList details.tool-execution');
      details.open = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
      // 第一个 pre 是命令参数（短，不滚动），要取真正能滚的那一个（输出）。
      const pre = [...details.querySelectorAll('.tool-detail pre')].find((node) => node.scrollHeight > node.clientHeight);
      pre.scrollTop = 240;
      const before = {
        blocks: details.querySelectorAll('.tool-detail-block').length,
        scrollTop: pre.scrollTop,
        open: details.open,
      };

      // agent 在这一步之后又推了一次工具状态（同一 callId、同一状态、只是时间变了）。
      const updated = { ...tools()[0], summary: '`cargo check …` → 超时（120 秒）· 30.0s' };
      window.postMessage({ type: 'toolExecutions', conversationId: 'c', messageId: 'm1', tools: [updated] }, '*');

      // 只等一个宏任务：新节点插入后**同一帧**就必须已经是完整状态。
      await new Promise((resolve) => setTimeout(resolve, 0));
      const afterNode = document.querySelector('#messageList details.tool-execution');
      const afterPre = [...(afterNode?.querySelectorAll('.tool-detail pre') ?? [])].find((node) => node.scrollHeight > node.clientHeight);
      const sameFrame = {
        exists: Boolean(afterNode),
        open: afterNode?.open === true,
        blocks: afterNode?.querySelectorAll('.tool-detail-block').length ?? 0,
        text: (afterNode?.textContent || '').includes('checking crate'),
        scrollTop: afterPre?.scrollTop ?? -1,
      };
      await new Promise((resolve) => setTimeout(resolve, 150));
      const after = {
        blocks: document.querySelector('#messageList details.tool-execution')?.querySelectorAll('.tool-detail-block').length ?? 0,
        scrollTop: ([...(document.querySelector('#messageList details.tool-execution')?.querySelectorAll('.tool-detail pre') ?? [])]
          .find((node) => node.scrollHeight > node.clientHeight))?.scrollTop ?? -1,
      };
      return { before, sameFrame, after };
    });

    check('展开后正文确实建出来了', out.before.blocks >= 2, JSON.stringify(out.before));
    check('测试前置：确实滚动到了输出中段', out.before.scrollTop > 100, `scrollTop=${out.before.scrollTop}`);
    check('状态更新后这一步仍然展开', out.sameFrame.open === true, JSON.stringify(out.sameFrame));
    check(
      '同一帧内正文已经在（不再「展开但空白」）',
      out.sameFrame.blocks >= 2 && out.sameFrame.text === true,
      JSON.stringify(out.sameFrame),
    );
    check(
      '内部滚动位置被保留（不再跳回顶部）',
      out.after.scrollTop > 100,
      `after=${out.after.scrollTop}（before=${out.before.scrollTop}）`,
    );
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
  console.log('「命令窗口闪动」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('展开的命令步骤在流式更新时不再闪：正文同步就位，内部滚动不跳。');
}
