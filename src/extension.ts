import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from './agent/auditLog';
import { SkillRegistry } from './agent/skillRegistry';
import { ToolExecutor } from './agent/toolExecutor';
import { CleanupScheduler } from './core/cleanupScheduler';
import { getApiKey, storeApiKey } from './core/apiKeys';
import { describePermissionScope, formatPermissionScope, profileFor, readSettings } from './core/settings';
import { ConversationStorage } from './core/storage';
import { revertApprovalBridge, showApprovalBridge } from './core/vscodeApprovals';
import { DeepSeekClient } from './providers/deepseekClient';
import { ChatPanel } from './views/chatPanel';
import { SettingsPanel } from './views/settingsPanel';
import { tt } from './core/i18n';

let activeStorage: ConversationStorage | undefined;

/**
 * 激活。
 *
 * **这里刻意不做重活**（真实性能问题 + 官方指引）：`activationEvents` 已清空，
 * 于是扩展只在「打开 HWChat 面板」或「执行 hwchat.* 命令」时才激活——官方文档
 * （Activation Events：*It is best practice to activate only when a user needs your
 * extension*；且 1.74 起贡献的命令/视图无需显式声明）就是为了避免「装了扩展，
 * 每个窗口启动都被它读一遍磁盘」。
 *
 * 旧实现在激活时依次做了三件重活，而它们全都有按需路径：
 *   1. `await storage.initialize()`：把整份历史（本机 21MB / 600+ 条消息）读一遍、
 *      解析一遍、写回中断状态——实测 122ms CPU；
 *   2. `await skills.refresh()`：三条 `findFiles`（每次都是真实 ripgrep 全工作区遍历）；
 *   3. `await storage.stats()`：对所有消息文件 `stat` 一遍（只为了打一行日志，15ms）。
 * 现在它们都推迟到真正打开面板 / 发送消息时（`ConversationStorage` 的每个方法都会
 * 自行 `initialize()`），激活本身只剩注册命令、视图与事件。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('HWChat', { log: true });
  const storage = new ConversationStorage(join(context.globalStorageUri.fsPath, 'history-v1'));
  activeStorage = storage;

  const audit = new AuditLog(join(context.globalStorageUri.fsPath, 'agent-audit.jsonl'));
  const skills = new SkillRegistry(
    vscode.Uri.joinPath(context.globalStorageUri, 'skills'),
    vscode.Uri.file(join(homedir(), '.copilot', 'skills')),
    vscode.Uri.file(join(homedir(), '.copilot', '.skill-quick-launch.json')),
  );
  // 技能清单需要至少一次真实扫描（`sendState` 已不再每次扫描）。激活本身现在只在
  // 「用户打开面板 / 执行 hwchat.* 命令」时发生，所以这一次扫描落在正确的时机；
  // 之后 `SkillRegistry.refresh` 的 30 秒新鲜窗口与 single-flight 会挡掉重复调用。
  skills.onError = (error) => {
    output.warn(`[skills] 扫描失败（保留上一份清单）：${error instanceof Error ? error.message : String(error)}`);
  };
  await skills.refresh();
  const toolExecutor = new ToolExecutor(
    audit,
    () => vscode.workspace.isTrusted,
    // 结构化诊断：每次工具调用一行 JSON（不含命令正文、文件内容或凭据）。
    // 排查「CPU 100% / rg EAGAIN」时先看这里：activeSearches / pendingSearches
    // 与 durationMs 能直接指出是不是搜索在堆积。
    (event) => output.debug(`[tool] ${JSON.stringify(event)}`),
  );

  const logPermissionScope = (): void => {
    const report = describePermissionScope();
    for (const line of formatPermissionScope(report)) {
      output.info(line);
    }
  };
  logPermissionScope();

  const client = new DeepSeekClient((profileId) => getApiKey(context.secrets, profileId, profileId === 'default'));
  let settingsPanel!: SettingsPanel;
  const chat = new ChatPanel(
    context.extensionUri,
    context.globalStorageUri,
    storage,
    client,
    context.secrets,
    skills,
    toolExecutor,
    {
      onHistoryChanged: () => {
        void settingsPanel?.refresh();
      },
      openSettings: () => void settingsPanel.open(),
      ensurePrivacyConsent: () => ensurePrivacyConsent(context),
      log: (line) => output.debug(line),
    },
  );
  const scheduler = new CleanupScheduler(
    storage,
    output,
    () => chat.getProtectedConversationIds(),
    (result) => {
      // 什么都没变时不要再推一次全量状态（`sendState()` 仍然要读列表、读首页、发 3MB+ 的
      // 消息）。审计日志的维护与界面刷新解耦：它是 O(一次 stat) 的空跑，保持在每次心跳上。
      if (result.compactedMessages > 0 || result.deletedConversations > 0) {
        void chat.refresh();
        void settingsPanel?.refresh();
      }
      void audit.cleanup(readSettings().auditRetentionDays).catch((error) => {
        output.error(error instanceof Error ? error.message : String(error));
      });
    },
  );
  settingsPanel = new SettingsPanel(
    context.extensionUri,
    storage,
    client,
    context.secrets,
    skills,
    vscode.Uri.joinPath(context.globalStorageUri, 'skills'),
    {
      onChanged: () => {
        scheduler.restart();
        void audit.cleanup(readSettings().auditRetentionDays);
        void chat.refresh();
      },
      protectedConversationIds: () => chat.getProtectedConversationIds(),
      isAgentBusy: () => chat.isBusy(),
      clearAudit: () => audit.clear(),
    },
  );

  const chatView = vscode.window.registerWebviewViewProvider(ChatPanel.viewType, chat, {
    webviewOptions: { retainContextWhenHidden: true },
  });

  const commands: Array<[string, (...args: unknown[]) => unknown]> = [
    ['hwchat.openChat', (id?: unknown) => chat.open(typeof id === 'string' ? id : undefined)],
    ['hwchat.newChat', () => chat.newChat()],
    ['hwchat.openSettings', () => settingsPanel.open()],
    ['hwchat.askSelection', () => chat.openSelection('ask')],
    ['hwchat.explainSelection', () => chat.openSelection('explain')],
    ['hwchat.cleanupNow', () => scheduler.run(true)],
    /*
     * 恢复自动删除的对话。
     *
     * 自动清理（空草稿 / 超期 / 缓存预算回收）现在都先把对话挪进 `trash/` 而不是
     * `rm -rf`。用户 2026-10-31 报过 13 条归档对话在一次清理后彻底消失（连废纸篓都
     * 没有），所以必须有一条可用的找回路径，而不是只在日志里留一行数字。
     */
    ['hwchat.emptyTrash', async () => {
      const stats = await storage.trashStats();
      if (!stats.count) {
        await vscode.window.showInformationMessage(tt('ext.trashEmpty'));
        return;
      }
      // 这是整个扩展里唯一会永久销毁对话内容的入口，必须二次确认并说清不可撤销。
      const answer = await vscode.window.showWarningMessage(
        tt('ext.emptyTrashConfirm', { count: stats.count, size: formatBytesForNotice(stats.bytes) }),
        { modal: true, detail: tt('ext.emptyTrashDetail') },
        tt('ext.emptyTrashAction'),
      );
      if (answer !== tt('ext.emptyTrashAction')) return;
      const removed = await storage.purgeTrash();
      await chat.refresh();
      await vscode.window.showInformationMessage(tt('ext.emptyTrashDone', { count: removed }));
    }],
    ['hwchat.restoreDeletedConversations', async () => {
      const entries = await storage.listTrash();
      if (!entries.length) {
        await vscode.window.showInformationMessage(tt('ext.trashEmpty'));
        return;
      }
      const items = entries.map((entry) => ({
        label: entry.title || entry.id,
        description: `${new Date(entry.deletedAt).toLocaleString()} · ${tt(`ext.trashReason.${entry.reason}`)} · ${entry.messageCount} 条消息${entry.archived ? ' · 归档' : ''}`,
        id: entry.id,
        picked: true,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: tt('ext.trashPick'),
        placeHolder: tt('ext.trashPickHint', { count: entries.length }),
      });
      if (!picked?.length) return;
      let restored = 0;
      for (const item of picked) {
        if (await storage.restoreFromTrash(item.id)) restored += 1;
      }
      await chat.refresh();
      await vscode.window.showInformationMessage(tt('ext.trashRestored', { count: restored }));
    }],
    ['hwchat.setApiKey', () => setApiKey(context.secrets, settingsPanel, chat)],
    ['hwchat.exportHistory', () => exportHistory(storage)],
    ['hwchat.attachFiles', (uri?: unknown, selected?: unknown) => {
      const uris = Array.isArray(selected)
        ? selected.filter((item): item is vscode.Uri => item instanceof vscode.Uri)
        : uri instanceof vscode.Uri ? [uri] : undefined;
      return chat.attachFiles(uris);
    }],
    ['hwchat.archiveConversation', () => chat.archiveActiveConversation()],
    ['hwchat.continueConversation', (id?: unknown) => chat.continueActiveConversation(typeof id === 'string' ? id : undefined)],
    ['hwchat.rescanSkills', async () => {
      await skills.refresh({ force: true });
      await chat.refresh();
      void vscode.window.showInformationMessage(tt('ext.skillsFound', { count: skills.list().length }));
    }],
    // 桥接工具（run_in_terminal 等）的审批由 VS Code 决定，只能改它自己的设置。
    ['hwchat.syncVsCodeApprovals', () => showApprovalBridge(context)],
    ['hwchat.revertVsCodeApprovals', () => revertApprovalBridge(context)],
    ['hwchat.showResourceStats', async () => {
      const stats = toolExecutor.resourceStats();
      const lines = [
        `searches: active=${stats.search?.active ?? 0} queued=${stats.search?.queued ?? 0} inFlight=${stats.search?.inFlight ?? 0} cached=${stats.search?.cacheSize ?? 0}`,
        `searches total: completed=${stats.search?.completed ?? 0} failed=${stats.search?.failed ?? 0} cancelled=${stats.search?.cancelled ?? 0} deduped=${stats.search?.deduped ?? 0} retries=${stats.search?.retries ?? 0} rejected=${stats.search?.rejected ?? 0}`,
        `content searches: total=${stats.contentSearches} cacheHits=${stats.contentSearchCacheHits}`,
        `commands: active=${stats.commands.active} queued=${stats.commands.queued} children=${stats.children}`,
      ];
      for (const line of lines) output.info(line);
      output.show(true);
      await vscode.window.showInformationMessage(tt('ext.resourceStats', { active: stats.search?.active ?? 0, queued: stats.search?.queued ?? 0, commands: stats.commands.active }));
    }],
    // 面板布局问题（右边被切 / 显示不全）没法从扩展侧取证：扩展宿主不知道 webview
    // 有多宽、文档有没有横向溢出。这条命令让界面自己量一遍再把数字报回来。
    ['hwchat.reportLayout', () => chat.requestLayoutReport()],
    ['hwchat.showPermissionScope', async () => {
      const report = describePermissionScope();
      for (const line of formatPermissionScope(report)) {
        output.info(line);
      }
      output.show(true);
      await vscode.window.showInformationMessage(tt('ext.permissionScope', { preset: report.preset }));
    }],
  ];
  const commandDisposables = commands.map(([name, handler]) => vscode.commands.registerCommand(name, handler));
  const configurationDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('hwchat')) {
      return;
    }
    scheduler.restart();
    logPermissionScope();
    void chat.refresh();
    void settingsPanel.refresh();
    void skills.refresh();
  });
  const trustDisposable = vscode.workspace.onDidGrantWorkspaceTrust(() => void chat.refresh());
  /**
   * 扩展被安装 / 卸载 / 启用 / 停用（官方定义见 `extensions.onDidChange`）。
   *
   * 用来把「本地skill快捷调用」的安装状态与勾选状态实时对接给 HWChat 的技能面板：
   * 没有它，用户装完扩展必须重载窗口，星标面板才会从「去安装」变成勾选列表。
   */
  const extensionsDisposable = vscode.extensions.onDidChange(() => {
    void chat.refreshSkills().catch((error) => {
      output.warn(`[skills] 扩展变更后刷新失败：${error instanceof Error ? error.message : String(error)}`);
    });
  });

  context.subscriptions.push(
    output,
    chat,
    settingsPanel,
    scheduler,
    chatView,
    configurationDisposable,
    trustDisposable,
    extensionsDisposable,
    skills,
    toolExecutor,
    ...commandDisposables,
  );
  scheduler.start();
  void audit.cleanup(readSettings().auditRetentionDays);
  setTimeout(() => void scheduler.run(false).catch((error) => {
    output.error(error instanceof Error ? error.message : String(error));
  }), 2_000).unref?.();

  output.info('HWChat activated.');
}

