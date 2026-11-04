/**
 * 「输出图片」这项能力对模型的两处提示，以及与「用户是不是要一张图」的判定。
 *
 * 为什么单独一个模块（真实事故，2026-11-04）：用户在没填「图片模型」的配置档下说
 * 「给我这个 skill 的原理图」，agent 既没被告知图片能力不可用、也没被告知本地图片
 * 可以嵌进回复显示，于是自己去 `npx -y @mermaid-js/mermaid-cli` 下载渲染器、
 * **整整超时 2 分钟**，最后手写了一个 SVG 落在工作区里 —— 用户界面上什么也没看到，
 * 得到的结论是「图片输出功能没成功」。
 *
 * 所以这里有两件事必须由宿主**确定性**地讲清楚：
 *  1. 这个配置档能不能出图（不能就直说，并给出设置路径，别让模型去找渲染器）；
 *  2. 本地生成的图片/图示怎么让用户在对话里直接看到（markdown 图片，面板会渲染）。
 */

/** 用户这句话是不是在要一张图（而不是要代码、要解释）。 */
const IMAGE_NOUN = '图|图片|配图|插画|插图|画面|海报|封面|头像|图标|logo|示意图|原理图|架构图|流程图|思维导图';

const IMAGE_REQUEST_PATTERNS: readonly RegExp[] = [
  // 动词 + 量词 + 图片名词：「画一张」「生成一张图」「出张图」「来个配图」…
  new RegExp(`(?:画|绘制|生成|做|出|来|整|弄|搞)\\s*(?:一|两|三|几)?\\s*(?:张|幅|个|份)?\\s*(?:${IMAGE_NOUN})`, 'i'),
  // 「画一张 X」后面直接接内容的说法（「画一张在雨里的猫」）：
  // 只认 张 / 幅 这种图片量词，「画一个表格」不算。
  /(?:画|绘制)\s*(?:一|两|三|几)?\s*(?:张|幅)\s*[^。！？\n]{1,25}/,
  // 名词在前：「图片生成」「海报设计」…
  /(?:图片|插图|插画|海报|封面|头像|图标|示意图|原理图|架构图|流程图)\s*(?:生成|绘制|设计)/i,
  // 请求语气 + 图片名词，且名词要**收尾**（后面是标点/结尾）：
  // 「给我这个 skill 的原理图」算，而「帮我看看这个图片路径配置」不算。
  new RegExp(`(?:给我|帮我|我要|我想要|想要|需要|来一?[个张]|出)[^。！？\\n]{0,20}?(?:${IMAGE_NOUN})(?=[。！？\\s]|$|[，,、])`, 'i'),
  // 英文：必须是指令式的开头，或「please / could you + 动词」，或「动词 + 图片名词」。
  // 只写 `draw ... a` 会把「how to draw a chart in css」也算成要图。
  /^(?:please\s+)?(?:draw|sketch|paint|illustrate)\b/i,
  /\b(?:please|could you|can you|would you)\b[^.\n]{0,40}\b(?:draw|sketch|paint|illustrate|generate|create|make)\b/i,
  /\b(?:generate|create|make|produce|draw)\s+(?:an?\s+|me\s+)?(?:image|picture|illustration|drawing|poster|logo|icon|avatar|artwork)\b/i,
  /\bimage\s+generation\b/i,
];

/**
 * 判断用户是否在图。
 *
 * 宁可漏判也不要误判：误报会在每次普通提问后弹一条「没有图片模型」的提示，
 * 那会训练用户无视提示。所以只认**明确的出图动词 + 图片名词**组合。
 */
export function looksLikeImageRequest(text: string | undefined): boolean {
  const value = String(text ?? '').trim();
  if (!value || value.length > 2000) return false;
  // 明确在说代码/命令时不算要图（「写一段画图的代码」「how to draw a chart in css」）。
  // 注意 `\b` 只对 ASCII 有用：`脚本\b` 永远匹配不上（CJK 属于非单词字符，边界判断
  // 不成立），所以中文与英文分两条写，别把两者塞进同一个 `…\b`。
  if (/(?:代码|脚本|函数|组件|命令)/.test(value)) return false;
  if (/\b(?:code|script|function|component|command|css|scss|html)\b/i.test(value)) return false;
  return IMAGE_REQUEST_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 给模型的图片能力说明。**每次请求都重新拼**：用户可能中途去设置里填上图片模型，
 * 下一轮就该立刻可用；反之清空了下一轮就不能再调用。
 *
 * @param imageModel 当前配置档的出图模型名（空 = 这个配置档不出图）
 */
export function imageCapabilityPrompt(imageModel: string | undefined, language: 'zh' | 'en' = 'zh'): string {
  const model = String(imageModel ?? '').trim();
  if (language === 'en') {
    return model
      ? [
        `Image output is available (model: ${model}). Use generate_image when the user asks for a picture, illustration, poster, icon or avatar.`,
        'Any local image file you produced or found in the workspace (svg, png, jpg, webp) can be shown inline in your reply: put `![caption](relative/path.ext)` on its own line. Prefer that over only saving a file and describing it.',
      ].join('\n')
      : [
        'Image output is NOT configured: this API profile has no image model, so there is no image-generation tool. When the user asks for a picture, say so in one short line and point them to Settings → Connection → Image model.',
        'Do not try to install or download rendering tools (mermaid-cli, puppeteer/chromium, rsvg-convert, ImageMagick) to satisfy such a request — that burns minutes and usually times out.',
        'A local image file you produced or found in the workspace (svg, png, jpg, webp) can still be shown inline: put `![caption](relative/path.ext)` on its own line.',
      ].join('\n');
  }
  return model
    ? [
      `图片输出可用（图片模型：${model}）。用户要图、插图、海报、图标、头像时，用 generate_image 生成。`,
      '你自己生成或在工作区里找到的本地图片（svg / png / jpg / webp）可以直接显示在回复里：把 `![说明](相对路径)` 单独放一行，面板会把它渲染成图片。不要只保存文件再口头描述。',
    ].join('\n')
    : [
      '图片输出尚未配置：当前接口配置档没有「图片模型」，因此没有出图工具。用户要图时，用一句话说明这一点，并告诉他去「设置 → 连接 → 图片模型」填写。',
      '不要为了满足这种请求去安装或下载渲染器（mermaid-cli、puppeteer/chromium、rsvg-convert、ImageMagick）——那会浪费好几分钟而且通常会超时。',
      '你自己生成或在工作区里找到的本地图片（svg / png / jpg / webp）仍然可以显示：把 `![说明](相对路径)` 单独放一行即可。',
    ].join('\n');
}
