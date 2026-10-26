import * as vscode from 'vscode';
import { SkillRegistry } from '../agent/skillRegistry';
import { deleteApiKey, hasApiKey, storeApiKey } from '../core/apiKeys';
import { PERMISSION_PRESET_DETAILS } from '../core/permissions';
import { isPermissionPreset, profileFor, readSettings, updateSettings } from '../core/settings';
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
  | { type: 'save'; settings: Partial<ChatSettings>; apiKeys?: Record<string, string>; clearApiKeyIds?: string[] }
  | { type: 'test'; settings: Partial<ChatSettings>; apiKey?: string }
  | { type: 'cleanup' }
  | { type: 'exportAll' }
  | { type: 'rescanSkills' }
  | { type: 'openSkillFolder' }
  | { type: 'clearLocalData' }
  | { type: 'openNativeSettings' };

export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

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
        'HWChat 设置',
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
        case 'cleanup':
          await this.cleanup();
          break;
        case 'exportAll':
          await this.exportAll();
          break;
        case 'rescanSkills':
          await this.skills.refresh();
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
    let settings = validateSettings(message.settings);
    let permissionChangeCancelled = false;
    if (
      isPermissionPreset(settings.permissionPreset)
      && settings.permissionPreset !== previous.permissionPreset
      && isRiskyPermissionPreset(settings.permissionPreset)
      && !await this.confirmPermissionPreset(settings.permissionPreset)
    ) {
      permissionChangeCancelled = true;
      settings = {
        ...settings,
        permissionPreset: previous.permissionPreset,
        fileReadPolicy: previous.fileReadPolicy,
        fileWritePolicy: previous.fileWritePolicy,
        commandPolicy: previous.commandPolicy,
        dangerousCommandPolicy: previous.dangerousCommandPolicy,
        sensitiveFilePolicy: previous.sensitiveFilePolicy,
      };
    }
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
    this.callbacks.onChanged();
    await this.post({
      type: 'toast',
      tone: permissionChangeCancelled ? 'neutral' : 'success',
      text: permissionChangeCancelled ? '其它设置已保存；权限预设更改已取消。' : '设置已保存。',
    });
    await this.sendState();
  }

  private async confirmPermissionPreset(permissionPreset: ChatSettings['permissionPreset']): Promise<boolean> {
    const risk = permissionPreset === 'full'
      ? 'Agent 将可在受信任工作区内自动读写、移动和删除文件，自动运行只读、正常和危险命令（含提权、破坏性删除、强制推送等），读取 .env、密钥、证书等敏感文件时仍会逐次确认。工作区外路径仍被禁止。'
      : permissionPreset === 'autopilot'
        ? 'Agent 将可在受信任工作区内无需逐次确认地读写、移动和删除文件，并自动运行只读与正常命令（含依赖安装、构建、提交等）。敏感文件仍被禁止，仅危险命令会逐次确认。'
        : 'Agent 将使用自定义读取、写入和命令策略，其中可能包含自动执行或敏感文件访问权限。';
    const answer = await vscode.window.showWarningMessage(
      '确认更改 Agent 权限预设？',
      {
        modal: true,
        detail: `${risk}\n\n点击“确认并承担风险”表示你已了解可能造成文件损坏、数据丢失、命令执行或敏感信息暴露，并自行承担相关风险。`,
      },
      '确认并承担风险',
      '取消',
    );
    return answer === '确认并承担风险';
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
      await this.post({ type: 'toast', tone: 'success', text: '连接成功。' });
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
      text: `清理完成：瘦身 ${result.compactedMessages} 条，删除 ${result.deletedConversations} 个过期对话。`,
    });
    await this.sendState();
  }

  private async exportAll(): Promise<void> {
    const destination = await vscode.window.showSaveDialog({
      filters: { JSON: ['json'] },
      saveLabel: '导出全部记录',
      defaultUri: vscode.Uri.file(`HWChat-history-${new Date().toISOString().slice(0, 10)}.json`),
    });
    if (!destination) {
      return;
    }
    await this.storage.writeExportFile(destination.fsPath);
    await this.post({ type: 'toast', tone: 'success', text: '全部对话已导出。' });
  }

  private async clearLocalData(): Promise<void> {
    if (this.callbacks.isAgentBusy()) {
      throw new Error('当前有正在执行的 Agent 任务，请先停止任务。');
    }
    const answer = await vscode.window.showWarningMessage(
      '删除 HWChat 的全部本地对话和 Agent 审计记录？',
      { modal: true, detail: 'API Key 不会被删除。此操作无法撤销，建议先导出记录。' },
      '全部删除',
      '取消',
    );
    if (answer !== '全部删除') return;
    await this.storage.clearAll();
    await this.callbacks.clearAudit();
    this.callbacks.onChanged();
    await this.sendState();
    await this.post({ type: 'toast', tone: 'success', text: '本地对话和审计记录已删除。' });
  }

  private async sendState(): Promise<void> {
    const stats = await this.storage.stats();
    const settings = readSettings();
    const apiKeyConfiguredByProfile = Object.fromEntries(await Promise.all(settings.apiProfiles.map(async (profile) => [
      profile.id,
      await hasApiKey(this.secrets, profile.id, profile.id === 'default'),
    ])));
    await this.post({
      type: 'state',
      settings,
      apiKeyConfigured: Boolean(apiKeyConfiguredByProfile[settings.activeApiProfileId]),
      apiKeyConfiguredByProfile,
      stats,
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
    const style = mediaUri(webview, this.extensionUri, 'settings.css');
    const script = mediaUri(webview, this.extensionUri, 'settings.js');
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'logo.png'));
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}'; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${style}">
  <title>HWChat 设置</title>
