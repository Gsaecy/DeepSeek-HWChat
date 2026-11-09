/*
 * 对话长度进度条 + 「在新对话继续」按钮。
 *
 * 用户要求（2026-11-09）：「做一个对话长度进度和对话超过长度后显示提醒按钮：在新对话继续。
 * 点击后自动引用当前对话，但是从新窗口开始对话（相当于用新开窗口方式压缩对话）」。
 *
 * 这条链路必须真的通到 `continueFromConversation`（新对话 + 引用当前摘要），
 * 而不是只发一个没人处理的 postMessage —— 所以这里既查静态接线，也在真实
 * Chromium 里点一次按钮，确认宿主收到的是 `continueInNewChat`。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_DIR = process.cwd();
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const JS = readFileSync('media/chat.js', 'utf8');
const CSS = readFileSync('media/chat.css', 'utf8');
const VALIDATOR = readFileSync('src/core/incomingMessage.ts', 'utf8');

/* ── 静态接线 ─────────────────────────────────────────────────────────── */
assert.match(PANEL, /id="contextGauge"/, '面板必须渲染进度条容器');
assert.match(PANEL, /contextLoad: contextLoad\(/, '状态里必须带上 contextLoad');
assert.match(PANEL, /case 'continueInNewChat':/, '宿主必须处理这个按钮');
assert.match(PANEL, /await this\.continueFromConversation\(this\.activeConversationId\)/, '按钮必须复用「新对话 + 引用当前摘要」那条现成链路');
assert.match(VALIDATOR, /continueInNewChat: \{\}/, '入站消息校验表必须登记它（否则会被当成未知消息丢掉）');
assert.match(JS, /elements\.contextGaugeAction\.addEventListener\('click', \(\) => post\('continueInNewChat'\)\)/, '按钮必须真的发消息');
assert.match(JS, /elements\.contextGaugeAction\.hidden = load\.level !== 'over'/, '只有超长时才显示按钮');
assert.match(CSS, /\.context-gauge\.level-over \.context-gauge-fill/, '超长时进度条要有明显区分');

/* ── 真实浏览器 ───────────────────────────────────────────────────────── */
const playwrightRoot = [
  join(CHAT_DIR, 'node_modules', 'playwright'),
  join(homedir(), 'AI projects', 'Safevault_windows', 'node_modules', 'playwright'),
].find((candidate) => existsSync(join(candidate, 'package.json')));
const cacheRoot = join(homedir(), 'Library/Caches/ms-playwright');
const chromiumDir = existsSync(cacheRoot)
  ? (readdirSync(cacheRoot).filter((name) => name.startsWith('chromium_headless_shell')).sort().pop() ?? null)
  : null;
if (!playwrightRoot || !chromiumDir) {
  console.log('SKIP 真实浏览器部分：找不到 playwright 或 chromium');
  process.exit(0);
}
const { chromium: launcher } = await import(join(playwrightRoot, 'index.mjs'));
const executablePath = join(cacheRoot, chromiumDir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
if (!existsSync(executablePath)) {
  console.log('SKIP 真实浏览器部分：chromium 执行文件不在预期路径');
  process.exit(0);
}

const browser = await launcher.launch({ executablePath });
try {
  for (const [label, load, expectAction] of [
    ['正常', { tokens: 12_000, budget: 128_000, percent: 9, level: 'ok' }, false],
    ['该提醒', { tokens: 100_000, budget: 128_000, percent: 78, level: 'warn' }, false],
    ['超长', { tokens: 190_000, budget: 128_000, percent: 148, level: 'over' }, true],
  ]) {
    const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
    await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
    await page.waitForSelector('#composer');
    const now = Date.now();
    const conversation = { id: 'c1', title: 't', mode: 'agent', createdAt: now, updatedAt: now, messageCount: 1, preview: 'x', pinned: false, archived: false };
    const state = {
      conversations: [conversation], archivedConversations: [],
      settings: { sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false },
      skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
      availableToolCount: 0, showArchived: false, todos: [], modelOptionsByProfile: {}, quickLaunchInstalled: true,
      fileRoots: {}, pendingAttachments: [], hasMore: false, conversation, taskTree: null,
      messages: [{ id: 'm1', role: 'assistant', content: 'hi', createdAt: now, updatedAt: now, status: 'complete', model: 'm', toolExecutions: [] }],
      contextLoad: load,
    };
    const push = async () => page.evaluate((payload) => { window.postMessage({ type: 'state', state: payload }, '*'); }, state);
    await push();
    await page.waitForTimeout(300);
    await push();
    await page.waitForTimeout(200);

    const seen = await page.evaluate(() => ({
      gaugeHidden: document.getElementById('contextGauge').hidden,
      actionHidden: document.getElementById('contextGaugeAction').hidden,
      className: document.getElementById('contextGauge').className,
      label: document.getElementById('contextGaugeLabel').textContent,
      fillWidth: document.getElementById('contextGaugeFill').style.width,
    }));

    assert.equal(seen.gaugeHidden, false, `${label}：进度条应当可见`);
    assert.equal(seen.actionHidden, !expectAction, `${label}：按钮显示状态不对`);
    assert.match(seen.className, new RegExp(`level-${load.level}$`), `${label}：档位 class 不对（${seen.className}）`);
    assert.match(seen.label, /\d+%/, `${label}：标签里应当有百分比（${seen.label}）`);
    // 进度条宽度画到 100% 就够（percent 可以超过 100，但条不能溢出）。
    const width = Number(seen.fillWidth.replace('%', ''));
    assert.ok(width > 0 && width <= 100, `${label}：进度宽度应在 (0,100]，实际 ${seen.fillWidth}`);

    if (expectAction) {
      await page.evaluate(() => { window.__hwchatMessages.length = 0; });
      await page.click('#contextGaugeAction');
      await page.waitForTimeout(60);
      const posted = await page.evaluate(() => window.__hwchatMessages.map((message) => message.type));
      assert.ok(posted.includes('continueInNewChat'), `点击按钮必须发出 continueInNewChat，实际 ${JSON.stringify(posted)}`);
    }
    console.log(`✓ ${label}：标签「${seen.label}」，宽度 ${seen.fillWidth}，按钮${expectAction ? '出现并已点击' : '隐藏'}`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log('\n对话长度进度检查通过：三档显示正确，超长时按钮出现，点击会发出 continueInNewChat。');
