/**
 * 生成英文界面截图。
 *
 * 做法：把 develop 用的预览页（test/preview-*.html）套上真实词表里的英文文案，
 * 复用同一份 media/*.css 渲染，再用本机 Chrome 无头模式截图。
 * 这样截图里的布局、间距、图标与扩展里完全一致，只有语言不同。
 *
 * 运行：node docs/screenshots/build.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

// 1) 用 esbuild 把 i18n 模块单独打包成可 import 的 ESM，vscode 指向测试替身。
const bundled = await esbuild.build({
  entryPoints: ['src/core/i18n.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { vscode: './src/test/support/vscodeMock.ts' },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;
const { messageTable } = await import(moduleUrl);
const english = messageTable('en');
const i18nTag = `<script type="application/json" id="hwchat-i18n">${JSON.stringify(english).replace(/</g, '\\u003c')}</script>`;

/** 预览页里的示例对话需要英文版，才能和英文界面连成一体。 */
const chatReplacements = [
  ['<html lang="zh-CN">', '<html lang="en">'],
  // 侧栏与工具栏外壳（按“长串优先”排列，避免短串先吃掉长串的一部分）
  ['aria-label="显示对话记录" title="对话记录"', `aria-label="${english['chat.showHistory']}" title="${english['chat.history']}"`],
  ['aria-label="关闭对话记录" title="关闭"', `aria-label="${english['chat.closeHistory']}" title="${english['common.close']}"`],
  ['aria-label="对话记录"', `aria-label="${english['chat.historyPane']}"`],
  ['<span>新建对话</span>', `<span>${english['chat.newChat']}</span>`],
  ['<span class="sr-only">搜索对话</span>', `<span class="sr-only">${english['chat.searchConversations']}</span>`],
  ['placeholder="搜索对话"', `placeholder="${english['chat.searchConversations']}"`],
  ['<span class="sr-only">搜索</span>', `<span class="sr-only">${english['chat.searchConversations']}</span>`],
  ['<span>显示归档</span>', `<span>${english['chat.showArchived']}</span>`],
  ['aria-label="打开设置" title="设置"', `aria-label="${english['chat.openSettings']}" title="${english['chat.settings']}"`],
  ['<span>设置</span>', `<span>${english['chat.settings']}</span>`],
  ['<strong id="conversationTitle">新对话</strong>', `<strong id="conversationTitle">${english['common.newChat']}</strong>`],
  ['<span id="connectionState">准备就绪</span>', `<span id="connectionState">${english['chat.ready']}</span>`],
  ['工作模式', english['chat.workspaceMode']],
  ['aria-label="API 配置"', `aria-label="${english['chat.apiProfile']}"`],
  ['<span class="sr-only">API 配置</span>', `<span class="sr-only">${english['chat.apiProfile']}</span>`],
  ['aria-label="模型"', `aria-label="${english['chat.model']}"`],
  ['<span class="sr-only">模型</span>', `<span class="sr-only">${english['chat.model']}</span>`],
  ['aria-label="从 API 刷新模型列表" title="刷新模型列表"', `aria-label="${english['chat.refreshModelsFromApi']}" title="${english['chat.refreshModels']}"`],
  ['aria-label="选择 Skill" title="选择 Skill"', `aria-label="${english['chat.selectSkill']}" title="${english['chat.selectSkill']}"`],
  ['aria-label="归档当前对话" title="归档"', `aria-label="${english['chat.archiveCurrent']}" title="${english['chat.archive']}"`],
  ['aria-label="导出当前对话" title="导出"', `aria-label="${english['chat.exportCurrent']}" title="${english['chat.export']}"`],
  ['<strong>本次对话使用的 Skill</strong>', `<strong>${english['chat.skillsPanelTitle']}</strong>`],
  ['<span id="workspaceTrustBadge">工作区状态</span>', `<span id="workspaceTrustBadge">${english['chat.workspaceTrustBadge']}</span>`],
  ['默认启用来自本地skill快捷调用；回复只显示本轮实际加载的 Skill。', english['chat.skillsPanelNote']],
  ['>加载更早消息<', `>${english['chat.loadOlder']}<`],
  ['aria-label="回到最新消息" title="回到最新消息"', `aria-label="${english['chat.scrollToBottom']}" title="${english['chat.scrollToBottom']}"`],
  ['aria-label="移除代码上下文"', `aria-label="${english['chat.removeContext']}"`],
  ['今天想一起解决什么？', 'What should we solve today?'],
  ['解释代码', english['chat.suggestion.explain']],
  ['设计方案', english['chat.suggestion.design']],
  ['代码审查', english['chat.suggestion.review']],
  ['data-prompt="解释当前代码"', 'data-prompt="Explain the current code"'],
  ['data-prompt="设计实现方案"', 'data-prompt="Design an implementation plan"'],
  ['data-prompt="执行代码审查"', 'data-prompt="Run a code review"'],
  ['任务历史', english['chat.taskHistory']],
  ['只读摘要 + 按需检索；实际发送的摘要和片段会计入输入 Token', english['chat.taskHistoryNote']],
  ['aria-label="解除任务历史" title="解除任务历史"', `aria-label="${english['chat.detachHistory']}" title="${english['chat.detachHistory']}"`],
  ['<span>任务树</span>', `<span>${english['chat.taskTree']}</span>`],
  ['placeholder="询问代码、调试问题或直接交给 Agent 实现…"', `placeholder="${english['chat.promptPlaceholderAgent']}"`],
  ['aria-label="本轮 Agent 设置"', `aria-label="${english['chat.agentRuntimeSettings']}"`],
  ['aria-label="添加文件" title="添加文件"', `aria-label="${english['chat.attachFile']}" title="${english['chat.attachFile']}"`],
  ['aria-label="语音输入" title="语音输入"', `aria-label="${english['chat.voiceInput']}" title="${english['chat.voiceInput']}"`],
  ['aria-label="发送" title="发送"', `aria-label="${english['chat.send']}" title="${english['chat.send']}"`],
  ['aria-label="停止生成" title="停止"', `aria-label="${english['chat.stopGenerating']}" title="${english['chat.stop']}"`],
  ['<strong id="sourceHistoryTitle">任务历史</strong>', `<strong id="sourceHistoryTitle">${english['chat.taskHistory']}</strong>`],
  ['<strong id="agentRunLabel">Agent 正在执行</strong>', `<strong id="agentRunLabel">${english['chat.agentRunning']}</strong>`],
  // 运行中控件的静态文案（页面里是硬编码的，真实面板由 html() 生成）
  ['<span>权限预设：</span>', `<span>${english['chat.permissionPresetLabel']}</span>`],
  ['<span>最大步骤：</span>', `<span>${english['chat.maxStepsLabel']}</span>`],
  ['<span>思考深度：</span>', `<span>${english['chat.reasoningDepthLabel']}</span>`],
  // 示例对话：用户提问与模型回答
  ['完成登录模块重构', 'Refactor the login module'],
  ['正在按新要求继续验证', 'Verifying against the new requirements'],
  ['排查 Android 构建', 'Debug the Android build'],
  ['Gradle 版本需要对齐', 'Gradle versions need aligning'],
  ['旧版上传模块方案', 'Legacy upload module plan'],
  ['已归档', 'Archived'],
  ['重构登录逻辑，修复并发刷新问题并运行测试。', 'Refactor the login flow, fix the concurrent refresh bug and run the tests.'],
  [
    '先看一下现在的刷新入口是怎么写的。\\n\\n- 认证状态由 `authStore` 共享写入\\n- 刷新入口有两处，都走同一个任务队列\\n\\n现在把并发刷新合并成一个共享任务。\\n\\n改完了，接下来跑测试确认没有回归。\\n\\n## 已完成\\n\\n把并发刷新改成 *共享任务*，并将失败重试写进测试。\\n\\n## 改动\\n\\n1. 刷新逻辑\\n   - 并发调用只保留一个请求\\n   - 失败后按 0.5s / 1s / 2s 退避重试\\n2. 测试\\n   - 新增刷新失败后的恢复用例\\n\\n> 公共接口未改动，调用方无需调整。\\n\\n| 项 | 改动前 | 改动后 |\\n| --- | --- | --- |\\n| 并发请求 | 3 个 | 1 个 |\\n| 失败重试 | 无 | 3 次 |\\n\\n---\\n\\n需要手动复查时可运行：\\n\\n```zsh\\nnpm run check\\nnpm test\\n```',
    'Let me look at how the refresh entry point is written today.\\n\\n- Auth state is written through a shared `authStore`\\n- There are two refresh entry points, both going through the same task queue\\n\\nNow I will collapse concurrent refreshes into one shared task.\\n\\nDone. Next I will run the tests to confirm there is no regression.\\n\\n## Done\\n\\nConcurrent refreshes now share a *single task*, and retry-after-failure is covered by tests.\\n\\n## Changes\\n\\n1. Refresh logic\\n   - Concurrent calls keep only one request\\n   - Failures retry with 0.5s / 1s / 2s backoff\\n2. Tests\\n   - Added a recovery case for a failed refresh\\n\\n> The public interface is unchanged, so callers need no updates.\\n\\n| Item | Before | After |\\n| --- | --- | --- |\\n| Concurrent requests | 3 | 1 |\\n| Retries on failure | None | 3 |\\n\\n---\\n\\nTo re-check manually, run:\\n\\n```zsh\\nnpm run check\\nnpm test\\n```',
  ],
  [
    '## 先看清调用链\\n\\n- 认证状态由 `authStore` 共享写入\\n- 刷新入口有两处，都走同一个任务队列\\n\\n## 再确认风险\\n\\n1. 并发时会不会重复请求 → *会*，需要合并\\n2. 失败后有没有重试 → 目前没有\\n\\n> 结论：先合并请求，再补退避重试。',
    '## Read the call chain first\\n\\n- Auth state is written through a shared `authStore`\\n- There are two refresh entry points, both on the same task queue\\n\\n## Then confirm the risks\\n\\n1. Can concurrency duplicate the request? *Yes*, so it needs merging\\n2. Is there a retry after failure? Not currently\\n\\n> Conclusion: merge the requests first, then add backoff retries.',
  ],
  ['不要改公共接口，再补一个刷新失败后的恢复测试。', 'Do not change the public interface, and add a recovery test for a failed refresh.'],
  ["name: 'TypeScript 质量规范', description: '严格类型、最小改动与测试要求'", "name: 'TypeScript quality rules', description: 'Strict types, minimal diffs and test coverage'"],
  ["name: '项目文档同步', description: '代码改动后同步 README 与技术文档'", "name: 'Keep project docs in sync', description: 'Sync README and technical docs after code changes'"],
  ["name: '本地模型'", "name: 'Local model'"],
  ['读取 src/AuthManager.ts（8.2 KB）', 'Read src/AuthManager.ts (8.2 KB)'],
  ['修改 src/AuthManager.ts：替换 1 处文本', 'Edited src/AuthManager.ts: 1 replacement'],
  ['正在运行测试', 'Running tests'],
  ['读取 214 行代码。', 'Read 214 lines of code.'],
  ['共享 refreshTask 并在 finally 中清理', 'Share refreshTask and clean up in finally'],
  ['文件更新为 228 行（+14）。', 'File updated to 228 lines (+14).'],
  ['重构登录逻辑并运行测试', 'Refactor login and run tests'],
  ['保留公共接口并补恢复测试', 'Keep the public interface, add recovery tests'],
  ['更新 README 使用说明', 'Update the README usage notes'],
  ['<option value="0">无限制</option><option value="12">12 步</option><option value="24">24 步</option><option value="40">40 步</option>', [0, 12, 24, 40].map((steps) => `<option value="${steps}">${steps === 0 ? english['chat.unlimited'] : english['chat.stepsOption'].replace('{count}', String(steps))}</option>`).join('')],
  ['<option value="default">默认</option><option value="none">无</option><option value="low">低</option><option value="high">高</option><option value="max">最大值</option>', ['default', 'none', 'low', 'high', 'max'].map((effort) => `<option value="${effort}">${english['chat.reasoning.' + effort]}</option>`).join('')],
  ['failure-screenshot.png', 'failure-screenshot.png'],
  // 收尾修正：前面有些短串先匹配了长串的一部分，这里按替换后的实际文本补齐。
  ['执行Code review', english['chat.suggestion.review']],
  ['解除Task history', english['chat.detachHistory']],
  // 输入框下方的权限预设下拉也换成英文四项（预览页里还留着已删除的「自定义」）。
  ['<option value="askAll" title="读取、写入和命令全部逐次确认；危险命令直接拒绝">每次询问</option><option value="review" title="自动读写与常规命令，只有危险命令逐次确认">风险操作询问</option><option value="autopilot" title="自动读写与常规命令，只有危险命令逐次确认">Autopilot</option><option value="full" title="全部自动执行（含危险命令），读取敏感文件时逐次确认">完全访问</option><option value="custom" title="按设置页中的读取 / 写入 / 命令 / 危险命令 / 敏感文件策略逐项组合">自定义</option>',
    ['askAll', 'review', 'autopilot', 'full'].map((id) => `<option value="${id}" title="${english[`preset.${id}.summary`]}">${english[`preset.${id}.label`]}</option>`).join('')],
];

