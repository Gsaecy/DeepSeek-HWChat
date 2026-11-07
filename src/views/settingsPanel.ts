import * as vscode from 'vscode';
import { SkillRegistry } from '../agent/skillRegistry';
import { deleteApiKey, getApiKey, hasApiKey, hasEmbeddingKey, resolveEmbeddingKey, storeApiKey, storeEmbeddingKey } from '../core/apiKeys';
import { embeddingsEndpoint } from '../providers/embeddingsClient';
import { embeddingCandidatesFor, probeEmbeddingCapability } from '../providers/embeddingsProbe';
import { PERMISSION_PRESET_IDS, DEFAULT_PERMISSION_PRESET, permissionPresetDetail, permissionPresetDetails } from '../core/permissions';
import { currentLanguage, messageScriptTag, t, tt, type Language } from '../core/i18n';
import { isConversationMode } from '../core/modes';
import { imageProfileFor, profileFor, readSettings, updateSettings } from '../core/settings';
import { ConversationStorage } from '../core/storage';
import { ChatSettings } from '../core/types';
import { DeepSeekClient } from '../providers/deepseekClient';
import { mediaUri, nonce } from './webview';

interface SettingsPanelCallbacks {
  onChanged: () => void;
  protectedConversationIds: () => string[];
  isAgentBusy: () => boolean;
  clearAudit: () => Promise<void>;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'save'; settings: Partial<ChatSettings>; apiKeys?: Record<string, string>; clearApiKeyIds?: string[]; embeddingApiKeys?: Record<string, string>; clearEmbeddingKeyIds?: string[] }
  | { type: 'test'; settings: Partial<ChatSettings>; apiKey?: string }
  | { type: 'testImage'; settings: Partial<ChatSettings> }
  /**
   * 「这个配置档能不能直接算向量？」——用户 2026-11-07 的要求：
   * 「能就直接调用，不能就让用户另外配置」。带 settings 是因为可能还没保存。
   */
  | { type: 'probeEmbeddings'; settings: Partial<ChatSettings>; apiKeys?: Record<string, string>; embeddingApiKey?: string }
  | { type: 'cleanup' }
  | { type: 'exportAll' }
  | { type: 'rescanSkills' }
  | { type: 'openSkillFolder' }
  | { type: 'clearLocalData' }
  | { type: 'emptyTrash' }
  | { type: 'restoreTrash' }
  | { type: 'openNativeSettings' };

