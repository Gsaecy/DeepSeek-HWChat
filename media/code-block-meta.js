/*
 * 围栏代码块的元信息解析（webview 与单元测试共用的纯函数）。
 *
 * 为什么不写在 chat.js 里：chat.js 是 IIFE、依赖 DOM，没法在 Node 里直接跑。
 * 把「围栏边界 + 位置/工具标注」这两件容易出错的事抽到这里，src/test/codeBlockMeta.test.ts
 * 就能真正覆盖它们，而不是只靠肉眼看渲染结果。
 *
 * 约定的围栏写法（标注写在语言标记后面，空格分隔，值可加引号）：
 *
 *   ```bash loc=local
 *   ```powershell loc=local tool=powershell
 *   ```sh loc=server tool=bash
 *   ```bash loc="GitHub Actions runner"
 *
 * 只做字符串处理，不碰 DOM，不读文案（界面上的文字由 chat.js 查 i18n 词表拼）。
 */
(() => {
  /** 认作「这是一条终端命令」的语言标记。 */
  const SHELL_LANGUAGES = new Set([
    'bash', 'zsh', 'sh', 'shell', 'fish', 'ksh', 'dash',
    'powershell', 'pwsh', 'ps1', 'posix',
    'cmd', 'bat', 'cmd.exe',
    'terminal', 'console', 'shellsession', 'shell-session',
  ]);

  /** 工具别名归一：用户看到的应该是 cmd / powershell / bash 这种确切名字。 */
  const TOOL_ALIASES = {
    pwsh: 'powershell',
    ps1: 'powershell',
    'powershell.exe': 'powershell',
    bat: 'cmd',
    'cmd.exe': 'cmd',
    shell: 'sh',
    console: 'sh',
    terminal: 'sh',
    shellsession: 'sh',
    'shell-session': 'sh',
  };

  const LOCATION_LOCAL = /^(?:local|local terminal|local shell|local machine|本机|本地|本地终端|本地命令行|本机终端)$/;
  const LOCATION_SERVER = /^(?:server|remote|remote server|remote host|ssh|ssh host|远程|远程主机|远程服务器|服务器|服务器终端|远程终端)$/;

  function isShellLanguage(language) {
    return SHELL_LANGUAGES.has(String(language == null ? '' : language).trim().toLowerCase());
  }

  function canonicalTool(value) {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    if (!raw) return '';
    return TOOL_ALIASES[raw] || raw;
  }

  /** 位置归一：'local' / 'server' / 自定义文本（原样返回）/ ''（未标注）。 */
  function normalizeLocation(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (LOCATION_LOCAL.test(lower)) return 'local';
    if (LOCATION_SERVER.test(lower)) return 'server';
    return raw;
  }

  /**
   * 按空格切分标注，但把引号里的内容当一个整体：
   * `loc="GitHub Actions runner"` 只有一对引号，值里允许空格。
   */
  function tokenize(info) {
    const tokens = [];
    let index = 0;
    while (index < info.length) {
      while (index < info.length && /\s/.test(info[index])) index += 1;
      if (index >= info.length) break;
      let token = '';
      while (index < info.length && !/\s/.test(info[index])) {
        const char = info[index];
        if (char === '"' || char === "'") {
          index += 1;
          while (index < info.length && info[index] !== char) { token += info[index]; index += 1; }
          if (index < info.length) index += 1;
          continue;
        }
        token += char;
        index += 1;
      }
      tokens.push(token);
    }
    return tokens;
  }

  /**
   * 解析围栏信息串。
   *
   * 第一个不含 '=' 的 token 是语言；其余按 key=value 解析，
   * 认 loc/location/where/host 作为位置，tool/shell/term/terminal 作为工具。
   * 未知键直接忽略 —— 模型多写个 title= 之类的不该影响渲染。
   */
  function parseFenceInfo(info) {
    const tokens = tokenize(String(info == null ? '' : info));
    let language = '';
    let location = '';
    let tool = '';
    for (const token of tokens) {
      const equals = token.indexOf('=');
      if (equals <= 0) {
        if (!language) language = canonicalTool(token);
        continue;
      }
      const key = token.slice(0, equals).trim().toLowerCase();
      const value = token.slice(equals + 1).trim();
      if (!value) continue;
      if (key === 'loc' || key === 'location' || key === 'where' || key === 'host') location = normalizeLocation(value);
      else if (key === 'tool' || key === 'shell' || key === 'term' || key === 'terminal') tool = canonicalTool(value);
    }
    return { language, location, tool };
  }

  /**
   * 这一行是不是围栏开头？是则返回信息串（可能为空字符串），否则 null。
   *
   * 允许前后空白，也允许 4 个以上反引号（Markdown 里用更长的围栏包住代码块内的 ```）。
   */
  function matchFenceStart(line) {
    const match = String(line == null ? '' : line).match(/^\s*`{3,}\s*(.*)$/);
    if (!match) return null;
    return match[1].trim();
  }

  /**
   * 从 startIndex 处的围栏开头收集整块代码。
   *
   * 结束围栏没出现（流式输出到一半）时，剩下的行全算代码 —— 这样已经出现的部分
   * 会立刻按代码块渲染，而不是先闪成一大段正文再跳变。
   */
  function collectFenceBlock(lines, startIndex) {
    const list = Array.isArray(lines) ? lines : [];
    const info = matchFenceStart(list[startIndex]);
    if (info === null) return null;
    const code = [];
    let index = startIndex + 1;
    while (index < list.length && !/^\s*`{3,}\s*$/.test(String(list[index] == null ? '' : list[index]))) {
      code.push(String(list[index] == null ? '' : list[index]));
      index += 1;
    }
    return { info, code: code.join('\n'), nextIndex: index < list.length ? index + 1 : list.length };
  }

  /**
   * 去掉所有非空行的公共缩进。
   *
   * 列表里的围栏是缩进写的，代码内容会带上同样的缩进；复制出去时那几格空格
   * 没有意义，还可能让路径多出前导空格。只删公共前缀，所以代码自身相对的缩进
   * （YAML 层级、Python 块）不会被破坏。
   */
  function dedentCode(text) {
    const raw = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    if (!raw) return '';
    const lines = raw.split('\n');
    let prefix = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const indent = line.match(/^[ \t]*/)[0];
      if (prefix === null) { prefix = indent; continue; }
      let common = 0;
      while (common < prefix.length && common < indent.length && prefix[common] === indent[common]) common += 1;
      prefix = prefix.slice(0, common);
      if (!prefix) return raw;
    }
    if (!prefix) return raw;
    return lines.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line)).join('\n');
  }

  globalThis.HWChatCodeBlockMeta = {
    isShellLanguage,
    canonicalTool,
    normalizeLocation,
    parseFenceInfo,
    matchFenceStart,
    collectFenceBlock,
    dedentCode,
  };
})();
