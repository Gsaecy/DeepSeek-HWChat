/**
 * VS Code 桥接工具里**注定调不通**的那几个，以及它们的替代方案。
 *
 * 真实故障（用户 2026-11-04，附执行记录）：让 agent「先给我预览一下效果」，它调用
 * `run_in_terminal` 启动本地静态服务器，返回：
 *
 *     Invocation context must be provided for this tool
 *
 * 紧接着两次「换条路写日志」都被路径隔离拦住，凑满 3 轮失败 → 整轮停机。用户看到的
 * 就是「经常调用 vs code 工具失败」。
 *
 * **根因在 VS Code 侧，不在 HWChat 的参数上**。`run_in_terminal` 的实现（Workbench
 * 打包产物里能直接读到）是：
 *
 *     async invoke(e, t, i, n) {
 *       let r = e.toolSpecificData;
 *       if (!r) throw new Error("toolSpecificData must be provided for this tool");
 *       if (!e.context) throw new Error("Invocation context must be provided for this tool");
 *       ...
 *       this._getSandboxPrecheckInputs(e.context.sessionResource, e.chatRequestId)
 *
 * 而 `lm.invokeTool` 的公开参数只有 `{ input, toolInvocationToken, tokenizationOptions }`
 * —— `toolSpecificData` 与 `context` 都传不进去，`toolInvocationToken` 也只能从
 * `ChatRequest` 里拿到（HWChat 是独立面板，不是 chat participant，没有 ChatRequest）。
 *
 * 官方 `vscode.d.ts` 对此的说明是「outside of a chat request, `undefined` should be passed」，
 * 也就是「一般工具可以」，但**具体工具可以自己要求上下文**，`run_in_terminal` 就是这种。
 *
 * 结论：这类工具在 HWChat 里**永远不可能成功**。继续把它摆在模型面前，只会每次白烧
 * 一轮、并把它算进「连续失败」预算。正确处理是：
 *  1. 不下发（`definitions()` 过滤掉）；
 *  2. 万一模型凭记忆硬调，返回一条**确定性**说明 + 替代方案（原生 `run_command`），
 *     并记进本次会话的不可用集合，之后不再下发；
 *  3. 这条说明要写清「不是权限问题、不是路径问题」，否则模型会去改参数重试。
 */

/**
 * 已知需要「chat 调用上下文」的桥接工具。
 *
 * 只收**确认过实现**的名字：多列一个是白丢能力，少列一个只是多烧一轮（运行期还能学到）。
 *
 * `copilot_replaceString` / `copilot_multiReplaceString` 的确认依据（VS Code 自带
 * 的 `extensions/copilot/dist/extension.js`，2026-11-07 实读）：
 *
 *     async resolveInput(e, n) { return this._promptContext = n, e }
 *     async _prepareEditsForFile(e, n) {
 *       …
 *       if (!n.filePath || n.oldString === void 0 || n.newString === void 0 || !this._promptContext)
 *         throw this.sendReplaceTelemetry("invalidStrings", …), new Error("Invalid input");
 *
 * `_promptContext` 由 `resolveInput` 的第二个参数赋值，也就是**聊天请求上下文**；
 * `lm.invokeTool` 的公开参数只有 `{ input, toolInvocationToken }`，传不了它。
 * 所以这两个工具在 HWChat 里**永远**只会回一句 `Invalid input`（用户 2026-11-07 的真实报错），
 * 而 HWChat 有原生的 `replace_in_file` / `write_file`，能力不缺。
 */
const KNOWN_NEEDS_CHAT_CONTEXT: readonly string[] = [
  'run_in_terminal',
  'copilot_replaceString',
  'copilot_multiReplaceString',
];

/**
 * 这条错误是不是「缺少 chat 调用上下文」这一类。
 *
 * 除了 VS Code 明确写出的两句，还要认那一句**光秃秃的** `Invalid input` ——
 * 它来自上面那个 `!this._promptContext` 分支，和真实的参数错误共用同一句话。
 * 所以只在「这个工具是已知/已学到需要上下文」时才这样判定：
 * 对别的工具，`Invalid input` 仍然按普通错误原样上报，不会被吞掉。
 */
export function isMissingChatContextError(message: string, toolName?: string): boolean {
  if (/invocation context must be provided/i.test(message)) return true;
  if (/toolSpecificData must be provided/i.test(message)) return true;
  if (toolName && needsChatContext(toolName) && /^invalid input\.?$/i.test(message.trim())) return true;
  return false;
}

/** 这些工具是不是「编辑类」——替代方案要说 `replace_in_file`，而不是 `run_command`。 */
function isEditTool(name: string): boolean {
  return /replaceString|multiReplace|insertEdit|applyPatch|createFile/i.test(name);
}

/**
 * 这个桥接工具是不是已知调不通的。
 *
 * @param name 工具名（`lm.tools` 里的原始名）
 * @param learned 本次会话里已经撞过上下文错误的工具（运行期学到的）
 */
export function needsChatContext(name: string, learned: ReadonlySet<string> = new Set()): boolean {
  return learned.has(name) || KNOWN_NEEDS_CHAT_CONTEXT.includes(name);
}

/**
 * 给模型的确定性说明。
 *
 * 三条信息缺一不可：**为什么不行**（不是你的参数问题）、**别再试**、**用什么代替**。
 * 少最后一条，模型就会去「换个写法」重试同一个工具。
 */
export function missingChatContextNotice(toolName: string): string {
  if (isEditTool(toolName)) {
    /*
     * 编辑类要给**能照着做**的替代：多文件多处替换就按顺序多次调 `replace_in_file`，
     * 大段重构可以直接 `write_file` 整份重写。否则模型会去改参数重试同一个工具。
     */
    return [
      `工具 ${toolName} 在 HWChat 里无法调用：它要求 VS Code 聊天请求的调用上下文（promptContext），`,
      '而 HWChat 是独立面板，`lm.invokeTool` 的公开参数里传不了它 —— 这不是权限、路径或参数格式的问题，',
      '改参数、拆成更小的替换、或换一个 oldString 都不会成功，**不要重试**。',
      '改文件请用原生工具：`replace_in_file`（一处一次，需要改 N 处就按顺序调用 N 次）或 `write_file`（整份重写）。',
    ].join('');
  }
  return [
    `工具 ${toolName} 在 HWChat 里无法调用：它要求 VS Code 聊天请求的调用上下文（toolSpecificData + context），`,
    '而 HWChat 是独立面板，`lm.invokeTool` 的公开参数里没有这两项 —— 这不是权限、路径或参数格式的问题，',
    '改参数或换命令写法都不会成功，**不要重试**。',
    '需要执行命令时请用原生 `run_command`（它支持 cwd、超时与后台运行）；需要预览网页时用 `open_web_preview`。',
  ].join('');
}
