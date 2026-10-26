# HWChat

当前版本：**0.1.4**

HWChat 是面向 VS Code 的本地优先编码 Agent 扩展。项目仓库：<https://github.com/Gsaecy/DeepSeek-HWChat>

HWChat 是一个在 VS Code 内直接编码的 DeepSeek / OpenAI 兼容 Agent 扩展。它提供简洁的聊天与设置界面、原生流式 tool calling、本地 Skill、文件附件、权限预设、归档历史和可恢复的分片存储。聊天固定在 VS Code 右侧辅助侧边栏，不会再占用编辑器标签页。

## 编码 Agent

- `Agent`：读取和搜索项目、检查诊断、创建/修改/移动/删除文件、运行命令，并把工具结果继续回传模型完成多轮任务。
- `Plan`：只开放只读工具，用于分析代码和制定方案，不修改工作区。
- `Chat`：不开放工作区工具，仅使用对话和明确添加的上下文。
- 原生识别 VS Code 的单根和多根工作区，可直接列出工作区根目录、浏览目录、读取文件，并通过 `open_file` 在编辑器中打开文件，不再绕行终端、`code` CLI 或其它扩展工具。
- 在受信任工作区和当前权限预设允许时，Agent 可自行执行工作区内命令。`每次询问` / `风险操作询问` 会按策略弹窗；`Autopilot` / `完全访问` 可自动运行常规命令，但工作区外路径、未受信任工作区、敏感文件和危险命令仍受硬性安全边界保护。
- 每个执行步骤默认折叠，只显示结果摘要；展开后可查看工具输入、输出、审批状态、耗时和涉及文件。
- 可从聊天输入区添加多个文件，也可在资源管理器右键选择“HWChat: 添加文件到对话”。文件内容不会发送给 Webview，只在扩展宿主中按需加入 API 请求。
- 支持多个 OpenAI 兼容 API 配置档，每个配置档可独立保存地址、API Key、模型列表和请求头，并在对话顶部即时切换。
- 模型选择不依赖 Copilot 或其它扩展注册的模型。HWChat 会直接调用当前 API 的 `/models` 接口读取可用细分模型和展示名称，过滤接口标记为停用、过期或不可用的模型，并记住用户手动排除的模型；DeepSeek 官网接口在首次刷新前以 `deepseek-flash` 和 `deepseek-v4-pro` 作为离线兜底。
- 思考深度跟随当前模型能力：仅当 `/models` 元数据声明支持多档调节时开放选择；不支持、固定思考或能力未知的模型不会伪装成可调节。兼容接口拒绝思考参数时会自动移除不支持的参数后重试。
- 每条完成的助手回复显示本轮 Token 消耗，统一换算为百万 Token（`M tokens`）；左侧对话记录显示该对话所有轮次的累计消耗。
- 对话输入框下方直接提供权限预设、执行步骤和思考层级。执行步骤默认不限；切换到 Autopilot、完全访问或自定义权限前会显示风险说明，确认后对下一次发送立即生效。
- Agent 运行时输入框仍可编辑和发送。相关补充会合并到当前任务并在下一个工具边界重新规划，尚未执行的冲突步骤会跳过；无关任务进入可见任务树队列，前一分支完成后自动继续。
- 运行中插入的每个问题都会立即生成自己的排队回答位，并最终把结果显示在对应问题下方，不再把后续问题的答案堆到上一条回复前面。
- Agent 运行时可以自由向上查看历史；只有用户停留在底部时才自动跟随流式输出。
- 支持从输入框粘贴图片、截图和文件，粘贴后会先显示本地缩略图。图片会以兼容 OpenAI 的多模态内容发送；任务缓存到期后会移除附件正文、图片 Base64 和缩略图，只保留名称、类型和大小摘要。
- 支持语音输入。HWChat 仅接收识别后的文字，不把音频写入对话缓存；识别文字仍需点击发送才会提交给当前 API。
- 模型回复中的终端命令会显示为独立的“终端命令”代码块，并提供经 VS Code 剪贴板确认的一键复制；Agent 执行步骤中的输入、结果和实际命令也可直接复制，消息正文支持选择后用 `⌘/Ctrl+C` 复制。
- 输入框支持 `⌘/Ctrl+V` 粘贴文字、图片、截图和文件；剪贴板同时包含文字和附件时会一起保留，并在 Webview 原生粘贴失效时自动使用 VS Code 剪贴板兜底。
- 除内置工作区工具外，HWChat 会发现并调用当前 VS Code 中通过 Language Model Tool API 暴露的扩展工具；网页、文本、Markdown 和差异内容可直接在编辑区预览。
- 可从任意历史记录点击“续接”，或运行命令 `HWChat: 在新对话中续接当前任务历史`。新对话保存来源对话的本地只读交接摘要，Agent 还可按需检索来源链中的旧消息，避免重复踩已经记录的坑。旧对话不会被复制或修改；本地保存本身不产生 API Token，但实际发送给模型的摘要和检索片段会计入输入 Token。

