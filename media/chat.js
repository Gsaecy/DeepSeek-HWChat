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

  /**
   * 围栏解析（语言 / 位置 / 工具标注）。纯函数放在 media/code-block-meta.js，
   * 由扩展在注入 HTML 时先加载，这样可以单独跑单元测试。
   *
   * 万一那个脚本没加载成功，这里退化成「只认语言」的旧行为：
   * 代码块照旧能渲染和复制，只是不再显示位置与工具标签。
   */
  const codeMeta = globalThis.HWChatCodeBlockMeta || {
    isShellLanguage: (language) => /^(bash|zsh|sh|shell|powershell|pwsh|cmd|bat|terminal|console)$/i.test(String(language || '')),
    canonicalTool: (value) => String(value == null ? '' : value).trim().toLowerCase(),
    normalizeLocation: (value) => String(value == null ? '' : value).trim(),
    parseFenceInfo: (info) => ({ language: String(info == null ? '' : info).trim().split(/\s+/)[0] || '', location: '', tool: '' }),
    matchFenceStart: (line) => {
      const match = String(line == null ? '' : line).match(/^\s*`{3,}\s*(.*)$/);
      return match ? match[1].trim() : null;
    },
    collectFenceBlock: (lines, startIndex) => {
      const list = Array.isArray(lines) ? lines : [];
      const start = String(list[startIndex] == null ? '' : list[startIndex]);
      // 必须真的以 ``` 开头才算围栏：旧兜底无条件 `slice(3)`，于是脚本没加载成功时
      // 每一行正文都会被当成代码块，首三个字符被吃掉（预览夹具里实测正文 "ABCDEFGH"
      // 显示成 "DEFGH" 且代码体为空）。
      if (!/^\s*`{3,}/.test(start)) return null;
      const info = start.trim().slice(3).trim();
      const code = [];
      let index = startIndex + 1;
      while (index < list.length && !/^\s*`{3,}\s*$/.test(String(list[index] == null ? '' : list[index]))) {
        code.push(String(list[index] == null ? '' : list[index]));
        index += 1;
      }
      return { info, code: code.join('\n'), nextIndex: index < list.length ? index + 1 : list.length };
    },
    dedentCode: (text) => String(text == null ? '' : text),
  };

  /**
   * 文件引用的识别与解析。纯函数放在 media/file-reference.js，由扩展在注入
   * HTML 时先加载，这样可以单独跑单元测试。
   *
   * 万一那个脚本没加载成功，这里退化成两个空实现：正文与代码片段原样显示，
   * 不再有任何文件引用——功能少一块，但渲染不会崩。
   */
  const fileRef = globalThis.HWChatFileRef || null;

  /**
   * 任务清单面板的显示状态。同样放在 media/todo-panel-state.js 里以便单测。
   *
   * 退化实现只是「永远不自动展开」：面板照旧能显示和点击，只是新清单不会自己弹开。
   */
  const todoPanelState = globalThis.HWChatTodoPanelState || {
    todoSignature: (todos) => (Array.isArray(todos) ? todos.map((todo) => String(todo && todo.content != null ? todo.content : '')).join('\u0000') : ''),
    shouldRevealTodoPanel: () => false,
    capsuleRadius: (height) => Math.max(2, Math.round(Number(height) * 0.3) || 2),
    planPanelToggle: (input) => ({ allowed: true, open: Boolean(input && input.open), collapsePeers: false, exitArchiveFocus: false }),
    nextArchiveFocus: (input) => {
      const clicked = String((input && input.clickedId) || '');
      if (!clicked) return null;
      return String((input && input.currentId) || '') === clicked ? null : clicked;
    },
  };

  /**
   * 界面图标。形状定义在 media/ui-icons.js（纯函数，可单独单测），这里只负责变成 DOM。
   *
   * 退化策略：图标脚本没加载成功时回到原来的文字符号 —— 字形不好看总比徽标变成空白好，
   * 至少「成功 / 失败」还看得懂。
   */
  const uiIcons = globalThis.HWChatIcons || null;
  const GLYPH_FALLBACK = {
    check: '✓', minus: '−', bang: '!', ellipsis: '…', dot: '●', ring: '○',
    turn: '↳', square: '□', close: '×', arrowUpRight: '↗', restore: '↺', pencil: '✎',
    warn: '⚠',
  };

  /**
   * 提醒块分级解析。规则在 media/callout-meta.js（纯函数，可单独单测）。
   *
   * 退化策略：脚本没加载成功时永远返回 null，也就是所有引用块走原来的渲染 ——
   * 少一种样式总比把 `> [!DANGER]` 那行标记渲染成正文、让人看到一堆方括号好。
   */
  const calloutMeta = globalThis.HWChatCalloutMeta || null;
  /** 行内快路径的纯函数判定（见 media/inline-append.js）。缺了就一律走重排，行为安全。 */
  const inlineAppend = globalThis.HWChatInlineAppend || null;
  /**
   * 流式补全未闭合 markdown（见 media/stream-repair.js）。
   *
   * 依据 Vercel AI SDK 官方 Streamdown 的做法：还在流的 `**重点`、`` `npm test ``、
   * `[文档](https://exa` 直接按**最终形态**渲染，而不是先显示成字面量、等收尾符
   * 到了再跳变——那正是「已经输出的文字会跳」的另一半原因。缺了脚本就不补，
   * 行为退回原样，不会渲染错。
   */
  const streamRepair = globalThis.HWChatStreamRepair || null;

  /**
   * 用户消息里的明文凭据识别。规则在 media/secret-scan.js（纯函数，可单独单测）。
   *
   * 为什么这一类不能只交给模型：用户把 API key 贴进对话时，密钥已经发出去了，
   * 等模型在回复里提一句已经晚了；而且模型不一定会提。这里在渲染层直接认出来，
   * 不依赖模型自觉。
   *
   * 退化策略：脚本没加载成功时永远返回空数组，也就是不显示提醒 ——
   * 宁可少一条提示，也不要因为探测失败把每条消息都标红。
   */
  const secretScan = globalThis.HWChatSecretScan || null;

  /**
   * toast 的显示时长。规则在 media/toast-timing.js（纯函数，可单独单测）。
   *
   * 原来所有 toast 一律 4.2 秒，与文字长度无关 —— 六十多个汉字的停滞提醒
   * 在 4.2 秒里读不完，用户反馈「弹了一次但消失太快，没看清」。
   *
   * 退化策略：模块没加载成功时退回原来的 4.2 秒，行为与改动前完全一致。
   */
  const toastTiming = globalThis.HWChatToastTiming || null;

  /**
   * 收尾清单里的复选框剥离。规则在 media/follow-up-format.js（纯函数，可单测）。
   *
   * 模型爱把「需要你做的」写成 `1. [ ] **动作**`，渲染出来就是一串字面方括号。
   * 提示词已经要求它别这么写（src/agent/followUpPrompt.ts），这里再兜一层：
   * 只剥有序列表的标记，`- [ ]` 这类真正的任务列表保持原样。
   *
   * 退化策略：模块没加载成功时原样显示，行为与改动前一致。
   */
  const followUpFormat = globalThis.HWChatFollowUpFormat || null;

  /**
   * 造一个图标节点。
   *
   * 用 DOMParser 而不是 innerHTML：SVG 是外来命名空间，用 HTML 解析器插入时
   * 容易在特定上下文里走错分支；image/svg+xml 模式一定按 SVG 解析。
   */
  function iconNode(name) {
    const wrapper = document.createElement('span');
    wrapper.className = 'ui-icon';
    const markup = uiIcons ? uiIcons.markup(name) : '';
    if (markup) {
      try {
        const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
        const svg = parsed.documentElement;
        if (svg && svg.tagName.toLowerCase() === 'svg') {
          wrapper.append(document.importNode(svg, true));
          return wrapper;
        }
      } catch {
        // 解析失败就走下面的文字退路，不让一个图标拖垮整段渲染。
      }
    }
    wrapper.textContent = GLYPH_FALLBACK[name] || '';
    return wrapper;
  }

  /**
   * 造一个分级提醒块。
   *
   * 正文渲染走回调而不是直接调 appendRichText：appendRichText 是递归函数，
   * 直接引用会让这段代码无法单独切出来跑（test/check-callout-dom.mjs 就是这么测的）。
   * 有了回调，这里只负责「结构 + 标题 + 图标」，正文怎么排交给调用方。
   *
   * 分级只决定两件事（与需求一一对应）：
   *   - data-tone 交给 CSS：danger 的标题取红色，important 的标题不动；
   *   - 图标颜色：danger 取亮黄，important 取橘黄。
   * 标题缺失时用文案表里的默认名，避免出现「一个图标下面什么都没有」。
   */
  function calloutNode(plan, renderBody) {
    const box = document.createElement('div');
    box.className = 'message-callout';
    box.dataset.tone = plan.tone;
    const head = document.createElement('div');
    head.className = 'callout-head';
    const icon = iconNode('warn');
    icon.classList.add('callout-icon');
    const title = document.createElement('span');
    title.className = 'callout-title';
    title.textContent = plan.title || t(plan.tone === 'danger' ? 'chat.calloutDanger' : 'chat.calloutImportant');
    head.append(icon, title);
    box.append(head);
    if (plan.body && typeof renderBody === 'function') {
      const body = document.createElement('div');
      body.className = 'callout-body';
      renderBody(body);
      box.append(body);
    }
    return box;
  }

  /**
   * 用户消息里检测到明文凭据时，紧跟这条消息显示一条危险提醒。
   *
   * 两条硬要求：
   *   1. 走 danger 级别（红色标题 + 亮黄图标），与「会造成损失」的分级口径一致；
   *   2. **绝不回显凭据原文**，只说类型与长度 —— 提醒本身再把密钥打印一遍
   *      就是在这个已经有泄漏风险的会话里做二次泄漏。
   *
   * 返回 null 表示没有命中，调用方不需要自己判断。
   */
  function secretWarningNode(text) {
    if (!secretScan) return null;
    let findings = [];
    try {
      findings = secretScan.scanSecrets(text) || [];
    } catch {
      // 正则异常不该拖垮整条消息的渲染：退化成不提醒即可。
      return null;
    }
    if (!findings.length) return null;
    const isPrivacy = (finding) => finding.category === 'privacy';
    const credentials = findings.filter((finding) => !isPrivacy(finding));
    const privacy = findings.filter(isPrivacy);
    const linesFor = (items) => items.map((finding) => {
      // 赋值类没有"有名的格式"，改用字段名（如 password / api_key）让用户能定位。
      if (finding.kind === 'credentialAssignment') {
        return `- ${t('chat.secretWarnFieldItem', { field: finding.field, length: finding.length })}`;
      }
      const kind = t(`chat.secretKind.${finding.kind}`);
      return `- ${t('chat.secretWarnItem', { kind, length: finding.length })}`;
    });
    // 两类分开成段：处置方式完全不同 —— 密钥要吊销并轮换，身份证 / 银行卡要挂失、
    // 关注盗刷。混成一张列表会让人照着「吊销密钥」的建议去处理身份证。
    const blocks = [];
    if (credentials.length) blocks.push([...linesFor(credentials), '', t('chat.secretWarnBody')].join('\n'));
    if (privacy.length) blocks.push([...linesFor(privacy), '', t('chat.secretWarnPrivacyBody')].join('\n'));
    const titleKey = credentials.length && privacy.length
      ? 'chat.secretWarnMixedTitle'
      : privacy.length
        ? 'chat.secretWarnPrivacyTitle'
        : 'chat.secretWarnTitle';
    const bodyText = blocks.join('\n\n');
    return calloutNode({ tone: 'danger', title: t(titleKey), body: bodyText }, (node) => {
      appendRichText(node, bodyText);
    });
  }

  /**
   * 把助手输出里的少量 emoji 换成同一套扁平图标。
   *
   * 为什么必须在 DOM 上做、不能直接替换原始字符串：正文里可能有代码块，
   * 代码里的 `🔔` 是内容本身，替换掉就把别人的代码改错了。
   * 所以这里走文本节点，遇到 <pre>/<code> 直接跳过。
   *
   * 只替换 media/ui-icons.js 的 EMOJI 里登记过的那几个；其余 emoji 原样保留——
   * 把用户自己打的 🎉 换成某个我们画的图形只会更奇怪。
   */
  function flattenEmojiIcons(root) {
    const uiIcons = globalThis.HWChatIcons;
    if (!uiIcons || typeof uiIcons.emojiName !== 'function') return;
    if (typeof document.createTreeWalker !== 'function') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const parentTag = node.parentElement ? node.parentElement.tagName : '';
      if (parentTag === 'PRE' || parentTag === 'CODE') continue;
      const text = node.nodeValue || '';
      if (!text) continue;
      const pieces = [];
      let buffer = '';
      const chars = Array.from(text);
      for (let index = 0; index < chars.length; index += 1) {
        let candidate = chars[index];
        // 变体选择符 U+FE0F 属于同一个符号，一起吞掉再查表。
        if (chars[index + 1] === '\uFE0F') { candidate += chars[index + 1]; index += 1; }
        const name = uiIcons.emojiName(candidate);
        if (!name) { buffer += candidate; continue; }
        if (buffer) { pieces.push(document.createTextNode(buffer)); buffer = ''; }
        const icon = iconNode(name);
        icon.classList.add('ui-icon-inline');
        pieces.push(icon);
      }
      if (!pieces.length) continue;
      if (buffer) pieces.push(document.createTextNode(buffer));
      const fragment = document.createDocumentFragment();
      fragment.append(...pieces);
      node.parentNode?.replaceChild(fragment, node);
    }
  }

  /**
   * 工具条上的「深度」档，与 `src/views/chatPanel.ts` 的 REASONING_DEPTHS 一致。
   * 'none'（关闭思考）不在常量里，但由 `syncReasoningSelector()` 对**所有**支持
   * 思考的模型动态加到第二位——它和「低/高/最大」一样是官方接受的档位。
   * 'default'（不发送参数）也不是深度，固定在第一档。
   */
  const REASONING_DEPTHS = ['low', 'medium', 'high', 'max'];
  /** 步数第四档「无限制」的表示值，与 `src/core/agentLimits.ts` 保持一致。 */
  const STEPS_UNLIMITED = 0;

  const elements = Object.fromEntries([
    'app', 'historyPane', 'historyButton', 'closeHistoryButton', 'newChatButton',
    'historySearch', 'archiveViewButton', 'conversationList', 'settingsButton',
    'settingsButtonSide', 'exportButton', 'archiveButton', 'conversationTitle',
    'conversationTitleInput', 'projectBadge', 'editTitleButton', 'saveTitleButton', 'cancelTitleButton',
    'connectionState', 'profileInput', 'modelInput', 'modeInput', 'internetReferenceButton', 'skillsButton', 'skillsCount',
    'skillsPanel', 'skillsList', 'workspaceTrustBadge', 'skillsInstallHint', 'skillsInstallButton', 'skillsSourceNote', 'messageViewport',
    'messageList', 'emptyState', 'loadOlderButton', 'scrollToBottomButton', 'attachmentList', 'contextChip',
    'contextLabel', 'removeContextButton', 'composer', 'promptInput',
    'historyLinkBanner', 'sourceHistoryTitle', 'detachHistoryButton',
    'permissionPresetInput', 'agentMaxStepsInput', 'reasoningEffortInput', 'voiceButton',
    'agentRunState', 'agentRunLabel', 'agentRunMeta', 'taskTree', 'taskTreeSummary', 'taskTreeList',
    'todoPanel', 'todoList', 'todoSummary', 'todoSummaryActions', 'resumeTodosButton', 'cancelTodosButton',
    'todoArchivePanel', 'todoArchiveList', 'todoArchiveSummary', 'todoArchiveBar',
    'approvalCard', 'approvalTitle', 'approvalSummary', 'approvalDetail', 'approvalDenyButton', 'approvalAllowButton',
    'messageEditor', 'messageEditorInput', 'messageEditorState', 'messageEditorHint', 'messageEditorSave', 'messageEditorCancel', 'messageEditorTitle',
    'attachButton', 'sendButton', 'stopButton', 'toast',
  ].map((id) => [id, document.getElementById(id)]));

  const state = {
    conversations: [], archivedConversations: [], conversation: null, messages: [],
    hasMore: false, sendOnEnter: true, streaming: false, streamingConversationId: null,
    search: '', pendingAttachments: [], skills: [], selectedSkillIds: [], quickLaunchInstalled: true, mode: 'agent',
    apiProfiles: [], activeApiProfileId: '', model: '', permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default',
    modelOptionsByProfile: {},
    permissionPresetPending: false, modelLoadingProfileId: null,
    workspaceTrusted: false, agentAvailable: false, availableToolCount: 0, showArchived: false, renderTimer: null,
    project: { name: null, bound: false }, titleEditing: false,
    /**
     * 文件引用的上下文：工作区根目录 + 本对话的项目根 + 当前操作系统对应的
     * 「文件管理器」名字（macOS 是 Finder，Windows 是资源管理器）。
     * 由扩展在每次推状态时下发，前端据此把相对路径拼成绝对路径。
     */
    fileRoots: { roots: [], preferred: '' }, fileTarget: 'finder',
    taskTree: null, todos: [], todoArchives: [], expandedArchiveId: null, archiveRestore: null, todosInterrupted: false, todosIncomplete: false,
    /** 互联网参考开关（按对话）：由 state 下发，界面只回显。 */
    internetReference: false,
    todoSignature: '',
    runningConversationIds: [], pendingApprovals: [],
    /** 每个对话各自的输入框草稿，键是对话 id（还没落库的新对话用 'draft'）。 */
    drafts: {},
    autoFollow: true, renderingMessages: false, voiceRecognition: null, voiceActive: false,
  };

  const clipboardWrites = new Map();
  let clipboardSequence = 0;
  let pasteSequence = 0;
  let pasteFallbackTimer = null;
  let pendingPaste = null;
  let deferredMessageRenderMode = null;
  /**
   * 长用户消息默认折叠。
   *
   * 用户贴进来的长篇需求（一份 ADR、一整段决策表）会把整个对话框顶成几屏，
   * 自己刚才说的话反倒把后面的回复挤出视野。所以超过阈值就折起来，只留开头几行
   * 加一层渐隐，右下角给一个「展开全文」。
   *
   * 阈值同时看字符数与行数：一张 Markdown 表格字符不多但行很多，只看字符数会漏；
   * 反过来一整段没有换行的长文又只看行数会漏。
   */
  const USER_CLAMP_CHARS = 480;
  const USER_CLAMP_LINES = 12;
  /**
   * 用户手动展开过的消息 id。
   *
   * 放在模块级而不是 DOM 上：整段重建（新消息到达、状态回推）会把 article 重造一遍，
   * 若把状态存在节点上，用户刚展开的一条下一帧又缩回去了。
   */
  const expandedUserMessages = new Set();

  /**
   * 正在**消息气泡里**编辑的那条用户消息。
   *
   * 排队消息（还没被 agent 取走）的编辑入口放在气泡里，而不是任务树：任务树一行
   * 只显示一句话，长内容根本看不清。编辑态存模块级、不存节点上——整段重建会把
   * article 重造一遍（理由同 expandedUserMessages）。
   */
  let editingBubbleMessageId = null;
  /** 编辑中的那条消息对应的任务节点 id：保存时要把它交给 editTaskMessage。 */
  let editingBubbleTaskId = null;
  let editingBubbleDraft = '';
  /**
   * 编辑模式：
   * - `inPlace`：这条还在队列里，保存就是改掉它本身（下一轮直接读新内容）；
   * - `resend`：这条已经被 agent 执行过，历史不会改写，保存后作为一条新消息发出。
   */
  let editingBubbleMode = 'inPlace';
  /** 等着被局部重画的那条消息 id（见 scheduleMessagePatch）。 */
  let pendingPatchId = null;
  let selectingMessageText = false;
  let interactingWithMessages = false;
  let interactionTimer = null;
  /** 本次按下落在哪个 `<summary>` 上（见 pointerdown 里的 click 委托兜底）。 */
  let pressedSummary = null;

  function post(type, payload = {}) { vscode.postMessage({ type, ...payload }); }

  /**
   * 量一次布局，把「到底是我们的 CSS 还是 webview 宽度本身不对」分清楚。
   *
   * 面板右侧被切有两种完全不同的原因，症状却一模一样：
   *  1. 文档里某个内容太宽，把文档撑出横向滚动 → `文档.scrollWidth > 视口.clientWidth`；
   *  2. webview 的宽度比可见区域大（宿主没重排），文档自己并不溢出 →
   *     两个数相等，但 `聊天栏 + 侧栏` 的宽度明显大于窗口应有的宽度。
   * 光看截图分不出来，所以把原始数字一起报上去（命令：复制布局诊断）。
   */
  function collectLayoutReport() {
    const doc = document.documentElement;
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    };
    const wide = [];
    for (const node of document.querySelectorAll('body *')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > doc.clientWidth + 1) {
        wide.push(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${typeof node.className === 'string' && node.className ? `.${node.className.split(/\s+/)[0]}` : ''} right=${Math.round(rect.right)} w=${Math.round(rect.width)}`);
        if (wide.length >= 8) break;
      }
    }
    /*
     * 胶囊归档栏单独量一遍。
     *
     * 用户反馈「往左拖到滚不动为止，右侧胶囊还是被截断」——这句话本身信息不足：
     * 可能是栏的右边界跑到容器外面（滚到头也露不出来），也可能是可达上限被算小了，
     * 还可能是它上面有东西压着。把「栏自身的滚动账」和「最后一颗胶囊的实际位置」
     * 一起量出来，就能直接分辨是哪一种，不必再猜。
     */
    const capsuleBar = (() => {
      const bar = document.getElementById('todoArchiveBar');
      if (!bar || bar.hidden) return null;
      const rect = bar.getBoundingClientRect();
      const parent = bar.parentElement;
      const parentRect = parent ? parent.getBoundingClientRect() : null;
      const capsules = bar.querySelectorAll('.todo-capsule');
      const last = capsules.length ? capsules[capsules.length - 1].getBoundingClientRect() : null;
      // 滚到真正的上限，看最后一颗能不能完整露出来；量完还原，不改用户当前视图。
      const restore = bar.scrollLeft;
      bar.scrollLeft = Number.MAX_SAFE_INTEGER;
      const atEnd = bar.scrollLeft;
      const max = Math.max(0, bar.scrollWidth - bar.clientWidth);
      const lastAtEnd = last ? capsules[capsules.length - 1].getBoundingClientRect() : null;
      bar.scrollLeft = restore;
      const style = getComputedStyle(bar);
      return {
        count: capsules.length,
        bar: { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) },
        parent: parentRect ? { cls: parent.className, right: Math.round(parentRect.right), width: Math.round(parentRect.width) } : null,
        overflowsParent: parentRect ? Math.round(rect.right - parentRect.right) : null,
        clientWidth: bar.clientWidth,
        scrollWidth: bar.scrollWidth,
        maxScroll: Math.round(max),
        scrollLeft: Math.round(atEnd),
        reachedEnd: atEnd >= max - 1,
        margin: `${style.marginLeft}/${style.marginRight}`,
        padding: `${style.paddingLeft}/${style.paddingRight}`,
        lastCapsuleRightAtEnd: lastAtEnd ? Math.round(lastAtEnd.right) : null,
        lastCapsuleClippedBy: lastAtEnd ? Math.round(lastAtEnd.right - rect.right) : null,
        lastCapsuleFullyVisible: lastAtEnd ? lastAtEnd.right <= rect.right + 1 : null,
      };
    })();
    return {
      viewport: `${doc.clientWidth}x${doc.clientHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      documentScrollWidth: doc.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      horizontalOverflow: doc.scrollWidth - doc.clientWidth,
      appShell: box('#app'),
      historyPane: box('#historyPane'),
      chatPane: box('.chat-pane'),
      messageViewport: box('#messageViewport'),
      messageList: box('#messageList'),
      composerWrap: box('.composer-wrap'),
      chatToolbar: box('.chat-toolbar'),
      capsuleBar,
      mediaQueries: {
        mobile720: window.matchMedia('(max-width: 720px)').matches,
        narrow860: window.matchMedia('(max-width: 860px)').matches,
      },
      wideElements: wide,
    };
  }

  /* ── 复制「文字 + 图片」───────────────────────────────────────────────
   *
   * 需求（用户原话）：「历史消息里含有图片，点击复制直接连图片和文字一起复制，
   * 且能一起粘贴到输入框」。
   *
   * 为什么不能仍走扩展：VS Code 的剪贴板 API 只有 `writeText`，写不了图片。
   * 所以带图片的消息改由 webview 自己用异步剪贴板写入（`navigator.clipboard.write`
   * + `ClipboardItem`），一次写入两种格式：`text/plain` 与 `image/png`。
   *
   * 这条路在 VS Code 里是通的 —— 依据是 VS Code 自己的 workbench 源码：
   * webview 的 iframe 上写着
   *     allow="cross-origin-isolated; autoplay; local-network-access; clipboard-read; clipboard-write"
   * （仅 Firefox 会省略最后两项，见 `Qu = userAgent 含 Firefox` 那处判断），
   * 而 webview 跑的是 Chromium。所以授权这一层不需要额外配置。
   *
   * 实测（headless Chromium，同一内核）：写入 文字 + 1×1 PNG 后读回剪贴板得到
   * `["text/plain","image/png"]`；在 textarea 里粘贴，`clipboardData` 同时给出
   * `text/plain` 和 `file:image/png` —— 也就是输入框既拿到文字、又拿到一张图。
   */

  /** 剪贴板里一次只能放一张图片（ClipboardItem 的键是 MIME），多图时只放第一张。 */
  const pendingAttachmentData = new Map();

  /** 向扩展要附件的原始 base64（前端只有 160×120 的缩略图，复制要用原图）。 */
  function requestAttachmentData(id) {
    return new Promise((resolve) => {
      const requestId = `attdata-${Date.now()}-${++clipboardSequence}`;
      const timer = setTimeout(() => {
        if (pendingAttachmentData.delete(requestId)) resolve(null);
      }, 5_000);
      pendingAttachmentData.set(requestId, { resolve, timer });
      post('requestAttachmentData', { requestId, id });
    });
  }

  function finishAttachmentData(message) {
    const pending = pendingAttachmentData.get(message.requestId);
    if (!pending) return;
    pendingAttachmentData.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message.ok && message.dataBase64 ? message : null);
  }

  /**
   * 把原图统一转成 PNG。
   *
   * `ClipboardItem` 只接受 `text/plain` / `text/html` / `image/png` 三种键：
   * 直接把 `image/jpeg` 塞进去会抛异常，用户点了复制就什么也没复制到。
   * 所以非 PNG 的图片先解到 canvas 再导出 PNG。
   */
  async function toPngBlob(data) {
    const mime = (data.mimeType || 'image/png').toLowerCase();
    const bytes = Uint8Array.from(atob(data.dataBase64), (char) => char.charCodeAt(0));
    const source = new Blob([bytes], { type: mime });
    if (mime === 'image/png') return source;
    const bitmap = await createImageBitmap(source);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    } finally {
      bitmap.close?.();
    }
  }

  /** 写入「文字 + 图片」。成功返回 true；环境不支持或写入被拒时返回 false，由调用方降级。 */
  async function writeRichClipboard(text, data) {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    try {
      const png = await toPngBlob(data);
      if (!png) return false;
      const entries = { 'text/plain': new Blob([text], { type: 'text/plain' }), 'image/png': png };
      await navigator.clipboard.write([new ClipboardItem(entries)]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 消息上的「复制」：有图片就连图片一起复制，没有就走原来的纯文字路径。
   *
   * 降级是**显式**的：写图片失败时仍然把文字复制成功，并弹一句说明，而不是让用户
   * 以为复制成功了、粘贴时才发现少了图。
   */
  async function copyMessage(button, message) {
    const text = message?.content || '';
    const images = (message?.attachments || []).filter((attachment) => attachment.kind === 'image' && attachment.id);
    if (!images.length) {
      requestClipboardWrite(text, button);
      return;
    }
    if (button) { button.disabled = true; button.textContent = t('common.copying'); }
    const data = await requestAttachmentData(images[0].id);
    const written = data ? await writeRichClipboard(text, data) : false;
    if (written) {
      flashCopyLabel(button, true);
      showToast(images.length > 1 ? t('chat.copyImageFirstOnly') : t('chat.copiedWithImage'), 'neutral');
      return;
    }
    // 图片没能写进剪贴板：文字仍然要复制成功，只是少了图。
    requestClipboardWrite(text, button);
    showToast(t('chat.copyImageUnsupported'), 'warning');
  }

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
    flashCopyLabel(pending.button, ok, pending.idleLabel);
    if (!ok) showToast(t('chat.clipboardFailed', { error: error || t('chat.clipboardUnavailable') }), 'warning');
  }

  /**
   * 复制按钮的两段式反馈：先变「已复制」，1.2 秒后回到原文案。
   *
   * 抽出来是因为现在有**两条**写入路径：纯文字走扩展（`copyText`），
   * 文字 + 图片走 webview 自己的 `navigator.clipboard.write`（扩展 API 只能写文字）。
   * 两条路径的按钮反馈必须一致，否则用户会以为其中一种没生效。
   */
  function flashCopyLabel(button, ok, idleLabel = t('common.copy')) {
    if (!button) return;
    button.disabled = false;
    button.textContent = ok ? t('common.copied') : idleLabel;
    if (ok) setTimeout(() => { if (button.isConnected) button.textContent = idleLabel; }, 1_200);
  }

  function renderAll(options) {
    const skipMessages = Boolean(options && options.skipMessages);
    renderHistory(); renderHeader(); renderSkills();
    if (!skipMessages) renderMessages('replace');
    renderHistoryLink(); renderAttachments(); renderTaskTree(); renderTodos(); renderArchivePanel(); renderTodoArchives(); renderApproval(); updateComposerState();
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
      if (conversation.pending) row.dataset.pending = '1';
      const content = document.createElement('button');
      content.type = 'button'; content.className = 'conversation-content';
      const titleRow = document.createElement('span'); titleRow.className = 'conversation-title-row';
      // 多线程：这条对话在后台跑（或正在等授权）时，列表里直接标出来，不用挨个点开看。
      const runningNow = state.runningConversationIds.includes(conversation.id);
      const awaitingNow = state.pendingApprovals.some((item) => item.conversationId === conversation.id);
      if (runningNow) titleRow.append(textElement('span', 'conversation-dot running', ''));
      if (awaitingNow) titleRow.append(textElement('span', 'conversation-dot awaiting', ''));
      titleRow.append(textElement('span', 'conversation-title', conversation.title));
      // 状态文字单独成节点（而不是拼进整段 meta 字符串）：「运行中」要单独着色，
      // 时间戳和 token 数必须保持原色，否则整行都被染蓝就分不出重点了。
      const tokenTotal = conversation.totalTokens ? ` · ${formatMillionTokens(conversation.totalTokens)} tokens` : '';
      const linked = conversation.sourceConversationId ? t('chat.continuedPrefix') : '';
      const meta = textElement('span', 'conversation-meta', '');
      if (awaitingNow) meta.append(textElement('span', 'conversation-status awaiting', `${t('approval.pending')} · `));
      else if (runningNow) meta.append(textElement('span', 'conversation-status running', `${t('chat.running')} · `));
      meta.append(document.createTextNode(`${linked}${relativeTime(conversation.updatedAt)}${tokenTotal}`));
      const preview = textElement('span', 'conversation-preview', conversation.preview || t('common.emptyConversation'));
      content.append(titleRow, meta, preview);
      content.addEventListener('click', () => {
        // 占位卡还没有真实 id：点它等于「什么都不做」，避免把假 id 发给扩展。
        if (conversation.pending) return;
        post('selectConversation', { id: conversation.id });
        closeMobileHistory();
      });
      const actions = document.createElement('div'); actions.className = 'conversation-actions';
      const continueTask = actionButton(t('chat.continueTaskHistory'), 'arrowUpRight');
      continueTask.disabled = runningNow || awaitingNow || Boolean(conversation.pending);
      continueTask.addEventListener('click', () => { post('continueConversation', { id: conversation.id }); closeMobileHistory(); });
      const pin = actionButton(conversation.pinned ? t('chat.unpin') : t('chat.pin'), conversation.pinned ? 'dot' : 'ring');
      pin.disabled = Boolean(conversation.pending);
      pin.addEventListener('click', () => post('togglePin', { id: conversation.id, pinned: !conversation.pinned }));
      const archive = actionButton(conversation.archived ? t('chat.restoreConversation') : t('chat.archive'), conversation.archived ? 'restore' : 'square');
      archive.addEventListener('click', () => post('toggleArchive', { id: conversation.id, archived: !conversation.archived }));
      const remove = actionButton(t('common.delete'), 'close'); remove.classList.add('danger-action');
      remove.disabled = Boolean(conversation.pending);
      remove.addEventListener('click', () => post('deleteConversation', { id: conversation.id }));
      actions.append(continueTask, pin, archive, remove); row.append(content, actions); elements.conversationList.append(row);
    }
  }

  /** 行内操作按钮。形状由 media/ui-icons.js 决定，label 只用于无障碍与悬停提示。 */
  function actionButton(label, iconName) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'row-action'; button.setAttribute('aria-label', label); button.title = label;
    button.append(iconNode(iconName));
    return button;
  }

  function renderHeader() {
    const archived = Boolean(state.conversation?.archived);
    // 后台线程数（不含当前对话）：用于提示「还能继续在这里操作」。
    const otherRunning = state.runningConversationIds.filter((id) => id !== state.conversation?.id).length;
    elements.conversationTitle.textContent = state.conversation?.title || t('common.newChat');
    renderProjectBadge();
    // 编辑中不覆盖输入框：服务端随时可能推状态（流式输出、清单更新），
    // 那会让用户正在打的内容被旧标题冲掉。
    const canRename = Boolean(state.conversation?.id);
    elements.editTitleButton.disabled = !canRename;
    elements.editTitleButton.title = canRename ? t('chat.editTitle') : t('chat.titleEditLocked');
    if (state.titleEditing && !canRename) {
      finishTitleEdit(false);
    }
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
    syncSkillsButton();
    elements.permissionPresetInput.value = state.permissionPreset;
    syncPermissionHint();
    ensureStepOption(state.agentMaxSteps);
    elements.agentMaxStepsInput.value = String(state.agentMaxSteps);
    syncReasoningSelector();
    const activeProfileId = state.conversation?.apiProfileId || state.activeApiProfileId;
    syncInternetReferenceButton();
  }

  /**
   * 互联网参考开关的显示：`aria-pressed` 是唯一状态来源，样式与提示都由它派生。
   *
   * 不加「loading」之类的过渡态：模型列表的刷新已经改成静默自动（见后端
   * `ensureModelsFresh`），这里不再需要为「正在刷新」显示任何东西。
   */
  function syncInternetReferenceButton() {
    const button = elements.internetReferenceButton;
    if (!button) return;
    const enabled = state.internetReference === true;
    button.setAttribute('aria-pressed', String(enabled));
    button.classList.toggle('is-on', enabled);
    button.title = enabled ? t('chat.internetReferenceOn.hint') : t('chat.internetReferenceOff.hint');
  }

  /**
   * 标题旁的项目徽标：本对话**涉及**的全部项目。
   *
   * 已绑定：橙色显示文件夹名，多个项目用 `·` 连起来——一个对话经常横跨多个项目
   * （在 A 里做功能、顺手把 B 的对接改掉），只显示第一个时用户看不出还动过别处。
   * 一行放不下时折成 `+N`，完整清单进 title，别把标题挤走。
   * 未绑定：红色显示「项目待建立」——此时 git 写操作会被拒绝，必须让用户看见，
   * 不能显示一个猜出来的目录名让用户以为已经绑定好了。
   */
  function renderProjectBadge() {
    const badge = elements.projectBadge;
    if (!badge) return;
    const project = state.project || { name: null, others: [], bound: false };
    const others = Array.isArray(project.others) ? project.others.filter((name) => typeof name === 'string' && name) : [];
    if (project.bound && project.name) {
      // 一行放得下的名字数量：写成常量而不是外部变量，这一段要能被测试脚本单独抽出来跑。
      const visibleNames = 3;
      const names = [project.name, ...others];
      const shown = names.slice(0, visibleNames);
      const hidden = names.length - shown.length;
      badge.textContent = hidden > 0 ? `${shown.join(' · ')} +${hidden}` : shown.join(' · ');
      badge.classList.add('bound');
      badge.classList.remove('missing');
      badge.classList.toggle('multi', names.length > 1);
      // 悬停永远给出完整清单：折起来的那些名字不能只存在于「+N」里。
      badge.title = names.length > 1
        ? t('chat.projectLabelMany', { count: names.length, names: names.join(' / ') })
        : t('chat.projectLabel', { name: names[0] });
    } else {
      badge.textContent = t('chat.projectPending');
      badge.classList.add('missing');
      badge.classList.remove('bound', 'multi');
      badge.title = t('chat.projectPendingHint');
    }
    badge.hidden = false;
  }

  /** 进入标题编辑：只切显示，不发请求。 */
  function startTitleEdit() {
    if (state.titleEditing || !state.conversation?.id) return;
    state.titleEditing = true;
    elements.conversationTitleInput.value = state.conversation.title || '';
    elements.conversationTitle.hidden = true;
    elements.conversationTitleInput.hidden = false;
    elements.editTitleButton.hidden = true;
    elements.saveTitleButton.hidden = false;
    elements.cancelTitleButton.hidden = false;
    elements.conversationTitleInput.focus();
    elements.conversationTitleInput.select();
  }

  /**
   * 退出标题编辑。
   *
   * `commit` 为真才发请求；空标题、没改动都只是退出，不打扰用户。
   * 放弃编辑（叉号 / Esc）时输入框里的内容直接丢弃，不写 state，也不发请求。
   */
  function finishTitleEdit(commit) {
    if (!state.titleEditing) return;
    state.titleEditing = false;
    const value = elements.conversationTitleInput.value.trim();
    elements.conversationTitleInput.hidden = true;
    elements.conversationTitle.hidden = false;
    elements.editTitleButton.hidden = false;
    elements.saveTitleButton.hidden = true;
    elements.cancelTitleButton.hidden = true;
    if (!commit) return;
    const current = state.conversation?.title || '';
    if (!value || value === current) return;
    post('renameConversation', { id: state.conversation?.id, title: value });
  }

  function syncPermissionHint() {
    const selected = elements.permissionPresetInput.selectedOptions[0];
    const hint = selected?.title || '';
    // 运行中切换只对下一次对话生效：把这个约束写进悬停提示，
    // 用户才不会以为「改了但没生效」。
    const nextTurn = state.streaming ? t('chat.permissionPresetNextTurnHint') : '';
    elements.permissionPresetInput.title = [
      hint ? t('chat.permissionPresetTitle', { hint }) : t('chat.permissionPreset'),
      nextTurn,
    ].filter(Boolean).join('\n');
    elements.permissionPresetInput.dataset.nextTurnOnly = state.streaming ? '1' : '';
    elements.permissionPresetInput.closest('.permission-field')?.setAttribute('title', [hint, nextTurn].filter(Boolean).join('\n'));
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
    const labels = { default: t('chat.reasoning.default'), none: t('chat.reasoning.none'), low: t('chat.reasoning.low'), medium: t('chat.reasoning.medium'), high: t('chat.reasoning.high'), max: t('chat.reasoning.max') };
    // 'default' 永远排第一：它表示「不发参数、用模型官方默认」，也是新对话的初始值。
    let efforts = ['default'];
    let title = t('chat.reasoningSupport.unknown');
    if (support === 'configurable') {
      // 深度档按模型声明过滤（声明里若带着 default，这里不用它——'default'
      // 已固定在第一档）。「无」= 关闭思考，任何支持思考的模型都能关
      // （DeepSeek 走 thinking.type=disabled），所以它常驻在第二位，
      // 与 Copilot 的「无 / 低 / 高 / 最大」一致。
      const declared = modelOption?.reasoningEfforts?.length ? modelOption.reasoningEfforts : REASONING_DEPTHS;
      const depths = REASONING_DEPTHS.filter((value) => declared.includes(value));
      const levels = ['none', ...(depths.length ? depths : [...REASONING_DEPTHS])];
      efforts = ['default', ...new Set(levels)];
      title = t('chat.reasoningSupport.configurable');
    } else if (support === 'unsupported') {
      title = t('chat.reasoningSupport.unsupported');
    } else if (support === 'fixed') {
      title = t('chat.reasoningSupport.fixed');
    }
    // 旧存档里可能是 'none'（关闭思考）：不是「深度」，但也不能静默改成别的档
    // ——那等于替用户打开思考、多花 token。补一个临时选项照原样显示即可。
    if (!efforts.includes(state.reasoningEffort)) {
      // 非法 / 已不在该模型能力里的值：回到「模型官方默认」，而不是替用户选「高」。
      state.reasoningEffort = 'default';
    }
    const singleLabel = support === 'unsupported' ? t('chat.reasoningUnsupportedShort') : support === 'fixed' ? t('chat.reasoningFixedShort') : support === 'unknown' ? t('chat.reasoningUnknownShort') : undefined;
    replaceSelectOptions(elements.reasoningEffortInput, efforts.map((value) => ({ value, label: singleLabel || labels[value] || value })), state.reasoningEffort);
    elements.reasoningEffortInput.dataset.support = support;
    elements.reasoningEffortInput.dataset.baseTitle = title;
    applyReasoningTitle();
  }

  /** 思考深度的悬停提示 = 能力说明 + （运行中）「下一次发送生效」。 */
  function applyReasoningTitle() {
    const base = elements.reasoningEffortInput.dataset.baseTitle || '';
    const nextSend = state.streaming && elements.reasoningEffortInput.dataset.support === 'configurable'
      ? t('chat.controlsNextSendHint')
      : '';
    elements.reasoningEffortInput.title = [base, nextSend].filter(Boolean).join('\n');
  }

  /** 步数与思考深度在运行中也能改，把「下一次发送生效」写进悬停提示。 */
  function syncNextSendHints() {
    const nextSend = state.streaming ? t('chat.controlsNextSendHint') : '';
    elements.agentMaxStepsInput.title = [t('chat.maxSteps'), nextSend].filter(Boolean).join('\n');
    applyReasoningTitle();
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

  /**
   * 步数归一：`0` 是第四档「无限制」（显式选择），保持 0；
   * 负数、非数字、空值这类脏值显示成默认 24；正数夹到 200 的绝对上限。
   * 注意 `Number('') === 0`：空串必须单独挡掉，否则一个空的下拉值会被当成「无限制」。
   */
  function normalizeStepValue(value) {
    if (value === '' || value === null || value === undefined) return 24;
    const numeric = Math.floor(Number(value));
    if (!Number.isFinite(numeric)) return 24;
    if (numeric === STEPS_UNLIMITED) return STEPS_UNLIMITED;
    if (numeric < 0) return 24;
    return Math.min(numeric, 200);
  }

  function stepsLabel(value) {
    return value === STEPS_UNLIMITED ? t('chat.stepsUnlimited') : t('chat.stepsOption', { count: value });
  }

  function ensureStepOption(value) {
    const normalized = normalizeStepValue(value);
    if ([...elements.agentMaxStepsInput.options].some((option) => Number(option.value) === normalized)) return;
    const option = document.createElement('option'); option.value = String(normalized); option.textContent = stepsLabel(normalized);
    elements.agentMaxStepsInput.append(option);
  }

  /**
   * skills 按钮现在只显示图标（数量文字被 CSS 隐藏了），
   * 所以数量必须挪到悬停提示和无障碍标签里，否则「已启用几个」就没有任何可见入口。
   */
  function syncSkillsButton() {
    const count = state.selectedSkillIds.length;
    const label = count ? `${t('chat.selectSkill')} · ${count}` : t('chat.selectSkill');
    elements.skillsCount.textContent = String(count);
    elements.skillsButton.title = label;
    elements.skillsButton.setAttribute('aria-label', label);
    elements.skillsButton.classList.toggle('active', count > 0);
  }

  function renderSkills() {
    elements.skillsList.replaceChildren();
    elements.workspaceTrustBadge.textContent = state.workspaceTrusted ? t('settings.workspaceTrusted') : t('settings.workspaceUntrusted');
    elements.workspaceTrustBadge.classList.toggle('trusted', state.workspaceTrusted);
    syncSkillsInstallHint();
    /**
     * 没装「本地skill快捷调用」时**不列技能**。
     *
     * 用户反馈：那个扩展卸载之后，星标面板里仍然是一整屏技能 + 「默认启用」打勾，
     * 看起来像扩展的残留。原因是勾选读取的是它留下的 `.skill-quick-launch.json`
     * （扩展侧已经不再读了），而列表本身来自 `~/.copilot/skills/`。按产品语义，
     * 这时面板的职责只有一个：告诉用户去装那个扩展。装好之后（`extensions.onDidChange`
     * 会立刻回推）列表与勾选自动接上。
     */
    if (!state.quickLaunchInstalled) {
      elements.skillsList.hidden = true;
      return;
    }
    elements.skillsList.hidden = false;
    if (!state.skills.length) {
      elements.skillsList.append(textElement('p', 'skills-empty', t('chat.skillsEmpty')));
      return;
    }
    for (const skill of state.skills) {
      const label = document.createElement('label'); label.className = 'skill-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = state.selectedSkillIds.includes(skill.id);
      /**
       * 勾选只属于**当前这条对话**：取消不会写回「本地skill快捷调用」那份全局清单，
       * 那份清单只提供新对话的默认值。所以这里只发一个意图，由扩展侧落到这条对话的
       * 存档，界面等 `skillsChanged` 回推再更新。
       *
       * 没装那个扩展时照样能勾（勾的是本对话），只是顺带把安装提示展开，说明新对话的
       * 默认值本该从那里来。
       */
      input.addEventListener('change', () => {
        if (skill.source === 'copilot' && !state.quickLaunchInstalled) showSkillsInstallHint();
        post('toggleSkill', { skillId: skill.id, enabled: input.checked });
      });
      const copy = document.createElement('span');
      const title = document.createElement('span'); title.className = 'skill-option-title'; title.append(textElement('strong', '', skill.name));
      if (skill.defaultEnabled) title.append(textElement('em', 'skill-badge', t('chat.skillDefaultEnabled')));
      if (skill.lastUsedAt) title.append(textElement('em', 'skill-badge used', t('chat.skillUsed')));
      copy.append(title, textElement('small', '', skill.description || skill.relativePath), textElement('code', '', skill.relativePath));
      label.append(input, copy); elements.skillsList.append(label);
    }
  }

  /**
   * 安装提示只反映「扩展在不在」，与展开了几次无关，重渲染后由它统一对齐。
   *
   * 关键点：**没装时点开星标就要看到它**。旧实现只会在「用户勾了一个 copilot skill」
   * 之后才展开，于是「点星标 → 一片勾选列表，不知道该装扩展」——正是用户报的问题。
   */
  function syncSkillsInstallHint() {
    if (!elements.skillsInstallHint) return;
    elements.skillsInstallHint.hidden = Boolean(state.quickLaunchInstalled);
    syncSkillsSourceNote();
  }

  /** 面板底部的说明随安装状态切换：装了才谈「只影响本次对话」。 */
  function syncSkillsSourceNote() {
    const note = elements.skillsSourceNote;
    if (!note) return;
    note.textContent = state.quickLaunchInstalled
      ? t('chat.skillsSourceInstalled')
      : t('chat.skillsSourceMissing');
  }

  /** 面板必须可见，用户才可能看到安装提示（勾选时会用到）。 */
  function showSkillsInstallHint() {
    if (!elements.skillsInstallHint) return;
    elements.skillsPanel.hidden = false;
    elements.skillsInstallHint.hidden = Boolean(state.quickLaunchInstalled);
    if (!elements.skillsInstallHint.hidden) {
      elements.skillsInstallHint.scrollIntoView({ block: 'nearest' });
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

  /**
   * 消息列表的「画面签名」。
   *
   * 用途：`state` 推送里绝大多数只是设置/控件变了（切预设、切模型、加附件、归档…），
   * 消息本身一条都没动，但 `renderAll()` 以前无条件 `renderMessages('replace')` ——
   * 80 条消息实测 **20ms CPU / 次**（重建 1500+ 个 DOM 节点并重新布局）。
   *
   * 签名只取「会让画面不同」的字段，且不序列化正文（只看长度），所以对 80 条消息
   * 是几十微秒。真正的正文变化一定伴随 `updatedAt` / 长度变化，不会被漏掉。
   */
  function messageListSignature(messages, conversationId) {
    const parts = [conversationId || ''];
    for (const message of messages || []) {
      const tools = message.toolExecutions || [];
      const lastTool = tools.length ? tools[tools.length - 1] : null;
      parts.push([
        message.id,
        message.role,
        message.status || '',
        message.updatedAt || 0,
        (message.content || '').length,
        (message.reasoning || '').length,
        tools.length,
        lastTool ? `${lastTool.callId}:${lastTool.status}:${lastTool.finishedAt || 0}:${(lastTool.output || '').length}` : '',
        (message.usedSkills || []).length,
        (message.attachments || []).length,
        message.context ? 1 : 0,
      ].join('~'));
    }
    return parts.join('\n');
  }

  /** 最近一次真正画进 DOM 的那份消息列表的签名。 */
  let renderedMessageSignature = '';

  function renderMessages(mode = 'keep', options = {}) {
    if (!options.force && (selectingMessageText || interactingWithMessages || hasMessageSelection())) {
      deferMessageRender(mode);
      return;
    }
    /*
     * 编辑框已经搬到 `#messageList` 之外的浮层（`#messageEditor`），
     * 所以这里**不再需要**「编辑中暂停重绘」的守卫：消息列表随便重排，
     * 浮层与光标都不受影响。保留 `options.force` 参数以兼容既有调用点。
     */
    deferredMessageRenderMode = null;
    // 整段重建会把 DOM 直接对齐 state，此时「只差某一条没重画」的待办已经自动满足。
    pendingPatchId = null;
    const viewport = elements.messageViewport;
    const previousTop = viewport.scrollTop;
    const previousHeight = viewport.scrollHeight;
    const shouldFollow = mode === 'bottom' || state.autoFollow;
    state.renderingMessages = true;
    // 消息列表整段重建。只在「结构真的变了」时走这条路（切换对话、追加消息、
    // 补载更早的消息）；流式输出期间每 70ms 那一次改走 patchMessage，
    // 原因见那里的注释。先记录用户手动展开/收起的 <details> 状态，
    // 重建后再恢复，否则点击展开会立刻被下一次渲染收起。
    const detailOverrides = captureDetailOverrides();
    elements.messageList.replaceChildren(); elements.emptyState.hidden = state.messages.length > 0;
    elements.loadOlderButton.hidden = !state.hasMore || !state.messages.length;
    for (const message of state.messages) {
      const article = renderMessage(message);
      rememberRender(article, message);
      elements.messageList.append(article);
    }
    restoreDetailOverrides(detailOverrides);
    renderedMessageSignature = messageListSignature(state.messages, state.conversation?.id);
    requestAnimationFrame(() => {
      if (shouldFollow) viewport.scrollTop = viewport.scrollHeight;
      else if (mode === 'prepend') viewport.scrollTop = previousTop + Math.max(0, viewport.scrollHeight - previousHeight);
      else viewport.scrollTop = previousTop;
      state.renderingMessages = false;
      updateScrollToBottom();
    });
  }

  /**
   * 流式输出期间只重画「正在变的那一条消息」。
   *
   * 真实缺陷（用户反馈「输出内容一闪一闪的跳动」）：以前每个 delta 都调
   * renderMessages()，而它是整段重建——先 `messageList.replaceChildren()` 清空，
   * 再把 N 条消息全部重新造一遍，70ms 一次。于是每个 tick 都在做 O(N) 的
   * 销毁 + 重建，长对话里能直接看出来：
   *   1. `.stream-cursor` 被新造一个，`blink` 动画每 70ms 从头开始 —— 光标在抖；
   *   2. 其它消息的 <details>（思考过程、步骤详情）被重造，展开状态靠事后回填，
   *      中间会闪一下，正在展开的那一条尤其明显；
   *   3. 附件图标、行内 emoji（flattenEmojiIcons 换成 SVG）全部重建一次；
   *   4. 整个列表的高度在同一个任务里先塌到 0 再涨回去，位置靠 rAF 补，肉眼可见跳动。
   *
   * 现在只把这一条 <article> 换掉：节点数从 O(N) 降到 O(1)，其余消息的 DOM
   * 对象连动画状态都原封不动。光标节点显式复用，动画因此不中断。
   *
   * 返回 false 表示没法就地替换（DOM 与 state 顺序对不上），调用方退回整段重建。
   */
  /**
   * 只重画「还在增长的那一段正文」。
   *
   * 真实故障：用户看到的「已经输出的文字在后续内容继续输出时闪动，像是同一个位置
   * 闪过不一样的文字」。除了半截 markdown 解析出的回退（见 appendInline 的斜体边界），
   * 主因是每一帧都把**整条消息**重新解析、重建全部块：1500 字的回答约 42 块，单帧
   * 就要 20ms 且随长度线性增长，已输出的段落跟着一起被销毁重建，肉眼看到的就是闪。
   *
   * 这里只做一件事：把「最后一次渲染时最后一个块的起始行」之后的内容重新解析，
   * 用它替换尾部，前面的块节点原样留在 DOM 里 —— 文字、行内元素、代码块高亮、
   * emoji 图标、展开状态全都不用重建，也不可能闪。
   *
   * 返回 false 表示这一帧没法增量（字段变了、内容不是纯追加、结构对不上），
   * 调用方退回整条替换。
   */
  function patchGrowingSegment(current) {
    const previous = current.hwchatRender;
    const flow = current.hwchatFlow;
    if (!previous || !flow?.tail?.node?.isConnected) return false;
    // 这一条还是「正在继续处理…」的占位：结构马上要整体换掉，增量不适用。
    if (flow.placeholder) return false;
    const message = state.messages.find((item) => item.id === current.dataset.messageId);
    if (!message) return false;
    const content = message.content || '';
    // 只有「正文纯追加、别的什么都不变」才能增量；其余情况交给整条替换。
    if (!content.startsWith(previous.content)) return false;
    if (content.length === previous.content.length) return false;
    if (previous.reasoning !== (message.reasoning || '')) return false;
    if (previous.status !== (message.status || '')) return false;
    if (previous.skills !== JSON.stringify(message.usedSkills || [])) return false;
    if (previous.usage !== (message.usage?.totalTokens || 0)) return false;
    if (previous.tools !== toolGroupSignature(message)) return false;

    const tailText = content.slice(flow.tailStart).trim();
    if (!tailText) return false;
    const tailNode = flow.tail.node;
    const lastBlock = flow.tail.blocks[flow.tail.blocks.length - 1];
    if (!lastBlock || !lastBlock.node.isConnected) return false;

    /*
     * 最省的一档：这一段最后是一整段普通文字，新来的又只是普通文字 —— 直接追加到
     * 末尾的文本节点上，连重排都不做。
     *
     * 为什么值得单独做一档：重排会把段落里的整个 DOM 重建一遍，里面的文件标签
     * 也是新造的。用户鼠标正停在那颗标签上时，新造的节点要重新进入 :hover、
     * 过渡动画从头跑一遍，看起来就是「鼠标停在已经输出的文字上，那些字也会跳」。
     * 原地追加只改一个文本节点的内容，标签节点、悬停状态、动画都不受影响。
     */
    const appended = content.slice(previous.content.length);
    /*
     * 尾部还有没闭合的 `**` / `~~` / `` ` `` 时不能走原地追加：追加只是把字符贴到
     * 文本节点上，不会重新走遍行内解析，补全也就没机会生效，用户会先看到字面量的
     * `**重点`、等收尾符到了才变粗 —— 仍然是一次可见跳动。
     */
    const tailNeedsRepair = Boolean(streamRepair?.needsRepair?.(tailText));
    /*
     * 上一帧的正文以空白结尾、而画出来的那段并没有这个空白（排版时 `trim()` 掉了），
     * 这一帧又接着写实字 —— 直接追加就会把那个空格永久吃掉（实测：`增长 3.5 倍`
     * 变成 `增长 3.5倍`）。这种帧必须重排一次，让空白重新参与排版。
     */
    const lostTrailingSpace = /[ \t]$/.test(previous.content) && !/[ \t]$/.test(lastBlock.node.textContent || '');
    // 上一帧画的还是占位文案：交给调用方整条重画，别把正文接在占位后面。
    if (!flow.placeholder && !tailNeedsRepair && !lostTrailingSpace && canAppendPlainText(appended, lastBlock.node, tailNode)) {
      appendRawText(lastBlock.node, appended);
      current.hwchatRender = { ...previous, content };
      return true;
    }
    // 从「最后一个块」的起始行重新解析：它可能继续增长，也可能裂成两个块。
    // 只有最后一个块会被替换，它前面的块连节点带文字都不动。
    const fresh = document.createElement('div');
    const freshBlocks = appendRichText(fresh, tailText.split('\n').slice(lastBlock.line).join('\n'), true);
    // 从最后一个块开始往后清掉：一个列表块可能对应多个 <ol>/<ul> 兄弟节点，
    // 所以按 DOM 顺序删，不按 blocks 数量删。
    let node = lastBlock.node;
    while (node) { const after = node.nextElementSibling; node.remove(); node = after; }
    const kept = flow.tail.blocks.filter((block) => block.line < lastBlock.line);
    const appendedBlocks = [];
    for (const block of freshBlocks) { tailNode.append(block.node); appendedBlocks.push({ line: lastBlock.line + block.line, node: block.node }); }
    flow.tail.blocks = kept.concat(appendedBlocks);
    current.hwchatRender = { ...previous, content };
    return true;
  }

  /**
   * 新追加的这一小段能不能直接贴到段落末尾。
   *
   * 判定刻意保守：只要这一小段里出现任何可能**开启或闭合**行内标记、链接、表格、
   * 换行，或者看起来像路径的一小截，就返回 false 让调用方老老实实重排这一段。
   * 重排永远是对的，这个快路径只负责「普通文字」这个绝大多数情况 ——
   * 路径、粗体跨帧这些边界一律走重排，不会因为走快路径而渲染错。
   */
  function canAppendPlainText(appended, blockNode, tailNode) {
    if (!appended) return false;
    // 结构检查：只有「这一段最后一个块、而且就是整段普通文字」才谈得上原地追加。
    if (blockNode.tagName !== 'P') return false;
    if (blockNode.parentNode !== tailNode) return false;
    if (blockNode.nextElementSibling) return false;
    /*
     * 末尾必须已经是一个文本节点。
     *
     * 否则新来的字有可能属于上一个行内元素：正文写到 `src/app/App.ts` 时那半截
     * 已经被认成文件标签，接着来的 `x` 应该在标签**里面**（`App.tsx`），而不是
     * 贴在标签后面变成散字。末尾是元素时一律重排，让这段文字重新参与行内解析；
     * 重排过一次之后末尾就有文本节点了，后面的普通文字照旧走快路径。
     */
    if (!blockNode.lastChild || blockNode.lastChild.nodeType !== 3) return false;
    // 文字层面的判定交给纯函数（media/inline-append.js），自带单测。
    if (!inlineAppend) return false;
    return inlineAppend.canAppendPlainText(appended, (blockNode.textContent || '').slice(-8));
  }

  /** 把纯文字贴到块的末尾：优先并入最后一个文本节点，避免多出一层空 span。 */
  function appendRawText(blockNode, text) {
    const last = blockNode.lastChild;
    if (last && last.nodeType === 3) { last.appendData(text); return; }
    blockNode.append(document.createTextNode(text));
  }

  /**
   * 工具调用的结构签名：任何一项变化都会影响正文分段，增量就不安全了。
   *
   * 注意必须把「当前正文长度下算出的分组」也纳入签名。工具块的位置是
   * `min(contentOffset, text.length)`：正文还没写到那个位置时，工具块只能贴在末尾，
   * 随着正文增长它会跳回中间。只看工具自身字段的话，这种「分组变了」会被漏掉，
   * 增量更新就会把正文一直追加到错误的段里（实测：块数 2，整条渲染是 5）。
   */
  function toolGroupSignature(message) {
    const tools = message.toolExecutions || [];
    const groups = groupToolsByOffset(tools, (message.content || '').length);
    return JSON.stringify([
      tools.map((tool) => [tool.callId, tool.status, tool.summary, tool.contentOffset, tool.output, tool.finishedAt]),
      /*
       * 分组签名只回答「工具归属于哪一段正文之后」，**不**回答「因为正文还没写到，
       * 它现在临时贴在末尾的哪个字符位置」。
       *
       * 后者是 `min(contentOffset, 正文长度)` 的结果，正文每长一个字它就变一次；
       * 把它算进签名，就等于每一帧都宣布「结构变了」→ 每一帧整条消息重排 →
       * 悬停高亮被销毁重建（颜色一闪一闪）、点击落在正要被替换的节点上（点不动）。
       * 实测：20 帧里 tool-execution 节点被换掉 19 次，hover 状态 119 帧里丢 117 帧。
       *
       * 抹平成 `pending` 之后，只有两种情况会真的变：工具集合/状态变化，
       * 或者正文终于写到那个位置（pending → 真实 offset，一次真实的重排）。
       */
      groups ? groups.map((group) => [group.pending ? 'pending' : group.offset, group.tools.map((tool) => tool.callId)]) : null,
    ]);
  }

  /** 记下这一帧的渲染快照，下一帧据此判断能不能增量。 */
  function rememberRender(article, message) {
    article.hwchatRender = {
      content: message.content || '',
      reasoning: message.reasoning || '',
      status: message.status || '',
      skills: JSON.stringify(message.usedSkills || []),
      usage: message.usage?.totalTokens || 0,
      tools: toolGroupSignature(message),
    };
  }

  function patchMessage(messageId) {
    const index = state.messages.findIndex((item) => item.id === messageId);
    if (index < 0) return false;
    const current = elements.messageList.children[index];
    // 顺序对不上时不能按索引换：会换错那一条。宁可整段重建一次。
    if (!current || current.dataset.messageId !== messageId) return false;
    // 快路径：只动还在增长的那一段，已输出的块一个节点都不重建。
    if (patchGrowingSegment(current)) {
      renderedMessageSignature = messageListSignature(state.messages, state.conversation?.id);
      keepViewportAfterPatch();
      return true;
    }
    // 只抓这一条里的展开状态，别的消息根本没动。
    const detailOverrides = captureDetailOverrides(current);
    const liveCursor = current.querySelector('.stream-cursor');
    const next = renderMessage(state.messages[index]);
    // 复用原光标节点：新造一个会让 blink 动画从头开始，视觉上就是「一闪」。
    const freshCursor = next.querySelector('.stream-cursor');
    if (liveCursor && freshCursor) freshCursor.replaceWith(liveCursor);
    restoreDetailOverrides(detailOverrides, next);
    const viewport = elements.messageViewport;
    const previousTop = viewport.scrollTop;
    state.renderingMessages = true;
    current.replaceWith(next);
    rememberRender(next, state.messages[index]);
    renderedMessageSignature = messageListSignature(state.messages, state.conversation?.id);
    requestAnimationFrame(() => {
      // 变的都是最后一条：跟着底部就贴底；用户翻上去看了就一点不动。
      if (state.autoFollow) viewport.scrollTop = viewport.scrollHeight;
      else viewport.scrollTop = previousTop;
      state.renderingMessages = false;
      updateScrollToBottom();
    });
    return true;
  }

  /** 增量更新之后同样要跟住滚动，语义与整条替换那条路径保持一致。 */
  function keepViewportAfterPatch() {
    const viewport = elements.messageViewport;
    const previousTop = viewport.scrollTop;
    requestAnimationFrame(() => {
      if (state.autoFollow) viewport.scrollTop = viewport.scrollHeight;
      else viewport.scrollTop = previousTop;
      updateScrollToBottom();
    });
  }

  /**
   * 攒 70ms 再画一次（同一条消息的多个 delta 合成一次）。
   *
   * 时间到了先试局部替换；替换不了、或者用户正在选字（动 DOM 会把选区弄丢，
   * 而选区丢了就没法复制），才退到整段重建。
   */
  function scheduleMessagePatch(messageId) {
    pendingPatchId = messageId;
    if (state.renderTimer) return;
    state.renderTimer = setTimeout(runPendingMessageRender, 70);
  }

  function runPendingMessageRender() {
    state.renderTimer = null;
    const messageId = pendingPatchId;
    pendingPatchId = null;
    if (selectingMessageText || interactingWithMessages || hasMessageSelection()) {
      // 用户在选字/拖动：这一轮不碰 DOM，交互结束时补一次整段重建（选区优先）。
      deferMessageRender('keep');
      return;
    }
    if (messageId && patchMessage(messageId)) return;
    renderMessages('keep');
  }

  /** 用户交互结束后补做被推迟的渲染。
   *
   * `afterClick` 的由来（真实故障，2026-10-30 用户报「编辑这条按钮还是不灵敏」）：
   *
   * 浏览器把一次点击拆成 `pointerdown` → `pointerup` → `click`，**同一个任务**里依次派发。
   * 而 `click` 只在「按下目标与松开目标仍有共同祖先」时才派发；按下那个节点一旦被移除，
   * Chromium 实测**连 click 都不发**（只有 mouseup 落到被重排后的空白处）。
   *
   * 原来的代码在 `pointerup` 里**同步**跑 `flushDeferredMessageRender()`，而它就是
   * `elements.messageList.replaceChildren()` 整段重建。于是只要 agent 正在流式输出
   * （渲染被 defer 了），松手的一瞬间按钮先被销毁，浏览器随即放弃派发 click ——
   * 用户看到的就是「点了没反应」，而且**只在 agent 跑的时候才这样**，静态时正常。
   *
   * 所以从 `pointerup` 走这条路时必须把重排推到下一个任务：先让 click 落地（按钮还在），
   * 再重建列表。这不是乐观猜测，是照规范里 click 的合成条件做的顺序安排。
   */
  function releaseMessageInteraction(options) {
    clearTimeout(interactionTimer);
    interactionTimer = null;
    if (!interactingWithMessages && !selectingMessageText) return;
    interactingWithMessages = false;
    selectingMessageText = false;
    if (options && options.afterClick) {
      setTimeout(flushDeferredMessageRender, 0);
      return;
    }
    flushDeferredMessageRender();
  }

  function flushDeferredMessageRender() {
    if (interactingWithMessages || hasMessageSelection() || !deferredMessageRenderMode) return;
    const mode = deferredMessageRenderMode;
    deferredMessageRenderMode = null;
    renderMessages(mode);
  }

  /**
   * 读取当前 DOM 中“与默认状态不同”的展开状态。
   *
   * `root` 默认整段列表（整段重建时用）；局部替换时传那一条 <article>，
   * 只比对真正要重建的那部分，别的消息的 <details> 根本没被碰过。
   */
  function captureDetailOverrides(root = elements.messageList) {
    const overrides = new Map();
    for (const details of root.querySelectorAll('details[data-detail-key]')) {
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
  function restoreDetailOverrides(overrides, root = elements.messageList) {
    if (!overrides.size) return;
    for (const details of root.querySelectorAll('details[data-detail-key]')) {
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
      const statusCell = textElement('span', 'task-node-status', '');
      statusCell.append(iconNode(taskStatusIconName(node.status)));
      const titleCell = textElement('span', 'task-node-title', node.title);
      // 还没执行的节点在这里不给编辑（只有一行，长内容看不清），入口在消息气泡里。
      if (node.pending) titleCell.title = t('taskQueue.editInBubble');
      const actions = taskNodeActions(node);
      row.append(statusCell, titleCell, actions || textElement('small', '', taskStatusLabel(node.status)));
      elements.taskTreeList.append(row);
    }
  }

  /**
   * 任务树节点的行内操作。
   *
   * **排队中**只留「删除」：改文字要用多行编辑框看全文，编辑入口在消息气泡里。
   * **执行中**什么都不给——这是本次修的缺陷：agent 已经把这句话读走并在执行，
   * 后端也改不了那条 request（`editPending` 返回 false），于是「编辑」实际会走
   * 「把改过的内容当成新消息再发一遍」，同一件事被排队做第二次。
   * **已完成**保留「编辑」：历史不改写，改完作为一条新消息发出；编辑框同样开在
   * 气泡里（任务树一行看不全长内容）。
   */
  function taskNodeActions(node) {
    if (!node.userMessageId) return null;
    if (node.pending) {
      const actions = document.createElement('span'); actions.className = 'task-node-actions';
      const remove = textElement('button', 'task-node-action is-danger', t('taskQueue.remove'));
      remove.type = 'button';
      remove.title = t('taskQueue.removeHint');
      remove.addEventListener('click', (event) => { event.stopPropagation(); post('removeTaskMessage', { nodeId: node.id }); });
      actions.append(remove);
      return actions;
    }
    if (node.status !== 'complete') return null;
    const actions = document.createElement('span'); actions.className = 'task-node-actions';
    const edit = textElement('button', 'task-node-action', t('taskQueue.edit'));
    edit.type = 'button';
    edit.title = t('taskQueue.editExecutedHint');
    edit.addEventListener('click', (event) => { event.stopPropagation(); beginResendEdit(node); });
    actions.append(edit);
    return actions;
  }

  /**
   * 打开气泡编辑（「改完作为新消息发出」模式）。
   *
   * 入口在任务树，编辑界面在气泡：任务树一行放不下长内容，而这条消息本身就在
   * 气泡里，整条宽度都能用。
   */
  function beginResendEdit(node) {
    const message = state.messages.find((item) => item.id === node.userMessageId);
    if (!message) { showToast(t('taskQueue.editExpired'), 'warning'); return; }
    openMessageEditor(message, node, 'resend');
  }

  /** 任务树节点的状态 → 图标名（形状定义见 media/ui-icons.js）。 */
  function taskStatusIconName(status) { return status === 'complete' ? 'check' : status === 'active' ? 'dot' : status === 'routing' ? 'ellipsis' : status === 'merged' ? 'turn' : status === 'queued' ? 'ring' : 'minus'; }
  function taskStatusLabel(status) { return ({ active: t('chat.taskStatus.active'), routing: t('chat.taskStatus.routing'), merged: t('chat.taskStatus.merged'), queued: t('chat.taskStatus.queued'), complete: t('chat.taskStatus.complete'), cancelled: t('chat.taskStatus.cancelled'), error: t('chat.taskStatus.error') })[status] || status; }

  /**
   * 面板区（任务树 / 任务清单 / 归档快照）的互斥展开。
   *
   * 起因：三个 <details> 都能同时展开，内容一多就把输入框顶到窗口外；
   * 而且点开底下胶囊里的归档清单时，上面「正在跑的」任务树和任务清单还占着版面，
   * 看起来像两份清单同时在动。
   *
   * 现在的规则（对应需求）：
   * - 同一时刻只展开一个面板：点开胶囊里的归档清单 → 另外两个收起、并锁住不让展开；
   * - 归档清单被收起（点它自己的标题栏）或再次点同一颗胶囊 → 解锁，并还原进入前的展开状态；
   * - 点另一颗胶囊 → 直接换到那份归档清单，仍然只有一个面板展开。
   */
  function isArchiveFocused() { return Boolean(state.expandedArchiveId); }

  /** 锁住的任务树 / 任务清单：加 class 让 summary 变暗、光标显示不可点（提示见 togglePanel）。 */
  function syncPanelLock() {
    const locked = isArchiveFocused();
    for (const key of ['taskTree', 'todoPanel']) {
      const panel = elements[key];
      if (!panel) continue;
      panel.classList.toggle('panel-locked', locked);
      if (locked) panel.setAttribute('aria-disabled', 'true');
      else panel.removeAttribute('aria-disabled');
    }
  }

  /** 收起另外两个面板，并记住它们原本的展开状态（退出聚焦时还原，不吞掉用户原来的视图）。 */
  function collapsePeers() {
    if (!state.archiveRestore) {
      state.archiveRestore = { taskTree: Boolean(elements.taskTree.open), todoPanel: Boolean(elements.todoPanel.open) };
    }
    elements.taskTree.open = false;
    elements.todoPanel.open = false;
    syncPanelLock();
  }

  function enterArchiveFocus(archiveId) {
    if (!archiveId) { exitArchiveFocus(); return; }
    collapsePeers();
    state.expandedArchiveId = archiveId;
    renderArchivePanel();
    renderTodoArchives();
    // 只在真正展开的那一刻滚一次：renderAll 会反复调用 renderArchivePanel，
    // 每次都滚会把用户正在看的位置拽走。
    elements.todoArchivePanel.scrollIntoView({ block: 'nearest' });
  }

  function exitArchiveFocus() {
    const restore = state.archiveRestore;
    const hadFocus = Boolean(state.expandedArchiveId);
    state.expandedArchiveId = null;
    state.archiveRestore = null;
    elements.todoArchivePanel.open = false;
    syncPanelLock();
    renderArchivePanel();
    renderTodoArchives();
    if (!hadFocus || !restore) return;
    if (restore.taskTree && !elements.taskTree.hidden) elements.taskTree.open = true;
    if (restore.todoPanel && !elements.todoPanel.hidden) elements.todoPanel.open = true;
  }

  /**
   * 点面板标题栏（鼠标与键盘触发的都是 click）时的唯一入口。
   *
   * 一律 preventDefault 再自己设 open：`<details>` 的默认行为是先改状态再派发 toggle，
   * 那样就没法在「锁住」的情况下拦住它（比如防止任务树被顶开）。
   */
  function togglePanel(key, panel) {
    const plan = todoPanelState.planPanelToggle({ panel: key, open: !panel.open, archiveFocused: isArchiveFocused() });
    if (!plan.allowed) {
      showToast(t('todo.archive.lockedHint'), 'warning');
      return;
    }
    if (key === 'todoArchivePanel') {
      if (!plan.open) { exitArchiveFocus(); return; }
      collapsePeers();
      panel.open = true;
      return;
    }
    panel.open = plan.open;
  }

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
    // 面板是 <details>，展开状态会被浏览器记住；这里判断「是不是换了一份新清单」，
    // 是的话强制展开，免得上一份被收起后新任务看起来像没出现。
    const signature = todoPanelState.todoSignature(todos);
    const reveal = todoPanelState.shouldRevealTodoPanel({ signature, previousSignature: state.todoSignature, archiveFocused: isArchiveFocused() });
    state.todoSignature = signature;
    elements.todoPanel.hidden = !todos.length;
    if (!todos.length) {
      elements.todoPanel.classList.remove('interrupted');
      elements.todoPanel.classList.remove('incomplete');
      elements.todoList.replaceChildren();
      if (elements.todoSummary) elements.todoSummary.textContent = '';
      syncTodoSummaryActions(false);
      return;
    }
    // 胶囊聚焦期间清单必须保持收起：它是被锁住的两个面板之一。
    if (isArchiveFocused()) elements.todoPanel.open = false;
    if (reveal) elements.todoPanel.open = true;
    const done = todos.filter((todo) => todo.status === 'completed').length;
    // 清单没全绿时有两种来源，标题上要分开说：
    // - 被停止 / 报错 → 「已中断」：工作被打断了；
    // - Agent 正常跑完、只是模型漏了给最后一项打勾 → 「未完成」：别让用户误以为被腰斩。
    // 两者都会把「执行中」降级成待办（后端已做），这里只补文字标记，不引入第四种状态。
    const interrupted = Boolean(state.todosInterrupted);
    const incomplete = !interrupted && Boolean(state.todosIncomplete);
    elements.todoPanel.classList.toggle('interrupted', interrupted);
    elements.todoPanel.classList.toggle('incomplete', incomplete);
    if (elements.todoSummary) {
      const progress = t('todo.progress', { done, total: todos.length });
      const suffix = interrupted ? ` · ${t('todo.interrupted')}` : incomplete ? ` · ${t('todo.incomplete')}` : '';
      elements.todoSummary.textContent = `${progress}${suffix}`;
    }
    renderTodoItems(elements.todoList, todos);
    // 「继续执行 / 取消任务」只在清单停在半路时出现：全部打勾的清单会被后端归档、
    // 面板本身就消失了；运行中的清单要停就走输入框旁的停止按钮，不需要这两个。
    syncTodoSummaryActions(Boolean(state.todosInterrupted || state.todosIncomplete) && !state.streaming);
  }

  /**
   * 顶栏两个动作按钮的显隐。
   *
   * 动作区整体 `hidden` 而不是逐个按钮隐藏：这样清单状态文字不会因为一个隐藏的容器
   * 多保留一段空白，左对齐的固定宽度区才站得住。
   */
  function syncTodoSummaryActions(visible) {
    if (elements.todoSummaryActions) elements.todoSummaryActions.hidden = !visible;
    if (elements.resumeTodosButton) elements.resumeTodosButton.hidden = !visible;
    if (elements.cancelTodosButton) elements.cancelTodosButton.hidden = !visible;
  }

  /** 归档快照面板：只有点开胶囊时才出现，标题与汇总都标出「已归档」。 */
  function renderArchivePanel() {
    const archive = state.expandedArchiveId ? state.todoArchives.find((item) => item.id === state.expandedArchiveId) : null;
    elements.todoArchivePanel.hidden = !archive;
    if (!archive) {
      elements.todoArchivePanel.open = false;
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
    // 面板和胶囊是同一个状态：有展开的归档，面板就必须是展开的。
    elements.todoArchivePanel.open = true;
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
      } else {
        // 已完成是勾、待办是空心圆，两者都来自同一套 SVG：
        // 以前勾是字体字符、圆圈是 CSS 边框，两者的粗细和大小没法统一。
        statusNode.append(iconNode(status === 'completed' ? 'check' : 'ring'));
      }

      item.append(order, content, statusNode);
      list.append(item);
    });
  }

  /**
   * 归档胶囊栏。
   *
   * 规则（对应需求）：
   * - 每份完成的清单是一颗纯色圆角矩形，颜色由扩展按「越新越深」算好（浅蓝 → 深蓝，相邻两颗连续过渡）；
   * - 胶囊内不含任何图标或文字，也不挂 title 悬停提示：颜色深浅和左右顺序就是全部信息；
   * - 永远不换行，保持 3:1 的固定尺寸；超出栏宽时横向滚动；
   * - 点一颗胶囊展开/收起那份清单：展开中的那颗显示红色边框，鼠标悬停的那颗显示浅红色边框
   *   （边框用内阴影画，不改变胶囊尺寸，见 media/chat.css）。
   */
  // 初始高度 10.67px = 原来 16px 的 2/3（胶囊只是一条颜色提示，不需要那么厚）。
  // 宽高比固定 3:1，所以宽度跟着从 48px 变成 32px。
  const CAPSULE_BASE_HEIGHT = (16 * 2) / 3;
  const CAPSULE_RATIO = 3;
  /** 上一次渲染的归档条数：只用来判断「是不是又完成了一份新的」。 */
  let lastArchiveCount = 0;

  function renderTodoArchives() {
    const archives = Array.isArray(state.todoArchives) ? state.todoArchives : [];
    // 归档数变多 = 末尾补上了一份新的。它排在整条栏的最右端，
    // 栏窄到需要横向滚动时正好落在视野之外，所以下面要跟过去一次。
    const grew = archives.length > lastArchiveCount;
    lastArchiveCount = archives.length;
    // 被展开的那份归档没了（对话被清理、删档、切换对话）：立刻退出聚焦，
    // 否则任务树和任务清单会一直锁着，用户看不到正在跑的那份。
    if (state.expandedArchiveId && !archives.some((item) => item.id === state.expandedArchiveId)) {
      state.expandedArchiveId = null;
      state.archiveRestore = null;
      elements.todoArchivePanel.open = false;
      renderArchivePanel();
    }
    syncPanelLock();
    elements.todoArchiveBar.hidden = !archives.length;
    elements.todoArchiveBar.replaceChildren();
    if (!archives.length) return;
    archives.forEach((archive) => {
      const capsule = document.createElement('button');
      capsule.type = 'button';
      capsule.className = 'todo-capsule';
      capsule.dataset.archiveId = archive.id;
      capsule.style.backgroundColor = archive.color;
      const active = state.expandedArchiveId === archive.id;
      capsule.classList.toggle('active', active);
      capsule.setAttribute('aria-expanded', active ? 'true' : 'false');
      // 只留无障碍名称（读屏用），不设 title —— 鼠标悬停不再弹出任何内容。
      const label = t('todo.archive.capsule', { done: archive.completed, total: archive.total });
      capsule.setAttribute('aria-label', `${label}。${active ? t('todo.archive.hintOpen') : t('todo.archive.hint')}`);
      // 点同一颗 = 收起并解锁；点另一颗 = 换成那份，仍然只有一个面板展开。
      capsule.addEventListener('click', () => {
        // 按住拖动松手时浏览器补发的那个 click 不算点击，否则拖一下就多展开一个面板。
        if (consumeArchiveDragClick()) return;
        const nextId = todoPanelState.nextArchiveFocus({ currentId: state.expandedArchiveId, clickedId: archive.id });
        if (nextId) enterArchiveFocus(nextId);
        else exitArchiveFocus();
      });
      elements.todoArchiveBar.append(capsule);
    });
    layoutTodoArchives();
    // 只在「多了一份」时跟到末尾：展开/收起、切换对话、重载都会重渲染，
    // 每次都跳回最右会把用户自己往回滚的位置抢走。scrollWidth 由浏览器夹到
    // 真正的上限（stop 在 max = scrollWidth - clientWidth），放得下时等于没动。
    if (grew) elements.todoArchiveBar.scrollLeft = elements.todoArchiveBar.scrollWidth;
  }

  /**
   * 固定胶囊尺寸：宽 = 3 × 高，间距 = 0.25 × 高。
   * 超出可视宽度的部分由归档栏横向滚动访问。
   */
  function layoutTodoArchives() {
    const bar = elements.todoArchiveBar;
    if (!bar || bar.hidden) return;
    const height = CAPSULE_BASE_HEIGHT;
    bar.style.setProperty('--capsule-h', `${height.toFixed(2)}px`);
    bar.style.setProperty('--capsule-w', `${(height * CAPSULE_RATIO).toFixed(2)}px`);
    bar.style.setProperty('--capsule-gap', `${(height * 0.25).toFixed(2)}px`);
    // 圆角矩形：半径跟着高度缩放（不是 999px 的整圆胶囊）。
    bar.style.setProperty('--capsule-radius', `${todoPanelState.capsuleRadius(height)}px`);
  }

  /**
   * 按住鼠标横向拖动胶囊栏。
   *
   * 为什么需要它：滚动条已经隐藏（见 media/chat.css），滚轮是最快的一种滚法，
   * 但触控板用户和习惯拖拽的人会本能地按住内容往左拉 —— 没有拖动就成了「滚不动」。
   *
   * 拖动结束后浏览器仍会补发一个 click，落在胶囊上就会把「拖一下」当成「点这一颗」，
   * 于是拖完莫名多展开一个面板。所以位移超过阈值时在栏的 dataset 上打一个一次性标记，
   * 由 consumeArchiveDragClick 把这个 click 吞掉。
   */
  function bindTodoArchiveDrag(bar) {
    if (!bar) return;
    // 起点抖动不算拖动：按下时手总会晃几像素，没超过这个距离仍按「点击胶囊」处理。
    const DRAG_THRESHOLD = 3;
    let pointerId = null;
    let startX = 0;
    let startScrollLeft = 0;
    // 是否已经捕获指针（只有真的拖起来之后才捕获，见下面 pointermove）。
    let captured = false;
    bar.addEventListener('pointerdown', (event) => {
      // 触摸屏交给浏览器原生滚动（带惯性、能甩），这里只接管鼠标和触控笔。
      if (event.pointerType === 'touch' || event.button !== 0) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startScrollLeft = bar.scrollLeft;
      captured = false;
      // 每次按下先清掉上一次的吞点击标记：拖到栏内空白处松手不会有 click 来清它，
      // 留着会让下一次正常点击白白失效。
      delete bar.dataset.dragMoved;
    });
    bar.addEventListener('pointermove', (event) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      if (bar.dataset.dragMoved !== '1' && Math.abs(dx) < DRAG_THRESHOLD) return;
      bar.dataset.dragMoved = '1';
      bar.classList.add('dragging');
      // 确认是拖动之后才捕获指针，而不是按下就捕获：捕获会把后续的事件（包括 click）
      // 改派给栏本身，胶囊就再也收不到点击了。轻微抖动（不是拖动）不该让点击失效。
      if (!captured && typeof bar.setPointerCapture === 'function') {
        captured = true;
        bar.setPointerCapture(event.pointerId);
      }
      // 手往左拖 = 内容跟着往左走 = scrollLeft 增大，所以是「起点位置 − 位移」。
      // 从按下时的位置算，拖动过程中不会因为每次赋值而累积误差；越界由浏览器自己夹住。
      bar.scrollLeft = startScrollLeft - dx;
      event.preventDefault();
    });
    const release = (event) => {
      if (pointerId === null) return;
      if (event && event.pointerId !== undefined && event.pointerId !== pointerId) return;
      pointerId = null;
      bar.classList.remove('dragging');
      if (captured && typeof bar.releasePointerCapture === 'function'
        && typeof bar.hasPointerCapture === 'function'
        && event && event.pointerId !== undefined && bar.hasPointerCapture(event.pointerId)) {
        captured = false;
        bar.releasePointerCapture(event.pointerId);
      }
    };
    bar.addEventListener('pointerup', release);
    bar.addEventListener('pointercancel', release);
    // 兜底：指针在窗口外松开时可能收不到 up，失去捕获后一律当作已松手，别卡在拖动状态。
    bar.addEventListener('lostpointercapture', release);
  }

  /**
   * 拖动结束后的那个 click 要吞掉。
   *
   * 标记存在归档栏的 dataset 上、读到即清，所以只有紧跟拖动的那一次点击被吃掉；
   * 正常点击（按下没移动）根本不会留下标记。
   */
  function consumeArchiveDragClick() {
    const bar = elements.todoArchiveBar;
    if (!bar || bar.dataset.dragMoved !== '1') return false;
    delete bar.dataset.dragMoved;
    return true;
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

  /**
   * 这条用户消息对应的任务节点（**不区分**是否已执行）。
   *
   * 用 `userMessageId` 对应，不用标题/顺序去猜：标题是截断过的，顺序会随排队变化。
   * 传入 `nodes` 而不是直接读 `state`，是为了让这条判定能脱离界面单独验证。
   */
  function taskNodeForMessage(nodes, messageId) {
    if (!messageId) return null;
    return (nodes || []).find((node) => node.userMessageId === messageId) || null;
  }

  /**
   * 这条用户消息是不是「还没被执行」——只有这种能原地改。
   *
   * 判断依据是队列状态 `pending`（队列还持有那条 request），不是消息状态：消息写进
   * 存档时就是 complete，从状态上看不出它排没排队。
   */
  function pendingTaskForBubble(nodes, messageId) {
    const node = taskNodeForMessage(nodes, messageId);
    return node && node.pending ? node : null;
  }

  /** 当前所有「排队中」节点的用户消息 id：用来判断气泡里的编辑入口要不要重画。 */
  function pendingBubbleMessageIds(nodes) {
    return (nodes || []).filter((node) => node.pending && node.userMessageId).map((node) => node.userMessageId).sort();
  }

  function renderMessage(message) {
    const article = document.createElement('article');
    article.className = `message ${message.role}${message.status === 'error' ? ' error' : ''}`; article.dataset.messageId = message.id;
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const author = textElement('span', '', message.role === 'user' ? t('chat.you') : 'HWChat');
    const time = textElement('time', '', formatTime(message.createdAt)); time.dateTime = new Date(message.createdAt).toISOString(); meta.append(author, time);
    if (message.content) {
      const copy = textElement('button', 'message-copy-button', t('common.copy')); copy.type = 'button'; copy.title = t('chat.copyMessage');
      copy.addEventListener('click', () => { void copyMessage(copy, message); });
      meta.append(copy);
    }
    const body = document.createElement('div'); body.className = 'message-body';
    const attached = [message.context, ...(message.attachments || [])].filter(Boolean);
    if (attached.length) body.append(renderMessageAttachments(attached));
    if (message.usedSkills?.length) body.append(renderSkillUsage(message.usedSkills));
    if (message.reasoning) body.append(renderReasoning(message.reasoning, message.status === 'streaming'));
    const flow = appendMessageFlow(body, message);
    // 用户消息太长就折叠：只留开头几行 + 渐隐 + 「展开全文」。
    if (message.role === 'user' && flow?.tail?.node) attachUserMessageClamp(flow.tail.node, message);
    // 每条用户消息都带执行状态徽标（还没执行 / 执行中 / 已执行 / 已跳过）。
    if (message.role === 'user') {
      const execution = renderExecutionRow(message);
      if (execution) body.append(execution);
    }
    // 用户自己贴进来的明文凭据：在界面层直接认出来，不等模型提醒。
    // 放在消息正文之后，顺序上与「你说的话 → 系统的警告」一致。
    if (message.role === 'user') {
      const warning = secretWarningNode(message.content || '');
      if (warning) body.append(warning);
    }
    // 只换助手的输出：用户自己打的 emoji 是他输入的内容，不该被我们改写。
    if (message.role !== 'user') flattenEmojiIcons(body);
    if (message.status === 'streaming') { const cursor = document.createElement('span'); cursor.className = 'stream-cursor'; cursor.setAttribute('aria-label', t('chat.generating')); body.append(cursor); }
    if (message.usage?.totalTokens) body.append(textElement('div', 'message-usage', `${formatMillionTokens(message.usage.totalTokens)} tokens`));
    article.append(meta, body);
    // 流式增量更新要靠这份定位信息：正文最后一段的源起点 + 里面每个块的起始行。
    article.hwchatFlow = flow;
    return article;
  }

  /**
   * 用户消息的执行状态徽标：还没执行 / 执行中 / 已执行 / 已跳过。
   *
   * 为什么要给**每一条**用户消息都画：一次运行里可能排了七八条消息，中途中断、
   * 之后再点「继续」，光看气泡根本分不清哪条跑过、哪条被跳过 —— 而漏掉一条任务
   * 往往就是这样发生的。状态存在消息本身（`message.executionStatus`），所以运行结束、
   * 切对话、重启之后都还在。
   *
   * 没有这个字段的老消息不画徽标：认不出状态就不猜，写成「已执行」会让人以为跑过了。
   */
  const EXECUTION_STATUSES = ['pending', 'running', 'done', 'skipped'];

  function executionStatusOf(message) {
    const status = message?.executionStatus;
    return typeof status === 'string' && EXECUTION_STATUSES.includes(status) ? status : null;
  }

  function renderExecutionRow(message) {
    const status = executionStatusOf(message);
    if (!status) return null;
    const row = document.createElement('div'); row.className = 'message-execution';
    const badge = textElement('span', `message-execution-badge is-${status}`, t(`chat.execution.${status}`));
    badge.title = t(`chat.execution.${status}.hint`);
    badge.setAttribute('data-execution-status', status);
    row.append(badge);
    // 编辑入口只在「还没执行」时给：队列还持有它，改完下一轮直接读新内容。
    const node = status === 'pending' ? pendingTaskForBubble(state.taskTree?.nodes, message.id) : null;
    if (node) {
      const edit = textElement('button', 'message-execution-edit', t('chat.editMessage'));
      edit.type = 'button';
      edit.title = t('chat.editMessageHint');
      // 稳定标识：按钮所在的消息 id。流式重排会把按钮换掉（pointerdown 之后换掉就
      // 不会派发 click），所以 pointerup 兜底要靠它重新找回那条消息。
      edit.dataset.editMessage = message.id;
      edit.dataset.editNode = node.id;
      edit.addEventListener('click', () => {
        // 指针路径已经处理过这次点击 → 吞掉，避免重复打开（见 consumeEditClick）。
        if (consumeEditClick(message.id)) return;
        openMessageEditor(message, node);
      });
      row.append(edit);
    }
    return row;
  }

  /**
   * 打开悬浮编辑框。
   *
   * 需求（用户原话）：「点击编辑后显示编辑界面在新的层级显示，比如显示一个悬浮编辑窗口，
   * 不被 agent 运行输出内容影响，更改内容会影响输入框气泡内容。编辑结束之前，如果 agent
   * 刚好运行到这个正在编辑的消息，会暂停等待，修改完，编辑框消失，才会读取更新后的
   * 消息内容继续执行。」
   *
   * 三件事一起解决：
   *  1. **不被重绘影响**：编辑框在 `#messageList` 之外（`#messageEditor`），流式输出重排
   *     消息列表时它一个节点都不会被碰到；
   *  2. **保存后同步气泡**：后端回推 `messageUpdated`，气泡内容跟着换；
   *  3. **agent 会等**：打开时先发 `beginEditTaskMessage`，后端在任务队列上挂闸门，
   *     agent 取到这条任务时会停住，直到保存 / 取消（或 5 分钟超时）。
   */
  const MESSAGE_EDITOR_IDS = ['messageEditor', 'messageEditorInput', 'messageEditorState', 'messageEditorHint', 'messageEditorSave', 'messageEditorCancel', 'messageEditorTitle'];

  function openMessageEditor(message, node, mode = 'inPlace') {
    const editor = elements.messageEditor;
    if (!editor) return;
    editingBubbleMessageId = message.id;
    editingBubbleTaskId = node?.id || null;
    editingBubbleDraft = message.content || '';
    editingBubbleMode = mode === 'resend' ? 'resend' : 'inPlace';
    elements.messageEditorTitle.textContent = mode === 'resend' ? t('chat.editResend') : t('chat.editMessage');
    elements.messageEditorHint.textContent = mode === 'resend' ? t('chat.editResendHint') : t('chat.editMessageKeys');
    elements.messageEditorInput.value = editingBubbleDraft;
    // 只有「还在队列里」的那条才会让 agent 停下来等；已执行的只是重发，不需要闸门。
    elements.messageEditorState.textContent = '';
    editor.hidden = false;
    editor.classList.toggle('is-resend', mode === 'resend');
    document.body.classList.add('editor-open');
    if (node && mode !== 'resend') {
      post('beginEditTaskMessage', { nodeId: node.id });
    }
    growMessageEditor();
    syncMessageEditorState();
    requestAnimationFrame(() => {
      const input = elements.messageEditorInput;
      if (!input || typeof input.focus !== 'function') return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  /** 编辑框最多长到多高，再长就自己滚（再高会把对话顶出视野）。 */
  const MESSAGE_EDIT_MAX_HEIGHT = 420;

  function growMessageEditor() {
    const input = elements.messageEditorInput;
    if (!input) return;
    input.style.height = 'auto';
    const next = Math.min(input.scrollHeight || 0, MESSAGE_EDIT_MAX_HEIGHT);
    input.style.height = next ? `${next}px` : '';
  }

  /** 关掉浮层：保存与取消共用，差别只在有没有发编辑请求。 */
  function closeMessageEditor() {
    const editor = elements.messageEditor;
    const nodeId = editingBubbleTaskId;
    const wasPending = editingBubbleMode !== 'resend';
    editingBubbleMessageId = null;
    editingBubbleTaskId = null;
    editingBubbleDraft = '';
    editingBubbleMode = 'inPlace';
    if (editor) { editor.hidden = true; editor.classList.remove('is-resend'); }
    document.body.classList.remove('editor-open');
    // 取消 / 保存后关闭：都要放行闸门，否则 agent 会一直等这条。
    if (nodeId && wasPending) post('cancelEditTaskMessage', { nodeId });
    flushDeferredMessageRender();
  }

  /**
   * 浮层标题右侧的状态：agent 是否已经走到这条、正停着等用户改完。
   *
   * 这一条是**后端**的真实状态（`waitingForEdit`），不是界面猜的：
   * 队列在 `take()` 里等闸门时才会置位，所以显示「正在等你改完」就一定真的停住了。
   */
  function syncMessageEditorState() {
    const label = elements.messageEditorState;
    if (!label) return;
    const nodeId = editingBubbleTaskId;
    if (!nodeId) { label.textContent = ''; label.dataset.state = ''; return; }
    const node = (state.taskTree?.nodes || []).find((item) => item.id === nodeId);
    if (node?.waitingForEdit) {
      label.textContent = t('chat.editorAgentWaiting');
      label.dataset.state = 'waiting';
      elements.messageEditorHint.textContent = t('chat.editorAgentWaitingHint');
      return;
    }
    label.dataset.state = '';
    label.textContent = editingBubbleMode === 'resend' ? '' : t('chat.editorAgentWillWait');
    elements.messageEditorHint.textContent = editingBubbleMode === 'resend' ? t('chat.editResendHint') : t('chat.editMessageKeys');
  }

  function saveMessageEditor() {
    const text = elements.messageEditorInput ? String(elements.messageEditorInput.value || '').trim() : '';
    const nodeId = editingBubbleTaskId;
    const messageId = editingBubbleMessageId;
    const live = state.messages.find((item) => item.id === messageId);
    const changed = Boolean(text) && text !== (live?.content || '');
    if (!text) {
      // 空内容不保存：提示一下，编辑框留着，别让用户以为改没了。
      showToast(t('taskQueue.saveEmpty'), 'warning');
      return;
    }
    closeMessageEditor();
    if (!changed) return;
    if (!nodeId) { showToast(t('taskQueue.editExpired'), 'warning'); return; }
    post('editTaskMessage', { nodeId, text });
  }

  /** 这条用户消息是否需要折叠（够长才折，短消息一点界面都不动）。 */
  function isLongUserMessage(message) {
    if (message.role !== 'user') return false;
    const raw = String(message.content || '');
    if (!raw.trim()) return false;
    return raw.length > USER_CLAMP_CHARS || raw.split('\n').length > USER_CLAMP_LINES;
  }

  /**
   * 给一条长用户消息装上折叠。
   *
   * 折叠只改一个 class（高度交给 CSS），不重建任何节点：正文、表格、代码块、
   * 文件标签和选中状态都原样保留，展开时也不会丢失滚动位置。
   */
  function attachUserMessageClamp(contentNode, message) {
    if (!isLongUserMessage(message)) return;
    const expanded = expandedUserMessages.has(message.id);
    contentNode.classList.add('is-clampable');
    contentNode.classList.toggle('is-clamped', !expanded);
    const toggle = textElement('button', 'message-clamp-toggle', expanded ? t('chat.collapseMessage') : t('chat.expandMessage'));
    toggle.type = 'button';
    toggle.title = t('chat.expandMessageHint');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.addEventListener('click', () => {
      const next = !expandedUserMessages.has(message.id);
      if (next) expandedUserMessages.add(message.id); else expandedUserMessages.delete(message.id);
      contentNode.classList.toggle('is-clamped', !next);
      toggle.textContent = next ? t('chat.collapseMessage') : t('chat.expandMessage');
      toggle.setAttribute('aria-expanded', String(next));
      // 展开/收起会大幅改变高度：跟底就重新贴底，翻上去了就保持原位。
      const viewport = elements.messageViewport;
      const previousTop = viewport.scrollTop;
      requestAnimationFrame(() => {
        if (state.autoFollow) viewport.scrollTop = viewport.scrollHeight;
        else viewport.scrollTop = previousTop;
        updateScrollToBottom();
      });
    });
    contentNode.after(toggle);
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
      const blocks = appendRichText(content, text || idleStatusText, Boolean(text) && message.status === 'streaming');
      body.append(content);
      // 画的是占位文案（还没有正文）时记一笔：这一块不能走「原地追加」，
      // 否则第一句真正的话会被接在「正在继续处理…」后面。
      return { tailStart: 0, placeholder: !text, tail: { node: content, blocks } };
    }
    let cursor = 0;
    let tailStart = 0;
    let tail = null;
    let rendered = false;
    for (const group of groups) {
      const boundary = Math.max(cursor, Math.min(group.offset, text.length));
      const narration = appendNarration(body, text.slice(cursor, boundary));
      if (narration) { rendered = true; tailStart = cursor; tail = narration; }
      body.append(renderToolExecutions(group.tools));
      cursor = boundary;
    }
    // 只有**最后**一段才可能是「还在写」的那一段，也只有它允许补全；
    // 前面的段落已经完整，若它恰好以 `2 * 3` 这种结尾，补全反而会凭空多出星号。
    const last = appendNarration(body, text.slice(cursor), message.status === 'streaming');
    if (last) { rendered = true; tailStart = cursor; tail = last; }
    if (!rendered) {
      const content = document.createElement('div'); content.className = 'message-content';
      const blocks = appendRichText(content, idleStatusText); body.append(content);
      return { tailStart: 0, placeholder: true, tail: { node: content, blocks } };
    }
    return { tailStart, tail };
  }

  /** 只渲染有内容的段落：分段边界上的空行、纯空白段直接跳过，不占版面。 */
  function appendNarration(body, rawText, streaming = false) {
    const info = narrationNode(rawText, streaming);
    if (!info) return null;
    body.append(info.node);
    return info;
  }

  /** 建一个正文段落节点；`rawText` 全是空白时返回 null（不占版面）。 */
  function narrationNode(rawText, streaming = false) {
    const text = String(rawText || '').trim();
    if (!text) return null;
    const content = document.createElement('div'); content.className = 'message-content message-narration';
    const blocks = appendRichText(content, text, streaming);
    return { node: content, blocks, text };
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
      /*
       * `pending` = 这一步工具的位置还在**正文之后**（正文还没写到那里），
       * 所以它只能贴在末尾。这个状态会随着正文增长一帧一帧变化，
       * 但它不是「结构变了」—— 见 toolGroupSignature 里为什么要把它抹平。
       */
      const pending = raw >= limit;
      const offset = Math.max(0, Math.min(raw, limit));
      const last = groups[groups.length - 1];
      if (last && last.offset === offset) last.tools.push(tool);
      else groups.push({ offset, pending, tools: [tool] });
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

  /**
   * 点击附件 → 在编辑器里打开查看（粘贴错了可以先点开核对再发送）。
   *
   * 只回传标识，不回传内容：前端从来没有拿到 `dataBase64`，`id` 才是这里
   * 唯一可靠的句柄，扩展侧靠它取回完整附件。
   */
  function attachmentOpenPayload(attachment) {
    const payload = { label: attachment && attachment.label ? String(attachment.label) : '' };
    if (attachment && attachment.id) payload.id = attachment.id;
    if (attachment && attachment.path) payload.path = attachment.path;
    return payload;
  }

  function makeAttachmentOpenable(element, attachment) {
    const base = (attachment && (attachment.path || attachment.label)) || '';
    element.title = `${base} · ${t('chat.openAttachmentHint')}`;
    element.classList.add('attachment-openable');
    element.setAttribute('role', 'button');
    element.tabIndex = 0;
    element.addEventListener('click', (event) => {
      // 删除按钮在同一个容器里，点它不能顺带把附件打开。
      if (event.target instanceof Element && event.target.closest('button')) return;
      post('openAttachment', attachmentOpenPayload(attachment));
    });
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      post('openAttachment', attachmentOpenPayload(attachment));
    });
  }

  function renderMessageAttachments(attachments) {
    const row = document.createElement('div'); row.className = 'message-attachments';
    for (const attachment of attachments) {
      if (attachment.kind === 'image' && attachment.thumbnailDataUrl) {
        const figure = document.createElement('figure'); figure.className = 'message-image-attachment';
        const image = document.createElement('img'); image.src = attachment.thumbnailDataUrl; image.alt = attachment.label;
        // 图片可以拖回输入框变成新附件：`img` 默认就是可拖的（浏览器会拖出图片本身），
        // 但那样松手只能落到「拖出 webview」，落不进输入框。关掉原生拖拽、改由 figure
        // 承担，才能走我们自己的 dragstart/drop 通道（见 makeAttachmentDraggable）。
        image.draggable = false;
        figure.append(image, textElement('figcaption', '', attachment.label));
        // 「添加到输入框」按钮：拖拽在触摸屏和键盘上都不好用，必须另有入口。
        const reuse = textElement('button', 'message-attachment-reuse', t('chat.attachFromMessage'));
        reuse.type = 'button';
        reuse.title = t('chat.attachFromMessageHint');
        reuse.setAttribute('aria-label', `${t('chat.attachFromMessage')}：${attachment.label}`);
        reuse.addEventListener('click', (event) => {
          event.stopPropagation();
          post('attachMessageAttachment', attachmentOpenPayload(attachment));
        });
        figure.append(reuse);
        makeAttachmentOpenable(figure, attachment);
        makeAttachmentDraggable(figure, attachment);
        row.append(figure);
      } else {
        const chip = textElement('span', 'message-file-attachment', attachment.label); row.append(chip);
        makeAttachmentOpenable(chip, attachment);
        makeAttachmentDraggable(chip, attachment);
      }
    }
    return row;
  }

  /**
   * 让已经发出去的附件可以**拖回输入框**变成一条新附件。
   *
   * 需求（用户原话）：「已经发到聊天框的消息里面的图片，想要拖动，或者复制到输入框
   * 显示成新的附件」。
   *
   * 为什么不靠 `dataTransfer.files`：webview 里拿到的 File 是浏览器从图片元素现造的，
   * 没有磁盘路径，扩展侧还得靠 base64 反推；而附件本来就在扩展的内存索引里
   * （`attachmentIndex`，按 `id` 取回原始 `dataBase64`）。所以这里只把**标识**放进
   * 拖拽数据 —— 内容由扩展侧取，前端不搬运几 MB 的 base64。
   *
   * 同时写一份自定义 MIME：`drop` 时用它判断「这是我们自己的附件」，而不是靠一个
   * 全局变量猜（拖动可能被外部打断，变量会留下过期的值）。
   */
  const ATTACHMENT_DRAG_TYPE = 'application/x-hwchat-attachment';
  /** 拖拽中的附件标识；`dragover` 判断要不要把输入框显示成放置目标时用它。 */
  let draggingAttachment = null;

  function makeAttachmentDraggable(element, attachment) {
    const payload = attachmentOpenPayload(attachment);
    const token = payload.id || payload.path || payload.label;
    if (!token) return;
    element.draggable = true;
    element.addEventListener('dragstart', (event) => {
      draggingAttachment = payload;
      element.classList.add('is-dragging');
      if (!event.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'copy';
      // 标识写进去就够了；再附一份纯文本，拖到外部程序时至少能看出拖的是什么。
      event.dataTransfer.setData(ATTACHMENT_DRAG_TYPE, token);
      event.dataTransfer.setData('text/plain', attachment.label || '');
    });
    const end = () => {
      draggingAttachment = null;
      element.classList.remove('is-dragging');
      elements.composer.classList.remove('is-drop-target');
    };
    element.addEventListener('dragend', end);
  }

  /** 这次拖动是不是「我们自己的附件」（而不是从 Finder / 编辑器拖进来的文件）。 */
  function isAttachmentDrag(event) {
    const types = event.dataTransfer?.types;
    if (types && Array.from(types).includes(ATTACHMENT_DRAG_TYPE)) return true;
    return Boolean(draggingAttachment);
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
      // 「在跑」和「已结束」必须分开：只有运行中才需要实时计时与停滞提示。
      const running = tool.status === 'pending' && !tool.finishedAt;
      if (running) {
        details.dataset.running = '1';
        details.dataset.startedAt = String(tool.startedAt || 0);
        details.dataset.riskLabel = riskLabelOf(tool);
        if (tool.stallHint) details.dataset.stallHint = tool.stallHint;
      }
      if (running && tool.stallHint) details.classList.add('stalled');
      const summary = document.createElement('summary');
      const statusBadge = textElement('span', 'tool-status', '');
      statusBadge.append(iconNode(statusIconName(tool.status)));
      const meta = textElement('small', '', '');
      meta.textContent = running ? runningToolMeta(details) : toolMeta(tool);
      summary.append(statusBadge, textElement('span', 'tool-summary', tool.summary || tool.name), meta);
      const detail = document.createElement('div'); detail.className = 'tool-detail';
      // 停滞提示同时放进卡片正文：窄窗口下 summary 里的小字会被媒体查询隐藏，
      // 而 pending 卡片默认是展开的，正文这一行在任何宽度下都看得见。
      if (running && tool.stallHint) detail.append(textElement('p', 'tool-stall', tool.stallHint));
      if (tool.changedFiles?.length) detail.append(textElement('div', 'tool-files', t('chat.toolFiles', { files: tool.changedFiles.join(t('common.listSeparator')) })));
      if (tool.input) detail.append(detailBlock(t('chat.toolInput'), tool.input, tool.risk === 'command' ? commandText(tool.input) : undefined));
      if (tool.output) detail.append(detailBlock(t('chat.toolOutput'), tool.output));
      if (!tool.input && !tool.output) detail.append(textElement('p', 'tool-cleaned', tool.finishedAt ? t('chat.toolCleaned') : t('chat.toolWaiting')));
      details.append(summary, detail); section.append(details);
    }
    scheduleToolTicker();
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

  /** 工具执行结果 → 图标名。pending 落在省略号上，表示「还没结束」。 */
  function statusIconName(status) { return status === 'success' ? 'check' : status === 'denied' ? 'minus' : status === 'error' ? 'bang' : 'ellipsis'; }
  function riskLabelOf(tool) {
    const labels = { read: t('chat.risk.read'), write: t('chat.risk.write'), command: t('chat.risk.command') };
    return labels[tool.risk] || tool.name;
  }
  function toolMeta(tool) {
    const duration = tool.finishedAt && tool.startedAt ? ` · ${formatDuration(tool.finishedAt - tool.startedAt)}` : '';
    return `${riskLabelOf(tool)}${duration}`;
  }

  /**
   * 运行中的卡片文字：`命令 · 已运行 12.3 秒 [· 已 45 秒无输出…]`。
   * 结束时间未知，只能用「已经跑了多久」证明它还在动——
   * 没有这个数字时，正常运行和彻底卡死在界面上完全一样。
   */
  function runningToolMeta(node) {
    const parts = [];
    if (node.dataset.riskLabel) parts.push(node.dataset.riskLabel);
    const startedAt = Number(node.dataset.startedAt || 0);
    const seconds = startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;
    parts.push(t('chat.toolRunningSeconds', { seconds: seconds.toFixed(1) }));
    if (node.dataset.stallHint) parts.push(node.dataset.stallHint);
    return parts.join(' · ');
  }

  let toolTicker = null;
  function scheduleToolTicker() {
    // 本轮渲染的节点此刻还没插进文档，等一拍再扫描，否则一个都找不到。
    setTimeout(() => {
      paintRunningToolMeta();
      if (!toolTicker) toolTicker = setInterval(paintRunningToolMeta, 1000);
    }, 0);
  }
  function paintRunningToolMeta() {
    const nodes = document.querySelectorAll('.tool-execution[data-running="1"]');
    if (!nodes.length) {
      if (toolTicker) { clearInterval(toolTicker); toolTicker = null; }
      return;
    }
    for (const node of nodes) {
      const summary = node.querySelector('summary');
      const meta = summary ? summary.querySelector('small') : null;
      if (meta) meta.textContent = runningToolMeta(node);
    }
  }

  function renderReasoning(reasoning, streaming) {
    const details = document.createElement('details'); details.className = 'reasoning';
    details.dataset.detailKey = 'reasoning';
    // 默认收起：思考过程是给想追根究底的人看的，不该一上来就占满视野。
    details.dataset.defaultOpen = '0';
    const content = document.createElement('div'); content.className = 'reasoning-content'; appendRichText(content, reasoning, streaming);
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
  /**
   * 把一段 markdown 渲染进 `container`，并返回「每个块是从第几行开始的」。
   *
   * 返回块行号是为了流式增量更新：正文增长时只需要从「最后一个块的起始行」重新解析，
   * 前面的块连节点带文字都不用碰（见 patchGrowingSegment）。
   */
  function appendRichText(container, text, streaming = false) {
    /*
     * 流式输出时先把「还在写的那一段」补全再排版。
     *
     * 只补尾部：前面已经完整的段落一个字符都不动（否则前一段里没闭合的标记会被
     * 补到末尾去）。补全之后，`**重点` 这一帧就是粗体、`[文档](https://exa` 这一帧
     * 就是链接文字，可见文字只增不减，不会再「先字面量、后跳变」。
     */
    const source = streaming && streamRepair ? streamRepair.repairStreamingMarkdown(text) : text;
    const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    const push = (node, line) => { container.append(node); blocks.push({ line, node }); };
    let paragraph = [];
    let paragraphLine = 0;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const value = paragraph.join('\n').trim();
      const startLine = paragraphLine;
      paragraph = [];
      if (!value) return;
      const node = document.createElement('p');
      appendInline(node, value);
      push(node, startLine);
    };
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] || '';
      // 围栏代码块。流式输出时结束围栏可能还没到，先按代码块渲染，避免整段闪成正文。
      const block = codeMeta.collectFenceBlock(lines, index);
      if (block) {
        flushParagraph();
        const startLine = index;
        index = block.nextIndex;
        push(codeBlockNode(block.code, block.info), startLine);
        continue;
      }
      if (!line.trim()) { flushParagraph(); index += 1; continue; }
      // 分隔线：--- / *** / ___（三个以上同类符号）
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        flushParagraph();
        push(document.createElement('hr'), index);
        index += 1;
        continue;
      }
      // 标题：# 到 ######，行尾多余的 # 只是装饰
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph();
        const node = document.createElement(`h${heading[1].length}`);
        appendInline(node, heading[2]);
        push(node, index);
        index += 1;
        continue;
      }
      // 表格：表头行 + |---|---| 分隔行
      if (isTableStart(lines, index)) { flushParagraph(); const startLine = index; const table = appendTable(container, lines, index); index = table.nextIndex; push(table.node, startLine); continue; }
      // 引用：连续的 > 行合成一个引用块，块内再走一遍同样的排版
      if (/^\s{0,3}>/.test(line)) {
        flushParagraph();
        const startLine = index;
        const quoted = [];
        while (index < lines.length) {
          const current = lines[index] || '';
          if (/^\s{0,3}>/.test(current)) { quoted.push(current.replace(/^\s{0,3}>\s?/, '')); index += 1; continue; }
          if (!current.trim() && /^\s{0,3}>/.test(lines[index + 1] || '')) { quoted.push(''); index += 1; continue; }
          break;
        }
        // 提醒块：首行是 [!DANGER] / [!IMPORTANT] 才走分级渲染；
        // 解析不出来（普通引用、没登记的标记）继续走下面的引用块，外观完全不变。
        const callout = calloutMeta ? calloutMeta.parseCallout(quoted) : null;
        if (callout) {
          push(calloutNode(callout, (body) => appendRichText(body, callout.body)), startLine);
          continue;
        }
        const node = document.createElement('blockquote');
        appendRichText(node, quoted.join('\n'));
        push(node, startLine);
        continue;
      }
      // 列表：层级由 appendList 按缩进算，正文里不再叠加第二套缩进规则
      if (isListLine(line)) { flushParagraph(); const startLine = index; const list = appendList(container, lines, index); index = list.nextIndex; push(list.node, startLine); continue; }
      if (!paragraph.length) paragraphLine = index;
      paragraph.push(line);
      index += 1;
    }
    flushParagraph();
    return blocks;
  }

  /** 位置标签：已知的两种走文案表，其余（例如 loc="GitHub runner"）原样显示。 */
  function locationLabelOf(location) {
    if (location === 'local') return t('chat.runLocationLocal');
    if (location === 'server') return t('chat.runLocationServer');
    return location;
  }

  /**
   * 代码块：终端命令与普通代码用不同底色和标题，方便非技术读者区分「要我做什么」和「这是什么」。
   *
   * 需要用户自己执行的命令还会在标题栏标出「位置」和「工具」：位置决定这条命令该贴在
   * 本地终端还是服务器终端里跑，工具决定是 cmd 还是 bash —— 贴错地方是这类操作最常见的
   * 失败原因。复制按钮只复制代码本身，不含任何标注，粘进终端即可执行。
   */
  function codeBlockNode(codeText, info) {
    const parsed = codeMeta.parseFenceInfo(info);
    const text = codeMeta.dedentCode(codeText);
    const language = parsed.language;
    const shellLanguage = codeMeta.isShellLanguage(language) || (!language && looksLikeShell(text));
    const location = shellLanguage ? parsed.location : '';
    const tool = shellLanguage ? (parsed.tool || language || 'shell') : '';
    const wrapper = document.createElement('div');
    wrapper.className = `code-block${shellLanguage ? ' terminal-command' : ''}${location === 'server' ? ' is-remote' : ''}`;
    const header = document.createElement('div'); header.className = 'code-header';
    const idleLabel = shellLanguage ? t('chat.copyCommand') : t('common.copy');
    const copy = textElement('button', '', idleLabel); copy.type = 'button';
    copy.title = shellLanguage ? t('chat.copyTerminalCommand') : t('chat.copyCode');
    copy.addEventListener('click', () => requestClipboardWrite(text, copy, idleLabel));
    const pre = document.createElement('pre');
    const codeNode = document.createElement('code'); codeNode.textContent = text; pre.append(codeNode);
    const meta = document.createElement('span'); meta.className = 'code-meta';
    if (shellLanguage) {
      if (location) {
        const label = locationLabelOf(location);
        const chip = textElement('span', `code-chip code-chip-location${location === 'server' ? ' is-remote' : ''}`, t('chat.runLocationTag', { location: label }));
        chip.title = t('chat.runLocationTitle', { location: label });
        meta.append(chip);
      }
      const toolChip = textElement('span', 'code-chip code-chip-tool', t('chat.runToolTag', { tool }));
      toolChip.title = t('chat.runToolTitle', { tool });
      meta.append(toolChip);
    } else {
      meta.append(textElement('span', '', language || 'code'));
    }
    header.append(meta, copy);
    wrapper.append(header, pre);
    return wrapper;
  }

  function isListLine(line) { return /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/.test(String(line || '')); }

  /**
   * 列表条目正文：纯文字走行内格式，\u0000N\u0000 占位符处插入对应的代码块。
   *
   * 逐段 appendInline 而不是整段一次，是为了让代码块留在它原本的位置上
   * （「位置：…／命令／预期：…」这种顺序不能被挪动）。
   * 没有代码块的条目完全走原来的单次 appendInline，渲染结果与以前一致。
   */
  function appendListItemContent(li, item) {
    const blocks = item.blocks || [];
    const text = String(item.text || '');
    if (!blocks.length) { appendInline(li, text); return; }
    const parts = text.split(/\u0000(\d+)\u0000/);
    for (let index = 0; index < parts.length; index += 1) {
      if (index % 2 === 1) {
        const block = blocks[Number(parts[index])];
        if (block) li.append(codeBlockNode(block.code, block.info));
        continue;
      }
      const value = parts[index].replace(/^\n+|\n+$/g, '');
      if (!value.trim()) continue;
      const line = document.createElement('div');
      line.className = 'li-text';
      appendInline(line, value);
      li.append(line);
    }
  }

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
        // 缩进的围栏（列表里的代码块）单独收成代码块，避免被当成普通续行拼进正文。
        // 只认缩进的：顶格围栏属于列表结束，交给外层 appendRichText 渲染。
        const nested = items.length && /^\s/.test(line) ? codeMeta.collectFenceBlock(lines, index) : null;
        if (nested) {
          const item = items[items.length - 1];
          item.blocks.push({ code: nested.code, info: nested.info });
          // 占位符记住代码块在正文里的位置，渲染时再按顺序还原。
          item.text += `\n\u0000${item.blocks.length - 1}\u0000\n`;
          index = nested.nextIndex;
          continue;
        }
        // 缩进的续行并入上一条，而不是断开列表
        if (items.length && /^\s+\S/.test(line)) { items[items.length - 1].text += `\n${line.trim()}`; index += 1; continue; }
        break;
      }
      items.push({
        indent: match[1].replace(/\t/g, '    ').length,
        ordered: /\d/.test(match[2]),
        startNumber: Number.parseInt(match[2], 10) || 1,
        // 有序列表开头多出来的 `[ ]` 是模型自带的复选框标记，渲染出来只是噪音；
        // 提示词已经禁止，这里再兜一层（见 media/follow-up-format.js）。
        text: followUpFormat ? followUpFormat.listItemText(match[2], match[3]) : match[3],
        blocks: [],
      });
      index += 1;
    }
    const stack = [];
    let firstList = null;
    for (const item of items) {
      while (stack.length && item.indent < stack[stack.length - 1].indent) stack.pop();
      let frame = stack[stack.length - 1];
      const tagName = item.ordered ? 'ol' : 'ul';
      if (!frame || item.indent > frame.indent) {
        const list = document.createElement(tagName);
        if (item.ordered && item.startNumber !== 1) list.start = item.startNumber;
        if (frame?.li) frame.li.append(list); else container.append(list);
        if (!firstList) firstList = list;
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
      appendListItemContent(li, item);
      frame.list.append(li);
      frame.li = li;
    }
    return { node: firstList, nextIndex: index };
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
    return { node: wrap, nextIndex: index };
  }

  function looksLikeShell(value) {
    return /^(?:\$\s*)?(?:npm|pnpm|yarn|git|cd|ls|mkdir|rm|cp|mv|curl|wget|python3?|node|npx|docker|kubectl|gradle|\.\/|swift|go|cargo|chmod|chown|brew|apt|pip3?|export|setx|powershell)\b/im.test(value.trim());
  }

  /**
   * 文件引用的渲染与右键菜单。
   *
   * 判断与解析都在 media/file-reference.js（纯函数、可单测），这里只负责
   * 「把解析结果变成 DOM」以及「把用户的动作发回扩展」。
   *
   * 显示规则（用户明确要求）：
   *  - 写了引用格式（反引号）→ 显示相对路径，短、好读；
   *  - 没写引用格式（正文里裸写）→ 显示**完整绝对路径**，这样能在
   *    VS Code 之外对着路径找到文件；
   *  - 路径不在工作区内、无法相对化时，也只能显示完整路径。
   * 完整路径同时挂在 title 上，任何时候悬停都能看到。
   */
  function fileReferenceContext() {
    return { roots: state.fileRoots.roots, preferred: state.fileRoots.preferred };
  }

  function fileTargetLabel() {
    return t(`chat.fileRefTarget.${state.fileTarget}`);
  }

  function fileReferencePayload(reference) {
    return {
      path: reference.absolute,
      line: reference.line,
      column: reference.column,
      endLine: reference.endLine,
    };
  }

  /**
   * 造一个文件引用节点；认出不是文件时返回 null，调用方按原样渲染。
   *
   * 注意这里造出来的节点是**待核实**状态：上面拼出的绝对路径是按项目根猜的
   * （`extension.js` 可能其实指 `out/extension.js`，也可能根本不存在）。
   * 节点登记进 `pendingFileReferences`，等扩展回话再决定升级还是降级。
   *
   * @param {string|object} input 反引号里的原文，或 scanPlainText 的解析结果
   * @param {{ compact?: boolean, allowSpaces?: boolean, original?: string }} [options]
   */
  function fileReferenceNode(input, options = {}) {
    if (!fileRef) return null;
    const reference = typeof input === 'string'
      ? fileRef.parseReference(input, { allowSpaces: options.allowSpaces })
      : input;
    if (!reference) return null;
    const resolved = fileRef.resolveReference(reference, fileReferenceContext());
    // 解析不出绝对路径（没有工作区根、又是相对路径）时退回原文，别显示一个点不开的假引用。
    if (!resolved) return null;

    /*
     * 这一步是「文件标签后面的文字会跳动」的修复点。
     *
     * 流式输出时，正在增长的那一段正文每 70ms 会被重新排版一次，里面的文件标签
     * 也跟着重新造一个。新造的标签一开始按**用户写的原文**显示（短），随后扩展
     * 核实回来才换成真实路径（可能长得多，例如解析到当前首选根目录之外的文件）。
     * 于是每一帧都重演一次「短 → 长」：标签后面的文字被推来推去，看起来就是
     * 标签长度在来回变化、后面的字在跳。
     *
     * 现在把核实结果按「首选根 + 路径」缓存起来。重建出来的标签直接套用上一次的
     * 结论，既不会再晚一拍，也不会重复发请求 —— 同一段正文里每帧画出来的标签
     * 与上一帧完全一致，后面的文字自然不动。
     */
    const entry = {
      node: null,
      labelNode: null,
      reference,
      resolved,
      compact: Boolean(options.compact),
      original: typeof input === 'string' ? input : (options.original || reference.path),
    };
    const known = cachedReferenceResolution(reference);
    if (known !== undefined) {
      // 已经判过「不是真实文件」：直接退回原文（compact 时是 <code>），
      // 别再画一个点不开的假标签、也别再问一次。
      if (!known) return null;
      return buildFileReferenceNode(entry, known);
    }

    const node = buildFileReferenceNode(entry);
    pendingFileReferences.push(entry);
    scheduleFileReferenceCheck();
    return node;
  }

  /**
   * 造出标签节点本身。
   *
   * `verified` 是已经核实过的绝对路径（来自上一次应答的缓存）。传了它就直接按
   * **最终形态**画：标签一次到位，不会先短后长；不传就先按原文画，等应答再更新。
   */
  function buildFileReferenceNode(entry, verified) {
    const { reference, compact } = entry;
    if (verified) {
      // 核实过就整条重新解析一遍：扩展查到的可能是**另一个文件**
      // （`extension.js` → `out/extension.js`），点击目标与标签要一起换。
      const next = fileRef.resolveReference({ ...reference, path: verified }, fileReferenceContext());
      if (next) entry.resolved = next;
    }
    const suffix = fileRef.locationSuffix(reference);
    const resolved = entry.resolved;
    const label = fileReferenceLabel(entry);

    const node = document.createElement('span');
    node.className = `file-ref${compact ? '' : ' file-ref-full'}`;
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.title = `${resolved.absolute}${suffix}\n${t('chat.fileRefHint', { target: fileTargetLabel() })}`;
    const labelNode = textElement('span', 'file-ref-label', label);
    node.append(iconNode('file'), labelNode);

    entry.node = node;
    entry.labelNode = labelNode;
    node.hwFileReference = entry;
    node.addEventListener('click', () => post('openFileReference', fileReferencePayload(entry.resolved)));
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      post('openFileReference', fileReferencePayload(entry.resolved));
    });
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openFileReferenceMenu(event, entry.resolved);
    });
    return node;
  }

  /**
   * 标签文字的唯一计算处。
   *
   * 「文件标签后面的文字会跳」的根因是同一颗标签有短长两种写法：首次渲染按猜的
   * 路径写一遍、核实回来再改成真实路径写一遍。流式输出每 70ms 重建一次正文，
   * 于是每一帧都重演一次「短 → 长」，后面的文字被推来推去。
   *
   * 现在首次渲染、沿用缓存结论的重建、以及核实后的原地更新，全部调用这一个函数：
   * 只要 `entry.resolved` 相同，算出来的标签就一模一样，宽度自然不会再变。
   */
  function fileReferenceLabel(entry) {
    const suffix = fileRef.locationSuffix(entry.reference);
    if (entry.compact && entry.resolved.relative) return `${entry.resolved.relative}${suffix}`;
    return `${entry.resolved.absolute}${suffix}`;
  }

  /**
   * 核实结果缓存：键是「首选根 + 用户写的路径」。
   *
   * 存的是「绝对路径」或 `null`（判不出来）。`undefined` 表示还没问过 ——
   * 三种状态必须分清，否则「没问过」会被当成「不存在」而误降级。
   */
  const fileReferenceResolution = new Map();
  const FILE_REFERENCE_CACHE_LIMIT = 500;
  /** 上一次看到的工作区根签名：根一变，核实缓存整份作废。 */
  let fileRootsSignature = '';

  function fileReferenceKey(reference) {
    return `${state.fileRoots.preferred || ''}::${reference.path || ''}`;
  }

  function cachedReferenceResolution(reference) {
    return fileReferenceResolution.get(fileReferenceKey(reference));
  }

  function rememberReferenceResolution(reference, absolute) {
    const key = fileReferenceKey(reference);
    fileReferenceResolution.delete(key);
    fileReferenceResolution.set(key, absolute || null);
    // 只留最近的若干条：长对话里引用会很多，但真正会重复出现的都是最近的。
    if (fileReferenceResolution.size > FILE_REFERENCE_CACHE_LIMIT) {
      const oldest = fileReferenceResolution.keys().next();
      if (!oldest.done) fileReferenceResolution.delete(oldest.value);
    }
  }

  /*
   * 引用核实的批处理。
   *
   * 为什么不在造节点时就发请求：一条消息里可能有一二十个引用，逐个发就是
   * 一二十次往返。渲染是同步完成的，用一个微任务就能把它们合成一次请求。
   */
  let pendingFileReferences = [];
  let fileReferenceBatchSeq = 0;
  let fileReferenceFlushScheduled = false;
  const fileReferenceBatches = new Map();

  function scheduleFileReferenceCheck() {
    if (fileReferenceFlushScheduled) return;
    fileReferenceFlushScheduled = true;
    Promise.resolve().then(() => {
      fileReferenceFlushScheduled = false;
      flushFileReferenceCheck();
    });
  }

  function flushFileReferenceCheck() {
    if (!pendingFileReferences.length) return;
    const batch = pendingFileReferences;
    pendingFileReferences = [];
    fileReferenceBatchSeq += 1;
    const requestId = `ref-${fileReferenceBatchSeq}`;
    fileReferenceBatches.set(requestId, batch);
    // 扩展没回话的批次（窗口正在关、旧版本没有这条协议）不该无限堆积。
    if (fileReferenceBatches.size > 40) {
      const oldest = fileReferenceBatches.keys().next();
      if (!oldest.done) fileReferenceBatches.delete(oldest.value);
    }
    post('verifyFileReferences', {
      requestId,
      items: batch.map((entry) => ({ path: entry.reference.path, root: state.fileRoots.preferred })),
    });
  }

  /** 扩展回话：`resolved[i]` 是真实文件，`null` 表示判不出来。 */
  function applyFileReferenceVerification(message) {
    const batch = fileReferenceBatches.get(message.requestId);
    if (!batch) return;
    fileReferenceBatches.delete(message.requestId);
    const resolved = Array.isArray(message.resolved) ? message.resolved : [];
    batch.forEach((entry, index) => {
      const absolute = typeof resolved[index] === 'string' && resolved[index] ? resolved[index] : '';
      /*
       * 先落缓存再动 DOM。
       *
       * 流式输出会不停重建这一段正文，同一个引用几毫秒后就会再画一次；没有缓存时
       * 新节点只能先按原文画、等下一轮应答再改 —— 每帧都重演一次「短 → 长」，
       * 标签后面的文字因此来回跳。有了缓存，重建出来的节点一次就画成最终形态。
       */
      rememberReferenceResolution(entry.reference, absolute);
      if (absolute) upgradeFileReference(entry, absolute); else demoteFileReference(entry);
    });
  }

  /**
   * 换成真实文件。
   *
   * 扩展查到的可能是**另一个文件**（`extension.js` → `out/extension.js`），
   * 所以整条重新解析一遍：标签、悬停提示、点击目标一起换成真实路径。
   * 否则标签写着 `extension.js`、点开却是 `out/extension.js`，两边对不上。
   */
  function upgradeFileReference(entry, absolute) {
    const next = fileRef.resolveReference({ ...entry.reference, path: absolute }, fileReferenceContext());
    if (!next) return;
    entry.resolved = next;
    const suffix = fileRef.locationSuffix(entry.reference);
    /*
     * 点击目标、悬停提示、标签文字一起换成真实文件。
     *
     * 只改这一次是安全的：下一次重建会从缓存里拿到同一个结论、算出一模一样的标签
     * （见 fileReferenceLabel），不会再「一帧短一帧长」。整条消息里同一颗标签因此
     * 只有一次「猜的 → 真实的」变化，而不是每帧一次。
     */
    entry.labelNode.textContent = fileReferenceLabel(entry);
    entry.node.title = `${next.absolute}${suffix}\n${t('chat.fileRefHint', { target: fileTargetLabel() })}`;
  }

  /**
   * 判不出真实文件：还原成原文。
   *
   * 用户看到的还是同一串字符，只是不再带图标和右键菜单——点开一个不存在的
   * 路径比不给菜单更糟，用户会以为是自己点错了。
   */
  function demoteFileReference(entry) {
    const node = entry.node;
    const replacement = entry.compact
      ? textElement('code', '', entry.original)
      : document.createTextNode(entry.original);
    const parent = node.parentNode || node.parent;
    if (!parent) return;
    if (typeof node.replaceWith === 'function') {
      node.replaceWith(replacement);
      return;
    }
    if (typeof parent.replaceChild === 'function') parent.replaceChild(replacement, node);
  }

  /** 正文里裸写的路径：扫描出来逐个替换成引用，其余部分保持纯文本。 */
  function appendPlainText(parent, text) {
    if (!text) return;
    const hits = fileRef ? fileRef.scanPlainText(text) : [];
    if (!hits.length) { parent.append(document.createTextNode(text)); return; }
    let cursor = 0;
    for (const hit of hits) {
      if (hit.index > cursor) parent.append(document.createTextNode(text.slice(cursor, hit.index)));
      const node = fileReferenceNode(hit.reference, { compact: false, original: hit.text });
      if (node) parent.append(node); else parent.append(document.createTextNode(hit.text));
      cursor = hit.index + hit.length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  /**
   * 右键菜单（四项）：
   *   1. 在系统文件管理器里定位（Finder / 资源管理器 / 文件管理器）；
   *   2. 在 VS Code 资源管理器视图里定位；
   *   3. 在编辑器里打开；
   *   4. 复制完整路径。
   *
   * 前两项容易混，区别是「离开 VS Code 去系统里找」和「留在编辑器里看它在项目树的哪一层」。
   *
   * 自己画菜单而不是用浏览器默认菜单：webview 里默认菜单没有这些项，
   * 也没法把命令回传给扩展。
   */
  let fileReferenceMenu = null;

  function closeFileReferenceMenu() {
    if (!fileReferenceMenu) return;
    fileReferenceMenu.remove();
    fileReferenceMenu = null;
    document.removeEventListener('click', closeFileReferenceMenu, true);
    document.removeEventListener('keydown', onFileMenuKeydown, true);
    window.removeEventListener('blur', closeFileReferenceMenu);
    window.removeEventListener('resize', closeFileReferenceMenu);
  }

  function onFileMenuKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); closeFileReferenceMenu(); }
  }

  function openFileReferenceMenu(event, reference) {
    closeFileReferenceMenu();
    const menu = document.createElement('div');
    menu.className = 'file-ref-menu';
    menu.setAttribute('role', 'menu');
    const add = (label, iconName, action) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'file-ref-menu-item';
      item.setAttribute('role', 'menuitem');
      item.append(iconNode(iconName), textElement('span', '', label));
      item.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation();
        closeFileReferenceMenu();
        action(item);
      });
      menu.append(item);
    };
    add(t('chat.fileRefReveal', { target: fileTargetLabel() }), 'folder', () => {
      post('revealFile', fileReferencePayload(reference));
    });
    add(t('chat.fileRefRevealInExplorer'), 'tree', () => {
      post('revealFileInExplorer', fileReferencePayload(reference));
    });
    add(t('chat.fileRefOpenEditor'), 'file', () => {
      post('openFileReference', fileReferencePayload(reference));
    });
    const path = reference.absolute;
    add(t('chat.fileRefCopyPath'), 'copy', (item) => {
      requestClipboardWrite(path, item, t('chat.fileRefCopyPath'));
    });
    document.body.append(menu);

    // 贴边时往回收，别让菜单跑出可视区。
    const rect = menu.getBoundingClientRect();
    const left = Math.min(event.clientX, window.innerWidth - rect.width - 6);
    const top = Math.min(event.clientY, window.innerHeight - rect.height - 6);
    menu.style.left = `${Math.max(6, left)}px`;
    menu.style.top = `${Math.max(6, top)}px`;

    fileReferenceMenu = menu;
    // 捕获阶段收菜单：点菜单项自身时 stopPropagation 已经拦住了冒泡版本，
    // 这里只处理「点别处」的情况。
    document.addEventListener('click', closeFileReferenceMenu, true);
    document.addEventListener('keydown', onFileMenuKeydown, true);
    window.addEventListener('blur', closeFileReferenceMenu);
    window.addEventListener('resize', closeFileReferenceMenu);
  }

  /** 行内格式：`代码`、**加粗**、~~删除~~、[文字](链接)、裸链接。 */
  function appendInline(parent, value) {
    // 只把「目标看起来像链接」的 [文字](目标) 当链接：目标必须以 http(s)://、mailto:、# 或 / 开头，
    // 这样 [文字](javascript:…) 之类的构造连匹配都不会匹配，不会出现半个链接加一个多余的右括号。
    //
    // 斜体两侧的 `(?<!\*)` / `(?!\*)` 是流式输出的必需约束：`**重点` 还没等到收尾的 `**` 时，
    // 旧的 `\*[^\s*][^*\n]*\*` 会把第二个 `*` 和结尾那个 `*` 配成斜体，于是可见文字从
    // `**重点*` 跳成 `*重点`——已经显示出来的星号少了一个，用户看到的就是「同一位置闪过
    // 不一样的文字」。加上边界后，半截的粗体一律按字面量显示，直到 `**` 真正闭合。
    const pattern = /(`[^`]+`|\*\*[^*\n]+\*\*|(?<!\*)\*(?!\*)[^\s*][^*\n]*\*(?!\*)|~~[^~\n]+~~|\[[^\]\n]+\]\((?:https?:\/\/|mailto:|#|\/)[^)\s]*\)|https?:\/\/[^\s<]+)/g; let cursor = 0;
    for (const match of value.matchAll(pattern)) {
      const index = match.index || 0; if (index > cursor) appendPlainText(parent, value.slice(cursor, index)); const token = match[0];
      if (token.startsWith('`')) {
        // 反引号里是文件路径时渲染成可点的引用（悬停看完整路径、右键在 Finder/资源管理器中定位），
        // 否则维持原来的代码片段样式。allowSpaces 只在这里打开：反引号已经界定了边界。
        const codeText = token.slice(1, -1);
        parent.append(fileReferenceNode(codeText, { compact: true, allowSpaces: true }) || textElement('code', '', codeText));
      }
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
    if (cursor < value.length) appendPlainText(parent, value.slice(cursor));
  }

  function renderAttachments() {
    elements.attachmentList.replaceChildren(); let fileIndex = 0;
    for (const attachment of state.pendingAttachments) {
      const chip = document.createElement('div'); chip.className = `attachment-chip${attachment.kind === 'image' && attachment.thumbnailDataUrl ? ' attachment-chip-image' : ''}`;
      if (attachment.kind === 'image' && attachment.thumbnailDataUrl) {
        const image = document.createElement('img'); image.src = attachment.thumbnailDataUrl; image.alt = '';
        chip.append(image);
      }
      const label = textElement('span', '', attachment.label);
      const size = textElement('small', '', attachment.kind === 'selection' ? t('chat.codeSelection') : formatBytes(attachment.bytes || 0));
      const remove = textElement('button', '', ''); remove.type = 'button'; remove.title = t('common.remove'); remove.append(iconNode('close'));
      if (attachment.kind === 'selection') remove.addEventListener('click', () => post('removeContext'));
      else { const index = fileIndex; remove.addEventListener('click', () => post('removeAttachment', { index })); fileIndex += 1; }
      chip.append(label, size, remove); elements.attachmentList.append(chip);
      // 待发送的附件同样可以点开核对——「粘贴错了」正好发生在发送之前。
      makeAttachmentOpenable(chip, attachment);
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
    // 互联网参考与权限预设同一套语义：运行中可改，下一次发送生效。
    if (elements.internetReferenceButton) elements.internetReferenceButton.disabled = archived;
    // 预设允许在任务运行中改（只对下一次对话生效）；步数与思考深度仍然锁在当前任务上。
    elements.permissionPresetInput.disabled = archived || state.permissionPresetPending;
    // 步数与思考深度和权限预设同一套语义：**运行中可改，下一次发送生效**。
    // 当前这一轮用的是运行开始时的设置快照，所以中途改不会让同一轮前后请求不一致。
    elements.agentMaxStepsInput.disabled = archived;
    elements.reasoningEffortInput.disabled = archived || elements.reasoningEffortInput.dataset.support !== 'configurable';
    elements.voiceButton.disabled = archived;
    elements.detachHistoryButton.disabled = state.streaming || archived;
    elements.promptInput.placeholder = archived ? t('chat.promptPlaceholderArchived') : state.streaming ? t('chat.promptPlaceholderStreaming') : t('chat.promptPlaceholderAgent');
    syncPermissionHint();
    syncNextSendHints();
  }

  function autoResize() { elements.promptInput.style.height = 'auto'; elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 180)}px`; updateComposerState(); }

  /**
   * 输入框草稿按对话分开存。
   *
   * 以前输入框是**面板级共享**的：在 A 里敲了半句没发，切到 B，那半句就原样躺在 B 的输入框里，
   * 顺手一回车就发到了错的对话。这里给每个对话一个草稿槽（还没落库的新对话用 'draft' 键），
   * 切走时存下来、切回来时贴回去。
   */
  function draftKey(conversationId) { return conversationId || 'draft'; }
  /** 把输入框当前内容存进该对话的草稿槽；空串视为「没有草稿」，直接删掉。 */
  function saveDraft(conversationId) {
    const key = draftKey(conversationId);
    if (elements.promptInput.value) state.drafts[key] = elements.promptInput.value;
    else delete state.drafts[key];
  }
  /** 把该对话的草稿贴回输入框；没有草稿就清空。 */
  function restoreDraft(conversationId) {
    const value = state.drafts[draftKey(conversationId)];
    elements.promptInput.value = typeof value === 'string' ? value : '';
  }

  /**
   * 「新建对话」的即时反馈。
   *
   * 为什么要在本地先切（真实故障）：以前点击只发一条 `newChat`，界面要等扩展把一整份
   * 状态算完（读对话列表 + 读首页 80 条消息 + 序列化约 3MB）再推回来才有变化。扩展
   * 正在跑 Agent 或搜索队列满时，这个往返可能几百毫秒甚至直接失败，用户看到的就是
   * **「点了没反应」，只能重载窗口**。草稿是纯本地状态（没有对话、没有消息），
   * 完全可以立刻画出来；随后到达的 `state` 会把它校准成权威值。
   */
  /** 「新建对话」点击后、扩展回话之前的占位卡片 id 前缀（每次点击各插一张）。 */
  const PENDING_NEW_CHAT_PREFIX = '__hwchat_pending_new_chat__';
  let pendingNewChatSeq = 0;

  function enterDraftLocally() {
    /**
     * 当前就是一条没用过的空对话：什么都不做，只把焦点还给输入框。
     * 扩展侧 `newChat()` 的判据完全一致（0 条消息），所以这里不做占位卡；
     * 否则会出现「UI 画了一张卡、服务端没建」的错位。
     */
    const currentEmpty = Boolean(state.conversation)
      && (state.conversation.messageCount ?? state.messages.length) === 0
      && state.messages.length === 0;
    if (currentEmpty) {
      elements.promptInput.focus();
      return;
    }
    saveDraft(state.conversation?.id);
    state.conversation = null;
    state.messages = [];
    state.hasMore = false;
    state.pendingAttachments = [];
    state.pendingApprovals = [];
    state.taskTree = null;
    state.todos = [];
    state.todosInterrupted = false;
    state.todosIncomplete = false;
    state.autoFollow = true;
    state.expandedArchiveId = null;
    state.archiveRestore = null;
    state.showArchived = false;
    // 侧边栏立刻出现这张卡片：扩展会真的建一条对话，随后推送的权威列表会把它替换掉。
    // 万一扩展失败，任何一次状态推送都会整体替换列表，占位卡不会残留。
    // 每次点击各插一张：连点三次就该看到三张卡片，而不是三张挤成一张。
    pendingNewChatSeq += 1;
    state.conversations = [{
      id: `${PENDING_NEW_CHAT_PREFIX}${pendingNewChatSeq}`,
      title: t('common.newChat'),
      preview: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      pinned: false,
      totalTokens: 0,
      mode: state.mode,
      skillIds: [],
      archived: false,
      pending: true,
    }, ...state.conversations];
    restoreDraft(null);
    autoResize();
    renderAll();
    elements.promptInput.focus();
  }

  function submit() {
    const text = elements.promptInput.value.trim();
    if ((!text && !state.pendingAttachments.length) || state.conversation?.archived || state.permissionPresetPending) return;
    elements.promptInput.value = ''; saveDraft(state.conversation?.id); state.autoFollow = true; autoResize();
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
  function showToast(text, tone = 'neutral') {
    elements.toast.textContent = text;
    elements.toast.dataset.tone = tone;
    elements.toast.hidden = false;
    clearTimeout(showToast.timer);
    // 时长跟文字量走：长警告要读得完，短提示仍维持 4 秒左右。
    const duration = toastTiming ? toastTiming.toastDurationMs(text, tone) : 4200;
    showToast.timer = setTimeout(hideToast, duration);
  }
  /** 立刻收起提示。函数声明会提升，所以 showToast 里可以直接引用。 */
  function hideToast() { clearTimeout(showToast.timer); elements.toast.hidden = true; }
  function closeMobileHistory() { elements.app.classList.remove('history-open'); }
  function textElement(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; return node; }

  // 三个面板（任务树 / 任务清单 / 归档快照）互斥展开。
  // 鼠标点击和键盘回车/空格触发的都是 click，所以这一处就覆盖了全部展开入口。
  // 点一下就把提示收起：有些警告确实要读很久，何时消掉应该由用户决定。
  elements.toast.addEventListener('click', hideToast);
  elements.editTitleButton.append(iconNode('pencil'));
  elements.saveTitleButton.append(iconNode('check'));
  elements.cancelTitleButton.append(iconNode('close'));
  elements.editTitleButton.addEventListener('click', startTitleEdit);
  elements.saveTitleButton.addEventListener('click', () => finishTitleEdit(true));
  elements.cancelTitleButton.addEventListener('click', () => finishTitleEdit(false));
  elements.conversationTitleInput.addEventListener('keydown', (event) => {
    // Enter 确认、Esc 放弃。都不让事件冒泡：面板里还有别的 keydown 监听（输入框自动高度等）。
    if (event.key === 'Enter') {
      event.preventDefault();
      finishTitleEdit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishTitleEdit(false);
    }
  });
  for (const key of ['taskTree', 'todoPanel', 'todoArchivePanel']) {
    const panel = elements[key];
    const summary = panel ? panel.querySelector('summary') : null;
    if (!summary) continue;
    summary.addEventListener('click', (event) => {
      event.preventDefault();
      togglePanel(key, panel);
    });
  }
  elements.newChatButton.addEventListener('click', () => { enterDraftLocally(); post('newChat'); closeMobileHistory(); });
  elements.historyButton.addEventListener('click', () => elements.app.classList.toggle('history-open'));
  elements.closeHistoryButton.addEventListener('click', closeMobileHistory);
  elements.archiveViewButton.addEventListener('click', () => post('showArchived', { value: !state.showArchived }));
  elements.settingsButton.addEventListener('click', () => post('openSettings')); elements.settingsButtonSide.addEventListener('click', () => post('openSettings'));
  elements.exportButton.addEventListener('click', () => post('exportConversation'));
  elements.archiveButton.addEventListener('click', () => { if (state.conversation) post('toggleArchive', { id: state.conversation.id, archived: !state.conversation.archived }); });
  elements.detachHistoryButton.addEventListener('click', () => post('detachConversationHistory'));
  elements.attachButton.addEventListener('click', () => post('attachFiles')); elements.removeContextButton.addEventListener('click', () => post('removeContext'));

  /*
   * 输入框作为「放附件」的落点。
   *
   * 两种来源都接：
   *  1. 消息里已经发出去的附件（我们自己的自定义 MIME，见 makeAttachmentDraggable）；
   *  2. 从 Finder / 编辑器直接拖进来的文件（`dataTransfer.files`）——
   *     输入框一旦能被放下东西，不同时支持它会让人以为拖错了。
   *
   * 注意 `dragover` 必须 preventDefault，否则浏览器根本不认为这里是合法落点，
   * `drop` 永远不会有。`dragenter/dragover` 只加高亮，真正取数据在 `drop`。
   */
  const setDropTarget = (active) => elements.composer.classList.toggle('is-drop-target', active);
  elements.composer.addEventListener('dragenter', (event) => {
    if (!isAttachmentDrag(event) && !hasDroppedFiles(event)) return;
    event.preventDefault();
    setDropTarget(true);
  });
  elements.composer.addEventListener('dragover', (event) => {
    if (!isAttachmentDrag(event) && !hasDroppedFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDropTarget(true);
  });
  elements.composer.addEventListener('dragleave', (event) => {
    // 移到子元素上也会触发 dragleave：只有真正离开输入框区域才取消高亮。
    if (event.relatedTarget instanceof Node && elements.composer.contains(event.relatedTarget)) return;
    setDropTarget(false);
  });
  elements.composer.addEventListener('drop', (event) => {
    if (!isAttachmentDrag(event) && !hasDroppedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(false);
    const payload = draggingAttachment;
    draggingAttachment = null;
    if (payload) {
      post('attachMessageAttachment', payload);
      return;
    }
    const files = event.dataTransfer?.files;
    if (files && files.length) void readClipboardFiles(files);
  });

  /** 这次拖进来的是不是磁盘上的文件（Finder、资源管理器、VS Code 资源管理器）。 */
  function hasDroppedFiles(event) {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  }

  elements.stopButton.addEventListener('click', () => post('stop'));
  // 按钮在 <summary> 里面：不阻止默认行为的话，点按钮会顺带把清单折叠起来。
  // preventDefault 拦掉 <details> 的切换，stopPropagation 让内层点击不再冒泡到 summary。
  const bindSummaryAction = (id, type) => {
    const button = elements[id];
    if (!button) return;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      post(type);
    });
  };
  bindSummaryAction('resumeTodosButton', 'resumeTodos');
  bindSummaryAction('cancelTodosButton', 'cancelTodos'); elements.skillsButton.addEventListener('click', () => { elements.skillsPanel.hidden = !elements.skillsPanel.hidden; });
  // 安装按钮只把请求转给扩展（webview 自己开不了外部链接）。
  if (elements.skillsInstallButton) elements.skillsInstallButton.addEventListener('click', () => post('installQuickLaunch'));
  elements.approvalAllowButton.addEventListener('click', () => {
    const requestId = elements.approvalCard.dataset.requestId;
    if (requestId) post('approvalResponse', { requestId, allow: true });
  });
  elements.approvalDenyButton.addEventListener('click', () => {
    const requestId = elements.approvalCard.dataset.requestId;
    if (requestId) post('approvalResponse', { requestId, allow: false });
  });
  // 鼠标滚轮悬停在胶囊栏时转为横向滚动；到达边缘后保留页面的纵向滚动。
  elements.todoArchiveBar.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const maxScroll = elements.todoArchiveBar.scrollWidth - elements.todoArchiveBar.clientWidth;
    if (maxScroll <= 0) return;
    const movingLeft = event.deltaY < 0;
    if ((movingLeft && elements.todoArchiveBar.scrollLeft <= 0)
      || (!movingLeft && elements.todoArchiveBar.scrollLeft >= maxScroll)) return;
    event.preventDefault();
    elements.todoArchiveBar.scrollLeft = Math.min(maxScroll, Math.max(0, elements.todoArchiveBar.scrollLeft + event.deltaY));
  }, { passive: false });
  // 滚动条是隐藏的（见 media/chat.css），所以除了滚轮，还要支持按住鼠标横向拖动。
  bindTodoArchiveDrag(elements.todoArchiveBar);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateScrollToBottom, 60);
  });
  elements.historySearch.addEventListener('input', (event) => { state.search = event.target.value; renderHistory(); });
  elements.modelInput.addEventListener('change', (event) => { state.model = event.target.value; syncReasoningSelector(); post('setModel', { model: event.target.value }); });
  elements.profileInput.addEventListener('change', (event) => post('setProfile', { profileId: event.target.value }));
  /*
   * 悬浮编辑框的交互。
   *
   * 打开入口：**以 `pointerup` 为准**，不依赖浏览器是否会派发 `click`。
   *
   * 真实故障（用户两次反馈「点击编辑有时候没反应 / 还是不灵敏」）：agent 运行时
   * 消息列表被反复重排，按下与松开之间按钮时常被换掉。早先的实现只在「按钮已经
   * 不在文档里」时才兜底，可实测发现还有第三种情形 —— 松手那一刻按钮**还在**，
   * 但同一个 `pointerup` 里后面的监听器（`releaseMessageInteraction`）立刻把列表
   * 整段重建，按钮随即消失，浏览器于是**根本不派发 click**（`mouseup` 只能落到
   * 空白处）。兜底因为「按下时节点还在」提前退出，点击就彻底丢了。
   *
   * 所以现在不猜：按下时记下「哪条消息 + 哪个任务 + 按钮矩形」，松开时只要指针
   * 仍落在同一矩形内（= 一次点击），就直接打开编辑框；随后浏览器若补发 click，
   * 由 `editClickConsumed` 吞掉，避免双触发。键盘（Enter/空格）不产生 pointer 事件，
   * 仍走按钮自己的 click 监听，两条路都通。
   */
  let pressedEditTarget = null;
  let editClickConsumed = null;
  elements.messageList.addEventListener('pointerdown', (event) => {
    pressedEditTarget = null;
    // 每次按下都清掉上一次的「已处理」标记：若上一次的 pointerup 打开了编辑框、但浏览器
    // 没能补发 click（按钮被重排换掉），这个标记就会一直挂着，把**下一次**正常点击吞掉。
    editClickConsumed = null;
    if (event.button !== 0) return;
    const button = event.target instanceof Element ? event.target.closest('.message-execution-edit') : null;
    if (!button) return;
    const box = button.getBoundingClientRect();
    pressedEditTarget = {
      messageId: button.dataset.editMessage || '',
      nodeId: button.dataset.editNode || '',
      left: box.left, right: box.right, top: box.top, bottom: box.bottom,
    };
  });
  document.addEventListener('pointerup', (event) => {
    const pressed = pressedEditTarget;
    pressedEditTarget = null;
    if (!pressed?.messageId) return;
    const insideRecorded = event.clientX >= pressed.left - 2 && event.clientX <= pressed.right + 2
      && event.clientY >= pressed.top - 2 && event.clientY <= pressed.bottom + 2;
    /*
     * 两种都算点中：
     *  1. 落点还在**按下时那个矩形**里 —— 人手没动；
     *  2. 落点下**当前**就是同一条消息的编辑按钮 —— 按住期间流式内容把气泡往下推，
     *     按钮自己挪到了指针底下。用户看到的是「我点在按钮上」，不能因为布局位移就丢掉。
     */
    const underPointer = insideRecorded
      ? null
      : document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.message-execution-edit');
    const sameTarget = underPointer
      ? underPointer.dataset.editMessage === pressed.messageId
      : insideRecorded;
    if (!sameTarget) return;
    const message = state.messages.find((item) => item.id === pressed.messageId);
    if (!message) return;
    // 优先用任务树里那条（拿到最新标题/状态）；列表刚被重建时树里也可能已经变，
    // 但 id 是稳定的，拿不到就按 id 兜住 —— 打开编辑框只需要它。
    const node = pendingTaskForBubble(state.taskTree?.nodes, message.id);
    const nodeId = node?.id || pressed.nodeId;
    if (!nodeId) return;
    editClickConsumed = { messageId: pressed.messageId, at: Date.now() };
    openMessageEditor(message, node || { id: nodeId });
  });
  /** 指针路径已经打开过编辑框时，吞掉浏览器随后补发的那个 click（避免重复打开）。 */
  function consumeEditClick(messageId) {
    const consumed = editClickConsumed;
    editClickConsumed = null;
    if (!consumed) return false;
    return consumed.messageId === messageId && Date.now() - consumed.at < 800;
  }

  elements.messageEditorInput.addEventListener('input', () => { editingBubbleDraft = elements.messageEditorInput.value; growMessageEditor(); });
  /**
   * 编辑框打开期间的快捷键挂在 **document** 上，而不是输入框自己。
   *
   * 原因（实测）：输入框拿焦点靠打开后的 `requestAnimationFrame`，可这中间任何东西
   * （宿主把焦点抢回输入框、上一个动作的残留焦点、预览/测试脚本的 focus）都可能把
   * 焦点挪走。焦点一旦不在 textarea 上，`Esc` 与 `⌘Enter` 就静默失效 —— 编辑框明明
   * 开着却关不掉，用户只会觉得「又点不动了」。挂在 document 上，只要编辑框还开着
   * 就一定响应，这也是「模态浮层」该有的行为。
   */
  document.addEventListener('keydown', (event) => {
    if (elements.messageEditor.hidden) return;
    // 中文输入法组字过程中 Esc 是「取消候选」，不能当成关闭编辑框。
    if (event.isComposing) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveMessageEditor(); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeMessageEditor(); }
  }, true);
  elements.messageEditorSave.addEventListener('click', () => saveMessageEditor());
  elements.messageEditorCancel.addEventListener('click', () => closeMessageEditor());
  // 点遮罩空白处 = 取消（与 Esc 一致）。
  elements.messageEditor.addEventListener('mousedown', (event) => { if (event.target === elements.messageEditor) closeMessageEditor(); });

  elements.internetReferenceButton.addEventListener('click', () => {
    const next = state.internetReference !== true;
    // 先本地切换，让点击立刻有反馈；后端回来时会以它的值为准（见 internetReferenceChanged）。
    state.internetReference = next;
    syncInternetReferenceButton();
    post('setInternetReference', { enabled: next });
  });
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
    state.agentMaxSteps = normalizeStepValue(event.target.value);
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
  // 滚动事件一帧只处理一次：`isNearBottom()` / `updateScrollToBottom()` 都要读
  // scrollHeight / clientHeight，逐个事件读等于每一帧强制布局多次；
  // 平滑滚动与触控板惯性下这能堆成几十次/帧的同步布局。
  let scrollFramePending = false;
  elements.messageViewport.addEventListener('scroll', () => {
    if (scrollFramePending) return;
    scrollFramePending = true;
    requestAnimationFrame(() => {
      scrollFramePending = false;
      if (!state.renderingMessages) state.autoFollow = isNearBottom();
      updateScrollToBottom();
    });
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
    /*
     * 记下「按下的那个折叠标题」，供下面的 click 委托兜底。
     *
     * 依据（W3C / WHATWG）：
     *  - HTML 规范 `<summary>` 的 activation behavior 挂在 **summary 元素自己** 上：
     *    「If this summary element is not the summary for its parent details, then return.」
     *  - MDN《Element: click event》：*If the button is pressed on one element and the pointer
     *    is moved outside the element before the button is released, the event is fired on the
     *    most specific ancestor element that contained both elements.*
     * 两者合起来意味着：只要按下之后那个 summary 被换掉（流式重排重建 DOM），click 就会落到
     * 共同祖先上、summary 收不到激活 → 用户看到「点了没反应」。所以按下时先记一指。
     */
    pressedSummary = summarizePressTarget(event.target);
    // 兜底：指针在窗口外松开时可能收不到 pointerup，超时后恢复渲染。
    clearTimeout(interactionTimer);
    interactionTimer = setTimeout(releaseMessageInteraction, 3000);
  });

  /**
   * 把一次按下的落点折成「稳定标识 + 矩形」。
   *
   * 存标识而不是节点：重排会把节点换掉，标识（`data-detail-key`）跟着业务数据走，不会变。
   * 矩形用于判断松开时指针是否还在同一处（防止「按住拖走再松开」被当成点击）。
   */
  function summarizePressTarget(target) {
    if (!(target instanceof Element)) return null;
    const summary = target.closest('summary');
    if (!summary) return null;
    const details = summary.parentElement;
    if (!details || details.tagName !== 'DETAILS') return null;
    const key = details.dataset.detailKey;
    if (!key) return null;
    const box = summary.getBoundingClientRect();
    return { key, node: summary, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }

  /** 在当前 DOM 里按 `data-detail-key` 找回那个折叠块（节点可能已经被重建过）。 */
  function findDetailsByKey(root, key) {
    if (!key) return null;
    for (const details of root.querySelectorAll('details[data-detail-key]')) {
      if (details.dataset.detailKey === key) return details;
    }
    return null;
  }

  document.addEventListener('pointerup', (event) => {
    const pressed = pressedSummary;
    pressedSummary = null;
    /*
     * 兜底：按下与松开之间那个 `<summary>` 被重排换掉了。
     *
     * 依据（实测 + 规范）：
     *  - HTML 规范：`<summary>` 的 activation behavior 挂在 summary 元素自己身上，
     *    只有 **它自己** 收到激活才会切换 `open`。
     *  - MDN《Element: click event》：按下与松开不在同一个元素上时，click 会派发到
     *    「同时包含它们的最近祖先」。而旧节点已经被移除、树上找不到共同祖先，
     *    实测结果是 **click 根本不派发**（`pointerdown` 有、`click` 没有）。
     *  所以事件委托兜不住 —— 必须挂在 `pointerup` 上：它只取决于释放位置，一定会来。
     *  判断条件用「按下那个节点是否还在文档里」：还在就说明浏览器会正常派发 click，
     *  交给原生处理（避免双触发）；不在了才由这里补一次 toggle，等价于规范的 activation。
     */
    const stillAlive = pressed?.node?.isConnected === true;
    if (pressed && !stillAlive) {
      const inside = event.clientX >= pressed.left && event.clientX <= pressed.right
        && event.clientY >= pressed.top && event.clientY <= pressed.bottom;
      if (inside) {
        /*
         * 用稳定标识 `data-detail-key`（`tool:<callId>` / `reasoning` / `skills`）
         * 在**当前** DOM 里找回同一个折叠块 —— 节点换了，用户点的还是那一步。
         */
        const details = findDetailsByKey(elements.messageList, pressed.key);
        if (details) details.open = !details.open;
      }
    }
    /*
     * 点在可折叠标题（`<summary>`：工具步骤、思考过程、任务面板）上时，别急着恢复渲染。
     *
     * 恢复渲染＝允许 70ms 后那一帧重排；如果它恰好是全条替换，刚被点开的 <details>
     * 会被销毁重建（展开状态靠 override 补回来，但节点已经换了）。这里把暂停窗口
     * 延到 400ms，让这次展开先落地。
     */
    if (pressed) {
      clearTimeout(interactionTimer);
      interactionTimer = setTimeout(releaseMessageInteraction, 400);
      return;
    }
    /*
     * 走 `afterClick`：这次松手之后浏览器还要补一个 click。若在这里同步重排列表，
     * click 的按下目标就被销毁了，浏览器不会派发 click —— 消息里所有按钮/链接都会
     * 「点了没反应」。推到下一个任务，click 先落地。
     */
    releaseMessageInteraction({ afterClick: true });
  });
  document.addEventListener('pointercancel', () => releaseMessageInteraction());
  window.addEventListener('blur', () => releaseMessageInteraction());
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
        // 切对话之前先把 A 的输入存进 A 的草稿槽，否则它会跟着人跑到 B 的输入框里。
        if (previousConversationId !== message.state?.conversation?.id) saveDraft(previousConversationId);
        // 编辑框属于那条消息，切到别的对话就收掉：草稿留着也没地方保存回去。
        if (editingBubbleMessageId && previousConversationId !== message.state?.conversation?.id) {
          editingBubbleMessageId = null; editingBubbleTaskId = null; editingBubbleDraft = '';
        }
        const incoming = message.state; state.conversations = incoming.conversations || []; state.archivedConversations = incoming.archivedConversations || [];
        state.conversation = incoming.conversation; state.messages = incoming.messages || []; state.hasMore = Boolean(incoming.hasMore);
        state.sendOnEnter = incoming.settings?.sendOnEnter !== false; state.pendingAttachments = incoming.pendingAttachments || [];
        state.apiProfiles = incoming.settings?.apiProfiles || []; state.activeApiProfileId = incoming.settings?.activeApiProfileId || ''; state.model = incoming.settings?.model || ''; state.modelOptionsByProfile = incoming.modelOptionsByProfile || {};
        state.permissionPreset = incoming.settings?.permissionPreset || 'askAll'; state.agentMaxSteps = normalizeStepValue(incoming.settings?.agentMaxSteps); state.reasoningEffort = incoming.settings?.reasoningEffort || 'default'; state.internetReference = incoming.settings?.internetReference === true; syncInternetReferenceButton();
        state.permissionPresetPending = false;
        state.skills = incoming.skills || []; state.selectedSkillIds = incoming.selectedSkillIds || [];
        // 没装「本地skill快捷调用」时勾选入口改为引导安装，所以这个标记必须随 state 下发。
        state.quickLaunchInstalled = incoming.quickLaunchInstalled !== false;
        state.mode = incoming.mode || 'agent';
        state.workspaceTrusted = Boolean(incoming.workspaceTrusted); state.agentAvailable = Boolean(incoming.agentAvailable); state.availableToolCount = Number(incoming.availableToolCount) || 0; state.showArchived = Boolean(incoming.showArchived); state.taskTree = incoming.taskTree || (message.streamingConversationId ? state.taskTree : null); state.todos = Array.isArray(incoming.todos) ? incoming.todos : [];
        state.project = incoming.project && typeof incoming.project === 'object'
          ? {
            name: incoming.project.name || null,
            // 徽标要显示「涉及的全部项目」：除了主项目之外的都从这里来。
            others: Array.isArray(incoming.project.others)
              ? incoming.project.others.filter((name) => typeof name === 'string' && name)
              : [],
            bound: Boolean(incoming.project.bound),
          }
          : { name: null, others: [], bound: false };
        {
          const nextRoots = incoming.fileRoots && typeof incoming.fileRoots === 'object'
            ? {
              roots: Array.isArray(incoming.fileRoots.roots) ? incoming.fileRoots.roots.filter((value) => typeof value === 'string' && value) : [],
              preferred: typeof incoming.fileRoots.preferred === 'string' ? incoming.fileRoots.preferred : '',
            }
            : { roots: [], preferred: '' };
          /*
           * 工作区根变了，之前核实的「这个路径对应哪个文件」就不再成立
           * （同一个相对路径换根目录就是另一个文件），缓存必须整份作废。
           */
          const signature = `${nextRoots.preferred}\u0000${nextRoots.roots.join('\u0000')}`;
          if (signature !== fileRootsSignature) {
            fileRootsSignature = signature;
            fileReferenceResolution.clear();
          }
          state.fileRoots = nextRoots;
        }
        state.fileTarget = incoming.fileTarget === 'explorer' || incoming.fileTarget === 'fileManager'
          ? incoming.fileTarget
          : 'finder';
        state.todoArchives = Array.isArray(incoming.todoArchives) ? incoming.todoArchives : [];
        state.todosInterrupted = Boolean(incoming.todosInterrupted);
        state.todosIncomplete = Boolean(incoming.todosIncomplete);
        state.runningConversationIds = Array.isArray(incoming.runningConversationIds) ? incoming.runningConversationIds : [];
        state.pendingApprovals = Array.isArray(incoming.pendingApprovals) ? incoming.pendingApprovals : [];
        elements.modelInput.value = state.model || 'deepseek-flash';
        if (previousConversationId !== incoming.conversation?.id) {
          state.autoFollow = true; state.expandedArchiveId = null; state.archiveRestore = null;
          if (state.titleEditing) finishTitleEdit(false);
          // 切过来了：贴回这条对话自己的草稿（没有就是空的），并让输入框重新量一次高度。
          restoreDraft(incoming.conversation?.id); autoResize();
        }
        setStreaming(Boolean(message.streamingConversationId), message.streamingConversationId);
        // 消息内容没变（例如只切换了预设 / 模型 / 附件）时不再重建整个消息区：
        // 这就是「点一下界面卡半拍」的主要来源。
        const nextSignature = messageListSignature(state.messages, state.conversation?.id);
        renderAll({ skipMessages: nextSignature === renderedMessageSignature });
        break;
      }
      case 'draft': elements.promptInput.value = message.text || ''; saveDraft(state.conversation?.id); state.pendingAttachments = message.attachments || []; renderAttachments(); autoResize(); elements.promptInput.focus(); break;
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
      // 排队消息被编辑：原地换掉那一条的文字，不重建整个列表（否则滚动位置和选区都会丢）。
      case 'messageUpdated': {
        if (message.conversationId !== state.conversation?.id || !message.message) break;
        const index = state.messages.findIndex((item) => item.id === message.message.id);
        if (index < 0) break;
        state.messages[index] = message.message;
        if (!patchMessage(message.message.id)) renderMessages('keep');
        break;
      }
      // 排队消息被删除：把它和它的占位回复一起从界面上撤掉。
      case 'messageRemoved': {
        if (message.conversationId !== state.conversation?.id) break;
        const gone = new Set([message.userMessageId, message.assistantMessageId].filter(Boolean));
        if (!gone.size) break;
        state.messages = state.messages.filter((item) => !gone.has(item.id));
        // 正在编辑的那条被删了：编辑框必须一起收掉，否则保存会指向一条已经不存在的消息。
        if (editingBubbleMessageId && gone.has(editingBubbleMessageId)) {
          editingBubbleMessageId = null; editingBubbleTaskId = null; editingBubbleDraft = '';
        }
        renderMessages('keep');
        break;
      }
      case 'streamDelta': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.content = `${target.content || ''}${message.content || ''}`; target.reasoning = `${target.reasoning || ''}${message.reasoning || ''}`; scheduleMessagePatch(message.messageId); } break; }
      case 'toolExecutions': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.toolExecutions = message.tools || []; scheduleMessagePatch(message.messageId); } break; }
      case 'skillUsage': { if (message.conversationId !== state.conversation?.id) break; const target = state.messages.find((item) => item.id === message.messageId); if (target) { target.usedSkills = message.skills || []; scheduleMessagePatch(message.messageId); } break; }
      case 'messageComplete': { if (message.conversationId !== state.conversation?.id) break; if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; } pendingPatchId = null; const index = state.messages.findIndex((item) => item.id === message.message.id); if (index >= 0) state.messages[index] = message.message; else state.messages.push(message.message); renderMessages('keep'); break; }
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
      // 勾选由扩展侧按「这条对话」算好再回推，界面只照着画。
      case 'skillsChanged':
        state.selectedSkillIds = message.skillIds || [];
        if (Array.isArray(message.skills)) state.skills = message.skills;
        if (typeof message.quickLaunchInstalled === 'boolean') state.quickLaunchInstalled = message.quickLaunchInstalled;
        renderSkills(); renderHeader();
        break;


      case 'permissionPresetPending': state.permissionPresetPending = Boolean(message.active); updateComposerState(); break;
      case 'permissionPresetChanged': state.permissionPreset = message.permissionPreset || 'askAll'; elements.permissionPresetInput.value = state.permissionPreset; syncPermissionHint(); break;
      case 'agentMaxStepsChanged': state.agentMaxSteps = normalizeStepValue(message.agentMaxSteps); ensureStepOption(state.agentMaxSteps); elements.agentMaxStepsInput.value = String(state.agentMaxSteps); break;
      case 'reasoningEffortChanged': state.reasoningEffort = message.reasoningEffort || 'default'; elements.reasoningEffortInput.value = state.reasoningEffort; break;
      case 'internetReferenceChanged': state.internetReference = message.enabled === true; syncInternetReferenceButton(); break;
      case 'taskTreeChanged': {
        if (message.conversationId && message.conversationId !== state.conversation?.id) break;
        const wasPending = pendingBubbleMessageIds(state.taskTree?.nodes);
        state.taskTree = message.taskTree || null;
        renderTaskTree(); updateComposerState();
        syncMessageEditorState();
        /*
         * 排队状态一变，气泡里的「还没执行 + 编辑」入口就要跟着出现/消失。
         * 单独重画受影响的几条，不整段重建：整段重建会把正在编辑的编辑框、
         * 滚动位置和选区一起丢掉。
         */
        const nowPending = pendingBubbleMessageIds(state.taskTree?.nodes);
        if (wasPending.join(',') !== nowPending.join(',')) {
          for (const id of new Set([...wasPending, ...nowPending])) {
            if (id !== editingBubbleMessageId) patchMessage(id);
          }
        }
        break;
      }
      case 'todos': if (message.conversationId && message.conversationId !== state.conversation?.id) break; state.todos = Array.isArray(message.todos) ? message.todos : []; state.todosInterrupted = Boolean(message.interrupted); state.todosIncomplete = Boolean(message.incomplete); renderTodos(); break;
      case 'fileReferencesVerified': applyFileReferenceVerification(message); break;
      case 'todoArchives': if (message.conversationId && message.conversationId !== state.conversation?.id) break; state.todoArchives = Array.isArray(message.todoArchives) ? message.todoArchives : []; renderArchivePanel(); renderTodoArchives(); break;
      case 'voiceInputAllowed': startVoiceRecognition(); break;
      // 扩展要一份布局诊断（面板「右边被切 / 显示不全」时用来取证）。
      case 'layoutReportRequest': post('layoutReport', { report: collectLayoutReport() }); break;
      case 'clipboardWriteResult': finishClipboardWrite(message.requestId, Boolean(message.ok), message.error); break;
      case 'attachmentData': finishAttachmentData(message); break;
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
