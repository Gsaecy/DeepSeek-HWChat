/*
 * 设置页的「文字按钮被压成方块」问题。
 *
 * 用户反馈（2026-11-07，附两张截图）：
 *
 *     这里显示不对，而且点击也没反应          ← 检测能否直接调用 / 测试出图
 *
 * 两处症状同一个病根：这两个按钮被放进了 `.profile-control` —— 那是给 `＋` `−`
 * 这类**方形图标按钮**用的栅格（`minmax(0,1fr) 32px 32px`，按钮宽 32px）。
 * 中文标签在里面没有换行空间，只能一个字一行竖排；32px 宽的盒子也点不中。
 *
 * 另外两条同批修掉的问题也在这里守着：
 *   - 说明文字里的 `**粗体**` 被当普通文本显示成星号；
 *   - 没有独立的「向量接口 Key」输入框（聊天用 DeepSeek、向量用 holysheep 时填不进去）。
 *
 * 用法：node test/check-settings-layout.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

const read = (path) => readFileSync(path, 'utf8');
/** 去掉注释再查标识符：注释里写「这里曾写成 collectSettings()」不该算还在引用。 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const PANEL = read('src/views/settingsPanel.ts');
const CSS = read('media/settings.css');
const JS = read('media/settings.js');
const I18N = read('src/core/i18n.ts');

/* ── 1. 文字按钮不许进方形图标栅格 ──────────────────────────────── */
check(
  '「检测能否直接调用」用行内控件栅格（不是 32px 方形按钮）',
  /<span class="inline-control"><input id="embeddingModel"[^>]*><button id="probeEmbeddingButton"/.test(PANEL),
  '放进 .profile-control 会被压成 32px 宽，中文标签只能竖排',
);
check(
  '「测试出图」同样改掉了',
  /<span class="inline-control"><input id="profileImageModel"[^>]*><button id="testImageButton"/.test(PANEL),
);
check(
  '`.profile-control` 里只剩单字符图标按钮（＋ / −）',
  !/profile-control[^>]*>[^<]*<button[^>]*>[^+−]<\/button>/.test(PANEL),
);
check(
  '行内控件宽度 auto + 不换行（长标签不会被拆成一字一行）',
  /\.inline-control button \{[\s\S]{0,300}width: auto;/.test(CSS)
    && /\.inline-control button \{[\s\S]{0,400}white-space: nowrap;/.test(CSS),
);

/* ── 2. 说明文字不许残留 markdown ───────────────────────────────── */
const howto = /'settings\.embeddingHowto':[\s\S]*?\n  '/.exec(I18N)?.[0] ?? '';
check(
  '设置页说明里没有 `**` 之类的 markdown 残留',
  howto.length > 0 && !/\*\*/.test(howto),
  '这段是纯文本渲染，写 `**粗体**` 会原样显示星号',
);
check(
  '说明用纯文本注入（textContent，不走 markdown 渲染）',
  /howto\.textContent = t\('settings\.embeddingHowto'\)/.test(JS),
);

/* ── 3. 向量 Key 必须能单独填 ──────────────────────────────────── */
check(
  '有独立的「向量接口 Key」密码框',
  /<input id="embeddingApiKey" type="password"/.test(PANEL),
);
check(
  '向量 Key 按配置档分开保存在 SecretStorage',
  /embeddingKeyStorageKey/.test(read('src/core/apiKeys.ts')),
);
check(
  '保存时会提交向量 Key 与清除标记',
  /embeddingApiKeys: \{ \.\.\.pendingEmbeddingKeys \}/.test(JS)
    && /clearEmbeddingKeyIds: \[\.\.\.clearEmbeddingKeyIds\]/.test(JS),
);
check(
  '检测时把「刚填还没保存」的聊天 Key 也带上（只限同一档）',
  /typedChatKey && embeddingProfileId && embeddingProfileId === activeProfileId/.test(JS),
);
check(
  '检测时优先用刚填的向量 Key',
  /typedEmbeddingKey\?\.trim\(\)/.test(PANEL) && /embeddingApiKey: fields\.embeddingApiKey\.value\.trim\(\)/.test(JS),
);
check(
  '已保存时输入框显示占位提示（不会让人以为丢了）',
  /settings\.embeddingKey\.saved/.test(I18N) && /fields\.embeddingApiKey\.placeholder/.test(JS),
);

/* ── 3b. 明文 Key 不许进 settings ──────────────────────────────── */
/*
 * `validateSettings()` 是 `{ ...values }` 直通合并，没有白名单。所以只要前端把 Key
 * 塞进 `collectSettings()` 的返回值，它就会以**明文**写进 settings.json —— 而不是
 * SecretStorage。这条守护盯的就是这种「顺手加一个字段」的回归。
 */
const collect = /function readForm\(\) \{[\s\S]*?\n  \}/.exec(JS)?.[0] ?? '';
check('能定位到 readForm()（设置页唯一的表单取值出口）', collect.length > 0);
check(
  '表单取值里没有明文密钥字段',
  collect.length > 0 && !/\b(apiKey|embeddingKey)\s*:/.test(collect),
  'Key 只应经 apiKeys / embeddingApiKeys 通道进 SecretStorage',
);

/* ── 4. 点了要有反馈 ───────────────────────────────────────────── */
check(
  '检测结论为空时整行不占位（不空出一块）',
  /\.setting-row:has\(> span > #embeddingProbeResult:empty\) \{ display: none; \}/.test(CSS),
);
check(
  '检测期间按钮禁用并显示「正在检测」',
  /probeEmbeddingButton\.disabled = true/.test(JS)
    && /settings\.embeddingProbeRunning/.test(I18N),
);
check(
  '检测结束恢复按钮',
  /probeEmbeddingButton\.disabled = false/.test(JS),
);
/*
 * 「点了没反应」的真凶：处理器里调了不存在的 `collectSettings()`，点一下抛
 * ReferenceError。所以这里既守「走 withForm 统一取值」，也守「不引用未定义的标识符」——
 * 后者靠 node --check 查不出来（语法合法，运行时才炸）。
 */
check(
  '检测按钮走 withForm（与保存同一条取值/校验路径）',
  /probeEmbeddingButton\.addEventListener\('click', \(\) => withForm\(/.test(JS),
);
const CODE = stripComments(JS);
const declaredNames = new Set([...CODE.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
check(
  '不再引用不存在的 collectSettings()',
  !/\bcollectSettings\s*\(/.test(CODE),
  '这个标识符从未定义，点了就抛 ReferenceError（node --check 查不出来）',
);
check('readForm 已在脚本里定义', declaredNames.has('readForm'));
check(
  '「向量 Key 已保存」状态确实下发到界面',
  /embeddingKeyConfiguredByProfile,/.test(PANEL)
    && /message\.embeddingKeyConfiguredByProfile\b/.test(JS),
  '不下发的话重载后密码框只能显示 sk-…，用户不知道到底存没存',
);

/* ── 4b. 预览夹具的词表不许落后 ───────────────────────────────── */
/*
 * 夹具自带一份 `hwchat-i18n` 词表（浏览器守护用它渲染真实中文）。它是手抄的，
 * 曾经落后到连「向量 Key 已保存」都没有 —— 于是预览页把键名当文案显示，
 * 而守护却全绿。这条把它钉在真实词表上。
 */
const fixture = read('test/preview-settings.html');
const usedKeys = new Set([
  ...[...PANEL.matchAll(/t\(lang, '([\w.]+)'\)/g)].map((match) => match[1]),
  // `(?<!\w)` 是必需的：否则 `createElement('option')` 结尾的 `t('option')` 会被误当成 i18n 调用。
  ...[...JS.matchAll(/(?<!\w)t\('([\w.]+)'/g)].map((match) => match[1]),
]);
const fixtureTable = /<script type="application\/json" id="hwchat-i18n">([\s\S]*?)<\/script>/.exec(fixture)?.[1] ?? '';
let fixtureKeys = null;
try { fixtureKeys = new Set(Object.keys(JSON.parse(fixtureTable))); } catch { fixtureKeys = null; }
check('预览夹具的 i18n 词表能解析', fixtureKeys !== null);
const missingKeys = [...usedKeys].filter((key) => !fixtureKeys?.has(key));
check(
  `夹具词表覆盖设置页用到的 ${usedKeys.size} 个键`,
  missingKeys.length === 0,
  `缺 ${missingKeys.slice(0, 6).join(', ')}${missingKeys.length > 6 ? ' …' : ''}（用 src/core/i18n.ts 重新生成）`,
);

/* ── 5. 真实浏览器量一遍：按钮宽度必须大于高度 ──────────────────── */
const PLAYWRIGHT_ROOTS = [
  join(process.cwd(), 'node_modules', 'playwright'),
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`file://${join(process.cwd(), 'test', 'preview-settings.html')}`);
    await page.waitForSelector('#connection');

    const measured = await page.evaluate(() => {
      const measure = (id) => {
        const node = document.querySelector(`#${id}`);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height), text: node.textContent || '' };
      };
      return {
        probe: measure('probeEmbeddingButton'),
        testImage: measure('testImageButton'),
        noteText: document.querySelector('.setting-note')?.textContent?.trim() ?? '',
        keyInput: Boolean(document.querySelector('#embeddingApiKey')),
      };
    });

    check('浏览器：检测按钮量得到尺寸', Boolean(measured.probe));
    check(
      '浏览器：检测按钮是横的（宽度明显大于高度）',
      Boolean(measured.probe) && measured.probe.width > measured.probe.height * 2.5,
      `实际 ${measured.probe?.width}×${measured.probe?.height}（竖排时宽度会接近高度）`,
    );
    check(
      '浏览器：检测按钮的高度没有把文字挤成多行',
      Boolean(measured.probe) && measured.probe.height <= 40,
      `实际高度 ${measured.probe?.height}`,
    );
    check(
      '浏览器：测试出图按钮同样是横的',
      Boolean(measured.testImage) && measured.testImage.width > measured.testImage.height * 2,
      `实际 ${measured.testImage?.width}×${measured.testImage?.height}`,
    );
    check('浏览器：向量 Key 输入框存在', measured.keyInput === true);

    // 真的点一下：这是用户报的「点了没反应」，必须量到按钮禁用 + 中文回执。
    await page.fill('#embeddingApiKey', 'sk-test');
    await page.click('#probeEmbeddingButton');
    await page.waitForTimeout(120);
    const clicked = await page.evaluate(() => {
      const text = document.querySelector('#embeddingProbeResult')?.textContent?.trim() ?? '';
      return { text, disabled: document.querySelector('#probeEmbeddingButton')?.disabled === true };
    });
    measured.pendingText = clicked.text;
    check('浏览器：点检测后按钮被禁用', clicked.disabled);
    check('浏览器：点检测后有回执（不是静默）', clicked.text.length > 0);
    check(
      '浏览器：说明文案真的渲染出来（不是键名）',
      measured.noteText.length > 40 && !measured.noteText.startsWith('settings.'),
      `实际 ${JSON.stringify(measured.noteText.slice(0, 32))}`,
    );
    check(
      '浏览器：检测期间的提示是中文/英文，不是键名',
      measured.pendingText.length > 0 && !measured.pendingText.startsWith('settings.'),
      `实际 ${JSON.stringify(measured.pendingText)}`,
    );
    check('渲染没有脚本错误', errors.length === 0, errors.join('; '));
    await browser.close();
  }
}

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('设置页的按钮排版 / 说明文案 / 向量 Key 还有问题。');
  process.exitCode = 1;
} else {
  console.log('文字按钮不再被压成方块，说明是纯文本，向量 Key 能单独填。');
}
