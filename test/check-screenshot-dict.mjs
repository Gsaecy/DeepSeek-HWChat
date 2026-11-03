// README / Marketplace 那张截图的三条底线。
//
// 盘点（2026-11-03）时发现宣传图里输入框下方写着 **「Max steps: undefi…」** —— 原因是
// 截图构建脚本引用了 `english['chat.unlimited']`，而词表里的键叫 `chat.stepsUnlimited`，
// 于是 `undefined` 被插进 HTML，被 CSS 省略号截成 "undefi…"。这类错误不会让任何测试变红
// （截图不是代码路径），却会直接出现在商店页上。
//
// 同时那张图还把运行时下拉留成预览页的演示值（Autopilot / 无限制），与产品规则
// 「新对话默认每次询问」相反 —— 等于用官方图宣传一个更宽松的默认。
//
// 三条底线：
//   ① 构建脚本里引用的每个 `english['…']` 都必须在词表里存在；
//   ② 截图用的示例状态必须被改写成新对话默认值（每次询问 / 24 步 / 默认思考深度）；
//   ③ 已生成的英文页面里不许出现 `undefined`（构建产物，确保上面两条真的生效）。
//
// 运行：node test/check-screenshot-dict.mjs
import { existsSync, readFileSync } from 'node:fs';

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const BUILD = readFileSync('docs/screenshots/build.mjs', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

/** 词表里定义过的键（`'key': { zh: …`）。 */
const defined = new Set([...I18N.matchAll(/'([A-Za-z0-9_.]+)':\s*\{\s*zh\s*:/g)].map((m) => m[1]));
/** 构建脚本引用到的键（`english['key']` 与 `english[`template`]` 里的静态部分跳过）。 */
const referenced = new Set([...BUILD.matchAll(/english\['([A-Za-z0-9_.]+)'\]/g)].map((m) => m[1]));

check('构建脚本引用了词表键', referenced.size > 50, `${referenced.size} 个`);
const missing = [...referenced].filter((key) => !defined.has(key));
check('引用的键全部存在（缺一个就会渲染成 undefined）',
  missing.length === 0,
  missing.length ? `缺失：${missing.join(', ')}` : `${referenced.size} 个全部命中`);

check('截图状态被改写成新对话默认值',
  /permissionPreset: '\[a-z\]\+'|permissionPreset: '[a-z]+', agentMaxSteps: \\d+, reasoningEffort: '[a-z]+'/.test(BUILD)
  && /agentMaxSteps: 24, reasoningEffort: 'default'/.test(BUILD),
  '不改写就会把预览页的演示值（Autopilot / 无限制）截进宣传图');

const generated = ['docs/screenshots/chat-panel.html', 'docs/screenshots/chat.en.html'].filter((file) => existsSync(file));
if (!generated.length) {
  console.log('SKIP 产物检查：还没有生成 docs/screenshots/*.html');
} else {
  for (const file of generated) {
    const html = readFileSync(file, 'utf8');
    check(`${file} 里没有 undefined 文案`,
      !/>\s*undefined\s*</.test(html) && !/undefined</.test(html),
      '出现 undefined 说明某个 english[…] 取空了');
  }
  const main = readFileSync('docs/screenshots/chat-panel.html', 'utf8');
  check('产物的权限预设是「每次询问」',
    !/permissionPreset: 'autopilot'/.test(main) && /permissionPreset: 'askAll'/.test(main),
    '');
  check('产物的步数是 24',
    /agentMaxSteps: 24/.test(main), '');
}

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
