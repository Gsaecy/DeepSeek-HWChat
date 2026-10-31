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
    // 启动时的「归档守护」检查：有归档对话无故消失就必须让用户看见，
    // 而不是等他自己在历史列表里发现少了东西。
    const integrity = await this.storage.initialize().then(() => this.storage.takeIntegrityAlert());
    if (integrity?.missing.length) {
      const titles = integrity.missing.slice(0, 5).map((item) => `· ${item.title}`).join('\n');
      this.output.appendLine(
        `[cleanup] integrity: ${integrity.missing.length} 条归档对话不在磁盘、也不在回收站 `
        + integrity.missing.map((item) => item.id).join(','),
      );
      void vscode.window.showWarningMessage(
        tt('integrity.archivedMissing', { count: integrity.missing.length })
        + (titles ? `\n${titles}` : ''),
      );
    }
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
         * 说清「到底动了什么」。
         *
         * 清理只做两件事：瘦身缓存、整理没有任何消息的空对话。带内容的对话一条都不会
         * 消失（用户报告丢数据之后定下的规则），所以文案里不能再出现「删除 N 个对话」，
         * 否则用户会以为又有东西被清掉了。超预算只提示，不代替用户做决定。
         */
        const draftsHint = result.deletedConversations > 0 ? tt('cleanup.draftsHint', { count: result.deletedConversations }) : '';
        const budgetHint = result.overBudget
          ? tt('cleanup.overBudget', {
            size: `${(result.bytes / 1024 / 1024).toFixed(1)} MB`,
            budget: `${readSettings().cacheBudgetMB} MB`,
          })
          : '';
        const message = tt('cleanup.doneVerbose', { compacted: result.compactedMessages }) + draftsHint + budgetHint;
        if (result.overBudget) {
          // 超预算时给一个直接入口：清理是用户的决定，但至少别让他去找设置在哪。
          void vscode.window.showInformationMessage(message, tt('cleanup.openSettings')).then((choice) => {
            if (choice) void vscode.commands.executeCommand('hwchat.openSettings');
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
