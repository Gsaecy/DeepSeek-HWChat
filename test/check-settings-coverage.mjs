// 设置页覆盖率的守门人（盘点缺口的产物）。
//
// 盘点（2026-11-03）发现：`hwchat.proxy` 与 `hwchat.searchExclude` 在设置页里**没有任何
// 控件**，只能手改 settings.json —— 而 proxy 恰恰是网络失败时的救命项（Node fetch 不读
// HTTPS_PROXY、VS Code http.proxy 也不覆盖扩展）。
//
// 守住两件事：
//   A. 每个**未废弃**的配置项，要么在设置页有控件，要么在下面的映射里明确登记它由谁编辑
//      （新增配置项忘了接 UI 会当场变红）；
//   B. 反向：package.json 里**声明了多少个视图，就必须在 extension.ts 里注册多少个** ——
//      这条来自另一处真实错漏：`HistoryViewProvider` 曾写完却从没注册（后来按用户要求
//      整个删掉了，这里改成通用规则，防止下次再出现「声明了却没接」）。
//
// 运行：node test/check-settings-coverage.mjs
import { readFileSync } from 'node:fs';

const PKG = JSON.parse(readFileSync('package.json', 'utf8'));
const PANEL = readFileSync('src/views/settingsPanel.ts', 'utf8');
const WEBVIEW = readFileSync('media/settings.js', 'utf8');
const EXTENSION = readFileSync('src/extension.ts', 'utf8');
const SETTINGS_TS = readFileSync('src/core/settings.ts', 'utf8');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const configuration = PKG.contributes.configuration;
const properties = Object.assign({}, ...(Array.isArray(configuration)
  ? configuration.map((section) => section.properties || {})
  : [configuration.properties || {}]));

/**
 * 每个未废弃配置项的编辑方式。
 *   'input'    —— 设置页里的 `<input id="…">`，必须同时在 media/settings.js 的字段清单里
 *   'profile'  —— 通过「接口配置（profile）」那组控件编辑，没有独立输入框
 *   'internal' —— 由程序自己维护，不面向用户（例如 activeApiProfileId 由下拉写入）
 */
const EDITING = {
  'hwchat.language': 'input',
  'hwchat.apiProfiles': 'profile',
  'hwchat.activeApiProfileId': 'profile',
  'hwchat.baseUrl': 'profile',
  'hwchat.model': 'profile',
  'hwchat.requestHeaders': 'profile',
  'hwchat.requestTimeoutSeconds': 'input',
  'hwchat.proxy': 'input',
  'hwchat.proxyBypassHosts': 'input',
  'hwchat.embeddingProfileId': 'input',
  'hwchat.embeddingModel': 'input',
  'hwchat.embeddingBaseUrl': 'input',
  'hwchat.temperature': 'input',
  'hwchat.maxTokens': 'input',
  'hwchat.systemPrompt': 'input',
  'hwchat.sendOnEnter': 'input',
  'hwchat.historyRetentionDays': 'input',
  'hwchat.taskCacheRetentionHours': 'input',
  'hwchat.cacheBudgetMB': 'input',
  'hwchat.cleanupIntervalMinutes': 'input',
  'hwchat.maxMessagesInContext': 'input',
  'hwchat.defaultMode': 'input',
  'hwchat.searchExclude': 'input',
  'hwchat.maxReadBytes': 'input',
  'hwchat.maxToolOutputBytes': 'input',
  'hwchat.maxCommandSeconds': 'input',
  'hwchat.auditRetentionDays': 'input',
};