</head>
<body>
  <div class="settings-shell">
    <aside class="settings-sidebar">
      <div class="settings-brand"><img src="${logo}" alt=""><strong>HWChat</strong></div>
      <nav aria-label="设置分组">
        <button type="button" data-target="connection" class="active">连接</button>
        <button type="button" data-target="generation">生成</button>
        <button type="button" data-target="agent">Agent</button>
        <button type="button" data-target="skills">Skills</button>
        <button type="button" data-target="privacy">权限与隐私</button>
        <button type="button" data-target="storage">存储</button>
      </nav>
      <button id="nativeSettingsButton" type="button" class="native-settings">VS Code 设置</button>
    </aside>
    <main class="settings-main">
      <header class="settings-toolbar">
        <div><h1>设置</h1><span id="saveState">所有更改已保存</span></div>
        <div class="toolbar-actions"><button id="testButton" type="button">测试连接</button><button id="saveButton" class="primary" type="button">保存</button></div>
      </header>
      <div class="settings-content">
        <section id="connection" class="settings-section">
          <div class="section-heading"><h2>连接</h2><span id="keyState" class="status-pill">未配置</span></div>
          <div class="settings-group">
            <div class="setting-row"><span><strong>API 配置档</strong><small>每个服务独立保存地址、模型和密钥</small></span><span class="profile-control"><select id="profileSelect" class="control"></select><button id="addProfileButton" type="button" title="新增配置档" aria-label="新增配置档">＋</button><button id="deleteProfileButton" type="button" title="删除配置档" aria-label="删除配置档">−</button></span></div>
            <label class="setting-row"><span><strong>配置名称</strong><small>例如 DeepSeek、OpenAI、本地 Ollama</small></span><input id="profileName" class="control" type="text" maxlength="60"></label>
            <label class="setting-row"><span><strong>API Key</strong><small>保存在 VS Code SecretStorage</small></span><span class="control api-key-control"><input id="apiKey" type="password" autocomplete="new-password" placeholder="sk-…"><button id="clearKeyButton" type="button">清除</button></span></label>
            <label class="setting-row"><span><strong>接口地址</strong><small>OpenAI 兼容的 Base URL</small></span><input id="baseUrl" class="control" type="url" spellcheck="false"></label>
            <label class="setting-row"><span><strong>默认模型</strong><small>对话顶部可随时切换；保存后可从 API 刷新官方目录</small></span><input id="model" class="control mono" list="settingsModelPresets" spellcheck="false"><datalist id="settingsModelPresets"><option value="deepseek-flash"></option><option value="deepseek-v4-pro"></option></datalist></label>
            <label class="setting-row setting-row-stack"><span><strong>可选模型</strong><small>每行一个模型名，对话面板会显示为下拉列表</small></span><textarea id="profileModels" class="control mono" rows="4" spellcheck="false"></textarea></label>
            <label class="setting-row setting-row-stack"><span><strong>额外请求头</strong><small>JSON 对象，不包含 Authorization</small></span><textarea id="requestHeaders" class="control mono" rows="4" spellcheck="false"></textarea></label>
            <label class="setting-row"><span><strong>请求超时</strong><small>10–900 秒</small></span><span class="stepper"><input id="requestTimeoutSeconds" type="number" min="10" max="900"><span>秒</span></span></label>
          </div>
        </section>
        <section id="generation" class="settings-section">
          <div class="section-heading"><h2>生成</h2></div>
          <div class="settings-group">
            <label class="setting-row"><span><strong>温度</strong><small>0 更稳定，2 更发散</small></span><span class="range-control"><input id="temperature" type="range" min="0" max="2" step="0.1"><output id="temperatureValue"></output></span></label>
            <label class="setting-row"><span><strong>最大输出</strong><small>0 由服务端决定</small></span><span class="stepper"><input id="maxTokens" type="number" min="0"><span>tokens</span></span></label>
            <label class="setting-row"><span><strong>上下文消息</strong><small>0 表示不限条数，仍有内存保护</small></span><span class="stepper"><input id="maxMessagesInContext" type="number" min="0"><span>条</span></span></label>
            <label class="setting-row"><span><strong>回车发送</strong><small>关闭后使用 ⌘/Ctrl + Enter</small></span><input id="sendOnEnter" class="switch" type="checkbox"></label>
            <label class="setting-row setting-row-stack"><span><strong>系统提示词</strong></span><textarea id="systemPrompt" class="control" rows="7"></textarea></label>
          </div>
        </section>
        <section id="agent" class="settings-section">
          <div class="section-heading"><h2>Agent</h2><span id="trustState" class="status-pill">工作区状态</span></div>
          <div class="settings-group">
            <label class="setting-row"><span><strong>默认模式</strong><small>Agent 可执行工具，Plan 仅分析，Chat 仅对话</small></span><select id="defaultMode" class="control"><option value="agent">Agent</option><option value="plan">Plan</option><option value="chat">Chat</option></select></label>
            <label class="setting-row"><span><strong>最大执行步骤</strong><small>0 表示不限制；也可在对话输入框下方即时调整</small></span><span class="stepper"><input id="agentMaxSteps" type="number" min="0"><span>步</span></span></label>
            <label class="setting-row"><span><strong>命令超时</strong></span><span class="stepper"><input id="maxCommandSeconds" type="number" min="5" max="900"><span>秒</span></span></label>
            <label class="setting-row"><span><strong>单文件读取上限</strong></span><span class="stepper"><input id="maxReadBytes" type="number" min="16384" max="5242880"><span>bytes</span></span></label>
            <label class="setting-row"><span><strong>工具输出上限</strong></span><span class="stepper"><input id="maxToolOutputBytes" type="number" min="16384" max="2097152"><span>bytes</span></span></label>
          </div>
        </section>
        <section id="skills" class="settings-section">
          <div class="section-heading"><h2>Skills</h2><span id="skillCount" class="section-value">0 个</span></div>
          <div id="skillSummaryList" class="skill-summary-list"></div>
          <div class="storage-actions"><button id="rescanSkillsButton" type="button">重新扫描</button><button id="openSkillFolderButton" type="button">打开用户 Skill 目录</button></div>
        </section>
        <section id="privacy" class="settings-section">
          <div class="section-heading"><h2>权限与隐私</h2><span class="status-pill configured">无遥测</span></div>
          <div class="privacy-summary"><strong>数据流向</strong><p>消息、明确添加的文件、启用的 Skill 和必要的工具结果仅发送到你配置的模型接口。API Key 保存在 VS Code SecretStorage；历史和审计记录保存在本机。</p></div>
          <div class="settings-group">
            <label class="setting-row"><span><strong>权限预设</strong><small id="permissionPresetHint">自动读写与常规命令，只有危险命令逐次确认</small></span><select id="permissionPreset" class="control">${permissionPresetOptionsHtml()}</select></label>
            <div class="permission-matrix">
              <table>
                <thead><tr><th scope="col">档位</th><th scope="col">读取</th><th scope="col">写入</th><th scope="col">只读命令</th><th scope="col">正常命令</th><th scope="col">危险命令</th><th scope="col">敏感文件</th></tr></thead>
                <tbody>${permissionMatrixRowsHtml()}</tbody>
              </table>
              <p>硬边界不受预设影响：未受信任工作区禁止写入与命令；工作区外路径隔离。危险命令指提权、破坏性删除、磁盘擦写、强制推送、把网络脚本管道给 shell 等操作。</p>
            </div>
            <label class="setting-row"><span><strong>读取文件</strong><small>敏感文件仍受单独策略保护</small></span><select id="fileReadPolicy" class="control"><option value="allow">自动允许</option><option value="ask">每次询问</option><option value="deny">禁止</option></select></label>
            <label class="setting-row"><span><strong>修改文件</strong><small>未受信任工作区始终禁止</small></span><select id="fileWritePolicy" class="control"><option value="ask">每次询问</option><option value="allow">自动允许</option><option value="deny">禁止</option></select></label>
            <label class="setting-row"><span><strong>运行命令</strong><small>只读命令与正常命令（仅“自定义”生效）</small></span><select id="commandPolicy" class="control"><option value="ask">每次询问</option><option value="allow">自动允许</option><option value="deny">禁止</option></select></label>
            <label class="setting-row"><span><strong>危险命令</strong><small>仅“自定义”生效；提权、破坏性删除、强制推送等</small></span><select id="dangerousCommandPolicy" class="control"><option value="ask">逐次确认</option><option value="allow">自动允许</option><option value="deny">直接拒绝</option></select></label>
            <label class="setting-row"><span><strong>敏感文件</strong><small>仅“自定义”生效；.env、证书、密钥和常见凭据目录</small></span><select id="sensitiveFilePolicy" class="control"><option value="deny">禁止</option><option value="ask">逐次确认</option><option value="allow">允许</option></select></label>
            <label class="setting-row"><span><strong>审计记录保留</strong><small>只记录工具、结果摘要和审批状态，不记录 API Key</small></span><span class="stepper"><input id="auditRetentionDays" type="number" min="0" max="365"><span>天</span></span></label>
          </div>
          <div class="danger-zone"><div><strong>删除本地数据</strong><span>删除全部对话和 Agent 审计记录，不删除 API Key</span></div><button id="clearLocalDataButton" type="button">全部删除</button></div>
        </section>
        <section id="storage" class="settings-section">
          <div class="section-heading"><h2>存储</h2><span id="storageSize" class="section-value">0 MB</span></div>
          <div class="storage-meter"><span id="storageMeterFill"></span></div>
          <div class="stats-row"><span><strong id="conversationCount">0</strong> 对话</span><span><strong id="messageCount">0</strong> 消息</span></div>
          <div class="settings-group">
            <label class="setting-row"><span><strong>对话保留</strong><small>固定的对话不会过期</small></span><span class="stepper"><input id="historyRetentionDays" type="number" min="0"><span>天</span></span></label>
            <label class="setting-row"><span><strong>任务缓存保留</strong><small>到期后保留正文与执行摘要，移除思考、工具详情和附件正文</small></span><span class="stepper"><input id="taskCacheRetentionHours" type="number" min="0"><span>小时</span></span></label>
            <label class="setting-row"><span><strong>缓存上限</strong><small>超限后淘汰最旧的未固定对话</small></span><span class="stepper"><input id="cacheBudgetMB" type="number" min="5"><span>MB</span></span></label>
            <label class="setting-row"><span><strong>清理间隔</strong></span><span class="stepper"><input id="cleanupIntervalMinutes" type="number" min="1"><span>分钟</span></span></label>
          </div>
          <div class="storage-actions"><button id="cleanupButton" type="button">立即清理</button><button id="exportAllButton" type="button">导出全部对话</button></div>
        </section>
      </div>
    </main>
  </div>
  <div id="toast" class="toast" role="status" hidden></div>
  <script nonce="${scriptNonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function validateSettings(values: Partial<ChatSettings>): Partial<ChatSettings> {
  const result = { ...values };
  if (values.apiProfiles !== undefined) {
    if (!Array.isArray(values.apiProfiles) || values.apiProfiles.length === 0) throw new Error('至少保留一个 API 配置档。');
    const ids = new Set<string>();
    result.apiProfiles = values.apiProfiles.map((profile) => {
      const id = String(profile.id ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
      const name = String(profile.name ?? '').trim().slice(0, 60);
      if (!id || !name || ids.has(id)) throw new Error('API 配置档的名称和 ID 必须有效且不可重复。');
      ids.add(id);
      const url = validateEndpoint(profile.baseUrl);
      const headers = profile.requestHeaders ?? {};
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error(`${name} 的额外请求头必须是 JSON 对象。`);
      return {
        id,
        name,
        baseUrl: url,
        models: [...new Set((profile.models ?? []).map((model) => String(model).trim()).filter(Boolean))].slice(0, 500),
        excludedModels: [...new Set((profile.excludedModels ?? []).map((model) => String(model).trim()).filter(Boolean))].slice(0, 500),
        requestHeaders: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      };
    });
    if (values.activeApiProfileId && !ids.has(values.activeApiProfileId)) throw new Error('当前 API 配置档不存在。');
  }
  if (values.baseUrl !== undefined) {
    result.baseUrl = validateEndpoint(values.baseUrl);
  }
  if (values.model !== undefined && !values.model.trim()) {
    throw new Error('模型名称不能为空。');
  }
  if (values.requestHeaders !== undefined && (typeof values.requestHeaders !== 'object' || Array.isArray(values.requestHeaders))) {
    throw new Error('额外请求头必须是 JSON 对象。');
  }
  if (values.defaultMode !== undefined && !['chat', 'agent', 'plan'].includes(values.defaultMode)) {
    throw new Error('默认模式无效。');
  }
  if (values.agentMaxSteps !== undefined && (!Number.isFinite(values.agentMaxSteps) || values.agentMaxSteps < 0)) {
    throw new Error('最大执行步骤必须是 0 或正数。');
  }
  if (values.reasoningEffort !== undefined && !['default', 'none', 'low', 'high', 'max'].includes(values.reasoningEffort)) {
    throw new Error('思考层级无效。');
  }
  if (values.permissionPreset !== undefined && !['askAll', 'review', 'autopilot', 'full', 'custom'].includes(values.permissionPreset)) {
    throw new Error('权限预设无效。');
  }
  for (const key of ['fileReadPolicy', 'fileWritePolicy', 'commandPolicy', 'dangerousCommandPolicy', 'sensitiveFilePolicy'] as const) {
    const value = values[key];
    if (value !== undefined && !['allow', 'ask', 'deny'].includes(value)) {
      throw new Error(`${key} 权限策略无效。`);
    }
  }
  return result;
}

function validateEndpoint(value: string): string {
  const url = new URL(String(value ?? '').trim());
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('远程模型接口必须使用 HTTPS；本机 localhost 可使用 HTTP。');
  }
  return url.toString().replace(/\/$/, '');
}

function isRiskyPermissionPreset(value: ChatSettings['permissionPreset']): boolean {
  return value === 'autopilot' || value === 'full' || value === 'custom';
}

/** 权限预设下拉项与对照表都来自 core/permissions，避免 UI 与运行时策略漂移。 */
function permissionPresetOptionsHtml(): string {
  return PERMISSION_PRESET_DETAILS
    .map((detail) => `<option value="${detail.id}" title="${escapeHtml(detail.summary)}">${escapeHtml(detail.label)}</option>`)
    .join('');
}

function permissionMatrixRowsHtml(): string {
  return PERMISSION_PRESET_DETAILS
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