## Skills

HWChat 扫描以下本地格式：

- `.hwchat/skills/*.md`
- `.agents/skills/**/SKILL.md`
- `.claude/skills/**/SKILL.md`
- VS Code 全局存储中的用户 Skill 目录
- `~/.copilot/skills/**/SKILL.md`

HWChat 与“本地skill快捷调用”共享 `~/.copilot/.skill-quick-launch.json`。在那里勾选的 Skill 会成为新对话的默认选择，但“默认启用”不等于每轮都加载：`route` 模式下，Agent / Plan 会先看到轻量路由表，仅在任务匹配时通过 `load_skill` 读取全文；Chat 模式会按任务文字匹配后预载。每条回复只显示本轮真正读取过的 Skill 名称和数量，并把最近调用时间同步回快捷调用扩展。

用户也可以在当前对话中手动增减 Skill。非快捷调用来源的已选 Skill，以及 `always` 模式下的 Skill，会直接加入本轮系统上下文。支持简单 YAML frontmatter 的 `name` 和 `description`。

## 权限与隐私

- API Key 使用 VS Code `SecretStorage`，不会写入项目或对话记录。
- 首次发送前明确展示数据流向并取得同意。
- 提供“每次询问 / 风险操作询问 / Autopilot / 完全访问 / 自定义”权限预设；写入和命令在未受信任工作区中始终关闭。
- `.env`、证书、私钥、SSH/AWS/Kubernetes 凭据路径默认禁止读取。
- 高风险命令默认硬拦截；即使显式允许，仍强制逐次确认。
- 子进程环境会移除常见 Token、Secret、Password 和 API Key 变量。
- 远程 API 地址必须使用 HTTPS；只有本机 `localhost`、`127.0.0.1` 和 `::1` 可使用 HTTP。
- 无遥测。对话、Skill 和 Agent 审计记录默认只保存在本机，可在设置中全部删除。

详细边界见 [SECURITY.md](SECURITY.md)。

## 历史与缓存

- 每条消息独立存储，采用同目录临时文件、原子替换和恢复备份，索引损坏时会从磁盘重建。
- 流式回复每 1.5 秒持久化；扩展异常退出后保留已经生成的内容。
- 对话支持固定、归档、恢复、搜索、删除和流式导出。
- 被续接对话引用的来源历史会受自动清理保护；手动删除来源前会提示其对后续按需检索的影响。续接对话仍保留创建时的本地摘要。
- 已完成任务的思考过程、Token 输入/输出明细、工具输入/输出和附件正文会按保留时间自动瘦身，但最终回复、累计 Token、实际调用的 Skill、工具摘要、文件列表和审批结果会保留。
- UI 和模型上下文都有条数与字节上限；附件还有单文件、数量和总容量限制。
- 超出磁盘预算时按最久未使用顺序淘汰普通对话，固定、归档和执行中的对话不会被删除。

## 开发

运行要求：VS Code `1.106.0` 或更高版本，Node.js 20+。

安装已构建的 VSIX：

```bash
code --install-extension hwchat-0.1.4.vsix
```

在 VS Code 中打开命令面板，执行 `HWChat: 打开对话面板`。首次使用时进入设置，创建一个 API 配置档并保存 API Key；密钥只会进入 VS Code SecretStorage，不会写入 `settings.json`、项目文件或 VSIX。

从源码构建：

```bash
npm install
npm run check
npm test
npm run package
```

构建结果为项目根目录下的 `hwchat-0.1.4.vsix`。同一扩展已发布过的版本不能覆盖上传 Marketplace，发布新构建时必须递增版本号。

扩展图标使用 `resources/logo.png`。在 VS Code 中按 `F5` 启动扩展开发主机。

## 主要配置

- `hwchat.apiProfiles` / `hwchat.activeApiProfileId`：OpenAI 兼容接口配置档和当前配置档。
- `hwchat.baseUrl` / `hwchat.model`：兼容旧版配置，并保存当前默认接口和模型。
- `hwchat.defaultMode` / `hwchat.agentMaxSteps`：默认模式和单轮工具循环上限；步骤为 `0` 时不限制。
- `hwchat.reasoningEffort`：默认、无、低、高、最大五档思考层级；不支持该参数的兼容接口会自动降级重试。
- `hwchat.permissionPreset`：常用权限预设。
- `hwchat.fileReadPolicy` / `hwchat.fileWritePolicy` / `hwchat.commandPolicy`：分级权限。
- `hwchat.allowSensitiveFiles` / `hwchat.allowDangerousCommands`：高风险能力开关。
- `hwchat.taskCacheRetentionHours` / `hwchat.cacheBudgetMB`：任务缓存和磁盘预算。

对话数据位于 VS Code 的全局存储目录，不会写入项目目录。
