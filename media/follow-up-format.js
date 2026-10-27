/**
 * 「需要你做的」清单的渲染兜底。
 *
 * 提示词（src/agent/followUpPrompt.ts）已经要求模型写 `1. **动作**`，
 * 但模型并不总会照做 —— 用户已经因此反复看到 `1. [ ] **动作**`。
 * 提示词管的是「尽量别写」，这个模块管的是「写了也不展示」。
 *
 * 只处理**有序列表**：`- [ ]` / `* [x]` 是 GFM 合法的任务列表写法，
 * 模型用它表示「这是一份任务清单」时是有意义的，抽掉会丢信息。
 * 而 `1. [ ]` 这种「数字 + 方括号」在正常排版里没有语义，只会变成噪音，
 * 正是截图里那种情况，所以在这个范围内剥离是安全的。
 *
 * 剥离只作用于渲染，不改动消息原文：复制按钮复制的仍是模型写的原文。
 */
(function () {
  // [ ]、[]、[x]、[X] —— 后面必须跟空白，避免把 `[x]foo` 这类正文吃掉。
  const MARKER = /^\[[ xX]?\]\s+/;

  /** 去掉有序列表项开头的复选框标记；没有标记时原样返回。 */
  function stripCheckboxMarker(text) {
    if (typeof text !== 'string') return '';
    if (!text) return text;
    return text.replace(MARKER, '');
  }

  /** 列表项该显示什么文本：只有有序列表才剥标记。 */
  function listItemText(marker, text) {
    if (typeof marker !== 'string' || !/\d/.test(marker)) {
      return typeof text === 'string' ? text : '';
    }
    return stripCheckboxMarker(text);
  }

  globalThis.HWChatFollowUpFormat = { stripCheckboxMarker, listItemText };
})();
