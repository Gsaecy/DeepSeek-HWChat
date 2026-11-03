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
  /*
   * `loc=` 是硬要求，不是建议。
   *
   * 真实反馈（用户原话）：「需要我执行的命令，代码块要区分是服务器上执行还是本地终端执行，
   * 为什么现在不区分本地还是服务器了」。检查发现规则一直在，但模型经常只写 `tool=`、
   * 漏掉 `loc=`，于是面板上只剩「工具：bash」。所以这里把它写成 MUST，并说明代价：
   * 贴错终端会改错机器，这是这类操作最常见、也最贵的失败。
   */
  'Every shell block MUST carry `loc=`: a block with `tool=` but no `loc=` is incomplete, because the user cannot tell whether to paste it into their local terminal or an SSH session on a server, and pasting into the wrong one modifies the wrong machine. If you do not know where it runs, ask before writing the block.',
  // 位置的三种取值。
  'Use loc=local for a terminal on the machine running VS Code, loc=server for a remote, SSH or production host, and loc="<short label>" for anything else such as a container, CI runner or another machine.',
  // 工具必须写明，不能靠猜操作系统。
  'Use tool=cmd, tool=powershell, tool=bash, tool=zsh or tool=sh to name the exact shell, and never assume the user is on the same OS as the project.',
  // 列表里的围栏要缩进，否则会被当成正文。
  'Inside a bullet or numbered list, indent the fence by two spaces but keep the fence on a line of its own: a fence merged into the surrounding prose is rendered as literal text and cannot be copied.',
  // 标注不要混进代码本身，否则复制出去的命令不可用。
  'Never put the location, the tool or any "run this in ..." note inside the block, and never prefix commands with a prompt symbol such as $ or >: the header already shows location and tool, and the copy button copies the block verbatim.',
].join(' ');