export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** 上次生成 HTML 时用的语言；语言设置变化后据此触发重建。 */
  private renderedLanguage?: Language;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: ConversationStorage,
    private readonly client: DeepSeekClient,
    private readonly secrets: vscode.SecretStorage,
    private readonly skills: SkillRegistry,
    private readonly userSkillRoot: vscode.Uri,
    private readonly callbacks: SettingsPanelCallbacks,
  ) {}

  async open(): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'hwchat.settings',
        tt('settings.windowTitle'),
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, 'media'),
            vscode.Uri.joinPath(this.extensionUri, 'resources'),
          ],
        },
      );
      this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'logo.png');
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage(
        (message: IncomingMessage) => void this.handleMessage(message),
        undefined,
        this.disposables,
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }, undefined, this.disposables);
    } else {
      this.panel.reveal(vscode.ViewColumn.One, true);
      await this.sendState();
    }
  }

  async refresh(): Promise<void> {
    // 文案在生成 HTML 时静态注入，语言变了必须整页重建，否则界面会停留在旧语言。
    if (this.panel && this.renderedLanguage !== currentLanguage()) {
      this.panel.webview.html = this.html(this.panel.webview);
      return;
    }
    if (this.panel?.visible) {
      await this.sendState();
    }
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.sendState();
          break;
        case 'save':
          await this.save(message);
          break;
        case 'test':
          await this.test(message.settings, message.apiKey);
          break;
        case 'testImage':
          await this.testImage(message.settings);
          break;
        case 'probeEmbeddings':
          await this.probeEmbeddings(message.settings, message.apiKeys, message.embeddingApiKey);
          break;
        case 'cleanup':
          await this.cleanup();
          break;
        case 'exportAll':
          await this.exportAll();
          break;
        case 'rescanSkills':
          await this.skills.refresh({ force: true });
          this.callbacks.onChanged();
          await this.sendState();
          break;
        case 'openSkillFolder':
          await vscode.workspace.fs.createDirectory(this.userSkillRoot);
          await vscode.commands.executeCommand('revealFileInOS', this.userSkillRoot);
          break;
        case 'clearLocalData':
          await this.clearLocalData();
          break;
        case 'emptyTrash':
          await this.emptyTrash();
          break;
        case 'restoreTrash':
          await vscode.commands.executeCommand('hwchat.restoreDeletedConversations');
          break;
        case 'openNativeSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:honor-world.hwchat');
          break;
      }
    } catch (error) {
      await this.post({
        type: 'toast',
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async save(message: Extract<IncomingMessage, { type: 'save' }>): Promise<void> {
    const previous = readSettings();
    const settings = validateSettings(message.settings);
    await updateSettings(settings);
    const next = readSettings();
    const nextIds = new Set(next.apiProfiles.map((profile) => profile.id));
    for (const profile of previous.apiProfiles) {
      if (!nextIds.has(profile.id)) await deleteApiKey(this.secrets, profile.id);
    }
    for (const profileId of message.clearApiKeyIds ?? []) {
      if (nextIds.has(profileId)) await deleteApiKey(this.secrets, profileId);
    }
    for (const [profileId, apiKey] of Object.entries(message.apiKeys ?? {})) {
      if (nextIds.has(profileId) && apiKey.trim()) await storeApiKey(this.secrets, profileId, apiKey.trim());
    }
    /*
     * 向量 Key 单独存（`hwchat.embeddingKey.<profileId>`）。
     *
     * 用户反馈「也没看到向量 key 输入框」：聊天用 DeepSeek（没有 embeddings）、
     * 向量用 holysheep 时，两把 Key 必须能分开填；挤在同一个配置档里做不到。
     */
    for (const profileId of message.clearEmbeddingKeyIds ?? []) {
      if (nextIds.has(profileId)) await storeEmbeddingKey(this.secrets, profileId, '');
    }
    for (const [profileId, key] of Object.entries(message.embeddingApiKeys ?? {})) {
      if (!nextIds.has(profileId)) continue;
      if (key.trim()) await storeEmbeddingKey(this.secrets, profileId, key.trim());
    }
    this.callbacks.onChanged();
    await this.post({ type: 'toast', tone: 'success', text: tt('settings.savedToast') });
    await this.sendState();
  }

  private async test(values: Partial<ChatSettings>, apiKey?: string): Promise<void> {
    const settings = { ...readSettings(), ...validateSettings(values) };
    const profile = profileFor(settings, settings.activeApiProfileId);
    await this.post({ type: 'testing', active: true });
    try {
      await this.client.streamChat(
        {
          ...settings,
          baseUrl: profile.baseUrl,
          requestHeaders: profile.requestHeaders,
          temperature: 0,
          maxTokens: 1,
          requestTimeoutSeconds: Math.min(settings.requestTimeoutSeconds, 25),
        },
        [{ role: 'user', content: 'Reply OK.' }],
        { apiKey, onDelta: () => undefined },
      );
      await this.post({ type: 'toast', tone: 'success', text: tt('settings.connectOk') });
    } finally {
      await this.post({ type: 'testing', active: false });
    }
  }

  /**
   * 「测试出图」：先解释端点存不存在（免费探针），再报告用的哪个模型。
   *
   * 为什么要单独一个按钮：出图档与聊天档常常不是同一个服务，而 `generate_image`
   * 只在**某个**配置档配了图片模型时才会出现。用户填完没有任何反馈的话，
   * 只能靠「发一句话试试」来发现填错了。
   */
  /**
   * 检测某个配置档能否**直接**当向量接口用。
   *
   * 先用用户填的模型试一次，其余候选兜底；成功就把模型名回填到界面，
   * 失败就带上该服务商的原始错误（404 与 401 的处理方式完全不同）。
   */
  private async probeEmbeddings(
    values: Partial<ChatSettings>,
    apiKeys?: Record<string, string>,
    typedEmbeddingKey?: string,
  ): Promise<void> {
    const merged = { ...readSettings(), ...validateSettings(values) };
    const profileId = String(merged.embeddingProfileId ?? '').trim();
    const profile = (merged.apiProfiles ?? []).find((item) => item.id === profileId);
    if (!profile) {
      await this.post({ type: 'embeddingProbe', usable: false, attempts: [], summary: tt('settings.embeddingProbeNoProfile') });
      return;
    }
    const apiKey = typedEmbeddingKey?.trim()
      || (await resolveEmbeddingKey(this.secrets, profile.id).catch(() => undefined))
      || apiKeys?.[profile.id]?.trim();
    if (!apiKey?.trim()) {
      await this.post({ type: 'embeddingProbe', usable: false, attempts: [], summary: tt('settings.embeddingProbeNoKey', { profile: profile.name }) });
      return;
    }
    const baseOverride = String(merged.embeddingBaseUrl ?? '').trim();
    const baseUrl = baseOverride || profile.baseUrl;
    await this.post({ type: 'testing', active: true });
    // 界面先给一句「正在检测」：请求可能要十几秒，按钮点了没有任何反馈会被当成坏了。
    await this.post({ type: 'embeddingProbe', usable: false, attempts: [], pending: true, summary: tt('settings.embeddingProbeRunning') });
    try {
      const result = await probeEmbeddingCapability({
        endpoint: embeddingsEndpoint(baseUrl),
        apiKey,
        candidates: embeddingCandidatesFor(baseUrl, merged.embeddingModel),
        // 出「欠费/余额不足」时用它反推：同一个 Key 打一次最便宜的聊天请求，
        // 能过就说明账号有钱，被拒的只是向量这条产品线。
        accountCheck: profile.models?.[0]
          ? { chatUrl: `${baseUrl.replace(/\/+$/, '')}/chat/completions`, model: profile.models[0] }
          : undefined,
      });
      await this.post({
        type: 'embeddingProbe',
        usable: result.usable,
        model: result.model,
        dim: result.dim,
        attempts: result.attempts,
        summary: result.summary,
      });
    } catch (error) {
      await this.post({
        type: 'embeddingProbe',
        usable: false,
        attempts: [],
        summary: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await this.post({ type: 'testing', active: false });
    }
  }

  private async testImage(values: Partial<ChatSettings>): Promise<void> {
    const settings = { ...readSettings(), ...validateSettings(values) };
    const profile = imageProfileFor(settings);
    if (!profile) {
      await this.post({ type: 'toast', tone: 'warning', text: tt('settings.imageTestNoProfile') });
      return;
    }
    const model = String(profile.imageModel ?? '').trim();
    await this.post({ type: 'testing', active: true });
    try {
      const probe = await this.client.probeImageEndpoint({
        ...settings,
        activeApiProfileId: profile.id,
        baseUrl: profile.baseUrl,
        requestHeaders: profile.requestHeaders,
      });
      await this.post({
        type: 'toast',
        tone: probe.exists ? 'success' : 'warning',
        text: probe.exists
          ? tt('settings.imageTestOk', { profile: profile.name, model })
          : tt('settings.imageTestMissing', { endpoint: probe.endpoint, status: probe.status ?? 0 }),
      });
    } catch (error) {
      await this.post({
        type: 'toast',
        tone: 'warning',
        text: tt('settings.imageTestFailed', { error: error instanceof Error ? error.message : String(error) }),
      });
    } finally {
      await this.post({ type: 'testing', active: false });
    }
  }

  private async cleanup(): Promise<void> {
    const settings = readSettings();
    const result = await this.storage.cleanup({
      historyRetentionDays: settings.historyRetentionDays,
      taskCacheRetentionHours: settings.taskCacheRetentionHours,
      cacheBudgetMB: settings.cacheBudgetMB,
      protectedConversationIds: this.callbacks.protectedConversationIds(),
    });
    this.callbacks.onChanged();
    await this.post({
      type: 'toast',
      tone: 'success',
      text: tt('settings.cleanupDone', { compacted: result.compactedMessages, deleted: result.deletedConversations }),
    });
    await this.sendState();
  }

  private async exportAll(): Promise<void> {
    const destination = await vscode.window.showSaveDialog({
      filters: { JSON: ['json'] },
      saveLabel: tt('settings.exportAllSaveLabel'),
      defaultUri: vscode.Uri.file(`HWChat-history-${new Date().toISOString().slice(0, 10)}.json`),
    });
    if (!destination) {
      return;
    }
    await this.storage.writeExportFile(destination.fsPath);
    await this.post({ type: 'toast', tone: 'success', text: tt('settings.exportedAll') });
  }

  private async emptyTrash(): Promise<void> {
    const stats = await this.storage.trashStats();
    if (!stats.count) {
      await this.post({ type: 'toast', tone: 'info', text: tt('settings.storage.trashEmpty') });
      return;
    }
    // 这是唯一会永久销毁对话内容的按钮，必须二次确认。
    const answer = await vscode.window.showWarningMessage(
      tt('ext.emptyTrashConfirm', { count: stats.count, size: `${(stats.bytes / 1024 / 1024).toFixed(1)} MB` }),
      { modal: true, detail: tt('ext.emptyTrashDetail') },
      tt('ext.emptyTrashAction'),
    );
    if (answer !== tt('ext.emptyTrashAction')) return;
    const removed = await this.storage.purgeTrash();
    this.callbacks.onChanged();
    await this.sendState();
    await this.post({ type: 'toast', tone: 'success', text: tt('ext.emptyTrashDone', { count: removed }) });
  }

  private async clearLocalData(): Promise<void> {
    if (this.callbacks.isAgentBusy()) {
      throw new Error(tt('settings.busy'));
    }
    // 模态框的「取消」由 VS Code 追加，这里只给危险动作本身一个按钮。
    const answer = await vscode.window.showWarningMessage(
      tt('settings.clearConfirmTitle'),
      { modal: true, detail: tt('settings.clearConfirmDetail') },
      tt('settings.dangerZone.action'),
    );
    if (answer !== tt('settings.dangerZone.action')) return;
    await this.storage.clearAll();
    await this.callbacks.clearAudit();
    this.callbacks.onChanged();
    await this.sendState();
    await this.post({ type: 'toast', tone: 'success', text: tt('settings.cleared') });
  }

  private async sendState(): Promise<void> {
    const stats = await this.storage.stats();
    const settings = readSettings();
    const apiKeyConfiguredByProfile = Object.fromEntries(await Promise.all(settings.apiProfiles.map(async (profile) => [
      profile.id,
      await hasApiKey(this.secrets, profile.id, profile.id === 'default'),
    ])));
    // 向量 Key 单独标记：界面据此显示「已保存 / 未填写」，否则用户不知道到底存没存进去。
    const embeddingKeyConfiguredByProfile = Object.fromEntries(await Promise.all(settings.apiProfiles.map(async (profile) => [
      profile.id,
      await hasEmbeddingKey(this.secrets, profile.id),
    ])));
    await this.post({
      type: 'state',
      settings,
      apiKeyConfigured: Boolean(apiKeyConfiguredByProfile[settings.activeApiProfileId]),
      apiKeyConfiguredByProfile,
      embeddingKeyConfiguredByProfile,
      stats,
      trash: await this.storage.trashStats(),
      skills: this.skills.list(),
      workspaceTrusted: vscode.workspace.isTrusted,
      workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
    });
  }

  private async post(message: unknown): Promise<void> {
    if (this.panel) {
      await this.panel.webview.postMessage(message);
    }
  }

  private html(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    const lang = currentLanguage();
    this.renderedLanguage = lang;
    const style = mediaUri(webview, this.extensionUri, 'settings.css');
    const script = mediaUri(webview, this.extensionUri, 'settings.js');
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'logo.png'));
    const languageOptions = (['auto', 'zh', 'en'] as const)
      .map((value) => `<option value="${value}">${t(lang, `language.${value}`)}</option>`)
      .join('');
    return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}'; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${style}">
  <title>${t(lang, 'settings.windowTitle')}</title>
</head>
<body>
  <div class="settings-shell">
    <aside class="settings-sidebar">
      <div class="settings-brand"><img src="${logo}" alt=""><strong>HWChat</strong></div>
      <nav aria-label="${t(lang, 'settings.navLabel')}">
        <button type="button" data-target="general" class="active">${t(lang, 'settings.nav.general')}</button>
        <button type="button" data-target="connection">${t(lang, 'settings.nav.connection')}</button>
        <button type="button" data-target="generation">${t(lang, 'settings.nav.generation')}</button>
        <button type="button" data-target="agent">${t(lang, 'settings.nav.agent')}</button>
        <button type="button" data-target="skills">${t(lang, 'settings.nav.skills')}</button>
        <button type="button" data-target="privacy">${t(lang, 'settings.nav.privacy')}</button>
        <button type="button" data-target="storage">${t(lang, 'settings.nav.storage')}</button>
      </nav>
      <button id="nativeSettingsButton" type="button" class="native-settings">${t(lang, 'settings.nativeButton')}</button>
    </aside>
    <main class="settings-main">
      <header class="settings-toolbar">
        <div><h1>${t(lang, 'settings.title')}</h1><span id="saveState">${t(lang, 'settings.saved')}</span></div>
        <div class="toolbar-actions"><button id="testButton" type="button">${t(lang, 'settings.test')}</button><button id="saveButton" class="primary" type="button">${t(lang, 'settings.save')}</button></div>
      </header>
      <div class="settings-content">
        <section id="general" class="settings-section">
          <div class="section-heading"><h2>${t(lang, 'settings.general.title')}</h2></div>
          <div class="settings-group">
            <label class="setting-row"><span><strong>${t(lang, 'language.label')}</strong><small>${t(lang, 'language.hint')} · ${t(lang, 'settings.general.languageHint')}</small></span><select id="language" class="control">${languageOptions}</select></label>
          </div>
        </section>
        <section id="connection" class="settings-section">
          <div class="section-heading"><h2>${t(lang, 'settings.connection.title')}</h2><span id="keyState" class="status-pill">${t(lang, 'settings.keyUnconfigured')}</span></div>
          <div class="settings-group">
            <div class="setting-row"><span><strong>${t(lang, 'settings.profile.label')}</strong><small>${t(lang, 'settings.profile.hint')}</small></span><span class="profile-control"><select id="profileSelect" class="control"></select><button id="addProfileButton" type="button" title="${t(lang, 'settings.profile.add')}" aria-label="${t(lang, 'settings.profile.add')}">＋</button><button id="deleteProfileButton" type="button" title="${t(lang, 'settings.profile.delete')}" aria-label="${t(lang, 'settings.profile.delete')}">−</button></span></div>
            <label class="setting-row"><span><strong>${t(lang, 'settings.profileName.label')}</strong><small>${t(lang, 'settings.profileName.hint')}</small></span><input id="profileName" class="control" type="text" maxlength="60"></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.apiKey.label')}</strong><small>${t(lang, 'settings.apiKey.hint')}</small></span><span class="control api-key-control"><input id="apiKey" type="password" autocomplete="new-password" placeholder="sk-…"><button id="clearKeyButton" type="button">${t(lang, 'settings.apiKey.clear')}</button></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.baseUrl.label')}</strong><small>${t(lang, 'settings.baseUrl.hint')}</small></span><input id="baseUrl" class="control" type="url" spellcheck="false"></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.model.label')}</strong><small>${t(lang, 'settings.model.hint')}</small></span><input id="model" class="control mono" list="settingsModelPresets" spellcheck="false"><datalist id="settingsModelPresets"><option value="deepseek-flash"></option><option value="deepseek-v4-pro"></option></datalist></label>
            <label class="setting-row setting-row-stack"><span><strong>${t(lang, 'settings.models.label')}</strong><small>${t(lang, 'settings.models.hint')}</small></span><textarea id="profileModels" class="control mono" rows="4" spellcheck="false"></textarea></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.imageModel.label')}</strong><small>${t(lang, 'settings.imageModel.hint')}</small></span><span class="inline-control"><input id="profileImageModel" class="control mono" type="text" spellcheck="false" maxlength="120" placeholder="gpt-image-1"><button id="testImageButton" type="button">${t(lang, 'settings.imageModel.test')}</button></span></label>
            <label class="setting-row setting-row-stack"><span><strong>${t(lang, 'settings.headers.label')}</strong><small>${t(lang, 'settings.headers.hint')}</small></span><textarea id="requestHeaders" class="control mono" rows="4" spellcheck="false"></textarea></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.timeout.label')}</strong><small>${t(lang, 'settings.timeout.hint')}</small></span><span class="stepper"><input id="requestTimeoutSeconds" type="number" min="10" max="900"><span>${t(lang, 'common.seconds')}</span></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.proxy.label')}</strong><small>${t(lang, 'settings.proxy.hint')}</small></span><input id="proxy" class="control mono" type="text" spellcheck="false" placeholder="http://127.0.0.1:8080"></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.proxyBypassHosts.label')}</strong><small>${t(lang, 'settings.proxyBypassHosts.hint')}</small></span><input id="proxyBypassHosts" class="control mono" type="text" spellcheck="false" placeholder="api.deepseek.com"></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.embeddingProfile.label')}</strong><small>${t(lang, 'settings.embeddingProfile.hint')}</small></span><select id="embeddingProfileId" class="control"></select></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.embeddingModel.label')}</strong><small>${t(lang, 'settings.embeddingModel.hint')}</small></span><span class="inline-control"><input id="embeddingModel" class="control mono" type="text" spellcheck="false" placeholder="embedding-3"><button id="probeEmbeddingButton" type="button">${t(lang, 'settings.embeddingProbe.action')}</button></span></label>
            <div class="setting-row setting-row-stack"><span><small id="embeddingProbeResult"></small><button id="applyEmbeddingButton" type="button" hidden>${t(lang, 'settings.embeddingApply')}</button></span></div>
            <div class="setting-row setting-row-stack"><div class="setting-note"></div></div>
            <label class="setting-row"><span><strong>${t(lang, 'settings.embeddingBaseUrl.label')}</strong><small>${t(lang, 'settings.embeddingBaseUrl.hint')}</small></span><input id="embeddingBaseUrl" class="control mono" type="text" spellcheck="false" placeholder="https://open.bigmodel.cn/api/paas/v4"></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.embeddingKey.label')}</strong><small>${t(lang, 'settings.embeddingKey.hint')}</small></span><span class="control api-key-control"><input id="embeddingApiKey" type="password" autocomplete="new-password" placeholder="sk-…"><button id="clearEmbeddingKeyButton" type="button">${t(lang, 'settings.apiKey.clear')}</button></span></label>
          </div>
        </section>
        <section id="generation" class="settings-section">
          <div class="section-heading"><h2>${t(lang, 'settings.generation.title')}</h2></div>
          <div class="settings-group">
            <label class="setting-row"><span><strong>${t(lang, 'settings.temperature.label')}</strong><small>${t(lang, 'settings.temperature.hint')}</small></span><span class="range-control"><input id="temperature" type="range" min="0" max="2" step="0.1"><output id="temperatureValue"></output></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.maxTokens.label')}</strong><small>${t(lang, 'settings.maxTokens.hint')}</small></span><span class="stepper"><input id="maxTokens" type="number" min="0"><span>tokens</span></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.contextMessages.label')}</strong><small>${t(lang, 'settings.contextMessages.hint')}</small></span><span class="stepper"><input id="maxMessagesInContext" type="number" min="0"><span>${t(lang, 'settings.messageUnit')}</span></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.sendOnEnter.label')}</strong><small>${t(lang, 'settings.sendOnEnter.hint')}</small></span><input id="sendOnEnter" class="switch" type="checkbox"></label>
            <label class="setting-row setting-row-stack"><span><strong>${t(lang, 'settings.systemPrompt.label')}</strong></span><textarea id="systemPrompt" class="control" rows="7"></textarea></label>
          </div>
        </section>
        <section id="agent" class="settings-section">
          <div class="section-heading"><h2>${t(lang, 'settings.agent.title')}</h2><span id="trustState" class="status-pill">${t(lang, 'settings.trustStatePlaceholder')}</span></div>
          <div class="settings-group">
            <label class="setting-row"><span><strong>${t(lang, 'settings.defaultMode.label')}</strong><small>${t(lang, 'settings.defaultMode.hint')}</small></span><select id="defaultMode" class="control"><option value="agent">Agent</option><option value="plan">Plan</option><option value="chat">Chat</option></select></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.searchExclude.label')}</strong><small>${t(lang, 'settings.searchExclude.hint')}</small></span><input id="searchExclude" class="control mono" type="text" spellcheck="false" placeholder="dist, .next, vendor"></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.commandTimeout.label')}</strong></span><span class="stepper"><input id="maxCommandSeconds" type="number" min="5" max="900"><span>${t(lang, 'common.seconds')}</span></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.readLimit.label')}</strong></span><span class="stepper"><input id="maxReadBytes" type="number" min="16384" max="5242880"><span>bytes</span></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.toolOutputLimit.label')}</strong></span><span class="stepper"><input id="maxToolOutputBytes" type="number" min="16384" max="2097152"><span>bytes</span></span></label>
          </div>
        </section>
        <section id="skills" class="settings-section">
          <div class="section-heading"><h2>${t(lang, 'settings.skills.title')}</h2><span id="skillCount" class="section-value">${t(lang, 'settings.skills.count', { count: 0 })}</span></div>
          <div id="skillSummaryList" class="skill-summary-list"></div>
          <div class="storage-actions"><button id="rescanSkillsButton" type="button">${t(lang, 'settings.skills.rescan')}</button><button id="openSkillFolderButton" type="button">${t(lang, 'settings.skills.openFolder')}</button></div>
        </section>
        <section id="privacy" class="settings-section">
          <div class="section-heading"><h2>${t(lang, 'settings.privacy.title')}</h2><span class="status-pill configured">${t(lang, 'settings.privacy.noTelemetry')}</span></div>
          <div class="privacy-summary"><strong>${t(lang, 'settings.privacy.dataFlow')}</strong><p>${t(lang, 'settings.privacy.dataFlowBody')}</p></div>
          <div class="settings-group">
            <div class="privacy-summary"><strong>${t(lang, 'settings.fixedDefaults.title')}</strong><p>${t(lang, 'settings.fixedDefaults.body')}</p></div>
            <div class="permission-matrix">
              <table>
                <thead><tr><th scope="col">${t(lang, 'matrix.preset')}</th><th scope="col">${t(lang, 'matrix.read')}</th><th scope="col">${t(lang, 'matrix.write')}</th><th scope="col">${t(lang, 'matrix.readOnlyCommand')}</th><th scope="col">${t(lang, 'matrix.regularCommand')}</th><th scope="col">${t(lang, 'matrix.dangerousCommand')}</th><th scope="col">${t(lang, 'matrix.sensitive')}</th></tr></thead>
                <tbody>${permissionMatrixRowsHtml(lang)}</tbody>
              </table>
              <p>${t(lang, 'matrix.hardBoundary')}</p>
            </div>
            <label class="setting-row"><span><strong>${t(lang, 'settings.privacy.audit')}</strong><small>${t(lang, 'settings.privacy.auditHint')}</small></span><span class="stepper"><input id="auditRetentionDays" type="number" min="0" max="365"><span>${t(lang, 'common.days')}</span></span></label>
          </div>
          <div class="danger-zone"><div><strong>${t(lang, 'settings.dangerZone.title')}</strong><span>${t(lang, 'settings.dangerZone.hint')}</span></div><button id="clearLocalDataButton" type="button">${t(lang, 'settings.dangerZone.action')}</button></div>
        </section>
        <section id="storage" class="settings-section">
          <div class="section-heading"><h2>${t(lang, 'settings.storage.title')}</h2><span id="storageSize" class="section-value">0 MB</span></div>
          <div class="storage-meter"><span id="storageMeterFill"></span></div>
          <div class="stats-row"><span><strong id="conversationCount">0</strong> ${t(lang, 'settings.storage.conversations')}</span><span><strong id="messageCount">0</strong> ${t(lang, 'settings.storage.messages')}</span></div>
          <div class="settings-group">
            <label class="setting-row"><span><strong>${t(lang, 'settings.storage.history')}</strong><small>${t(lang, 'settings.storage.historyHint')}</small></span><span class="stepper"><input id="historyRetentionDays" type="number" min="0"><span>${t(lang, 'common.days')}</span></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.storage.taskCache')}</strong><small>${t(lang, 'settings.storage.taskCacheHint')}</small></span><span class="stepper"><input id="taskCacheRetentionHours" type="number" min="0"><span>${t(lang, 'common.hours')}</span></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.storage.budget')}</strong><small>${t(lang, 'settings.storage.budgetHint')}</small></span><span class="stepper"><input id="cacheBudgetMB" type="number" min="5"><span>MB</span></span></label>
            <label class="setting-row"><span><strong>${t(lang, 'settings.storage.cleanupInterval')}</strong></span><span class="stepper"><input id="cleanupIntervalMinutes" type="number" min="1"><span>${t(lang, 'common.minutes')}</span></span></label>
          </div>
          <div class="stats-row"><span><strong id="trashCount">0</strong> ${t(lang, 'settings.storage.trashCount')}</span><span id="trashSize">0 MB</span></div>
          <p class="settings-hint">${t(lang, 'settings.storage.trashHint')}</p>
          <div class="storage-actions"><button id="cleanupButton" type="button">${t(lang, 'settings.storage.cleanupNow')}</button><button id="restoreTrashButton" type="button">${t(lang, 'settings.storage.restoreTrash')}</button><button id="emptyTrashButton" class="danger" type="button">${t(lang, 'settings.storage.emptyTrash')}</button><button id="exportAllButton" type="button">${t(lang, 'settings.storage.exportAll')}</button></div>
        </section>
      </div>
    </main>
  </div>
  <div id="toast" class="toast" role="status" hidden></div>
  ${messageScriptTag(lang)}
  <script nonce="${scriptNonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function validateSettings(values: Partial<ChatSettings>): Partial<ChatSettings> {
  const result = { ...values };
  if (values.apiProfiles !== undefined) {
    if (!Array.isArray(values.apiProfiles) || values.apiProfiles.length === 0) throw new Error(tt('error.keepOneProfile'));
    const ids = new Set<string>();
    result.apiProfiles = values.apiProfiles.map((profile) => {
      const id = String(profile.id ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
      const name = String(profile.name ?? '').trim().slice(0, 60);
      if (!id || !name || ids.has(id)) throw new Error(tt('error.profileInvalid'));
      ids.add(id);
      const url = validateEndpoint(profile.baseUrl);
      const headers = profile.requestHeaders ?? {};
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error(tt('error.profileHeaders', { name }));
      return {
        id,
        name,
        baseUrl: url,
        models: [...new Set((profile.models ?? []).map((model) => String(model).trim()).filter(Boolean))].slice(0, 500),
        excludedModels: [...new Set((profile.excludedModels ?? []).map((model) => String(model).trim()).filter(Boolean))].slice(0, 500),
        requestHeaders: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        imageModel: String(profile.imageModel ?? '').trim().slice(0, 120) || undefined,
      };
    });
    if (values.activeApiProfileId && !ids.has(values.activeApiProfileId)) throw new Error(tt('error.profileMissing'));
  }
  if (values.baseUrl !== undefined) {
    result.baseUrl = validateEndpoint(values.baseUrl);
  }
  if (values.model !== undefined && !values.model.trim()) {
    throw new Error(tt('error.modelEmpty'));
  }
  if (values.requestHeaders !== undefined && (typeof values.requestHeaders !== 'object' || Array.isArray(values.requestHeaders))) {
    throw new Error(tt('error.headersNotObject'));
  }
  if (values.defaultMode !== undefined && !isConversationMode(values.defaultMode)) {
    throw new Error(tt('error.defaultModeInvalid'));
  }
  // 0 是显式的「无限制」；负数与非数字才是非法值。
  if (values.agentMaxSteps !== undefined && (!Number.isFinite(values.agentMaxSteps) || values.agentMaxSteps < 0)) {
    throw new Error(tt('error.maxStepsInvalid'));
  }
  if (values.reasoningEffort !== undefined && !['default', 'none', 'low', 'medium', 'high', 'max'].includes(values.reasoningEffort)) {
    throw new Error(tt('error.reasoningInvalid'));
  }
  if (values.permissionPreset !== undefined && !['askAll', 'review', 'autopilot', 'full'].includes(values.permissionPreset)) {
    throw new Error(tt('error.presetInvalid'));
  }
  /*
   * 代理写错会让**所有**请求都失败，所以在保存时就拦下来，并明确说清不支持 socks://。
   * 空字符串是合法的（= 直连），不要当成错误。
   */
  if (values.proxy !== undefined) {
    const raw = String(values.proxy ?? '').trim();
    if (raw) {
      if (/^socks/i.test(raw)) throw new Error(tt('error.proxySocks'));
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new Error(tt('error.proxyInvalid'));
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(tt('error.proxyInvalid'));
      result.proxy = raw;
    } else {
      result.proxy = '';
    }
  }
  if (values.searchExclude !== undefined) {
    if (!Array.isArray(values.searchExclude) || values.searchExclude.some((item) => typeof item !== 'string')) {
      throw new Error(tt('error.searchExcludeInvalid'));
    }
    result.searchExclude = [...new Set(values.searchExclude.map((item) => item.trim()).filter(Boolean))].slice(0, 100);
  }
  for (const key of ['fileReadPolicy', 'fileWritePolicy', 'commandPolicy', 'dangerousCommandPolicy', 'sensitiveFilePolicy'] as const) {
    const value = values[key];
    if (value !== undefined && !['allow', 'ask', 'deny'].includes(value)) {
      throw new Error(tt('error.policyInvalid', { key }));
    }
  }
  return result;
}

function validateEndpoint(value: string): string {
  const url = new URL(String(value ?? '').trim());
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(tt('error.endpointHttps'));
  }
  return url.toString().replace(/\/$/, '');
}

function permissionMatrixRowsHtml(lang: Language): string {
  return permissionPresetDetails(lang)
    .map((detail) => `<tr data-preset="${detail.id}"><th scope="row">${escapeHtml(detail.label)}</th><td>${escapeHtml(detail.read)}</td><td>${escapeHtml(detail.write)}</td><td>${escapeHtml(detail.readOnlyCommand)}</td><td>${escapeHtml(detail.regularCommand)}</td><td>${escapeHtml(detail.dangerousCommand)}</td><td>${escapeHtml(detail.sensitive)}</td></tr>`)
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
