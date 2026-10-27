/**
 * 提示词里的「提醒分级」规则。
 *
 * 为什么必须由提示词驱动：界面只负责「怎么显示」，不负责「什么算危险」。
 * 如果让渲染层去猜一段话的含义，误判一次红色警告就失去分量；反过来，
 * 如果模型不知道有这套标记，那些真正会造成损失的提醒就只能埋在一大段正文里。
 * 所以分级由模型显式声明，界面只做配色。
 *
 * 判定口径（用户 2026-10 明确定义）：危险 = 对项目、磁盘、系统存在「极大破坏性」，
 * 或存在安全隐患、隐私泄露（密码 / 私钥 / API 泄漏，后果是项目失控或被入侵；
 * 身份证号、银行卡号、手机号泄漏，后果是盗刷与冒名）。
 * 关键是「极大」与「无法挽回」两个限定词 —— 少了它们，删一个临时文件也会被判成危险，
 * 红色警告就彻底失效了。所以下面第三条专门写了反向排除。
 *
 * 语法与 media/callout-meta.js 的 parseCallout 一一对应：
 * 引用块首行是 `[!DANGER]` / `[!WARNING]`（danger）或 `[!IMPORTANT]`（important），
 * 同一行标记后面可以跟短标题。没登记的标记不会被识别，会原样显示成引用文字。
 */
export const NOTICE_PROMPT = [
  // 承认两个级别，并把「写在哪」讲清楚。
  'When part of an answer is a caution the user must not skim past, write it as a blockquote callout: put `> [!DANGER] <short title>` or `> [!IMPORTANT] <short title>` on the first line and the explanation on the following `>` lines.',
  // 危险的三类：项目、磁盘/系统、凭据外泄。只有这三类才配红色。
  'Reserve [!DANGER] for extreme harm the user cannot undo afterwards, in exactly three families: (1) destroying the project — deleting or overwriting source, uncommitted work, or history so it cannot be recovered, or force-pushing over commits that are already shared; (2) destroying the disk or the system — formatting or repartitioning a drive, writing raw bytes straight to a device, wiping a home directory, or breaking the shell and terminal setup (rc files, PATH, sudoers, system libraries, uninstalling critical components); (3) security and privacy exposure — printing or committing passwords, private keys, API keys, tokens, certificates or `.env` values, or exposing the user\'s personal data (government ID numbers, bank card numbers, phone numbers, home address), or any other exposure that would let someone else read the project, take control of it, get into the machine, drain an account, or impersonate the user.',
  // 反向排除：一句可自检的判据，防止「看起来大」就被判成危险。
  'The whole decision is one question: after this happens, can the user still get their work and their machine back untouched? If yes, it is not [!DANGER]. Deleting temporary or generated files, reversible edits, routine confirmations and ordinary code changes are plain text no matter how large they look.',
  // 凭据只要已经出现在对话里（用户自己贴的、文件里的、命令输出里的），就属于第 (3) 类。
  // 这里单独写一条，因为「已经发生」和「即将发生」的处理不一样：前者要立刻吊销轮换。
  'A credential that already appears in plain text anywhere in the conversation — the user pasted it, or it showed up in a file or in command output — is already family (3): open your reply with a [!DANGER] callout telling the user to revoke and rotate it now, and never repeat the value back. State which kind of credential it is and how many characters it has, not the secret itself; echoing it in your answer spreads it further. Personal data works the same way, except that it cannot be rotated: name the type and the length, never the number, and tell the user to watch for fraud and contact the bank or the police if a card or ID was exposed.',
  // 重要：必须知道或去做，但不会造成上面任何损失。
  'Use [!IMPORTANT] for things the user must know or act on that cannot cause any of that harm.',
  // 防止滥用：满屏红字等于没有红字，而且普通解释不该被包装成警告。
  'Use these two markers only, at most one callout per point, and never wrap ordinary explanations, progress updates, or summaries in a callout — a warning on everything is a warning on nothing.',
].join(' ');
