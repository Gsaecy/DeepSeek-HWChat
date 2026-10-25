(() => {
  const vscode = acquireVsCodeApi();
  const fieldIds = [
    'apiKey', 'profileName', 'profileModels', 'baseUrl', 'model', 'requestHeaders', 'requestTimeoutSeconds',
    'temperature', 'maxTokens', 'maxMessagesInContext', 'sendOnEnter',
    'systemPrompt', 'historyRetentionDays', 'taskCacheRetentionHours',
    'cacheBudgetMB', 'cleanupIntervalMinutes', 'defaultMode', 'agentMaxSteps',
    'permissionPreset', 'fileReadPolicy', 'fileWritePolicy', 'commandPolicy', 'allowSensitiveFiles',
    'allowDangerousCommands', 'maxReadBytes', 'maxToolOutputBytes',
    'maxCommandSeconds', 'auditRetentionDays',
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
    elements.saveState.textContent = '有未保存的更改';
    elements.saveState.classList.add('dirty');
  }

  function readForm() {
    let requestHeaders = {};
    const headerText = fields.requestHeaders.value.trim();
    if (headerText) {
      try {
        requestHeaders = JSON.parse(headerText);
      } catch {
        throw new Error('额外请求头不是有效的 JSON。');
      }
      if (!requestHeaders || Array.isArray(requestHeaders) || typeof requestHeaders !== 'object') {
        throw new Error('额外请求头必须是 JSON 对象。');
      }
      for (const [key, value] of Object.entries(requestHeaders)) {
        if (typeof value !== 'string') throw new Error(`请求头 ${key} 的值必须是字符串。`);
      }
    }
    const profile = {
      id: activeProfileId,
      name: fields.profileName.value.trim(),
      baseUrl: fields.baseUrl.value.trim(),
      models: [...new Set(fields.profileModels.value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean))],
      requestHeaders,
    };
    const nextProfiles = profiles.map((item) => item.id === activeProfileId ? profile : item);
    if (!nextProfiles.length || nextProfiles.some((item) => !item.id || !item.name || !item.baseUrl)) {
      throw new Error('请补全每个 API 配置档的名称和接口地址。');
    }
    if (!profile.models.length) profile.models = [fields.model.value.trim()];
    return {
      apiProfiles: nextProfiles,
      activeApiProfileId: activeProfileId,
      baseUrl: fields.baseUrl.value.trim(),
      model: fields.model.value.trim(),
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
      agentMaxSteps: numberValue(fields.agentMaxSteps, 0),
      fileReadPolicy: fields.fileReadPolicy.value,
      fileWritePolicy: fields.fileWritePolicy.value,
      commandPolicy: fields.commandPolicy.value,
      permissionPreset: fields.permissionPreset.value,
      allowSensitiveFiles: fields.allowSensitiveFiles.checked,
      allowDangerousCommands: fields.allowDangerousCommands.checked,
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
    try { headers = JSON.parse(headerText); } catch { throw new Error('额外请求头不是有效的 JSON。'); }
    if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error('额外请求头必须是 JSON 对象。');
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') throw new Error(`请求头 ${key} 的值必须是字符串。`);
    }
    return headers;
  }

  function commitProfileEditor() {
    const index = profiles.findIndex((profile) => profile.id === activeProfileId);
    if (index < 0) return;
    const models = [...new Set(fields.profileModels.value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean))];
    const defaultModel = fields.model.value.trim();
    if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
    profiles[index] = {
      ...profiles[index],
      name: fields.profileName.value.trim(),
      baseUrl: fields.baseUrl.value.trim(),
      models,
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
    fields.apiKey.placeholder = configured ? '已安全保存，输入新值可替换' : 'sk-…';
    elements.keyState.textContent = configured ? '已配置' : '未配置';
    elements.keyState.classList.toggle('configured', configured);
    elements.clearKeyButton.disabled = !configured && !pendingApiKeys[profile.id];
    renderProfileSelect();
  }

  function applyPermissionPreset() {
    const preset = fields.permissionPreset.value;
    const values = {
      askAll: ['ask', 'ask', 'ask', false, false],
      review: ['allow', 'ask', 'ask', false, false],
      autopilot: ['allow', 'allow', 'allow', false, false],
      full: ['allow', 'allow', 'allow', true, true],
    }[preset];
    if (values) {
      [fields.fileReadPolicy.value, fields.fileWritePolicy.value, fields.commandPolicy.value] = values;
      fields.allowSensitiveFiles.checked = values[3];
      fields.allowDangerousCommands.checked = values[4];
    }
    const locked = preset !== 'custom';
    for (const field of [fields.fileReadPolicy, fields.fileWritePolicy, fields.commandPolicy, fields.allowSensitiveFiles, fields.allowDangerousCommands]) field.disabled = locked;
  }

  function populate(settings, apiKeyConfigured, stats, skills, workspaceTrusted, workspaceFolderCount, keyMap) {
    profiles = Array.isArray(settings.apiProfiles) && settings.apiProfiles.length ? settings.apiProfiles.map((item) => ({ ...item, models: [...(item.models || [])], requestHeaders: { ...(item.requestHeaders || {}) } })) : [{ id: 'default', name: 'DeepSeek', baseUrl: settings.baseUrl, models: [settings.model], requestHeaders: settings.requestHeaders || {} }];
    activeProfileId = settings.activeApiProfileId || profiles[0].id;
    fields.model.value = settings.model || profiles.find((profile) => profile.id === activeProfileId)?.models?.[0] || '';
    apiKeyConfiguredByProfile = keyMap || {};
    for (const key of Object.keys(pendingApiKeys)) delete pendingApiKeys[key];
    clearApiKeyIds.clear();
    if (apiKeyConfiguredByProfile.default === undefined) apiKeyConfiguredByProfile[activeProfileId] = apiKeyConfigured;
    renderProfileSelect();
    loadProfileFields();
    fields.apiKey.value = '';
    fields.apiKey.placeholder = apiKeyConfigured ? '已安全保存，输入新值可替换' : 'sk-…';
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
    fields.agentMaxSteps.value = settings.agentMaxSteps;
    fields.permissionPreset.value = settings.permissionPreset || 'review';
    fields.fileReadPolicy.value = settings.fileReadPolicy;
    fields.fileWritePolicy.value = settings.fileWritePolicy;
    fields.commandPolicy.value = settings.commandPolicy;
    fields.allowSensitiveFiles.checked = settings.allowSensitiveFiles;
    fields.allowDangerousCommands.checked = settings.allowDangerousCommands;
    applyPermissionPreset();
    fields.maxReadBytes.value = settings.maxReadBytes;
    fields.maxToolOutputBytes.value = settings.maxToolOutputBytes;
    fields.maxCommandSeconds.value = settings.maxCommandSeconds;
    fields.auditRetentionDays.value = settings.auditRetentionDays;
    elements.temperatureValue.textContent = Number(settings.temperature).toFixed(1);
    loadProfileFields();
    renderStats(stats, settings.cacheBudgetMB);
    renderSkills(skills || []);
    elements.trustState.textContent = workspaceFolderCount === 0 ? '未打开工作区' : workspaceTrusted ? '工作区已信任' : '工作区未信任';
    elements.trustState.classList.toggle('configured', Boolean(workspaceTrusted));
    elements.saveState.textContent = '所有更改已保存';
    elements.saveState.classList.remove('dirty');
  }

  function renderSkills(skills) {
    elements.skillCount.textContent = `${skills.length} 个`;
    elements.skillSummaryList.replaceChildren();
    if (!skills.length) {
      const empty = document.createElement('p');
      empty.className = 'skill-summary-empty';
      empty.textContent = '未发现 Skill。支持 .hwchat/skills/*.md、.agents/skills/**/SKILL.md 和 .claude/skills/**/SKILL.md。';
      elements.skillSummaryList.append(empty);
      return;
    }
    for (const skill of skills) {
      const row = document.createElement('div');
      row.className = 'skill-summary-row';
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = skill.name;
      if (skill.defaultEnabled) title.append(makeBadge('默认启用'));
      if (skill.lastUsedAt) title.append(makeBadge('已调用', 'used'));
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

  function renderStats(stats, budgetMB) {
    const bytes = stats?.bytes || 0;
    const budgetBytes = Math.max(1, budgetMB) * 1024 * 1024;
    elements.storageSize.textContent = formatBytes(bytes);
    elements.storageMeterFill.style.width = `${Math.min(100, (bytes / budgetBytes) * 100)}%`;
    elements.conversationCount.textContent = (stats?.conversations || 0).toLocaleString();
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

  elements.saveButton.addEventListener('click', () => withForm((settings) => {
    commitProfileEditor();
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
    fields.apiKey.placeholder = '保存后清除';
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
    profiles.push({ id, name: '新 API', baseUrl: 'https://api.example.com/v1', models: ['model-name'], requestHeaders: {} });
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
  fields.permissionPreset.addEventListener('change', () => { applyPermissionPreset(); markDirty(); });
  elements.cleanupButton.addEventListener('click', () => post('cleanup'));
  elements.exportAllButton.addEventListener('click', () => post('exportAll'));
  elements.rescanSkillsButton.addEventListener('click', () => post('rescanSkills'));
  elements.openSkillFolderButton.addEventListener('click', () => post('openSkillFolder'));
  elements.clearLocalDataButton.addEventListener('click', () => post('clearLocalData'));
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
        populate(message.settings, message.apiKeyConfigured, message.stats, message.skills, message.workspaceTrusted, message.workspaceFolderCount, message.apiKeyConfiguredByProfile);
        break;
      case 'testing':
        elements.testButton.disabled = message.active;
        elements.testButton.textContent = message.active ? '正在测试…' : '测试连接';
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
