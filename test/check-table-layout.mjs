/*
 * 表格排版守护：一列不许被压成「一个字一行」。
 *
 * 现场（用户 2026-11-09 截图）：一张四列表格里有一颗文件引用胶囊，扩展把它核实成
 * Windows 工作区里的**绝对路径**（跨根，没有相对写法），而 `.file-ref` 的标签是
 * `white-space: nowrap` —— 这颗胶囊的最小宽度就是整条路径（实测 676px）。自动表格
 * 布局先取各列最小宽度再分配，于是：
 *
 *   列宽 33 / 33 / 697 / 33 px（视口 683），行高 515px 与 422px；
 *   前三列全是中文（最小宽度 = 一个字），第四列被推出面板之外。
 *
 * 修法两条：
 *   1. `chat.js` 的 `fileReferenceLabel`：表格单元格里的胶囊只写**文件名**
 *      （完整路径仍在 title 上，点开直达）；
 *   2. `chat.css` 兜底：单元格里的胶囊限宽 20em，防文件名本身过长。
 * 正文里的引用保持原样（仍显示完整路径）。
 *
 * 为什么不用 CSS `direction: rtl` 做「左侧省略」：POSIX 绝对路径以 `/` 开头，
 * 这个中性字符在 RTL 段落里会跑到**末尾**，`/Users/x/README.md` 被画成
 * `…/README.md/`（看起来像目录）。这条是实测出来的，不是推测。
 *
 * 运行：node test/check-table-layout.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_DIR = process.cwd();
const CSS = readFileSync('media/chat.css', 'utf8');
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const JS = readFileSync('media/chat.js', 'utf8');

/**
 * 取某条规则的声明块。
 *
 * 必须按行首锚定：`indexOf('.file-ref {')` 会先命中
 * `.message-content td .file-ref { … }`（它排在前面），于是「正文里的引用没有限宽」
 * 这条断言会去检查表格那条规则 —— 测试自己先撒了谎。
 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)[ \\t]*${escaped} \\{`).exec(CODE);
  assert.ok(match, `chat.css 里找不到 ${selector} 的规则（需要行首是这条选择器的独立规则）`);
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
  return CODE.slice(start, CODE.indexOf('}', start));
}

/* ── 静态契约 ─────────────────────────────────────────────────────────── */
assert.match(
  ruleBody('.message-content td .file-ref'),
  /max-width:\s*20em/,
  '表格单元格里的文件引用必须限宽（20em）。不限宽时它的最小宽度等于整段标签，'
  + '会把中文列压成一字一行（真实故障：行高 515px、第四列推出面板外）。',
);
assert.match(
  ruleBody('.file-ref'),
  /max-width:\s*100%/,
  '正文里的引用必须是 max-width: 100% —— 它按设计显示完整路径，不能被压窄。',
);
assert.doesNotMatch(CODE, /\.message-content (?:th|td) \.file-ref-label[^{]*\{[^}]*direction:\s*rtl/, '不要用 rtl 做左侧省略（见文件头说明）');
assert.match(
  ruleBody('.message-content .table-wrap'),
  /overflow-x:/,
  '表格比容器宽时必须能横向滚动，否则右边的列永远看不到（`.message-viewport` 是 overflow-x: hidden）。',
);
assert.match(JS, /appendInline\(td, cells\[column\] \|\| '', \{ dense: true \}\)/, '表格单元格必须走 dense 分支');
assert.match(JS, /dense: Boolean\(options\.dense\)/, 'dense 必须记在 entry 上，核实回来后重画也保持一致');
assert.match(
  JS,
  /if \(entry\.dense\) \{[\s\S]{0,300}?\.split\([^)]*\)[\s\S]{0,120}?\.pop\(\)/,
  'dense 分支必须把标签收成文件名（只取最后一段）',
);

/* ── 真实浏览器：量像素 ───────────────────────────────────────────────── */
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
  console.log('SKIP 真实浏览器部分：chromium 可执行文件不在预期路径');
  process.exit(0);
}

