(() => {
  const vscode = acquireVsCodeApi();
  const elements = Object.fromEntries([
    'app', 'historyPane', 'historyButton', 'closeHistoryButton', 'newChatButton',
    'historySearch', 'archiveViewButton', 'conversationList', 'settingsButton',
    'settingsButtonSide', 'exportButton', 'archiveButton', 'conversationTitle',
    'connectionState', 'profileInput', 'modelInput', 'modeInput', 'skillsButton', 'skillsCount',
    'skillsPanel', 'skillsList', 'workspaceTrustBadge', 'messageViewport',
    'messageList', 'emptyState', 'loadOlderButton', 'attachmentList', 'contextChip',
    'contextLabel', 'removeContextButton', 'composer', 'promptInput', 'composerHint',
    'attachButton', 'sendButton', 'stopButton', 'toast',
  ].map((id) => [id, document.getElementById(id)]));

  const state = {
    conversations: [], archivedConversations: [], conversation: null, messages: [],
    hasMore: false, sendOnEnter: true, streaming: false, streamingConversationId: null,
    search: '', pendingAttachments: [], skills: [], selectedSkillIds: [], mode: 'agent',
    apiProfiles: [], activeApiProfileId: '',
    workspaceTrusted: false, agentAvailable: false, showArchived: false, renderTimer: null,
  };

  function post(type, payload = {}) { vscode.postMessage({ type, ...payload }); }

  function renderAll() {
    renderHistory(); renderHeader(); renderSkills(); renderMessages(false); renderAttachments(); updateComposerState();
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
      const meta = textElement('span', 'conversation-meta', `${relativeTime(conversation.updatedAt)}${tokenTotal}`);
      const preview = textElement('span', 'conversation-preview', conversation.preview || '空对话');
      content.append(title, meta, preview);
      content.addEventListener('click', () => { post('selectConversation', { id: conversation.id }); closeMobileHistory(); });
      const actions = document.createElement('div'); actions.className = 'conversation-actions';
      const pin = actionButton(conversation.pinned ? '取消固定' : '固定', conversation.pinned ? '●' : '○');
      pin.addEventListener('click', () => post('togglePin', { id: conversation.id, pinned: !conversation.pinned }));
      const archive = actionButton(conversation.archived ? '恢复对话' : '归档', conversation.archived ? '↺' : '□');
      archive.addEventListener('click', () => post('toggleArchive', { id: conversation.id, archived: !conversation.archived }));
      const remove = actionButton('删除', '×'); remove.classList.add('danger-action');
      remove.addEventListener('click', () => post('deleteConversation', { id: conversation.id }));
      actions.append(pin, archive, remove); row.append(content, actions); elements.conversationList.append(row);
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
    elements.connectionState.textContent = state.streaming ? 'Agent 正在执行' : archived ? '已归档 · 只读' : state.mode !== 'chat' && !state.workspaceTrusted ? '未信任 · 写入与命令受限' : '准备就绪';
    elements.connectionState.classList.toggle('live', state.streaming);
    elements.connectionState.classList.toggle('restricted', !state.workspaceTrusted && state.mode !== 'chat');
    elements.skillsCount.textContent = String(state.selectedSkillIds.length);
    elements.skillsButton.classList.toggle('active', state.selectedSkillIds.length > 0);
  }

  function syncConnectionSelectors() {
    const profileId = state.conversation?.apiProfileId || state.activeApiProfileId || state.apiProfiles[0]?.id || '';
    replaceSelectOptions(elements.profileInput, state.apiProfiles.map((profile) => ({ value: profile.id, label: profile.name })), profileId);
    const profile = state.apiProfiles.find((item) => item.id === profileId) || state.apiProfiles[0];
    const model = state.conversation?.model || elements.modelInput.value || profile?.models?.[0] || 'deepseek-chat';
    const models = [...new Set([...(profile?.models || []), model].filter(Boolean))];
    replaceSelectOptions(elements.modelInput, models.map((value) => ({ value, label: value })), model);
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

  function renderMessages(preserveScroll) {
    const viewport = elements.messageViewport; const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop;
    elements.messageList.replaceChildren(); elements.emptyState.hidden = state.messages.length > 0;
    elements.loadOlderButton.hidden = !state.hasMore || !state.messages.length;
    for (const message of state.messages) elements.messageList.append(renderMessage(message));
    requestAnimationFrame(() => { viewport.scrollTop = preserveScroll ? viewport.scrollHeight - distanceFromBottom : viewport.scrollHeight; });
  }

  function scheduleMessageRender() {
    if (state.renderTimer) return;
    state.renderTimer = setTimeout(() => { state.renderTimer = null; renderMessages(false); }, 70);
  }

  function renderMessage(message) {
    const article = document.createElement('article');
    article.className = `message ${message.role}${message.status === 'error' ? ' error' : ''}`; article.dataset.messageId = message.id;
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const author = textElement('span', '', message.role === 'user' ? '你' : 'HWChat');
    const time = textElement('time', '', formatTime(message.createdAt)); time.dateTime = new Date(message.createdAt).toISOString(); meta.append(author, time);
    const body = document.createElement('div'); body.className = 'message-body';
    const attached = [message.context, ...(message.attachments || [])].filter(Boolean);
    if (attached.length) body.append(renderMessageAttachments(attached));
    if (message.toolExecutions?.length) body.append(renderToolExecutions(message.toolExecutions));
    if (message.usedSkills?.length) body.append(renderSkillUsage(message.usedSkills));
    if (message.reasoning) body.append(renderReasoning(message.reasoning));
    const content = document.createElement('div'); content.className = 'message-content';
    appendRichText(content, message.content || (message.status === 'streaming' ? '正在继续处理…' : '')); body.append(content);
    if (message.status === 'streaming') { const cursor = document.createElement('span'); cursor.className = 'stream-cursor'; cursor.setAttribute('aria-label', '生成中'); body.append(cursor); }
    if (message.usage?.totalTokens) body.append(textElement('div', 'message-usage', `${formatMillionTokens(message.usage.totalTokens)} tokens`));
    article.append(meta, body); return article;
  }

  function renderSkillUsage(skills) {
    const details = document.createElement('details'); details.className = 'message-skills';
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
    for (const attachment of attachments) { const chip = textElement('span', '', attachment.label); chip.title = attachment.path || attachment.label; row.append(chip); }
    return row;
  }

  function renderToolExecutions(tools) {
    const section = document.createElement('section'); section.className = 'tool-stack';
    const changed = new Set(tools.flatMap((tool) => tool.changedFiles || []));
    section.append(textElement('div', 'tool-stack-heading', `${tools.length} 个执行步骤${changed.size ? ` · 修改 ${changed.size} 个文件` : ''}`));
    for (const tool of tools) {
      const details = document.createElement('details'); details.className = `tool-execution status-${tool.status || 'pending'}`;
      if (tool.status === 'pending') details.open = true;
      const summary = document.createElement('summary');
      summary.append(textElement('span', 'tool-status', statusSymbol(tool.status)), textElement('span', 'tool-summary', tool.summary || tool.name), textElement('small', '', toolMeta(tool)));
      const detail = document.createElement('div'); detail.className = 'tool-detail';
      if (tool.changedFiles?.length) detail.append(textElement('div', 'tool-files', `文件：${tool.changedFiles.join('、')}`));
      if (tool.input) detail.append(detailBlock('输入', tool.input));
      if (tool.output) detail.append(detailBlock('结果', tool.output));
      if (!tool.input && !tool.output) detail.append(textElement('p', 'tool-cleaned', tool.finishedAt ? '详细缓存已按保留策略清理，摘要仍保留。' : '等待执行结果。'));
      details.append(summary, detail); section.append(details);
    }
    return section;
  }

  function detailBlock(label, value) {
    const block = document.createElement('div'); block.className = 'tool-detail-block';
    const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = value; pre.append(code);
    block.append(textElement('strong', '', label), pre); return block;
  }

  function statusSymbol(status) { return status === 'success' ? '✓' : status === 'denied' ? '−' : status === 'error' ? '!' : '…'; }
  function toolMeta(tool) {
    const labels = { read: '读取', write: '写入', command: '命令' };
    const duration = tool.finishedAt && tool.startedAt ? ` · ${formatDuration(tool.finishedAt - tool.startedAt)}` : '';
    return `${labels[tool.risk] || tool.name}${duration}`;
  }

  function renderReasoning(reasoning) {
    const details = document.createElement('details'); details.className = 'reasoning';
    const content = document.createElement('div'); content.className = 'reasoning-content'; appendRichText(content, reasoning);
    details.append(textElement('summary', '', '思考过程'), content); return details;
  }

  function appendRichText(container, text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n'); let paragraph = []; let code = []; let language = ''; let inCode = false;
    const flushParagraph = () => { if (!paragraph.length) return; const value = paragraph.join('\n').trimEnd(); if (value) { const node = document.createElement('p'); appendInline(node, value); container.append(node); } paragraph = []; };
    const flushCode = () => {
      const wrapper = document.createElement('div'); wrapper.className = 'code-block'; const header = document.createElement('div'); header.className = 'code-header';
      const copy = textElement('button', '', '复制'); copy.type = 'button'; copy.addEventListener('click', async () => { await navigator.clipboard.writeText(code.join('\n')); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制'; }, 1200); });
      const pre = document.createElement('pre'); const codeNode = document.createElement('code'); codeNode.textContent = code.join('\n'); pre.append(codeNode);
      header.append(textElement('span', '', language || 'code'), copy); wrapper.append(header, pre); container.append(wrapper); code = []; language = '';
    };
    for (const line of lines) {
      const fence = line.match(/^```\s*([^\s`]*)/);
      if (fence) { if (inCode) { flushCode(); inCode = false; } else { flushParagraph(); language = fence[1] || ''; inCode = true; } continue; }
      if (inCode) code.push(line); else if (!line.trim()) flushParagraph(); else paragraph.push(line);
    }
    if (inCode) flushCode(); flushParagraph();
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
      const chip = document.createElement('div'); chip.className = 'attachment-chip';
      const label = textElement('span', '', attachment.label); label.title = attachment.path || attachment.label;
      const size = textElement('small', '', attachment.kind === 'selection' ? '代码选区' : formatBytes(attachment.bytes || 0));
      const remove = textElement('button', '', '×'); remove.type = 'button'; remove.title = '移除';
      if (attachment.kind === 'selection') remove.addEventListener('click', () => post('removeContext'));
      else { const index = fileIndex; remove.addEventListener('click', () => post('removeAttachment', { index })); fileIndex += 1; }
      chip.append(label, size, remove); elements.attachmentList.append(chip);
    }
    elements.contextChip.hidden = true;
  }

  function updateComposerState() {
    const hasText = elements.promptInput.value.trim().length > 0 || state.pendingAttachments.length > 0; const archived = Boolean(state.conversation?.archived);
    elements.sendButton.disabled = !hasText || state.streaming || archived; elements.sendButton.hidden = state.streaming; elements.stopButton.hidden = !state.streaming;
    elements.promptInput.disabled = state.streaming || archived; elements.attachButton.disabled = state.streaming || archived;
    elements.profileInput.disabled = state.streaming || archived; elements.modelInput.disabled = state.streaming || archived; elements.modeInput.disabled = state.streaming || archived; elements.skillsButton.disabled = state.streaming || archived;
    elements.promptInput.placeholder = archived ? '该对话已归档，恢复后可继续' : '询问代码、调试问题或直接交给 Agent 实现…';
    elements.composerHint.textContent = archived ? '归档对话为只读' : state.sendOnEnter ? 'Enter 发送 · Shift+Enter 换行' : '⌘/Ctrl+Enter 发送';
  }

  function autoResize() { elements.promptInput.style.height = 'auto'; elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 180)}px`; updateComposerState(); }
  function submit() { const text = elements.promptInput.value.trim(); if ((!text && !state.pendingAttachments.length) || state.streaming || state.conversation?.archived) return; elements.promptInput.value = ''; autoResize(); post('send', { text, mode: state.mode, skillIds: state.selectedSkillIds }); }
  function setStreaming(value, conversationId = null) { state.streaming = value; state.streamingConversationId = value ? conversationId : null; renderHeader(); updateComposerState(); }
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
  elements.attachButton.addEventListener('click', () => post('attachFiles')); elements.removeContextButton.addEventListener('click', () => post('removeContext'));
  elements.stopButton.addEventListener('click', () => post('stop')); elements.skillsButton.addEventListener('click', () => { elements.skillsPanel.hidden = !elements.skillsPanel.hidden; });
  elements.historySearch.addEventListener('input', (event) => { state.search = event.target.value; renderHistory(); });
  elements.modelInput.addEventListener('change', (event) => post('setModel', { model: event.target.value }));
  elements.profileInput.addEventListener('change', (event) => post('setProfile', { profileId: event.target.value }));
  elements.modeInput.addEventListener('change', (event) => { state.mode = event.target.value; post('setMode', { mode: state.mode }); renderHeader(); updateComposerState(); });
  elements.composer.addEventListener('submit', (event) => { event.preventDefault(); submit(); }); elements.promptInput.addEventListener('input', autoResize);
  elements.promptInput.addEventListener('keydown', (event) => { const commandEnter = (event.metaKey || event.ctrlKey) && event.key === 'Enter'; const regularEnter = state.sendOnEnter && event.key === 'Enter' && !event.shiftKey && !event.isComposing; if (commandEnter || regularEnter) { event.preventDefault(); submit(); } });
  elements.loadOlderButton.addEventListener('click', () => { const first = state.messages[0]; if (first) post('loadOlder', { before: first.id }); });
  for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { elements.promptInput.value = button.dataset.prompt || ''; autoResize(); elements.promptInput.focus(); });
  document.addEventListener('click', (event) => { if (!elements.skillsPanel.hidden && !elements.skillsPanel.contains(event.target) && !elements.skillsButton.contains(event.target)) elements.skillsPanel.hidden = true; });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state': {
        const incoming = message.state; state.conversations = incoming.conversations || []; state.archivedConversations = incoming.archivedConversations || [];
        state.conversation = incoming.conversation; state.messages = incoming.messages || []; state.hasMore = Boolean(incoming.hasMore);
        state.sendOnEnter = incoming.settings?.sendOnEnter !== false; state.pendingAttachments = incoming.pendingAttachments || [];
        state.apiProfiles = incoming.settings?.apiProfiles || []; state.activeApiProfileId = incoming.settings?.activeApiProfileId || '';
        state.skills = incoming.skills || []; state.selectedSkillIds = incoming.selectedSkillIds || []; state.mode = incoming.mode || 'agent';
        state.workspaceTrusted = Boolean(incoming.workspaceTrusted); state.agentAvailable = Boolean(incoming.agentAvailable); state.showArchived = Boolean(incoming.showArchived);
        elements.modelInput.value = incoming.settings?.model || 'deepseek-chat'; setStreaming(Boolean(message.streamingConversationId), message.streamingConversationId); renderAll(); break;
      }
      case 'draft': elements.promptInput.value = message.text || ''; state.pendingAttachments = message.attachments || []; renderAttachments(); autoResize(); elements.promptInput.focus(); break;
      case 'attachments': state.pendingAttachments = message.attachments || []; renderAttachments(); break;
      case 'context': state.pendingAttachments = state.pendingAttachments.filter((item) => item.kind !== 'selection'); renderAttachments(); break;
      case 'messageStart': state.conversation = state.conversation || { id: message.conversationId, title: message.userMessage.content, mode: state.mode }; state.messages.push(message.userMessage, message.assistant); state.pendingAttachments = []; setStreaming(true, message.conversationId); renderMessages(false); renderAttachments(); break;
      case 'streamDelta': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.content = `${target.content || ''}${message.content || ''}`; target.reasoning = `${target.reasoning || ''}${message.reasoning || ''}`; scheduleMessageRender(); } break; }
      case 'toolExecutions': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.toolExecutions = message.tools || []; scheduleMessageRender(); } break; }
      case 'skillUsage': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.usedSkills = message.skills || []; scheduleMessageRender(); } break; }
      case 'messageComplete': { if (message.conversationId !== state.conversation?.id) break; if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; } const index = state.messages.findIndex((item) => item.id === message.message.id); if (index >= 0) state.messages[index] = message.message; else state.messages.push(message.message); renderMessages(false); break; }
      case 'streamIdle': setStreaming(false); elements.promptInput.focus(); break;
      case 'olderMessages': state.messages = [...message.messages, ...state.messages]; state.hasMore = Boolean(message.hasMore); renderMessages(true); break;
      case 'modelChanged': elements.modelInput.value = message.model; showToast(`已切换到 ${message.model}`); break;
      case 'profileChanged': state.activeApiProfileId = message.profileId; elements.modelInput.value = message.model; showToast('API 配置已切换'); break;
      case 'modeChanged': state.mode = message.mode; renderHeader(); break;
      case 'skillsChanged': state.selectedSkillIds = message.skillIds || []; renderSkills(); renderHeader(); break;
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