/** 与设置页一致的体积格式（KB/MB），只用于提示文案。 */
function formatBytesForNotice(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function ensurePrivacyConsent(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<boolean>('hwchat.privacyConsent.v1')) {
    return true;
  }
  // 模态框自带本地化的 Cancel，不用再传一个自己的「取消」。
  const answer = await vscode.window.showInformationMessage(
    tt('ext.privacyTitle'),
    { modal: true, detail: tt('ext.privacyDetail') },
    tt('ext.privacyAgree'),
  );
  if (answer !== tt('ext.privacyAgree')) return false;
  await context.globalState.update('hwchat.privacyConsent.v1', true);
  return true;
}

export async function deactivate(): Promise<void> {
  await activeStorage?.flush();
  activeStorage = undefined;
}

async function setApiKey(secrets: vscode.SecretStorage, settingsPanel: SettingsPanel, chat?: { refreshModelsQuietly(): Promise<void> }): Promise<void> {
  const settings = readSettings();
  const profile = profileFor(settings);
  const value = await vscode.window.showInputBox({
    title: tt('ext.apiKeyTitle', { profile: profile.name }),
    prompt: tt('ext.apiKeyPrompt'),
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-…',
    validateInput: (input) => input.trim() ? undefined : tt('ext.apiKeyEmpty'),
  });
  if (value === undefined) {
    return;
  }
  await storeApiKey(secrets, profile.id, value.trim());
  await settingsPanel.refresh();
  // 刚填好 Key：静默拉一次模型清单，用户不需要再去点刷新按钮。
  void chat?.refreshModelsQuietly();
  void vscode.window.showInformationMessage(tt('ext.apiKeySaved'));
}

async function exportHistory(storage: ConversationStorage): Promise<void> {
  const destination = await vscode.window.showSaveDialog({
    filters: { JSON: ['json'] },
    saveLabel: tt('ext.exportLabel'),
    defaultUri: vscode.Uri.file(`HWChat-history-${new Date().toISOString().slice(0, 10)}.json`),
  });
  if (!destination) {
    return;
  }
  await storage.writeExportFile(destination.fsPath);
  void vscode.window.showInformationMessage(tt('ext.exported'));
}