const LONG_PATH = 'D:/Users/guohongyu/AI projects/Safevault_windows/src/app/components/shared/vaultInitializationPolicy.ts';
const TABLE = [
  '| 优先级 | macOS 缺 | Windows 实现 | 缺了会怎样 |',
  '|---|---|---|---|',
  `| **P0** | 云端「可疑空快照」防护 | \`${LONG_PATH}\` 51 行 | macOS 命中 **0**：服务器回空快照可能被当真相覆盖本地库 |`,
  `| **P0** | 初始化防误写 | \`${LONG_PATH}:30\` 30 行 | 首次启动/异常恢复可能写示例数据或覆盖已有库 |`,
  '| P1 | 应用内下载安装更新 | `UpdateService` + `run_installer` | 只能提示后跳官网手动下 DMG |',
].join('\n');

/*
 * 裸路径（没有反引号）走的是 appendPlainText 那条路：同一颗单元格也必须收成文件名。
 * 注意正文里的裸路径扫描在**空白**处断开，所以这里用一条不含空格的路径
 * （含空格的裸路径根本不会被认成引用，会当普通文字换行，不存在这个排版问题）。
 */
const BARE_PATH = 'D:/Users/guohongyu/projects/Safevault_windows/vaultInitializationPolicy.ts';
const BARE_TABLE = [
  '| 位置 | 说明 |',
  '|---|---|',
  `| ${BARE_PATH} | 裸写的绝对路径 |`,
].join('\n');

