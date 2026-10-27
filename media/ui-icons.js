/*
 * 界面图标的统一来源（webview 与单元测试共用）。
 *
 * 为什么要这个文件：
 * 之前在 chat.js 里是「拿文字当图标」——✓ ● ○ … ↳ − ! × ↗ ↺ □，靠系统字体渲染。
 * 问题有三个，且都无法用 CSS 修掉：
 *   1. 字形由字体决定：同样是 9px，Windows 的 ✓ 比 macOS 细一截，同一个 16px 徽标里
 *      有时顶到边、有时缩成一小点；
 *   2. 基线不齐：这些字符的 ascent/descent 各不相同，vertical-align 要逐个调；
 *   3. 字重不可控：想让勾粗一点只能加 font-weight，结果整个字符被拉宽。
 * 图标必须是我们自己画的几何图形，所以统一改成内联 SVG，形状、笔画、留白都由规格决定。
 *
 * 规格（扁平：单色、无渐变、无阴影、无滤镜）：
 * - 统一 16 格网格，四周留 2 格安全区：图形只画在 2~14，保证并排时视觉大小一致；
 * - 只用 currentColor，颜色一律交给 CSS（主题一换图标自动跟随）；
 * - 状态徽标用描边（小尺寸下太细会糊，所以标注单独调粗）；
 * - 折叠箭头是同一套网格里的 chevron，展开时用 CSS 旋转，不再换字符。
 *
 * 本文件是纯字符串处理，不碰 DOM，src/test/uiIcons.test.ts 可以直接覆盖。
 */
