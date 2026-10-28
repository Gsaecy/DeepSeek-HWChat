/**
 * HWChat 全局文案表（中文 / 英文）。
 *
 * 设计要点：
 * 1) 单一来源：所有面向用户的字符串都从这里取，UI、通知、错误提示不接受硬编码中文。
 * 2) 同一份词表同时服务三处：
 *    - 扩展宿主（`t()` / `tt()`）
 *    - 两个 webview（把当期语言的扁平表注入 HTML 的 JSON 块，脚本里用 `t()`）
 *    - 测试（`messageTable()` 可断言中英两版键集合完全一致）
 * 3) 缺键时返回键本身而不是抛错：漏译会显示成 `chat.xxx` 这种可识别文本，容易被发现，
 *    而不是让整块界面崩掉。
 *
 * 语言来源：`hwchat.language`，取值 `auto` / `zh` / `en`。
 * `auto` 跟随 VS Code 显示语言（`vscode.env.language`），中文环境用中文，其余用英文。
 */
import * as vscode from 'vscode';

export type Language = 'zh' | 'en';
export type LanguageSetting = 'auto' | Language;

interface Entry {
  zh: string;
  en: string;
}

/** 占位符用 `{name}`，值按字符串插入。 */
export type Vars = Record<string, string | number>;

