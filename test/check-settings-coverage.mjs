// 设置页覆盖率 + 资源管理器历史视图的守门人（盘点缺口的产物）。
//
// 盘点（2026-11-03）发现两类「有配置项、但用户摸不到」的缺口：
//   ① `hwchat.proxy` 与 `hwchat.searchExclude` 在设置页里**没有任何控件**，只能手改
//      settings.json —— 而 proxy 恰恰是网络失败时的救命项（Node fetch 不读 HTTPS_PROXY、
//      VS Code http.proxy 也不覆盖扩展）。
//   ② `src/views/historyView.ts` 里的 `HistoryViewProvider` 写完了却**从没注册**：
//      package.json 没有这个视图、extension.ts 没有 registerTreeDataProvider。
//
// 所以这里守住两件事：
//   A. 每个**未废弃**的配置项，要么在设置页有控件，要么在下面的映射里明确登记它由谁编辑
//      （新增配置项忘了接 UI 会当场变红）；
//   B. 历史视图真的被贡献、被注册、被刷新。
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

/* ── B：资源管理器里的历史视图 ────────────────────────────────────────── */
const explorerViews = (PKG.contributes.views?.explorer ?? []).map((view) => view.id);
check('package.json 贡献了历史视图', explorerViews.includes('hwchat.historyView'), JSON.stringify(explorerViews));
check('视图名称走本地化', (PKG.contributes.views?.explorer ?? []).some((view) => String(view.name).startsWith('%')), '');
check('扩展注册了该视图', /registerTreeDataProvider\('hwchat\.historyView'/.test(EXTENSION), '视图没注册 = 永远不会出现');
check('历史变化时刷新该视图', /onHistoryChanged:[\s\S]{0,200}historyView\.refresh\(\)/.test(EXTENSION), '不刷新就是一份过期列表');
check('provider 随扩展一起释放', /context\.subscriptions\.push\([\s\S]{0,200}historyView/.test(EXTENSION), '');
check('视图用到的文案都存在',
  ['history.pinned', 'history.open', 'history.emptyConversation']
    .every((key) => readFileSync('src/core/i18n.ts', 'utf8').includes(`'${key}'`)),
  '缺键会渲染出原始键名');

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
