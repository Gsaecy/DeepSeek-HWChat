// toast 显示时长的界面侧验证。
//
// 回归的故障：所有 toast 一律写死 4.2 秒，与文字长度、严重程度都无关。
// 六十多个汉字的停滞提醒在 4.2 秒里读不完 —— 用户反馈「弹了一次但消失太快，
// 我没看清」，也就是说提示虽然弹了，但等于没起作用。
//
// 这个脚本做两件事：
// 1. 加载真实的 media/toast-timing.js 并直接调用它，验证「长警告读得完」。
// 2. 断言各处接线还在（chat.js 读模块、退化兜底、点击关闭、注入顺序、可访问性），
//    这些点任何一处被删掉，用户就又会遇到一闪而过的提示。
//
// 运行：node test/check-toast-duration.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(path, 'utf8');
const CHAT_JS = read('media/chat.js');
const PANEL = read('src/views/chatPanel.ts');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed += 1; console.log(`✔ ${name}`); }
  else { failed += 1; console.log(`✘ ${name}`); }
}

/* ── 1. 直接跑真实的纯函数 ───────────────────────────────── */

const sandbox = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('media/toast-timing.js'), sandbox);
const timing = sandbox.HWChatToastTiming;

check('toast-timing.js 挂载 HWChatToastTiming', Boolean(timing));
check('暴露 toastDurationMs 与 readingUnits', typeof timing.toastDurationMs === 'function' && typeof timing.readingUnits === 'function');

const STALL_ZH = '有命令已 30 秒没有输出，可能卡在等待密码或确认。HWChat 无法替你输入，可在该步骤上点停止；到达 55 秒上限会自动终止。';
const stallMs = timing.toastDurationMs(STALL_ZH, 'warning');
check(`中文停滞提醒读得完（${(stallMs / 1000).toFixed(1)}s > 8s）`, stallMs > 8000);
check(`中文停滞提醒比旧实现长一倍以上（旧 4.2s）`, stallMs > 8400);
check('短提示维持 4 秒（不因改造变长）', timing.toastDurationMs('标题已保存', 'neutral') === 4000);
check('warning 下限高于 neutral', timing.toastDurationMs('注意', 'warning') > timing.toastDurationMs('注意', 'neutral'));
check('error 下限最高', timing.toastDurationMs('注意', 'error') > timing.toastDurationMs('注意', 'warning'));
check('封顶 20 秒', timing.toastDurationMs('字'.repeat(500), 'error') === 20000);
check('空值不抛异常且算 0 单位', timing.readingUnits(null) === 0 && timing.readingUnits(undefined) === 0);
check('中文一字算一单位', timing.readingUnits('三个字') === 3);

/* ── 2. 接线断言 ─────────────────────────────────────────── */

check('chat.js 顶层读取 globalThis.HWChatToastTiming', CHAT_JS.includes('const toastTiming = globalThis.HWChatToastTiming || null;'));
check('chat.js 保留 4200ms 退化兜底', CHAT_JS.includes('? toastTiming.toastDurationMs(text, tone) : 4200'));
check('showToast 用 duration 变量设定时器（不再写死 4200）', /showToast\.timer = setTimeout\(hideToast, duration\)/.test(CHAT_JS));
check('有 hideToast 并清掉待触发的定时器', /function hideToast\(\) \{ clearTimeout\(showToast\.timer\); elements\.toast\.hidden = true; \}/.test(CHAT_JS));
check('点击 toast 可立刻收起', CHAT_JS.includes("elements.toast.addEventListener('click', hideToast);"));
check('toast 元素仍带 role="status"（可访问性未破坏）', PANEL.includes('id="toast" class="toast" role="status"'));

check('chatPanel 注入 toast-timing.js', PANEL.includes("mediaUri(webview, this.extensionUri, 'toast-timing.js')"));
check('页面里有 toastTimingScript 的 script 标签', PANEL.includes('src="${toastTimingScript}"'));

// 注入顺序：模块必须排在 chat.js 之前，否则 chat.js 运行时读到 null、退回 4.2 秒。
const timingTagAt = PANEL.indexOf('src="${toastTimingScript}"');
const chatTagAt = PANEL.indexOf('src="${script}"');
check('toast-timing.js 的标签排在 chat.js 之前', timingTagAt >= 0 && chatTagAt >= 0 && timingTagAt < chatTagAt);

// 顺序还要排在所有依赖它的东西之前：确认没有把标签写进 <head>（那里还没有 body）。
const bodyAt = PANEL.indexOf('<body');
check('script 标签在 <body> 之后（和其它模块一致）', bodyAt >= 0 && timingTagAt > bodyAt);

console.log(`\n${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
