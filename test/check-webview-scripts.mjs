// 「面板真的加载了它依赖的每个脚本」——这条盘点的产物。
//
// 真实缺陷（2026-11-03 盘点功能清单时发现）：
//   `media/inline-append.js` 与 `media/stream-repair.js` 写了、单测了、也写进了 README 与
//   CHANGELOG（「纯文本直接追加」「半截 markdown 先补全再渲染」），但**从来没有被注入到
//   面板 HTML** —— 只有 `test/preview-chat.html` 加载了它们。
//   于是线上 `globalThis.HWChatInlineAppend` / `HWChatStreamRepair` 恒为 undefined：
//   快路径永不生效、补全永不生效，而所有浏览器守护跑的都是 preview 页，全绿。
//
// 这类「文档说有、测试绿、线上没接」是最难靠肉眼发现的一类错漏，所以做成静态对齐：
//   preview 页加载的每个 media 辅助脚本，真实面板 HTML 也必须加载；
//   chat.js 必须是最后加载的那个。
//
// 运行：node test/check-webview-scripts.mjs
import { readFileSync } from 'node:fs';

const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const PREVIEW = readFileSync('test/preview-chat.html', 'utf8');
const CHAT_JS = readFileSync('media/chat.js', 'utf8');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/**
 * 面板实际**注入**的脚本顺序。
 *
 * 不能直接按 `mediaUri(...)` 声明的先后判断：`chat.js` 的 uri 是最早声明的，但它在
 * HTML 里是**最后**一个 `<script>`。真正决定执行顺序的是模板里标签的先后，所以这里
 * 先建立「变量名 → 文件名」的表，再按模板中 `<script ... src="${变量}">` 的顺序取。
 */
const uriByVar = new Map([...PANEL.matchAll(/const (\w+) = mediaUri\(webview, this\.extensionUri, '([^']+\.js)'\)/g)]
  .map((match) => [match[1], match[2]]));
const panelScripts = [...PANEL.matchAll(/<script nonce="\$\{scriptNonce\}" src="\$\{(\w+)\}"><\/script>/g)]
  .map((match) => uriByVar.get(match[1]) ?? `?${match[1]}`);
/** preview 页里本地加载的 media 脚本。 */
const previewScripts = [...PREVIEW.matchAll(/src="\.\.\/media\/([^"]+\.js)"/g)].map((m) => m[1]);

check('面板的脚本清单解析成功', panelScripts.length > 5, `panel=${panelScripts.length}`);
check('preview 的脚本清单解析成功', previewScripts.length > 5, `preview=${previewScripts.length}`);
check('chat.js 在面板里最后加载',
  panelScripts[panelScripts.length - 1] === 'chat.js',
  `末尾是 ${panelScripts[panelScripts.length - 1]}`);
check('preview 里 chat.js 也最后加载',
  previewScripts[previewScripts.length - 1] === 'chat.js',
  `末尾是 ${previewScripts[previewScripts.length - 1]}`);

// 核心断言：preview 加载的辅助脚本，面板必须一个不少。
for (const script of previewScripts) {
  if (script === 'chat.js') continue;
  check(`面板也加载 ${script}`, panelScripts.includes(script), '只在预览页加载 = 线上功能静默失效');
}
// 反过来：面板加载的脚本，预览页也要有，否则守护覆盖不到。
for (const script of panelScripts) {
  if (script === 'chat.js') continue;
  check(`preview 也加载 ${script}`, previewScripts.includes(script), '面板有、预览页没有 → 浏览器守护覆盖不到它');
}

// chat.js 读的每个 HWChatXxx 全局，都必须有对应脚本注入（防止再出现「依赖一个没人加载的文件」）。
const globals = [...CHAT_JS.matchAll(/globalThis\.(HWChat[A-Za-z]+)/g)].map((m) => m[1]);
const unique = [...new Set(globals)];
const EXPECTED = {
  HWChatCodeBlockMeta: 'code-block-meta.js',
  HWChatTodoPanelState: 'todo-panel-state.js',
  HWChatIcons: 'ui-icons.js',
  HWChatCalloutMeta: 'callout-meta.js',
  HWChatSecretScan: 'secret-scan.js',
  HWChatToastTiming: 'toast-timing.js',
  HWChatFollowUpFormat: 'follow-up-format.js',
  HWChatInlineAppend: 'inline-append.js',
  HWChatStreamRepair: 'stream-repair.js',
  HWChatFileRef: 'file-reference.js',
};
for (const name of unique) {
  const script = EXPECTED[name];
  if (!script) {
    check(`未知全局 ${name} 有对应脚本`, false, '新加的 HWChatXxx 需要在本题里登记并确认面板加载');
    continue;
  }
  check(`${name} ← ${script}（面板已加载）`, panelScripts.includes(script), '全局依赖的脚本没注入');
}

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