const DICTIONARY: Record<string, Entry> = {
  // 语言设置本身
  'language.label': { zh: '界面语言', en: 'Interface language' },
  'language.hint': { zh: '切换 HWChat 全部界面与提示语言', en: 'Change the language of all HWChat UI and messages' },
  'language.auto': { zh: '自动（跟随 VS Code）', en: 'Auto (follow VS Code)' },
  'language.zh': { zh: '中文', en: 'Chinese' },
  'language.en': { zh: 'English', en: 'English' },

  // 通用词
  'common.copy': { zh: '复制', en: 'Copy' },
  'common.copied': { zh: '已复制', en: 'Copied' },
  'common.copying': { zh: '复制中…', en: 'Copying…' },
  'common.remove': { zh: '移除', en: 'Remove' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.delete': { zh: '删除', en: 'Delete' },
  'common.save': { zh: '保存', en: 'Save' },
  'common.close': { zh: '关闭', en: 'Close' },
  'common.none': { zh: '无', en: 'None' },
  'common.unknown': { zh: '未知', en: 'Unknown' },
  'common.newChat': { zh: '新对话', en: 'New chat' },
  'common.emptyConversation': { zh: '空对话', en: 'Empty conversation' },
  'common.file': { zh: '文件', en: 'File' },
  'common.seconds': { zh: '秒', en: 's' },
  'common.days': { zh: '天', en: 'days' },
  'common.hours': { zh: '小时', en: 'hours' },
  'common.minutes': { zh: '分钟', en: 'min' },
  'common.listSeparator': { zh: '、', en: ', ' },
  'chat.clipboardAttachment': { zh: '剪贴板附件', en: 'Clipboard attachment' },
  'chat.openAttachmentHint': { zh: '点击在编辑器中查看', en: 'Click to open in the editor' },
  /* 文件引用（正文里被提到的文件）。
     「文件管理器」的名字随平台变：macOS 是 Finder，Windows 是资源管理器，
     其余统一叫文件管理器。拆成独立键，句子模板才能只写一次。 */
  'chat.fileRefTarget.finder': { zh: 'Finder', en: 'Finder' },
  'chat.fileRefTarget.explorer': { zh: '资源管理器', en: 'Explorer' },
  'chat.fileRefTarget.fileManager': { zh: '文件管理器', en: 'file manager' },
  'chat.fileRefReveal': { zh: '在{target}中显示', en: 'Reveal in {target}' },
  /* 这一项是「在 VS Code 自己的资源管理器里定位」，和上面那条「在系统文件管理器里显示」
     是两件事。文案刻意采用 VS Code 自带右键菜单的措辞（Reveal in Explorer View），
     顺带避开一个重名：Windows 上系统文件管理器也叫「资源管理器」，两条若同名会无法区分。 */
  'chat.fileRefRevealInExplorer': { zh: '在资源管理器视图中显示', en: 'Reveal in Explorer View' },
  'chat.fileRefOpenEditor': { zh: '在编辑器中打开', en: 'Open in editor' },
  'chat.fileRefCopyPath': { zh: '复制完整路径', en: 'Copy full path' },
  'chat.fileRefHint': { zh: '左键在编辑器中打开，右键在{target}中显示', en: 'Click to open in the editor, right-click to reveal in {target}' },
  'error.fileRefMissing': { zh: '文件不存在：{path}', en: 'File not found: {path}' },
  'error.fileRefRevealFailed': { zh: '无法在系统中显示该文件：{error}', en: 'Could not reveal the file: {error}' },
  'error.fileRefOutsideWorkspace': { zh: '该文件不在当前工作区内，无法在资源管理器中显示。', en: 'The file is outside the workspace, so it cannot be shown in the Explorer.' },

  'notice.attachmentTaskPrefix': { zh: '处理附件：', en: 'Work with attachments: ' },
  'chat.continuationTitlePrefix': { zh: '继续：', en: 'Continue: ' },
  'chat.untitledTask': { zh: '未命名任务', en: 'Untitled task' },

  // 相对时间
  'time.justNow': { zh: '刚刚', en: 'just now' },
  'time.minutesAgo': { zh: '{count} 分钟前', en: '{count} min ago' },
  'time.hoursAgo': { zh: '{count} 小时前', en: '{count} h ago' },
  'time.daysAgo': { zh: '{count} 天前', en: '{count} d ago' },

  // 权限预设：名称与一句话说明
  'preset.askAll.label': { zh: '每次询问', en: 'Ask every time' },
  'preset.askAll.summary': {
    zh: '读取、写入和命令全部逐次确认；危险命令直接拒绝',
    en: 'Reads, writes and commands all require confirmation; dangerous commands are denied outright',
  },
  'preset.review.label': { zh: '风险操作询问', en: 'Ask on risky actions' },
  'preset.review.summary': {
    zh: '自动读写与常规命令，只有危险命令逐次确认',
    en: 'Automatic reads, writes and regular commands; only dangerous commands need confirmation',
  },
  'preset.autopilot.label': { zh: 'Autopilot', en: 'Autopilot' },
  'preset.autopilot.summary': {
    zh: '全部自动执行（含危险命令），敏感文件仍然禁止',
    en: 'Everything runs automatically, dangerous commands included; sensitive files stay blocked',
  },
  'preset.full.label': { zh: '完全访问', en: 'Full access' },
  'preset.full.summary': {
    zh: '全部自动执行（含危险命令），读取敏感文件时逐次确认',
    en: 'Everything runs automatically, dangerous commands included; reading sensitive files needs confirmation',
  },

  // 权限预设：对照表表头与单元格
  'matrix.preset': { zh: '档位', en: 'Preset' },
  'matrix.read': { zh: '读取', en: 'Read' },
  'matrix.write': { zh: '写入', en: 'Write' },
  'matrix.readOnlyCommand': { zh: '只读命令', en: 'Read-only commands' },
  'matrix.regularCommand': { zh: '正常命令', en: 'Regular commands' },
  'matrix.dangerousCommand': { zh: '危险命令', en: 'Dangerous commands' },
  'matrix.sensitive': { zh: '敏感文件', en: 'Sensitive files' },
  'matrix.hardBoundary': {
    zh: '硬边界不受预设影响：未受信任工作区禁止写入与命令；工作区外路径隔离。危险命令指提权、破坏性删除、磁盘擦写、强制推送、把网络脚本管道给 shell 等操作。',
    en: 'Hard limits ignore the preset: untrusted workspaces block writes and commands, and paths outside the workspace are isolated. Dangerous commands cover privilege escalation, destructive deletion, disk wiping, forced pushes, and piping remote scripts into a shell.',
  },
  'matrix.askEvery': { zh: '逐次确认', en: 'Ask' },
  'matrix.allow': { zh: '自动允许', en: 'Allow' },
  'matrix.allowInWorkspace': { zh: '自动允许（工作区内）', en: 'Allow (in workspace)' },
  'matrix.deny': { zh: '直接拒绝', en: 'Deny' },
  'matrix.block': { zh: '禁止', en: 'Blocked' },

  // 策略取值（下拉框）
  'policy.allow': { zh: '自动允许', en: 'Allow automatically' },
  'policy.ask': { zh: '每次询问', en: 'Ask every time' },
  'policy.deny': { zh: '禁止', en: 'Deny' },
  'policy.dangerous.allow': { zh: '自动允许', en: 'Allow automatically' },
  'policy.dangerous.ask': { zh: '逐次确认', en: 'Ask every time' },
  'policy.dangerous.deny': { zh: '直接拒绝', en: 'Deny outright' },
  'policy.sensitive.allow': { zh: '允许', en: 'Allow' },
  'policy.sensitive.ask': { zh: '逐次确认', en: 'Ask every time' },
  'policy.sensitive.deny': { zh: '禁止', en: 'Blocked' },

  // 对话面板：工具栏与侧栏
  'chat.historyPane': { zh: '对话记录', en: 'Conversations' },
  'chat.closeHistory': { zh: '关闭对话记录', en: 'Close conversations' },
  'chat.newChat': { zh: '新建对话', en: 'New chat' },
  'chat.searchConversations': { zh: '搜索对话', en: 'Search conversations' },
  'chat.showArchived': { zh: '显示归档', en: 'Show archived' },
  'chat.backToConversations': { zh: '返回对话', en: 'Back to conversations' },
  'chat.settings': { zh: '设置', en: 'Settings' },
  'chat.showHistory': { zh: '显示对话记录', en: 'Show conversations' },
  'chat.history': { zh: '对话记录', en: 'Conversations' },
  'chat.ready': { zh: '准备就绪', en: 'Ready' },
  'chat.readyWithTools': { zh: '准备就绪 · {count} 个工具', en: 'Ready · {count} tools' },
  'chat.workspaceMode': { zh: '工作模式', en: 'Work mode' },
  'chat.apiProfile': { zh: 'API 配置', en: 'API profile' },
  'chat.model': { zh: '模型', en: 'Model' },
  'chat.refreshModels': { zh: '刷新模型列表', en: 'Refresh model list' },
  'chat.refreshingModels': { zh: '正在刷新模型列表', en: 'Refreshing model list' },
  'chat.refreshModelsFromApi': { zh: '从 API 刷新模型列表', en: 'Refresh the model list from the API' },
  'chat.selectSkill': { zh: '选择 Skill', en: 'Select skills' },
  'chat.enableSkill': { zh: '启用 Skill', en: 'Enable skills' },
  'chat.archiveCurrent': { zh: '归档当前对话', en: 'Archive this conversation' },
  'chat.archive': { zh: '归档', en: 'Archive' },
  'chat.restoreConversation': { zh: '恢复对话', en: 'Restore conversation' },
  'chat.exportCurrent': { zh: '导出当前对话', en: 'Export this conversation' },
  'chat.export': { zh: '导出', en: 'Export' },
  'chat.openSettings': { zh: '打开设置', en: 'Open settings' },
  'chat.editTitle': { zh: '编辑对话标题', en: 'Edit conversation title' },
  'chat.titleInputLabel': { zh: '对话标题', en: 'Conversation title' },
  'chat.saveTitle': { zh: '保存标题', en: 'Save title' },
  'chat.cancelTitleEdit': { zh: '放弃本次编辑', en: 'Discard changes' },
  'chat.titleSaved': { zh: '标题已更新。', en: 'Title updated.' },
  'chat.titleEditLocked': { zh: '发出第一条消息后才能改标题。', en: 'Send the first message before renaming.' },
  'chat.projectLabel': { zh: '本次对话所属项目：{name}', en: 'Project for this conversation: {name}' },
  'chat.projectLabelMany': {
    zh: '本对话改过 {count} 个项目：{names}',
    en: 'Projects changed in this conversation ({count}): {names}',
  },
  'chat.projectPending': { zh: '项目待建立', en: 'No project yet' },
  'chat.projectPendingHint': {
    zh: '这条对话还没有落到任何工作区文件夹，git 写操作会被拒绝；等它开始改文件（或指定项目）就会自动绑定。',
    en: 'This conversation is not bound to a workspace folder yet, so git writes are refused. It binds automatically once it touches files (or you name a project).',
  },
  'chat.skillsPanelTitle': { zh: '本次对话使用的 Skill', en: 'Skills used in this conversation' },
  'chat.workspaceTrustBadge': { zh: '工作区状态', en: 'Workspace status' },
  'chat.skillsPanelNote': {
    zh: 'route 模式只在命中后通过 load_skill 读取正文，每条回复会显示本轮实际加载的 Skill。',
    en: 'In route mode a skill is only read through load_skill on a match, and every reply lists the skills actually loaded.',
  },
  'chat.skillsSourceInstalled': {
    zh: '勾选状态来自「本地skill快捷调用」。在这里勾选 / 取消只影响本次对话，不会改动它那边的勾选。',
    en: 'Ticks come from the local skill quick-launch extension. Changing a tick here only affects this conversation, never that extension.',
  },
  'chat.skillsSourceMissing': {
    zh: '勾选状态来自「本地skill快捷调用」。没检测到它，所以新对话从空白开始；装好后新建对话会自动套用它的勾选。在这里勾选仍然只影响本次对话。',
    en: 'Ticks come from the local skill quick-launch extension. It is not detected, so new conversations start empty; once installed a new conversation picks its ticks up. Ticking here still only affects this conversation.',
  },
  'chat.skillsInstallBadge': { zh: '未安装', en: 'Not installed' },
  'chat.skillsInstallTitle': {
    zh: '新对话的默认勾选来自「本地skill快捷调用」',
    en: 'New conversations start from “Local Skill Quick Launch”',
  },
  'chat.skillsInstallBody': {
    zh: '装上「本地skill快捷调用」后，它的勾选会决定每个新对话默认启用哪些 Skill（route 模式下命中才读取正文）。现在没有检测到它，所以新对话从空白开始；装好后新建对话即可自动套用。注意：在 HWChat 里取消勾选只作用于当前这条对话，不会改到它的全局清单。',
    en: 'With the local skill quick-launch extension installed, its ticks decide which skills every new conversation starts with (in route mode a skill’s text is read only on a match). It is not detected right now, so new conversations start empty; install it and the next new conversation picks the ticks up. Note that unticking here only affects the current conversation and never edits that global list.',
  },
  'chat.skillsInstallAction': { zh: '打开扩展详情', en: 'Open extension page' },
  'chat.skillsToggleFailed': { zh: '没能保存这条对话的 Skill 勾选，请再点一次。', en: 'Could not save the skill selection for this conversation. Please try again.' },

  // 对话面板：空状态
  'chat.loadOlder': { zh: '加载更早消息', en: 'Load earlier messages' },
  'chat.emptyTitle': { zh: '今天想一起解决什么？', en: 'What should we solve today?' },
  'chat.suggestion.explain': { zh: '解释代码', en: 'Explain code' },
  'chat.suggestion.design': { zh: '设计方案', en: 'Design a plan' },
  'chat.suggestion.review': { zh: '代码审查', en: 'Code review' },
  'chat.suggestion.explainPrompt': { zh: '解释当前选中的代码，并指出潜在问题。', en: 'Explain the selected code and point out potential problems.' },
  'chat.suggestion.designPrompt': { zh: '为这个需求设计一个清晰、可执行的实现方案。', en: 'Design a clear, actionable implementation plan for this requirement.' },
  'chat.suggestion.reviewPrompt': { zh: '检查这段实现中的错误、边界条件和安全风险。', en: 'Review this implementation for bugs, edge cases and security risks.' },

  // 对话面板：任务历史与上下文
  'chat.scrollToBottom': { zh: '回到最新消息', en: 'Jump to latest message' },
  'chat.taskHistory': { zh: '任务历史', en: 'Task history' },
  'chat.taskHistoryNote': {
    zh: '只读摘要 + 按需检索；实际发送的摘要和片段会计入输入 Token',
    en: 'Read-only summary plus on-demand retrieval; whatever is sent counts toward input tokens',
  },
  'chat.detachHistory': { zh: '解除任务历史', en: 'Detach task history' },
  'chat.removeContext': { zh: '移除代码上下文', en: 'Remove code context' },
  'chat.taskTree': { zh: '任务树', en: 'Task tree' },
  'chat.agentRuntimeSettings': { zh: '本轮 Agent 设置', en: 'Agent settings for this turn' },

  // 对话面板：输入区
  'chat.promptPlaceholder': { zh: '询问代码、调试问题或实现思路…', en: 'Ask about code, debug an issue, or describe what to build…' },
  'chat.promptPlaceholderAgent': { zh: '询问代码、调试问题或直接交给 Agent 实现…', en: 'Ask about code, debug an issue, or hand it to the agent…' },
  'chat.promptPlaceholderStreaming': {
    zh: 'Agent 正在执行；新消息会自动合并到当前任务或加入队列…',
    en: 'The agent is running; new messages join the current task or the queue…',
  },
  'chat.promptPlaceholderArchived': { zh: '该对话已归档，恢复后可继续', en: 'This conversation is archived. Restore it to continue.' },
  'chat.messageLabel': { zh: '消息', en: 'Message' },
  'chat.permissionPreset': { zh: '权限预设', en: 'Permission preset' },
  'chat.permissionPresetLabel': { zh: '权限预设：', en: 'Preset: ' },
  'chat.permissionPresetTitle': { zh: '权限预设：{hint}', en: 'Permission preset: {hint}' },
  // 运行中也能改预设，但只对下一次对话生效：界面必须把这件事说清楚，
  // 否则用户放宽权限后看到命令仍被拦，会以为设置没生效。
  'chat.permissionPresetNextTurnHint': { zh: '任务运行中可切换：新预设从下一次对话起生效，当前任务仍按原预设执行。', en: 'Switchable while a task runs: the new preset applies from the next conversation; the running task keeps its own preset.' },
  'chat.permissionPresetNextTurn': { zh: '已切换为「{preset}」。当前任务仍按「{current}」执行，本次任务结束后的下一次对话使用新预设。', en: 'Switched to “{preset}”. The running task keeps “{current}”; the next conversation after it finishes uses the new preset.' },
  'chat.controlsNextSendHint': { zh: '任务运行中可切换：从下一次发送起生效，当前这一轮仍按原设置执行。', en: 'Switchable while a task runs: the change applies from the next message; the current turn keeps its own setting.' },
  'chat.controlsNextSend': { zh: '已改为 {label}。当前这一轮仍按原设置执行，下一次发送起生效。', en: 'Changed to {label}. The current turn keeps its setting; this applies from the next message.' },
  'chat.maxSteps': { zh: '最大步骤', en: 'Max steps' },
  'chat.maxStepsLabel': { zh: '最大步骤：', en: 'Max steps: ' },
  'chat.stepsOption': { zh: '{count} 步', en: '{count} steps' },
  'chat.stepsUnlimited': { zh: '无限制', en: 'Unlimited' },
  'chat.reasoningDepth': { zh: '思考深度', en: 'Reasoning depth' },
  'chat.reasoningDepthLabel': { zh: '思考深度：', en: 'Reasoning: ' },
  // 'default' / 'none' 两档已从下拉框移除（不是「深度」），文案留着是因为旧对话
  // 与不支持思考的模型仍会走到这两个值。
  'chat.reasoning.default': { zh: '默认（模型官方）', en: 'Default (model)' },
  'chat.reasoning.none': { zh: '无', en: 'None' },
  'chat.reasoning.low': { zh: '低', en: 'Low' },
  'chat.reasoning.medium': { zh: '中', en: 'Medium' },
  'chat.reasoning.high': { zh: '高', en: 'High' },
  'chat.reasoning.max': { zh: '最大', en: 'Max' },
  'chat.attachFile': { zh: '添加文件', en: 'Add files' },
  'chat.voiceInput': { zh: '语音输入', en: 'Voice input' },
  'chat.send': { zh: '发送', en: 'Send' },
  'chat.stopGenerating': { zh: '停止生成', en: 'Stop generating' },
  'chat.stop': { zh: '停止', en: 'Stop' },

  // 对话面板：列表与状态
  'chat.noMatchingConversations': { zh: '没有匹配的对话', en: 'No matching conversations' },
  'chat.noArchivedConversations': { zh: '没有已归档的对话', en: 'No archived conversations' },
  'chat.conversationsStoredLocally': { zh: '对话会安全地保存在本机', en: 'Conversations are stored safely on this device' },
  'chat.continuedPrefix': { zh: '续接 · ', en: 'Continued · ' },
  'chat.continueTaskHistory': { zh: '在新对话中续接任务历史', en: 'Continue task history in a new chat' },
  'chat.pin': { zh: '固定', en: 'Pin' },
  'chat.unpin': { zh: '取消固定', en: 'Unpin' },
  'chat.agentRunning': { zh: 'Agent 正在执行', en: 'Agent running' },
  'chat.agentRunningWith': { zh: 'Agent 正在执行：{title}', en: 'Agent running: {title}' },
  'chat.archivedReadOnly': { zh: '已归档 · 只读', en: 'Archived · read-only' },
  'chat.untrustedRestricted': { zh: '未信任 · 写入与命令受限', en: 'Untrusted · writes and commands restricted' },
  'chat.routingCount': { zh: '{count} 条判断中', en: '{count} routing' },
  'chat.queuedCount': { zh: '{count} 条排队', en: '{count} queued' },
  'chat.nodeCount': { zh: '{count} 个节点', en: '{count} nodes' },
  'chat.nodeCountWithQueue': { zh: '{count} 个节点 · {queued} 个排队', en: '{count} nodes · {queued} queued' },
  'chat.taskStatus.active': { zh: '执行中', en: 'Running' },
  'chat.taskStatus.routing': { zh: '判断关联性', en: 'Routing' },
  'chat.taskStatus.merged': { zh: '已合并', en: 'Merged' },
  'chat.taskStatus.queued': { zh: '排队', en: 'Queued' },
  'chat.taskStatus.complete': { zh: '完成', en: 'Done' },
  'chat.taskStatus.cancelled': { zh: '已取消', en: 'Cancelled' },
  'chat.taskStatus.error': { zh: '失败', en: 'Failed' },
  'chat.you': { zh: '你', en: 'You' },
  'chat.copyMessage': { zh: '复制这条消息', en: 'Copy this message' },
  'chat.generating': { zh: '生成中', en: 'Generating' },
  'chat.queuedWaiting': { zh: '已加入任务队列，等待当前分支完成…', en: 'Queued; waiting for the current branch to finish…' },
  'chat.continuing': { zh: '正在继续处理…', en: 'Continuing…' },

  // 对话面板：技能与工具卡片
  'chat.skillsEmpty': {
    zh: '未发现 Skill。可放入 .hwchat/skills 或兼容的 SKILL.md 目录。',
    en: 'No skills found. Add them under .hwchat/skills or a compatible SKILL.md directory.',
  },
  'chat.skillDefaultEnabled': { zh: '默认启用', en: 'Enabled by default' },
  'chat.skillUsed': { zh: '已调用', en: 'Used' },
  'chat.skillQuickInvoke': { zh: '快捷调用', en: 'Quick invoke' },
  'chat.skillsUsedCount': { zh: '本轮调用 {count} 个 Skill', en: '{count} skills used this turn' },
  'chat.calloutDanger': { zh: '危险', en: 'Danger' },
  'chat.calloutImportant': { zh: '重要', en: 'Important' },
  'chat.secretWarnTitle': { zh: '危险：这条消息里有明文凭据', en: 'Danger: this message contains a plaintext credential' },
  'chat.secretWarnItem': { zh: '检测到 {kind}（{length} 个字符）', en: 'Detected {kind} ({length} characters)' },
  'chat.secretWarnFieldItem': { zh: '检测到 {field} 字段的明文值（{length} 个字符）', en: 'Detected a plaintext value for the {field} field ({length} characters)' },
  'chat.secretWarnBody': { zh: '这条消息已随会话保存并发送给模型服务商，风险不在本机而在对方是否留存。请立刻到服务商后台**吊销并重新生成**这把凭据；新值只写进环境变量或系统钥匙串，不要再贴进对话。若已提交进仓库，记得改写历史后再强推。', en: 'This message is saved with the conversation and was sent to the model provider, so the exposure is not local — it depends on whether they retain it. **Revoke and rotate** this credential in the provider console now; keep the new value in an environment variable or the OS keychain and never paste it into a chat again. If it was committed to a repository, rewrite the history before force-pushing.' },
  'chat.secretKind.privateKey': { zh: '私钥', en: 'private key' },
  'chat.secretKind.awsAccessKey': { zh: 'AWS 访问密钥', en: 'AWS access key' },
  'chat.secretKind.githubToken': { zh: 'GitHub 令牌', en: 'GitHub token' },
  'chat.secretKind.anthropicKey': { zh: 'Anthropic API 密钥', en: 'Anthropic API key' },
  'chat.secretKind.openaiKey': { zh: 'OpenAI 风格 API 密钥', en: 'OpenAI-style API key' },
  'chat.secretKind.googleApiKey': { zh: 'Google API 密钥', en: 'Google API key' },
  'chat.secretKind.slackToken': { zh: 'Slack 令牌', en: 'Slack token' },
  'chat.secretKind.bearerToken': { zh: 'Bearer 令牌', en: 'Bearer token' },
  'chat.secretKind.jwt': { zh: 'JWT 令牌', en: 'JWT token' },
  'chat.secretKind.credentialAssignment': { zh: '明文凭据', en: 'plaintext credential' },
  'chat.secretWarnPrivacyTitle': { zh: '危险：这条消息里有个人隐私信息', en: 'Danger: this message contains personal data' },
  'chat.secretWarnMixedTitle': { zh: '危险：这条消息里有明文凭据与个人隐私', en: 'Danger: this message contains credentials and personal data' },
  'chat.secretWarnPrivacyBody': { zh: '这条消息已随会话保存并发送给模型服务商。身份证号、银行卡号、手机号不像密钥那样能「吊销」，发出去就是永久的：请不要把完整号码贴进任何对话；已经发出的，留意后续的异常登录、盗刷与冒名办理，必要时联系银行挂失或报警。今后只发打码后的片段（例如只留后四位）。', en: 'This message is saved with the conversation and was sent to the model provider. ID numbers, bank card numbers and phone numbers cannot be **revoked** the way a key can — once sent, they stay exposed. Never paste a full number into a chat again; if you already did, watch for unusual logins, card fraud and identity misuse, and contact your bank or the police if needed. Send only masked fragments (for example the last four digits).' },
  'chat.secretKind.idCard': { zh: '身份证号', en: 'government ID number' },
  'chat.secretKind.bankCard': { zh: '银行卡号', en: 'bank card number' },
  'chat.secretKind.phoneNumber': { zh: '手机号', en: 'phone number' },
  'chat.toolStack': { zh: '处理过程 · 共 {count} 步', en: 'Process · {count} steps' },
  'chat.toolStackWithFiles': { zh: '处理过程 · 共 {count} 步，改动 {files} 个文件', en: 'Process · {count} steps, {files} files changed' },
  'chat.toolFiles': { zh: '文件：{files}', en: 'Files: {files}' },
  'chat.toolInput': { zh: '提交内容', en: 'Input' },
  'chat.toolOutput': { zh: '返回结果', en: 'Result' },
  'chat.toolCleaned': { zh: '详细缓存已按保留策略清理，摘要仍保留。', en: 'Detailed cache was trimmed by the retention policy; the summary is kept.' },
  'chat.toolWaiting': { zh: '正在等待结果…', en: 'Waiting for the result…' },
  'chat.toolRunningSeconds': { zh: '已运行 {seconds} 秒', en: 'running {seconds}s' },
  'chat.copyCommand': { zh: '复制命令', en: 'Copy command' },
  'chat.copyActualCommand': { zh: '复制实际终端命令', en: 'Copy the actual terminal command' },
  'chat.copyLabel': { zh: '复制{label}', en: 'Copy {label}' },
  'chat.copyTerminalCommand': { zh: '复制终端命令', en: 'Copy terminal command' },
  'chat.copyCode': { zh: '复制代码', en: 'Copy code' },
  'chat.risk.read': { zh: '读取', en: 'Read' },
  'chat.risk.write': { zh: '写入', en: 'Write' },
  'chat.risk.command': { zh: '命令', en: 'Command' },
  'chat.reasoningTitle': { zh: '思考过程', en: 'Reasoning' },
  'chat.reasoningStreaming': { zh: '正在思考…', en: 'Thinking…' },
  'chat.reasoningChars': { zh: '{count} 字 · 点开查看', en: '{count} chars · expand' },
  'chat.terminalCommand': { zh: '终端命令 · {language}', en: 'Terminal · {language}' },
  // 需要用户自己跑的命令：标出在哪跑、用什么跑。位置错是最常见的失败原因。
  'chat.runLocationTag': { zh: '位置：{location}', en: 'Location: {location}' },
  'chat.runLocationTitle': { zh: '这条命令要在这里运行：{location}', en: 'This command runs in: {location}' },
  'chat.runLocationLocal': { zh: '本地终端', en: 'Local terminal' },
  'chat.runLocationServer': { zh: '服务器终端', en: 'Server terminal' },
  'chat.runToolTag': { zh: '工具：{tool}', en: 'Tool: {tool}' },
  'chat.runToolTitle': { zh: '运行工具：{tool}', en: 'Run tool: {tool}' },
  'chat.codeSelection': { zh: '代码选区', en: 'Code selection' },
  'chat.sourceHistory': { zh: '任务历史：{title}', en: 'Task history: {title}' },
  'chat.previousConversation': { zh: '旧对话', en: 'Previous chat' },

  // 对话面板：思考深度能力提示
  'chat.reasoningSupport.unknown': { zh: '当前模型未声明思考深度能力', en: 'This model does not advertise reasoning-depth support' },
  'chat.reasoningSupport.configurable': { zh: '当前模型支持调节思考深度', en: 'This model supports adjusting reasoning depth' },
  'chat.reasoningSupport.unsupported': { zh: '当前模型不支持思考深度设置', en: 'This model does not support reasoning-depth settings' },
  'chat.reasoningSupport.fixed': { zh: '当前模型的思考模式由模型固定', en: 'This model fixes its own reasoning mode' },
  'chat.reasoningUnsupportedShort': { zh: '不支持', en: 'Unsupported' },
  'chat.reasoningFixedShort': { zh: '模型固定', en: 'Fixed by model' },
  'chat.reasoningUnknownShort': { zh: '能力未知', en: 'Unknown' },

  // 对话面板：剪贴板与语音
  'chat.noContentToCopy': { zh: '没有可复制的内容。', en: 'There is nothing to copy.' },
  'chat.clipboardTimeout': { zh: '写入剪贴板超时。', en: 'Timed out writing to the clipboard.' },
  'chat.clipboardFailed': { zh: '复制失败：{error}', en: 'Copy failed: {error}' },
  'chat.clipboardUnavailable': { zh: '无法访问系统剪贴板', en: 'cannot access the system clipboard' },
  'chat.pastedImage': { zh: '粘贴的图片', en: 'Pasted image' },
  'chat.pastedFile': { zh: '粘贴的文件', en: 'Pasted file' },
  'chat.clipboardReadFailed': { zh: '读取剪贴板附件失败：{error}', en: 'Failed to read the clipboard attachment: {error}' },
  'chat.noSpeechRecognition': {
    zh: '当前 VS Code/Webview 不提供语音识别。请启用系统听写或使用支持语音识别的 VS Code 版本。',
    en: 'This VS Code build does not expose speech recognition to the webview. Enable system dictation or use a VS Code version that supports it.',
  },
  'chat.speechFailed': { zh: '语音输入失败：{error}', en: 'Voice input failed: {error}' },
  'chat.speechStartFailed': { zh: '无法开始语音输入：{error}', en: 'Could not start voice input: {error}' },
  'chat.clipboardTruncated': { zh: '剪贴板文字过长，已粘贴前 200 万个字符。', en: 'Clipboard text was too long; only the first 2 million characters were pasted.' },

  // 对话面板：运行时提示
  'chat.modelChanged': { zh: '已切换到 {model}', en: 'Switched to {model}' },
  'chat.profileChanged': { zh: 'API 配置已切换', en: 'API profile switched' },
  'chat.permissionCancelled': { zh: '已取消权限预设更改。', en: 'Permission preset change cancelled.' },
  'chat.queuedNotExecuted': { zh: '该排队任务在当前 Agent 运行结束前尚未执行。', en: 'This queued task did not run before the current agent turn finished.' },
  'chat.emptyResponse': { zh: '接口没有返回正文。', en: 'The API returned no content.' },
  'chat.stopped': { zh: '已停止生成。', en: 'Generation stopped.' },
  'chat.requestFailed': { zh: '请求失败：{error}', en: 'Request failed: {error}' },
  'chat.stoppedBeforeRun': { zh: '任务在执行前被停止。', en: 'The task was stopped before it ran.' },
  'chat.taskNotRun': { zh: '任务未执行：{error}', en: 'Task not executed: {error}' },
  'chat.followUpDone': { zh: '已完成以上步骤，并根据后续消息继续处理。', en: 'Completed the steps above and continued from your follow-up message.' },
  'chat.followUpAdjusted': { zh: '已根据后续消息调整任务。', en: 'Adjusted the task based on your follow-up message.' },
  'chat.modelUnavailable': { zh: '该模型已不可用或已从当前 API 配置中排除。', en: 'That model is unavailable or excluded from the current API profile.' },
  'chat.modelsFetched': { zh: '已从“{profile}”获取 {count} 个 API 模型。{switched}', en: 'Fetched {count} models from “{profile}”.{switched}' },
  'chat.modelSwitchedSuffix': {
    zh: ' 当前模型“{current}”不在接口目录中，已切换到“{next}”。',
    en: ' The current model “{current}” is not in the API catalog, so it switched to “{next}”.',
  },
  'chat.continuationCreated': { zh: '已创建续接对话，并关联“{title}”的只读任务历史。', en: 'Created a continuation chat linked to the read-only task history of “{title}”.' },
  'chat.historyDetached': { zh: '已解除只读任务历史。', en: 'Read-only task history detached.' },
  'chat.noHistorySummary': { zh: '没有可检索的关联任务历史', en: 'No linked task history to search' },
  'chat.noHistoryContent': { zh: '当前对话未关联来源对话。', en: 'This conversation has no linked source conversation.' },
  'chat.searchHistoryLabel': { zh: '检索关联任务历史：{query}', en: 'Search linked task history: {query}' },
  'chat.readHistoryLatestLabel': { zh: '读取关联任务的最近历史', en: 'Read the most recent linked task history' },
  'chat.historySourceDetail': {
    zh: '来源：{title}\n最多返回 {limit} 条只读片段。',
    en: 'Source: {title}\nUp to {limit} read-only excerpts will be returned.',
  },
  'chat.historyHits': { zh: '找到 {count} 条关联任务历史', en: 'Found {count} linked task history entries' },
  'chat.historyMiss': { zh: '未在关联任务历史中找到{query}记录。', en: 'No matching records were found in the linked task history for {query}.' },
  'chat.historyMissQuery': { zh: '“{query}”', en: '"{query}"' },
  'chat.historyMissAvailable': { zh: '可用', en: 'available' },

  // 通知与确认框（扩展宿主）
  'notice.selectCodeFirst': { zh: '请先在编辑器中选择代码。', en: 'Select some code in the editor first.' },
  'notice.selectionTruncated': { zh: '[选区过长，已截断]', en: '[selection too long, truncated]' },
  'notice.explainPrompt': { zh: '请解释这段代码，并指出可能的风险和改进点。', en: 'Explain this code and point out possible risks and improvements.' },
  'notice.addToChat': { zh: '添加到对话', en: 'Add to chat' },
  'notice.filter.textAndCode': { zh: '文本与代码', en: 'Text and code' },
  'notice.filter.allFiles': { zh: '所有文件', en: 'All files' },
  'notice.selectConversationFirst': { zh: '请先选择一段要续接的对话。', en: 'Pick a conversation to continue from first.' },
  'notice.agentBusyNewChat': { zh: 'Agent 正在执行，请先停止当前任务再新建对话。', en: 'The agent is running. Stop the current task before starting a new chat.' },
  'notice.agentBusySwitch': { zh: 'Agent 正在执行，请先停止当前任务再切换对话。', en: 'The agent is running. Stop the current task before switching conversations.' },
  'notice.agentFinishing': { zh: 'Agent 正在收尾，请稍后再次发送。', en: 'The agent is wrapping up. Send again in a moment.' },
  'notice.processAttachments': { zh: '请处理已添加的文件。', en: 'Please work with the attached files.' },
  'notice.privacyRequired': { zh: '需要确认隐私说明后才能向配置的模型接口发送内容。', en: 'Confirm the privacy notice before sending content to the configured model endpoint.' },
  'notice.configureApiKey': { zh: '请先为“{profile}”配置 API Key。', en: 'Configure an API key for “{profile}” first.' },
  'notice.archivedResume': { zh: '该对话已归档，请恢复后继续。', en: 'This conversation is archived. Restore it to continue.' },
  'notice.voiceTitle': { zh: '允许 HWChat 使用语音输入？', en: 'Allow HWChat to use voice input?' },
  'notice.voiceDetail': {
    zh: 'HWChat 只接收语音识别后的文字，不保存音频，也不会把音频写入对话缓存。具体的语音识别服务由 VS Code/Webview 和系统浏览器实现，可能会按你的系统设置处理音频。识别出的文字只有在你点击发送后才会发送给当前 API。',
    en: 'HWChat only receives the transcribed text; it never stores audio or writes it into the conversation cache. Speech recognition itself is provided by the VS Code webview and your system browser, which may process audio according to your OS settings. Transcribed text is only sent to the API after you press send.',
  },
  'notice.voiceAllow': { zh: '允许语音输入', en: 'Allow voice input' },
  'notice.permissionTitle': { zh: '确认更改 Agent 权限预设？', en: 'Change the agent permission preset?' },
  'notice.permissionFull': {
    zh: 'Agent 将可在受信任工作区内自动读写、移动和删除文件，自动运行只读、正常和危险命令（含提权、破坏性删除、强制推送等），读取 .env、密钥、证书等敏感文件时仍会逐次确认。工作区外路径仍被禁止。',
    en: 'The agent will be able to read, write, move and delete files in trusted workspaces without asking, and to run read-only, regular and dangerous commands automatically (including privilege escalation, destructive deletion and forced pushes). Reading .env files, keys and certificates still requires confirmation. Paths outside the workspace remain blocked.',
  },
  'notice.permissionReview': {
    zh: 'Agent 将可在受信任工作区内无需逐次确认地读写、移动和删除文件，并自动运行只读与正常命令（含依赖安装、构建、提交等）。敏感文件仍被禁止，仅危险命令会逐次确认。',
    en: 'The agent will be able to read, write, move and delete files in trusted workspaces without asking, and to run read-only and regular commands automatically (including dependency installs, builds and commits). Sensitive files stay blocked and only dangerous commands require confirmation.',
  },
  'notice.permissionDetail': {
    zh: '{risk}\n\n点击“确认并承担风险”表示你已了解可能造成文件损坏、数据丢失、命令执行或敏感信息暴露，并自行承担相关风险。',
    en: '{risk}\n\nBy choosing “Confirm and accept the risk” you acknowledge possible file damage, data loss, command execution or exposure of sensitive information, and accept that risk yourself.',
  },
  'notice.permissionConfirm': { zh: '确认并承担风险', en: 'Confirm and accept the risk' },
  'notice.agentBusyContinue': { zh: 'Agent 正在执行，请先停止当前任务再续接历史。', en: 'The agent is running. Stop the current task before continuing history.' },
  'notice.agentBusyDetach': { zh: 'Agent 正在执行，暂时不能解除任务历史。', en: 'The agent is running; task history cannot be detached right now.' },
  'notice.agentBusyArchive': { zh: '请先停止当前任务，再归档对话。', en: 'Stop the current task before archiving the conversation.' },
  'notice.agentBusyDelete': { zh: '请先停止当前回复，再删除对话。', en: 'Stop the current reply before deleting the conversation.' },
  'notice.modeBusy': { zh: '当前任务还在执行，模式改动没有生效（仍按原模式运行）。', en: 'The current task is still running, so the mode change did not take effect (it keeps the mode it started with).' },
  'notice.deleteConversationTitle': { zh: '删除这段对话？此操作无法撤销。', en: 'Delete this conversation? This cannot be undone.' },
  'notice.deleteConversationDetail': {
    zh: '有 {count} 段续接对话正在引用这段历史。删除后它们仍保留本地摘要，但无法再按需检索这段完整历史。',
    en: '{count} continuation chats reference this history. They keep their local summaries afterwards, but can no longer search the full history on demand.',
  },
  'notice.exportSaveLabel': { zh: '导出对话', en: 'Export conversation' },
  'notice.exported': { zh: '对话已导出。', en: 'Conversation exported.' },
  'notice.approveCommandTitle': { zh: '允许 Agent 运行命令？', en: 'Allow the agent to run a command?' },
  'notice.approveWriteTitle': { zh: '允许 Agent 修改文件？', en: 'Allow the agent to modify files?' },
  'notice.approveReadTitle': { zh: '允许 Agent 读取文件？', en: 'Allow the agent to read files?' },
  'notice.approveDeny': { zh: '拒绝', en: 'Deny' },
  'notice.approveAllowOnce': { zh: '允许一次', en: 'Allow once' },
  // 面板内审批：模态框会锁死整个 VS Code 窗口（连侧边栏拖拽都做不了），改成输入框上方一张卡片。
  'approval.cardTitle': { zh: '需要你确认后继续', en: 'Needs your approval to continue' },
  'approval.detail': { zh: '查看详情', en: 'Details' },  'approval.pending': { zh: '等待授权', en: 'Waiting for approval' },
  'approval.otherConversation': { zh: '有对话正在等待你的授权，切回该对话即可继续。', en: 'A conversation is waiting for your approval. Switch back to it to continue.' },
  'approval.expired': { zh: '这次授权请求已失效（任务已结束）。', en: 'This approval request expired because the task has ended.' },

  // 设置页：外壳与导航
  'settings.windowTitle': { zh: 'HWChat 设置', en: 'HWChat Settings' },
  'settings.title': { zh: '设置', en: 'Settings' },
  'settings.navLabel': { zh: '设置分组', en: 'Settings sections' },
  'settings.nav.general': { zh: '通用', en: 'General' },
  'settings.nav.connection': { zh: '连接', en: 'Connection' },
  'settings.nav.generation': { zh: '生成', en: 'Generation' },
  'settings.nav.agent': { zh: 'Agent', en: 'Agent' },
  'settings.nav.skills': { zh: 'Skills', en: 'Skills' },
  'settings.nav.privacy': { zh: '权限与隐私', en: 'Permissions & privacy' },
  'settings.nav.storage': { zh: '存储', en: 'Storage' },
  'settings.nativeButton': { zh: 'VS Code 设置', en: 'VS Code settings' },
  'settings.saved': { zh: '所有更改已保存', en: 'All changes saved' },
  'settings.unsaved': { zh: '有未保存的更改', en: 'Unsaved changes' },
  'settings.test': { zh: '测试连接', en: 'Test connection' },
  'settings.testing': { zh: '正在测试…', en: 'Testing…' },
  'settings.save': { zh: '保存', en: 'Save' },
  'settings.general.title': { zh: '通用', en: 'General' },
  'settings.general.languageHint': { zh: '立即生效，不需要重载窗口', en: 'Applies immediately, no window reload needed' },

  // 设置页：连接
  'settings.connection.title': { zh: '连接', en: 'Connection' },
  'settings.keyConfigured': { zh: '已配置', en: 'Configured' },
  'settings.keyUnconfigured': { zh: '未配置', en: 'Not configured' },
  'settings.profile.label': { zh: 'API 配置档', en: 'API profiles' },
  'settings.profile.hint': { zh: '每个服务独立保存地址、模型和密钥', en: 'Each service keeps its own endpoint, models and key' },
  'settings.profile.add': { zh: '新增配置档', en: 'Add profile' },
  'settings.profile.delete': { zh: '删除配置档', en: 'Delete profile' },
  'settings.profileName.label': { zh: '配置名称', en: 'Profile name' },
  'settings.profileName.hint': { zh: '例如 DeepSeek、OpenAI、本地 Ollama', en: 'For example DeepSeek, OpenAI, local Ollama' },
  'settings.apiKey.label': { zh: 'API Key', en: 'API key' },
  'settings.apiKey.hint': { zh: '保存在 VS Code SecretStorage', en: 'Stored in VS Code SecretStorage' },
  'settings.apiKey.savedPlaceholder': { zh: '已安全保存，输入新值可替换', en: 'Saved securely; type a new value to replace it' },
  'settings.apiKey.clearPlaceholder': { zh: '保存后清除', en: 'Cleared on save' },
  'settings.apiKey.clear': { zh: '清除', en: 'Clear' },
  'settings.baseUrl.label': { zh: '接口地址', en: 'Endpoint' },
  'settings.baseUrl.hint': { zh: 'OpenAI 兼容的 Base URL', en: 'OpenAI-compatible base URL' },
  'settings.model.label': { zh: '默认模型', en: 'Default model' },
  'settings.model.hint': { zh: '对话顶部可随时切换；保存后可从 API 刷新官方目录', en: 'Switchable from the chat header; refresh the catalog from the API after saving' },
  'settings.models.label': { zh: '可选模型', en: 'Available models' },
  'settings.models.hint': { zh: '每行一个模型名，对话面板会显示为下拉列表', en: 'One model per line; the chat panel shows them as a dropdown' },
  'settings.headers.label': { zh: '额外请求头', en: 'Extra request headers' },
  'settings.headers.hint': { zh: 'JSON 对象，不包含 Authorization', en: 'JSON object, without Authorization' },
  'settings.timeout.label': { zh: '请求超时', en: 'Request timeout' },
  'settings.timeout.hint': { zh: '10–900 秒', en: '10–900 seconds' },

  // 设置页：生成
  'settings.generation.title': { zh: '生成', en: 'Generation' },
  'settings.temperature.label': { zh: '温度', en: 'Temperature' },
  'settings.temperature.hint': { zh: '0 更稳定，2 更发散', en: '0 is more stable, 2 is more divergent' },
  'settings.maxTokens.label': { zh: '最大输出', en: 'Max output' },
  'settings.maxTokens.hint': { zh: '0 由服务端决定', en: '0 lets the server decide' },
  'settings.contextMessages.label': { zh: '上下文消息', en: 'Context messages' },
  'settings.contextMessages.hint': { zh: '0 表示不限条数，仍有内存保护', en: '0 means unlimited, still bounded by memory guards' },
  'settings.messageUnit': { zh: '条', en: 'msgs' },
  'settings.sendOnEnter.label': { zh: '回车发送', en: 'Send on Enter' },
  'settings.sendOnEnter.hint': { zh: '关闭后使用 ⌘/Ctrl + Enter', en: 'When off, use ⌘/Ctrl + Enter' },
  'settings.systemPrompt.label': { zh: '系统提示词', en: 'System prompt' },

  // 设置页：Agent
  'settings.agent.title': { zh: 'Agent', en: 'Agent' },
  'settings.trustStatePlaceholder': { zh: '工作区状态', en: 'Workspace status' },
  'settings.noWorkspace': { zh: '未打开工作区', en: 'No workspace open' },
  'settings.workspaceTrusted': { zh: '工作区已信任', en: 'Workspace trusted' },
  'settings.workspaceUntrusted': { zh: '工作区未信任', en: 'Workspace untrusted' },
  'settings.defaultMode.label': { zh: '默认模式', en: 'Default mode' },
  'settings.defaultMode.hint': { zh: 'Agent 可执行工具，Plan 仅分析，Chat 仅对话', en: 'Agent can use tools, Plan only analyses, Chat only talks' },
  // 设置页不再提供「新对话默认值」的三个下拉：它们改成固定初始值，按对话在工具条里调。
  'settings.fixedDefaults.title': { zh: '新对话的初始值（固定）', en: 'New-conversation defaults (fixed)' },
  'settings.fixedDefaults.body': { zh: '每一条新对话都从「每次询问」+ 24 步 + 「默认（模型官方）」开始，不受此处或 settings.json 里旧值影响；这三项请在输入框下方的工具条里按对话调整，选择随该对话存档。任务运行中也可以切换权限预设，但只对下一次对话生效。', en: 'Every new conversation starts at “Ask every time”, 24 steps and “Default (model)”, regardless of older values in settings.json. Adjust the three under the composer; the choice is stored with that conversation. The permission preset can be switched while a task runs, but only takes effect for the next conversation.' },
  'settings.maxSteps.label': { zh: '新对话的最大执行步骤', en: 'Max agent steps for new chats' },
  'settings.maxSteps.hint': { zh: '默认 {default} 步，四档可选（含「无限制」）；也可在对话输入框下方即时调整，只影响当前对话', en: 'Defaults to {default} steps; four presets including Unlimited. Also adjustable under the composer, per conversation' },
  'settings.stepsUnit': { zh: '步', en: 'steps' },
  'settings.commandTimeout.label': { zh: '命令超时', en: 'Command timeout' },
  'settings.readLimit.label': { zh: '单文件读取上限', en: 'Per-file read limit' },
  'settings.toolOutputLimit.label': { zh: '工具输出上限', en: 'Tool output limit' },

  // 设置页：Skills
  'settings.skills.title': { zh: 'Skills', en: 'Skills' },
  'settings.skills.count': { zh: '{count} 个', en: '{count}' },
  'settings.skills.rescan': { zh: '重新扫描', en: 'Rescan' },
  'settings.skills.openFolder': { zh: '打开用户 Skill 目录', en: 'Open user skill folder' },
  'settings.skills.empty': {
    zh: '未发现 Skill。支持 .hwchat/skills/*.md、.agents/skills/**/SKILL.md 和 .claude/skills/**/SKILL.md。',
    en: 'No skills found. Supported: .hwchat/skills/*.md, .agents/skills/**/SKILL.md and .claude/skills/**/SKILL.md.',
  },

  // 设置页：权限与隐私
  'settings.privacy.title': { zh: '权限与隐私', en: 'Permissions & privacy' },
  'settings.privacy.noTelemetry': { zh: '无遥测', en: 'No telemetry' },
  'settings.privacy.dataFlow': { zh: '数据流向', en: 'Data flow' },
  'settings.privacy.dataFlowBody': {
    zh: '消息、明确添加的文件、启用的 Skill 和必要的工具结果仅发送到你配置的模型接口。API Key 保存在 VS Code SecretStorage；历史和审计记录保存在本机。',
    en: 'Messages, explicitly attached files, enabled skills and necessary tool results are only sent to the model endpoint you configure. API keys are stored in VS Code SecretStorage; history and audit records stay on this device.',
  },
  'settings.privacy.presetLabel': { zh: '权限预设', en: 'Permission preset' },
  'settings.privacy.readFile': { zh: '读取文件', en: 'Read files' },
  'settings.privacy.readFileHint': { zh: '敏感文件仍受单独策略保护', en: 'Sensitive files are still guarded separately' },
  'settings.privacy.writeFile': { zh: '修改文件', en: 'Modify files' },
  'settings.privacy.writeFileHint': { zh: '未受信任工作区始终禁止', en: 'Always blocked in untrusted workspaces' },
  'settings.privacy.command': { zh: '运行命令', en: 'Run commands' },
  'settings.privacy.commandHint': { zh: '只读命令与正常命令；由预设决定，此处只读展示', en: 'Read-only and regular commands; decided by the preset, shown read-only here' },
  'settings.privacy.dangerous': { zh: '危险命令', en: 'Dangerous commands' },
  'settings.privacy.dangerousHint': { zh: '由预设决定，此处只读展示；提权、破坏性删除、强制推送等', en: 'Decided by the preset, shown read-only here; escalation, destructive deletion, forced pushes' },
  'settings.privacy.sensitive': { zh: '敏感文件', en: 'Sensitive files' },
  'settings.privacy.sensitiveHint': { zh: '由预设决定，此处只读展示；.env、证书、密钥和常见凭据目录', en: 'Decided by the preset, shown read-only here; .env, certificates, keys and common credential paths' },
  'settings.privacy.audit': { zh: '审计记录保留', en: 'Audit retention' },
  'settings.privacy.auditHint': { zh: '只记录工具、结果摘要和审批状态，不记录 API Key', en: 'Only tools, result summaries and approval states are recorded, never API keys' },
  'settings.dangerZone.title': { zh: '删除本地数据', en: 'Delete local data' },
  'settings.dangerZone.hint': { zh: '删除全部对话和 Agent 审计记录，不删除 API Key', en: 'Deletes all conversations and agent audit records, not API keys' },
  'settings.dangerZone.action': { zh: '全部删除', en: 'Delete all' },

  // 设置页：存储
  'settings.storage.title': { zh: '存储', en: 'Storage' },
  'settings.storage.conversations': { zh: '对话', en: 'conversations' },
  'settings.storage.messages': { zh: '消息', en: 'messages' },
  'settings.storage.history': { zh: '对话保留', en: 'Conversation retention' },
  'settings.storage.historyHint': { zh: '固定的对话不会过期', en: 'Pinned conversations never expire' },
  'settings.storage.taskCache': { zh: '任务缓存保留', en: 'Task cache retention' },
  'settings.storage.taskCacheHint': { zh: '到期后保留正文与执行摘要，移除思考、工具详情和附件正文', en: 'After expiry the reply and step summary stay; reasoning, tool details and attachment bodies are removed' },
  'settings.storage.budget': { zh: '缓存上限', en: 'Cache budget' },
  'settings.storage.budgetHint': { zh: '超限后淘汰最旧的未固定对话', en: 'Evicts the oldest unpinned conversations when exceeded' },
  'settings.storage.cleanupInterval': { zh: '清理间隔', en: 'Cleanup interval' },
  'settings.storage.cleanupNow': { zh: '立即清理', en: 'Clean up now' },
  'settings.storage.exportAll': { zh: '导出全部对话', en: 'Export all conversations' },

  // 设置页：通知与确认
  'settings.savedToast': { zh: '设置已保存。', en: 'Settings saved.' },
  'settings.savedWithPresetCancelled': { zh: '其它设置已保存；权限预设更改已取消。', en: 'Other settings saved; the permission preset change was cancelled.' },
  'settings.connectOk': { zh: '连接成功。', en: 'Connection succeeded.' },
  'settings.cleanupDone': { zh: '清理完成：瘦身 {compacted} 条，删除 {deleted} 个过期对话。', en: 'Cleanup done: {compacted} messages trimmed, {deleted} expired conversations removed.' },
  'settings.exportedAll': { zh: '全部对话已导出。', en: 'All conversations exported.' },
  'settings.busy': { zh: '当前有正在执行的 Agent 任务，请先停止任务。', en: 'An agent task is still running. Stop it first.' },
  'settings.clearConfirmTitle': { zh: '删除 HWChat 的全部本地对话和 Agent 审计记录？', en: 'Delete all local HWChat conversations and agent audit records?' },
  'settings.clearConfirmDetail': { zh: 'API Key 不会被删除。此操作无法撤销，建议先导出记录。', en: 'API keys are not deleted. This cannot be undone; export your records first.' },
  'settings.cleared': { zh: '本地对话和审计记录已删除。', en: 'Local conversations and audit records deleted.' },
  'settings.exportAllSaveLabel': { zh: '导出全部记录', en: 'Export all records' },
  'settings.newProfileName': { zh: '新 API', en: 'New API' },

  // 校验错误
  'error.headersInvalidJson': { zh: '额外请求头不是有效的 JSON。', en: 'Extra request headers are not valid JSON.' },
  'error.headersNotObject': { zh: '额外请求头必须是 JSON 对象。', en: 'Extra request headers must be a JSON object.' },
  'error.headerValueNotString': { zh: '请求头 {key} 的值必须是字符串。', en: 'The value of header {key} must be a string.' },
  'error.profileIncomplete': { zh: '请补全每个 API 配置档的名称和接口地址。', en: 'Fill in the name and endpoint for every API profile.' },
  'error.profileNeedsModel': { zh: '当前 API 配置档至少需要一个可选模型。', en: 'Each API profile needs at least one available model.' },
  'error.keepOneProfile': { zh: '至少保留一个 API 配置档。', en: 'Keep at least one API profile.' },
  'error.profileInvalid': { zh: 'API 配置档的名称和 ID 必须有效且不可重复。', en: 'API profile names and IDs must be valid and unique.' },
  'error.profileHeaders': { zh: '{name} 的额外请求头必须是 JSON 对象。', en: 'The extra request headers of {name} must be a JSON object.' },
  'error.profileMissing': { zh: '当前 API 配置档不存在。', en: 'The current API profile does not exist.' },
  'error.modelEmpty': { zh: '模型名称不能为空。', en: 'The model name cannot be empty.' },
  'error.defaultModeInvalid': { zh: '默认模式无效。', en: 'Invalid default mode.' },
  'error.maxStepsInvalid': { zh: '最大执行步骤必须是 1 到 200 之间的整数（不再支持 0 = 不限制）。', en: 'Max agent steps must be an integer between 1 and 200 (0 = unlimited is no longer supported).' },
  'error.reasoningInvalid': { zh: '思考层级无效。', en: 'Invalid reasoning level.' },
  'error.presetInvalid': { zh: '权限预设无效。', en: 'Invalid permission preset.' },
  'error.policyInvalid': { zh: '{key} 权限策略无效。', en: 'Invalid policy for {key}.' },
  'error.endpointHttps': { zh: '远程模型接口必须使用 HTTPS；本机 localhost 可使用 HTTP。', en: 'Remote model endpoints must use HTTPS; localhost may use HTTP.' },
  'error.tooManyFiles': { zh: '单次最多添加 20 个文件。', en: 'You can add at most 20 files at once.' },
  'error.attachmentsTooLargeKb': { zh: '附件总量超过 {kb} KB 上限。', en: 'Attachments exceed the {kb} KB limit.' },
  'error.tooManyAttachments': { zh: '单次最多添加 20 个附件。', en: 'You can add at most 20 attachments at once.' },
  'error.clipboardSizeMismatch': { zh: '剪贴板文件大小校验失败。', en: 'Clipboard file size verification failed.' },
  'error.fileTooLargeMb': { zh: '文件过大，上限为 {mb} MB。', en: 'File too large; the limit is {mb} MB.' },
  'error.attachmentCapacity': { zh: '附件总量超过本轮容量上限。', en: 'Attachments exceed the capacity for this turn.' },
  'error.allModelsInvalid': { zh: '接口返回的模型均已过期、不可用或被当前配置排除。', en: 'Every model returned by the API is expired, unavailable, or excluded by the current profile.' },
  'error.sourceConversationMissing': { zh: '来源对话不存在，可能已被删除或清理。', en: 'The source conversation no longer exists; it may have been deleted or cleaned up.' },
  'error.clipboardBase64': { zh: '剪贴板附件不是有效的 Base64 数据。', en: 'The clipboard attachment is not valid Base64 data.' },
  'error.clipboardEmpty': { zh: '剪贴板附件为空。', en: 'The clipboard attachment is empty.' },
  'error.clipboardBinary': { zh: '该剪贴板文件是二进制文件；图片请使用图像格式粘贴。', en: 'The clipboard file is binary; paste images in an image format instead.' },
  'error.attachmentUnavailable': { zh: '这个附件的内容已被清理，无法再打开。', en: 'The body of this attachment has been cleared and can no longer be opened.' },
  'error.attachmentOpenFailed': { zh: '无法打开附件：{error}', en: 'Could not open the attachment: {error}' },

  // 历史视图
  'history.pinned': { zh: '固定 · ', en: 'Pinned · ' },
  'history.open': { zh: '打开对话', en: 'Open conversation' },

  // 扩展命令与通知
  'ext.skillsFound': { zh: '已发现 {count} 个 Skill。', en: 'Found {count} skills.' },
  'ext.permissionScope': { zh: '生效权限预设：{preset}（各层来源见 HWChat 输出面板）', en: 'Effective permission preset: {preset} (per-layer sources in the HWChat output channel)' },
  'ext.resourceStats': { zh: '搜索：活动 {active}、排队 {queued}；命令：活动 {commands}。详细计数已写入 HWChat 输出面板。', en: 'Searches: {active} active, {queued} queued; commands: {commands} active. Full counters were written to the HWChat output panel.' },
  'ext.privacyTitle': {
    zh: 'HWChat 会将你发送的消息、已选择的文件内容和必要的工具结果发送到你在设置中配置的模型接口。对话、Skill 和审计记录默认只保存在本机；扩展不上传遥测。Agent 的写入和命令操作仍需按权限策略审批。',
    en: 'HWChat sends your messages, the file content you select and necessary tool results to the model endpoint you configure. Conversations, skills and audit records stay on this device by default; the extension uploads no telemetry. Agent writes and commands still go through the permission policy.',
  },
  'ext.privacyDetail': { zh: '请确认你了解并同意这项数据流向后继续。可在 HWChat 设置中清除本地记录。', en: 'Confirm that you understand and accept this data flow to continue. Local records can be cleared in HWChat settings.' },
  'ext.privacyAgree': { zh: '同意并继续', en: 'Agree and continue' },
  'ext.apiKeyTitle': { zh: '设置 {profile} API Key', en: 'Set the API key for {profile}' },
  'ext.apiKeyPrompt': { zh: '密钥将安全保存在 VS Code SecretStorage 中。', en: 'The key will be stored securely in VS Code SecretStorage.' },
  'ext.apiKeyEmpty': { zh: 'API Key 不能为空。', en: 'The API key cannot be empty.' },
  'ext.apiKeySaved': { zh: 'HWChat API Key 已保存。', en: 'HWChat API key saved.' },
  'ext.exported': { zh: 'HWChat 对话记录已导出。', en: 'HWChat conversation history exported.' },
  'ext.exportAllLabel': { zh: '导出全部对话', en: 'Export all conversations' },

  // 内置工具：描述与参数说明（会作为工具定义发给模型）
  'tool.listWorkspaceRoots.description': { zh: '列出当前 VS Code 多根工作区中的全部根文件夹。询问“工作区有哪些项目”时优先使用。', en: 'List every root folder in the current VS Code multi-root workspace. Prefer this when asked what projects the workspace contains.' },
  'tool.listDirectory.description': { zh: '列出工作区内一个目录的直接子项，不递归。支持工作区内绝对路径和多根工作区路径。', en: 'List the direct children of a directory inside the workspace, without recursing. Accepts in-workspace absolute paths and multi-root paths.' },
  'tool.listDirectory.pathParam': { zh: '目录路径；默认当前首个工作区根目录', en: 'Directory path; defaults to the first workspace root' },
  'tool.listFiles.description': { zh: '列出工作区内匹配的文件路径，不读取文件内容。', en: 'List matching file paths inside the workspace without reading their contents.' },
  'tool.listFiles.globParam': { zh: '相对工作区的 glob，例如 src/**/*.ts', en: 'Workspace-relative glob, for example src/**/*.ts' },
  'tool.searchFiles.description': { zh: '在工作区文本文件中搜索字符串，返回匹配文件和行号。', en: 'Search text files in the workspace and return matching files and line numbers.' },
  'tool.readFile.description': { zh: '读取工作区内一个文本文件。敏感文件默认禁止。', en: 'Read a text file inside the workspace. Sensitive files are blocked by default.' },
  'tool.openFile.description': { zh: '直接在 VS Code 编辑器中打开工作区内文件。不运行终端命令；用户要求打开文件时优先使用。', en: 'Open a workspace file directly in the VS Code editor. Runs no terminal command; prefer it when the user asks to open a file.' },
  'tool.openFile.pathParam': { zh: '工作区相对路径、带工作区根目录名的路径，或工作区内绝对路径', en: 'Workspace-relative path, a path prefixed with a workspace root name, or an in-workspace absolute path' },
  'tool.openFile.previewParam': { zh: '是否以预览标签打开，默认 true', en: 'Open as a preview tab; defaults to true' },
  'tool.getDiagnostics.description': { zh: '读取 VS Code 当前已知的语法和类型诊断。', en: 'Read the syntax and type diagnostics VS Code currently knows about.' },
  'tool.writeFile.description': { zh: '创建或完整替换一个工作区文本文件。写入前必须经过权限检查。', en: 'Create or fully replace a workspace text file. The write must pass the permission check first.' },
  'tool.replaceInFile.description': { zh: '在一个工作区文本文件中进行精确文本替换，适合小范围修改。', en: 'Perform an exact text replacement in a workspace file; suited to small edits.' },
  'tool.renameFile.description': { zh: '重命名或移动工作区内的单个文件。', en: 'Rename or move a single file inside the workspace.' },
  'tool.deleteFile.description': { zh: '将工作区内的单个文件移到系统废纸篓。不能删除目录。', en: 'Move a single workspace file to the system trash. Directories cannot be deleted.' },
  'tool.runCommand.description': { zh: '在本次对话所属项目里运行命令（cwd 缺省为该项目的根目录），返回截断后的输出。不得借此访问工作区外路径。git 写操作（add/commit/push 等）只有在用户明确要求或已启用技能规则要求时才允许。', en: 'Run a command inside this conversation\'s project (cwd defaults to that project root) and return truncated output. It must not be used to reach paths outside the workspace. git writes (add/commit/push, …) are allowed only when the user explicitly asked or an enabled skill rule requires it.' },
  'tool.searchHistoryDescription': { zh: '只读检索当前对话已关联的旧任务历史及其上游来源。用于确认以前做过的修改、失败方案、用户纠正和验证结果；不能读取任意其他对话，也不能修改历史。', en: 'Read-only search of the previous task history linked to this conversation and its upstream sources. Use it to confirm earlier edits, rejected approaches, user corrections and verification results. It cannot read arbitrary other conversations or modify history.' },
  'tool.searchHistoryQueryParam': { zh: '要查找的文件名、错误、决策、功能或关键词；留空时返回最近记录', en: 'File name, error, decision, feature or keyword to look for; leave empty to return the most recent records' },
  'tool.searchHistoryLimitParam': { zh: '最多返回的历史片段数，默认 10', en: 'Maximum number of history excerpts to return; defaults to 10' },

  // 内置工具：执行摘要与状态
  'tool.invalidArguments': { zh: '{name} 参数无效', en: '{name}: invalid arguments' },
  'tool.executionFailed': { zh: '{name} 执行失败', en: '{name} failed' },
  'tool.summaryFailed': { zh: '{summary}失败', en: '{summary} — failed' },
  'tool.unknownTool': { zh: '未知工具：{name}', en: 'Unknown tool: {name}' },
  'tool.deniedByUser': { zh: '用户拒绝了这次操作。', en: 'The user denied this operation.' },
  'tool.deniedByUserTool': { zh: '用户拒绝了这次工具调用。', en: 'The user denied this tool call.' },
  'tool.policyDenied': { zh: '当前权限策略禁止该{kind}工具。', en: 'The current permission policy blocks this {kind} tool.' },
  'tool.policyKind.read': { zh: '读取', en: 'read' },
  'tool.policyKind.write': { zh: '写入', en: 'write' },
  'tool.policyKind.command': { zh: '命令', en: 'command' },
  'tool.planModeReadOnly': { zh: '规划模式只允许只读工具。', en: 'Plan mode only allows read-only tools.' },
  'tool.untrustedWorkspace': { zh: '当前工作区未受信任，已阻止可能修改文件或执行命令的工具。', en: 'The workspace is untrusted, so tools that could modify files or run commands were blocked.' },
  'tool.fileTooLarge': { zh: '文件过大（{size}），上限为 {max}。', en: 'File too large ({size}); the limit is {max}.' },
  'tool.filesFound': { zh: '找到 {count} 个文件', en: 'Found {count} files' },
  'tool.filesFoundTruncated': { zh: '找到 {count} 个文件（已达上限，可能还有更多）', en: 'Found {count} files (limit reached; there may be more)' },
  'tool.filesTruncatedNote': { zh: '\n… 结果已达文件上限，列表不完整；请用根目录名前缀或更具体的 glob 缩小范围。', en: '\n… The file limit was reached, so the list is incomplete. Narrow it with a root-name prefix or a more specific glob.' },
  'tool.noMatchingFiles': { zh: '没有匹配文件。', en: 'No matching files.' },
  'tool.workspaceRootsFound': { zh: '找到 {count} 个工作区根目录', en: 'Found {count} workspace roots' },
  'tool.workspaceRootsListed': { zh: '列出 {count} 个工作区根目录', en: 'Listed {count} workspace roots' },
  'tool.noWorkspaceOpen': { zh: '当前没有打开的工作区。', en: 'No workspace is currently open.' },
  'tool.folderItemCountSuffix': { zh: '（{count} 项）', en: ' ({count} items)' },
  'tool.notDirectory': { zh: '{path} 不是目录。', en: '{path} is not a directory.' },
  'tool.listed': { zh: '列出 {path}（{count} 项）', en: 'Listed {path} ({count} items)' },
  'tool.directoryEmpty': { zh: '目录为空。', en: 'The directory is empty.' },
  'tool.queryEmpty': { zh: 'query 不能为空。', en: 'query cannot be empty.' },
  'tool.searchRangeNote': { zh: '文件列表已达上限，搜索范围不完整；请用根目录名前缀或更具体的 glob 缩小范围。', en: 'The file list hit its limit, so the search was incomplete. Narrow it with a root-name prefix or a more specific glob.' },
  'tool.searchBudgetNote': { zh: '只扫描了前 {count} 个文件，搜索范围不完整。', en: 'Only the first {count} files were scanned, so the search was incomplete.' },
  'tool.searchByteBudgetNote': { zh: '本次搜索已读取到 {size} 上限，搜索范围不完整；请用更具体的 query 或 glob 缩小范围。', en: 'This search hit the {size} read budget, so the scope was incomplete. Narrow it with a more specific query or glob.' },
  'tool.searchQueueFull': { zh: '搜索队列已满（上限 {count} 个等待任务），本次搜索未执行。请等待当前搜索结束后再试。', en: 'The search queue is full ({count} waiting), so this search was not run. Wait for the current search to finish and try again.' },
  'tool.searchResourceBusy': { zh: '系统暂时无法启动搜索进程（{code}），已按上限重试 {attempts} 次仍失败。请关闭其他窗口或占用资源的进程后重试，或改用更具体的 glob 缩小范围。', en: 'The system could not start a search process ({code}); retried {attempts} times with backoff and gave up. Close other windows or resource-heavy processes and retry, or narrow the scope with a more specific glob.' },
  'tool.cancelled': { zh: '任务已取消，工具调用已停止。', en: 'The task was cancelled, so the tool call stopped.' },
  'tool.noMatches': { zh: '没有匹配。', en: 'No matches.' },
  'tool.matchesFound': { zh: '找到 {count} 处匹配', en: 'Found {count} matches' },
  'tool.readFileTooLarge': { zh: '文件过大（{size}），已超过 {max} 上限；请提高读取上限或先用搜索定位内容。', en: 'File too large ({size}); it exceeds the {max} limit. Raise the read limit or locate the content with a search first.' },
  'tool.readSummary': { zh: '读取 {path}（{size}）', en: 'Read {path} ({size})' },
  'tool.openFileOnlyFiles': { zh: 'open_file 只能打开文件。', en: 'open_file can only open files.' },
  'tool.openedInEditor': { zh: '已在编辑器中打开 {path}', en: 'Opened {path} in the editor' },
  'tool.openedInEditorContent': { zh: '文件已通过 VS Code 原生编辑器打开。', en: 'The file was opened in the native VS Code editor.' },
  'tool.diagnosticsRead': { zh: '读取 {count} 条诊断', en: 'Read {count} diagnostics' },
  'tool.noDiagnostics': { zh: '没有已知诊断。', en: 'No known diagnostics.' },
  'tool.writeTooLarge': { zh: '写入内容过大，超过单文件安全上限。', en: 'The content to write exceeds the per-file safety limit.' },
  'tool.updatedFile': { zh: '更新 {path}：{delta}', en: 'Updated {path}: {delta}' },
  'tool.updatedFileNoDelta': { zh: '更新 {path}', en: 'Updated {path}' },
  'tool.createdFile': { zh: '创建 {path}', en: 'Created {path}' },
  'tool.fileWritten': { zh: '文件已写入。', en: 'The file was written.' },
  'tool.oldTextEmpty': { zh: 'oldText 不能为空。', en: 'oldText cannot be empty.' },
  'tool.replaceTooLarge': { zh: '文件过大（{size}），精确替换上限为 {max}。', en: 'File too large ({size}); the exact-replace limit is {max}.' },
  'tool.oldTextMissing': { zh: 'oldText 在文件中不存在，未执行修改。', en: 'oldText does not exist in the file, so nothing was changed.' },
  'tool.oldTextMultiple': { zh: 'oldText 出现 {count} 次，请提供更精确的文本或明确 replaceAll=true。', en: 'oldText appears {count} times; provide more precise text or set replaceAll=true.' },
  'tool.replaceTooLargeAfter': { zh: '替换后的文件预计超过单文件安全上限。', en: 'The file would exceed the per-file safety limit after the replacement.' },
  'tool.replaceSummary': { zh: '修改 {path}：替换 {count} 处文本', en: 'Edited {path}: {count} replacement(s)' },
  'tool.renameOnlyFiles': { zh: 'rename_file 只能移动普通文件。', en: 'rename_file can only move regular files.' },
  'tool.movedFile': { zh: '移动 {from} → {to}', en: 'Moved {from} → {to}' },
  'tool.deleteOnlyFiles': { zh: 'delete_file 只能删除普通文件，目录删除被禁止。', en: 'delete_file can only delete regular files; deleting directories is forbidden.' },
  'tool.trashedFile': { zh: '已将 {path} 移到废纸篓', en: 'Moved {path} to the trash' },
  'tool.commandEmpty': { zh: '命令为空或过长。', en: 'The command is empty or too long.' },
  'tool.commandTimeout': { zh: '命令超时（{seconds} 秒）', en: 'Command timed out ({seconds}s)' },
  'tool.commandCancelled': { zh: '命令已取消，相关子进程正在结束。', en: 'The command was cancelled and its process tree is being stopped.' },
  'tool.commandQueueFull': { zh: '同时运行的命令已达上限（{count} 个等待中），本次命令未执行。请等待当前命令结束后再试。', en: 'Too many commands are already running ({count} waiting), so this command was not run. Wait for the current command to finish and try again.' },
  'tool.commandExit': { zh: '命令退出码 {code}', en: 'Command exit code {code}' },
  'tool.noOutput': { zh: '(无输出)', en: '(no output)' },
  'tool.commandStallHint': { zh: '已 {seconds} 秒无输出，可能在等终端输入', en: 'No output for {seconds}s — may be waiting for terminal input' },
  'tool.commandTimeoutRunning': { zh: '已超时（{seconds} 秒），正在结束进程…', en: 'Timed out ({seconds}s) — stopping the process…' },
  'tool.toolNotAllowed': { zh: '工具 {name} 未被允许。', en: 'Tool {name} is not allowed.' },
  'tool.dangerousDenied': { zh: '命令包含高风险或破坏性操作（提权、破坏性删除、磁盘擦写、强制推送等），当前权限预设禁止执行。需要执行时请切换到“Autopilot”或“完全访问”预设。', en: 'The command contains high-risk or destructive operations (privilege escalation, destructive deletion, disk wiping, forced pushes). The current preset forbids running it; switch to “Autopilot” or “Full access” to allow it.' },
  'tool.policyDeniedTool': { zh: '当前权限策略禁止 {name}。', en: 'The current permission policy blocks {name}.' },
  'tool.planModeReadOnlyTool': { zh: '规划模式只允许只读分析。', en: 'Plan mode only allows read-only analysis.' },
  'tool.gitWriteNotRequested': { zh: '已阻止 git {operation}：本次对话中用户没有要求提交或推送，HWChat 不会主动提交。请先用一句话向用户确认；用户明确要求后（或启用包含提交规则的技能后）再执行。', en: 'Blocked `git {operation}`: the user has not asked to commit or push in this conversation, and HWChat never commits on its own. Ask the user first; retry after they explicitly request it, or after a skill with a commit rule is enabled.' },
  'tool.gitProjectUnknown': { zh: '本次对话还没有确定属于哪个项目，无法执行 git 写操作。请先修改该项目的文件，或在 run_command 里显式传入 cwd=<项目根> 后重试。', en: 'This conversation is not bound to a project yet, so git write operations are refused. Edit a file in that project first, or pass an explicit cwd=<project root> to run_command and retry.' },
  'tool.gitNotRepository': { zh: '上一级路径里没有 git 仓库（{path}），无法执行写操作。', en: 'No git repository found above {path}; the write operation was refused.' },
  'tool.gitProjectMismatch': { zh: '已阻止跨项目 git 操作：命令会作用于仓库 {repo}，而本次对话绑定的是项目 {project}。请传入该项目内的 cwd 重试。', en: 'Blocked a cross-project git operation: the command targets repository {repo}, but this conversation is bound to {project}. Retry with a cwd inside that project.' },
  'tool.gitForeignProject': { zh: '已阻止 git 操作：仓库 {repo} 里还包含另一个工作区项目 {project}，一次 git add/commit 会把它的改动一起提交。请在该项目自己的对话里操作。', en: 'Blocked the git operation: repository {repo} also contains another workspace project ({project}), so a single git add/commit would include its changes. Run it from that project\'s own conversation.' },
  'tool.versionBumpNotAuthorized': { zh: '已阻止修改版本号：{file} 的 version 想从 {from} 改成 {to}，但本次对话中用户没有要求升级版本，HWChat 不会主动升版本。请先停下改动，在任务全部完成后用一句话询问用户是否要升版本（长任务在阶段完成时再问），得到明确同意后再改。', en: 'Blocked the version bump: {file} would change version {from} → {to}, but the user has not asked for a version bump in this conversation, and HWChat never bumps versions on its own. Stop here and ask the user in one sentence — after all work in this conversation is finished (or at a phase boundary for a long task) — then proceed only after an explicit yes.' },
  'tool.versionBumpCommandNotAuthorized': { zh: '已阻止执行 `{command}`：它会改写项目版本号，而本次对话中用户没有要求升级版本，HWChat 不会主动升版本。请先完成手上的任务，再询问用户是否要升版本；用户明确同意后再执行。', en: 'Blocked `{command}`: it rewrites the project version, but the user has not asked for a version bump in this conversation, and HWChat never bumps versions on its own. Finish the current work first, then ask the user; run it only after an explicit yes.' },
  'tool.versionBumpNotRequested': { zh: '已阻止版本升级操作：本次对话中用户没有要求升级版本，HWChat 不会主动升版本。请先完成手上的任务，再询问用户是否要升版本；用户明确同意后再执行。', en: 'Blocked a version-bump operation: the user has not asked for a version bump in this conversation, and HWChat never bumps versions on its own. Finish the current work first, then ask the user; proceed only after an explicit yes.' },
  'tool.untrustedWrite': { zh: '当前工作区未受信任，文件写入和命令执行已禁用。请先信任工作区。', en: 'The workspace is untrusted, so file writes and command execution are disabled. Trust the workspace first.' },
  'tool.symlinkEscape': { zh: '路径通过符号链接离开了工作区。', en: 'The path leaves the workspace through a symbolic link.' },
  'tool.sensitiveCommandArg': { zh: '命令参数引用了敏感文件名', en: 'a command argument references a sensitive file name' },
  'tool.sensitiveBlocked': { zh: '已阻止访问敏感文件：{files}。可在设置中把“敏感文件”策略改为“逐次确认”或“允许”。', en: 'Blocked access to sensitive files: {files}. Change the “Sensitive files” policy to “Ask every time” or “Allow” in settings.' },
  'tool.sensitiveCommandRisk': { zh: '命令可能访问敏感文件', en: 'The command may access sensitive files' },
  'tool.sensitiveAccess': { zh: '访问敏感文件：{files}', en: 'Access sensitive files: {files}' },
  'tool.sensitiveCommandDetail': { zh: '命令：{command}\n\n该命令引用了 .env、密钥、证书或凭据文件。', en: 'Command: {command}\n\nThe command references .env, key, certificate or credential files.' },
  'tool.sensitiveAccessDetail': { zh: '目标：{files}\n\n敏感文件包含密钥、令牌或凭据；确认后会读取内容并可能随请求发送给模型接口。', en: 'Target: {files}\n\nSensitive files contain keys, tokens or credentials. If you confirm, their content is read and may be sent to the model endpoint with the request.' },
  'tool.sensitiveReadBlocked': { zh: '已阻止读取敏感文件：{path}。可在设置中把“敏感文件”策略改为“逐次确认”或“允许”。', en: 'Blocked reading the sensitive file {path}. Change the “Sensitive files” policy to “Ask every time” or “Allow” in settings.' },
  'tool.untrustedNoWrite': { zh: '当前工作区未受信任，不能写入文件。', en: 'The workspace is untrusted; files cannot be written.' },
  'tool.argsNotObject': { zh: '工具参数必须是 JSON 对象。', en: 'Tool arguments must be a JSON object.' },
  'tool.argsInvalid': { zh: '工具参数无效：{error}', en: 'Invalid tool arguments: {error}' },
  'tool.paramMustBeString': { zh: '{key} 必须是字符串。', en: '{key} must be a string.' },
  'tool.approvalRunCommand': { zh: '运行命令：{command}', en: 'Run command: {command}' },
  'tool.approvalMoveFile': { zh: '移动文件：{from} → {to}', en: 'Move file: {from} → {to}' },
  'tool.approvalDeleteFile': { zh: '删除文件：{path}', en: 'Delete file: {path}' },
  'tool.approvalModifyFile': { zh: '修改文件：{path}', en: 'Modify file: {path}' },
  'tool.approvalReadData': { zh: '读取工作区数据：{name}', en: 'Read workspace data: {name}' },
  'tool.detailSeverePrefix': { zh: '严重风险命令：提权、破坏性删除、磁盘擦写或不可逆操作。\n\n', en: 'Severe risk: privilege escalation, destructive deletion, disk wiping or an irreversible operation.\n\n' },
  'tool.detailWriteFile': { zh: '目标：{path}\n写入内容：{chars} 字符', en: 'Target: {path}\nContent: {chars} characters' },
  'tool.detailReplaceInFile': { zh: '目标：{path}\n精确替换：{old} -> {new} 字符', en: 'Target: {path}\nExact replace: {old} -> {new} characters' },
  'tool.detailRenameFile': { zh: '来源：{from}\n目标：{to}', en: 'From: {from}\nTo: {to}' },
  'tool.detailDeleteFile': { zh: '目标：{path}\n文件将移到系统废纸篓。', en: 'Target: {path}\nThe file will move to the system trash.' },
  'tool.detailRunCommand': { zh: '工作目录：{cwd}\n命令：{command}', en: 'Working directory: {cwd}\nCommand: {command}' },
  'tool.dirTag': { zh: '[目录]', en: '[dir]' },
  'tool.linkTag': { zh: '[链接]', en: '[link]' },
  'tool.fileTag': { zh: '[文件]', en: '[file]' },
  'tool.binaryFile': { zh: '该文件似乎是二进制文件，未加入模型上下文。', en: 'This file looks binary, so it was not added to the model context.' },
  'tool.outputTruncated': { zh: '{result}\n… [输出已截断，原始大小 {bytes} 字节]', en: '{result}\n… [output truncated; original size {bytes} bytes]' },
  'tool.lineDelta': { zh: '{lines} 行（{delta}）', en: '{lines} lines ({delta})' },

  // 待办清单（Agent 自己维护的任务清单）
  'todo.title': { zh: '任务清单', en: 'Task list' },
  'todo.progress': { zh: '{done}/{total} 已完成', en: '{done}/{total} done' },
  'todo.status.pending': { zh: '等待执行', en: 'Waiting' },
  'todo.status.in_progress': { zh: '执行中', en: 'In progress' },
  'todo.status.completed': { zh: '已完成', en: 'Completed' },
  'todo.updated': { zh: '任务清单已更新：{done}/{total} 已完成', en: 'Task list updated: {done}/{total} done' },
  'todo.empty': { zh: '这次调用没有产生有效条目，任务清单保持不变。', en: 'This call produced no valid items, so the task list is unchanged.' },
  'todo.hintSingleActive': { zh: '提示：同一时刻只应有一项处于 in_progress。', en: 'Note: only one item should be in_progress at a time.' },
  // 推送 / 版本号不属于任务清单：拆分时就排除，完成后单独确认。
  // 命中时要明确告诉模型「这一步没有被丢掉」，否则它会以为清单被改坏而反复重试。
  'todo.scopeExcludedSummary': { zh: '任务清单已更新：{done}/{total} 已完成（已移出 {count} 条推送 / 版本号条目）', en: 'Task list updated: {done}/{total} done ({count} push/version item(s) moved out)' },
  'todo.scopeExcludedNotice': { zh: '已从任务清单移出 {count} 条不属于清单的条目：{items}。推送与版本号更新不写进任务清单——工作完成并验证后，请单独用一句话征询用户确认，得到明确同意再执行；不要把它们当收尾步骤顺手做掉。', en: 'Moved {count} item(s) out of the task list because they do not belong there: {items}. A push and a version bump are not checklist work — after the work is finished and verified, ask the user separately in one short sentence and act only on an explicit yes. Do not treat them as a finishing step.' },
  'todo.scopeExcludedOnlySummary': { zh: '任务清单未更新：这 {count} 条都是推送 / 版本号条目', en: 'Task list unchanged: all {count} item(s) were push/version steps' },
  'taskQueue.edit': { zh: '编辑', en: 'Edit' },
  'taskQueue.remove': { zh: '删除', en: 'Delete' },
  'taskQueue.save': { zh: '保存', en: 'Save' },
  'taskQueue.cancelEdit': { zh: '取消', en: 'Cancel' },
  'taskQueue.editHint': { zh: '修改这条排队消息；agent 还没读到它，保存后下一轮直接用新内容执行', en: 'Edit this queued message. The agent has not read it yet, so the new text is what it runs next.' },
  'taskQueue.removeHint': { zh: '撤掉这条排队消息（还没被执行才能删）', en: 'Remove this queued message (only possible before the agent runs it)' },
  'taskQueue.editExecutedHint': { zh: '这条已经被 agent 执行过：历史不会改，保存后会把改过的内容作为新消息再发一次', en: 'The agent already ran this one. History stays as it is; saving sends your edited text as a new message.' },
  'taskQueue.editExpired': { zh: '这条排队消息已经不在队列里了', en: 'That queued message is no longer in the queue' },
  'taskQueue.resentAfterEdit': { zh: '已把改过的内容作为新消息发出', en: 'Sent the edited text as a new message' },
  'taskQueue.removeExecuted': { zh: '这条已经被 agent 读取执行，无法删除；可以编辑后重新发出', en: 'The agent already ran this message, so it cannot be deleted. You can edit it and send it again.' },
  'taskQueue.removed': { zh: '已删除排队消息', en: 'Queued message removed' },
  'todo.replacementBlockedSummary': { zh: '任务清单未更新：会丢掉 {count} 条已完成条目', en: 'Task list unchanged: {count} completed item(s) would be dropped' },
  'todo.replacementBlockedNotice': {
    zh: '这次提交的清单丢掉了现有清单里的 {count} 条已完成条目：{items}。用户点「继续执行」是在继续**同一份**清单（共 {total} 条），不是让你重新拆一份——已完成项是已验证的事实，换掉等于把进度抹掉。请照抄现有条目的原文（已完成的保留 completed 状态），只在后面接着加或调整**未完成**的部分，然后把整份清单再提交一次。如果用户本轮明确要求重新规划，才按新方案提交。',
    en: 'The list you submitted drops {count} already-completed item(s) from the existing list: {items}. Pressing Continue resumes the SAME list ({total} items), not a re-plan — completed items are verified facts, and replacing them erases progress. Copy the existing items verbatim (keep them completed), re-plan only the unfinished part, then submit the whole list again. Only submit a fresh plan when the user explicitly asked for one this turn.',
  },
  'todo.scopeExcludedOnlyNotice': { zh: '这次提交的 {count} 条全是推送或版本号步骤（{items}），它们不属于任务清单，所以清单保持不变。请把真正的实现步骤写进清单；推送与版本号更新在工作完成后单独征询用户确认。', en: 'All {count} item(s) this call contained were push or version steps ({items}); they do not belong in the task list, so the list is unchanged. Put the real implementation steps in the list, and ask the user separately about the push and the version bump once the work is done.' },
  // 英文不再写 ", can be resumed"：状态区宽度要固定，句尾那半句会把控件拉到 170px，
  // 整个顶栏都为它让路；「可以继续」由右侧那两个按钮本身表达，不必再写一遍。
  'todo.interrupted': { zh: '已中断，可继续', en: 'interrupted' },
  'todo.incomplete': { zh: '未完成，可继续', en: 'not finished' },
  // 清单全部完成时立刻归档成胶囊，面板不再占位；这两条分别给工具卡与模型看。
  'todo.archived': { zh: '任务清单全部完成（{total} 项），已归档成胶囊', en: 'Task list complete ({total} item(s)); archived as a capsule' },
  'todo.archivedHint': { zh: '这份清单已全部完成并归档，面板上的清单已收起（可在输入框上方的胶囊里回看）。若要继续做别的，请提交一份新的清单。', en: 'This list is fully completed and archived, so the panel is collapsed (reopen it from the capsule above the composer). To keep going, submit a new list.' },
  // 顶栏的「继续执行 / 取消任务」，只在清单处于可继续状态时出现
  'todo.resume': { zh: '继续执行', en: 'Continue' },
  'todo.cancel': { zh: '取消任务', en: 'Cancel task' },
  'todo.resumeHint': { zh: '从中断的地方接着执行这份清单', en: 'Keep running this list from where it stopped' },
  'todo.cancelHint': { zh: '放弃这份清单，面板上的清单会消失且不归档', en: 'Discard this list; it disappears without being archived' },
  'todo.resumeInstruction': {
    zh: '继续执行当前任务清单里尚未完成的条目，从中断的地方接着做，不要重复已经完成的步骤。现有清单就是这一轮的计划：用 update_todos 传入同一份清单（条目原文照抄，已完成的保持 completed），只把接下来要做的那一项标成 in_progress；不要重新拆一份清单。',
    en: 'Continue the unfinished items of the current task list from where it stopped; do not repeat steps that are already done. The existing list IS the plan for this turn: call update_todos with that same list (copy every item verbatim, keep completed ones completed) and move only the next item to in_progress. Do not write a new list.',
  },
  'todo.resumed': { zh: '已从中断处继续执行', en: 'Resumed from the interruption point' },
  'todo.cancelled': { zh: '任务已取消，清单已清除', en: 'Task cancelled; the list was cleared' },
  'todo.cancelNoActive': { zh: '当前没有可以取消的任务', en: 'There is no task to cancel' },
  // 任务清单归档胶囊
  'todo.archive.title': { zh: '已归档任务清单', en: 'Archived task list' },
  'todo.archive.summary': { zh: '已归档 · {time} · {done}/{total} 完成', en: 'Archived · {time} · {done}/{total} done' },
  'todo.archive.capsule': { zh: '归档任务清单 {done}/{total} 完成', en: 'Archived task list, {done}/{total} done' },
  'todo.archive.hint': { zh: '点击展开这份已归档的任务清单', en: 'Click to expand this archived task list' },
  'todo.archive.hintOpen': { zh: '点击收起', en: 'Click to collapse' },
  'todo.archive.collapse': { zh: '收起归档', en: 'Collapse' },
  'todo.archive.lockedHint': { zh: '已展开归档清单，先收起它才能打开任务树或当前任务清单', en: 'An archived list is open; collapse it before opening the task tree or the current task list' },
  'chat.running': { zh: '运行中', en: 'Running' },
  'chat.runningInOtherShort': { zh: '另有 {count} 个对话在后台执行', en: '{count} other chat(s) running in the background' },
  'chat.runningInOther': { zh: '另一个对话正在后台执行，可以继续在这里操作。', en: 'Another conversation is running in the background; you can keep working here.' },
  'tool.updateTodos.description': {
    zh: '创建或更新本轮的任务清单。当任务需要拆成多个步骤执行（例如“重构某个模块并补测试”“排查一个跨文件的问题”）时，先用它把步骤列出来，之后每完成一步就再调用一次更新状态。清单按数组顺序展示，所以顺序要与实际执行顺序一致。同一时刻只应有一项处于 in_progress；开始做某项前把它设为 in_progress，做完立刻设为 completed。全部完成后保持整份清单，不要清空。任务只有一步时不要使用这个工具。如果面板上已有一份被中断的清单、而用户要继续把它做完，请沿用它并先把当前条目改回 in_progress，完成后把全部条目设为 completed，这样它会被归档。',
    en: 'Create or update the task list for this turn. Use it when the work needs several steps (for example "refactor a module and add tests" or "debug an issue across files"): list the steps first, then call it again after each step to update the status. Items are displayed in array order, so keep that order equal to the execution order. Only one item should be in_progress at a time: mark an item in_progress before starting it and completed as soon as it is done. When everything is finished, keep the full list rather than clearing it. Do not use this tool when the task is a single step. If the panel already holds an interrupted list and the user wants to finish it, keep using that list, set the current item back to in_progress first, and mark every item completed when done so it gets archived.',
  },
  'tool.updateTodos.todosParam': {
    zh: '完整清单，按执行顺序排列。每次调用都要传整份清单（不是增量），这样状态更新后顺序和已完成项才不会丢。',
    en: 'The full list, in execution order. Send the whole list on every call (not a delta) so the order and completed items survive the update.',
  },
  'tool.updateTodos.contentParam': {
    zh: '这一项的待办内容，一句话说清要做什么',
    en: 'What this item does, in one sentence',
  },
  'tool.updateTodos.statusParam': {
    zh: 'pending 等待执行、in_progress 正在执行、completed 已完成',
    en: 'pending = not started, in_progress = being worked on, completed = done',
  },

  // 扩展宿主：命令与通知（补充）
  'ext.privacyCancel': { zh: '取消', en: 'Cancel' },
  'ext.exportLabel': { zh: '导出全部对话', en: 'Export all conversations' },

  // 历史视图与存储
  'history.emptyConversation': { zh: '空对话', en: 'Empty conversation' },
  'storage.defaultTitle': { zh: '新对话', en: 'New chat' },
  'storage.messageMissing': { zh: '找不到要更新的消息。', en: 'Could not find the message to update.' },
  'storage.conversationMissing': { zh: '对话不存在，可能已被清理。', en: 'The conversation no longer exists; it may have been cleaned up.' },
  'storage.queuedNotRun': { zh: '排队任务在上次会话结束时尚未执行。', en: 'A queued task had not run when the previous session ended.' },
  'storage.interrupted': { zh: '上次生成被中断。', en: 'The previous generation was interrupted.' },

  // API 客户端错误
  'api.noKey': { zh: '尚未配置 API Key。请打开设置完成配置。', en: 'No API key configured. Open settings to finish setup.' },
  'api.timeout': { zh: '请求超时（{seconds} 秒）。', en: 'Request timed out ({seconds}s).' },
  'api.connectFailed': { zh: '无法连接到接口：{error}', en: 'Could not reach the endpoint: {error}' },
  'api.requestFailed': { zh: '接口请求失败（{status}）：{detail}', en: 'Endpoint request failed ({status}): {detail}' },
  'api.noStream': { zh: '接口没有返回可读取的数据流。', en: 'The endpoint returned no readable stream.' },
  'api.noKeyForModels': { zh: '尚未配置 API Key，无法获取模型列表。', en: 'No API key configured, so the model list cannot be fetched.' },
  'api.modelListTimeout': { zh: '获取模型列表超时（{seconds} 秒）。', en: 'Timed out fetching the model list ({seconds}s).' },
  'api.modelListFailed': { zh: '无法获取模型列表：{error}', en: 'Could not fetch the model list: {error}' },
  'api.modelListStatus': { zh: '获取模型列表失败（{status}）：{detail}', en: 'Fetching the model list failed ({status}): {detail}' },
  'api.noModels': { zh: '接口返回成功，但没有发现可用模型。', en: 'The endpoint responded successfully but exposed no usable models.' },
  'api.cancelled': { zh: '请求已停止。', en: 'The request was stopped.' },
  'api.httpsRequired': { zh: '为保护 API Key，远程模型接口必须使用 HTTPS；本机 localhost 可使用 HTTP。', en: 'To protect your API key, remote model endpoints must use HTTPS; localhost may use HTTP.' },
  'api.unknownError': { zh: '未知错误', en: 'Unknown error' },

  // Agent 运行进度
  'agent.stepLimit': { zh: '\n\nAgent 已达到 {steps} 步执行上限，已停止继续调用工具。上面的进度和结果都保留着，回复「继续」即可接着执行；如果一直跑到上限，多半是任务没拆细，可以把它拆成几步分别发给我。', en: '\n\nThe agent reached its {steps}-step limit and stopped calling tools. Everything above is preserved; reply "continue" to carry on. If every run hits the limit, the task is probably too broad — split it into a few smaller requests.' },
  'agent.cancelled': { zh: '任务已取消。', en: 'The task was cancelled.' },
  'agent.loopDetected': { zh: '\n\n检测到连续 {count} 次完全相同的工具调用（{tool}），已停止自动重试以避免死循环。请告诉我需要改变的做法（换关键词、换目录或换工具），我再继续。', en: '\n\nDetected {count} identical tool calls in a row ({tool}); automatic retries were stopped to avoid an endless loop. Tell me what should change (different keywords, folder, or tool) and I will continue.' },
  'agent.noProgress': { zh: '\n\n连续 {rounds} 轮工具调用全部失败，已停止继续自动重试。请检查上面的错误信息，调整权限、路径或网络后回复「继续」。', en: '\n\nThe last {rounds} rounds of tool calls all failed, so automatic retries stopped. Review the errors above, adjust permissions, paths, or network access, then reply "continue".' },
  'agent.toolCallBudget': { zh: '\n\n本轮工具调用次数已达安全上限（单轮最多 {round} 个、整轮请求最多 {count} 个），已暂停。已完成的进度和结果都保留着，回复「继续」可以从当前进度接着执行。', en: '\n\nThis run reached its tool-call safety limit (at most {round} per step and {count} per request), so it paused. Completed progress and results are preserved; reply "continue" to resume.' },
  'agent.toolBudgetSkipped': { zh: '已达本轮工具调用安全上限，此步骤未执行', en: 'Skipped: the tool-call safety limit for this run was reached' },
  'agent.loopSkipped': { zh: '连续 {count} 次完全相同的调用，已阻止以避免死循环', en: 'Blocked: {count} identical calls in a row would loop forever' },
  'agent.commandStalled': { zh: '有命令已 {seconds} 秒没有输出，可能卡在等待密码或确认。HWChat 无法替你输入，可在该步骤上点停止；到达 {timeout} 秒上限会自动终止。', en: 'A command has produced no output for {seconds}s and may be waiting for a password or confirmation. HWChat cannot type it for you; stop that step if needed. It will be killed automatically at the {timeout}s cap.' },
  'agent.mergedGuidance': { zh: '收到相关新消息，已跳过尚未执行的旧步骤', en: 'New guidance arrived; pending steps were skipped' },
  'agent.mergedGuidanceOutput': { zh: '任务树已合并用户的新指导，Agent 将先重新规划。', en: 'The task tree merged your new guidance; the agent will re-plan first.' },
  'agent.progress.list_workspace_roots': { zh: '正在读取 VS Code 工作区根目录', en: 'Reading VS Code workspace roots' },
  'agent.progress.list_directory': { zh: '正在列出目录', en: 'Listing a directory' },
  'agent.progress.list_files': { zh: '正在列出工作区文件', en: 'Listing workspace files' },
  'agent.progress.search_files': { zh: '正在搜索工作区', en: 'Searching the workspace' },
  'agent.progress.read_file': { zh: '正在读取文件', en: 'Reading a file' },
  'agent.progress.open_file': { zh: '正在 VS Code 编辑器中打开文件', en: 'Opening a file in the VS Code editor' },
  'agent.progress.get_diagnostics': { zh: '正在读取诊断', en: 'Reading diagnostics' },
  'agent.progress.write_file': { zh: '准备写入文件', en: 'Preparing to write a file' },
  'agent.progress.replace_in_file': { zh: '准备修改文件', en: 'Preparing to edit a file' },
  'agent.progress.rename_file': { zh: '准备移动文件', en: 'Preparing to move a file' },
  'agent.progress.delete_file': { zh: '准备删除文件', en: 'Preparing to delete a file' },
  'agent.progress.run_command': { zh: '准备运行命令', en: 'Preparing to run a command' },
  'agent.progress.load_skill': { zh: '正在加载 Skill', en: 'Loading a skill' },
  'agent.progress.search_conversation_history': { zh: '正在检索关联的只读任务历史', en: 'Searching linked read-only task history' },
  'agent.progress.update_todos': { zh: '正在更新任务清单', en: 'Updating the task list' },
  'agent.progress.generic': { zh: '正在执行 {name}', en: 'Running {name}' },
  'agent.contentOmitted': { zh: '[正文未写入历史：{bytes} 字节]', en: '[body not written to history: {bytes} bytes]' },
  'agent.valueTruncated': { zh: '{value}… [{bytes} 字节]', en: '{value}… [{bytes} bytes]' },
  'agent.detailsTruncated': { zh: '{result}\n… [本地详情已截断]', en: '{result}\n… [local details truncated]' },

  // 路径隔离
  'path.blockedGeneric': { zh: '命令被路径隔离策略拦截：不能引用工作区外路径、HOME 或上级目录。', en: 'Blocked by path isolation: commands cannot reference paths outside the workspace, HOME, or parent directories.' },
  'path.blockedResolved': { zh: '命令被路径隔离策略拦截：路径 {token} 解析后不在当前工作区内。', en: 'Blocked by path isolation: {token} resolves outside the current workspace.' },
  'path.blockedSedHint': { zh: '命令被路径隔离策略拦截：路径 {path} 不在当前工作区内。它看起来是 sed/grep 的正则地址而不是文件路径——请改写为不使用斜杠包裹的形式（例如 grep -e "模式" 或 sed -n -e "命令"）。', en: 'Blocked by path isolation: {path} is outside the current workspace. It looks like a sed/grep regex address rather than a file path; rewrite it without slash-delimited addresses (for example grep -e "pattern" or sed -n -e "command").' },
  'path.blockedSimple': { zh: '命令被路径隔离策略拦截：路径 {path} 不在当前工作区内。', en: 'Blocked by path isolation: {path} is outside the current workspace.' },
  'path.noWorkspace': { zh: '当前没有打开的工作区。', en: 'No workspace is currently open.' },
  'path.ambiguous': { zh: '路径「{value}」在多个工作区根目录中同时存在（{roots}），无法判断目标。请在路径前加上根目录名，例如「{example}」。', en: 'The path "{value}" exists in several workspace roots ({roots}), so the target is ambiguous. Prefix it with a root name, for example "{example}".' },
  'path.outsideWorkspace': { zh: '路径必须位于当前 VS Code 工作区内。', en: 'The path must be inside the current VS Code workspace.' },
  'path.homeReference': { zh: '参数引用了 HOME 或用户目录：{value}', en: 'The argument references HOME or a user directory: {value}' },
  'path.notInside': { zh: '路径不在当前工作区内：{value}', en: 'The path is outside the current workspace: {value}' },

  // Skill 加载
  'skill.loadDescription': { zh: '读取一个已由用户启用且与当前任务匹配的本地 Skill 指令。只有路由表中的 Skill 可以读取。', en: 'Read a local skill instruction that the user enabled and that matches the current task. Only skills in the routing table can be read.' },
  'skill.loadDenied': { zh: 'Skill 加载被拒绝', en: 'Skill load denied' },
  'skill.loadDeniedContent': { zh: '只能加载本次对话已启用并出现在路由表中的 Skill。', en: 'Only skills enabled for this conversation and present in the routing table can be loaded.' },
  'skill.loaded': { zh: '加载 Skill：{name}', en: 'Load skill: {name}' },
  'skill.localSkill': { zh: '本地 Skill', en: 'Local skill' },
};

/** 语言设置归一化：非法值一律视为 `auto`。 */
export function normalizeLanguageSetting(value: unknown): LanguageSetting {
  return value === 'zh' || value === 'en' || value === 'auto' ? value : 'auto';
}

/**
 * 解析实际生效语言。
 * `auto` 时跟随 VS Code 显示语言：`zh-cn` / `zh-tw` 等中文环境用中文，其余用英文。
 */
export function resolveLanguage(setting: unknown, appLanguage: string): Language {
  const normalized = normalizeLanguageSetting(setting);
  if (normalized === 'zh' || normalized === 'en') return normalized;
  return /^zh/i.test(String(appLanguage ?? '')) ? 'zh' : 'en';
}

/** VS Code 显示语言；测试替身没有 `env`，因此做防御性读取。 */
function appLanguage(): string {
  const env = (vscode as unknown as { env?: { language?: string } }).env;
  return env?.language ?? 'en';
}

/** 当前生效语言（每次调用都重新读配置，设置改动立即生效）。 */
export function currentLanguage(): Language {
  let setting: unknown;
  try {
    setting = vscode.workspace.getConfiguration('hwchat').get('language', 'auto');
  } catch {
    setting = 'auto';
  }
  return resolveLanguage(setting, appLanguage());
}

/** 用 `{name}` 占位符插值；缺值时保留原样，便于定位。 */
function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}

