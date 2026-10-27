import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from './agent/auditLog';
import { SkillRegistry } from './agent/skillRegistry';
import { ToolExecutor } from './agent/toolExecutor';
import { CleanupScheduler } from './core/cleanupScheduler';
import { getApiKey, storeApiKey } from './core/apiKeys';
import { describePermissionScope, formatPermissionScope, initializeSettingsStorage, profileFor, readSettings } from './core/settings';
import { ConversationStorage } from './core/storage';
import { revertApprovalBridge, showApprovalBridge } from './core/vscodeApprovals';
import { DeepSeekClient } from './providers/deepseekClient';
import { ChatPanel } from './views/chatPanel';
import { SettingsPanel } from './views/settingsPanel';
import { tt } from './core/i18n';

let activeStorage: ConversationStorage | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initializeSettingsStorage(context.globalState);
  const output = vscode.window.createOutputChannel('HWChat', { log: true });
  const storage = new ConversationStorage(join(context.globalStorageUri.fsPath, 'history-v1'));
  activeStorage = storage;
  await storage.initialize();

  const audit = new AuditLog(join(context.globalStorageUri.fsPath, 'agent-audit.jsonl'));
  const skills = new SkillRegistry(
    vscode.Uri.joinPath(context.globalStorageUri, 'skills'),
    vscode.Uri.file(join(homedir(), '.copilot', 'skills')),
    vscode.Uri.file(join(homedir(), '.copilot', '.skill-quick-launch.json')),
  );
  await skills.refresh();
  const toolExecutor = new ToolExecutor(audit, () => vscode.workspace.isTrusted);

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
    },
  );
  const scheduler = new CleanupScheduler(
    storage,
    output,
    () => chat.getProtectedConversationIds(),
    () => {
      void chat.refresh();
      void settingsPanel?.refresh();
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
    ['hwchat.setApiKey', () => setApiKey(context.secrets, settingsPanel)],
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
      await skills.refresh();
      await chat.refresh();
      void vscode.window.showInformationMessage(tt('ext.skillsFound', { count: skills.list().length }));
    }],
    // 桥接工具（run_in_terminal 等）的审批由 VS Code 决定，只能改它自己的设置。
    ['hwchat.syncVsCodeApprovals', () => showApprovalBridge(context)],
    ['hwchat.revertVsCodeApprovals', () => revertApprovalBridge(context)],
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

  context.subscriptions.push(
    output,
    chat,
    settingsPanel,
    scheduler,
    chatView,
    configurationDisposable,
    trustDisposable,
    skills,
    toolExecutor,
    ...commandDisposables,
  );
  scheduler.start();
  void audit.cleanup(readSettings().auditRetentionDays);
  setTimeout(() => void scheduler.run(false).catch((error) => {
    output.error(error instanceof Error ? error.message : String(error));
  }), 2_000).unref?.();

  const stats = await storage.stats();
  output.info(`Activated with ${stats.conversations} conversations and ${stats.messages} messages.`);
}

async function ensurePrivacyConsent(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<boolean>('hwchat.privacyConsent.v1')) {
    return true;
  }
  const answer = await vscode.window.showInformationMessage(
    tt('ext.privacyTitle'),
    { modal: true, detail: tt('ext.privacyDetail') },
    tt('ext.privacyAgree'),
    tt('ext.privacyCancel'),
  );
  if (answer !== tt('ext.privacyAgree')) return false;
  await context.globalState.update('hwchat.privacyConsent.v1', true);
  return true;
}

export async function deactivate(): Promise<void> {
  await activeStorage?.flush();
  activeStorage = undefined;
}

async function setApiKey(secrets: vscode.SecretStorage, settingsPanel: SettingsPanel): Promise<void> {
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
