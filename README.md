# HWChat

[English](README.md) · [中文](README.zh-CN.md)

HWChat is a local-first coding agent for VS Code with a DeepSeek / OpenAI-compatible backend.

It ships a compact chat surface and settings page, native streaming tool calling, local skills, file attachments, permission presets, plan-tracking task lists with archived snapshots, terminal commands labelled with where they run and which shell to use, archived history and crash-resilient chunked storage. The chat lives in the VS Code secondary sidebar, so it never takes over an editor tab.

![HWChat chat panel: conversation sidebar and a new conversation](https://raw.githubusercontent.com/Gsaecy/DeepSeek-HWChat/main/docs/screenshots/chat-panel.png)

## Interface language

HWChat speaks Chinese and English. Open **Settings → General → Interface language** and pick `Auto` (follow the VS Code display language), `Chinese` or `English`. The chat panel, settings page, notifications and error messages switch immediately — no window reload needed.

Command palette titles and the configuration descriptions in the VS Code Settings UI follow the editor's own display language through the standard VS Code localization (NLS) mechanism.

## Coding agent

- **Agent** — reads and searches the project, checks diagnostics, creates/edits/moves/deletes files, runs commands, and feeds tool results back to the model for multi-step work.
- **Plan** — read-only tools only: analyse code and produce a plan without touching the workspace.
- **Chat** — no workspace tools at all; only the conversation and the context you explicitly attach.
- The active mode comes from the composer dropdown and, for new conversations, from `hwchat.defaultMode`: switching in the dropdown is written to the current conversation immediately and stays in force for every later request. Each request also states the mode explicitly in the system prompt (and marks it authoritative for that turn), so continuing a conversation after a switch never rides on the previous mode's assumptions. The tool list, the permission gate and the prompt all read the same resolved mode.
- Understands single-root and multi-root VS Code workspaces natively: list workspace roots, browse directories, read files, and open them in the editor through `open_file` — no detouring through a terminal, the `code` CLI or another extension. Tools bridged from other VS Code extensions obey the same path isolation as the built-in ones, and their parameter descriptions state that file arguments must be absolute paths inside the workspace.
- In a trusted workspace, and when the active permission preset allows it, the agent runs commands inside the workspace on its own. Commands are graded in three tiers: read-only (`ls`, `git status`, `grep`…), regular (install, build, commit…) and dangerous (privilege escalation, destructive deletion, disk wiping, forced pushes, piping remote scripts into a shell…). `Ask every time` confirms everything and denies dangerous commands outright; `Ask on risky actions` and `Autopilot` run read-only and regular commands automatically and ask for dangerous ones; `Full access` even runs dangerous commands but still confirms before reading sensitive files. Untrusted workspaces and path isolation outside the workspace always apply. `sed`/`grep` pattern or script arguments (such as `sed -n '/a/,/^b/p'`) are treated as patterns and not mistaken for escaping paths, while real file arguments are still validated one by one — including direct filesystem-root targets like `rm -rf /`, which are rejected.
- While a command runs, the step card keeps telling you it is still alive: it refreshes `running 12.3s` every second instead of only showing a duration after the fact. If a command produces **no output for 30 seconds**, the card switches to the warning colour, states "No output for Xs — may be waiting for terminal input", and raises a notification that also names the timeout cap. That number refreshes **every 10 seconds** rather than freezing at 30 — a frozen figure next to a ticking `running` counter looks like the UI hung again — while the notification itself fires once, so it stays a signal instead of noise. Its display time scales with the text: the Chinese stall warning now stays about 9 seconds (it used to be a flat 4.2 seconds, which is not enough to read sixty-odd characters), short toasts keep their 4 seconds, and clicking a notification dismisses it immediately. This matters because a hung command and a busy one are otherwise indistinguishable. Timeouts terminate the whole **process group**: killing only the shell leaves grandchildren such as `cargo` or `qlmanage` alive, still holding the output pipe open and hanging the call forever (this really happened — the card sat on "preparing to run command" for half an hour while the test process had used 0.01 s of CPU). Settling has three fallbacks — a normal close, a grace period after exit, and a hard deadline after SIGKILL — so a call always returns. HWChat **cannot hand the terminal over to you**: commands that need a password (`sudo`, `ssh`) read EOF and fail fast, so use non-interactive forms. The per-command limit is the smaller of the configured value and the tool request — 120 seconds by default (5–900 s in settings) — so asking for a larger value does not extend it.
- Every execution step is collapsed by default and shows a result summary; expanding it reveals tool input, output, approval state, elapsed time and touched files. The expand/collapse state belongs to you: re-rendering during streaming no longer collapses a step you opened.
- Add multiple files from the composer, or right-click a file in Explorer and choose **HWChat: Add files to chat**. File contents never reach the webview; they are attached to the API request on demand from the extension host.
- Multiple OpenAI-compatible API profiles, each with its own endpoint, API key, model list and request headers, switchable from the control row under the conversation title.
- Model selection does not depend on Copilot or any other extension. HWChat calls the profile's `/models` endpoint, filters models the API marks as retired, expired or unavailable, and remembers models you excluded. Before the first refresh, the official DeepSeek endpoint falls back to `deepseek-flash` and `deepseek-v4-pro`.
- Reasoning depth has five options: **Default (model)** / low / medium / high / max. New conversations start at Default (model), which sends **no** `reasoning_effort` or `thinking` at all and lets each model use its own official default. Each level is sent the way the model's own API documents it: the official DeepSeek endpoint accepts `low`/`medium`/`high`/`max` (`medium` is mapped to `high` server-side), so all four go out verbatim, while other OpenAI-compatible endpoints have no `max` level and receive their highest level, `high`. The selector is only enabled when the current model advertises adjustable effort; unsupported, fixed or unknown models are never dressed up as adjustable, and compatible endpoints that reject the parameter get a retry with it removed.
- Max steps has four presets: 24 / 68 / 120 / unlimited (new conversations always start at 24). Unlimited means no round cap, and the loop still stops on its other guards: the same tool call three times in a row, several rounds without progress, the per-run tool-call budget, and the stop button. A stored `0` from an older conversation or setting is the explicit "unlimited" value; negative or invalid values still fall back to the default 24.
- Each finished assistant reply shows its own token usage normalised to millions (`M tokens`); the conversation list shows the running total for the whole conversation.
- In that conversation list, a running conversation shows **Running** in the accent colour (blue) while the timestamp and token count stay muted, so the one that is actually working stands out at a glance. Conversations waiting for approval keep the plain colour.
- The chat header puts the title on the first row, the status text ("Ready · N tools" / running) together with the project name on the row beneath it, and work mode, API profile, model, refresh, plus skills/archive/export/settings on a separate row that wraps instead of squeezing the title. The dropdowns and the skills button keep only what carries information — text plus a chevron with a fixed gap for the three selects, the star icon alone for skills (its count moved into the tooltip) — so the header has room for the title. Each select is sized to its content and none of them grows: mode 60px, profile 82px, model 150px, so the model box never eats the whole row and turns into an oversized empty field. The row itself is **justified** (`justify-content: space-between`): the controls used to sit inside three `control-group` wrappers, so leftover width was only distributed *between* groups while each group kept its fixed 6px — which read as tight inside a group and loose between groups. The wrappers are gone from the template, so all eight controls are direct children of `.toolbar-controls` and the leftover width is split evenly between every adjacent pair: every neighbouring pair sits the same distance apart, with the first and last control flush to the row edges (`gap` stays as the minimum so they never touch when the row is nearly full).
- The conversation title is editable: the pencil icon at the right turns the title into an underlined inline field, with a check to save and a cross to discard (Enter/Esc do the same). Custom titles are capped at 48 characters and are never overwritten by the automatic title taken from the first message. Renaming does not bump `updatedAt`, so the history order does not jump.
- The project name sits in the status row under the title, immediately to the right of the status text (the row is left-aligned with a fixed 8px gap, so it never covers the status), so it never eats the title's width: the workspace folder this conversation is bound to, in orange. The label is **plain text** — no pill, no border, no padding. When no folder can be determined it turns red and reads **No project yet** — that state is real, because relative paths then fall back to the first root and git writes are refused, so guessing a folder name would be misleading. The label flips to orange as soon as the conversation touches a file and binds its project root. Additional project labels, if any, flow left to right after the status text; a long project name is truncated first (capped at half the row) while the status text keeps at least 45% of the width.
- That label lists **every project the conversation touched**, not just the one it bound to first: a conversation often spans several projects (build the feature in A, fix B's integration along the way), and showing only the first one hides both "it changed something elsewhere" and "you accidentally edited another project". Each successful write records its project root once, in first-touched order; refused or failed writes do not count as a change, and read-only commands (`git status`) do not either. Names are joined with `·` and folded into `+N` when the row runs out — hover for the complete list. Conversations from before this change have no such record, but theirs is recovered from the folder-name prefix of the paths in their tool history, so they show multiple projects too.
- The composer is a single rounded box: the text area on top, and one bottom row holding permission preset, max steps, reasoning level plus attach, voice and send/stop. That row never wraps; as it narrows, the text prefixes disappear in the order reasoning → max steps → permission preset, leaving only the selected values. A new conversation starts at Ask every time / 24 steps / reasoning high. Switching presets shows that preset's risk summary and takes effect on the next send.
- The composer stays editable while the agent runs. Related follow-ups merge into the current task and re-plan at the next tool boundary, skipping conflicting pending steps; unrelated tasks join a visible task-tree queue and continue automatically when the current branch finishes.
- Every question you insert while the agent is running immediately gets its own queued reply slot, and the answer ends up under that question instead of being prepended to the previous reply.
- You can scroll freely through history while the agent runs; streaming only auto-follows while you are at the bottom. During execution the send button becomes a **red highlighted stop button** (danger background, breathing halo, solid square icon) so it is obvious the task is running and how to stop it; the animation is skipped when the system requests reduced motion.
- Paste images, screenshots and files straight into the composer; pasted images show a local thumbnail first. Images are sent as OpenAI-compatible multimodal content. When the task cache expires, attachment bodies, image Base64 and thumbnails are dropped while names, types and sizes remain.
- **Attachments are clickable and open in the editor**, in the composer and in sent messages alike, so a wrong paste can be checked before sending. Files picked from disk open at their original path — nothing is copied, moved or rewritten. Pasted text opens as an untitled document and never touches disk. Pasted images get a content-addressed copy inside the extension's own storage, so no files appear in your workspace and repeated clicks reuse the same cached copy.
- **Files mentioned in a reply are clickable and can be located in your system file manager.** A path the model writes (`src/core/ids.ts`, `media/chat.js:745`) renders as a small chip instead of dead monospace text: hovering lifts it slightly and the tooltip carries the full absolute path; **click** opens it in the editor (jumping to the line when one is given), **right-click** opens a four-item menu: reveal in Finder / Explorer (with the file selected), reveal in the **VS Code Explorer view** (expands the project tree and selects the file there, leaving the editor untouched), open in the editor, and copy full path. Those two "reveal" entries are deliberately separate features - one takes you out of VS Code to the system file manager, the other keeps you in the editor - so they are two distinct commands (`revealFileInOS` / `revealInExplorer`) and two distinct messages; the VS Code one also checks first whether the file is inside the workspace, because `revealInExplorer` is silently a no-op for anything outside it. The second entry is worded "Reveal in Explorer View" rather than "Reveal in Explorer" because on Windows the system file manager is also called Explorer and two identically named entries would be impossible to tell apart. A path written in backticks (reference form) shows the relative path plus line number; a **bare path with no reference formatting** is still recognised but shows the **complete absolute path**, so you can find the file outside VS Code. Detection uses an extension allowlist, so `v0.2.4`, `e.g.`, `example.com`, URLs and `--force` never grow a menu; paths containing spaces are only recognised inside backticks, where the boundary is unambiguous; and a path glued to Chinese text is still picked out exactly. Naming follows the platform: Finder on macOS, Explorer on Windows, file manager elsewhere. The whole path is read-only — showing and opening never move, rename or rewrite the referenced file. **Every reference is verified before it is shown**: after rendering, each one is sent back to the extension once, which checks the real file system - an absolute path must exist; a relative path with directories is resolved only against the project root and the workspace roots and never falls back to a same-named file elsewhere; a bare filename is first joined to the roots (`package.json` and friends live there) and only then looked up by name across the tree, and **only a single match counts** (pointing at the wrong file is worse than showing no reference at all); when nothing can be determined, the chip degrades back to plain text with the original wording untouched. When the verified file is a different one (`extension.js` → `out/extension.js`), the label, tooltip and both click targets are switched over together, so a chip never says A while opening B.
- Voice input is supported. HWChat only receives the transcribed text and never writes audio into the conversation cache; the text is still only sent to the API after you press send.
- Replies are rendered as Markdown rather than one wall of text: headings (`#`–`######`), nested ordered/unordered lists, tables (with alignment and horizontal scrolling), quotes and rules, plus inline bold, `inline code`, strikethrough and `[text](link)`. Commands you have to run yourself appear as a dedicated block whose header states **where** it runs (`loc=local` local terminal, `loc=server` remote host shown in a warning colour, or `loc="custom label"`) and **with which tool** (`bash`, `zsh`, `cmd`, `powershell`…), with one-click copy through the VS Code clipboard confirmation that copies the command only and never the labels; commands written inside a list item are rendered as a block too instead of leaking as literal backticks; tool input, results and the actual command can be copied too, and message text supports select-then-`⌘/Ctrl+C`. Step summaries read like "Process · 5 steps, 2 files changed" so non-programmers can follow along. Every "here is what I am about to do" paragraph is followed by the exact steps it triggered — what ran and how it ended — interleaved in the order things happened, so nothing has to be cross-referenced; a single-step group omits the summary heading, and older messages keep the previous "steps, then text" layout. Reminders you must not skim past are rendered as **graded callouts**: writing `> [!DANGER] short title` turns the title red and paints the icon in a bright warning yellow, `> [!IMPORTANT] short title` keeps the normal title colour and only turns the icon orange, and anything else stays a plain quote. The level comes from that explicit marker rather than from guessing the wording, and `[!DANGER]` is reserved for exactly three kinds of unrecoverable harm: **destroying the project** (source, uncommitted work, already-shared history), **destroying the disk or the system** (formatting, raw device writes, wiping a home directory, breaking the shell environment) and **leaking credentials or personal data** (passwords, private keys, API keys, tokens, certificates, `.env`; government ID numbers, bank card numbers, phone numbers). One question decides it: after this happens, can you still get your work and your machine back untouched? If yes it is not a danger callout — deleting temporary files, reversible edits and ordinary code changes stay plain text no matter how large they look. And when you paste a plaintext credential such as an API key or a private key into the chat, the UI does not wait for the model to notice: it puts a danger callout right under that message, naming only the kind of credential and its character count, never echoing the secret itself. Government ID numbers, bank card numbers and phone numbers trigger it too, because unlike a key they cannot be revoked once sent — the callout suggests sending only a masked fragment. The two groups get separate advice (rotate a credential; report a lost card and watch for fraud). Detection uses structural checks (mod 11 for IDs, Luhn for cards, carrier prefixes for phones), so placeholders like `sk-xxxx` or `your_api_key_here`, commit hashes, version numbers, timestamps and ordinary order numbers do not trigger it. A closing `🔔 需要你做的` checklist is always a plain numbered list (`1. **action**`) and never shows `[ ]` checkbox markers: the rule lives in HWChat's own system prompt (`src/agent/followUpPrompt.ts`) and the renderer strips the marker again (`media/follow-up-format.js`), so the layout holds whether or not the model complies. Only ordered lists are affected — a genuine `- [ ]` task list stays intact, and the stored message text is never rewritten.
- The composer supports `⌘/Ctrl+V` for text, images, screenshots and files. When the clipboard carries both text and attachments, both are kept; if the webview's native paste fails, HWChat falls back to the VS Code clipboard.
- Beyond the built-in workspace tools, HWChat discovers and calls every language-model tool exposed by other VS Code extensions (no longer capped at 100). Tools that need authorisation show VS Code's own confirmation only; tools that do not are called directly and HWChat adds no extra "Allow the agent…" prompt. Extensions that declare language-model tools but are not running are activated when you **open the HWChat panel or send a message** (no longer unconditionally at VS Code startup), and a tool call that hits a temporarily missing tool triggers one more activation and retry. Web pages, text, Markdown and diffs preview inside the editor.
- Continue any conversation with **Continue**, or run `HWChat: Continue current task history in a new chat`. The new conversation keeps a local read-only handover digest of the source conversation and can also search the upstream chain on demand, so previously recorded pitfalls are not repeated. The old conversation is never copied or modified. Keeping the digest is free; whatever is actually sent counts toward input tokens.

## Task list

When the work needs several steps, the agent writes a task list rather than leaving you to infer progress from the prose. It sits between the task tree and the composer, numbered in execution order: the step on the left, its state on the right.

| State | Indicator |
| --- | --- |
| Waiting to run | green hollow circle |
| In progress | green bouncing ellipsis |
| Completed | solid green circle with a white check |

All three marks are **inline SVG icons, not font characters**: the shape and weight are identical on macOS and Windows, the colour follows the theme, and nothing depends on whether the system font happens to contain the glyph or what its metrics are. The disclosure arrows work the same way (one masked chevron rotated 90° instead of a `▸` / `▾` character). A small set of emoji in **agent output** (`🔔 📌 💡 🚀 🔍 ⚠ ✅ ❌ 📝`) is replaced with the same icon set, because system emoji are coloured and glossy and cannot be flattened with CSS; the swap happens on rendered text nodes, skips `<pre>` / `<code>`, and leaves unlisted emoji alone.

Click the title to collapse or expand the list, the same way as the task tree. **A new list opens the panel automatically** — the collapsed state is only remembered within one list, so a list that was collapsed earlier never makes a new task look like it never started. The agent keeps exactly one step in progress, updates the list after each step, and leaves the finished list in place as a record of what happened. The list is stored with the conversation, so it survives reloading the window; a single-step request never creates one. It is a tool (`update_todos`) that needs no permission, because it changes no files and runs no commands.

### Two things the task list never contains

A **push** and a **version bump** are never task-list items. Both are asked about separately once the work is finished and verified, and happen only after you say yes.

This is not tidiness for its own sake. The moment a list reads `6. Commit and push`, clicking **Continue** shows you those steps and approves the work they describe — so a push you never asked for gets authorised by the list itself. And that item is usually not the agent smuggling something in; it is the plausible expansion "while I am committing, I may as well push", which is exactly the kind of line nobody re-reads.

Two layers are needed, because either one alone leaks: a prompt rule that keeps these steps out when the work is broken down, and a filter before the list is stored that removes them if the model writes them anyway — plus a note in the tool result telling it to ask you afterwards.

The filter is deliberately narrow and only matches real repository actions: `git push`, "push to remote / origin / branch", "push the code to origin", "bump the version to 0.2.4", `npm version patch`, "bump to 0.2.4". "Implement message push", "a toggle for push notifications" and "send a push notification to the device" are ordinary feature work, and "package as version 0.2.3" or "fix the version label" are a build step and a copy change — none of those are removed. If every item in a list is one of the excluded kinds, the list stays as it was rather than being emptied.

### After an interruption: continue or cancel

When a run is cut short (process killed, stop pressed) or the model finishes without ticking the last boxes, two buttons appear at the far right of the list header: **Continue** and **Cancel task**.

- **Continue** picks the work up from where it stopped instead of redoing finished steps. Context is rebuilt from the archive, so the model sees the list it wrote and every tool result up to the interruption. The button only appears while unticked items remain. It clears the interrupted flag before starting the run, then re-reads the archive afterwards: if the run never actually started (a denied approval, a blocked send, an error before dispatch), the flag is put back so the list cannot get stuck half-done with no way to resume.
- **Cancel task** clears the list without archiving it and without leaving a capsule — it means "stop keeping this". If the run is still going, it is stopped first, so the end-of-run bookkeeping cannot write the cleared list back.

The header is split into **fixed-width** sections (title / state / actions), each left-aligned inside its own section, so a longer or shorter state text can no longer push the title around. The task-tree header has only the title and the node count. To keep the state section at a fixed width, the English state text was also shortened from `interrupted, can be resumed` to `interrupted` — the buttons already say it.

### Archived capsules

Once every step is **completed**, the list is archived immediately — not when the run ends: the moment the last item is ticked, it leaves the composer area, the task-list disclosure disappears, and a solid-colour rounded rectangle takes its place above the input box, left-aligned. That removes the "finished but still taking up space" case: the model usually keeps writing its summary after the last tick, and if the process is killed or the window closed in between, the end-of-run bookkeeping never runs and a finished 6/6 list would sit there forever (reading a conversation also archives such leftovers).

- A capsule holds **no icon and no text**, and hovering it shows nothing — the colour and the left-to-right order are the whole message. Screen readers still get "Archived task list, N/M done".
- **The border shows the state**: the archive you have open gets a **red border**, and the capsule under the pointer gets a **light red border** so you can tell which one you are about to click (hovering never changes the capsule's own solid colour). The border is painted inside the capsule, so nothing shifts or resizes when it appears.
- Click a capsule to expand that snapshot (title reads "Archived task list", the summary carries the archive time, the border turns dashed); click again to collapse.
- **Only one panel is expanded at a time**: opening the snapshot closes and locks the task tree and the list that is still running (their titles dim, and clicking them says to collapse the archive first), so you are only ever looking at one list. Collapsing the snapshot — via its own title bar, or by clicking the same capsule again — unlocks them and restores whatever you had open before. The panel area also has a height ceiling and scrolls internally (the **scrollbar is always visible**, so both the wheel and dragging work), so it can never push the composer out of the window. While a snapshot is open the other two panels collapse to their title bars, and the pane gets a taller ceiling so more rows fit at once.
- A conversation can hold several archives; each new one appears to the right of the previous one. Colours are **one continuous ramp from light blue `#7cbef0` to deep blue `#1e4fd8`**, sampled evenly by position, so the step between any two neighbours is the same size — it reads as a gradient rather than a few jump-cuts, getting deeper towards the right.
- Capsules **never wrap** and keep a fixed **3:1** width-to-height ratio, 10.67px tall (32px wide). When the row is too narrow it **scrolls horizontally with no scrollbar at all** (a 6px track is nearly half the capsule's own height — it both obscured the row and pulled the eye): scroll it with the mouse wheel over the row, or **hold the mouse button and drag** (the cursor is `grab`, turning into `grabbing` while dragging; touch screens use the platform's native momentum scrolling). Once the row is scrolled to an end, the wheel goes back to scrolling the page vertically. Capsule size stays constant. A newly added archive scrolls itself into view once, while re-renders (expanding or collapsing a snapshot) leave your scroll position alone. The corner radius is about 3px, and each capsule remains a rounded rectangle, never a pill.
- A conversation keeps at most 12 archives; beyond that the oldest is dropped. Lists that ended with unfinished items are **not** archived — see "Unfinished lists" below.
- Archives are persisted with the conversation (`todoArchives` in the manifest), so they survive a reload; malformed entries on disk are dropped at load time without affecting the conversation.

### Unfinished lists (interrupted / not finished)

When a run ends with items still open, the list does not become a capsule: it **stays in the panel** and the `in_progress` item is downgraded to **waiting** (hollow green circle) so the bouncing animation stops — nothing is advancing it, so it must not pretend to be running. The note in the disclosure header depends on **how the run ended**:

- **interrupted, can be resumed** — you pressed stop, the request failed, or the window/process went away. The work was cut off mid-flight.
- **not finished, can be resumed** — the agent loop finished normally but the model forgot to tick the last item. That is not an interruption, so it is labelled in a neutral colour instead of the warning amber that would make it look cut off. The engine deliberately does **not** tick it for the model: the list is the model's own statement of what is done, and auto-ticking would be fabricating progress. Prevention lives in the system prompt instead — before ending a turn the model must re-read the list and, for any item whose work is finished (including the very last one), call `update_todos` once more to mark it completed.

Either way the follow-up is the same:

- **Carry on**: ask the agent to continue. It reuses the same list, sets the current item back to `in_progress`, and once everything is completed the list is archived as usual. This resume instruction **binds to that list exactly once**: the panel scopes the turn to the list's unticked items instead of treating "continue the task list" as the task itself, so an unrelated request made meanwhile is queued (shown as waiting in the task tree) rather than merged into the running turn. When every item is already ticked, or there is no list at all, it does not apply. **Continue approves that you keep doing what you already asked for — not every line of the list.** The list is the agent's plan, not a record of what you approved; if it added something you never asked for (a push, a version bump), that step needs its own yes.
- **Start something else**: just ask for the new task. The new list the model writes **replaces** the old one wholesale — the old list is not kept and is not archived.

Both flags are persisted with the conversation (`todosIncomplete` / `todosInterrupted` in the manifest) and are **mutually exclusive**: one list only ever carries one of them, and both are cleared when a new list arrives or the list is archived. Older saves without these fields are treated as unmarked.

## Concurrent conversations

Every conversation runs its own agent thread; they do not block each other:

- You can start a new chat or open another history entry while a reply is streaming — the conversation you leave keeps running in the background and is marked with a blue "running" dot in the history list.
- What the new-chat button does: if the current conversation **has content**, it creates a new one (a card appears in the sidebar immediately and the right pane switches to its empty chat); if the current one **is already empty** (0 messages), nothing is created — focus just returns to that empty chat. Otherwise repeated clicks pile up a stack of identical "New chat · empty" cards. Empty conversations that already piled up are collapsed to the newest one by the periodic cleanup (5 minute grace period; an empty conversation has nothing to lose).
- Stop only stops the thread you are looking at; archive and delete only guard their own conversation.
- Model / mode / skills / permission preset are disabled only while that conversation itself is busy, never because some other conversation is running.
- When a background thread finishes, only the history list is refreshed, so your scroll position in the current conversation is preserved.
- The history list is ordered by **creation time** (newest first), not by last activity. Sending a message in an old conversation no longer bumps it to the top, so every entry keeps its place and you do not have to re-scan the list after each reply. Pinned conversations still float to the top and archived ones still sink to the bottom.
- Your unsent text in the composer belongs to the conversation you typed it in. Switching conversations saves the draft and restores the one belonging to the conversation you open — text you typed in one chat can no longer be sent to another by mistake.

### Per-conversation settings

Mode, model, permission preset, max steps and reasoning effort belong to **the conversation itself** (`src/core/conversationControls.ts`, `src/core/modes.ts`).

- **A new conversation always starts at “Ask every time” / 24 steps / “Default (model)”**, regardless of older values in `settings.json`. Earlier versions wrote the panel's choice into global settings, so leftovers such as `hwchat.permissionPreset: autopilot` and `hwchat.agentMaxSteps: 0` made every new conversation auto-execute with no step cap. Those keys are still registered (so no "unknown configuration" warning) but marked deprecated and **never read**; `HWChat: Show permission scope` still prints the declared values so you can reconcile them.
- Switching conversation A to "Full access" does not loosen the permissions of conversation B running in the background, and changing B's step limit does not truncate A's next round.
- Changes made in the panel are written back to the current conversation only — never to global configuration.
- **The permission preset can be switched while a task is running** (like Copilot). A run snapshots its settings when it starts and every tool call reads that snapshot, so switching mid-run **never changes the running task**; the new preset is stored on the conversation and applies from the next conversation after the task finishes. The UI says so explicitly, and widening to Autopilot / Full access still asks for confirmation.
- Invalid stored values (misspelled preset, string step limit, non-string project root) are dropped on load and fall back to defaults instead of being carried into a run.

## git and project scope

HWChat never commits on its own. git write operations (`add`, `commit`, `push`, `tag`, `reset`, `clean`, `merge`, `rebase`, `checkout`, `restore`, `stash`) are allowed only when:

1. the user explicitly asked to commit, push or tag in the current conversation (negations such as "don't commit yet" do not count), or
2. an enabled skill rule requires committing after finishing a task — this counts as an explicit request.

The system prompt states the same rule, but the boundary is enforced at runtime: `ToolExecutor` parses every command for git subcommands and refuses unauthorized ones with an explanation, and bridged VS Code tools (such as `run_in_terminal`) are checked through their JSON arguments so the rule cannot be bypassed by switching channels. Read-only inspection (`status`, `diff`, `log`, `show`) is always allowed.

**Commits stay inside the project this conversation belongs to:**

- Each conversation binds a project root (`projectRoot`) on its first file write or on an explicit `cwd`. Relative paths, the default command `cwd` and newly created files belong to that project instead of "the first root of the multi-root workspace".
- Before a git write, the real repository root is read with `git rev-parse --show-toplevel` and must match the project root. A repository that also contains another workspace project is refused too, because one `git add -A` would sweep that project's changes in.
- While the project root is undetermined, git writes only accept an explicit `cwd`; the "default lands on the first root" behavior is never treated as project ownership.

## Version numbers: asked after the task, never bumped on its own

HWChat **does not bump versions on its own** either. The version number is the user's decision, not a finishing step:

- It must not edit the `version` field of `package.json` / `package-lock.json` / `manifest.json` and similar manifests, and must not run `npm version` / `yarn version` / `cargo set-version` / `standard-version` or create git tags.
- It asks only when asking is due, and only once:
  - **short tasks** — after every problem mentioned in the conversation is finished and verified;
  - **long tasks** — at a clear phase boundary, or after the whole task is done;
  - never mid-task, and never bundled into the middle of an unfinished step.
- Until the user says yes, versions and git history stay untouched and the remaining work continues. An explicit request ("bump to 0.2.3") or an enabled skill rule counts as permission.

The same rule is enforced at runtime (`src/agent/releasePolicy.ts`): when a write touches a version manifest, the project's own `version` field is compared and a change is refused with an instruction to ask the user first; `npm version`-style commands are refused as well, and bridged VS Code tool arguments are checked so switching channels does not bypass it. Read-only queries (`npm --version`, `git tag -l`) remain allowed.

Only **project-level** version numbers count: dependency versions inside `package-lock.json`, and `version` entries in a `Cargo.toml` dependency table, are not treated as bumps. When a manifest cannot be parsed the write is not blocked — refusing to break a normal file repair matters more than catching that edge.

## Skills

HWChat scans these local formats:

- `.hwchat/skills/*.md`
- `.agents/skills/**/SKILL.md`
- `.claude/skills/**/SKILL.md`
- the user skill folder in VS Code global storage
- `~/.copilot/skills/**/SKILL.md`

The star button opens the "skills used in this conversation" panel. **Its ticks are wired straight to the local skill quick-launch extension**: when that extension is installed, the global tick list it maintains (`active` in `~/.copilot/.skill-quick-launch.json`) is each new conversation's starting selection. After that, ticking or unticking in the chat panel affects **only the current conversation** and is never written back to that list — a temporary opt-out for one task should not silently change the default for every future conversation. To change the default, tick in the quick-launch panel. Tick or no tick, "selected" does not mean "loaded every turn": in `route` mode the agent first sees a lightweight routing table and only reads the full text through `load_skill` on a match; chat mode preloads on a text match. Each reply lists only the skills actually read in that turn, and the last-used timestamp is written back to the quick-launch extension (timestamp only, never the ticks). Installing, uninstalling, enabling or disabling that extension updates the panel immediately (via `extensions.onDidChange`) — no window reload — and a tick change on its side is picked up too.

Without the quick-launch extension the star button shows **only an install hint** (with a "Not installed" badge) and an "Open extension page" button — no skill list at all: with no source for the defaults, the panel's one job is to send you to install it. The button opens the extension page inside VS Code via the built-in `extension.open` command (so you can tick right after installing), falls back to `workbench.extensions.search`, and only then opens the Marketplace page through `vscode.env.openExternal`. **Uninstalling that extension does not delete `.skill-quick-launch.json`**, so HWChat stops reading it once the extension is gone — otherwise those 30-odd stale `active` entries would mark every skill as "enabled by default" and pre-tick it, which looks exactly like a botched uninstall. The skills themselves are still discovered under `~/.copilot/skills/` (that is Copilot's skill directory and does not come and go with the extension); they just stop being steered by an orphaned state file.

Skills from other sources (`.hwchat/skills`, `.agents/skills`, `.claude/skills`, the extension's own user skill folder) are also selected per conversation; `always`-mode skills join the system context directly. Simple YAML frontmatter with `name` and `description` is supported.

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
- Tool approvals are answered **inside the chat panel** (a card above the composer with Deny / Allow once and collapsible details) instead of a modal dialog that freezes the whole VS Code window. While an approval is pending you can still drag sashes, switch conversations and edit files. If the conversation waiting for approval is in the background, the history list marks it with an amber "waiting for approval" dot; a request is voided immediately when its task is stopped or finished.
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
bash scripts/install-local.sh
```

`scripts/install-local.sh` picks the newest VSIX in the project root, locates the VS Code `code` CLI on its own, and passes `--force` so re-installing the same version works. When no `code` is found it does not just fail: it prints the two alternatives (`Shell Command: Install 'code' command in PATH`, or the Extensions view `⋯` → `Install from VSIX…`). `--check` reports which package would be installed and what is installed now without installing; `--list` only lists installed versions; for a VS Code that lives elsewhere (Insiders, say) pass `HWCHAT_CODE_CLI=/path/to/code bash scripts/install-local.sh`.

The equivalent one-liner, without the script:

```bash
code --install-extension "$(ls -t hwchat-*.vsix | head -n 1)" --force
```

It always installs the newest VSIX in the project root, so it never goes stale.

> Reload the window afterwards (`Developer: Reload Window`). The chat UI runs inside the installed extension host, so without a reload you are still testing the old code.

Open the command palette and run `HWChat: Open chat panel`. On first use, open settings, create an API profile and save its API key — the key only goes into VS Code `SecretStorage`, never into `settings.json`, project files or the VSIX.

## Build from source

Requires Node.js 20+.

```bash
npm install
npm run check
npm test
npm run package
```

The build output is `hwchat-<version>.vsix` in the project root, where `<version>` comes from `package.json`. A version already published to the Marketplace cannot be uploaded again, so bump the version for every public build.

Nothing in this README needs editing when packaging: the Extensions view and the Marketplace read the version, repository, license and issue links from `package.json`, so they are never duplicated here. Version history lives in [CHANGELOG.md](CHANGELOG.md).

The extension icon is `resources/logo.png`. Press `F5` in VS Code to launch the extension development host.

## Key settings

- `hwchat.language` — interface language: `auto` (follow VS Code), `zh` or `en`.
- `hwchat.apiProfiles` / `hwchat.activeApiProfileId` — OpenAI-compatible profiles and the active one.
- `hwchat.baseUrl` / `hwchat.model` — legacy-compatible endpoint and current default model.
- `hwchat.defaultMode` / `hwchat.agentMaxSteps` — default mode and per-turn tool-loop budget. The budget **defaults to 24 and is capped at 200**; `0` (the old "unlimited") and invalid values fall back to the default, so an old saved conversation can never bypass the cap. When the budget runs out the agent stops calling tools, keeps every result, and tells you to reply "continue". **Both only seed new conversations**; once a conversation exists its own record wins and panel changes are written back to that conversation.
- `hwchat.searchExclude` — extra directory names excluded from HWChat's workspace search, on top of the built-in list (`.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.turbo`, `.venv`, `venv`, `__pycache__`, `DerivedData`, `.cache`). Searches also run one at a time, identical concurrent searches are merged, and results are cached for ~1.5 s with invalidation on every write/save/delete. Commands get their own limit of two and drop to one at a time for 5 s after an `EAGAIN`-class resource error. The skill list is no longer rescanned on every state push (30 s freshness window plus request coalescing, with watcher-driven forced refreshes), command output is accumulated within a byte budget instead of re-encoding the whole buffer per chunk, and history is read once instead of twice at startup. `HWChat: Show resource stats` prints live search/command counters for troubleshooting.
- `hwchat.reasoningEffort` — five levels (default, none, low, high, max); endpoints without support get an automatic retry. Also only a default for new conversations.
- `hwchat.permissionPreset`, `hwchat.agentMaxSteps`, `hwchat.reasoningEffort` — **deprecated, no effect**. Every new conversation starts at “Ask every time” / 24 steps / “Default (model)”; adjust the three under the composer for the current conversation (24 / 68 / 120 / unlimited, four reasoning depths, four presets) and the choice is stored with that conversation. The keys stay registered only so old `settings.json` files do not report unknown settings.
- `hwchat.fileReadPolicy` / `hwchat.fileWritePolicy` / `hwchat.commandPolicy` / `hwchat.dangerousCommandPolicy` / `hwchat.sensitiveFilePolicy` — fully derived from the preset; display-only, marked deprecated in the VS Code settings UI.
- Permission settings are `resource`-scoped and may be set in a folder's `.vscode/settings.json`. Precedence is most-specific-first (workspace folder → `.code-workspace` → user), and when folders disagree the strictest value wins (`Ask every time` > `Ask on risky actions` > `Autopilot` > `Full access`).
- `hwchat.allowSensitiveFiles` / `hwchat.allowDangerousCommands` — deprecated booleans, used only as a migration fallback when the newer settings are absent.
- `hwchat.taskCacheRetentionHours` / `hwchat.cacheBudgetMB` — task cache and disk budget.

Conversation data lives in the VS Code global storage directory and is never written into your project.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/core/` | i18n, settings, permissions, storage, approval plans |
| `src/agent/` | agent loop, tool executor, path isolation, file reference resolution, project scope (git gate), version-bump gate, skills, task queue |
| `src/views/` | chat panel, settings panel, history view |
| `src/providers/` | DeepSeek / OpenAI-compatible client |
| `media/` | webview scripts and styles; `ui-icons.js` holds every interface icon shape (flat inline SVG, `currentColor` only) and is unit-tested |
| `docs/screenshots/` | screenshot build script and the generated English screenshot |
| `test/` | browser preview pages and standalone DOM / geometry checks (`check-panel-exclusivity.mjs`, `check-capsule-geometry.mjs`, `check-capsule-drag.mjs`, `check-icons-dom.mjs`, `check-icon-geometry.mjs`, `check-todo-actions.mjs`, `check-title-editing.mjs`, `check-draft-isolation.mjs`, `check-file-reference-dom.mjs`) |

The screenshot is generated with `node docs/screenshots/build.mjs`. It reuses the real webview CSS and the real English dictionary, so the image matches the shipped UI, and it renders an empty new conversation: no conversations, messages, task list, attachments or typed input are included.

## License

[MIT](LICENSE)
