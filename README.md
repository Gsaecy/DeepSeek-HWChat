# HWChat

[English](README.md) · [中文](README.zh-CN.md)

Current version: **0.1.9**

HWChat is a local-first coding agent for VS Code with a DeepSeek / OpenAI-compatible backend. Repository: <https://github.com/Gsaecy/DeepSeek-HWChat>

It ships a compact chat surface and settings page, native streaming tool calling, local skills, file attachments, permission presets, archived history and crash-resilient chunked storage. The chat lives in the VS Code secondary sidebar, so it never takes over an editor tab.

![HWChat chat panel: conversation sidebar and a new conversation](https://raw.githubusercontent.com/Gsaecy/DeepSeek-HWChat/main/docs/screenshots/chat-panel.png)

## Interface language

HWChat speaks Chinese and English. Open **Settings → General → Interface language** and pick `Auto` (follow the VS Code display language), `Chinese` or `English`. The chat panel, settings page, notifications and error messages switch immediately — no window reload needed.

Command palette titles and the configuration descriptions in the VS Code Settings UI follow the editor's own display language through the standard VS Code localization (NLS) mechanism.

## Coding agent

- **Agent** — reads and searches the project, checks diagnostics, creates/edits/moves/deletes files, runs commands, and feeds tool results back to the model for multi-step work.
- **Plan** — read-only tools only: analyse code and produce a plan without touching the workspace.
- **Chat** — no workspace tools at all; only the conversation and the context you explicitly attach.
- Understands single-root and multi-root VS Code workspaces natively: list workspace roots, browse directories, read files, and open them in the editor through `open_file` — no detouring through a terminal, the `code` CLI or another extension. Tools bridged from other VS Code extensions obey the same path isolation as the built-in ones, and their parameter descriptions state that file arguments must be absolute paths inside the workspace.
- In a trusted workspace, and when the active permission preset allows it, the agent runs commands inside the workspace on its own. Commands are graded in three tiers: read-only (`ls`, `git status`, `grep`…), regular (install, build, commit…) and dangerous (privilege escalation, destructive deletion, disk wiping, forced pushes, piping remote scripts into a shell…). `Ask every time` confirms everything and denies dangerous commands outright; `Ask on risky actions` and `Autopilot` run read-only and regular commands automatically and ask for dangerous ones; `Full access` even runs dangerous commands but still confirms before reading sensitive files. Untrusted workspaces and path isolation outside the workspace always apply. `sed`/`grep` pattern or script arguments (such as `sed -n '/a/,/^b/p'`) are treated as patterns and not mistaken for escaping paths, while real file arguments are still validated one by one — including direct filesystem-root targets like `rm -rf /`, which are rejected.
- Every execution step is collapsed by default and shows a result summary; expanding it reveals tool input, output, approval state, elapsed time and touched files. The expand/collapse state belongs to you: re-rendering during streaming no longer collapses a step you opened.
- Add multiple files from the composer, or right-click a file in Explorer and choose **HWChat: Add files to chat**. File contents never reach the webview; they are attached to the API request on demand from the extension host.
- Multiple OpenAI-compatible API profiles, each with its own endpoint, API key, model list and request headers, switchable from the control row under the conversation title.
- Model selection does not depend on Copilot or any other extension. HWChat calls the profile's `/models` endpoint, filters models the API marks as retired, expired or unavailable, and remembers models you excluded. Before the first refresh, the official DeepSeek endpoint falls back to `deepseek-flash` and `deepseek-v4-pro`.
- Reasoning depth follows the current model's declared capability: the selector is only enabled when `/models` metadata advertises adjustable effort. Unsupported, fixed or unknown models are never dressed up as adjustable, and compatible endpoints that reject the parameter get a retry with it removed.
- Each finished assistant reply shows its own token usage normalised to millions (`M tokens`); the conversation list shows the running total for the whole conversation.
- The chat header keeps the title and status on the first row and puts work mode, API profile, model, refresh, plus skills/archive/export/settings on a second row that wraps instead of squeezing the title.
- The composer is a single rounded box: the text area on top, and one bottom row holding permission preset, max steps, reasoning level plus attach, voice and send/stop. That row never wraps; as it narrows, the text prefixes disappear in the order reasoning → max steps → permission preset, leaving only the selected values. Switching presets shows that preset's risk summary and takes effect on the next send.
- The composer stays editable while the agent runs. Related follow-ups merge into the current task and re-plan at the next tool boundary, skipping conflicting pending steps; unrelated tasks join a visible task-tree queue and continue automatically when the current branch finishes.
- Every question you insert while the agent is running immediately gets its own queued reply slot, and the answer ends up under that question instead of being prepended to the previous reply.
- You can scroll freely through history while the agent runs; streaming only auto-follows while you are at the bottom. During execution the send button becomes a **red highlighted stop button** (danger background, breathing halo, solid square icon) so it is obvious the task is running and how to stop it; the animation is skipped when the system requests reduced motion.
- Paste images, screenshots and files straight into the composer; pasted images show a local thumbnail first. Images are sent as OpenAI-compatible multimodal content. When the task cache expires, attachment bodies, image Base64 and thumbnails are dropped while names, types and sizes remain.
- Voice input is supported. HWChat only receives the transcribed text and never writes audio into the conversation cache; the text is still only sent to the API after you press send.
- Replies are rendered as Markdown rather than one wall of text: headings (`#`–`######`), nested ordered/unordered lists, tables (with alignment and horizontal scrolling), quotes and rules, plus inline bold, `inline code`, strikethrough and `[text](link)`. Terminal commands appear as a dedicated block with one-click copy through the VS Code clipboard confirmation; tool input, results and the actual command can be copied too, and message text supports select-then-`⌘/Ctrl+C`. Step summaries read like "Process · 5 steps, 2 files changed" so non-programmers can follow along. Every "here is what I am about to do" paragraph is followed by the exact steps it triggered — what ran and how it ended — interleaved in the order things happened, so nothing has to be cross-referenced; a single-step group omits the summary heading, and older messages keep the previous "steps, then text" layout.
- The composer supports `⌘/Ctrl+V` for text, images, screenshots and files. When the clipboard carries both text and attachments, both are kept; if the webview's native paste fails, HWChat falls back to the VS Code clipboard.
- Beyond the built-in workspace tools, HWChat discovers and calls every language-model tool exposed by other VS Code extensions (no longer capped at 100). Tools that need authorisation show VS Code's own confirmation only; tools that do not are called directly and HWChat adds no extra "Allow the agent…" prompt. Extensions that declare language-model tools but are not running are activated at startup, and a tool call that hits a temporarily missing tool triggers one more activation and retry. Web pages, text, Markdown and diffs preview inside the editor.
- Continue any conversation with **Continue**, or run `HWChat: Continue current task history in a new chat`. The new conversation keeps a local read-only handover digest of the source conversation and can also search the upstream chain on demand, so previously recorded pitfalls are not repeated. The old conversation is never copied or modified. Keeping the digest is free; whatever is actually sent counts toward input tokens.

## Task list

When the work needs several steps, the agent writes a task list rather than leaving you to infer progress from the prose. It sits between the task tree and the composer, numbered in execution order: the step on the left, its state on the right.

| State | Indicator |
| --- | --- |
| Waiting to run | green hollow circle |
| In progress | green bouncing ellipsis |
| Completed | solid green circle with a white check |

Click the title to collapse or expand the list, the same way as the task tree. The agent keeps exactly one step in progress, updates the list after each step, and leaves the finished list in place as a record of what happened. The list is stored with the conversation, so it survives reloading the window; a single-step request never creates one. It is a tool (`update_todos`) that needs no permission, because it changes no files and runs no commands.

## Skills

HWChat scans these local formats:

- `.hwchat/skills/*.md`
- `.agents/skills/**/SKILL.md`
- `.claude/skills/**/SKILL.md`
- the user skill folder in VS Code global storage
- `~/.copilot/skills/**/SKILL.md`

HWChat shares `~/.copilot/.skill-quick-launch.json` with the local skill quick-launch extension. Skills ticked there become the default selection for new conversations, but "enabled by default" does not mean "loaded every turn": in `route` mode the agent first sees a lightweight routing table and only reads the full text through `load_skill` on a match; chat mode preloads on a text match. Each reply lists only the skills actually read in that turn, and the last-used timestamp is written back to the quick-launch extension.

You can also add or remove skills for the current conversation by hand. Selected skills from non-quick-launch sources, plus `always`-mode skills, join the system context directly. Simple YAML frontmatter with `name` and `description` is supported.

## Permissions and privacy

- API keys live in VS Code `SecretStorage` — never in the project, the conversation, or the VSIX.
- Before the first send, the data flow is shown explicitly and must be accepted.
- Four permission presets (no per-item custom combination), with a boundary table in settings and the same wording in the composer dropdown:

| Preset | Read | Write | Read-only commands | Regular commands | Dangerous commands | Sensitive files |
| --- | --- | --- | --- | --- | --- | --- |
| Ask every time | Ask | Ask | Ask | Ask | Deny outright | Blocked |
| Ask on risky actions | Allow | Allow (in workspace) | Allow | Allow | Ask | Blocked |
| Autopilot | Allow | Allow (in workspace) | Allow | Allow | Allow | Blocked |
| Full access | Allow | Allow (in workspace) | Allow | Allow | Allow | Ask |

- Read-only commands are side-effect-free (`ls`, `git status`, `grep`…); regular commands are everyday operations (install, build, commit…); dangerous commands cover privilege escalation, destructive deletion, disk wiping, forced pushes and piping remote scripts into a shell.
- Writes and commands are always disabled in untrusted workspaces.
- `.env`, certificates, private keys and SSH/AWS/Kubernetes credential paths follow the sensitive-file policy: blocked by default, confirmed with the target file shown when set to "Ask every time", and only read automatically when set to "Allow".
- Subprocess environments strip common token, secret, password and API-key variables.
- Remote API endpoints must use HTTPS; only `localhost`, `127.0.0.1` and `::1` may use HTTP.
- No telemetry. Conversations, skills and agent audit records stay on your machine and can be deleted from settings.

See [SECURITY.md](SECURITY.md) for the full boundary description.

## History and cache

- Every message is stored independently with same-directory temp files, atomic replacement and recovery backups; a corrupt index is rebuilt from disk.
- Streaming replies are persisted every 1.5 seconds, so content already produced survives an abnormal exit.
- Conversations can be pinned, archived, restored, searched, deleted and exported as a stream.
- Source history referenced by a continuation is protected from automatic cleanup, and deleting a source warns about the effect on on-demand retrieval. Continuations keep the local digest created at link time.
- Heavy payloads of finished tasks (reasoning, token detail, tool input/output, attachment bodies) are trimmed on schedule, while the final reply, total tokens, skills actually used, tool summaries, file lists and approval results are kept.
- Both the UI and the model context have count and byte limits; attachments additionally have per-file, count and total-size limits.
- When the disk budget is exceeded, ordinary conversations are evicted least-recently-used first; pinned, archived and running conversations are never deleted.

## Install

Requires VS Code `1.106.0` or newer.

```bash
code --install-extension hwchat-0.1.9.vsix
```

Open the command palette and run `HWChat: Open chat panel`. On first use, open settings, create an API profile and save its API key — the key only goes into VS Code `SecretStorage`, never into `settings.json`, project files or the VSIX.

## Build from source

Requires Node.js 20+.

```bash
npm install
npm run check
npm test
npm run package
```

The build output is `hwchat-0.1.9.vsix` in the project root. A version already published to the Marketplace cannot be uploaded again, so bump the version for every public build.

The extension icon is `resources/logo.png`. Press `F5` in VS Code to launch the extension development host.

## Key settings

- `hwchat.language` — interface language: `auto` (follow VS Code), `zh` or `en`.
- `hwchat.apiProfiles` / `hwchat.activeApiProfileId` — OpenAI-compatible profiles and the active one.
- `hwchat.baseUrl` / `hwchat.model` — legacy-compatible endpoint and current default model.
- `hwchat.defaultMode` / `hwchat.agentMaxSteps` — default mode and per-turn tool-loop limit; `0` means unlimited.
- `hwchat.reasoningEffort` — five levels (default, none, low, high, max); endpoints without support get an automatic retry.
- `hwchat.permissionPreset` — one of the four presets above.
- `hwchat.fileReadPolicy` / `hwchat.fileWritePolicy` / `hwchat.commandPolicy` / `hwchat.dangerousCommandPolicy` / `hwchat.sensitiveFilePolicy` — fully derived from the preset; display-only, marked deprecated in the VS Code settings UI.
- Permission settings are `resource`-scoped and may be set in a folder's `.vscode/settings.json`. Precedence is most-specific-first (workspace folder → `.code-workspace` → user), and when folders disagree the strictest value wins (`Ask every time` > `Ask on risky actions` > `Autopilot` > `Full access`).
- `hwchat.allowSensitiveFiles` / `hwchat.allowDangerousCommands` — deprecated booleans, used only as a migration fallback when the newer settings are absent.
- `hwchat.taskCacheRetentionHours` / `hwchat.cacheBudgetMB` — task cache and disk budget.

Conversation data lives in the VS Code global storage directory and is never written into your project.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/core/` | i18n, settings, permissions, storage, approval plans |
| `src/agent/` | agent loop, tool executor, path isolation, skills, task queue |
| `src/views/` | chat panel, settings panel, history view |
| `src/providers/` | DeepSeek / OpenAI-compatible client |
| `media/` | webview scripts and styles |
| `docs/screenshots/` | screenshot build script and the generated English screenshot |
| `test/` | browser preview pages used for layout checks |

The screenshot is generated with `node docs/screenshots/build.mjs`. It reuses the real webview CSS and the real English dictionary, so the image matches the shipped UI, and it renders an empty new conversation: no conversations, messages, task list, attachments or typed input are included.

## License

[MIT](LICENSE)