const settingsReplacements = [
  ['<html lang="zh-CN">', '<html lang="en">'],
  ['data-target="connection" class="active">连接<', `data-target="general" class="active">${english['settings.nav.general']}</button><button data-target="connection">${english['settings.nav.connection']}<`],
  ['data-target="connection">连接<', `data-target="connection">${english['settings.nav.connection']}<`],
  // 真实设置页有「通用 → 界面语言」分组，预览页还没有，这里按同一结构补上，
  // 让截图能如实展示语言切换入口。
  ['<div class="settings-content">', `<div class="settings-content"><section id="general" class="settings-section"><div class="section-heading"><h2>${english['settings.general.title']}</h2></div><div class="settings-group"><label class="setting-row"><span><strong>${english['language.label']}</strong><small>${english['language.hint']}</small></span><select id="language" class="control"><option value="auto">${english['language.auto']}</option><option value="zh">${english['language.zh']}</option><option value="en">${english['language.en']}</option></select></label></div></section>`],
  ['data-target="generation">生成<', `data-target="generation">${english['settings.nav.generation']}<`],
  ['data-target="agent">Agent<', `data-target="agent">${english['settings.nav.agent']}<`],
  ['data-target="skills">Skills<', `data-target="skills">${english['settings.nav.skills']}<`],
  ['data-target="privacy">权限与隐私<', `data-target="privacy">${english['settings.nav.privacy']}<`],
  ['data-target="storage">存储<', `data-target="storage">${english['settings.nav.storage']}<`],
  ['>VS Code 设置<', `>${english['settings.nativeButton']}<`],
  ['<h1>设置</h1><span id="saveState">所有更改已保存</span>', `<h1>${english['settings.title']}</h1><span id="saveState">${english['settings.saved']}</span>`],
  ['>测试连接<', `>${english['settings.test']}<`],
  ['class="primary">保存<', `class="primary">${english['settings.save']}<`],
  ['<h2>连接</h2><span id="keyState" class="status-pill">未配置</span>', `<h2>${english['settings.connection.title']}</h2><span id="keyState" class="status-pill">${english['settings.keyUnconfigured']}</span>`],
  ['<strong>API 配置档</strong><small>每个服务独立保存地址、模型和密钥</small>', `<strong>${english['settings.profile.label']}</strong><small>${english['settings.profile.hint']}</small>`],
  ['<strong>配置名称</strong>', `<strong>${english['settings.profileName.label']}</strong>`],
  ['<strong>API Key</strong><small>保存在 VS Code SecretStorage</small>', `<strong>${english['settings.apiKey.label']}</strong><small>${english['settings.apiKey.hint']}</small>`],
  ['>清除<', `>${english['settings.apiKey.clear']}<`],
  ['<strong>接口地址</strong><small>OpenAI 兼容 Base URL</small>', `<strong>${english['settings.baseUrl.label']}</strong><small>${english['settings.baseUrl.hint']}</small>`],
  ['<strong>默认模型</strong>', `<strong>${english['settings.model.label']}</strong>`],
  ['<strong>可选模型</strong><small>每行一个模型名</small>', `<strong>${english['settings.models.label']}</strong><small>${english['settings.models.hint']}</small>`],
  ['<strong>额外请求头</strong>', `<strong>${english['settings.headers.label']}</strong>`],
  ['<strong>请求超时</strong></span><span class="stepper"><input id="requestTimeoutSeconds" type="number"><span>秒</span>', `<strong>${english['settings.timeout.label']}</strong></span><span class="stepper"><input id="requestTimeoutSeconds" type="number"><span>${english['common.seconds']}</span>`],
  ['<h2>生成</h2>', `<h2>${english['settings.generation.title']}</h2>`],
  ['<strong>温度</strong>', `<strong>${english['settings.temperature.label']}</strong>`],
  ['<strong>最大输出</strong>', `<strong>${english['settings.maxTokens.label']}</strong>`],
  ['<strong>上下文消息</strong></span><span class="stepper"><input id="maxMessagesInContext"><span>条</span>', `<strong>${english['settings.contextMessages.label']}</strong></span><span class="stepper"><input id="maxMessagesInContext"><span>${english['settings.messageUnit']}</span>`],
  ['<strong>回车发送</strong>', `<strong>${english['settings.sendOnEnter.label']}</strong>`],
  ['<strong>系统提示词</strong>', `<strong>${english['settings.systemPrompt.label']}</strong>`],
  ['<h2>Agent</h2><span id="trustState" class="status-pill">状态</span>', `<h2>${english['settings.agent.title']}</h2><span id="trustState" class="status-pill">${english['settings.trustStatePlaceholder']}</span>`],
  ['<strong>默认模式</strong>', `<strong>${english['settings.defaultMode.label']}</strong>`],
  ['<strong>最大执行步骤</strong></span><span class="stepper"><input id="agentMaxSteps"><span>步</span>', `<strong>${english['settings.maxSteps.label']}</strong></span><span class="stepper"><input id="agentMaxSteps"><span>${english['settings.stepsUnit']}</span>`],
  ['<strong>命令超时</strong></span><span class="stepper"><input id="maxCommandSeconds"><span>秒</span>', `<strong>${english['settings.commandTimeout.label']}</strong></span><span class="stepper"><input id="maxCommandSeconds"><span>${english['common.seconds']}</span>`],
  ['<strong>单文件读取上限</strong>', `<strong>${english['settings.readLimit.label']}</strong>`],
  ['<strong>工具输出上限</strong>', `<strong>${english['settings.toolOutputLimit.label']}</strong>`],
  ['<h2>Skills</h2><span id="skillCount" class="section-value">0 个</span>', `<h2>${english['settings.skills.title']}</h2><span id="skillCount" class="section-value">0</span>`],
  ['>重新扫描<', `>${english['settings.skills.rescan']}<`],
  ['>打开用户 Skill 目录<', `>${english['settings.skills.openFolder']}<`],
  ['<h2>权限与隐私</h2><span class="status-pill configured">无遥测</span>', `<h2>${english['settings.privacy.title']}</h2><span class="status-pill configured">${english['settings.privacy.noTelemetry']}</span>`],
  ['<strong>数据流向</strong><p>消息、明确添加的文件、启用的 Skill 和必要工具结果仅发送到配置的模型接口。</p>', `<strong>${english['settings.privacy.dataFlow']}</strong><p>${english['settings.privacy.dataFlowBody']}</p>`],
  ['<strong>权限预设</strong><small id="permissionPresetHint">自动读写与常规命令，只有危险命令逐次确认</small>', `<strong>${english['settings.privacy.presetLabel']}</strong><small id="permissionPresetHint">${english['preset.review.summary']}</small>`],
  ['<strong>读取文件</strong>', `<strong>${english['settings.privacy.readFile']}</strong>`],
  ['<strong>修改文件</strong>', `<strong>${english['settings.privacy.writeFile']}</strong>`],
  ['<strong>运行命令</strong><small>只读命令与正常命令（仅“自定义”生效）</small>', `<strong>${english['settings.privacy.command']}</strong><small>${english['settings.privacy.commandHint']}</small>`],
  ['<strong>危险命令</strong><small>仅“自定义”生效；提权、破坏性删除、强制推送等</small>', `<strong>${english['settings.privacy.dangerous']}</strong><small>${english['settings.privacy.dangerousHint']}</small>`],
  ['<strong>敏感文件</strong><small>仅“自定义”生效；.env、证书、密钥和常见凭据目录</small>', `<strong>${english['settings.privacy.sensitive']}</strong><small>${english['settings.privacy.sensitiveHint']}</small>`],
  ['<strong>审计记录保留</strong></span><span class="stepper"><input id="auditRetentionDays"><span>天</span>', `<strong>${english['settings.privacy.audit']}</strong></span><span class="stepper"><input id="auditRetentionDays"><span>${english['common.days']}</span>`],
  ['<strong>删除本地数据</strong><span>删除全部对话和审计记录</span>', `<strong>${english['settings.dangerZone.title']}</strong><span>${english['settings.dangerZone.hint']}</span>`],
  ['>全部删除<', `>${english['settings.dangerZone.action']}<`],
  ['<h2>存储</h2>', `<h2>${english['settings.storage.title']}</h2>`],
  ['</strong> 对话</span>', `</strong> ${english['settings.storage.conversations']}</span>`],
  ['</strong> 消息</span>', `</strong> ${english['settings.storage.messages']}</span>`],
  ['<strong>对话保留</strong></span><span class="stepper"><input id="historyRetentionDays"><span>天</span>', `<strong>${english['settings.storage.history']}</strong></span><span class="stepper"><input id="historyRetentionDays"><span>${english['common.days']}</span>`],
  ['<strong>任务缓存保留</strong></span><span class="stepper"><input id="taskCacheRetentionHours"><span>小时</span>', `<strong>${english['settings.storage.taskCache']}</strong></span><span class="stepper"><input id="taskCacheRetentionHours"><span>${english['common.hours']}</span>`],
  ['<strong>缓存上限</strong>', `<strong>${english['settings.storage.budget']}</strong>`],
  ['<strong>清理间隔</strong></span><span class="stepper"><input id="cleanupIntervalMinutes"><span>分钟</span>', `<strong>${english['settings.storage.cleanupInterval']}</strong></span><span class="stepper"><input id="cleanupIntervalMinutes"><span>${english['common.minutes']}</span>`],
  ['>立即清理<', `>${english['settings.storage.cleanupNow']}<`],
  ['>导出全部对话<', `>${english['settings.storage.exportAll']}<`],
  // 权限对照表
  ['<th scope="col">档位</th><th scope="col">读取</th><th scope="col">写入</th><th scope="col">只读命令</th><th scope="col">正常命令</th><th scope="col">危险命令</th><th scope="col">敏感文件</th>',
    `<th scope="col">${english['matrix.preset']}</th><th scope="col">${english['matrix.read']}</th><th scope="col">${english['matrix.write']}</th><th scope="col">${english['matrix.readOnlyCommand']}</th><th scope="col">${english['matrix.regularCommand']}</th><th scope="col">${english['matrix.dangerousCommand']}</th><th scope="col">${english['matrix.sensitive']}</th>`],
  ['<tr data-preset="askAll"><th scope="row">每次询问</th><td>逐次确认</td><td>逐次确认</td><td>逐次确认</td><td>逐次确认</td><td>直接拒绝</td><td>禁止</td></tr>',
    `<tr data-preset="askAll"><th scope="row">${english['preset.askAll.label']}</th><td>${english['matrix.askEvery']}</td><td>${english['matrix.askEvery']}</td><td>${english['matrix.askEvery']}</td><td>${english['matrix.askEvery']}</td><td>${english['matrix.deny']}</td><td>${english['matrix.block']}</td></tr>`],
  ['<tr data-preset="review"><th scope="row">风险操作询问</th><td>自动允许</td><td>自动允许（工作区内）</td><td>自动允许</td><td>自动允许</td><td>逐次确认</td><td>禁止</td></tr>',
    `<tr data-preset="review"><th scope="row">${english['preset.review.label']}</th><td>${english['matrix.allow']}</td><td>${english['matrix.allowInWorkspace']}</td><td>${english['matrix.allow']}</td><td>${english['matrix.allow']}</td><td>${english['matrix.askEvery']}</td><td>${english['matrix.block']}</td></tr>`],
  ['<tr data-preset="autopilot" class="active"><th scope="row">Autopilot</th><td>自动允许</td><td>自动允许（工作区内）</td><td>自动允许</td><td>自动允许</td><td>逐次确认</td><td>禁止</td></tr>',
    `<tr data-preset="autopilot" class="active"><th scope="row">${english['preset.autopilot.label']}</th><td>${english['matrix.allow']}</td><td>${english['matrix.allowInWorkspace']}</td><td>${english['matrix.allow']}</td><td>${english['matrix.allow']}</td><td>${english['matrix.allow']}</td><td>${english['matrix.block']}</td></tr>`],
  ['<tr data-preset="full"><th scope="row">完全访问</th><td>自动允许</td><td>自动允许（工作区内）</td><td>自动允许</td><td>自动允许</td><td>自动允许</td><td>逐次确认</td></tr>',
    `<tr data-preset="full"><th scope="row">${english['preset.full.label']}</th><td>${english['matrix.allow']}</td><td>${english['matrix.allowInWorkspace']}</td><td>${english['matrix.allow']}</td><td>${english['matrix.allow']}</td><td>${english['matrix.allow']}</td><td>${english['matrix.askEvery']}</td></tr>`],
  // 预览页里还留着已经删除的「自定义」档位，截图里不能出现。
  ['<tr data-preset="custom"><th scope="row">自定义</th><td>自定义</td><td>自定义</td><td>自定义</td><td>自定义</td><td>自定义</td><td>自定义</td></tr>', ''],
  ['<option value="custom" title="按设置页中的读取 / 写入 / 命令 / 危险命令 / 敏感文件策略逐项组合">自定义</option>', ''],
  ['<p>硬边界不受预设影响：未受信任工作区禁止写入与命令；工作区外路径隔离。危险命令指提权、破坏性删除、磁盘擦写、强制推送、把网络脚本管道给 shell 等操作。</p>', `<p>${english['matrix.hardBoundary']}</p>`],
  ['<option value="askAll" title="读取、写入和命令全部逐次确认；危险命令直接拒绝">每次询问</option><option value="review" title="自动读写与常规命令，只有危险命令逐次确认">风险操作询问</option><option value="autopilot" title="自动读写与常规命令，只有危险命令逐次确认">Autopilot</option><option value="full" title="全部自动执行（含危险命令），读取敏感文件时逐次确认">完全访问</option>',
    ['askAll', 'review', 'autopilot', 'full'].map((id) => `<option value="${id}" title="${english[`preset.${id}.summary`]}">${english[`preset.${id}.label`]}</option>`).join('')],
  ['<option value="askAll" title="读取、写入和命令全部逐次确认；危险命令直接拒绝">每次询问</option>', `<option value="askAll" title="${english['preset.askAll.summary']}">${english['preset.askAll.label']}</option>`],
  ['<option value="allow">自动允许</option><option value="ask">每次询问</option><option value="deny">禁止</option>', `<option value="allow">${english['policy.allow']}</option><option value="ask">${english['policy.ask']}</option><option value="deny">${english['policy.deny']}</option>`],
  ['<option value="ask">每次询问</option><option value="allow">自动允许</option><option value="deny">禁止</option>', `<option value="ask">${english['policy.ask']}</option><option value="allow">${english['policy.allow']}</option><option value="deny">${english['policy.deny']}</option>`],
  ['<option value="ask">逐次确认</option><option value="allow">自动允许</option><option value="deny">直接拒绝</option>', `<option value="ask">${english['policy.dangerous.ask']}</option><option value="allow">${english['policy.dangerous.allow']}</option><option value="deny">${english['policy.dangerous.deny']}</option>`],
  ['<option value="deny">禁止</option><option value="ask">逐次确认</option><option value="allow">允许</option>', `<option value="deny">${english['policy.sensitive.deny']}</option><option value="ask">${english['policy.sensitive.ask']}</option><option value="allow">${english['policy.sensitive.allow']}</option>`],
  // 示例数据
  ["name:'本地 Ollama'", "name:'Local Ollama'"],
  ["systemPrompt:'你是一名严谨的软件工程助手。'", "systemPrompt:'You are a rigorous software engineering assistant.'"],
  ["name:'项目文档同步',description:'代码改动后同步 README 与技术文档'", "name:'Keep project docs in sync',description:'Sync README and technical docs after code changes'"],
  ["name:'安全审查',description:'检查凭据、权限和输入边界'", "name:'Security review',description:'Check credentials, permissions and input boundaries'"],
];

