/*
 * 「模型不接受图片输入」的自动降级守护。
 *
 * 现场（用户 2026-11-04，切到智谱模型后连发两次同样的请求都失败）：
 *
 *     请求失败：接口请求失败（400）：messages.content.type 参数非法，取值范围 ['text']
 *
 * 真正要命的不是"这张图发不出去"，而是：**对话历史里只要有一条带图的提问，
 * 之后每一次请求都会带上那个 `image_url`** —— 连纯文字的新消息也永远失败。
 *
 * 所以这里钉住四件事：
 *   1. 认得出这句话（且没带图时不认，避免掩盖真正的参数错误）；
 *   2. 降级时把「图片已省略」写进正文（不写，模型会编造画面内容）；
 *   3. 只被拒一次就学会，之后**一开始**就不带图（不要每次都先撞 400）；
 *   4. 记忆按「配置档 + 模型」分开 —— 换成视觉模型要立刻恢复。
 *
 * 用法：node test/check-vision-fallback.mjs
 */
import { readFileSync } from 'node:fs';

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
const MODULE = read('src/providers/visionFallback.ts');
const CLIENT = read('src/providers/deepseekClient.ts');
const PANEL = read('src/views/chatPanel.ts');
const EXT = read('src/extension.ts');
const I18N = read('src/core/i18n.ts');

/* ── 1. 识别 ─────────────────────────────────────────────────────────── */
check(
  '认得出「content.type 只允许 text」这类拒绝',
  /content\\\.type/.test(MODULE) && /只支持|only\\s\+support/.test(MODULE),
  '用户实际看到的是「messages.content.type 参数非法，取值范围 [\'text\']」',
);
check(
  '没有图片时**不**认这类拒绝',
  /if \(!hasImageParts\) return false;/.test(MODULE),
  '没带图还往图片上赖，会掩盖真正的参数错误（例如 tools 格式不对）',
);

/* ── 2. 降级质量 ─────────────────────────────────────────────────────── */
// 文案键由**调用方**（client）提供，模块本身只负责把它接进正文 ——
// 所以两侧都要检查，缺一边都会让模型"以为看到了图"。
check(
  '降级时把「图片已省略」写进正文',
  /trimmedNote/.test(MODULE)
  && MODULE.includes("${trimmedNote}")
  && /visionUnsupportedNote/.test(CLIENT)
  && /'api\.visionUnsupportedNote'/.test(I18N),
  '只删图不说明，模型会以为自己看到了却描述不出来，更容易编造画面',
);
check(
  '只剩一段文本时降级成字符串（兼容连 [{type:"text"}] 都不收的接口）',
  /merged\.length === 1 && merged\[0\]\?\.type === 'text'/.test(MODULE),
);
check(
  '没有图片的消息一个字都不动',
  /if \(!Array\.isArray\(message\.content\)\) return message;/.test(MODULE),
  '历史里其他消息必须原样透传，别顺手改坏',
);

/* ── 3. 自我修正 + 记忆 ─────────────────────────────────────────────── */
check(
  '400 被拒后自动去掉图片重发（而不是直接失败）',
  /isTextOnlyContentRejection\(detail, hasImageParts\(outgoing/.test(CLIENT)
  && /this\.textOnlyModels\.add\(this\.textOnlyKey\(settings\)\)/.test(CLIENT),
  '这条错误与参数无关，重发同样的请求永远不会成功 —— 必须改变请求形状',
);
check(
  '学会之后**一开始**就不发图片（不再先撞一次 400）',
  /if \(this\.textOnlyModels\.has\(this\.textOnlyKey\(settings\)\)\) \{/.test(CLIENT),
);
check(
  '记忆键含模型名（换视觉模型立刻恢复）',
  /return `\$\{settings\.activeApiProfileId\}\\u0000\$\{settings\.model\}`;/.test(CLIENT),
  '只按配置档记会让同一家的视觉模型也被误判成不吃图',
);
check(
  '有诊断日志，事后能复盘',
  /\[vision\]/.test(CLIENT),
);

/* ── 4. 用户知情 ─────────────────────────────────────────────────────── */
check(
  '降级会通知界面（不只写在日志里）',
  /onVisionFallback/.test(CLIENT) && /client\.onVisionFallback/.test(EXT),
  '用户会疑惑"我明明发了图，它为什么说看不到"',
);
check(
  '发送前就提示（已知模型不吃图时）',
  /this\.client\.isTextOnlyModel\(settings\)/.test(PANEL) && /notice\.visionFallback/.test(PANEL),
  '别等发出去再降级，用户能提前知道',
);
check(
  '提示文案说清了「图被省略」「换视觉模型」两件事',
  /notice\.visionFallback/.test(I18N) && /VL \/ Vision|视觉/.test(I18N),
);

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「模型不接受图片」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('模型不吃图时：自动降级 + 一次学会 + 明确告知，不会再让整轮请求永久失败。');
}
