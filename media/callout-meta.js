/*
 * 正文「提醒块」的分级解析（webview 与单元测试共用的纯函数）。
 *
 * 为什么要把这件事单独抽出来：
 * 用户要求「按危险程度显示」——危险的红标题 + 亮黄图标，重要但不危险的只把图标变橘黄，
 * 其余一律保持原样。这里最容易出错的地方不是配色，而是「哪些内容算提醒」：
 * 如果让渲染层去猜句子含义，一段普通说明被误判成「危险」，整个红色警告就失去分量了。
 * 所以分级只认显式标记，不猜语义：
 *
 *     > [!DANGER] 这一步会删掉数据
 *     > 具体说明……
 *
 * 只有第一行是 `[!DANGER]` / `[!WARNING]` / `[!IMPORTANT]` 的引用块才会变成提醒块，
 * 其它任何内容（包括 `[!NOTE]` 这类没登记的标记、以及普通引用）都返回 null，
 * 由调用方走原来的引用块渲染 —— 这样「其他的显示不变」是字面成立的，不是近似。
 *
 * 只做字符串处理，不碰 DOM、不读文案。
 */
(() => {
  /**
   * 标记 → 分级。
   *
   * 一个分级可以对应多个标记：模型习惯在不同上下文写 WARNING 或 DANGER，
   * 两者对用户都是「会造成损失」，没必要让它们显示成两种样子。
   */
  const MARKERS = {
    DANGER: 'danger',
    WARNING: 'danger',
    IMPORTANT: 'important',
  };

  /** 允许出现的分级值；渲染层按它决定配色，不在白名单里的一律不渲染成提醒块。 */
  const TONES = ['danger', 'important'];

  /** 第一行的标记：行首可带空格，标记本身大小写不敏感。 */
  const MARKER_LINE = /^\s*\[!([A-Za-z]+)\]\s*(.*)$/;

  /** 空行判定：只有空白也算空行（模型常在标记后留一个空引用行）。 */
  function isBlank(line) {
    return !String(line == null ? '' : line).trim();
  }

  /**
   * 去掉首尾空行。
   *
   * 为什么必须做：`> [!IMPORTANT] 标题` 后面通常跟一个空的 `>` 分隔行，
   * 不清理就会在标题和正文之间多出一段空白，看起来像标题下面断了一截。
   */
  function trimBlankLines(lines) {
    let start = 0;
    let end = lines.length;
    while (start < end && isBlank(lines[start])) start += 1;
    while (end > start && isBlank(lines[end - 1])) end -= 1;
    return lines.slice(start, end);
  }

  /**
   * 解析一个引用块的若干行（调用方已经把行首的 `>` 去掉）。
   *
   * 返回 null 表示「这不是提醒块，按普通引用处理」；
   * 返回 { tone, title, body } 表示按分级渲染，其中 body 可能为空字符串（只有标题的提醒）。
   */
  function parseCallout(lines) {
    const list = Array.isArray(lines) ? lines.map((line) => String(line == null ? '' : line)) : [];
    const trimmed = trimBlankLines(list);
    if (!trimmed.length) return null;
    const match = trimmed[0].match(MARKER_LINE);
    if (!match) return null;
    const tone = MARKERS[match[1].toUpperCase()];
    // 没登记的标记（[!NOTE] / [!TIP] / 随便写的词）不算提醒块：
    // 悄悄吞掉标记会让作者以为生效了，显示成普通引用反而是更诚实的反馈。
    if (!tone) return null;
    const title = String(match[2] || '').trim();
    const body = trimBlankLines(trimmed.slice(1)).join('\n');
    return { tone, title, body };
  }

  /** 标记本身对应的分级；不认识返回空字符串（供模型提示词与测试共用一张真值表）。 */
  function toneFor(marker) {
    const key = String(marker == null ? '' : marker).replace(/^\[!|\]$/g, '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(MARKERS, key) ? MARKERS[key] : '';
  }

  globalThis.HWChatCalloutMeta = {
    TONES: TONES.slice(),
    markers: () => Object.keys(MARKERS),
    toneFor,
    parseCallout,
  };
})();
