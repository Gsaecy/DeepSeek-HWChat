/**
 * 运行中「新消息暂停」通道。
 *
 * 用户的要求（原话）：「每次新发送消息，正在执行的任务会被暂停，然后综合分析新消息，
 * 再调整任务清单和任务。」
 *
 * 为什么不能只靠任务队列：队列的 `take()` 只在每个小任务边界被调用。模型正在生成
 * 一大段回答时，新消息要等到那个边界才被读到 —— 几十秒里 agent 仍按旧计划往下写，
 * 用户看到的就是「没理我」。这个通道只负责**打断正在生成的那一段**：面板发消息时
 * `request()`，`AgentRunner` 把 `signal` 合并进这次流式请求；请求被取消后识别为
 * 「暂停」而不是失败，回到循环顶部由任务队列把新消息交给模型重新评估。
 *
 * 工具执行**不**走这条信号：写到一半的命令被强杀可能留下半成品，代价比多等几秒大得多。
 *
 * 每次消费都换一把新锁 —— 一个 `AbortSignal` 一旦 abort 就永久保持 aborted，
 * 不换锁的话第二次新消息就再也暂停不了。
 */
export class AgentSteering {
  private controller = new AbortController();
  private pending = 0;

  /** 用户发来新消息：尽快停下手上的生成。重复调用只会合成一次暂停。 */
  request(): void {
    this.pending += 1;
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  /** 当前这一段生成要听的信号。 */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 有没有还没被消费的暂停请求。 */
  hasPending(): boolean {
    return this.pending > 0;
  }

  /**
   * 消费一次暂停请求并换一把新锁。
   *
   * 返回 true 表示「刚才那次中断确实是新消息引起的」，调用方应当把它当成暂停而不是失败。
   */
  consume(): boolean {
    if (!this.pending) return false;
    this.pending = 0;
    this.controller = new AbortController();
    return true;
  }
}
