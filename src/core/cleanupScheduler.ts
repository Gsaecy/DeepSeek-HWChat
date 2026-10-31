import * as vscode from 'vscode';
import { readSettings } from './settings';
import { tt } from './i18n';
import { ConversationStorage } from './storage';
import { CleanupResult } from './types';

export class CleanupScheduler implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<CleanupResult> | undefined;
  /**
   * 本进程是否已经报过一次「首次扫描」。
   *
   * 首次扫描一定是满的（增量记账只在内存里，新窗口没有基线，实测 19.29MB 历史约 118ms），
   * 之后每 10 分钟只重扫「自上次以来被写过」的对话（0.7–1.0ms）。所以日志策略是：
   *  - 真的瘦身/删除了 → 每次都写一行；
   *  - 每个进程的第一次 → 写一行，带上 `scanned=` 与耗时（用来确认它跑过、以及首扫成本）；
   *  - 其余「什么都没变」的心跳 → 一个字都不写。
   *
   * 旧实现无差别每 10 分钟写一行 `compacted=0 deleted=0 bytes=…`，字节数一模一样，
   * 反而让人以为它一直在扫 20MB。
   */
  private reportedFirstScan = false;

  constructor(
    private readonly storage: ConversationStorage,
    private readonly output: Pick<vscode.OutputChannel, 'appendLine'>,
    private readonly protectedConversationIds: () => string[],
    private readonly onComplete: (result: CleanupResult) => void,
  ) {}

  start(): void {
    this.stopTimer();
    const minutes = readSettings().cleanupIntervalMinutes;
    this.timer = setInterval(() => void this.run(false), minutes * 60 * 1000);
    this.timer.unref?.();
  }

  async run(verbose: boolean): Promise<CleanupResult> {
    if (this.running) {
      return this.running;
    }
    const settings = readSettings();
    const startedAt = Date.now();
    this.running = this.storage.cleanup({
      historyRetentionDays: settings.historyRetentionDays,
      taskCacheRetentionHours: settings.taskCacheRetentionHours,
      cacheBudgetMB: settings.cacheBudgetMB,
      protectedConversationIds: this.protectedConversationIds(),
    });
    try {
      const result = await this.running;
      const changed = result.compactedMessages > 0 || result.deletedConversations > 0;
      const firstScan = !this.reportedFirstScan;
      this.reportedFirstScan = true;
      if (changed || verbose || firstScan) {
        this.output.appendLine(
          `[cleanup] scanned=${result.scannedConversations ?? 0} compacted=${result.compactedMessages} `
          + `deleted=${result.deletedConversations}`
          + `${result.prunedDrafts ? `（其中空残骸 ${result.prunedDrafts}）` : ''}`
          + ` bytes=${result.bytes} took=${Date.now() - startedAt}ms`
          + `${firstScan ? '（本窗口首次扫描；之后只重扫有改动的对话）' : ''}`,
        );
      }
      this.onComplete(result);
      if (verbose) {
        /*
         * 说清「删到哪里去了」。
         *
         * 以前这句只写「删除 N 个过期对话」，用户看到的是对话凭空消失；现在它们都在
         * 回收站里，能通过命令找回 —— 提示必须带上这条出路，否则等于没修。
         */
        const restoreHint = result.deletedConversations > 0 ? tt('cleanup.trashHint', { count: result.deletedConversations }) : '';
        const message = tt('cleanup.doneVerbose', { compacted: result.compactedMessages, deleted: result.deletedConversations })
          + restoreHint;
        if (result.deletedConversations > 0) {
          // 提示里只写命令名等于把找回藏在命令面板里。给一个按钮：清理完当场就能点。
          void vscode.window.showInformationMessage(message, tt('cleanup.restoreAction')).then((choice) => {
            if (choice) void vscode.commands.executeCommand('hwchat.restoreDeletedConversations');
          });
        } else {
          void vscode.window.showInformationMessage(message);
        }
      }
      return result;
    } finally {
      this.running = undefined;
    }
  }

  restart(): void {
    this.start();
  }

  dispose(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
