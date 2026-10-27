/**
 * 输出文案里的「文件引用」识别。
 *
 * 目标：模型在回复里提到某个文件时，界面把它显示成一个可点的引用，
 * 右键能在 Finder / 资源管理器里定位到那个文件本身。
 *
 * 这个模块只管**判断和解析**，不碰 DOM、不碰 vscode：
 *  - 判断一段文本是不是文件路径（`looksLikeFilePath`）；
 *  - 把 `path:16` / `path#L16` 这类行号后缀拆出来（`splitLineSuffix`）；
 *  - 把相对路径解析成绝对路径（`resolveReference`），供界面与扩展共用。
 * 这样 node:test 能直接覆盖最容易被误判的那一层，不用启动编辑器。
 *
 * 判定刻意做「白名单」而不是「看着像路径就行」：
 * 正文里到处都是 `v0.2.4`、`e.g.`、`example.com`、`app.ts` 这类带点的东西，
 * 只要求「有扩展名」会把它们全变成假引用，比不显示更糟。
 */
(function () {
  /**
   * 认得的扩展名。
   *
   * 刻意不含 `com` / `org` / `net` / `io` / `dev` / `app`：
   * 那几个恰好也是最常见的域名后缀，加了就会把网址里的主机名当成文件。
   */
  const EXTENSIONS = new Set([
    // 源码
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro',
    'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'm', 'mm',
    'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'php', 'pl', 'lua', 'r', 'dart', 'scala', 'ex', 'exs',
    // 结构 / 配置
    'json', 'jsonc', 'json5', 'md', 'markdown', 'mdx', 'rst',
    'css', 'scss', 'sass', 'less', 'styl', 'html', 'htm', 'xhtml', 'xml', 'svg',
    'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'plist',
    'lock', 'gradle', 'cmake', 'mk', 'bazel', 'podspec', 'xcconfig', 'entitlements',
    // 脚本 / 命令
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'awk',
    // 文档 / 数据
    'txt', 'log', 'csv', 'tsv', 'pdf', 'epub', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    // 资源 / 产物
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'icns', 'heic', 'avif',
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'aac', 'm4a',
    'zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'jar', 'war', 'vsix', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'ipa',
    'patch', 'diff', 'proto', 'graphql', 'gql', 'sql', 'prisma', 'env',
  ]);

  /** 没有扩展名、但确实是文件的固定名字（大小写敏感，只收常见的正式写法）。 */
  const FILENAMES = new Set([
    'Makefile', 'makefile', 'GNUmakefile', 'Dockerfile', 'dockerfile', 'Containerfile',
    'LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'AUTHORS', 'CONTRIBUTORS',
    'Procfile', 'Gemfile', 'Rakefile', 'Podfile', 'Brewfile', 'Vagrantfile', 'Justfile',
    '.gitignore', '.gitattributes', '.gitmodules', '.npmrc', '.nvmrc', '.yarnrc',
    '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc', '.vscodeignore',
    '.env', '.bashrc', '.zshrc', '.profile', '.dockerignore',
  ]);

  /**
   * 正文里不可能出现在合法路径中的字符：控制符、尖括号、引号、通配符、竖线。
   * 命中就判定「这不是路径」，避免把 `<div>`、`a|b` 这类片段当成文件名。
   */
  const INVALID = /[<>"|?*\u0000-\u001f\u007f\u200b-\u200f]/;

  /**
   * 行号后缀：`path:16`、`path:16:5`、`path#L16`、`path#L16-L20`。
   *
   * 顺序上必须先剥后缀再判扩展名，否则 `src/a.ts:16` 会被当成扩展名 `ts:16`。
   * Windows 盘符 `C:\x` 不会误伤：冒号后面跟着数字才算行号。
   */
  function splitLineSuffix(token) {
    const value = typeof token === 'string' ? token : '';
    const hash = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(value);
    if (hash) {
      return { path: hash[1], line: Number(hash[2]), endLine: hash[3] ? Number(hash[3]) : undefined };
    }
    const colon = /^(.*?):(\d+)(?::(\d+))?$/.exec(value);
    if (colon) {
      return {
        path: colon[1],
        line: Number(colon[2]),
        column: colon[3] ? Number(colon[3]) : undefined,
      };
    }
    return { path: value };
  }

  /** 句子末尾的句点、逗号不是路径的一部分，剥掉才算得准扩展名。 */
  function trimTrailingPunctuation(value) {
    return value.replace(/[.,;]+$/, '');
  }

  function basenameOf(path) {
    const parts = String(path || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  /** 扩展名（小写、不含点）；没有或只有前导点时返回空串。 */
  function extensionOf(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function isAbsolutePath(path) {
    return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(path || ''));
  }

  /**
   * 这段文本算不算一个文件路径。
   *
   * @param {string} token 待判定的文本（已经去掉行号后缀与句末标点之前的原文）
   * @param {{ allowSpaces?: boolean }} [options]
   *   `allowSpaces`：允许路径里带空格。只在「已经由反引号界定边界」时打开——
   *   正文里裸写的路径去掉空格边界就无从判断起止，宁可漏认也不误认。
   */
  function looksLikeFilePath(token, options) {
    const value = typeof token === 'string' ? token.trim() : '';
    if (!value) return false;
    if (INVALID.test(value)) return false;
    // 网址不是文件。放在最前面判，避免 `https://a.com/b.ts` 被剥成 `a.com/b.ts`。
    if (value.includes('://')) return false;
    // 家目录写法不展开：展开等于把 `~` 解析成用户主目录，属于替用户猜测。
    if (value.startsWith('~')) return false;
    // 命令行开关（`--force`、`-rf`）不是文件名。
    if (value.startsWith('-')) return false;
    // 站内锚点、十六进制色值之类。
    if (value.startsWith('#')) return false;
    if (/\s/.test(value) && !(options && options.allowSpaces)) return false;
    // 其它 scheme（`mailto:`、`vscode-webview:` …）。Windows 盘符要放行。
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return false;

    const path = trimTrailingPunctuation(splitLineSuffix(value).path);
    if (!path) return false;
    // 只有分隔符、没有实际名字（`/`、`./`、`../`）。
    const name = basenameOf(path);
    if (!name) return false;
    if (FILENAMES.has(name)) return true;
    const extension = extensionOf(name);
    if (!extension) return false;
    return EXTENSIONS.has(extension);
  }

  /**
   * 把一段文本解析成文件引用。
   *
   * 返回 `{ path, line, column, endLine }`，不是文件时返回 null。
   * 这里不做「相对 → 绝对」的解析，因为那要工作区根目录（见 `resolveReference`）。
   */
  function parseReference(token, options) {
    if (!looksLikeFilePath(token, options)) return null;
    const trimmed = typeof token === 'string' ? token.trim() : '';
    const parts = splitLineSuffix(trimmed);
    const path = trimTrailingPunctuation(parts.path);
    return {
      path,
      line: parts.line,
      column: parts.column,
      endLine: parts.endLine,
    };
  }

  function toPosix(value) {
    return String(value || '').replaceAll('\\', '/');
  }

  /** 绝对路径是否落在某个根目录内（纯字符串比较，不碰文件系统）。 */
  function isInside(root, candidate) {
    const base = toPosix(root).replace(/\/+$/, '');
    const target = toPosix(candidate);
    return target === base || target.startsWith(`${base}/`);
  }

  function joinPath(root, relative) {
    const base = toPosix(root).replace(/\/+$/, '');
    const rest = toPosix(relative).replace(/^\.\//, '').replace(/^\/+/, '');
    return `${base}/${rest}`;
  }

  /**
   * 相对路径 → 绝对路径。
   *
   * 只做纯字符串拼接，**不探测文件是否存在**（webview 里没有 fs）。
   * 存在性判断留给扩展侧：顺着点击的那一刻去查，查不到就提示「文件不存在」，
   * 比在渲染时把每个路径都试一遍要准，也不会因为文件刚被创建就判错。
   *
   * @param {{ path: string, line?: number, column?: number, endLine?: number }} reference
   * @param {{ roots?: string[], preferred?: string }} context
   */
  function resolveReference(reference, context) {
    if (!reference || typeof reference.path !== 'string' || !reference.path) return null;
    const roots = Array.isArray(context && context.roots) ? context.roots.filter(Boolean) : [];
    const preferred = (context && context.preferred) || (roots.length ? roots[0] : '');
    const path = reference.path;

    if (isAbsolutePath(path)) {
      const inside = roots.some((root) => isInside(root, path));
      return {
        absolute: toPosix(path),
        /* 落在某个根目录里才有「相对写法」，否则只能整条路径照搬。 */
        relative: inside ? relativeOf(preferred, path) : '',
        line: reference.line,
        column: reference.column,
        endLine: reference.endLine,
        display: toPosix(path),
      };
    }
    if (!preferred) return null;
    const absolute = joinPath(preferred, path);
    return {
      absolute,
      relative: relativeOf(preferred, absolute),
      line: reference.line,
      column: reference.column,
      endLine: reference.endLine,
      display: relativeOf(preferred, absolute) || toPosix(path),
    };
  }

  function relativeOf(root, absolute) {
    if (!root || !isInside(root, absolute)) return '';
    const base = toPosix(root).replace(/\/+$/, '');
    const value = toPosix(absolute);
    if (value === base) return '';
    return value.slice(base.length + 1);
  }

  /**
   * 正文里「没写引用格式」的裸路径扫描。
   *
   * 用户明确要求：没被反引号包起来的文件也要能被认出来，并且显示**完整路径**，
   * 这样才能在 VS Code 之外（Finder / 资源管理器）对着路径找到文件。
   *
   * 做法：把正文里每一段「ASCII 路径字符」当成候选，再交给 `parseReference` 判定。
   * 不按空白切词，是因为中文正文经常直接把路径贴在前面的汉字上：
   *   `修改src/core/ids.ts。`
   * 按「空白 + 标点」切会得到一个 `修改src/core/ids.ts`，把汉字也带进路径里，
   * 于是拼出一条不存在的绝对路径、点开就报「文件不存在」。
   * 只捞 ASCII 片段，汉字自然被当成分隔符，还能一次捞出同一句里的多个路径。
   *
   * 返回 `[{ index, length, text, reference }]`，`index/length` 是相对入参的偏移，
   * 调用方据此把原文切开、在中间插入引用节点。
   */
  const ASCII_RUN = /[A-Za-z0-9_./\\@+#:-]+/g;
  /** 网址整体替换成等长空格：保留偏移，又能避免把主机名当路径。 */
  const URL_LIKE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+/g;

  function scanPlainText(text) {
    const value = typeof text === 'string' ? text : '';
    if (!value) return [];
    // 网址去掉协议头之后，`example.com/a.ts` 长得跟相对路径一模一样。
    // 先等长抹掉，偏移不变，后面的引用位置才对得回原文。
    const working = value.replace(URL_LIKE, (match) => ' '.repeat(match.length));
    const found = [];
    for (const match of working.matchAll(ASCII_RUN)) {
      const parsed = parseReference(match[0]);
      if (!parsed) continue;
      const raw = match[0];
      // 去掉句末标点后长度会变短，引用只覆盖真正的路径部分，尾部标点留在正文里。
      const length = trimTrailingPunctuation(raw).length;
      if (length <= 0) continue;
      found.push({
        index: match.index || 0,
        length,
        text: value.slice(match.index || 0, (match.index || 0) + length),
        reference: parsed,
      });
    }
    return found;
  }

  /** 行号后缀的显示形式：与写进正文的写法一致，便于对着原文核对。 */
  function locationSuffix(reference) {
    if (!reference || !reference.line) return '';
    if (reference.endLine && reference.endLine !== reference.line) return `:${reference.line}-${reference.endLine}`;
    if (reference.column) return `:${reference.line}:${reference.column}`;
    return `:${reference.line}`;
  }

  globalThis.HWChatFileRef = {
    looksLikeFilePath,
    parseReference,
    resolveReference,
    scanPlainText,
    splitLineSuffix,
    locationSuffix,
    basenameOf,
    isAbsolutePath,
  };
})();
