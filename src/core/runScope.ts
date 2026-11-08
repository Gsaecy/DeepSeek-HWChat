/**
 * 「这次运行 / 这段草稿，还是当前那一份吗？」
 *
 * 架构评审 ⑨：面板里有两条异步链，结果落地时**没有校代次**。
 *
 * 1. **运行归属**。一轮 agent 结束时会 `runs.delete(conversationId)`，并按
 *    conversationId 结算审批卡片与方案卡片。这些收尾动作都是 `await` 之后才跑的：
 *    期间如果同一对话已经起了新的一轮（或被别处重新登记），旧 run 的收尾会把
 *    **新 run 的登记删掉**、把新 run 正等着的审批卡按「已过期」结算。
 *    表现是界面上「停止 → 立刻再发」之后运行圆点消失、卡片点了没反应。
 *    判据只能是对象身份：`this.runs.get(id) === run`。
 *
 * 2. **草稿归属**。`pendingAttachments` / `pendingContext` 属于「当前这条对话」，
 *    但附件来源都要先 `await`（文件对话框、剪贴板解码、从磁盘重读）。
 *    用户在这期间切到别的对话，结果仍会推进**新对话**的草稿 —— 给 A 选的图/文件
 *    悄悄挂到 B 上，然后被 B 一起发给模型。
 *    判据是代次：`activeConversationId` 每变一次 +1，异步链落地前对一次。
 */

/**
 * 单调递增的代次。
 *
 * 为什么不用 `activeConversationId` 直接比：切走再切回来（A → B → A）时对话 id
 * 又变回 A，只比 id 会把中间那次切换当成没发生，图仍会挂错。
 */
export class EpochGuard {
  private value = 0;

  /** 当前代次。异步链在开始时记下它。 */
  get current(): number {
    return this.value;
  }

  /** 状态换了一份：让所有在飞的结果作废。 */
  bump(): number {
    this.value += 1;
    return this.value;
  }

  /** 记下的代次已经过期（中间换过）。 */
  isStale(epoch: number): boolean {
    return epoch !== this.value;
  }
}

/**
 * 生成一轮运行的标识。
 *
 * 只用于「归属」与日志关联，不参与任何安全判定，所以不需要密码学强度；
 * 带上对话 id 是为了在日志里一眼看出是哪条对话的那一轮。
 */
export function makeRunId(conversationId: string, sequence: number, stamp = Date.now()): string {
  return `${conversationId}#${stamp.toString(36)}-${sequence}`;
}