function applyReplacements(source, replacements) {
  let output = source;
  const missed = [];
  for (const [from, to] of replacements) {
    if (!output.includes(from)) {
      missed.push(from.slice(0, 70));
      continue;
    }
    output = output.split(from).join(to);
  }
  return { output, missed };
}

function buildPage(sourceFile, replacements, targetFile) {
  const source = readFileSync(sourceFile, 'utf8');
  const { output, missed } = applyReplacements(source, replacements);
  if (missed.length) {
    console.warn(`  ${sourceFile} 有 ${missed.length} 条示例文案未命中（不影响结构）`);
  }
  // 词表必须在 chat.js / settings.js 之前注入。
  const withI18n = output.replace(
    /<script src="\.\.\/media\/(chat|settings)\.js"><\/script>/,
    `${i18nTag}\n<script src="../media/$1.js"></script>`,
  );
  // 预览页放在 test/ 时 ../media 指向项目根；生成到 docs/screenshots/ 后
  // 必须多退一层，否则样式与脚本 404（曾经因此截出四张无样式的重复图）。
  return withI18n
    .replaceAll('"../media/', '"../../media/')
    .replaceAll('"../resources/', '"../../resources/');
}

/**
 * 主题用页面内联脚本写死，而不是靠 file:// 的查询参数——
 * 查询串在 file:// 下并不可靠（设置页两张图曾经因此完全一样）。
 */
