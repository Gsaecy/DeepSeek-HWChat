import * as vscode from 'vscode';
import { readSettings } from './settings';
import { ConversationStorage } from './storage';
import { CleanupResult } from './types';

export class CleanupScheduler implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<CleanupResult> | undefined;

  constructor(
    private readonly storage: ConversationStorage,
    private readonly output: vscode.OutputChannel,
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
    this.running = this.storage.cleanup({
      historyRetentionDays: settings.historyRetentionDays,
      taskCacheRetentionHours: settings.taskCacheRetentionHours,
      cacheBudgetMB: settings.cacheBudgetMB,
      protectedConversationIds: this.protectedConversationIds(),
    });
    try {
      const result = await this.running;
      this.output.appendLine(
        `[cleanup] compacted=${result.compactedMessages} deleted=${result.deletedConversations} bytes=${result.bytes}`,
      );
      this.onComplete(result);
      if (verbose) {
        void vscode.window.showInformationMessage(
          `HWChat 清理完成：瘦身 ${result.compactedMessages} 条消息，删除 ${result.deletedConversations} 个过期对话。`,
        );
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
