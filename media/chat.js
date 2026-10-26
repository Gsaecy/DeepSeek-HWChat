(() => {
  const vscode = acquireVsCodeApi();
  const elements = Object.fromEntries([
    'app', 'historyPane', 'historyButton', 'closeHistoryButton', 'newChatButton',
    'historySearch', 'archiveViewButton', 'conversationList', 'settingsButton',
    'settingsButtonSide', 'exportButton', 'archiveButton', 'conversationTitle',
    'connectionState', 'profileInput', 'modelInput', 'modeInput', 'refreshModelsButton', 'skillsButton', 'skillsCount',
    'skillsPanel', 'skillsList', 'workspaceTrustBadge', 'messageViewport',
    'messageList', 'emptyState', 'loadOlderButton', 'attachmentList', 'contextChip',
    'contextLabel', 'removeContextButton', 'composer', 'promptInput', 'composerHint',
    'historyLinkBanner', 'sourceHistoryTitle', 'detachHistoryButton',
    'permissionPresetInput', 'agentMaxStepsInput', 'reasoningEffortInput', 'voiceButton',
    'agentRunState', 'agentRunLabel', 'agentRunMeta', 'taskTree', 'taskTreeSummary', 'taskTreeList',
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
    taskTree: null, autoFollow: true, renderingMessages: false, voiceRecognition: null, voiceActive: false,
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

  function requestClipboardWrite(text, button, idleLabel = '复制') {
    if (!text) {
      showToast('没有可复制的内容。', 'warning');
      return;
    }
    const requestId = `copy-${Date.now()}-${++clipboardSequence}`;
    if (button) {
      button.disabled = true;
      button.textContent = '复制中…';
    }
    const timer = setTimeout(() => finishClipboardWrite(requestId, false, '写入剪贴板超时。'), 3_000);
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
      pending.button.textContent = ok ? '已复制' : pending.idleLabel;
      if (ok) setTimeout(() => { if (pending.button.isConnected) pending.button.textContent = pending.idleLabel; }, 1_200);
    }
    if (!ok) showToast(`复制失败：${error || '无法访问系统剪贴板'}`, 'warning');
  }

  function renderAll() {
    renderHistory(); renderHeader(); renderSkills(); renderMessages('replace'); renderHistoryLink(); renderAttachments(); renderTaskTree(); updateComposerState();
  }

  function renderHistory() {
    const query = state.search.trim().toLocaleLowerCase();
    const source = state.showArchived ? state.archivedConversations : state.conversations;
    const conversations = source.filter((item) => !query || `${item.title} ${item.preview || ''}`.toLocaleLowerCase().includes(query));
    elements.archiveViewButton.classList.toggle('active', state.showArchived);
    const archiveLabel = elements.archiveViewButton.querySelector('span:last-child');
    if (archiveLabel) archiveLabel.textContent = state.showArchived ? '返回对话' : `显示归档${state.archivedConversations.length ? ` (${state.archivedConversations.length})` : ''}`;
    elements.conversationList.replaceChildren();
    if (!conversations.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = query ? '没有匹配的对话' : state.showArchived ? '没有已归档的对话' : '对话会安全地保存在本机';
      elements.conversationList.append(empty);
      return;
    }
    for (const conversation of conversations) {
      const row = document.createElement('div');
      row.className = `conversation-row${state.conversation?.id === conversation.id ? ' active' : ''}`;
      const content = document.createElement('button');
      content.type = 'button'; content.className = 'conversation-content';
      const title = textElement('span', 'conversation-title', conversation.title);
      const tokenTotal = conversation.totalTokens ? ` · ${formatMillionTokens(conversation.totalTokens)} tokens` : '';
      const linked = conversation.sourceConversationId ? '续接 · ' : '';
      const meta = textElement('span', 'conversation-meta', `${linked}${relativeTime(conversation.updatedAt)}${tokenTotal}`);
      const preview = textElement('span', 'conversation-preview', conversation.preview || '空对话');
      content.append(title, meta, preview);
      content.addEventListener('click', () => { post('selectConversation', { id: conversation.id }); closeMobileHistory(); });
      const actions = document.createElement('div'); actions.className = 'conversation-actions';
      const continueTask = actionButton('在新对话中续接任务历史', '↗');
      continueTask.disabled = state.streaming;
      continueTask.addEventListener('click', () => { post('continueConversation', { id: conversation.id }); closeMobileHistory(); });
      const pin = actionButton(conversation.pinned ? '取消固定' : '固定', conversation.pinned ? '●' : '○');
      pin.addEventListener('click', () => post('togglePin', { id: conversation.id, pinned: !conversation.pinned }));
      const archive = actionButton(conversation.archived ? '恢复对话' : '归档', conversation.archived ? '↺' : '□');
      archive.addEventListener('click', () => post('toggleArchive', { id: conversation.id, archived: !conversation.archived }));
      const remove = actionButton('删除', '×'); remove.classList.add('danger-action');
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
    elements.conversationTitle.textContent = state.conversation?.title || '新对话';
    syncConnectionSelectors();
    elements.modeInput.value = state.mode; elements.exportButton.disabled = !state.conversation;
    elements.archiveButton.disabled = !state.conversation || state.streaming;
    elements.archiveButton.title = archived ? '恢复对话' : '归档';
    elements.connectionState.textContent = state.streaming ? 'Agent 正在执行' : archived ? '已归档 · 只读' : state.mode !== 'chat' && !state.workspaceTrusted ? '未信任 · 写入与命令受限' : `准备就绪${state.availableToolCount ? ` · ${state.availableToolCount} 个工具` : ''}`;
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
    elements.refreshModelsButton.title = modelsLoading ? '正在刷新模型列表' : '刷新模型列表';
  }

  function syncPermissionHint() {
    const selected = elements.permissionPresetInput.selectedOptions[0];
    const hint = selected?.title || '';
    elements.permissionPresetInput.title = hint ? `权限预设：${hint}` : '权限预设';
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
    const labels = { default: '默认', none: '无', low: '低', high: '高', max: '最大值' };
    let efforts = ['default'];
    let title = '当前模型未声明思考深度能力';
    if (support === 'configurable') {
      efforts = modelOption?.reasoningEfforts?.length ? modelOption.reasoningEfforts : ['default', 'none', 'low', 'high', 'max'];
      if (!efforts.includes('default')) efforts.unshift('default');
      title = '当前模型支持调节思考深度';
    } else if (support === 'unsupported') {
      title = '当前模型不支持思考深度设置';
    } else if (support === 'fixed') {
      title = '当前模型的思考模式由模型固定';
    }
    if (!efforts.includes(state.reasoningEffort)) state.reasoningEffort = 'default';
    const singleLabel = support === 'unsupported' ? '不支持' : support === 'fixed' ? '模型固定' : support === 'unknown' ? '能力未知' : undefined;
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
    const option = document.createElement('option'); option.value = String(normalized); option.textContent = `${normalized} 步`;
    elements.agentMaxStepsInput.append(option);
  }

  function renderSkills() {
    elements.skillsList.replaceChildren();
    elements.workspaceTrustBadge.textContent = state.workspaceTrusted ? '工作区已信任' : '工作区未信任';
    elements.workspaceTrustBadge.classList.toggle('trusted', state.workspaceTrusted);
    if (!state.skills.length) {
      elements.skillsList.append(textElement('p', 'skills-empty', '未发现 Skill。可放入 .hwchat/skills 或兼容的 SKILL.md 目录。'));
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
      if (skill.defaultEnabled) title.append(textElement('em', 'skill-badge', '默认启用'));
      if (skill.lastUsedAt) title.append(textElement('em', 'skill-badge used', '已调用'));
      copy.append(title, textElement('small', '', skill.description || skill.relativePath), textElement('code', '', skill.relativePath));
      label.append(input, copy); elements.skillsList.append(label);
    }
  }

  function isNearBottom() {
    const viewport = elements.messageViewport;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 72;
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
    elements.agentRunLabel.textContent = current?.title ? `Agent 正在执行：${current.title}` : 'Agent 正在执行';
    elements.agentRunMeta.textContent = [routing ? `${routing} 条判断中` : '', queued ? `${queued} 条排队` : ''].filter(Boolean).join(' · ');
    elements.taskTreeSummary.textContent = `${nodes.length} 个节点${queued ? ` · ${queued} 个排队` : ''}`;
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
  function taskStatusLabel(status) { return ({ active: '执行中', routing: '判断关联性', merged: '已合并', queued: '排队', complete: '完成', cancelled: '已取消', error: '失败' })[status] || status; }

  function renderMessage(message) {
    const article = document.createElement('article');
    article.className = `message ${message.role}${message.status === 'error' ? ' error' : ''}`; article.dataset.messageId = message.id;
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const author = textElement('span', '', message.role === 'user' ? '你' : 'HWChat');
    const time = textElement('time', '', formatTime(message.createdAt)); time.dateTime = new Date(message.createdAt).toISOString(); meta.append(author, time);
    if (message.content) {
      const copy = textElement('button', 'message-copy-button', '复制'); copy.type = 'button'; copy.title = '复制这条消息';
      copy.addEventListener('click', () => requestClipboardWrite(message.content, copy));
      meta.append(copy);
    }
    const body = document.createElement('div'); body.className = 'message-body';
    const attached = [message.context, ...(message.attachments || [])].filter(Boolean);
    if (attached.length) body.append(renderMessageAttachments(attached));
    if (message.toolExecutions?.length) body.append(renderToolExecutions(message.toolExecutions));
    if (message.usedSkills?.length) body.append(renderSkillUsage(message.usedSkills));
    if (message.reasoning) body.append(renderReasoning(message.reasoning));
    const content = document.createElement('div'); content.className = 'message-content';
    const emptyStatusText = message.status === 'queued' ? '已加入任务队列，等待当前分支完成…' : message.status === 'streaming' ? '正在继续处理…' : '';
    appendRichText(content, message.content || emptyStatusText); body.append(content);
    if (message.status === 'streaming') { const cursor = document.createElement('span'); cursor.className = 'stream-cursor'; cursor.setAttribute('aria-label', '生成中'); body.append(cursor); }
    if (message.usage?.totalTokens) body.append(textElement('div', 'message-usage', `${formatMillionTokens(message.usage.totalTokens)} tokens`));
    article.append(meta, body); return article;
  }

  function renderSkillUsage(skills) {
    const details = document.createElement('details'); details.className = 'message-skills';
    details.dataset.detailKey = 'skills';
    details.dataset.defaultOpen = '0';
    const summary = document.createElement('summary'); summary.textContent = `本轮调用 ${skills.length} 个 Skill`;
    const list = document.createElement('div'); list.className = 'message-skills-list';
    for (const skill of skills) {
      const row = document.createElement('span'); row.title = skill.relativePath;
      row.append(textElement('strong', '', skill.name), textElement('small', '', skill.source === 'copilot' ? '快捷调用' : skill.source));
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
    section.append(textElement('div', 'tool-stack-heading', `${tools.length} 个执行步骤${changed.size ? ` · 修改 ${changed.size} 个文件` : ''}`));
    for (const [index, tool] of tools.entries()) {
      const details = document.createElement('details'); details.className = `tool-execution status-${tool.status || 'pending'}`;
      details.dataset.detailKey = `tool:${tool.callId || index}`;
      details.dataset.defaultOpen = tool.status === 'pending' ? '1' : '0';
      if (tool.status === 'pending') details.open = true;
      const summary = document.createElement('summary');
      summary.append(textElement('span', 'tool-status', statusSymbol(tool.status)), textElement('span', 'tool-summary', tool.summary || tool.name), textElement('small', '', toolMeta(tool)));
      const detail = document.createElement('div'); detail.className = 'tool-detail';
      if (tool.changedFiles?.length) detail.append(textElement('div', 'tool-files', `文件：${tool.changedFiles.join('、')}`));
      if (tool.input) detail.append(detailBlock('输入', tool.input, tool.risk === 'command' ? commandText(tool.input) : undefined));
      if (tool.output) detail.append(detailBlock('结果', tool.output));
      if (!tool.input && !tool.output) detail.append(textElement('p', 'tool-cleaned', tool.finishedAt ? '详细缓存已按保留策略清理，摘要仍保留。' : '等待执行结果。'));
      details.append(summary, detail); section.append(details);
    }
    return section;
  }

  function detailBlock(label, value, preferredCopyText) {
    const block = document.createElement('div'); block.className = 'tool-detail-block';
    const heading = document.createElement('div'); heading.className = 'tool-detail-heading';
    const idleLabel = preferredCopyText ? '复制命令' : '复制';
    const copy = textElement('button', '', idleLabel); copy.type = 'button'; copy.title = preferredCopyText ? '复制实际终端命令' : `复制${label}`;
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
    const labels = { read: '读取', write: '写入', command: '命令' };
    const duration = tool.finishedAt && tool.startedAt ? ` · ${formatDuration(tool.finishedAt - tool.startedAt)}` : '';
    return `${labels[tool.risk] || tool.name}${duration}`;
  }

  function renderReasoning(reasoning) {
    const details = document.createElement('details'); details.className = 'reasoning';
    details.dataset.detailKey = 'reasoning';
    details.dataset.defaultOpen = '0';
    const content = document.createElement('div'); content.className = 'reasoning-content'; appendRichText(content, reasoning);
    details.append(textElement('summary', '', '思考过程'), content); return details;
  }

  function appendRichText(container, text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n'); let paragraph = []; let code = []; let language = ''; let inCode = false;
    const flushParagraph = () => { if (!paragraph.length) return; const value = paragraph.join('\n').trimEnd(); if (value) { const node = document.createElement('p'); appendInline(node, value); container.append(node); } paragraph = []; };
    const flushCode = () => {
      const codeText = code.join('\n');
      const shellLanguage = /^(bash|zsh|sh|shell|powershell|pwsh|cmd|bat|terminal|console)$/i.test(language) || (!language && looksLikeShell(codeText));
      const wrapper = document.createElement('div'); wrapper.className = `code-block${shellLanguage ? ' terminal-command' : ''}`; const header = document.createElement('div'); header.className = 'code-header';
      const idleLabel = shellLanguage ? '复制命令' : '复制';
      const copy = textElement('button', '', idleLabel); copy.type = 'button'; copy.title = shellLanguage ? '复制终端命令' : '复制代码'; copy.addEventListener('click', () => requestClipboardWrite(codeText, copy, idleLabel));
      const pre = document.createElement('pre'); const codeNode = document.createElement('code'); codeNode.textContent = codeText; pre.append(codeNode);
      header.append(textElement('span', '', shellLanguage ? `终端命令 · ${language || 'shell'}` : language || 'code'), copy); wrapper.append(header, pre); container.append(wrapper); code = []; language = '';
    };
    for (const line of lines) {
      const fence = line.match(/^```\s*([^\s`]*)/);
      if (fence) { if (inCode) { flushCode(); inCode = false; } else { flushParagraph(); language = fence[1] || ''; inCode = true; } continue; }
      if (inCode) code.push(line); else if (!line.trim()) flushParagraph(); else paragraph.push(line);
    }
    if (inCode) flushCode(); flushParagraph();
  }

  function looksLikeShell(value) {
    return /^(?:\$\s*)?(?:npm|pnpm|yarn|git|cd|ls|mkdir|rm|cp|mv|curl|wget|python3?|node|npx|docker|kubectl|gradle|\.\/|swift|go|cargo|chmod|chown|brew|apt|pip3?|export|setx|powershell)\b/im.test(value.trim());
  }

  function appendInline(parent, value) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s<]+)/g; let cursor = 0;
    for (const match of value.matchAll(pattern)) {
      const index = match.index || 0; if (index > cursor) parent.append(document.createTextNode(value.slice(cursor, index))); const token = match[0];
      if (token.startsWith('`')) parent.append(textElement('code', '', token.slice(1, -1)));
      else if (token.startsWith('**')) parent.append(textElement('strong', '', token.slice(2, -2)));
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
      const size = textElement('small', '', attachment.kind === 'selection' ? '代码选区' : formatBytes(attachment.bytes || 0));
      const remove = textElement('button', '', '×'); remove.type = 'button'; remove.title = '移除';
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
    elements.sourceHistoryTitle.textContent = `任务历史：${state.conversation.sourceConversationTitle || '旧对话'}`;
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
    elements.promptInput.placeholder = archived ? '该对话已归档，恢复后可继续' : state.streaming ? 'Agent 正在执行；新消息会自动合并到当前任务或加入队列…' : '询问代码、调试问题或直接交给 Agent 实现…';
    elements.composerHint.textContent = archived ? '归档对话为只读' : state.streaming ? '发送后自动判断任务关系' : state.sendOnEnter ? 'Enter 发送 · Shift+Enter 换行' : '⌘/Ctrl+Enter 发送';
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
  elements.messageViewport.addEventListener('scroll', () => {
    if (!state.renderingMessages) state.autoFollow = isNearBottom();
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
        encoded.push({ name: file.name || (file.type.startsWith('image/') ? '粘贴的图片' : '粘贴的文件'), mimeType: file.type, size: buffer.byteLength, dataBase64: arrayBufferToBase64(buffer), thumbnailDataUrl });
      } catch (error) {
        showToast(`读取剪贴板附件失败：${error?.message || error}`, 'warning');
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
      showToast('当前 VS Code/Webview 不提供语音识别。请启用系统听写或使用支持语音识别的 VS Code 版本。', 'warning');
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
    recognition.onerror = (event) => showToast(`语音输入失败：${event.error || '未知错误'}`, 'warning');
    recognition.onend = () => { state.voiceRecognition = null; state.voiceActive = false; elements.voiceButton.classList.remove('active'); updateComposerState(); };
    elements.voiceButton.classList.add('active');
    try { recognition.start(); } catch (error) { recognition.onend(); showToast(`无法开始语音输入：${error?.message || error}`, 'warning'); }
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
        state.workspaceTrusted = Boolean(incoming.workspaceTrusted); state.agentAvailable = Boolean(incoming.agentAvailable); state.availableToolCount = Number(incoming.availableToolCount) || 0; state.showArchived = Boolean(incoming.showArchived); state.taskTree = incoming.taskTree || (message.streamingConversationId ? state.taskTree : null);
        elements.modelInput.value = state.model || 'deepseek-flash'; if (previousConversationId !== incoming.conversation?.id) state.autoFollow = true; setStreaming(Boolean(message.streamingConversationId), message.streamingConversationId); renderAll(); break;
      }
      case 'draft': elements.promptInput.value = message.text || ''; state.pendingAttachments = message.attachments || []; renderAttachments(); autoResize(); elements.promptInput.focus(); break;
      case 'attachments': state.pendingAttachments = message.attachments || []; renderAttachments(); break;
      case 'context': state.pendingAttachments = state.pendingAttachments.filter((item) => item.kind !== 'selection'); renderAttachments(); break;
      case 'messageStart': state.conversation = state.conversation || { id: message.conversationId, title: message.userMessage.content, mode: state.mode }; state.messages.push(message.userMessage, message.assistant); state.pendingAttachments = []; state.autoFollow = true; setStreaming(true, message.conversationId); renderMessages('bottom'); renderAttachments(); break;
      case 'messageAdded': if (message.conversationId === state.conversation?.id) { state.messages.push(message.message); state.pendingAttachments = []; renderMessages(state.autoFollow ? 'bottom' : 'keep'); renderAttachments(); } break;
      case 'streamDelta': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.content = `${target.content || ''}${message.content || ''}`; target.reasoning = `${target.reasoning || ''}${message.reasoning || ''}`; scheduleMessageRender(); } break; }
      case 'toolExecutions': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.toolExecutions = message.tools || []; scheduleMessageRender(); } break; }
      case 'skillUsage': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.usedSkills = message.skills || []; scheduleMessageRender(); } break; }
      case 'messageComplete': { if (message.conversationId !== state.conversation?.id) break; if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; } const index = state.messages.findIndex((item) => item.id === message.message.id); if (index >= 0) state.messages[index] = message.message; else state.messages.push(message.message); renderMessages('keep'); break; }
      case 'streamIdle': setStreaming(false); renderTaskTree(); elements.promptInput.focus(); break;
      case 'olderMessages': state.messages = [...message.messages, ...state.messages]; state.hasMore = Boolean(message.hasMore); renderMessages('prepend'); break;
      case 'modelChanged': state.model = message.model; if (state.conversation) state.conversation.model = message.model; state.reasoningEffort = message.reasoningEffort || 'default'; elements.modelInput.value = message.model; syncReasoningSelector(); updateComposerState(); showToast(`已切换到 ${message.model}`); break;
      case 'profileChanged': state.activeApiProfileId = message.profileId; state.model = message.model; state.reasoningEffort = message.reasoningEffort || 'default'; if (state.conversation) { state.conversation.apiProfileId = message.profileId; state.conversation.model = message.model; } elements.modelInput.value = message.model; renderHeader(); showToast('API 配置已切换'); break;
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
      case 'taskTreeChanged': state.taskTree = message.taskTree || null; renderTaskTree(); updateComposerState(); break;
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
          if (message.truncated) showToast('剪贴板文字过长，已粘贴前 200 万个字符。', 'warning');
        }
        break;
      case 'toast': showToast(message.text, message.tone); break;
    }
  });

  function formatTime(value) { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
  function relativeTime(value) { const delta = Date.now() - value; if (delta < 60_000) return '刚刚'; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`; if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)} 天前`; return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value)); }
  function formatBytes(bytes) { if (!bytes) return '文件'; if (bytes < 1024) return `${bytes} B`; return `${(bytes / 1024).toFixed(1)} KB`; }
  function formatDuration(ms) { if (ms < 1000) return `${ms} ms`; if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`; return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`; }
  function formatMillionTokens(tokens) {
    const millions = Math.max(0, Number(tokens) || 0) / 1_000_000;
    const digits = millions >= 1 ? 2 : millions >= .01 ? 3 : 6;
    return `${millions.toFixed(digits)}M`;
  }

  autoResize(); post('ready');
})();
