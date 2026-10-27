/**
 * 提示词里的「命令块」规则。
 *
 * 为什么要单独抽出常量：这条规则决定了用户看到的命令长什么样 —— 位置和工具标错，
 * 用户就会把远程命令贴进本地终端（或反过来）。写成常量后 src/test/commandPrompt.test.ts
 * 能直接断言它没被改坏，而不是靠人去读一大段 prompt 字符串。
 *
 * 语法与 media/code-block-meta.js 的 parseFenceInfo 一一对应：
 * 语言写在围栏后第一个位置，其余是 key=value（loc / tool）。
 */
export const COMMAND_BLOCK_PROMPT = [
  // 必须是一个真正的围栏块，而不是正文里的反引号。
  'When the user must run a terminal command themselves, always put it in a fenced shell block on its own lines, and annotate where it runs and with which tool: ```bash loc=local tool=bash, ```powershell loc=local tool=powershell, ```sh loc=server tool=bash.',
  // 位置的三种取值。
  'Use loc=local for a terminal on the machine running VS Code, loc=server for a remote, SSH or production host, and loc="<short label>" for anything else such as a container, CI runner or another machine.',
  // 工具必须写明，不能靠猜操作系统。
  'Use tool=cmd, tool=powershell, tool=bash, tool=zsh or tool=sh to name the exact shell, and never assume the user is on the same OS as the project.',
  // 列表里的围栏要缩进，否则会被当成正文。
  'Inside a bullet or numbered list, indent the fence by two spaces but keep the fence on a line of its own: a fence merged into the surrounding prose is rendered as literal text and cannot be copied.',
  // 标注不要混进代码本身，否则复制出去的命令不可用。
  'Never put the location, the tool or any "run this in ..." note inside the block, and never prefix commands with a prompt symbol such as $ or >: the header already shows location and tool, and the copy button copies the block verbatim.',
].join(' ');