/** 按键取文案。缺键返回键本身，漏译会在界面上显形，而不是让渲染崩掉。 */
export function t(lang: Language, key: string, vars?: Vars): string {
  const entry = DICTIONARY[key];
  if (!entry) return key;
  return interpolate(entry[lang], vars);
}

/** 按当前语言取文案。 */
export function tt(key: string, vars?: Vars): string {
  return t(currentLanguage(), key, vars);
}

/** 当期语言的扁平表，注入 webview 给前端脚本使用。 */
export function messageTable(lang: Language): Record<string, string> {
  const table: Record<string, string> = {};
  for (const [key, entry] of Object.entries(DICTIONARY)) {
    table[key] = entry[lang];
  }
  return table;
}

/** 全部键，供测试比对中英两版完整性。 */
export function messageKeys(): string[] {
  return Object.keys(DICTIONARY);
}

/** 词表原始条目，供测试断言中英都不为空。 */
export function messageEntry(key: string): Entry | undefined {
  return DICTIONARY[key];
}

/**
 * 把词表包成可安全嵌入 HTML 的 JSON script 块。
 * `<` 转义成 `\u003c`，避免文案里出现脚本结束标签时截断文档。
 */
export function messageScriptTag(lang: Language, id = 'hwchat-i18n'): string {
  const json = JSON.stringify(messageTable(lang)).replace(/</g, '\\u003c');
  return `<script type="application/json" id="${id}">${json}</script>`;
}
