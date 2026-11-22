/**
 * 工具清单裁剪：只在真正需要时才把「VS Code 扩展提供的桥接工具」下发给模型。
 *
 * 用户 2026-11-22 的疑问：「Copilot Chat 我也用的 DeepSeek 模型，还是很流畅的，
 * HWChat 却很难用」。除了模型本身，最直接的差别就在**工具清单**：
 *
 *  - Copilot Chat 只给模型一份**精选**工具（十几个），名字短、schema 小；
 *  - HWChat 之前把 VS Code 里**所有**扩展注册的语言模型工具都转成 `hwchat_vscode_*`
 *    一起下发（上限写成 400，等于不设限）。装了 Copilot / Git / 其它扩展之后，
 *    一次请求里可能多出几十个工具、上万字符的 JSON schema。
 *
 * 后果不是「多花点 token」而已：模型要在几十个候选里挑一个，挑错的概率随数量上升，
 * 而且很多桥接工具在 HWChat 的调用上下文里**根本调不通**（见 `bridgedTools.ts`），
 * 挑中就是一轮白烧。这与「省 token、不要错误调用」是同一件事。
 *
 * 所以这里按「用户这句话到底需不需要扩展能力」决定：
 *  - 提到浏览器 / 预览 / 终端 / 扩展 / 符号跳转这类**只有扩展才有的能力** → 照旧带上；
 *  - 其它情况（绝大多数编码任务）→ 只用原生工具，桥接工具全部隐去。
 *
 * 纯函数，便于单测。
 */

/** 桥接工具的 id 前缀（与 `vscodeTools.ts` 里的 `PREFIX` 必须一致）。 */
export const BRIDGED_TOOL_PREFIX = 'hwchat_vscode_';

/**
 * 「需要 VS Code 扩展能力」的判据。
 *
 * 刻意保守：只有明确指向**扩展侧能力**的词才命中。泛泛的「打开文件」不算 ——
 * 原生 `open_file` 已经能做；而「打开浏览器预览」属于扩展侧的 Simple Browser。
 */
const BRIDGE_INTENT = new RegExp([
  '(?:浏览器|简单浏览器|网页预览|预览页|预览界面|实时预览)',
  '\\b(?:browser|webview|simple browser|live preview)\\b',
  '(?:终端|集成终端|命令面板|符号跳转|转到定义|查找引用|重命名符号)',
  '\\b(?:terminal|command palette|go to definition|find references|rename symbol|symbols?)\\b',
  '(?:插件|扩展)(?:所)?(?:提供|自带)?(?:的|里|中)?(?:工具|命令|能力)',
  '\\b(?:extension|extensions)\\b[^.;!?]{0,12}\\b(?:tool|tools|command)\\b',
  '\\bTODO\\b|任务列表|任务面板',
].join('|'), 'i');

export function wantsBridgedTools(text: string | undefined): boolean {
  const value = String(text ?? '').trim();
  if (!value) return false;
  return BRIDGE_INTENT.test(value);
}

/**
 * 裁剪工具清单。
 *
 * @param names           全部可用工具名（原生 + 桥接）
 * @param bridgedRequested 本轮是否需要扩展侧能力（`undefined` = 未知，按需要处理）
 * @param max             清单上限；超出时**先砍桥接工具**，原生工具保留
 * @returns 裁剪后的清单；没砍掉任何东西时返回 `undefined`（表示「不限制」，与旧行为一致）
 */
export function trimToolSurface(
  names: readonly string[],
  options: { bridgedRequested?: boolean; max?: number } = {},
): string[] | undefined {
  const max = options.max ?? 28;
  const bridged = names.filter((name) => name.startsWith(BRIDGED_TOOL_PREFIX));
  const native = names.filter((name) => !name.startsWith(BRIDGED_TOOL_PREFIX));
  let kept = native;
  if (options.bridgedRequested === true) {
    kept = [...native, ...bridged.slice(0, Math.max(0, max - native.length))];
  }
  if (kept.length >= names.length) return undefined;
  return kept;
}