function withTheme(html, theme) {
  return html.replace(
    /document\.documentElement\.dataset\.theme\s*=[^<]*/,
    `document.documentElement.dataset.theme='${theme}';`,
  );
}

const chatHtml = buildPage('test/preview-chat.html', chatReplacements, join(OUT, 'chat.en.html'));
const settingsHtml = buildPage('test/preview-settings.html', settingsReplacements, join(OUT, 'settings.en.html'));

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function shot(html, fileName, output, width, height) {
  const page = join(OUT, fileName);
  writeFileSync(page, html);
  try {
    // 用临时配置目录，避免并发/残留的 Chrome 实例抢单例导致静默失败。
    execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      // 每次都换独立配置目录：共用目录时后一次会复用前一个实例，
      // 截图会拿到上一次的页面（明暗两版曾经因此完全相同）。
      `--user-data-dir=/tmp/hwchat-shot-${fileName.replace(/\W+/g, '-')}`,
      '--force-device-scale-factor=2',
      `--window-size=${width},${height}`,
      `--screenshot=${output}`,
      `file://${process.cwd()}/${page}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`已生成 ${output}`);
  } catch (error) {
    console.error(`截图失败：${output}`);
    console.error(String(error.stderr || error.message).slice(0, 600));
    process.exitCode = 1;
  }
}

shot(withTheme(chatHtml, 'dark'), 'chat.dark.html', join(OUT, 'chat-dark.png'), 1120, 980);
shot(withTheme(chatHtml, 'light'), 'chat.light.html', join(OUT, 'chat-light.png'), 1120, 980);
shot(withTheme(settingsHtml, 'light'), 'settings.light.html', join(OUT, 'settings-light.png'), 1160, 900);
shot(withTheme(settingsHtml, 'dark'), 'settings.dark.html', join(OUT, 'settings-dark.png'), 1160, 900);
console.log('截图完成。');