const browser = await launcher.launch({ executablePath });
try {
  for (const width of [683, 420, 900]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
    await page.waitForSelector('#composer');
    const now = Date.now();
    const conversation = { id: 'c1', title: 't', mode: 'agent', createdAt: now, updatedAt: now, messageCount: 2, preview: 'x', pinned: false, archived: false };
    const state = {
      conversations: [conversation], archivedConversations: [],
      settings: { sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false },
      skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
      availableToolCount: 128, showArchived: false, todos: [], modelOptionsByProfile: {}, quickLaunchInstalled: true,
      fileRoots: { Safevault_windows: 'D:/Users/guohongyu/AI projects/Safevault_windows' },
      pendingAttachments: [], hasMore: false, conversation, taskTree: null,
      messages: [
        // 对照组必须在同一条消息里：分两条时第二条会被预览页自己的示例内容顶掉。
        {
          id: 'm1',
          role: 'assistant',
          content: `见 \`${LONG_PATH}\` 这一处。\n\n${TABLE}\n\n${BARE_TABLE}`,
          createdAt: now,
          updatedAt: now,
          status: 'complete',
          model: 'm',
          toolExecutions: [],
        },
      ],
    };
    const push = async () => page.evaluate((payload) => { window.postMessage({ type: 'state', state: payload }, '*'); }, state);
    await push();
    await page.waitForTimeout(400);
    await push();
    await page.waitForTimeout(400);

    const measured = await page.evaluate(() => {
      const table = document.querySelector('#messageList table');
      const wrap = table?.parentElement;
      const cellChip = table?.querySelector('.file-ref');
      const cellLabel = cellChip?.querySelector('.file-ref-label');
      const bareChip = table?.parentElement?.nextElementSibling?.querySelector?.('.file-ref')
        ?? [...document.querySelectorAll('#messageList .table-wrap')][1]?.querySelector('.file-ref');
      const plainChip = [...document.querySelectorAll('#messageList .file-ref')].find((node) => !node.closest('table'));
      const plainLabel = plainChip?.querySelector('.file-ref-label');
      return {
        columns: [...(table?.querySelectorAll('thead th') ?? [])].map((th) => Math.round(th.getBoundingClientRect().width)),
        rows: [...(table?.querySelectorAll('tbody tr') ?? [])].map((tr) => Math.round(tr.getBoundingClientRect().height)),
        wrapOverflowX: wrap ? getComputedStyle(wrap).overflowX : '',
        cellChipWidth: cellChip ? Math.round(cellChip.getBoundingClientRect().width) : 0,
        cellChipMaxWidth: cellChip ? getComputedStyle(cellChip).maxWidth : '',
        cellLabelText: cellLabel?.textContent ?? '',
        cellLabelTruncated: cellLabel ? cellLabel.scrollWidth > cellLabel.clientWidth + 1 : false,
        cellLabelDirection: cellLabel ? getComputedStyle(cellLabel).direction : '',
        bareLabelText: bareChip?.querySelector('.file-ref-label')?.textContent ?? '',
        bareChipWidth: bareChip ? Math.round(bareChip.getBoundingClientRect().width) : 0,
        plainLabelText: plainLabel?.textContent ?? '',
        plainChipMaxWidth: plainChip ? getComputedStyle(plainChip).maxWidth : '',
      };
    });

    const at = `视口 ${width}px`;
    assert.equal(measured.columns.length, 4, `${at}：表头应有 4 列，实际 ${measured.columns.length}`);
    for (const [index, column] of measured.columns.entries()) {
      assert.ok(column >= 30, `${at}：第 ${index + 1} 列只有 ${column}px —— 中文被压成「一个字一行」了（故障现场是 33px）`);
    }
    for (const [index, row] of measured.rows.entries()) {
      assert.ok(row <= 160, `${at}：第 ${index + 1} 行高 ${row}px —— 列被压窄后整行被撑高（故障现场是 515px / 422px）`);
    }
    assert.equal(measured.wrapOverflowX, 'auto', `${at}：表格容器必须允许横向滚动`);
    assert.ok(measured.cellChipWidth > 0 && measured.cellChipWidth <= 210, `${at}：胶囊宽 ${measured.cellChipWidth}px，应在 20em（≈210px）以内`);
    assert.equal(measured.cellChipMaxWidth, '210px', `${at}：表格里的胶囊 max-width 应是 20em（子元素字号 10.5px → 210px），实际 ${measured.cellChipMaxWidth}`);
    // 只写文件名：不能出现目录分隔符，也不该被截断（这正是「报错时看不出是哪个文件」的反面）。
    assert.equal(measured.cellLabelText, 'vaultInitializationPolicy.ts', `${at}：表格里的标签应只剩文件名，实际「${measured.cellLabelText}」`);
    assert.equal(measured.cellLabelTruncated, false, `${at}：常见长度的文件名不该被截断`);
    assert.equal(measured.cellLabelDirection, 'ltr', `${at}：不要用 rtl 做省略（POSIX 路径开头的 / 会跑到末尾）`);
    // 裸路径（appendPlainText 那条路）在单元格里同样只写文件名。
    assert.equal(measured.bareLabelText, 'vaultInitializationPolicy.ts', `${at}：裸路径的单元格标签也应只剩文件名，实际「${measured.bareLabelText}」`);
    assert.ok(measured.bareChipWidth > 0 && measured.bareChipWidth <= 260, `${at}：裸路径胶囊宽 ${measured.bareChipWidth}px，不该独占整列`);
    // 对照组：正文里的同一颗引用仍然显示完整绝对路径。
    assert.equal(measured.plainLabelText, LONG_PATH, `${at}：正文里的引用必须仍显示完整路径，实际「${measured.plainLabelText}」`);
    assert.equal(measured.plainChipMaxWidth, '100%', `${at}：正文里的引用不该被压窄，实际 max-width=${measured.plainChipMaxWidth}`);

    console.log(`✓ ${at}：列宽 ${measured.columns.join(' / ')}，行高 ${measured.rows.join(' / ')}，胶囊 ${measured.cellChipWidth}px，标签「${measured.cellLabelText}」`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log('\n表格排版检查通过：长路径不再把中文列压成一字一行，单元格只显示文件名，正文引用保持不变。');
