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

  const elements = Object.fromEntries([
    'app', 'historyPane', 'historyButton', 'closeHistoryButton', 'newChatButton',
    'historySearch', 'archiveViewButton', 'conversationList', 'settingsButton',
    'settingsButtonSide', 'exportButton', 'archiveButton', 'conversationTitle',
    'connectionState', 'profileInput', 'modelInput', 'modeInput', 'refreshModelsButton', 'skillsButton', 'skillsCount',
    'skillsPanel', 'skillsList', 'workspaceTrustBadge', 'messageViewport',
    'messageList', 'emptyState', 'loadOlderButton', 'scrollToBottomButton', 'attachmentList', 'contextChip',
    'contextLabel', 'removeContextButton', 'composer', 'promptInput',
    'historyLinkBanner', 'sourceHistoryTitle', 'detachHistoryButton',
    'permissionPresetInput', 'agentMaxStepsInput', 'reasoningEffortInput', 'voiceButton',
    'agentRunState', 'agentRunLabel', 'agentRunMeta', 'taskTree', 'taskTreeSummary', 'taskTreeList',
    'todoPanel', 'todoList', 'todoSummary',
    'todoArchivePanel', 'todoArchiveList', 'todoArchiveSummary', 'todoArchiveBar',
    'approvalCard', 'approvalTitle', 'approvalSummary', 'approvalDetail', 'approvalDenyButton', 'approvalAllowButton',
    'attachButton', 'sendButton', 'stopButton', 'toast',
  ].map((id) => [id, document.getElementById(id)]));

  const state = {
    conversations: [], archivedConversations: [], conversation: null, messages: [],
    hasMore: false, sendOnEnter: true, streaming: false, streamingConversationId: null,
    search: '', pendingAttachments: [], skills: [], selectedSkillIds: [], mode: 'agent',
    apiProfiles: [], activeApiProfileId: '', model: '', permissionPreset: 'review', agentMaxSteps: 0, reasoningEffort: 'default',
    modelOptionsByProfile: {},
    permissionPresetPending: false, modelLoadingProfileId: null,
    workspaceTrusted: false, agentAvailable: false, availableToolCount: 0, showArchived: false, renderTimer: null,
    taskTree: null, todos: [], todoArchives: [], expandedArchiveId: null, todosInterrupted: false,
    runningConversationIds: [], pendingApprovals: [],
    autoFollow: true, renderingMessages: false, voiceRecognition: null, voiceActive: false,
  };

  const clipboardWrites = new Map();
  let clipboardSequence = 0;
  let pasteSequence = 0;
  let pasteFallbackTimer = null;
  let pendingPaste = null;
  let deferredMessageRenderMode = null;
  let selectingMessageText = false;
  let interactingWithMessages = false;
  let interactionTimer = null;

  function post(type, payload = {}) { vscode.postMessage({ type, ...payload }); }

  function requestClipboardWrite(text, button, idleLabel = t('common.copy')) {
    if (!text) {
      showToast(t('chat.noContentToCopy'), 'warning');
      return;
    }
    const requestId = `copy-${Date.now()}-${++clipboardSequence}`;
    if (button) {
      button.disabled = true;
      button.textContent = t('common.copying');
    }
    const timer = setTimeout(() => finishClipboardWrite(requestId, false, t('chat.clipboardTimeout')), 3_000);
    clipboardWrites.set(requestId, { button, idleLabel, timer });
    post('copyText', { text, requestId });
  }

  function finishClipboardWrite(requestId, ok, error) {
    const pending = clipboardWrites.get(requestId);
    if (!pending) return;
    clipboardWrites.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.button) {
      pending.button.disabled = false;
      pending.button.textContent = ok ? t('common.copied') : pending.idleLabel;
      if (ok) setTimeout(() => { if (pending.button.isConnected) pending.button.textContent = pending.idleLabel; }, 1_200);
    }
    if (!ok) showToast(t('chat.clipboardFailed', { error: error || t('chat.clipboardUnavailable') }), 'warning');
  }

  function renderAll() {
    renderHistory(); renderHeader(); renderSkills(); renderMessages('replace'); renderHistoryLink(); renderAttachments(); renderTaskTree(); renderTodos(); renderArchivePanel(); renderTodoArchives(); renderApproval(); updateComposerState();
  }

  function renderHistory() {
    const query = state.search.trim().toLocaleLowerCase();
    const source = state.showArchived ? state.archivedConversations : state.conversations;
    const conversations = source.filter((item) => !query || `${item.title} ${item.preview || ''}`.toLocaleLowerCase().includes(query));
    elements.archiveViewButton.classList.toggle('active', state.showArchived);
    const archiveLabel = elements.archiveViewButton.querySelector('span:last-child');
    if (archiveLabel) archiveLabel.textContent = state.showArchived ? t('chat.backToConversations') : `${t('chat.showArchived')}${state.archivedConversations.length ? ` (${state.archivedConversations.length})` : ''}`;
    elements.conversationList.replaceChildren();
    if (!conversations.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = query ? t('chat.noMatchingConversations') : state.showArchived ? t('chat.noArchivedConversations') : t('chat.conversationsStoredLocally');
      elements.conversationList.append(empty);
      return;
    }
    for (const conversation of conversations) {
      const row = document.createElement('div');
      row.className = `conversation-row${state.conversation?.id === conversation.id ? ' active' : ''}`;
      const content = document.createElement('button');
      content.type = 'button'; content.className = 'conversation-content';
      const titleRow = document.createElement('span'); titleRow.className = 'conversation-title-row';
      // 多线程：这条对话在后台跑（或正在等授权）时，列表里直接标出来，不用挨个点开看。
      const runningNow = state.runningConversationIds.includes(conversation.id);
      const awaitingNow = state.pendingApprovals.some((item) => item.conversationId === conversation.id);
      if (runningNow) titleRow.append(textElement('span', 'conversation-dot running', ''));
      if (awaitingNow) titleRow.append(textElement('span', 'conversation-dot awaiting', ''));
      titleRow.append(textElement('span', 'conversation-title', conversation.title));
      const statusPrefix = awaitingNow ? `${t('approval.pending')} · ` : runningNow ? `${t('chat.running')} · ` : '';
      const tokenTotal = conversation.totalTokens ? ` · ${formatMillionTokens(conversation.totalTokens)} tokens` : '';
      const linked = conversation.sourceConversationId ? t('chat.continuedPrefix') : '';
      const meta = textElement('span', 'conversation-meta', `${statusPrefix}${linked}${relativeTime(conversation.updatedAt)}${tokenTotal}`);
      const preview = textElement('span', 'conversation-preview', conversation.preview || t('common.emptyConversation'));
      content.append(titleRow, meta, preview);
      content.addEventListener('click', () => { post('selectConversation', { id: conversation.id }); closeMobileHistory(); });
      const actions = document.createElement('div'); actions.className = 'conversation-actions';
      const continueTask = actionButton(t('chat.continueTaskHistory'), '↗');
      continueTask.disabled = runningNow || awaitingNow;
      continueTask.addEventListener('click', () => { post('continueConversation', { id: conversation.id }); closeMobileHistory(); });
      const pin = actionButton(conversation.pinned ? t('chat.unpin') : t('chat.pin'), conversation.pinned ? '●' : '○');
      pin.addEventListener('click', () => post('togglePin', { id: conversation.id, pinned: !conversation.pinned }));
      const archive = actionButton(conversation.archived ? t('chat.restoreConversation') : t('chat.archive'), conversation.archived ? '↺' : '□');
      archive.addEventListener('click', () => post('toggleArchive', { id: conversation.id, archived: !conversation.archived }));
      const remove = actionButton(t('common.delete'), '×'); remove.classList.add('danger-action');
      remove.addEventListener('click', () => post('deleteConversation', { id: conversation.id }));
      actions.append(continueTask, pin, archive, remove); row.append(content, actions); elements.conversationList.append(row);
    }
  }

  function actionButton(label, text) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'row-action'; button.setAttribute('aria-label', label); button.title = label; button.textContent = text;
    return button;
  }

  function renderHeader() {
    const archived = Boolean(state.conversation?.archived);
    // 后台线程数（不含当前对话）：用于提示「还能继续在这里操作」。
    const otherRunning = state.runningConversationIds.filter((id) => id !== state.conversation?.id).length;
    elements.conversationTitle.textContent = state.conversation?.title || t('common.newChat');
    syncConnectionSelectors();
    elements.modeInput.value = state.mode; elements.exportButton.disabled = !state.conversation;
    elements.archiveButton.disabled = !state.conversation || state.streaming;
    elements.archiveButton.title = archived ? t('chat.restoreConversation') : t('chat.archive');
    elements.connectionState.textContent = state.streaming
      ? t('chat.agentRunning')
      : archived ? t('chat.archivedReadOnly')
        : state.mode !== 'chat' && !state.workspaceTrusted ? t('chat.untrustedRestricted')
          : otherRunning > 0 ? t('chat.runningInOtherShort', { count: otherRunning })
            : (state.availableToolCount ? t('chat.readyWithTools', { count: state.availableToolCount }) : t('chat.ready'));
    elements.connectionState.title = otherRunning > 0 ? t('chat.runningInOther') : '';
    elements.connectionState.classList.toggle('live', state.streaming);
    elements.connectionState.classList.toggle('restricted', !state.workspaceTrusted && state.mode !== 'chat');
    elements.skillsCount.textContent = String(state.selectedSkillIds.length);
    elements.skillsButton.classList.toggle('active', state.selectedSkillIds.length > 0);
    elements.permissionPresetInput.value = state.permissionPreset;
    syncPermissionHint();
    ensureStepOption(state.agentMaxSteps);
    elements.agentMaxStepsInput.value = String(state.agentMaxSteps);
    syncReasoningSelector();
    const activeProfileId = state.conversation?.apiProfileId || state.activeApiProfileId;
    const modelsLoading = state.modelLoadingProfileId === activeProfileId;
    elements.refreshModelsButton.classList.toggle('loading', modelsLoading);
    elements.refreshModelsButton.title = modelsLoading ? t('chat.refreshingModels') : t('chat.refreshModels');
  }

  function syncPermissionHint() {
    const selected = elements.permissionPresetInput.selectedOptions[0];
    const hint = selected?.title || '';
    elements.permissionPresetInput.title = hint ? t('chat.permissionPresetTitle', { hint }) : t('chat.permissionPreset');
    elements.permissionPresetInput.closest('.permission-field')?.setAttribute('title', hint);
  }

  function syncConnectionSelectors() {
    const profileId = state.conversation?.apiProfileId || state.activeApiProfileId || state.apiProfiles[0]?.id || '';
    replaceSelectOptions(elements.profileInput, state.apiProfiles.map((profile) => ({ value: profile.id, label: profile.name })), profileId);
    const profile = state.apiProfiles.find((item) => item.id === profileId) || state.apiProfiles[0];
    const discovered = state.modelOptionsByProfile[profileId] || [];
    const options = discovered.length
      ? discovered
      : (profile?.models || []).map((id) => ({ id, name: id, reasoningSupport: 'unknown' }));
    const requestedModel = state.conversation?.model || state.model || options[0]?.id || 'deepseek-flash';
    const selectedModel = options.some((option) => option.id === requestedModel) ? requestedModel : options[0]?.id || requestedModel;
    state.model = selectedModel;
    replaceSelectOptions(elements.modelInput, options.map((option) => ({ value: option.id, label: option.name || option.id })), selectedModel);
    syncReasoningSelector(options.find((option) => option.id === selectedModel));
  }

  function syncReasoningSelector(option) {
    const profileId = state.conversation?.apiProfileId || state.activeApiProfileId || state.apiProfiles[0]?.id || '';
    const modelOption = option || (state.modelOptionsByProfile[profileId] || []).find((item) => item.id === elements.modelInput.value);
    const support = modelOption?.reasoningSupport || 'unknown';
    const labels = { default: t('chat.reasoning.default'), none: t('chat.reasoning.none'), low: t('chat.reasoning.low'), high: t('chat.reasoning.high'), max: t('chat.reasoning.max') };
    let efforts = ['default'];
    let title = t('chat.reasoningSupport.unknown');
    if (support === 'configurable') {
      efforts = modelOption?.reasoningEfforts?.length ? modelOption.reasoningEfforts : ['default', 'none', 'low', 'high', 'max'];
      if (!efforts.includes('default')) efforts.unshift('default');
      title = t('chat.reasoningSupport.configurable');
    } else if (support === 'unsupported') {
      title = t('chat.reasoningSupport.unsupported');
    } else if (support === 'fixed') {
      title = t('chat.reasoningSupport.fixed');
    }
    if (!efforts.includes(state.reasoningEffort)) state.reasoningEffort = 'default';
    const singleLabel = support === 'unsupported' ? t('chat.reasoningUnsupportedShort') : support === 'fixed' ? t('chat.reasoningFixedShort') : support === 'unknown' ? t('chat.reasoningUnknownShort') : undefined;
    replaceSelectOptions(elements.reasoningEffortInput, efforts.map((value) => ({ value, label: singleLabel || labels[value] || value })), state.reasoningEffort);
    elements.reasoningEffortInput.dataset.support = support;
    elements.reasoningEffortInput.title = title;
  }

  function replaceSelectOptions(select, options, selected) {
    const signature = JSON.stringify(options);
    if (select.dataset.options !== signature) {
      select.replaceChildren(...options.map((option) => {
        const node = document.createElement('option'); node.value = option.value; node.textContent = option.label; return node;
      }));
      select.dataset.options = signature;
    }
    select.value = selected;
  }

  function ensureStepOption(value) {
    const normalized = Math.max(0, Math.floor(Number(value) || 0));
    if ([...elements.agentMaxStepsInput.options].some((option) => Number(option.value) === normalized)) return;
    const option = document.createElement('option'); option.value = String(normalized); option.textContent = t('chat.stepsOption', { count: normalized });
    elements.agentMaxStepsInput.append(option);
  }

  function renderSkills() {
    elements.skillsList.replaceChildren();
    elements.workspaceTrustBadge.textContent = state.workspaceTrusted ? t('settings.workspaceTrusted') : t('settings.workspaceUntrusted');
    elements.workspaceTrustBadge.classList.toggle('trusted', state.workspaceTrusted);
    if (!state.skills.length) {
      elements.skillsList.append(textElement('p', 'skills-empty', t('chat.skillsEmpty')));
      return;
    }
    for (const skill of state.skills) {
      const label = document.createElement('label'); label.className = 'skill-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = state.selectedSkillIds.includes(skill.id);
      input.addEventListener('change', () => {
        const selected = new Set(state.selectedSkillIds); if (input.checked) selected.add(skill.id); else selected.delete(skill.id);
        state.selectedSkillIds = [...selected]; elements.skillsCount.textContent = String(state.selectedSkillIds.length);
        post('setSkills', { skillIds: state.selectedSkillIds });
      });
      const copy = document.createElement('span');
      const title = document.createElement('span'); title.className = 'skill-option-title'; title.append(textElement('strong', '', skill.name));
      if (skill.defaultEnabled) title.append(textElement('em', 'skill-badge', t('chat.skillDefaultEnabled')));
      if (skill.lastUsedAt) title.append(textElement('em', 'skill-badge used', t('chat.skillUsed')));
      copy.append(title, textElement('small', '', skill.description || skill.relativePath), textElement('code', '', skill.relativePath));
      label.append(input, copy); elements.skillsList.append(label);
    }
  }

  function isNearBottom() {
    const viewport = elements.messageViewport;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 72;
  }

  /**
   * 「回到最新消息」按钮只在两件事同时成立时出现：内容可滚动，且用户已离开底部。
   * 短对话和空状态不显示，避免挂一个点了等于没反应的按钮。
   */
  function updateScrollToBottom() {
    const button = elements.scrollToBottomButton;
    if (!button) return;
    const viewport = elements.messageViewport;
    const overflowing = viewport.scrollHeight - viewport.clientHeight > 120;
    button.hidden = !overflowing || isNearBottom();
  }

  function hasMessageSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString()) return false;
    return Boolean(
      (selection.anchorNode && elements.messageViewport.contains(selection.anchorNode))
      || (selection.focusNode && elements.messageViewport.contains(selection.focusNode)),
    );
  }

  function clearPendingPaste() {
    clearTimeout(pasteFallbackTimer);
    pasteFallbackTimer = null;
    pendingPaste = null;
  }

  function deferMessageRender(mode) {
    const priority = { keep: 0, replace: 1, prepend: 2, bottom: 3 };
    if (!deferredMessageRenderMode || priority[mode] > priority[deferredMessageRenderMode]) deferredMessageRenderMode = mode;
  }

  function renderMessages(mode = 'keep') {
    if (selectingMessageText || interactingWithMessages || hasMessageSelection()) {
      deferMessageRender(mode);
      return;
    }
    deferredMessageRenderMode = null;
    const viewport = elements.messageViewport;
    const previousTop = viewport.scrollTop;
    const previousHeight = viewport.scrollHeight;
    const shouldFollow = mode === 'bottom' || state.autoFollow;
    state.renderingMessages = true;
    // 消息列表每次都是整段重建（流式输出期间每 70ms 一次）。先记录用户手动展开/收起的
    // <details> 状态，重建后再恢复，否则点击展开会立刻被下一次渲染收起。
    const detailOverrides = captureDetailOverrides();
    elements.messageList.replaceChildren(); elements.emptyState.hidden = state.messages.length > 0;
    elements.loadOlderButton.hidden = !state.hasMore || !state.messages.length;
    for (const message of state.messages) elements.messageList.append(renderMessage(message));
    restoreDetailOverrides(detailOverrides);
    requestAnimationFrame(() => {
      if (shouldFollow) viewport.scrollTop = viewport.scrollHeight;
      else if (mode === 'prepend') viewport.scrollTop = previousTop + Math.max(0, viewport.scrollHeight - previousHeight);
      else viewport.scrollTop = previousTop;
      state.renderingMessages = false;
      updateScrollToBottom();
    });
  }

  function scheduleMessageRender() {
    if (state.renderTimer) return;
    state.renderTimer = setTimeout(() => { state.renderTimer = null; renderMessages('keep'); }, 70);
  }

  /** 用户交互结束后补做被推迟的渲染。 */
  function releaseMessageInteraction() {
    clearTimeout(interactionTimer);
    interactionTimer = null;
    if (!interactingWithMessages && !selectingMessageText) return;
    interactingWithMessages = false;
    selectingMessageText = false;
    flushDeferredMessageRender();
  }

  function flushDeferredMessageRender() {
    if (interactingWithMessages || hasMessageSelection() || !deferredMessageRenderMode) return;
    const mode = deferredMessageRenderMode;
    deferredMessageRenderMode = null;
    renderMessages(mode);
  }

  /** 读取当前 DOM 中“与默认状态不同”的展开状态。 */
  function captureDetailOverrides() {
    const overrides = new Map();
    for (const details of elements.messageList.querySelectorAll('details[data-detail-key]')) {
      const messageId = details.closest('[data-message-id]')?.dataset.messageId;
      const key = details.dataset.detailKey;
      if (!messageId || !key) continue;
      if (details.open !== (details.dataset.defaultOpen === '1')) {
        overrides.set(`${messageId}::${key}`, details.open);
      }
    }
    return overrides;
  }

  /** 重建后恢复用户的展开/收起状态，保证“点开展开、再点收起”。 */
  function restoreDetailOverrides(overrides) {
    if (!overrides.size) return;
    for (const details of elements.messageList.querySelectorAll('details[data-detail-key]')) {
      const messageId = details.closest('[data-message-id]')?.dataset.messageId;
      const key = details.dataset.detailKey;
      if (!messageId || !key) continue;
      const value = overrides.get(`${messageId}::${key}`);
      if (value !== undefined) details.open = value;
    }
  }

  function renderTaskTree() {
    const tree = state.taskTree;
    const nodes = tree?.nodes || [];
    elements.agentRunState.hidden = !state.streaming;
    elements.taskTree.hidden = !nodes.length;
    if (!nodes.length) return;
    const routing = nodes.filter((node) => node.status === 'routing').length;
    const queued = nodes.filter((node) => node.status === 'queued').length;
    const current = nodes.find((node) => node.id === tree.currentNodeId);
    elements.agentRunLabel.textContent = current?.title ? t('chat.agentRunningWith', { title: current.title }) : t('chat.agentRunning');
    elements.agentRunMeta.textContent = [routing ? t('chat.routingCount', { count: routing }) : '', queued ? t('chat.queuedCount', { count: queued }) : ''].filter(Boolean).join(' · ');
    elements.taskTreeSummary.textContent = queued ? t('chat.nodeCountWithQueue', { count: nodes.length, queued }) : t('chat.nodeCount', { count: nodes.length });
    elements.taskTreeList.replaceChildren();
    const rootId = nodes[0]?.id;
    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = `task-node status-${node.status}${node.id === tree.currentNodeId ? ' current' : ''}`;
      if (node.parentId && node.parentId !== rootId) row.classList.add('nested');
      row.append(textElement('span', 'task-node-status', taskStatusSymbol(node.status)), textElement('span', 'task-node-title', node.title), textElement('small', '', taskStatusLabel(node.status)));
      elements.taskTreeList.append(row);
    }
  }

  function taskStatusSymbol(status) { return status === 'complete' ? '✓' : status === 'active' ? '●' : status === 'routing' ? '…' : status === 'merged' ? '↳' : status === 'queued' ? '○' : '−'; }
  function taskStatusLabel(status) { return ({ active: t('chat.taskStatus.active'), routing: t('chat.taskStatus.routing'), merged: t('chat.taskStatus.merged'), queued: t('chat.taskStatus.queued'), complete: t('chat.taskStatus.complete'), cancelled: t('chat.taskStatus.cancelled'), error: t('chat.taskStatus.error') })[status] || status; }

  /**
   * 任务清单：按执行顺序列序号，左边写内容，右边写状态。
   *
   * 状态只有三种视觉，且都用绿色表示「一切按计划推进」：
   * - pending   绿色空心圆圈
   * - in_progress 绿色跳动的三点省略号
   * - completed 实心绿色圆圈 + 白色对勾
   * 圆圈的“实心/空心”靠 CSS 控制，这里只给出结构，方便动画与减少动效偏好统一处理。
   *
   * 归档后（清单全部完成）当前清单会被后端收走，面板只剩胶囊；点开某颗胶囊时，
   * 由 `renderArchivePanel` 用独立面板显示那份快照，不会盖住正在执行的新清单。
   */
  function renderTodos() {
    const todos = Array.isArray(state.todos) ? state.todos : [];
    elements.todoPanel.hidden = !todos.length;
    if (!todos.length) {
      elements.todoPanel.classList.remove('interrupted');
      elements.todoList.replaceChildren();
      if (elements.todoSummary) elements.todoSummary.textContent = '';
      return;
    }
    const done = todos.filter((todo) => todo.status === 'completed').length;
    // 被中断的清单：后端已把「执行中」降级成待办，这里只补一个文字标记。
    // 不引入第四种状态——用户接着做时模型重新标 in_progress，全绿后照常归档。
    elements.todoPanel.classList.toggle('interrupted', Boolean(state.todosInterrupted));
    if (elements.todoSummary) {
      const progress = t('todo.progress', { done, total: todos.length });
      elements.todoSummary.textContent = state.todosInterrupted ? `${progress} · ${t('todo.interrupted')}` : progress;
    }
    renderTodoItems(elements.todoList, todos);
  }

  /** 归档快照面板：只有点开胶囊时才出现，标题与汇总都标出「已归档」。 */
  function renderArchivePanel() {
    const archive = state.expandedArchiveId ? state.todoArchives.find((item) => item.id === state.expandedArchiveId) : null;
    elements.todoArchivePanel.hidden = !archive;
    if (!archive) {
      elements.todoArchiveList.replaceChildren();
      elements.todoArchiveSummary.textContent = '';
      return;
    }
    elements.todoArchiveSummary.textContent = t('todo.archive.summary', {
      time: formatTime(archive.createdAt),
      done: archive.completed,
      total: archive.total,
    });
    renderTodoItems(elements.todoArchiveList, archive.todos);
  }

  function renderTodoItems(list, todos) {
    list.replaceChildren();
    todos.forEach((todo, index) => {
      const status = todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending';
      const item = document.createElement('li');
      item.className = `todo-item status-${status}`;

      const order = textElement('span', 'todo-index', String(index + 1));
      const content = textElement('span', 'todo-content', todo.content);
      const statusNode = document.createElement('span');
      statusNode.className = `todo-status status-${status}`;
      const label = t(`todo.status.${status}`);
      statusNode.title = label;
      statusNode.setAttribute('aria-label', label);
      if (status === 'in_progress') {
        // 三个点各自延迟，形成“跳动”的省略号；动画在 CSS 里，减少动效时不播放。
        for (let dot = 0; dot < 3; dot += 1) statusNode.append(document.createElement('i'));
      } else if (status === 'completed') {
        statusNode.textContent = '✓';
      }

      item.append(order, content, statusNode);
      list.append(item);
    });
  }

  /**
   * 归档胶囊栏。
   *
   * 规则（对应需求）：
   * - 每份完成的清单是一颗纯色胶囊，颜色由扩展按「越新越蓝」算好（绿 → 浅蓝 → 深蓝）；
   * - 永远不换行，胶囊过多或窗口变窄时按 3:1 的比例同时缩小宽和高；
   * - 点一颗胶囊展开/收起那份清单，展开时当前清单区域显示它的快照。
   */
  const CAPSULE_BASE_HEIGHT = 16;
  const CAPSULE_MIN_HEIGHT = 6;
  const CAPSULE_RATIO = 3;

  function renderTodoArchives() {
    const archives = Array.isArray(state.todoArchives) ? state.todoArchives : [];
    const previousExpanded = state.expandedArchiveId;
    if (!archives.length) state.expandedArchiveId = null;
    else if (state.expandedArchiveId && !archives.some((item) => item.id === state.expandedArchiveId)) state.expandedArchiveId = null;
    // 被展开的那份归档没了（对话被清理/删档）：连带把快照面板收起来，别留一块过期内容。
    if (previousExpanded !== state.expandedArchiveId) renderArchivePanel();
    elements.todoArchiveBar.hidden = !archives.length;
    elements.todoArchiveBar.replaceChildren();
    if (!archives.length) return;
    archives.forEach((archive, index) => {
      const capsule = document.createElement('button');
      capsule.type = 'button';
      capsule.className = 'todo-capsule';
      capsule.dataset.archiveId = archive.id;
      capsule.style.backgroundColor = archive.color;
      const active = state.expandedArchiveId === archive.id;
      capsule.classList.toggle('active', active);
      capsule.setAttribute('aria-expanded', active ? 'true' : 'false');
      const label = t('todo.archive.capsule', {
        done: archive.completed,
        total: archive.total,
        preview: archive.todos.map((todo) => todo.content).join(' / ').slice(0, 160),
      });
      capsule.setAttribute('aria-label', `${label}。${active ? t('todo.archive.hintOpen') : t('todo.archive.hint')}`);
      capsule.title = `${label}\n${active ? t('todo.archive.hintOpen') : t('todo.archive.hint')}`;
      // 归档图标：一颗胶囊里只放一个极简的「归档匣」，缩到很小时自动隐藏（见 CSS）。
      capsule.append(textElement('span', 'todo-capsule-mark', '▤'));
      capsule.addEventListener('click', () => {
        state.expandedArchiveId = state.expandedArchiveId === archive.id ? null : archive.id;
        renderArchivePanel(); renderTodoArchives();
        if (state.expandedArchiveId) {
          elements.todoArchivePanel.open = true;
          elements.todoArchivePanel.scrollIntoView({ block: 'nearest' });
        }
      });
      elements.todoArchiveBar.append(capsule);
    });
    layoutTodoArchives();
  }

  /**
   * 按可用宽度算胶囊尺寸：宽 = 3 × 高，间距 = 0.25 × 高。
   * 永远不换行（CSS `flex-wrap: nowrap`），放不下就一起缩小，缩到下限仍放不下就裁掉右侧。
   */
  let lastCapsuleBarWidth = 0;
  function layoutTodoArchives() {
    const bar = elements.todoArchiveBar;
    if (!bar || bar.hidden) return;
    const count = bar.children.length;
    if (!count) return;
    const available = bar.clientWidth || 0;
    if (!available) return;
    lastCapsuleBarWidth = available;
    // 总宽 = count 条 × (3h) 宽 + (count-1) 个间距，间距 = max(2px, 0.25h)（缩到很小时间距托底）。
    // 先按未托底的公式反解；若解出来已经小到触底，再用固定 2px 间距重解一次，避免差几像素就溢出。
    const perUnit = count * CAPSULE_RATIO + Math.max(0, count - 1) * 0.25;
    let height = Math.min(CAPSULE_BASE_HEIGHT, available / perUnit);
    if (height < 8) {
      height = Math.min(height, (available - 2 * (count - 1)) / (count * CAPSULE_RATIO));
    }
    height = Math.max(CAPSULE_MIN_HEIGHT, height);
    bar.style.setProperty('--capsule-h', `${height.toFixed(2)}px`);
    bar.style.setProperty('--capsule-w', `${(height * CAPSULE_RATIO).toFixed(2)}px`);
    bar.style.setProperty('--capsule-gap', `${Math.max(2, height * 0.25).toFixed(2)}px`);
    bar.classList.toggle('compact', height < 11);
  }

  /**
   * 面板内审批卡片。
   *
   * 只显示「属于当前对话」的那一条：另一个对话在等授权时，它自己那条线程会一直挂着，
   * 切回去就能看到这张卡片，不会像模态框那样把整个窗口按住。
   */
  function currentApproval() {
    const conversationId = state.conversation?.id;
    if (!conversationId) return null;
    return state.pendingApprovals.find((item) => item.conversationId === conversationId) || null;
  }

  function renderApproval() {
    const request = currentApproval();
    elements.approvalCard.hidden = !request;
    if (!request) {
      elements.approvalCard.dataset.requestId = '';
      return;
    }
    elements.approvalCard.dataset.requestId = request.requestId;
    elements.approvalCard.dataset.risk = request.risk;
    elements.approvalTitle.textContent = request.title;
    elements.approvalSummary.textContent = request.summary;
    elements.approvalDetail.textContent = request.detail || '';
  }

  function renderMessage(message) {
    const article = document.createElement('article');
    article.className = `message ${message.role}${message.status === 'error' ? ' error' : ''}`; article.dataset.messageId = message.id;
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const author = textElement('span', '', message.role === 'user' ? t('chat.you') : 'HWChat');
    const time = textElement('time', '', formatTime(message.createdAt)); time.dateTime = new Date(message.createdAt).toISOString(); meta.append(author, time);
    if (message.content) {
      const copy = textElement('button', 'message-copy-button', t('common.copy')); copy.type = 'button'; copy.title = t('chat.copyMessage');
      copy.addEventListener('click', () => requestClipboardWrite(message.content, copy));
      meta.append(copy);
    }
    const body = document.createElement('div'); body.className = 'message-body';
    const attached = [message.context, ...(message.attachments || [])].filter(Boolean);
    if (attached.length) body.append(renderMessageAttachments(attached));
    if (message.usedSkills?.length) body.append(renderSkillUsage(message.usedSkills));
    if (message.reasoning) body.append(renderReasoning(message.reasoning, message.status === 'streaming'));
    appendMessageFlow(body, message);
    if (message.status === 'streaming') { const cursor = document.createElement('span'); cursor.className = 'stream-cursor'; cursor.setAttribute('aria-label', t('chat.generating')); body.append(cursor); }
    if (message.usage?.totalTokens) body.append(textElement('div', 'message-usage', `${formatMillionTokens(message.usage.totalTokens)} tokens`));
    article.append(meta, body); return article;
  }

  /**
   * 按发生顺序把「说明」和「它触发的步骤」摆在一起：
   * 我先说要做什么 → 下面紧接着这一步真正执行了什么、结果如何 → 再回到下一段说明。
   * 这样读的人不用在「上面的话」和「下面的步骤列表」之间来回对照。
   * 旧消息没有分段信息时，退回原来的「步骤块 + 正文」排法。
   */
  function appendMessageFlow(body, message) {
    const tools = message.toolExecutions || [];
    const text = message.content || '';
    const idleStatusText = message.status === 'queued' ? t('chat.queuedWaiting') : message.status === 'streaming' ? t('chat.continuing') : '';
    const groups = groupToolsByOffset(tools, text.length);
    if (!groups) {
      if (tools.length) body.append(renderToolExecutions(tools));
      const content = document.createElement('div'); content.className = 'message-content';
      appendRichText(content, text || idleStatusText); body.append(content);
      return;
    }
    let cursor = 0;
    let rendered = false;
    for (const group of groups) {
      const boundary = Math.max(cursor, Math.min(group.offset, text.length));
      rendered = appendNarration(body, text.slice(cursor, boundary)) || rendered;
      body.append(renderToolExecutions(group.tools));
      cursor = boundary;
    }
    rendered = appendNarration(body, text.slice(cursor)) || rendered;
    if (!rendered) {
      const content = document.createElement('div'); content.className = 'message-content';
      appendRichText(content, idleStatusText); body.append(content);
    }
  }

  /** 只渲染有内容的段落：分段边界上的空行、纯空白段直接跳过，不占版面。 */
  function appendNarration(body, rawText) {
    const text = String(rawText || '').trim();
    if (!text) return false;
    const content = document.createElement('div'); content.className = 'message-content message-narration';
    appendRichText(content, text);
    body.append(content);
    return true;
  }

  /**
   * 把步骤按「接在哪段正文之后」分组。同一轮里连续调用的几个工具边界相同，合成一组。
   * 返回 null 表示这条消息没有分段信息（旧数据），由调用方走老排法。
   */
  function groupToolsByOffset(tools, textLength) {
    if (!tools.length) return null;
    if (!tools.some((tool) => typeof tool.contentOffset === 'number')) return null;
    const limit = Math.max(0, textLength);
    const groups = [];
    for (const tool of tools) {
      const raw = typeof tool.contentOffset === 'number' ? tool.contentOffset : limit;
      const offset = Math.max(0, Math.min(raw, limit));
      const last = groups[groups.length - 1];
      if (last && last.offset === offset) last.tools.push(tool);
      else groups.push({ offset, tools: [tool] });
    }
    return groups;
  }

  function renderSkillUsage(skills) {
    const details = document.createElement('details'); details.className = 'message-skills';
    details.dataset.detailKey = 'skills';
    details.dataset.defaultOpen = '0';
    const summary = document.createElement('summary'); summary.textContent = t('chat.skillsUsedCount', { count: skills.length });
    const list = document.createElement('div'); list.className = 'message-skills-list';
    for (const skill of skills) {
      const row = document.createElement('span'); row.title = skill.relativePath;
      row.append(textElement('strong', '', skill.name), textElement('small', '', skill.source === 'copilot' ? t('chat.skillQuickInvoke') : skill.source));
      list.append(row);
    }
    details.append(summary, list); return details;
  }

  function renderMessageAttachments(attachments) {
    const row = document.createElement('div'); row.className = 'message-attachments';
    for (const attachment of attachments) {
      if (attachment.kind === 'image' && attachment.thumbnailDataUrl) {
        const figure = document.createElement('figure'); figure.className = 'message-image-attachment'; figure.title = attachment.path || attachment.label;
        const image = document.createElement('img'); image.src = attachment.thumbnailDataUrl; image.alt = attachment.label;
        figure.append(image, textElement('figcaption', '', attachment.label)); row.append(figure);
      } else {
        const chip = textElement('span', 'message-file-attachment', attachment.label); chip.title = attachment.path || attachment.label; row.append(chip);
      }
    }
    return row;
  }

  function renderToolExecutions(tools) {
    const section = document.createElement('section'); section.className = 'tool-stack';
    const changed = new Set(tools.flatMap((tool) => tool.changedFiles || []));
    // 一步就够读清楚时不再加标题：分段渲染后每组通常只有一两步，
    // 反复出现「处理过程 · 共 1 步」只会把版面撑长。
    if (tools.length > 1) {
      section.append(textElement('div', 'tool-stack-heading', changed.size ? t('chat.toolStackWithFiles', { count: tools.length, files: changed.size }) : t('chat.toolStack', { count: tools.length })));
    }
    for (const [index, tool] of tools.entries()) {
      const details = document.createElement('details'); details.className = `tool-execution status-${tool.status || 'pending'}`;
      details.dataset.detailKey = `tool:${tool.callId || index}`;
      details.dataset.defaultOpen = tool.status === 'pending' ? '1' : '0';
      if (tool.status === 'pending') details.open = true;
      const summary = document.createElement('summary');
      summary.append(textElement('span', 'tool-status', statusSymbol(tool.status)), textElement('span', 'tool-summary', tool.summary || tool.name), textElement('small', '', toolMeta(tool)));
      const detail = document.createElement('div'); detail.className = 'tool-detail';
      if (tool.changedFiles?.length) detail.append(textElement('div', 'tool-files', t('chat.toolFiles', { files: tool.changedFiles.join(t('common.listSeparator')) })));
      if (tool.input) detail.append(detailBlock(t('chat.toolInput'), tool.input, tool.risk === 'command' ? commandText(tool.input) : undefined));
      if (tool.output) detail.append(detailBlock(t('chat.toolOutput'), tool.output));
      if (!tool.input && !tool.output) detail.append(textElement('p', 'tool-cleaned', tool.finishedAt ? t('chat.toolCleaned') : t('chat.toolWaiting')));
      details.append(summary, detail); section.append(details);
    }
    return section;
  }

  function detailBlock(label, value, preferredCopyText) {
    const block = document.createElement('div'); block.className = 'tool-detail-block';
    const heading = document.createElement('div'); heading.className = 'tool-detail-heading';
    const idleLabel = preferredCopyText ? t('chat.copyCommand') : t('common.copy');
    const copy = textElement('button', '', idleLabel); copy.type = 'button'; copy.title = preferredCopyText ? t('chat.copyActualCommand') : t('chat.copyLabel', { label });
    copy.addEventListener('click', () => requestClipboardWrite(preferredCopyText || value, copy, idleLabel));
    const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = value; pre.append(code);
    heading.append(textElement('strong', '', label), copy); block.append(heading, pre); return block;
  }

  function commandText(value) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.command === 'string' && parsed.command.trim()) return parsed.command;
    } catch {
      // Non-JSON command input is already directly copyable.
    }
    return value;
  }

  function statusSymbol(status) { return status === 'success' ? '✓' : status === 'denied' ? '−' : status === 'error' ? '!' : '…'; }
  function toolMeta(tool) {
    const labels = { read: t('chat.risk.read'), write: t('chat.risk.write'), command: t('chat.risk.command') };
    const duration = tool.finishedAt && tool.startedAt ? ` · ${formatDuration(tool.finishedAt - tool.startedAt)}` : '';
    return `${labels[tool.risk] || tool.name}${duration}`;
  }

  function renderReasoning(reasoning, streaming) {
    const details = document.createElement('details'); details.className = 'reasoning';
    details.dataset.detailKey = 'reasoning';
    // 默认收起：思考过程是给想追根究底的人看的，不该一上来就占满视野。
    details.dataset.defaultOpen = '0';
    const content = document.createElement('div'); content.className = 'reasoning-content'; appendRichText(content, reasoning);
    const summary = document.createElement('summary');
    // 标题上直接写清「现在在干什么 / 里面有多少内容」，不用点开也能判断要不要看。
    const chars = String(reasoning || '').replace(/\s+/g, '').length;
    summary.append(
      textElement('span', 'reasoning-title', t('chat.reasoningTitle')),
      textElement('small', 'reasoning-hint', streaming ? t('chat.reasoningStreaming') : t('chat.reasoningChars', { count: chars })),
    );
    details.append(summary, content); return details;
  }

  /**
   * 把回复正文渲染成「结构」，而不是一大段等宽文本。
   * 支持：围栏代码块、标题（# ~ ######）、有序/无序列表（按缩进嵌套）、表格、
   * 引用、分隔线、段落；行内支持 **加粗**、`代码`、~~删除~~、[文字](链接)、裸链接。
   * 全程用 DOM + textContent 构造，不拼 HTML 字符串——模型输出里的尖括号永远是文字。
   */
  function appendRichText(container, text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    let paragraph = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const value = paragraph.join('\n').trim();
      paragraph = [];
      if (!value) return;
      const node = document.createElement('p');
      appendInline(node, value);
      container.append(node);
    };
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] || '';
      // 围栏代码块。流式输出时结束围栏可能还没到，先按代码块渲染，避免整段闪成正文。
      const fence = line.match(/^\s*```\s*([^\s`]*)/);
      if (fence) {
        flushParagraph();
        const code = [];
        const language = fence[1] || '';
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index] || '')) { code.push(lines[index] || ''); index += 1; }
        index += 1;
        container.append(codeBlockNode(code.join('\n'), language));
        continue;
      }
      if (!line.trim()) { flushParagraph(); index += 1; continue; }
      // 分隔线：--- / *** / ___（三个以上同类符号）
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        flushParagraph();
        container.append(document.createElement('hr'));
        index += 1;
        continue;
      }
      // 标题：# 到 ######，行尾多余的 # 只是装饰
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph();
        const node = document.createElement(`h${heading[1].length}`);
        appendInline(node, heading[2]);
        container.append(node);
        index += 1;
        continue;
      }
      // 表格：表头行 + |---|---| 分隔行
      if (isTableStart(lines, index)) { flushParagraph(); index = appendTable(container, lines, index); continue; }
      // 引用：连续的 > 行合成一个引用块，块内再走一遍同样的排版
      if (/^\s{0,3}>/.test(line)) {
        flushParagraph();
        const quoted = [];
        while (index < lines.length) {
          const current = lines[index] || '';
          if (/^\s{0,3}>/.test(current)) { quoted.push(current.replace(/^\s{0,3}>\s?/, '')); index += 1; continue; }
          if (!current.trim() && /^\s{0,3}>/.test(lines[index + 1] || '')) { quoted.push(''); index += 1; continue; }
          break;
        }
        const node = document.createElement('blockquote');
        appendRichText(node, quoted.join('\n'));
        container.append(node);
        continue;
      }
      // 列表：层级由 appendList 按缩进算，正文里不再叠加第二套缩进规则
      if (isListLine(line)) { flushParagraph(); index = appendList(container, lines, index); continue; }
      paragraph.push(line);
      index += 1;
    }
    flushParagraph();
  }

  /** 代码块：终端命令与普通代码用不同底色和标题，方便非技术读者区分「要我做什么」和「这是什么」。 */
  function codeBlockNode(codeText, language) {
    const shellLanguage = /^(bash|zsh|sh|shell|powershell|pwsh|cmd|bat|terminal|console)$/i.test(language) || (!language && looksLikeShell(codeText));
    const wrapper = document.createElement('div');
    wrapper.className = `code-block${shellLanguage ? ' terminal-command' : ''}`;
    const header = document.createElement('div'); header.className = 'code-header';
    const idleLabel = shellLanguage ? t('chat.copyCommand') : t('common.copy');
    const copy = textElement('button', '', idleLabel); copy.type = 'button';
    copy.title = shellLanguage ? t('chat.copyTerminalCommand') : t('chat.copyCode');
    copy.addEventListener('click', () => requestClipboardWrite(codeText, copy, idleLabel));
    const pre = document.createElement('pre');
    const codeNode = document.createElement('code'); codeNode.textContent = codeText; pre.append(codeNode);
    header.append(textElement('span', '', shellLanguage ? t('chat.terminalCommand', { language: language || 'shell' }) : (language || 'code')), copy);
    wrapper.append(header, pre);
    return wrapper;
  }

  function isListLine(line) { return /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/.test(String(line || '')); }

  /**
   * 列表：按缩进算出层级，缩进变深就往下挂一层。
   * 有序 / 无序在同一层级切换时另起一个列表，序号从原文写的数字开始。
   */
  function appendList(container, lines, start) {
    const items = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index] || '';
      if (!line.trim()) {
        let next = index + 1;
        while (next < lines.length && !String(lines[next] || '').trim()) next += 1;
        if (next < lines.length && isListLine(lines[next])) { index = next; continue; }
        break;
      }
      const match = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+([\s\S]*)$/);
      if (!match) {
        // 缩进的续行并入上一条，而不是断开列表
        if (items.length && /^\s+\S/.test(line)) { items[items.length - 1].text += `\n${line.trim()}`; index += 1; continue; }
        break;
      }
      items.push({
        indent: match[1].replace(/\t/g, '    ').length,
        ordered: /\d/.test(match[2]),
        startNumber: Number.parseInt(match[2], 10) || 1,
        text: match[3],
      });
      index += 1;
    }
    const stack = [];
    for (const item of items) {
      while (stack.length && item.indent < stack[stack.length - 1].indent) stack.pop();
      let frame = stack[stack.length - 1];
      const tagName = item.ordered ? 'ol' : 'ul';
      if (!frame || item.indent > frame.indent) {
        const list = document.createElement(tagName);
        if (item.ordered && item.startNumber !== 1) list.start = item.startNumber;
        if (frame?.li) frame.li.append(list); else container.append(list);
        frame = { indent: item.indent, list, li: null };
        stack.push(frame);
      } else if (frame.list.tagName.toLowerCase() !== tagName) {
        const list = document.createElement(tagName);
        if (item.ordered && item.startNumber !== 1) list.start = item.startNumber;
        frame.list.after(list);
        frame.list = list;
        frame.li = null;
      }
      const li = document.createElement('li');
      appendInline(li, item.text);
      frame.list.append(li);
      frame.li = li;
    }
    return index;
  }

  function splitTableRow(line) {
    let value = String(line || '').trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split('|').map((cell) => cell.trim());
  }

  function tableAlignOf(cell) {
    const value = String(cell || '');
    const left = value.startsWith(':');
    const right = value.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return '';
  }

  /** 表头行 + 分隔行同时成立才算表格，避免把正文里的竖线误判成表。 */
  function isTableStart(lines, index) {
    const head = String(lines[index] || '');
    const rule = String(lines[index + 1] || '');
    if (!head.includes('|') || !rule.includes('-')) return false;
    if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(rule)) return false;
    const separators = splitTableRow(rule);
    if (!separators.length || !separators.every((cell) => /^:?-+:?$/.test(cell))) return false;
    return splitTableRow(head).length === separators.length;
  }

  function appendTable(container, lines, start) {
    const aligns = splitTableRow(lines[start + 1]).map(tableAlignOf);
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const [column, cell] of splitTableRow(lines[start]).entries()) {
      const th = document.createElement('th');
      if (aligns[column]) th.style.textAlign = aligns[column];
      appendInline(th, cell);
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    let index = start + 2;
    while (index < lines.length) {
      const line = lines[index] || '';
      if (!line.trim() || !line.includes('|')) break;
      const cells = splitTableRow(line);
      const row = document.createElement('tr');
      for (let column = 0; column < Math.max(cells.length, aligns.length); column += 1) {
        const td = document.createElement('td');
        if (aligns[column]) td.style.textAlign = aligns[column];
        appendInline(td, cells[column] || '');
        row.append(td);
      }
      body.append(row);
      index += 1;
    }
    const table = document.createElement('table'); table.append(head, body);
    const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.append(table);
    container.append(wrap);
    return index;
  }

  function looksLikeShell(value) {
    return /^(?:\$\s*)?(?:npm|pnpm|yarn|git|cd|ls|mkdir|rm|cp|mv|curl|wget|python3?|node|npx|docker|kubectl|gradle|\.\/|swift|go|cargo|chmod|chown|brew|apt|pip3?|export|setx|powershell)\b/im.test(value.trim());
  }

  /** 行内格式：`代码`、**加粗**、~~删除~~、[文字](链接)、裸链接。 */
  function appendInline(parent, value) {
    // 只把「目标看起来像链接」的 [文字](目标) 当链接：目标必须以 http(s)://、mailto:、# 或 / 开头，
    // 这样 [文字](javascript:…) 之类的构造连匹配都不会匹配，不会出现半个链接加一个多余的右括号。
    const pattern = /(`[^`]+`|\*\*[^*\n]+\*\*|\*[^\s*][^*\n]*\*|~~[^~\n]+~~|\[[^\]\n]+\]\((?:https?:\/\/|mailto:|#|\/)[^)\s]*\)|https?:\/\/[^\s<]+)/g; let cursor = 0;
    for (const match of value.matchAll(pattern)) {
      const index = match.index || 0; if (index > cursor) parent.append(document.createTextNode(value.slice(cursor, index))); const token = match[0];
      if (token.startsWith('`')) parent.append(textElement('code', '', token.slice(1, -1)));
      else if (token.startsWith('**')) parent.append(textElement('strong', '', token.slice(2, -2)));
      else if (token.startsWith('*')) parent.append(textElement('em', '', token.slice(1, -1)));
      else if (token.startsWith('~~')) parent.append(textElement('del', '', token.slice(2, -2)));
      else if (token.startsWith('[')) {
        const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const rawTarget = parts?.[2] || '';
        const link = textElement('a', '', parts?.[1] || token);
        // 只放行 http/https/mailto/站内锚点：webview 里不能让模型输出决定 href 的 scheme。
        link.href = /^(?:https?:\/\/|mailto:|#|\/)/i.test(rawTarget) ? rawTarget : '#';
        link.target = '_blank'; link.rel = 'noreferrer'; parent.append(link);
      }
      else { const link = textElement('a', '', token); link.href = token; link.target = '_blank'; link.rel = 'noreferrer'; parent.append(link); }
      cursor = index + token.length;
    }
    if (cursor < value.length) parent.append(document.createTextNode(value.slice(cursor)));
  }

  function renderAttachments() {
    elements.attachmentList.replaceChildren(); let fileIndex = 0;
    for (const attachment of state.pendingAttachments) {
      const chip = document.createElement('div'); chip.className = `attachment-chip${attachment.kind === 'image' && attachment.thumbnailDataUrl ? ' attachment-chip-image' : ''}`;
      if (attachment.kind === 'image' && attachment.thumbnailDataUrl) {
        const image = document.createElement('img'); image.src = attachment.thumbnailDataUrl; image.alt = '';
        chip.append(image);
      }
      const label = textElement('span', '', attachment.label); label.title = attachment.path || attachment.label;
      const size = textElement('small', '', attachment.kind === 'selection' ? t('chat.codeSelection') : formatBytes(attachment.bytes || 0));
      const remove = textElement('button', '', '×'); remove.type = 'button'; remove.title = t('common.remove');
      if (attachment.kind === 'selection') remove.addEventListener('click', () => post('removeContext'));
      else { const index = fileIndex; remove.addEventListener('click', () => post('removeAttachment', { index })); fileIndex += 1; }
      chip.append(label, size, remove); elements.attachmentList.append(chip);
    }
    elements.contextChip.hidden = true;
  }

  function renderHistoryLink() {
    const sourceId = state.conversation?.sourceConversationId;
    elements.historyLinkBanner.hidden = !sourceId;
    if (!sourceId) return;
    elements.sourceHistoryTitle.textContent = t('chat.sourceHistory', { title: state.conversation.sourceConversationTitle || t('chat.previousConversation') });
  }

  function updateComposerState() {
    const hasText = elements.promptInput.value.trim().length > 0 || state.pendingAttachments.length > 0; const archived = Boolean(state.conversation?.archived);
    elements.sendButton.disabled = !hasText || archived || state.permissionPresetPending; elements.sendButton.hidden = false; elements.stopButton.hidden = !state.streaming;
    elements.promptInput.disabled = archived; elements.attachButton.disabled = archived;
    elements.profileInput.disabled = state.streaming || archived; elements.modelInput.disabled = state.streaming || archived; elements.modeInput.disabled = state.streaming || archived; elements.skillsButton.disabled = state.streaming || archived;
    elements.refreshModelsButton.disabled = state.streaming || archived || Boolean(state.modelLoadingProfileId);
    elements.permissionPresetInput.disabled = state.streaming || archived || state.permissionPresetPending;
    elements.agentMaxStepsInput.disabled = state.streaming || archived;
    elements.reasoningEffortInput.disabled = state.streaming || archived || elements.reasoningEffortInput.dataset.support !== 'configurable';
    elements.voiceButton.disabled = archived;
    elements.detachHistoryButton.disabled = state.streaming || archived;
    elements.promptInput.placeholder = archived ? t('chat.promptPlaceholderArchived') : state.streaming ? t('chat.promptPlaceholderStreaming') : t('chat.promptPlaceholderAgent');
  }

  function autoResize() { elements.promptInput.style.height = 'auto'; elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 180)}px`; updateComposerState(); }
  function submit() {
    const text = elements.promptInput.value.trim();
    if ((!text && !state.pendingAttachments.length) || state.conversation?.archived || state.permissionPresetPending) return;
    elements.promptInput.value = ''; state.autoFollow = true; autoResize();
    if (state.streaming) post('sendWhileRunning', { text });
    else post('send', { text, mode: state.mode, skillIds: state.selectedSkillIds, permissionPreset: state.permissionPreset, agentMaxSteps: state.agentMaxSteps, reasoningEffort: state.reasoningEffort });
  }
  function setStreaming(value, conversationId = null) { state.streaming = value; state.streamingConversationId = value ? conversationId : null; renderHeader(); renderTaskTree(); updateComposerState(); }

  /** 运行中集合的增删：后台完成的对话不该把当前对话的发送按钮变成停止按钮。 */
  function markRunning(conversationId, running) {
    if (!conversationId) return;
    const set = new Set(state.runningConversationIds);
    if (running) set.add(conversationId); else set.delete(conversationId);
    state.runningConversationIds = [...set];
  }

  function updateStreamingFromRuns() {
    const currentId = state.conversation?.id;
    const running = Boolean(currentId && state.runningConversationIds.includes(currentId));
    if (running === state.streaming) { updateComposerState(); return; }
    setStreaming(running, currentId);
  }
  function showToast(text, tone = 'neutral') { elements.toast.textContent = text; elements.toast.dataset.tone = tone; elements.toast.hidden = false; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 4200); }
  function closeMobileHistory() { elements.app.classList.remove('history-open'); }
  function textElement(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; return node; }

  elements.newChatButton.addEventListener('click', () => { post('newChat'); closeMobileHistory(); });
  elements.historyButton.addEventListener('click', () => elements.app.classList.toggle('history-open'));
  elements.closeHistoryButton.addEventListener('click', closeMobileHistory);
  elements.archiveViewButton.addEventListener('click', () => post('showArchived', { value: !state.showArchived }));
  elements.settingsButton.addEventListener('click', () => post('openSettings')); elements.settingsButtonSide.addEventListener('click', () => post('openSettings'));
  elements.exportButton.addEventListener('click', () => post('exportConversation'));
  elements.archiveButton.addEventListener('click', () => { if (state.conversation) post('toggleArchive', { id: state.conversation.id, archived: !state.conversation.archived }); });
  elements.detachHistoryButton.addEventListener('click', () => post('detachConversationHistory'));
  elements.attachButton.addEventListener('click', () => post('attachFiles')); elements.removeContextButton.addEventListener('click', () => post('removeContext'));
  elements.stopButton.addEventListener('click', () => post('stop')); elements.skillsButton.addEventListener('click', () => { elements.skillsPanel.hidden = !elements.skillsPanel.hidden; });
  elements.approvalAllowButton.addEventListener('click', () => {
    const requestId = elements.approvalCard.dataset.requestId;
    if (requestId) post('approvalResponse', { requestId, allow: true });
  });
  elements.approvalDenyButton.addEventListener('click', () => {
    const requestId = elements.approvalCard.dataset.requestId;
    if (requestId) post('approvalResponse', { requestId, allow: false });
  });
  // 胶囊尺寸跟着面板宽度走：拖动侧边栏、切换分栏都会触发，重算一次即可（不重建 DOM）。
  let capsuleResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(capsuleResizeTimer);
    capsuleResizeTimer = setTimeout(() => { layoutTodoArchives(); updateScrollToBottom(); }, 60);
  });
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      // 只看宽度：胶囊缩小会改变这一行的高度，用高度触发会自己喂自己。
      const width = elements.todoArchiveBar.clientWidth;
      if (width && width !== lastCapsuleBarWidth) layoutTodoArchives();
    });
    observer.observe(elements.todoArchiveBar);
  }
  elements.historySearch.addEventListener('input', (event) => { state.search = event.target.value; renderHistory(); });
  elements.modelInput.addEventListener('change', (event) => { state.model = event.target.value; syncReasoningSelector(); post('setModel', { model: event.target.value }); });
  elements.profileInput.addEventListener('change', (event) => post('setProfile', { profileId: event.target.value }));
  elements.refreshModelsButton.addEventListener('click', () => post('refreshModels', { profileId: elements.profileInput.value }));
  elements.modeInput.addEventListener('change', (event) => { state.mode = event.target.value; post('setMode', { mode: state.mode }); renderHeader(); updateComposerState(); });
  elements.permissionPresetInput.addEventListener('change', (event) => {
    const permissionPreset = event.target.value;
    syncPermissionHint();
    if (permissionPreset === state.permissionPreset) return;
    state.permissionPresetPending = true;
    updateComposerState();
    post('setPermissionPreset', { permissionPreset });
  });
  elements.agentMaxStepsInput.addEventListener('change', (event) => {
    state.agentMaxSteps = Math.max(0, Math.floor(Number(event.target.value) || 0));
    post('setAgentMaxSteps', { agentMaxSteps: state.agentMaxSteps });
    renderHeader();
  });
  elements.reasoningEffortInput.addEventListener('change', (event) => {
    state.reasoningEffort = event.target.value || 'default';
    post('setReasoningEffort', { reasoningEffort: state.reasoningEffort });
    renderHeader();
  });
  elements.voiceButton.addEventListener('click', () => post('requestVoiceInput'));
  elements.composer.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  elements.promptInput.addEventListener('input', () => {
    if (pendingPaste && elements.promptInput.value !== pendingPaste.value) clearPendingPaste();
    autoResize();
  });
  elements.promptInput.addEventListener('keydown', (event) => {
    const pasteShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase() === 'v';
    if (pasteShortcut) {
      clearTimeout(pasteFallbackTimer);
      const requestId = `paste-${Date.now()}-${++pasteSequence}`;
      pendingPaste = {
        requestId,
        value: elements.promptInput.value,
        selectionStart: elements.promptInput.selectionStart ?? elements.promptInput.value.length,
        selectionEnd: elements.promptInput.selectionEnd ?? elements.promptInput.value.length,
      };
      pasteFallbackTimer = setTimeout(() => {
        if (pendingPaste?.requestId === requestId) post('readClipboardText', { requestId });
      }, 150);
      return;
    }
    const commandEnter = (event.metaKey || event.ctrlKey) && event.key === 'Enter';
    const regularEnter = state.sendOnEnter && event.key === 'Enter' && !event.shiftKey && !event.isComposing;
    if (commandEnter || regularEnter) { event.preventDefault(); submit(); }
  });
  elements.loadOlderButton.addEventListener('click', () => { const first = state.messages[0]; if (first) post('loadOlder', { before: first.id }); });
  // 可选链：万一 webview 仍加载旧 HTML（结构里没有这个按钮），这里不会中断后续初始化。
  elements.scrollToBottomButton?.addEventListener('click', () => {
    state.autoFollow = true;
    elements.messageViewport.scrollTo({ top: elements.messageViewport.scrollHeight, behavior: 'smooth' });
    updateScrollToBottom();
  });
  window.addEventListener('resize', updateScrollToBottom);
  elements.messageViewport.addEventListener('scroll', () => {
    if (!state.renderingMessages) state.autoFollow = isNearBottom();
    updateScrollToBottom();
  }, { passive: true });
  elements.promptInput.addEventListener('paste', (event) => {
    const files = clipboardFiles(event.clipboardData);
    const text = clipboardPlainText(event.clipboardData);
    if (!files.length && !text) return;
    clearPendingPaste();
    event.preventDefault();
    if (text) insertPromptText(text);
    void readClipboardFiles(files);
  });
  for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { elements.promptInput.value = button.dataset.prompt || ''; autoResize(); elements.promptInput.focus(); });
  document.addEventListener('click', (event) => { if (!elements.skillsPanel.hidden && !elements.skillsPanel.contains(event.target) && !elements.skillsButton.contains(event.target)) elements.skillsPanel.hidden = true; });
  elements.messageViewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // 用户在消息区按住鼠标（选中文字、点开工具详情）时暂停重建列表，
    // 避免点击展开后被紧随其后的流式渲染立刻收起。
    interactingWithMessages = true;
    if (event.target instanceof Element && event.target.closest('.message-body')) selectingMessageText = true;
    // 兜底：指针在窗口外松开时可能收不到 pointerup，超时后恢复渲染。
    clearTimeout(interactionTimer);
    interactionTimer = setTimeout(releaseMessageInteraction, 3000);
  });
  document.addEventListener('pointerup', releaseMessageInteraction);
  document.addEventListener('pointercancel', releaseMessageInteraction);
  window.addEventListener('blur', releaseMessageInteraction);
  document.addEventListener('selectionchange', () => {
    if (!selectingMessageText) flushDeferredMessageRender();
  });
  document.addEventListener('copy', (event) => {
    const text = selectedTextForCopy(event.target);
    if (!text) return;
    try {
      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        return;
      }
    } catch {
      // Fall through to the VS Code clipboard bridge.
    }
    post('copyText', { text });
  });
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLocaleLowerCase() !== 'c') return;
    const text = selectedTextForCopy(document.activeElement);
    if (text) post('copyText', { text });
  }, true);

  function selectedTextForCopy(target) {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      return end > start ? target.value.slice(start, end) : '';
    }
    return window.getSelection()?.toString() || '';
  }

  function clipboardFiles(data) {
    if (!data) return [];
    const itemFiles = [...(data.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    return itemFiles.length ? itemFiles : [...(data.files || [])];
  }

  function clipboardPlainText(data) {
    if (!data) return '';
    const plain = data.getData('text/plain');
    if (plain) return plain;
    const html = data.getData('text/html');
    if (!html) return '';
    return new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
  }

  function insertPromptText(text) {
    if (!text || elements.promptInput.disabled) return;
    const input = elements.promptInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(text, start, end, 'end');
    autoResize();
    input.focus();
  }

  async function readClipboardFiles(files) {
    const encoded = [];
    for (const file of files.slice(0, 20)) {
      try {
        const buffer = await file.arrayBuffer();
        const thumbnailDataUrl = file.type.startsWith('image/') ? await imageThumbnailDataUrl(file) : undefined;
        encoded.push({ name: file.name || (file.type.startsWith('image/') ? t('chat.pastedImage') : t('chat.pastedFile')), mimeType: file.type, size: buffer.byteLength, dataBase64: arrayBufferToBase64(buffer), thumbnailDataUrl });
      } catch (error) {
        showToast(t('chat.clipboardReadFailed', { error: error?.message || error }), 'warning');
      }
    }
    if (encoded.length) post('attachClipboardFiles', { files: encoded });
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer); let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    return btoa(binary);
  }

  async function imageThumbnailDataUrl(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 160 / bitmap.width, 120 / bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return undefined;
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); context.drawImage(bitmap, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', .78);
      return dataUrl.length <= 120_000 ? dataUrl : undefined;
    } catch {
      return undefined;
    } finally {
      bitmap?.close?.();
    }
  }

  function startVoiceRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast(t('chat.noSpeechRecognition'), 'warning');
      return;
    }
    if (state.voiceRecognition) {
      state.voiceRecognition.stop();
      return;
    }
    const recognition = new SpeechRecognition();
    state.voiceRecognition = recognition; state.voiceActive = true;
    recognition.lang = navigator.language || 'zh-CN'; recognition.interimResults = true; recognition.continuous = false;
    const original = elements.promptInput.value;
    recognition.onresult = (event) => {
      let finalTranscript = '';
      let interimTranscript = '';
      for (let index = 0; index < event.results.length; index += 1) {
        const value = event.results[index][0]?.transcript || '';
        if (event.results[index].isFinal) finalTranscript += value;
        else interimTranscript += value;
      }
      const transcript = `${finalTranscript}${interimTranscript}`;
      elements.promptInput.value = `${original}${original && transcript ? ' ' : ''}${transcript}`;
      autoResize();
    };
    recognition.onerror = (event) => showToast(t('chat.speechFailed', { error: event.error || t('common.unknown') }), 'warning');
    recognition.onend = () => { state.voiceRecognition = null; state.voiceActive = false; elements.voiceButton.classList.remove('active'); updateComposerState(); };
    elements.voiceButton.classList.add('active');
    try { recognition.start(); } catch (error) { recognition.onend(); showToast(t('chat.speechStartFailed', { error: error?.message || error }), 'warning'); }
    updateComposerState();
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state': {
        const previousConversationId = state.conversation?.id;
        const incoming = message.state; state.conversations = incoming.conversations || []; state.archivedConversations = incoming.archivedConversations || [];
        state.conversation = incoming.conversation; state.messages = incoming.messages || []; state.hasMore = Boolean(incoming.hasMore);
        state.sendOnEnter = incoming.settings?.sendOnEnter !== false; state.pendingAttachments = incoming.pendingAttachments || [];
        state.apiProfiles = incoming.settings?.apiProfiles || []; state.activeApiProfileId = incoming.settings?.activeApiProfileId || ''; state.model = incoming.settings?.model || ''; state.modelOptionsByProfile = incoming.modelOptionsByProfile || {};
        state.permissionPreset = incoming.settings?.permissionPreset || 'review'; state.agentMaxSteps = Math.max(0, Math.floor(Number(incoming.settings?.agentMaxSteps) || 0)); state.reasoningEffort = incoming.settings?.reasoningEffort || 'default';
        state.permissionPresetPending = false;
        state.skills = incoming.skills || []; state.selectedSkillIds = incoming.selectedSkillIds || []; state.mode = incoming.mode || 'agent';
        state.workspaceTrusted = Boolean(incoming.workspaceTrusted); state.agentAvailable = Boolean(incoming.agentAvailable); state.availableToolCount = Number(incoming.availableToolCount) || 0; state.showArchived = Boolean(incoming.showArchived); state.taskTree = incoming.taskTree || (message.streamingConversationId ? state.taskTree : null); state.todos = Array.isArray(incoming.todos) ? incoming.todos : [];
        state.todoArchives = Array.isArray(incoming.todoArchives) ? incoming.todoArchives : [];
        state.todosInterrupted = Boolean(incoming.todosInterrupted);
        state.runningConversationIds = Array.isArray(incoming.runningConversationIds) ? incoming.runningConversationIds : [];
        state.pendingApprovals = Array.isArray(incoming.pendingApprovals) ? incoming.pendingApprovals : [];
        elements.modelInput.value = state.model || 'deepseek-flash'; if (previousConversationId !== incoming.conversation?.id) state.autoFollow = true; setStreaming(Boolean(message.streamingConversationId), message.streamingConversationId); renderAll(); break;
      }
      case 'draft': elements.promptInput.value = message.text || ''; state.pendingAttachments = message.attachments || []; renderAttachments(); autoResize(); elements.promptInput.focus(); break;
      case 'attachments': state.pendingAttachments = message.attachments || []; renderAttachments(); break;
      case 'context': state.pendingAttachments = state.pendingAttachments.filter((item) => item.kind !== 'selection'); renderAttachments(); break;
      case 'messageStart': {
        markRunning(message.conversationId, true);
        // 发送准备期间用户可能已经切到别的对话：那种情况下不要把它塞进当前消息列表。
        if (state.conversation?.id && state.conversation.id !== message.conversationId) { renderHistory(); break; }
        state.conversation = state.conversation || { id: message.conversationId, title: message.userMessage.content, mode: state.mode };
        state.messages.push(message.userMessage, message.assistant); state.pendingAttachments = []; state.autoFollow = true;
        setStreaming(true, message.conversationId); renderMessages('bottom'); renderAttachments(); renderHistory(); break;
      }
      case 'messageAdded': if (message.conversationId === state.conversation?.id) { state.messages.push(message.message); state.pendingAttachments = []; renderMessages(state.autoFollow ? 'bottom' : 'keep'); renderAttachments(); } break;
      case 'streamDelta': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.content = `${target.content || ''}${message.content || ''}`; target.reasoning = `${target.reasoning || ''}${message.reasoning || ''}`; scheduleMessageRender(); } break; }
      case 'toolExecutions': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.toolExecutions = message.tools || []; scheduleMessageRender(); } break; }
      case 'skillUsage': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.usedSkills = message.skills || []; scheduleMessageRender(); } break; }
      case 'messageComplete': { if (message.conversationId !== state.conversation?.id) break; if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; } const index = state.messages.findIndex((item) => item.id === message.message.id); if (index >= 0) state.messages[index] = message.message; else state.messages.push(message.message); renderMessages('keep'); break; }
      case 'streamIdle': markRunning(message.conversationId, false); if (!message.conversationId || message.conversationId === state.conversation?.id) { setStreaming(false); renderTaskTree(); elements.promptInput.focus(); } renderHistory(); break;
      case 'runs': state.runningConversationIds = Array.isArray(message.runningConversationIds) ? message.runningConversationIds : []; updateStreamingFromRuns(); renderHistory(); break;
      case 'history': state.conversations = message.conversations || []; state.archivedConversations = message.archivedConversations || []; state.runningConversationIds = Array.isArray(message.runningConversationIds) ? message.runningConversationIds : state.runningConversationIds; renderHistory(); updateStreamingFromRuns(); break;
      case 'approvalRequest': if (message.request) { state.pendingApprovals = [...state.pendingApprovals.filter((item) => item.requestId !== message.request.requestId), message.request]; renderApproval(); renderHistory(); updateComposerState(); } break;
      case 'approvalResolved': state.pendingApprovals = state.pendingApprovals.filter((item) => item.requestId !== message.requestId); renderApproval(); renderHistory(); break;
      case 'olderMessages': state.messages = [...message.messages, ...state.messages]; state.hasMore = Boolean(message.hasMore); renderMessages('prepend'); break;
      case 'modelChanged': state.model = message.model; if (state.conversation) state.conversation.model = message.model; state.reasoningEffort = message.reasoningEffort || 'default'; elements.modelInput.value = message.model; syncReasoningSelector(); updateComposerState(); showToast(t('chat.modelChanged', { model: message.model })); break;
      case 'profileChanged': state.activeApiProfileId = message.profileId; state.model = message.model; state.reasoningEffort = message.reasoningEffort || 'default'; if (state.conversation) { state.conversation.apiProfileId = message.profileId; state.conversation.model = message.model; } elements.modelInput.value = message.model; renderHeader(); showToast(t('chat.profileChanged')); break;
      case 'modelsLoading': state.modelLoadingProfileId = message.active ? message.profileId : state.modelLoadingProfileId === message.profileId ? null : state.modelLoadingProfileId; renderHeader(); updateComposerState(); break;
      case 'modelsChanged': {
        const profile = state.apiProfiles.find((item) => item.id === message.profileId);
        if (profile) profile.models = message.models || profile.models;
        state.modelOptionsByProfile[message.profileId] = message.options || [];
        const activeProfileId = state.conversation?.apiProfileId || state.activeApiProfileId;
        if (activeProfileId === message.profileId && message.model) {
          if (state.conversation) state.conversation.model = message.model;
          state.model = message.model;
          elements.modelInput.value = message.model;
        }
        syncConnectionSelectors();
        break;
      }
      case 'modeChanged': state.mode = message.mode; renderHeader(); break;
      case 'skillsChanged': state.selectedSkillIds = message.skillIds || []; renderSkills(); renderHeader(); break;
      case 'permissionPresetPending': state.permissionPresetPending = Boolean(message.active); updateComposerState(); break;
      case 'permissionPresetChanged': state.permissionPreset = message.permissionPreset || 'review'; elements.permissionPresetInput.value = state.permissionPreset; syncPermissionHint(); break;
      case 'agentMaxStepsChanged': state.agentMaxSteps = Math.max(0, Math.floor(Number(message.agentMaxSteps) || 0)); ensureStepOption(state.agentMaxSteps); elements.agentMaxStepsInput.value = String(state.agentMaxSteps); break;
      case 'reasoningEffortChanged': state.reasoningEffort = message.reasoningEffort || 'default'; elements.reasoningEffortInput.value = state.reasoningEffort; break;
      case 'taskTreeChanged': if (message.conversationId && message.conversationId !== state.conversation?.id) break; state.taskTree = message.taskTree || null; renderTaskTree(); updateComposerState(); break;
      case 'todos': if (message.conversationId && message.conversationId !== state.conversation?.id) break; state.todos = Array.isArray(message.todos) ? message.todos : []; state.todosInterrupted = Boolean(message.interrupted); renderTodos(); break;
      case 'todoArchives': if (message.conversationId && message.conversationId !== state.conversation?.id) break; state.todoArchives = Array.isArray(message.todoArchives) ? message.todoArchives : []; renderArchivePanel(); renderTodoArchives(); break;
      case 'voiceInputAllowed': startVoiceRecognition(); break;
      case 'clipboardWriteResult': finishClipboardWrite(message.requestId, Boolean(message.ok), message.error); break;
      case 'clipboardText':
        if (message.requestId === pendingPaste?.requestId) {
          const snapshot = pendingPaste;
          clearPendingPaste();
          if (elements.promptInput.value === snapshot.value) {
            elements.promptInput.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
            insertPromptText(message.text || '');
          }
          if (message.truncated) showToast(t('chat.clipboardTruncated'), 'warning');
        }
        break;
      case 'toast': showToast(message.text, message.tone); break;
    }
  });

  function formatTime(value) { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
  function relativeTime(value) { const delta = Date.now() - value; if (delta < 60_000) return t('time.justNow'); if (delta < 3_600_000) return t('time.minutesAgo', { count: Math.floor(delta / 60_000) }); if (delta < 86_400_000) return t('time.hoursAgo', { count: Math.floor(delta / 3_600_000) }); if (delta < 604_800_000) return t('time.daysAgo', { count: Math.floor(delta / 86_400_000) }); return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value)); }
  function formatBytes(bytes) { if (!bytes) return t('common.file'); if (bytes < 1024) return `${bytes} B`; return `${(bytes / 1024).toFixed(1)} KB`; }
  function formatDuration(ms) { if (ms < 1000) return `${ms} ms`; if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`; return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`; }
  function formatMillionTokens(tokens) {
    const millions = Math.max(0, Number(tokens) || 0) / 1_000_000;
    const digits = millions >= 1 ? 2 : millions >= .01 ? 3 : 6;
    return `${millions.toFixed(digits)}M`;
  }

  autoResize(); post('ready');
})();
