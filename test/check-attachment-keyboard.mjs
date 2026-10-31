// 「附件卡片的键盘与拖放」真实浏览器验证（headless Chromium）。
//
// 为什么单独一个脚本：这几条全都在**真实输入事件**下才暴露 ——
//  1. 焦点在「添加到输入框」按钮上按 Enter，事件会冒泡到外层卡片的 keydown；
//     卡片如果没判断落点就 preventDefault，按钮的默认激活被取消 → 打开图片而不是加附件。
//     （独立审核发现，0.2.9 里真的坏过）
//  2. 外层卡片带 role="button" 又内含 <button> = 可聚焦元素嵌套，读屏与 Tab 顺序都会乱。
//  3. 从 Finder 拖文件进来时 `dataTransfer.files` 是 **FileList**，没有 slice；
//     直接 `files.slice()` 会抛 `files.slice is not a function`，界面毫无反应。
//
// 做法：用 Playwright 的**真实**键盘与鼠标（dragTo 走 CDP 派发真实拖拽），
// 不用合成 DragEvent 自证。预览页承载真实 DOM 结构与真实 media/chat.js。
//
// 前置：playwright 与 chromium 由本机缓存提供；找不到就跳过（打印 SKIP 并退出 0），
// 不阻塞没有浏览器的环境跑全量检查。
//
// 运行：node test/check-attachment-keyboard.mjs
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
  console.log(`SKIP 附件键盘/拖放验证：${playwrightRoot ? '找不到 chromium' : '找不到 playwright'}（不影响其它检查）`);
  process.exit(0);
}

const { chromium: launcher } = await import(join(playwrightRoot, 'index.mjs'));
const executablePath = join(cacheRoot, chromium, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
if (!existsSync(executablePath)) {
  console.log('SKIP 附件键盘/拖放验证：chromium 可执行文件不在预期路径');
  process.exit(0);
}

const browser = await launcher.launch({ executablePath });
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const page = await browser.newPage({ viewport: { width: 570, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
await page.waitForSelector('.message-attachment-reuse');
await page.waitForTimeout(400);

const posted = () => page.evaluate(() => window.__hwchatMessages.map((message) => message.type));

// 1) 键盘 Enter / Space 落在「添加到输入框」上
for (const key of ['Enter', ' ']) {
  await page.evaluate(() => { window.__hwchatMessages.length = 0; });
  await page.evaluate(() => document.querySelector('.message-attachment-reuse').focus());
  await page.keyboard.press(key === ' ' ? 'Space' : key);
  await page.waitForTimeout(200);
  const types = await posted();
  check(`键盘 ${key === ' ' ? '空格' : 'Enter'} → 加进输入框（而不是打开图片）`,
    types.includes('attachMessageAttachment') && !types.includes('openAttachment'), JSON.stringify(types));
}

// 2) 焦点角色在 <img> 上，外层卡片不再嵌套可聚焦元素
const roles = await page.evaluate(() => {
  const figure = document.querySelector('.message-image-attachment');
  return {
    figureRole: figure.getAttribute('role'),
    imageRole: figure.querySelector('img').getAttribute('role'),
    imageTabIndex: figure.querySelector('img').getAttribute('tabindex'),
    buttons: figure.querySelectorAll('button').length,
  };
});
check('图片才是按钮，外层卡片不再是（不嵌套可聚焦元素）',
  roles.figureRole === null && roles.imageRole === 'button' && Number(roles.imageTabIndex) === 0 && roles.buttons === 1,
  JSON.stringify(roles));

// 3) 图片上按 Enter 仍然是「打开附件」（原行为没坏）
await page.evaluate(() => { window.__hwchatMessages.length = 0; });
await page.evaluate(() => document.querySelector('.message-image-attachment img').focus());
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check('图片上按 Enter → 打开附件', (await posted()).includes('openAttachment'));

// 4) 真实鼠标拖拽图片到输入框
await page.evaluate(() => { window.__hwchatMessages.length = 0; });
let dragError = null;
try {
  await page.locator('.message-image-attachment img').first()
    .dragTo(page.locator('#composer'), { timeout: 8000 });
} catch (error) {
  dragError = error.message.split('\n')[0];
}
await page.waitForTimeout(400);
const afterDrag = await page.evaluate(() => ({
  types: window.__hwchatMessages.map((message) => message.type),
  highlighted: document.getElementById('composer').classList.contains('is-drop-target'),
}));
check('真实鼠标拖拽 → 产生附件', afterDrag.types.includes('attachMessageAttachment'), `posted=${JSON.stringify(afterDrag.types)} err=${dragError}`);
check('拖完后高亮复位、且没有误触发「打开附件」',
  afterDrag.highlighted === false && !afterDrag.types.includes('openAttachment'), JSON.stringify(afterDrag));

// 5) 外部文件（FileList）拖进来：不得抛 files.slice is not a function
const fileDrop = await page.evaluate(async () => {
  window.__hwchatMessages.length = 0;
  const composer = document.getElementById('composer');
  const transfer = new DataTransfer();
  transfer.items.add(new File(['hello from disk'], 'sample.txt', { type: 'text/plain' }));
  composer.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  const highlighted = composer.classList.contains('is-drop-target');
  composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  await new Promise((done) => setTimeout(done, 300));
  return {
    highlighted,
    after: composer.classList.contains('is-drop-target'),
    files: window.__hwchatMessages.filter((message) => message.type === 'attachClipboardFiles')
      .map((message) => message.files.map((file) => file.name)),
  };
});
check('外部文件（FileList）拖入 → 变成附件',
  fileDrop.highlighted && !fileDrop.after && fileDrop.files.length === 1 && fileDrop.files[0][0] === 'sample.txt',
  JSON.stringify(fileDrop));
check('拖放路径没有抛异常（FileList 已转数组）', errors.length === 0, JSON.stringify(errors.slice(0, 3)));

await browser.close();

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? '✓' : '✗'} ${result.name}${result.pass || !result.detail ? '' : ` — ${result.detail}`}`);
}
if (failed.length) {
  console.log(`\n${failed.length} 项不满足（共 ${results.length} 项）`);
  process.exit(1);
}
console.log(`\n全部通过：${results.length} 项（真实键盘 / 真实鼠标拖拽 / FileList 拖放）`);
