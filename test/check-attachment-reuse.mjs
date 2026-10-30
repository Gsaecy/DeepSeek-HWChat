// 「已发出的附件拖回输入框 / 点一下再加一份」的回归检查。
//
// 需求（用户原话）：「已经发到聊天框的消息里面的图片，想要拖动，或者复制到输入框
// 显示成新的附件」。
//
// 为什么需要这个脚本：这条功能全由**事件连接**组成，任何一环断掉都不会报错 ——
//  * `<img>` 自己不 draggable=false、figure 也不 draggable，就根本拖不动；
//  * 输入框不 preventDefault 掉 `dragover`，浏览器就不认为它是合法落点，`drop` 永不触发；
//  * 拖拽数据里不放自定义 MIME，就只能靠全局变量猜「拖的是不是我们的附件」；
//  * 只做拖拽不做一个可见按钮，触摸屏和键盘用户就完全没有入口；
//  * 拖完不清状态，下一次普通点击会被残留的「添加」逻辑吃掉。
// 这些都不会让 TypeScript 或现有单测变红，所以单独守一条。
//
// 真实的像素与事件行为是用 headless Chromium 验证的（11 项，见 CHANGELOG）；
// 这里守结构与接线。
//
// 运行：node test/check-attachment-reuse.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const JS = readFileSync('media/chat.js', 'utf8');
const CSS = readFileSync('media/chat.css', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const CORE = readFileSync('src/core/attachmentReuse.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

let failures = 0;
function check(name, pass, detail) {
  if (pass) return;
  failures += 1;
  console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

// —— 入口一：可见按钮（触摸屏 / 键盘唯一的入口）——
check('消息图片上有「添加到输入框」按钮',
  /message-attachment-reuse/.test(JS) && /chat\.attachFromMessage/.test(JS),
  '缺按钮模板或文案 key');
check('按钮回传 attachMessageAttachment（不是自行拼附件）',
  /post\('attachMessageAttachment', attachmentOpenPayload\(attachment\)\)/.test(JS),
  '按钮必须把标识交给扩展，内容由扩展侧取');
check('按钮点击不会再顺带打开附件（事件隔离）',
  /reuse\.addEventListener\('click', \(event\) => \{\s*event\.stopPropagation\(\)/.test(JS),
  'stopPropagation 少了会同时触发 openAttachment');

// —— 入口二：拖动 ——
check('图片元素关掉原生拖拽，由 figure 承担（否则拖出 webview）',
  /image\.draggable = false/.test(JS),
  'img 默认 draggable，会拖出图片文件而不是走我们的通道');
check('附件元素标成 draggable 并写自定义 MIME',
  /element\.draggable = true/.test(JS)
  && /ATTACHMENT_DRAG_TYPE = 'application\/x-hwchat-attachment'/.test(JS)
  && /setData\(ATTACHMENT_DRAG_TYPE, token\)/.test(JS),
  '缺 draggable 或自定义 MIME');
check('dragend 清理拖动状态与高亮',
  /addEventListener\('dragend', end\)/.test(JS) && /draggingAttachment = null/.test(JS),
  '残留状态会让下一次普通点击被误判');
check('图片与文本附件都能拖（同一套 makeAttachmentDraggable）',
  (JS.match(/makeAttachmentDraggable\(figure, attachment\)/g) || []).length === 1
  && (JS.match(/makeAttachmentDraggable\(chip, attachment\)/g) || []).length === 1,
  '两类附件都必须可拖');

// —— 落点：输入框 ——
check('dragover 必须 preventDefault（否则 drop 永不触发）',
  /addEventListener\('dragover', \(event\) => \{[\s\S]{0,200}?event\.preventDefault\(\)/.test(JS),
  '没有 preventDefault 就没有合法落点');
check('拖到输入框时高亮、离开/放下时取消',
  /is-drop-target/.test(JS) && /is-drop-target/.test(CSS)
  && /setDropTarget\(false\)/.test(JS),
  '缺高亮状态或其复位');
check('落在输入框以外不会加附件（只有 composer 上有 drop）',
  /elements\.composer\.addEventListener\('drop'/.test(JS),
  'drop 只能绑在输入框上');
check('同时支持从 Finder 拖文件进来（Files 类型走粘贴同一条通道）',
  /hasDroppedFiles/.test(JS) && /readClipboardFiles\(files\)/.test(JS),
  '能放东西的落点不该只认自己的附件');

// —— 扩展侧：取内容与配额 ——
check('扩展侧按 id 从索引取回原始附件', /this\.attachmentIndex\.get\(id\)/.test(PANEL), '');
check('复制时不带旧 id（否则两条附件共用一个句柄）',
  /delete copy\.id/.test(CORE),
  'reuseCopy 必须去掉 id');
check('索引被淘汰后有路径就回落到磁盘',
  /absoluteAttachmentUri\(plan\.path\)/.test(PANEL) && /this\.toolExecutor\.readAttachment\(/.test(PANEL),
  '没有 fallback 的话用户点了按钮「什么也不发生」');
check('配额与「选文件」同口径（20 条 / 总量上限）',
  /MAX_PENDING_ATTACHMENTS = 20/.test(CORE) && /checkReuseLimits/.test(PANEL),
  '拖拽这条路不能绕过上限');
check('文本与图片都能复用（不限于 kind === image）',
  /dataBase64 \|\| attachment\.content/.test(CORE.replace(/\s+/g, ' ')) || /dataBase64 \|\| attachment\.content/.test(CORE),
  '只认图片会把文本附件漏掉');

// —— 复制「文字 + 图片」——
//
// 需求：「历史消息里含有图片，点击复制直接连图片和文字一起复制，且能一起粘贴到输入框」。
// VS Code 的剪贴板 API 只能写文字，所以带图的消息必须由 webview 用异步剪贴板写入。
// 这一整条链路任何一环掉了都不会报错（点了复制照样显示「已复制」，粘贴时才发现没图），
// 因此逐环盯住。
const I18N_KEYS = I18N;
check('复制按钮接到 copyMessage（不是直接写文字）',
  /copy\.addEventListener\('click', \(\) => \{ void copyMessage\(copy, message\); \}\)/.test(JS),
  '仍直接 requestClipboardWrite 就永远复制不到图片');
check('带图消息向扩展要原图（前端只有缩略图）',
  /requestAttachmentData/.test(JS) && /post\('requestAttachmentData'/.test(JS),
  '拿 160×120 的缩略图去复制等于把用户截图压糊');
check('用 ClipboardItem 一次写入 text/plain + image/png',
  /new ClipboardItem\(/.test(JS) && /'text\/plain': new Blob/.test(JS) && /'image\/png': png/.test(JS),
  'ClipboardItem 只接受 text/plain、text/html、image/png 三种键');
check('非 PNG 先转 PNG（jpeg 直接塞会抛异常）',
  /toPngBlob/.test(JS) && /toBlob\(resolve, 'image\/png'\)/.test(JS),
  'user 上传的 jpg 截图走不通就没意义');
check('写入失败降级为纯文字，并明确告知只复制了文字',
  /requestClipboardWrite\(text, button\);\s*\n\s*showToast\(t\('chat\.copyImageUnsupported'\)/.test(JS)
  || (/chat\.copyImageUnsupported/.test(JS) && /requestClipboardWrite\(text, button\)/.test(JS)),
  '静默少一张图比报错更糟');
check('多图时说明只复制了第一张', /chat\.copyImageFirstOnly/.test(JS), '剪贴板一次只能放一张图');
check('扩展侧提供原始 base64，并有大文件兜底',
  /provideAttachmentData/.test(PANEL) && /requestAttachmentData/.test(PANEL)
  && /tooLarge: true/.test(PANEL),
  '十几 MB 塞进一次 postMessage 会卡住面板');

// —— 文案 ——
check('中英文案齐全',
  ['chat.attachFromMessage', 'chat.attachFromMessageHint', 'chat.copiedWithImage', 'chat.copyImageFirstOnly', 'chat.copyImageUnsupported']
    .every((key) => new RegExp(`'${key.replace(/\./g, '\\.')}':`).test(I18N_KEYS)),
  '');

// —— 样式：无 hover 的设备必须常显，否则入口等于不存在 ——
check('无悬停设备上按钮常显', /@media \(hover: none\)/.test(CSS), '');
check('悬停 / 聚焦时才浮现（不长期遮挡缩略图）',
  /\.message-image-attachment:hover \.message-attachment-reuse/.test(CSS)
  && /\.message-image-attachment:focus-within \.message-attachment-reuse/.test(CSS),
  '键盘聚焦也必须能看见按钮');
check('拖动中的附件有视觉反馈', /\.message-image-attachment\.is-dragging/.test(CSS), '');

if (failures) {
  console.log(`\n${failures} 项不满足`);
  process.exit(1);
}
console.log('附件复用检查通过：按钮 + 拖拽两条入口、落点高亮、扩展侧取内容与配额都接线完整。');
