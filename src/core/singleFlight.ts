/**
 * 「同一时刻只跑一份，跑完再补一次」。
 *
 * 真实故障：连点「新建对话」/ 快速切对话会在几百毫秒内触发多次状态推送，
 * 每次都要读对话列表 + 读首页 80 条消息 + 序列化约 3MB 推到 webview。
 * 旧实现让它们并发跑，界面在那段时间里完全没反应，用户只能重载窗口。
 *
 * 语义（这三条是重点，改实现时必须保持）：
 *  1. 空闲时调用 = 立刻执行；
 *  2. 执行中调用 = 不排队、不并发，只记一个脏标记；
 *  3. 跑完后若有脏标记，**再执行一次**（带上期间的所有变化），保证最后一次请求的结果一定被送出。
 *
 * 为什么不是简单的「丢弃后来的请求」：那样最后一次点击可能被丢掉，
 * 界面就会停在旧画面上——正是我们要修的症状。
 */
export class SingleFlight {
  private running: Promise<void> | undefined;
  private pending = false;
  /** 实际执行次数（只用于测试与诊断，不参与逻辑）。 */
  private runs = 0;

  constructor(private readonly task: () => Promise<void>) {}

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  get executionCount(): number {
    return this.runs;
  }

  run(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return this.running;
    }
    this.running = this.execute();
    return this.running;
  }

  private async execute(): Promise<void> {
    try {
      do {
        this.pending = false;
        this.runs += 1;
        await this.task();
        // 单次任务失败不能让后续请求卡死：清掉运行标记，让下一次调用重新开始。
      } while (this.pending);
    } finally {
      this.running = undefined;
    }
  }
}
