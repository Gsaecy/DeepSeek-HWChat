# Changelog

## 0.1.5

- Rebuilt the chat header so the conversation title keeps its own row; work mode, API profile, model, refresh, and the right-aligned Skill, archive, export, and settings controls moved to a dedicated row underneath and wrap instead of squeezing the title. The Skill button now sits directly left of settings.
- Merged the composer into one bordered card: the textarea sits on top, and a single bottom row inside the card holds the permission preset, maximum steps, reasoning depth, and the attach, voice, and send/stop buttons (attach is now left of the voice button).
- Reworked the permission matrix to the requested shape: presets now carry six independent columns (read, write, read-only commands, regular commands, dangerous commands, sensitive files). Read-only and regular commands are auto-approved from "review risky actions" upward, "full access" also auto-runs dangerous commands, and sensitive-file reads are confirmed one by one even in "full access".
- Replaced the `allowSensitiveFiles` / `allowDangerousCommands` booleans with the tri-state `hwchat.sensitiveFilePolicy` and `hwchat.dangerousCommandPolicy` (allow / ask / deny). Old booleans are kept as deprecated fallbacks and migrated on read.
- Added a sensitive-file guard that asks once per tool call with the concrete target paths, denies them under stricter presets, and keeps skipping them in workspace-wide searches unless the policy is "allow".
- Updated the settings matrix, composer preset tooltips, `package.json` enum descriptions, and docs to the new six-column model.
- Consolidated the permission model in `src/core/permissions.ts` as the single source of truth: command tiers (read-only / regular / dangerous), the six-column preset table, and the sensitive-file policy all resolve from there, so the settings matrix, composer tooltips, and runtime checks cannot drift apart.
- VS Code tool calls and built-in editor previews no longer prompt under `Autopilot` / `完全访问`; in fact every VS Code extension tool now delegates authorization to VS Code itself: tools that need no authorization run immediately, tools that declare a confirmation still show VS Code's own dialog, and cancel/deny is recorded as a denied step instead of an error.
- Fixed VS Code tools being silently dropped from the tool list: the 100-tool cap is raised to 400 with stable sorting, extensions that contribute language model tools are activated in the background (and once more on demand when the model calls a tool that is not registered yet), and unknown tool ids now return a clear message instead of a generic failure.
- Fixed tool-execution, reasoning, and Skill disclosure rows collapsing right after a click: the streaming re-render now captures and restores user expand/collapse state, and pauses rebuilding while the pointer is down in the message list.
- Fixed the toolbar collapsing into stacked full-width rows when a webview kept an older HTML structure: `media/chat.css` now also styles the legacy `.toolbar-main` / `.toolbar-connection` wrappers, and media URLs are versioned (`?v=<version>`) so HTML, CSS, and JS always come from the same build instead of a stale webview cache.
- Dimmed the composer placeholder/hint text (`--placeholder` uses 55% of the theme placeholder color) so the hint no longer competes with real input.
- Changed the user message bubble to normal editor foreground text (the label and body used to render in orange/yellow) while keeping a subtle accent background and border.
- Added a permission boundary matrix to the settings page and matching tooltips on the composer preset selector.
- Anchored the Skill panel to the dynamic header height so it keeps opening directly below the toolbar when controls wrap.
- Replaced the font-dependent glyphs with vector/CSS shapes: the composer runtime selectors draw their caret as a CSS triangle instead of the `⌄` character (which fell back to unreadable glyphs in some font stacks), and the export button now uses an inline SVG icon like every other toolbar button.
- Synced the dev preview `test/preview-chat.html` with the shipped markup (title row plus control group row, inline SVG icons), so previewing it no longer shows the retired two-wrapper toolbar or placeholder text glyphs.

## 0.1.4

- Added native multi-root workspace discovery, directory listing, and editor file opening. Requests such as opening a workspace Markdown file now use VS Code APIs directly instead of terminal commands, `code` CLI calls, or external Copilot tools.
- Added read-only task-history continuation. Any conversation can start a new linked conversation with a bounded local handoff summary and an on-demand source-history search tool; referenced source histories are protected from automatic cleanup.
- Paired every message sent during an active Agent run with its own queued or streaming assistant response, so related guidance and independent queued tasks render their answers immediately below the correct user message.
- Improved runtime command behavior and documentation: authorized Agents can execute regular commands inside trusted workspace roots, while Workspace Trust, path isolation, sensitive-file protection, and dangerous-command confirmation remain enforced.
- Filtered retired, disabled, unavailable, expired, and user-excluded models from direct API discovery, and prevented refresh from restoring models that were manually removed.
- Made reasoning controls model-aware. Adjustable levels are offered only when provider metadata declares multiple supported efforts; fixed, unsupported, and unknown models use their declared/default behavior.
- Added regression coverage for multi-root path resolution, linked-history persistence and cleanup protection, queued-response recovery, inserted-message ordering, retired-model filtering, and reasoning capability parsing.

