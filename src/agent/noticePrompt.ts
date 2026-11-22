/**
 * 提示词里的「提醒分级」规则。
 *
 * 为什么必须由提示词驱动：界面只负责「怎么显示」，不负责「什么算危险」。
 * 如果让渲染层去猜一段话的含义，误判一次红色警告就失去分量；反过来，
 * 如果模型不知道有这套标记，那些真正会造成损失的提醒就只能埋在一大段正文里。
 *
 * 判定口径（用户 2026-10 明确定义）：危险 = 对项目、磁盘、系统存在「极大破坏性」，
 * 或存在安全隐患、隐私泄露。关键是「极大」与「无法挽回」两个限定词 —— 少了它们，
 * 删一个临时文件也会被判成危险，红色警告就彻底失效了。
 *
 * 语法与 media/callout-meta.js 的 parseCallout 一一对应。
 *
 * 2026-11-22 压缩：判定词元一个不少（src/test/calloutMeta.test.ts 逐条钉住），
 * 只删重复的解释 —— 这段每轮请求都要重发。
 */
export const NOTICE_PROMPT = [
  'For a caution the user must not skim past, write a blockquote callout: `> [!DANGER] <short title>` or `> [!IMPORTANT] <short title>` on the first line, explanation on the following `>` lines.',
  'Reserve [!DANGER] for harm that cannot be undone: (1) project — deleting or overwriting source, uncommitted work or history beyond recovery, force-pushing over shared commits; (2) disk or system — formatting or repartitioning a drive, writing raw bytes to a device, wiping a home directory, breaking the shell setup (rc files, PATH, sudoers, system libraries, uninstalling critical components); (3) exposure — passwords, private keys, API keys, tokens, certificates or .env values printed or committed, personal data, or anything else that lets someone else read the project, take control of it, get into the machine, drain an account or impersonate the user.',
  'One test decides it: after it happens, can the user still get their work and their machine back untouched? If yes it is not [!DANGER] — temporary files, reversible edits, routine confirmations and ordinary code changes are plain text however large they look.',
  'A credential that already appears in plain text anywhere in the conversation — pasted by the user, or read from a file or command output — is family (3): open with a [!DANGER] callout telling the user to revoke and rotate it now, and never repeat the value back; state the kind of credential and how many characters it has. Personal data cannot be rotated: name the type and length, and tell the user to watch for fraud and contact the bank or police if a card or ID was exposed.',
  'Use [!IMPORTANT] only for things the user must know or act on that cannot cause any of that harm. Two markers only, at most one callout per point, and never wrap ordinary explanations, progress updates or summaries in a callout — a warning on everything is a warning on nothing.',
].join(' ');