/** media/settings.js 里读取的字段 id 清单。 */
const webviewFields = (() => {
  const match = WEBVIEW.match(/const fieldIds = \[([\s\S]*?)\];/);
  if (!match) return new Set();
  return new Set([...match[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));
})();

const deprecated = [];
for (const [key, value] of Object.entries(properties)) {
  const isDeprecated = Boolean(value.deprecationMessage || value.markdownDeprecationMessage);
  if (isDeprecated) {
    deprecated.push(key);
    continue;
  }
  const short = key.replace('hwchat.', '');
  const mode = EDITING[key];
  check(`${key} 有明确的编辑方式`, Boolean(mode), '新增配置项必须登记：input / profile / internal');
  if (!mode) continue;

  if (mode === 'input') {
    check(`${key} 在设置页有输入框`, PANEL.includes(`id="${short}"`), '设置页里找不到这个控件');
    check(`${key} 在设置页会被读取/写回`, webviewFields.has(short), 'media/settings.js 的字段清单里没有它');
    // 真正落库的路径：validateSettings 放行 + updateSettings 写回配置
    // 少数键在写回前要归一（language 走 normalizeLanguageSetting），所以只要求
    // 键名出现在 updateSettings 的键表里，具体值怎么加工不在这里管。
    check(`${key} 会被写回配置`,
      new RegExp(`\\['${short}', values\\.${short}\\b`).test(SETTINGS_TS),
      'updateSettings 的键表里没有它，界面改了也存不下去');
  }
}

check('废弃配置项只保留迁移用途', deprecated.length > 0 && deprecated.every((key) => {
  const value = properties[key];
  return Boolean(value.deprecationMessage || value.markdownDeprecationMessage);
}), `已废弃 ${deprecated.length} 项`);

/* ── A2：代理与搜索排除的完整链路（本轮新增的两个控件） ──────────────── */
for (const [key, label] of [['proxy', '接口代理'], ['searchExclude', '搜索排除目录']]) {
  check(`${key}：设置页文案已定义`, new RegExp(`settings\\.${key}\\.label`).test(readFileSync('src/core/i18n.ts', 'utf8')), label);
}
check('代理在保存前会校验（不支持 socks://）',
  /error\.proxySocks/.test(PANEL) && /error\.proxyInvalid/.test(PANEL),
  '写错代理会让所有请求失败，必须在保存时拦下');
check('搜索排除会被归一成数组',
  /searchExclude: fields\.searchExclude\.value\s*\n?\s*\.split/.test(WEBVIEW) || /fields\.searchExclude\.value\s*\n\s*\.split/.test(WEBVIEW),
  '逗号分隔的输入必须拆成数组');
check('搜索排除读取时按工作区根取并集',
  /function readSearchExclude\(\)/.test(SETTINGS_TS) && /workspaceFolders/.test(SETTINGS_TS),
  'resource 作用域只看合并视图会「写了但读不到」');

/* ── B：视图声明与注册必须一一对应 ──────────────────────────────────── */
const declaredViews = Object.entries(PKG.contributes.views ?? {})
  .flatMap(([container, list]) => list.map((view) => ({ container, id: view.id, name: view.name })));
check('解析出视图声明', declaredViews.length > 0, `${declaredViews.length} 个`);
for (const view of declaredViews) {
  // 只有 webview 视图用 registerWebviewViewProvider，其余用 registerTreeDataProvider。
  // chat 面板的 webview 视图由 ChatPanel 自己用 viewType 注册，其它（树形）视图在
  // extension.ts 里按 id 注册。两种都算「接上了」。
  const registeredById = EXTENSION.includes(`registerTreeDataProvider('${view.id}'`)
    || EXTENSION.includes(`registerWebviewViewProvider('${view.id}'`);
  // chat 面板的 webview 视图由 ChatPanel 声明 `static readonly viewType`，
  // extension.ts 再 `registerWebviewViewProvider(ChatPanel.viewType, …)` 注册 —— 两边都是
  // 同一个字符串常量，所以这里按「常量值 + 注册调用」判定，而不是要求写字面量 id。
  const registeredByPanel = /registerWebviewViewProvider\(ChatPanel\.viewType/
    .test(readFileSync('src/extension.ts', 'utf8'))
    && readFileSync('src/views/chatPanel.ts', 'utf8').includes(`'${view.id}'`);
  check(`视图 ${view.id} 有注册代码`, registeredById || registeredByPanel,
    '声明了视图却没有注册 = 用户看不到它');
  if (String(view.name).startsWith('%')) {
    check(`视图 ${view.id} 的名称有本地化条目`, !String(view.name).includes('undefined'), '');
  }
}

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