## 0.1.3

- Changed model discovery to query each configured API's `/models` endpoint directly, preserving provider display names without depending on Copilot or models registered by other VS Code extensions.
- Updated the official DeepSeek fallback catalog to `deepseek-flash` and `deepseek-v4-pro`; when the API directory no longer contains the selected model, HWChat now switches the UI and active conversation to the first available model together.
- Kept the chat mode, Skill count, and settings controls visible on one responsive toolbar row, with profile and model selectors sharing the available width below it.
- Added persisted thumbnails for pasted images and included them in scheduled completed-task cache compaction.
- Fixed the unregistered `hwchat.reasoningEffort` upgrade-window error with a local fallback, and fixed active-section tracking in the settings navigation.
- Made the settings navigation fixed while content scrolls, removed gradient styling, and improved foreground/background contrast in light and dark VS Code themes.
- Tightened the composer action controls and hid the textarea scrollbar while preserving keyboard, wheel, and touch scrolling.
- Replaced the boxed runtime dropdowns with compact labeled text selectors for permission preset, maximum steps, and reasoning depth.

## 0.1.2

- Added runtime task trees: messages sent while Agent is running are classified as related guidance or queued branches. Related guidance triggers replanning at the next tool boundary, while independent work continues after the active branch finishes.
- Kept the composer editable during Agent runs, added explicit running state, and stopped forcing the message viewport to the bottom after the user scrolls upward.
- Added permission, unlimited-step, reasoning-effort, and voice controls directly below the composer. Risky permission presets require an explicit risk acknowledgement and persist immediately.
- Added pasted image, screenshot, and file attachments with multimodal request support and scheduled removal of cached attachment bodies and image Base64 data.
- Added automatic model discovery, reasoning-parameter compatibility retries, built-in editor previews, and invocation of tools exposed by other VS Code extensions through the Language Model Tool API.
- Added dedicated terminal command blocks with one-click copying through the VS Code clipboard.
- Fixed intermittent chat copy/paste failures by preserving text selections during streaming, acknowledging clipboard writes, and supporting text plus file/image clipboard payloads together.
- Added regression coverage for unlimited Agent rounds, runtime replanning, queued tasks, reasoning fallback, and image-cache compaction.

## 0.1.1

- Moved the complete chat and history experience into the VS Code Secondary Sidebar so selecting or creating a conversation no longer opens an editor tab.
- Added multiple API profiles with per-profile SecretStorage keys, endpoint/model switching, custom model lists, and HTTPS enforcement for remote endpoints.
- Added permission presets for ask-all, review, Autopilot, full-access, and custom workflows while retaining Workspace Trust, path isolation, and dangerous-command confirmation boundaries.
- Integrated `~/.copilot/skills` and the shared local-skill-quick-launch state. Default-selected Skills use route-on-demand loading, and each reply records only the Skills actually loaded.
- Added per-reply and cumulative conversation Token usage in `M tokens`, including aggregation across Agent tool rounds and retention through cache compaction.

## 0.1.0

- Added real multi-round native tool calling for Agent and read-only Plan modes.
- Added workspace file search/read/write/replace/move/trash tools, diagnostics, and bounded command execution.
- Added per-operation permission policies, Workspace Trust enforcement, sensitive-file protection, dangerous-command blocking, privacy consent, and local audit records.
- Added local Skill discovery and per-conversation Skill selection.
- Added file attachments from the composer and Explorer context menu.
- Added collapsible persisted execution records with concise summaries and expandable details.
- Added conversation archive/restore and protected archived records from retention and budget eviction.
- Extended scheduled cache compaction to tool details and attachment bodies.
- Bounded and redacted Agent audit data, and omitted full file-write bodies from expandable execution history.
- Added Agent-loop, streaming tool-call, archive, compaction, and data-clearing tests.
- Added a native-feeling chat panel with streaming replies and code selection context.
- Added an Apple-inspired settings panel with secure API key storage.
- Added durable, per-message history storage with atomic writes and recovery backups.
- Added scheduled task-cache cleanup, retention rules, and a configurable disk budget.
- Added history export, pinning, deletion, and an integrated conversation list.
