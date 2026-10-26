# Security and Privacy

## Data flow

HWChat sends only the following data to the configured model endpoint:

- user messages;
- conversation context within the configured limits;
- files or selections explicitly attached by the user;
- local Skill contents actually preloaded or loaded for the current request;
- the bounded handoff summary and history excerpts requested from a conversation explicitly linked by the user;
- tool results required for the active Agent loop.

The extension does not include telemetry. Each API profile stores its key in VS Code SecretStorage, not in settings, project files, conversation history, logs, or the VSIX package. Reinstalling or upgrading the same extension identity can continue using an existing key because VS Code preserves that SecretStorage entry until the user clears it. Conversation and audit data remain in VS Code global storage unless the configured API endpoint receives them as part of a request.

Linking an old conversation is local and read-only: it does not copy or modify the source conversation. The source transcript is not sent wholesale. HWChat sends a bounded local handoff summary and, when the Agent requests missing details, only the matching excerpts. Those transmitted summaries and excerpts count as normal model input Tokens; keeping the source history on disk does not.

Remote model endpoints must use HTTPS. Plain HTTP is accepted only for loopback hosts (`localhost`, `127.0.0.1`, and `::1`). Error messages are redacted before they are shown or stored.

## Permission boundary

Read, write, and command tools have independent policies and can be selected through permission presets. Presets and their per-category boundaries are defined once in `src/core/permissions.ts` and rendered both in the settings matrix and in the composer tooltip:

| Preset | Read | Write | Read-only commands | Regular commands | Dangerous commands | Sensitive files |
| --- | --- | --- | --- | --- | --- | --- |
| Ask every time | confirm | confirm | confirm | confirm | denied | denied |
| Review risky actions | allow | allow | allow | allow | confirm | denied |
| Autopilot | allow | allow | allow | allow | confirm | denied |
| Full access | allow | allow | allow | allow | allow | confirm |
| Custom | user-defined | user-defined | user-defined | user-defined | confirm / allow / deny | deny / confirm / allow |

Workspace Trust is an additional hard boundary: file writes, moves, deletes, and commands are rejected in an untrusted workspace regardless of the configured policy.

VS Code extension tools (anything exposed through `vscode.lm.tools`) are authorized by VS Code, not by HWChat. HWChat invokes them without its own approval prompt, so tools that need no authorization run immediately; tools whose `prepareInvocation` declares confirmation still show VS Code's own confirmation dialog, and cancelling is reported as a denied step. HWChat only records the invocation in its audit log. Plan mode still blocks tools classified as write or command, and untrusted workspaces still block tools that may write or execute.

File tools resolve canonical paths and reject paths outside open workspace roots, including symlink escapes. Sensitive names and credential directories are denied by default. Deletes use the operating system trash and cannot remove directories.

Command execution is intentionally more privileged than file tools. Every command is classified as read-only, regular, or dangerous before a policy is applied. Dangerous commands — privilege escalation (`sudo`, `doas`, `su`), destructive deletes (`rm -r`, `rm -f`), `mkfs`/`dd`/disk erase, `shutdown`/`reboot`, destructive or force-pushed git operations, `chmod 777`, piping remote scripts into a shell, package publishing, and similar — are denied under "ask every time", confirmed one by one under "review" and "Autopilot", and auto-approved only under "full access". Sensitive files are a separate axis: denied under the first three presets, auto-approved only when explicitly allowed, and "full access" confirms each sensitive read with the concrete target path. HWChat also rejects obvious paths outside the workspace and sensitive filenames, and strips secret-like environment variables from child processes. This is defense in depth, not an operating-system sandbox: a sufficiently creative program launched by an approved command may still access resources available to the VS Code process. Keep `hwchat.commandPolicy` set to `ask`, review every command, and run VS Code with least privilege.

## Prompt injection

Workspace files, attachments, command output, and tool results are marked as untrusted project data in the system prompt. They cannot grant permissions. Only VS Code approval prompts and user settings authorize write or command operations.

## Local retention

Completed task details are compacted on a timer. Reasoning text, prompt/completion Token breakdowns, tool input/output, and attachment bodies can be removed while final replies, total Token counts, Skill usage names, and durable execution summaries remain. Source conversations referenced by continuation chats are protected from automatic retention and budget eviction; manually deleting a source preserves the continuation's snapshot but disables further full-history lookup. Users can export history or delete all local conversations and audit records from the settings panel.

## Reporting

Do not include API keys, private repository content, or personal data in a public issue. Revoke exposed credentials before reporting a security problem.
