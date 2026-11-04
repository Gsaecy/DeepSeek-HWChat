/**
 * 「按任务类型指定首选工具」——由宿主决定该用哪个工具，而不是让模型去猜。
 *
 * 为什么需要（真实故障，全部发生在同一天）：
 *  - 用户说「先给我预览一下效果」，模型选了桥接工具 `run_in_terminal` 起静态服务器。
 *    那个工具要求 chat 调用上下文，在 HWChat 里永远失败（见 `bridgedTools.ts`），
 *    接着三轮失败整轮停机。
 *  - 用户说「优化图片，生成新图片发给我」，模型自己去 `npx` 装 mermaid-cli（超时 2 分钟），
 *    手写 SVG 落盘，对话框里什么也没出现。
 *  - 用户说「提交/推送」，模型换着写法撞 git 闸门。
 *
 * 共同点：这几类任务的**执行路径是固定的**，完全可以由代码写死 —— 让模型去"想该用什么
 * 工具"只会引入不确定性。所以这里把「任务类型 → 首选工具序列」写成数据，
 * 由面板在**发送时**判定并强制：
 *
 *  1. `directive` 以宿主口吻拼进系统提示词最前面（不是建议，是本轮的执行约定）；
 *  2. `allowed` 用于**收窄工具清单** —— 清单里没有的工具，模型连选的机会都没有；
 *  3. `blocked` 用于**执行期硬拒** —— 万一模型凭记忆硬调，直接返回拒绝并指出首选工具。
 *
 * 收窄的边界（安全阀）：只读工具与元工具**永远保留**。用户说「预览一下」不该连
 * 「读代码」都被拿走；而写工具是否收窄还要看用户这句话里有没有写意图 ——
 * 「预览效果顺便把标题改大」必须仍然能改。
 */

export type ToolPlaybookKind = 'web-preview' | 'image-generation' | 'git-write';

export interface ToolPlaybook {
  kind: ToolPlaybookKind;
  /** 首选工具，**按执行顺序**排列（宿主指定，不是建议）。 */
  preferred: readonly string[];
  /** 这类任务里绝不该出现的工具；模型硬调用时会被拒绝。 */
  blocked: readonly string[];
  /** 收窄后仍然允许的工具（只读与元工具另有白名单，不必在这里重复）。 */
  allowed: readonly string[];
  /** 宿主口吻的指令，直接拼进系统提示词。 */
  directive: string;
  /** 这类任务是否收窄写工具（用户明确要改东西时为 false）。 */
  narrowWrites: boolean;
}

/**
 * 永远保留的工具：只读 + 元工具。
 *
 * 为什么保留只读：任何任务都可能需要先看代码；把它们拿走只会让模型瞎猜。
 * 为什么保留元工具：清单、方案决策、技能加载属于"怎么干活"的基础设施，
 * 与具体任务类型无关。
 */
const ALWAYS_ALLOWED: readonly string[] = [
  // 元工具
  'update_todos', 'ask_user_choice', 'load_skill', 'search_conversation_history',
  // 只读
  'list_workspace_roots', 'list_directory', 'list_files', 'search_files', 'read_file',
  'open_file', 'get_diagnostics',
  // 预览（只读性质）
  'open_web_preview', 'open_text_preview', 'open_markdown_preview', 'open_diff_preview',
];

/** 写意图：出现这些词就说明用户要动文件，此时不缩写工具。 */
const WRITE_INTENT = /(?:改|修|加|删|写|创建|新建|重命名|替换|实现|重构|生成文件|保存到|落盘)|\b(?:fix|add|remove|delete|write|create|rename|replace|refactor|implement|edit)\b/i;

export function hasWriteIntent(text: string | undefined): boolean {
  const value = String(text ?? '');
  if (!value.trim()) return false;
  // 「只读」类的明确否定：用户说了「别改 / 不要修改」时不算写意图。
  if (/(?:别|不要|不用|无需|不许)\s*(?:改|修改|动|写|创建|删)/.test(value)) return false;
  if (/(?:只|仅)\s*(?:看|读|预览|展示)/.test(value)) return false;
  return WRITE_INTENT.test(value);
}

/* ── 任务类型判定 ───────────────────────────────────────────────────── */

/** 「预览」：UI/网页/效果这类词，或「起本地服务」。排除「预览图片」那种。 */
function isWebPreviewRequest(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  // 明确在说图片：那是 image-generation 的地盘。
  if (/(?:预览|看).{0,4}(?:图|图片|海报|插画)/.test(value)) return false;
  if (/(?:预览|预览一下|先预览|看看效果|看一下效果|看下效果|看看页面|跑起来看看)/.test(value)) return true;
  if (/(?:起|启动|跑起来|开)(?:一个|个)?\s*(?:本地|静态|开发)?\s*(?:服务|服务器|端口)/.test(value)) return true;
  if (/\b(?:localhost|127\.0\.0\.1)(?::\d+)?\b/.test(value) && /(?:打开|看看|预览|open)/i.test(value)) return true;
  return false;
}

/** 「要一张图」：与 `imageRequest.looksLikeImageRequest` 保持同一套判定，避免两处漂移。 */
function isImageGenerationRequest(text: string, looksLikeImage: (value: string) => boolean): boolean {
  return looksLikeImage(text);
}

/** 「git 写操作」：用户明确要求提交 / 推送 / 打 tag。 */
function isGitWriteRequest(text: string): boolean {
  return /(?:提交|推送|commit|push|打\s*tag|打个\s*tag|发布到\s*github)/i.test(text)
    && !/(?:不要|别|不用|无需)\s*(?:提交|推送|commit|push)/i.test(text);
}

/* ── 首选工具的具体写法（宿主口吻） ─────────────────────────────────── */

