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
    'apiKey', 'profileName', 'profileModels', 'profileImageModel', 'baseUrl', 'model', 'requestHeaders', 'requestTimeoutSeconds', 'proxy', 'proxyBypassHosts', 'embeddingProfileId', 'embeddingModel', 'embeddingBaseUrl', 'embeddingApiKey',
    'temperature', 'maxTokens', 'maxMessagesInContext', 'sendOnEnter',
    'systemPrompt', 'historyRetentionDays', 'taskCacheRetentionHours',
    'cacheBudgetMB', 'cleanupIntervalMinutes', 'defaultMode',
    'maxReadBytes', 'maxToolOutputBytes',
    'maxCommandSeconds', 'auditRetentionDays', 'language', 'searchExclude', 'projectDoc',
  ];
  const fields = Object.fromEntries(fieldIds.map((id) => [id, document.getElementById(id)]));
  const elements = {
    saveButton: document.getElementById('saveButton'),
    testImageButton: document.getElementById('testImageButton'),
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
    embeddingProfileId: document.getElementById('embeddingProfileId'),
    probeEmbeddingButton: document.getElementById('probeEmbeddingButton'),
    embeddingApiKey: document.getElementById('embeddingApiKey'),
    clearEmbeddingKeyButton: document.getElementById('clearEmbeddingKeyButton'),
    embeddingProbeResult: document.getElementById('embeddingProbeResult'),
    applyEmbeddingButton: document.getElementById('applyEmbeddingButton'),
    addProfileButton: document.getElementById('addProfileButton'),
    deleteProfileButton: document.getElementById('deleteProfileButton'),
  };
  let profiles = [];
  let activeProfileId = '';
  let apiKeyConfiguredByProfile = {};
  const clearApiKeyIds = new Set();
  const pendingApiKeys = {};
  /** 向量 Key 与聊天 Key 分开提交：聊天用 DeepSeek、向量用 holysheep 时互不干扰。 */
  const clearEmbeddingKeyIds = new Set();
  const pendingEmbeddingKeys = {};

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
      proxy: fields.proxy.value.trim(),
      proxyBypassHosts: fields.proxyBypassHosts.value.split(/[,\n;]/).map((item) => item.trim()).filter(Boolean),
      embeddingProfileId: fields.embeddingProfileId.value,
      embeddingModel: fields.embeddingModel.value.trim(),
      embeddingBaseUrl: fields.embeddingBaseUrl.value.trim(),
      // 向量 Key 不走 settings：validateSettings 是直通合并，写在这里会以明文落到 settings.json。
      // 它只经 apiKeys / embeddingApiKeys 通道进 SecretStorage。
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
      projectDoc: ['auto', 'ask', 'off'].includes(fields.projectDoc.value) ? fields.projectDoc.value : 'auto',
      // 用户在输入框里可能用逗号、顿号或换行分隔；统一拆成数组并去重去空。
      searchExclude: fields.searchExclude.value
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item, index, list) => list.indexOf(item) === index),
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
      imageModel: fields.profileImageModel.value.trim() || undefined,
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
    fields.profileImageModel.value = profile.imageModel || '';
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
  function populate(settings, apiKeyConfigured, stats, skills, workspaceTrusted, workspaceFolderCount, keyMap, trash, embeddingKeyMap) {
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
    fields.proxy.value = settings.proxy || '';
    fields.proxyBypassHosts.value = (settings.proxyBypassHosts || []).join(', ');
    // 语义检索：配置档下拉 = 「关闭」+ 已有配置档（用它们的密钥算向量）。
    const embeddingOptions = [{ id: '', name: t('settings.embeddingOff') }, ...profiles.map((profile) => ({ id: profile.id, name: profile.name }))];
    elements.embeddingProfileId.replaceChildren(...embeddingOptions.map((item) => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option;
    }));
    elements.embeddingProfileId.value = settings.embeddingProfileId || '';
    fields.embeddingModel.value = settings.embeddingModel || '';
    fields.embeddingBaseUrl.value = settings.embeddingBaseUrl || '';
    const howto = document.querySelector('.setting-note');
    if (howto) howto.textContent = t('settings.embeddingHowto');
    const embeddingProfile = settings.embeddingProfileId || '';
    const embeddingKeySaved = Boolean((embeddingKeyMap || {})[embeddingProfile]);
    fields.embeddingApiKey.value = '';
    fields.embeddingApiKey.placeholder = embeddingKeySaved ? t('settings.embeddingKey.saved') : 'sk-…';
    elements.embeddingProbeResult.textContent = '';
    if (elements.applyEmbeddingButton) elements.applyEmbeddingButton.hidden = true;
    fields.searchExclude.value = Array.isArray(settings.searchExclude) ? settings.searchExclude.join(', ') : '';
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
    fields.projectDoc.value = settings.projectDoc || 'auto';
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

  /**
   * 提交整份表单。
   *
   * 「保存」与「保存并启用」走同一条路 —— 后者只是检测成功后才露出来的同一个动作，
   * 免得用户以为检测通过就等于已经生效（向量索引读的是**已保存**的配置）。
   */
  function saveAll() {
    withForm((settings) => {
      const embeddingProfileId = fields.embeddingProfileId.value;
      if (fields.embeddingApiKey.value.trim() && embeddingProfileId) {
        pendingEmbeddingKeys[embeddingProfileId] = fields.embeddingApiKey.value.trim();
      }
      post('save', {
        settings,
        apiKeys: { ...pendingApiKeys },
        clearApiKeyIds: [...clearApiKeyIds],
        embeddingApiKeys: { ...pendingEmbeddingKeys },
        clearEmbeddingKeyIds: [...clearEmbeddingKeyIds],
      });
    });
  }
  elements.saveButton.addEventListener('click', saveAll);
  elements.applyEmbeddingButton?.addEventListener('click', saveAll);
  elements.testButton.addEventListener('click', () => withForm((settings) => {
    post('test', { settings, apiKey: fields.apiKey.value });
  }));
  // 出图端点与聊天端点常常不是同一个服务：单独给一个只探测、不花钱的入口。
  elements.testImageButton?.addEventListener('click', () => withForm((settings) => {
    post('testImage', { settings });
  }));
  elements.clearKeyButton.addEventListener('click', () => {
    fields.apiKey.value = '';
    fields.apiKey.placeholder = t('settings.apiKey.clearPlaceholder');
    delete pendingApiKeys[activeProfileId];
    clearApiKeyIds.add(activeProfileId);
    markDirty();
  });
  elements.clearEmbeddingKeyButton.addEventListener('click', () => {
    fields.embeddingApiKey.value = '';
    clearEmbeddingKeyIds.add(fields.embeddingProfileId.value || activeProfileId);
    elements.embeddingProbeResult.textContent = '';
  });

  elements.embeddingProfileId.addEventListener('change', () => {
    // 换配置档就清空上次的检测结论与输入：Avoid 把 A 档的 Key 存到 B 档名下。
    fields.embeddingApiKey.value = '';
    elements.embeddingProbeResult.textContent = '';
    if (elements.applyEmbeddingButton) elements.applyEmbeddingButton.hidden = true;
    markDirty();
  });

  // 走 withForm 与「保存」同一条取值/校验路径：这里曾写成不存在的 collectSettings()，
  // 一点就抛 ReferenceError —— 用户看到的就是「点检测没反应」。
  elements.probeEmbeddingButton.addEventListener('click', () => withForm((settings) => {
    elements.embeddingProbeResult.textContent = t('settings.embeddingProbeRunning');
    elements.probeEmbeddingButton.disabled = true;
    // 还没保存的输入也要带上：用户可能刚打完 Key 就点检测。
    const typedKeys = { ...pendingApiKeys };
    const typedChatKey = fields.apiKey.value.trim();
    const embeddingProfileId = fields.embeddingProfileId.value;
    if (typedChatKey && embeddingProfileId && embeddingProfileId === activeProfileId) {
      // 只在这一档刚填的聊天 Key 上生效：A 档的 Key 不能拿去测 B 档。
      typedKeys[embeddingProfileId] = typedChatKey;
    }
    post('probeEmbeddings', {
      settings,
      apiKeys: typedKeys,
      embeddingApiKey: fields.embeddingApiKey.value.trim(),
    });
  }));

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
        populate(message.settings, message.apiKeyConfigured, message.stats, message.skills, message.workspaceTrusted, message.workspaceFolderCount, message.apiKeyConfiguredByProfile, message.trash, message.embeddingKeyConfiguredByProfile);
        break;
      case 'testing':
        elements.testButton.disabled = message.active;
        elements.testButton.textContent = message.active ? t('settings.testing') : t('settings.test');
        break;
      case 'toast':
        showToast(message.text, message.tone);
        break;
      case 'embeddingProbe': {
        // 「能不能直接调用」的结论就显示在按钮下面：能就直接回填模型，不能就说清为什么。
        const result = message;
        if (result.pending) {
          elements.probeEmbeddingButton.disabled = true;
          if (elements.applyEmbeddingButton) elements.applyEmbeddingButton.hidden = true;
          elements.embeddingProbeResult.textContent = result.summary || '';
          break;
        }
        elements.probeEmbeddingButton.disabled = false;
        elements.embeddingProbeResult.textContent = result.summary || '';
        elements.embeddingProbeResult.classList.toggle('ok', Boolean(result.usable));
        elements.embeddingProbeResult.classList.toggle('bad', !result.usable);
        if (result.usable && result.model) fields.embeddingModel.value = result.model;
        // 只在成功时露出「保存并启用」：失败时先让用户把问题解决掉。
        if (elements.applyEmbeddingButton) elements.applyEmbeddingButton.hidden = !result.usable;
        break;
      }
    }
  });

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  post('ready');
})();
