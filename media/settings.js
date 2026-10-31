(() => {
  const vscode = acquireVsCodeApi();

  // 词表由扩展在生成 HTML 时按当前语言注入，脚本只做查表，不保存任何文案。
  const messages = (() => {
    try {
      const node = document.getElementById('hwchat-i18n');
      return node ? JSON.parse(node.textContent || '{}') : {};
    } catch {
      return {};
    }
  })();

  /** 查表；缺键返回键本身，便于发现漏译。{name} 占位符按 vars 替换。 */
  function t(key, vars) {
    const template = messages[key];
    if (typeof template !== 'string') return key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
  }

  const fieldIds = [
    'apiKey', 'profileName', 'profileModels', 'baseUrl', 'model', 'requestHeaders', 'requestTimeoutSeconds',
    'temperature', 'maxTokens', 'maxMessagesInContext', 'sendOnEnter',
    'systemPrompt', 'historyRetentionDays', 'taskCacheRetentionHours',
    'cacheBudgetMB', 'cleanupIntervalMinutes', 'defaultMode',
    'maxReadBytes', 'maxToolOutputBytes',
    'maxCommandSeconds', 'auditRetentionDays', 'language',
  ];
  const fields = Object.fromEntries(fieldIds.map((id) => [id, document.getElementById(id)]));
  const elements = {
    saveButton: document.getElementById('saveButton'),
    testButton: document.getElementById('testButton'),
    clearKeyButton: document.getElementById('clearKeyButton'),
    cleanupButton: document.getElementById('cleanupButton'),
    exportAllButton: document.getElementById('exportAllButton'),
    nativeSettingsButton: document.getElementById('nativeSettingsButton'),
    saveState: document.getElementById('saveState'),
    keyState: document.getElementById('keyState'),
    temperatureValue: document.getElementById('temperatureValue'),
    storageSize: document.getElementById('storageSize'),
    storageMeterFill: document.getElementById('storageMeterFill'),
    conversationCount: document.getElementById('conversationCount'),
    trashCount: document.getElementById('trashCount'),
    trashSize: document.getElementById('trashSize'),
    emptyTrashButton: document.getElementById('emptyTrashButton'),
    restoreTrashButton: document.getElementById('restoreTrashButton'),
    messageCount: document.getElementById('messageCount'),
    trustState: document.getElementById('trustState'),
    skillCount: document.getElementById('skillCount'),
    skillSummaryList: document.getElementById('skillSummaryList'),
    rescanSkillsButton: document.getElementById('rescanSkillsButton'),
    openSkillFolderButton: document.getElementById('openSkillFolderButton'),
    clearLocalDataButton: document.getElementById('clearLocalDataButton'),
    toast: document.getElementById('toast'),
    profileSelect: document.getElementById('profileSelect'),
    addProfileButton: document.getElementById('addProfileButton'),
    deleteProfileButton: document.getElementById('deleteProfileButton'),
  };
  let profiles = [];
  let activeProfileId = '';
  let apiKeyConfiguredByProfile = {};
  const clearApiKeyIds = new Set();
  const pendingApiKeys = {};

  function post(type, payload = {}) {
    vscode.postMessage({ type, ...payload });
  }

  function markDirty() {
    elements.saveState.textContent = t('settings.unsaved');
    elements.saveState.classList.add('dirty');
  }

  function readForm() {
    commitProfileEditor();
    let requestHeaders = {};
    const headerText = fields.requestHeaders.value.trim();
    if (headerText) {
      try {
        requestHeaders = JSON.parse(headerText);
      } catch {
        throw new Error(t('error.headersInvalidJson'));
      }
      if (!requestHeaders || Array.isArray(requestHeaders) || typeof requestHeaders !== 'object') {
        throw new Error(t('error.headersNotObject'));
      }
      for (const [key, value] of Object.entries(requestHeaders)) {
        if (typeof value !== 'string') throw new Error(t('error.headerValueNotString', { key }));
      }
    }
    const profile = profiles.find((item) => item.id === activeProfileId);
    const nextProfiles = profiles.map((item) => ({ ...item, models: [...(item.models || [])], excludedModels: [...(item.excludedModels || [])], requestHeaders: { ...(item.requestHeaders || {}) } }));
    if (!nextProfiles.length || nextProfiles.some((item) => !item.id || !item.name || !item.baseUrl)) {
      throw new Error(t('error.profileIncomplete'));
    }
    if (!profile?.models?.length) throw new Error(t('error.profileNeedsModel'));
    const selectedModel = profile.models.includes(fields.model.value.trim()) ? fields.model.value.trim() : profile.models[0];
    fields.model.value = selectedModel;
    return {
      apiProfiles: nextProfiles,
      activeApiProfileId: activeProfileId,
      baseUrl: fields.baseUrl.value.trim(),
      model: selectedModel,
      requestHeaders,
      requestTimeoutSeconds: numberValue(fields.requestTimeoutSeconds, 120),
      temperature: numberValue(fields.temperature, 1),
      maxTokens: numberValue(fields.maxTokens, 0),
      maxMessagesInContext: numberValue(fields.maxMessagesInContext, 20),
      sendOnEnter: fields.sendOnEnter.checked,
      systemPrompt: fields.systemPrompt.value,
      historyRetentionDays: numberValue(fields.historyRetentionDays, 30),
      taskCacheRetentionHours: numberValue(fields.taskCacheRetentionHours, 24),
      cacheBudgetMB: numberValue(fields.cacheBudgetMB, 100),
      cleanupIntervalMinutes: numberValue(fields.cleanupIntervalMinutes, 10),
      defaultMode: fields.defaultMode.value,
      maxReadBytes: numberValue(fields.maxReadBytes, 512000),
      maxToolOutputBytes: numberValue(fields.maxToolOutputBytes, 200000),
      maxCommandSeconds: numberValue(fields.maxCommandSeconds, 120),
      auditRetentionDays: numberValue(fields.auditRetentionDays, 30),
    };
  }

  function numberValue(input, fallback) {
    const value = Number(input.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function readRequestHeaders() {
    const headerText = fields.requestHeaders.value.trim();
    if (!headerText) return {};
    let headers;
    try { headers = JSON.parse(headerText); } catch { throw new Error(t('error.headersInvalidJson')); }
    if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error(t('error.headersNotObject'));
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') throw new Error(t('error.headerValueNotString', { key }));
    }
    return headers;
  }

  function commitProfileEditor() {
    const index = profiles.findIndex((profile) => profile.id === activeProfileId);
    if (index < 0) return;
    const models = [...new Set(fields.profileModels.value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean))];
    const previous = profiles[index];
    const removed = (previous.models || []).filter((model) => !models.includes(model));
    const excludedModels = [...new Set([...(previous.excludedModels || []), ...removed])].filter((model) => !models.includes(model));
    if (models.length && !models.includes(fields.model.value.trim())) fields.model.value = models[0];
    profiles[index] = {
      ...previous,
      name: fields.profileName.value.trim(),
      baseUrl: fields.baseUrl.value.trim(),
      models,
      excludedModels,
      requestHeaders: readRequestHeaders(),
    };
    if (fields.apiKey.value.trim()) pendingApiKeys[activeProfileId] = fields.apiKey.value.trim();
  }

  function renderProfileSelect() {
    elements.profileSelect.replaceChildren(...profiles.map((profile) => {
      const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.name; return option;
    }));
    elements.profileSelect.value = activeProfileId;
    elements.deleteProfileButton.disabled = profiles.length <= 1;
  }

  function loadProfileFields() {
    const profile = profiles.find((item) => item.id === activeProfileId) || profiles[0];
    if (!profile) return;
    activeProfileId = profile.id;
    fields.profileName.value = profile.name || '';
    fields.baseUrl.value = profile.baseUrl || '';
    fields.profileModels.value = (profile.models || []).join('\n');
    if (!profile.models?.includes(fields.model.value)) fields.model.value = profile.models?.[0] || '';
    fields.requestHeaders.value = Object.keys(profile.requestHeaders || {}).length ? JSON.stringify(profile.requestHeaders, null, 2) : '';
    fields.apiKey.value = pendingApiKeys[profile.id] || '';
    const configured = Boolean(apiKeyConfiguredByProfile[profile.id]);
    fields.apiKey.placeholder = configured ? t('settings.apiKey.savedPlaceholder') : 'sk-…';
    elements.keyState.textContent = configured ? t('settings.keyConfigured') : t('settings.keyUnconfigured');
    elements.keyState.classList.toggle('configured', configured);
    elements.clearKeyButton.disabled = !configured && !pendingApiKeys[profile.id];
    renderProfileSelect();
  }

  // 与 src/core/permissions.ts 的 PERMISSION_PRESET_PROFILES 保持一致：
  // [读取, 写入, 只读命令, 正常命令, 危险命令, 敏感文件]
  function populate(settings, apiKeyConfigured, stats, skills, workspaceTrusted, workspaceFolderCount, keyMap, trash) {
    profiles = Array.isArray(settings.apiProfiles) && settings.apiProfiles.length ? settings.apiProfiles.map((item) => ({ ...item, models: [...(item.models || [])], excludedModels: [...(item.excludedModels || [])], requestHeaders: { ...(item.requestHeaders || {}) } })) : [{ id: 'default', name: 'DeepSeek', baseUrl: settings.baseUrl, models: [settings.model], excludedModels: [], requestHeaders: settings.requestHeaders || {} }];
    activeProfileId = settings.activeApiProfileId || profiles[0].id;
    fields.model.value = settings.model || profiles.find((profile) => profile.id === activeProfileId)?.models?.[0] || '';
    apiKeyConfiguredByProfile = keyMap || {};
    for (const key of Object.keys(pendingApiKeys)) delete pendingApiKeys[key];
    clearApiKeyIds.clear();
    if (apiKeyConfiguredByProfile.default === undefined) apiKeyConfiguredByProfile[activeProfileId] = apiKeyConfigured;
    renderProfileSelect();
    loadProfileFields();
    fields.apiKey.value = '';
    fields.apiKey.placeholder = apiKeyConfigured ? t('settings.apiKey.savedPlaceholder') : 'sk-…';
    fields.requestTimeoutSeconds.value = settings.requestTimeoutSeconds;
    fields.temperature.value = settings.temperature;
    fields.maxTokens.value = settings.maxTokens;
    fields.maxMessagesInContext.value = settings.maxMessagesInContext;
    fields.sendOnEnter.checked = settings.sendOnEnter;
    fields.systemPrompt.value = settings.systemPrompt;
    fields.historyRetentionDays.value = settings.historyRetentionDays;
    fields.taskCacheRetentionHours.value = settings.taskCacheRetentionHours;
    fields.cacheBudgetMB.value = settings.cacheBudgetMB;
    fields.cleanupIntervalMinutes.value = settings.cleanupIntervalMinutes;
    fields.defaultMode.value = settings.defaultMode;
    // 权限预设 / 步数 / 思考深度是固定的新对话初始值，设置页不再提供控件；
    // 说明矩阵里把「每次询问」这一行标出来即可。
    for (const row of document.querySelectorAll('.permission-matrix tbody tr')) {
      row.classList.toggle('active', row.dataset.preset === 'askAll');
    }
    fields.maxReadBytes.value = settings.maxReadBytes;
    fields.maxToolOutputBytes.value = settings.maxToolOutputBytes;
    fields.maxCommandSeconds.value = settings.maxCommandSeconds;
    fields.auditRetentionDays.value = settings.auditRetentionDays;
    fields.language.value = settings.language || 'auto';
    elements.temperatureValue.textContent = Number(settings.temperature).toFixed(1);
    loadProfileFields();
    renderStats(stats, settings.cacheBudgetMB, trash);
    renderSkills(skills || []);
    elements.trustState.textContent = workspaceFolderCount === 0 ? t('settings.noWorkspace') : workspaceTrusted ? t('settings.workspaceTrusted') : t('settings.workspaceUntrusted');
    elements.trustState.classList.toggle('configured', Boolean(workspaceTrusted));
    elements.saveState.textContent = t('settings.saved');
    elements.saveState.classList.remove('dirty');
  }

  function renderSkills(skills) {
    elements.skillCount.textContent = t('settings.skills.count', { count: skills.length });
    elements.skillSummaryList.replaceChildren();
    if (!skills.length) {
      const empty = document.createElement('p');
      empty.className = 'skill-summary-empty';
      empty.textContent = t('settings.skills.empty');
      elements.skillSummaryList.append(empty);
      return;
    }
    for (const skill of skills) {
      const row = document.createElement('div');
      row.className = 'skill-summary-row';
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = skill.name;
      if (skill.defaultEnabled) title.append(makeBadge(t('chat.skillDefaultEnabled')));
      if (skill.lastUsedAt) title.append(makeBadge(t('chat.skillUsed'), 'used'));
      const description = document.createElement('small');
      description.textContent = skill.description;
      copy.append(title, description);
      const path = document.createElement('code');
      path.textContent = skill.relativePath;
      row.append(copy, path);
      elements.skillSummaryList.append(row);
    }
  }

  function makeBadge(text, className = '') {
    const badge = document.createElement('em'); badge.className = `summary-badge ${className}`.trim(); badge.textContent = text; return badge;
  }

  function renderStats(stats, budgetMB, trash) {
    const bytes = stats?.bytes || 0;
    const budgetBytes = Math.max(1, budgetMB) * 1024 * 1024;
    elements.storageSize.textContent = formatBytes(bytes);
    elements.storageMeterFill.style.width = `${Math.min(100, (bytes / budgetBytes) * 100)}%`;
    elements.conversationCount.textContent = (stats?.conversations || 0).toLocaleString();
    // 回收站单独展示：用户要能一眼看到「有多少条对话等着我决定」。
    elements.trashCount.textContent = (trash?.count || 0).toLocaleString();
    elements.trashSize.textContent = formatBytes(trash?.bytes || 0);
    elements.messageCount.textContent = (stats?.messages || 0).toLocaleString();
  }

  function showToast(text, tone = 'neutral') {
    elements.toast.textContent = text;
    elements.toast.dataset.tone = tone;
    elements.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 3600);
  }

  function withForm(callback) {
    try {
      callback(readForm());
    } catch (error) {
      showToast(error.message || String(error), 'error');
    }
  }

  for (const field of Object.values(fields)) {
    field.addEventListener('input', markDirty);
    field.addEventListener('change', markDirty);
  }
  fields.temperature.addEventListener('input', () => {
    elements.temperatureValue.textContent = Number(fields.temperature.value).toFixed(1);
  });
  // 语言切换立即生效：只提交语言字段，避免顺带保存还没确认的其它改动。
  // 扩展侧保存后会重建两个面板的 HTML，界面与提示随即换成新语言。
  fields.language.addEventListener('change', () => {
    post('save', { settings: { language: fields.language.value } });
  });

  elements.saveButton.addEventListener('click', () => withForm((settings) => {
    post('save', {
      settings,
      apiKeys: { ...pendingApiKeys },
      clearApiKeyIds: [...clearApiKeyIds],
    });
  }));
  elements.testButton.addEventListener('click', () => withForm((settings) => {
    post('test', { settings, apiKey: fields.apiKey.value });
  }));
  elements.clearKeyButton.addEventListener('click', () => {
    fields.apiKey.value = '';
    fields.apiKey.placeholder = t('settings.apiKey.clearPlaceholder');
    delete pendingApiKeys[activeProfileId];
    clearApiKeyIds.add(activeProfileId);
    markDirty();
  });
  elements.profileSelect.addEventListener('change', () => {
    try {
      commitProfileEditor();
      activeProfileId = elements.profileSelect.value;
      loadProfileFields();
      markDirty();
    } catch (error) { showToast(error.message || String(error), 'error'); renderProfileSelect(); }
  });
  elements.addProfileButton.addEventListener('click', () => {
    try { commitProfileEditor(); } catch (error) { showToast(error.message || String(error), 'error'); return; }
    const id = `profile-${Date.now().toString(36)}`;
    profiles.push({ id, name: t('settings.newProfileName'), baseUrl: 'https://api.example.com/v1', models: ['model-name'], excludedModels: [], requestHeaders: {} });
    activeProfileId = id;
    fields.model.value = 'model-name';
    loadProfileFields();
    markDirty();
  });
  elements.deleteProfileButton.addEventListener('click', () => {
    if (profiles.length <= 1) return;
    const removed = activeProfileId;
    profiles = profiles.filter((profile) => profile.id !== removed);
    delete pendingApiKeys[removed];
    clearApiKeyIds.add(removed);
    activeProfileId = profiles[0].id;
    fields.model.value = profiles[0].models?.[0] || '';
    loadProfileFields();
    markDirty();
  });
  elements.cleanupButton.addEventListener('click', () => post('cleanup'));
  elements.exportAllButton.addEventListener('click', () => post('exportAll'));
  elements.rescanSkillsButton.addEventListener('click', () => post('rescanSkills'));
  elements.openSkillFolderButton.addEventListener('click', () => post('openSkillFolder'));
  elements.clearLocalDataButton.addEventListener('click', () => post('clearLocalData'));
  elements.emptyTrashButton?.addEventListener('click', () => post('emptyTrash'));
  elements.restoreTrashButton?.addEventListener('click', () => post('restoreTrash'));
  elements.nativeSettingsButton.addEventListener('click', () => post('openNativeSettings'));

  const navButtons = [...document.querySelectorAll('nav [data-target]')];
  const settingsScroller = document.querySelector('.settings-main');
  const settingsToolbar = document.querySelector('.settings-toolbar');
  const sections = [...document.querySelectorAll('.settings-section')];
  let lockedTarget = '';
  let unlockTimer;

  function setActiveSection(id) {
    navButtons.forEach((button) => {
      const active = button.dataset.target === id;
      button.classList.toggle('active', active);
      if (active) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function sectionScrollTop(section) {
    if (!settingsScroller) return section.offsetTop;
    const scrollerRect = settingsScroller.getBoundingClientRect();
    return Math.max(0, section.getBoundingClientRect().top - scrollerRect.top + settingsScroller.scrollTop - (settingsToolbar?.getBoundingClientRect().height || 64) - 8);
  }

  function updateActiveSection() {
    if (!settingsScroller || lockedTarget) return;
    if (settingsScroller.scrollHeight - settingsScroller.scrollTop - settingsScroller.clientHeight <= 2) {
      setActiveSection(sections.at(-1)?.id || '');
      return;
    }
    const marker = settingsScroller.getBoundingClientRect().top + (settingsToolbar?.getBoundingClientRect().height || 64) + 10;
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= marker) current = section;
      else break;
    }
    if (current) setActiveSection(current.id);
  }

  navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.target);
      if (!target || !settingsScroller) return;
      lockedTarget = target.id;
      setActiveSection(lockedTarget);
      settingsScroller.scrollTo({ top: sectionScrollTop(target), behavior: 'smooth' });
      clearTimeout(unlockTimer);
      unlockTimer = setTimeout(() => { lockedTarget = ''; updateActiveSection(); }, 1_500);
    });
  });
  settingsScroller?.addEventListener('scrollend', () => {
    if (!lockedTarget) return;
    lockedTarget = '';
    clearTimeout(unlockTimer);
    updateActiveSection();
  });
  settingsScroller?.addEventListener('scroll', () => {
    if (!lockedTarget) updateActiveSection();
  }, { passive: true });
  window.addEventListener('resize', updateActiveSection);
  requestAnimationFrame(updateActiveSection);

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      elements.saveButton.click();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        populate(message.settings, message.apiKeyConfigured, message.stats, message.skills, message.workspaceTrusted, message.workspaceFolderCount, message.apiKeyConfiguredByProfile, message.trash);
        break;
      case 'testing':
        elements.testButton.disabled = message.active;
        elements.testButton.textContent = message.active ? t('settings.testing') : t('settings.test');
        break;
      case 'toast':
        showToast(message.text, message.tone);
        break;
    }
  });

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  post('ready');
})();
