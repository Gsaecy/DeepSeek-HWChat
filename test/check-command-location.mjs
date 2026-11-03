// 「要我执行的命令，到底在本地终端跑还是在服务器上跑」——渲染层的守门人。
//
// 用户原话（2026-11-03）：「需要我执行的命令，代码块要区分是服务器上执行还是本地终端执行，
// 为什么现在不区分本地还是服务器了」。
//
// 复查结论：规则一直在（`src/agent/commandPrompt.ts` 的 `loc=local` / `loc=server`），
// 渲染层也支持（`media/chat.js` 的 `codeBlockNode`）。真正断掉的是**缺标注时的兜底**：
// 模型只写 `tool=bash` 没写 `loc=`，标题栏就只剩「工具：bash」，用户完全看不出该贴哪儿。
// 所以这里守两件事：
//   ① 标注齐全时位置必须显示（本地 / 服务器 / 自定义）；
//   ② **没有标注时必须显式显示「位置：未标注」**，不能静默省略。
//
// 运行：node test/check-command-location.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_DIR = process.cwd();
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* ── 静态契约 ──────────────────────────────────────────────────────────── */
const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_CSS = readFileSync('media/chat.css', 'utf8');
const PROMPT = readFileSync('src/agent/commandPrompt.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

check('提示词里 loc= 是硬要求',
  /Every shell block MUST carry `loc=`/.test(PROMPT),
  '只写「请标注」时模型会漏，必须写成 MUST 并说明代价');
check('提示词保留了本地/服务器/自定义三种取值',
  /loc=local/.test(PROMPT) && /loc=server/.test(PROMPT) && /loc="<short label>"/.test(PROMPT),
  '');
check('缺标注时有兜底文案，不是空着不显示',
  /chat\.runLocationUnknown'/.test(I18N) && /code-chip-location is-unknown/.test(CHAT_JS),
  '静默省略正是用户看到「不区分本地还是服务器」的原因');
check('兜底样式是中性虚线态',
  /\.code-chip-location\.is-unknown\s*\{[^}]*dashed/.test(CHAT_CSS),
  '不能用成功色（会被误读成「已确认是本地」）');

/* ── 真实浏览器渲染 ────────────────────────────────────────────────────── */
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
      const conv = {
        id: 'c', title: 't', mode: 'agent', createdAt: Date.now(), updatedAt: Date.now(),
        messageCount: 1, preview: 'p', pinned: false, archived: false,
      };
      const body = [
        '本地：',
        '',
        '```bash loc=local tool=bash',
        'npm test',
        '```',
        '',
        '服务器：',
        '',
        '```sh loc=server tool=bash',
        'tar xzf /www/x.tgz',
        '```',
        '',
        '没标注位置：',
        '',
        '```bash tool=bash',
        'mkdir -p /www/wwwroot/instindex',
        '```',
        '',
        '自定义位置：',
        '',
        '```bash loc="GitHub Actions runner" tool=bash',
        'npm ci',
        '```',
      ].join('\n');
      window.postMessage({ type: 'state', state: {
        conversations: [conv], archivedConversations: [], conversation: conv,
        messages: [{ id: 'm1', role: 'assistant', content: body, createdAt: Date.now(), updatedAt: Date.now(), status: 'complete' }],
        hasMore: false,
        settings: {
          sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll',
          agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false,
        },
        skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
        availableToolCount: 1, showArchived: false, taskTree: null, todos: [], project: null,
        modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {},
      } }, '*');
      // 只取我们自己那条消息：夹具页面本身就带着示例消息和示例代码块。
      for (let i = 0; i < 300; i += 1) {
        if (document.querySelectorAll('[data-message-id="m1"] .code-block').length >= 4) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return [...document.querySelectorAll('[data-message-id="m1"] .code-block')].map((block) => ({
        location: block.querySelector('.code-chip-location')?.textContent || '',
        unknown: block.querySelector('.code-chip-location')?.classList.contains('is-unknown') === true,
        remote: block.classList.contains('is-remote'),
        tool: block.querySelector('.code-chip-tool')?.textContent || '',
        code: block.querySelector('code')?.textContent || '',
      }));
    });

    check('四条命令块都渲染出来了', out.length === 4, `实际 ${out.length} 条`);
    if (out.length === 4) {
      check('loc=local → 位置显示为本地',
        /本地|local/i.test(out[0].location) && !out[0].unknown && !out[0].remote,
        `chip="${out[0].location}"`);
      check('loc=server → 位置显示为服务器，并带远端样式',
        /服务器|server/i.test(out[1].location) && out[1].remote && !out[1].unknown,
        `chip="${out[1].location}" remote=${out[1].remote}`);
      check('缺少 loc → 明确显示「位置：未标注」',
        /未标注|not specified/i.test(out[2].location) && out[2].unknown,
        `chip="${out[2].location}" unknown=${out[2].unknown}`);
      check('自定义位置原样显示',
        out[3].location.includes('GitHub Actions runner'),
        `chip="${out[3].location}"`);
      check('工具标注一直都在',
        out.every((block) => /bash/.test(block.tool)),
        out.map((block) => block.tool).join(' | '));
      check('复制出来的命令不含标注', out[2].code.trim() === 'mkdir -p /www/wwwroot/instindex', JSON.stringify(out[2].code));
    }
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
