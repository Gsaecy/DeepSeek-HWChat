# Changelog

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
