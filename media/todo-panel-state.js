/*
 * 任务清单面板的显示状态（webview 与单元测试共用的纯函数）。
 *
 * 为什么单独抽出来：`todoPanel` 是一个 <details>，它的展开状态完全由用户点击决定，
 * 浏览器会一直记住。于是「上一份清单被收起来了」这个状态会跨清单保留下来 ——
 * 新任务把清单发过来时面板仍然是收起的，看起来就像「任务清单没有唤起」。
 * 这里用「清单签名」（所有条目内容拼成的字符串）区分「同一份清单的状态更新」和
 * 「一份全新的清单」，只有后者才自动展开；用户在跑同一份清单时手动收起来则尊重他。
 *
 * 还负责三个面板（任务树 / 任务清单 / 归档快照）的互斥展开规则：同一时刻只展开一个，
 * 点开胶囊里的归档清单时另外两个被收起并锁住，直到归档清单被收起才恢复。
 *
 * 只做字符串/数字处理，不碰 DOM，不读文案。
 */
(() => {
  /**
   * 清单签名：条目内容按顺序拼接。
   *
   * 刻意只用 `content`、不用 `status`：同一条目从 pending 变成 completed 属于
   * 「同一份清单的进度更新」，不该被当成新清单而反复把面板顶开。
   */
  function todoSignature(todos) {
    if (!Array.isArray(todos) || !todos.length) return '';
    return todos
      .map((todo) => String(todo && todo.content != null ? todo.content : ''))
      .join('\u0000');
  }

  /**
   * 新清单到达时要不要把面板「唤起」（自动展开）。
   *
   * - 空清单：没有可显示的内容，不动；
   * - 签名和上一次相同：同一份清单在更新进度，保持用户当前的展开/收起选择；
   * - 签名不同：换了一份新清单（或从无到有），展开它。
   */
  function shouldRevealTodoPanel(input) {
    // 胶囊聚焦期间不许把任务清单顶开：它此刻是被锁住的那两个面板之一，
    // 展开它会破坏「同一时刻只展开一个面板」的约束。
    if (input && input.archiveFocused) return false;
    const signature = String(input && input.signature ? input.signature : '');
    if (!signature) return false;
    const previous = String(input && input.previousSignature ? input.previousSignature : '');
    if (!previous) return true;
    return signature !== previous;
  }

  /**
   * 三个可展开面板的 key（与 media/chat.js 里的元素 id 一致）。
   *
   * 同一时刻只允许其中一个展开 —— 否则面板区一多，输入框就被挤到窗口外。
   */
  const PANEL_KEYS = ['taskTree', 'todoPanel', 'todoArchivePanel'];
  const ARCHIVE_PANEL = 'todoArchivePanel';

  /**
   * 点了某个面板标题栏之后应该发生什么。
   *
   * 规则：
   * - 归档面板（胶囊里那份清单）随时可开可关：打开时连带收起另外两个，关闭时退出聚焦；
   * - 聚焦期间（有胶囊展开）任务树和任务清单被锁住，点了不展开 —— 必须先收起归档清单；
   * - 收起永远允许，否则会卡在「打不开也关不掉」的死状态。
   *
   * 返回：
   * - allowed          是否接受这次操作
   * - open             面板最终应处于的状态
   * - collapsePeers    是否要连带收起另外两个面板
   * - exitArchiveFocus 是否要退出胶囊聚焦（并还原进入前的展开状态）
   */
  function planPanelToggle(input) {
    const panel = String((input && input.panel) || '');
    const open = Boolean(input && input.open);
    const archiveFocused = Boolean(input && input.archiveFocused);
    if (PANEL_KEYS.indexOf(panel) === -1) return { allowed: true, open, collapsePeers: false, exitArchiveFocus: false };
    if (panel === ARCHIVE_PANEL) return { allowed: true, open, collapsePeers: open, exitArchiveFocus: !open };
    if (!open) return { allowed: true, open: false, collapsePeers: false, exitArchiveFocus: false };
    if (archiveFocused) return { allowed: false, open: false, collapsePeers: false, exitArchiveFocus: false };
    return { allowed: true, open: true, collapsePeers: false, exitArchiveFocus: false };
  }

  /**
   * 点胶囊之后谁处于展开态：点同一颗 = 收起（null），点另一颗 = 换成它。
   *
   * 只有一个「当前展开的 id」，所以结构上就不可能同时展开两颗胶囊。
   */
  function nextArchiveFocus(input) {
    const clicked = String((input && input.clickedId) || '');
    if (!clicked) return null;
    const current = String((input && input.currentId) || '');
    return current === clicked ? null : clicked;
  }

  /**
   * 归档胶囊的圆角半径：圆角矩形，不是胶囊（不做 999px 的整圆）。
   *
   * 按高度取比例，这样胶囊缩小到 6px 时圆角跟着变小，不会被磨成椭圆。
   */
  function capsuleRadius(height) {
    const value = Number(height);
    if (!Number.isFinite(value) || value <= 0) return 2;
    return Math.max(2, Math.round(value * 0.3));
  }

  globalThis.HWChatTodoPanelState = {
    todoSignature,
    shouldRevealTodoPanel,
    capsuleRadius,
    planPanelToggle,
    nextArchiveFocus,
  };
})();
