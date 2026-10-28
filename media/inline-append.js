/*
 * 「新来的这一小段能不能直接贴到段落末尾」的纯函数判定。
 *
 * 为什么单独抽出来：流式输出时正在增长的那一段每 70ms 重排一次，重排会把段落里的
 * DOM 整个重建一遍——包括里面的文件标签。用户鼠标正停在已输出的文字上时，重造出来的
 * 标签要重新进入 :hover、过渡动画从头跑，看起来就是「已经输出的文字也会跳」。
 * 所以对「只是接着写普通文字」这种绝大多数情况，我们直接把文字追加到末尾的文本节点上。
 *
 * 判定越保守越好：只要这一小段可能开启/闭合行内标记、构成链接或路径，就返回 false，
 * 让调用方老老实实重排。重排永远是对的，快路径只负责普通文字。
 *
 * 不碰 DOM、不读文案，纯字符串判断，所以能直接单测（见 src/test/inlineAppend.test.ts）。
 */
(() => {
  /**
   * 出现在这一小段里就说明「不能当纯文字贴」的字符：
   * 反引号 / 星号 / 波浪号 是行内标记，方括号圆括号竖线是链接与表格，
   * 井号是标题，尖括号是自动链接，冒号斜杠反斜杠是 URL 与路径，
   * 换行/回车会把段落切开。
   */
  const UNSAFE = /[`*~[\]()|#\\_<>:/\n\r]/;

  /** `.` 后面接字母数字很像扩展名（`app.ts`）——裸路径是要变成标签的。 */
  const EXTENSION_LIKE = /\.[A-Za-z0-9]/;

  /** 上一段文字以这些字符结尾时，很可能正写到一半的路径上。 */
  const PATH_TAIL = /[./:\\]$/;

  /** 这一小段以路径字符开头，就可能把上面那个「一半」补成完整路径。 */
  const PATH_HEAD = /^[A-Za-z0-9]/;

  /**
   * @param {string} appended 这一帧新追加的原始字符（可能含首尾空白）
   * @param {string} previousTail 上一帧这一块结尾处的可见文字（取末尾若干字符即可）
   * @returns {boolean} true 表示可以安全地直接追加成纯文字
   */
  function canAppendPlainText(appended, previousTail) {
    if (typeof appended !== 'string' || !appended) return false;
    if (UNSAFE.test(appended)) return false;
    if (EXTENSION_LIKE.test(appended)) return false;
    const tail = typeof previousTail === 'string' ? previousTail : '';
    // `app` + `.tsx` 被拆成两帧：单独看每一帧都「普通」，拼起来却是一个路径。
    if (PATH_TAIL.test(tail) && PATH_HEAD.test(appended)) return false;
    return true;
  }

  globalThis.HWChatInlineAppend = { canAppendPlainText };
})();