const WEB_PREVIEW_PLAYBOOK: ToolPlaybook = {
  kind: 'web-preview',
  preferred: ['run_command', 'open_web_preview'],
  blocked: [],
  allowed: ['run_command', 'open_web_preview'],
  narrowWrites: true,
  directive: [
    '## 本轮任务类型：本地预览（宿主已指定执行路径）',
    '按这个顺序做，不要换工具、不要猜：',
    '1. `run_command`，参数 `{"command":"<启动命令>","cwd":"<目录>","background":true}` —— 常驻命令必须带 `background: true`，它会立刻返回并给出后台 id。',
    '2. `open_web_preview`，参数 `{"url":"http://127.0.0.1:<端口>/"}` —— 端口取第 1 步实际用的那个。',
    '3. 回复里写清：访问地址、怎么停止（`kill <pid>` 或让我停掉后台 id）。',
    '禁止：`run_in_terminal` 等桥接终端工具（需要 chat 调用上下文，在这里永远失败）；用超时去"等"服务器。',
    '如果启动命令自己退出了，把它的输出原样读一遍再换方案 —— 最常见原因是端口被占用。',
  ].join('\n'),
};

const IMAGE_PLAYBOOK: ToolPlaybook = {
  kind: 'image-generation',
  preferred: ['generate_image'],
  blocked: [],
  allowed: ['generate_image', 'read_file', 'run_command'],
  narrowWrites: false,
  directive: [
    '## 本轮任务类型：生成图片（宿主已指定执行路径）',
    '要一张新图时直接调 `generate_image`（参数：`prompt` 必填，`size` 可选），生成结果会作为附件显示在这条回复里。',
    '禁止：`npx` 安装渲染器（mermaid-cli / puppeteer / rsvg-convert / ImageMagick）—— 实测会超时并浪费好几分钟；手写 SVG"当作图片"发出来也不算完成。',
    '如果当前没有可用的图片模型，用一句话说明并指出「设置 → 连接 → 图片模型」，不要自己造替代方案。',
  ].join('\n'),
};

const GIT_WRITE_PLAYBOOK: ToolPlaybook = {
  kind: 'git-write',
  preferred: ['run_command'],
  blocked: [],
  allowed: ['run_command'],
  narrowWrites: false,
  directive: [
    '## 本轮任务类型：git 写操作（宿主已指定执行路径）',
    '所有 git 写操作都通过 `run_command` 执行，并**显式传 `cwd`**（本次对话所属的项目根）：',
    '`{"command":"git ...","cwd":"<项目根>"}`。',
    '禁止：`git -C <别的路径>`、`cd <别的项目> && git ...`、桥接终端工具 —— 这些会跨项目提交，或在 HWChat 里根本调不通。',
    '先 `git status --short` 看清要提交什么；版本号不要自己改。',
  ].join('\n'),
};

/**
 * 判定本轮属于哪几种任务类型，并给出对应的执行约定。
 *
 * 可以同时命中（例如「先预览，然后把代码提交了」），按固定顺序返回，
 * 调用方把 directives 顺次拼进提示词、把 allowed 取并集。
 */
export function detectPlaybooks(
  text: string | undefined,
  options: { looksLikeImage?: (value: string) => boolean } = {},
): ToolPlaybook[] {
  const value = String(text ?? '');
  if (!value.trim()) return [];
  const looksLikeImage = options.looksLikeImage ?? (() => false);
  const playbooks: ToolPlaybook[] = [];
  if (isWebPreviewRequest(value)) playbooks.push(WEB_PREVIEW_PLAYBOOK);
  if (isImageGenerationRequest(value, looksLikeImage)) playbooks.push(IMAGE_PLAYBOOK);
  if (isGitWriteRequest(value)) playbooks.push(GIT_WRITE_PLAYBOOK);
  return playbooks;
}

/**
 * 收窄工具清单：清单里没有的工具模型连选的机会都没有。
 *
 * @param names 已经组装好的工具名（原生 + 桥接 + 额外工具）
 * @param playbooks 本轮命中的任务类型
 * @param writingRequested 用户这句话是否包含写意图（true 时不做写侧收窄）
 */
export function narrowToolNames(
  names: readonly string[],
  playbooks: readonly ToolPlaybook[],
  writingRequested: boolean,
): string[] {
  if (!playbooks.length) return [...names];
  const narrowing = playbooks.filter((playbook) => !playbook.narrowWrites || !writingRequested);
  if (!narrowing.length) return [...names];
  const keep = new Set<string>(ALWAYS_ALLOWED);
  for (const playbook of narrowing) {
    for (const name of playbook.allowed) keep.add(name);
    for (const name of playbook.preferred) keep.add(name);
  }
  // 命中多类任务时，任一类把它标成 blocked 也不算数 —— 只按 allowed 收窄，
  // 因为「同时在预览和提交」这种组合下 blocked 会互相打架。
  const kept = names.filter((name) => keep.has(name));
  // 收窄后如果一个工具都不剩，说明白名单配错了；宁可放弃收窄，也别让模型无工具可用。
  return kept.length ? kept : [...names];
}

/**
 * 执行期硬拒：模型凭记忆调了本轮不该用的工具时，明确告诉它该用哪个。
 *
 * 返回 undefined 表示放行。
 */
export function blockedToolReason(
  name: string,
  playbooks: readonly ToolPlaybook[],
  writingRequested: boolean,
): string | undefined {
  for (const playbook of playbooks) {
    if (!playbook.blocked.includes(name)) continue;
    if (playbook.narrowWrites && writingRequested) continue;
    return `本轮任务类型是「${playbook.kind}」，不该用 ${name}；请改用 ${playbook.preferred.join(' → ')}。`;
  }
  return undefined;
}
