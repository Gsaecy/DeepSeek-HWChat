import * as vscode from 'vscode';
import { ConversationStorage } from '../core/storage';
import { ConversationSummary } from '../core/types';
import { tt } from '../core/i18n';

export class HistoryViewProvider implements vscode.TreeDataProvider<ConversationSummary>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ConversationSummary | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly storage: ConversationStorage) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(conversation: ConversationSummary): vscode.TreeItem {
    const item = new vscode.TreeItem(conversation.title, vscode.TreeItemCollapsibleState.None);
    item.id = conversation.id;
    item.description = `${conversation.pinned ? tt('history.pinned') : ''}${relativeTime(conversation.updatedAt)}`;
    item.tooltip = new vscode.MarkdownString(
      [`**${escapeMarkdown(conversation.title)}**`, '', escapeMarkdown(conversation.preview || tt('history.emptyConversation'))].join('\n'),
    );
    item.iconPath = new vscode.ThemeIcon(conversation.pinned ? 'pinned' : 'comment-discussion');
    item.command = {
      command: 'hwchat.openChat',
      title: tt('history.open'),
      arguments: [conversation.id],
    };
    return item;
  }

  async getChildren(): Promise<ConversationSummary[]> {
    return this.storage.listConversations({ archived: false });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function relativeTime(value: number): string {
  const delta = Date.now() - value;
  if (delta < 60_000) {
    return tt('time.justNow');
  }
  if (delta < 3_600_000) {
    return tt('time.minutesAgo', { count: Math.floor(delta / 60_000) });
  }
  if (delta < 86_400_000) {
    return tt('time.hoursAgo', { count: Math.floor(delta / 3_600_000) });
  }
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value));
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, '\\$&');
}