(() => {
  /** 所有图标共用同一个坐标系，换图标不会跳位。 */
  const VIEW_BOX = '0 0 16 16';
  /** 安全区：图形不越出 2~14。测试会逐条校验。 */
  const PADDING = 2;
  /** 默认描边宽度（网格单位）；小尺寸徽标可单独加粗。 */
  const DEFAULT_STROKE = 2;

  /**
   * 图标表。
   *
   * 命名按「语义」而不是形状：调用方说「这是成功」，不关心它画成勾还是别的，
   * 以后要统一改形状只动这里一处。strokeWidth 只在视觉需要时覆盖。
   */
  const ICONS = {
    // 完成 / 成功。白色勾画在彩色圆底上，笔画要比其它图标粗一档才不发虚。
    check: { body: '<path d="M3.5 8.5 6.4 11.4 12.5 5.1"/>', strokeWidth: 2.6 },
    // 拒绝 / 取消 / 暂停：一根横杠。
    minus: { body: '<path d="M4 8h8"/>', strokeWidth: 2.4 },
    // 出错：上粗下点的感叹号（点用实心圆，避免小尺寸下糊成一段线）。
    bang: {
      body: '<path d="M8 3.4v5.5"/><circle cx="8" cy="12.2" r="1.1" fill="currentColor" stroke="none"/>',
      strokeWidth: 2.2,
    },
    // 等待 / 判断中：省略号。
    ellipsis: {
      body: '<circle cx="3.9" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="12.1" cy="8" r="1.15" fill="currentColor" stroke="none"/>',
    },
    // 当前节点 / 已固定：实心圆。
    dot: { body: '<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>' },
    // 排队 / 未固定 / 待办：空心圆。描边 2.4 是算出来的：
    // 这个圆在 9~10px 的框里渲染，2.4/16×10 ≈ 1.5px，和原来 12px 圆圈的 1.6px 边框基本一致，
    // 再细就会比旁边的勾明显发虚。
    ring: { body: '<circle cx="8" cy="8" r="4.4"/>', strokeWidth: 2.4 },
    // 已归并到后续节点：折向下再向右的箭头。
    turn: { body: '<path d="M4.8 3.6v5.2a2.2 2.2 0 0 0 2.2 2.2h3.4"/><path d="m9 9 2 2-2 2"/>' },
    // 已归档：方框。
    square: { body: '<rect x="4" y="4" width="8" height="8" rx="1.8"/>' },
    // 关闭 / 删除。
    close: { body: '<path d="M4.6 4.6 11.4 11.4"/><path d="M11.4 4.6 4.6 11.4"/>' },
    // 继续这条对话：右上箭头。
    arrowUpRight: { body: '<path d="M4.8 11.2 11.2 4.8"/><path d="M6.2 4.6h5v5"/>' },
    // 还原 / 恢复：带箭头的回转圈。
    restore: { body: '<path d="M12.6 8.3a4.6 4.6 0 1 1-1.2-3.1"/><path d="M7.6 3.2h4.1v4.1"/>' },
    // 折叠箭头：向右表示「下面是收起的内容」，展开时由 CSS 转 90°。
    chevronRight: { body: '<path d="M6.3 3.8 10.6 8l-4.3 4.2"/>', strokeWidth: 2.2 },
    chevronDown: { body: '<path d="M3.8 6.3 8 10.6l4.2-4.3"/>', strokeWidth: 2.2 },
    // 编辑：笔尖朝左下的铅笔。笔杆是一条闭合多边形（四条边），
    // 再加一条短横线当「橡皮箍」，小尺寸下这两个元素就够认出是铅笔，不需要更多细节。
    pencil: { body: '<path d="M3.2 12.8 4 9.9 10.9 3 12.9 4.9 6 11.8Z"/><path d="M9.7 4.2 11.7 6.2"/>' },

    /* ── 正文里用来替代 emoji 的一组 ───────────────────────────────
       为什么正文也要换：助手输出里的 🔔 ✅ ⚠️ 是系统 emoji 字体画的，
       彩色、有立体高光、大小还不一致，和这套单色扁平界面完全不是一回事，
       而且「扁平/单色」这件事由 emoji 字体决定，CSS 改不动。
       下面这些图形按同一套 16 格网格重新画过，颜色仍走 currentColor。 */

    // 提示 / 待办提醒。
    bell: { body: '<path d="M8 2.9a3.2 3.2 0 0 0-3.2 3.2v2.5L3.8 11.2h8.4L11.2 8.6V6.1A3.2 3.2 0 0 0 8 2.9"/><path d="M6.6 11.2a1.4 1.4 0 0 0 2.8 0"/>' },
    // 重点标记：书签形状，比「图钉」在小尺寸下更容易认出是「记住这个」。
    pin: { body: '<path d="M4.4 2.9h7.2v10.3L8 10.4l-3.6 2.8Z"/>' },
    // 说明 / 思路。
    bulb: { body: '<path d="M8 2.9a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-1.6 3v1.3H6.1V9.4a3.5 3.5 0 0 1-1.6-3A3.5 3.5 0 0 1 8 2.9Z"/><path d="M6.7 12.2h2.6"/><path d="M7.1 13.6h1.8"/>' },
    // 发布 / 上线。
    rocket: { body: '<path d="M8 2.9c1.9 1.3 2.9 3.4 2.9 5.7L8 11.3 5.1 8.6C5.1 6.3 6.1 4.2 8 2.9Z"/><circle cx="8" cy="6.6" r="1.15"/><path d="M8 11.3v2.4"/>' },
    // 排查 / 搜索。
    search: { body: '<circle cx="7.1" cy="7.1" r="4.1"/><path d="M10.2 10.2 13.1 13.1"/>' },
    // 需要注意 / 警告：三角形 + 感叹号。
    warn: { body: '<path d="M8 3.1 13.4 12.4H2.6Z"/><path d="M8 6.7v2.9"/><circle cx="8" cy="11.2" r="0.95" fill="currentColor" stroke="none"/>' },
  };

  /**
   * 正文 emoji → 图标名。
   *
   * 只收「在助手输出里反复出现、且有明确语义」的那些；其余 emoji 原样保留，
   * 不做通用转换——把用户打的 🎉 换成某个我们画的图形反而更奇怪。
   */
  const EMOJI = {
    '🔔': 'bell',
    '📌': 'pin',
    '💡': 'bulb',
    '🚀': 'rocket',
    '🔍': 'search',
    '⚠': 'warn',
    '✅': 'check',
    '❌': 'close',
    '📝': 'pencil',
  };


  const NAMES = Object.keys(ICONS);

  function has(name) {
    return Object.prototype.hasOwnProperty.call(ICONS, name);
  }

  /**
   * 生成一个完整的内联 SVG 字符串。
   *
   * 未知名字返回空字符串而不是抛错：界面缺一个图标不该让整个渲染中断，
   * 调用方会退化成文字符号（见 media/chat.js 的 iconNode）。
   */
  function markup(name) {
    if (!has(name)) return '';
    const icon = ICONS[name];
    const stroke = icon.strokeWidth || DEFAULT_STROKE;
    // fill="none" 放在根上：只有需要实心的元素才显式写 fill="currentColor"，
    // 这样漏写属性时得到的是描边图标，不会糊成一个实心块。
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}" aria-hidden="true" ` +
      `fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" ` +
      `stroke-linejoin="round" data-icon="${name}">${icon.body}</svg>`
    );
  }

  /**
   * emoji → 图标名；查不到返回空字符串（调用方原样保留该字符）。
   *
   * 先去掉变体选择符 U+FE0F：`⚠️` 和 `⚠` 是同一个符号的两种写法，
   * 有的输入带那个不可见字符、有的不带，不归一化会漏掉一半。
   */
  function emojiName(raw) {
    const key = String(raw || '').replace(/\uFE0F/g, '');
    return Object.prototype.hasOwnProperty.call(EMOJI, key) ? EMOJI[key] : '';
  }

  globalThis.HWChatIcons = {
    VIEW_BOX,
    PADDING,
    DEFAULT_STROKE,
    names: () => NAMES.slice(),
    has,
    markup,
    emojiName,
    emojiKeys: () => Object.keys(EMOJI),
    maxEmojiLength: () => Math.max(...Object.keys(EMOJI).map((key) => [...key].length)) + 1,
  };
})();
