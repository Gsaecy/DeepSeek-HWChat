/*
 * 流式输出时的「未闭合 markdown 补全」。
 *
 * 依据（不是自己猜的）：
 *  - Vercel AI SDK 官方的 Streamdown 组件在流式场景下的两条核心做法是
 *    「block 级记忆化，只重画变化的那一块」+「用 remend 补全未闭合的 markdown」；
 *    remend README 原话：自动补全 bold / italic / inline code / links / strikethrough /
 *    math，「让还在流的半截语法也能正确渲染」。
 *  - 不补全会发生什么：`**重点` 还没等到收尾的 `**` 时只能按字面量渲染，
 *    等收尾符一到，星号消失、文字变粗、宽度变化 —— 已经显示出来的文字就会跳。
 *    补全之后半截语法直接按**最终形态**渲染，可见文字只增不减。
 *
 * 只处理「尾部还在写的那一段」：前面已经完整的段落一个字符都不动，
 * 否则一个没闭合的标记会被错误地补到别处去。
 *
 * 纯字符串处理，不碰 DOM，可直接单测（见 src/test/streamRepair.test.ts）。
 */
(() => {
  /** 尾部这段是不是正处在一个未闭合的围栏代码块里（```）：是就不做行内补全。 */
  function insideOpenFence(text) {
    const lines = String(text || '').split('\n');
    let open = false;
    for (const line of lines) {
      if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) open = !open;
    }
    return open;
  }

  /** 取最后一段（最后一个空行之后的内容）：只有它可能还在写。 */
  function tailSegment(text) {
    const value = String(text || '');
    const boundary = value.lastIndexOf('\n\n');
    return boundary < 0 ? value : value.slice(boundary + 2);
  }

  /** 数出 needle 在 value 里出现了几次（不重叠）。 */
  function countOf(value, needle) {
    let count = 0;
    let index = value.indexOf(needle);
    while (index >= 0) {
      count += 1;
      index = value.indexOf(needle, index + needle.length);
    }
    return count;
  }

  /**
   * 补全尾部还没闭合的星号标记。
   *
   * 不能只数奇偶：`**重点` 的星号是偶数（2 个）却仍然是没闭合的粗体；
   * `**重点*` 是「收尾符才写了一半」，只该补 1 个而不是补 2 个（那会变成三个星号）。
   * 所以按「星号串」从左往右配对：串长 ≥2 开粗体（≥3 是粗斜体），长度 1 开斜体，
   * 长度够就闭合最近的那个。扫完还有没闭合的，就把它缺的那几个星号补上。
   */
  const STAR_RUN = /\*+/g;
  const TILDE_RUN = /~+/g;

  /**
   * 补全某一串「成对符号」的尾部未闭合状态（星号与波浪号共用一套逻辑）。
   *
   * 不能只数奇偶：`**重点` 的星号是偶数却仍是没闭合的粗体；`**重点*` 是「收尾符才写了
   * 一半」，只该补 1 个（补 2 个会变成三个星号）。所以按符号串从左往右配对，
   * 串长决定它是粗体（≥2）还是斜体（1），长度够就闭合最近的那个。
   */
  function repairDelimiter(value, char) {
    const pattern = char === '*' ? STAR_RUN : TILDE_RUN;
    pattern.lastIndex = 0;
    const runs = [];
    let found = pattern.exec(value);
    while (found) {
      runs.push({ start: found.index, length: found[0].length });
      found = pattern.exec(value);
    }
    if (!runs.length) return value;

    /** 从左往右配对，返回仍然没闭合的开启符宽度（栈顶）。 */
    const widestOpen = (list) => {
      const open = [];
      for (const run of list) {
        const width = run.length >= 3 ? 3 : run.length >= 2 ? 2 : 1;
        const top = open[open.length - 1];
        if (top !== undefined && run.length >= top) { open.pop(); continue; }
        open.push(width);
      }
      return open.length ? open[open.length - 1] : 0;
    };

    const lastRun = runs[runs.length - 1];
    const endsWithRun = lastRun.start + lastRun.length === value.length;

    /*
     * 结尾这一串有两种身份：
     *  - 它在**收尾**（正文停在一个比开启符更窄的串上，例如 `**重点*`、`~~删掉~`）：
     *    补够宽就行，补 1 个而不是补 2 个。
     *  - 它自己就是刚写下、还没写内容的**开启符**（`**` 后面什么都没有）：
     *    补收尾只会凑出 `****` 被当成字面量，屏幕上多显示一坨符号，先不补。
     */
    if (endsWithRun) {
      const need = widestOpen(runs.slice(0, -1));
      if (!need || lastRun.length >= need) return value;
      return value + char.repeat(need - lastRun.length);
    }

    const need = widestOpen(runs);
    return need ? value + char.repeat(need) : value;
  }

  /**
   * 删除线 `~~` 的补全。
   *
   * 与星号不同：单个 `~` 是**字面量**（`20~25`、`3~5 天`），绝不能当成开启符，
   * 否则正文里的区间写法会被补成删除线。所以这里只认成对的 `~~`，
   * 并单独处理「收尾符才写了一个 `~`」这种半截状态。
   */
  function repairTildes(value) {
    const trailing = /(~+)$/.exec(value);
    const tailLength = trailing ? trailing[1].length : 0;
    const stripped = tailLength ? value.slice(0, value.length - tailLength) : value;
    let doubled = 0;
    TILDE_RUN.lastIndex = 0;
    let found = TILDE_RUN.exec(stripped);
    while (found) {
      if (found[0].length >= 2) doubled += 1;
      found = TILDE_RUN.exec(stripped);
    }
    // 去掉结尾那一串之后还剩一个没闭合的 `~~`
    if (doubled % 2 === 1) {
      if (tailLength === 0) return `${value}~~`;   // 正文还在删除线里面
      if (tailLength === 1) return `${value}~`;    // 收尾符才写了一半
    }
    return value;
  }

  function repairStars(value) {
    // 行首的 `*` 是列表符号，不是行内标记：先等长遮成空格，位置才不会错。
    const masked = value.replace(/(^|\n)([ \t]*)\*(?=[ \t])/g, (match, newline, indent) => `${newline}${indent} `);
    const repaired = repairDelimiter(masked, '*');
    // 遮罩只是为了让配对算得准，**绝不能把遮罩后的字符串交出去**（列表符号会变成空格）。
    // 需要补的时候补的一定是末尾那几个星号，把它接回原文即可。
    return repaired === masked ? value : `${value}${repaired.slice(masked.length)}`;
  }

  /**
   * 补全尾部未闭合的行内标记。
   *
   * 顺序很重要：行内代码最先（代码里不会再有别的语法），链接次之，
   * 然后再处理星号与删除线。
   */
  function repairTail(segment) {
    let value = segment;

    // 行内代码：单个反引号未闭合。代码里不会再有别的行内语法，补完就结束。
    if (countOf(value, '`') % 2 === 1) return `${value}\``;

    /*
     * 链接：`[文字](` 之后的地址还没写完。
     *
     * 分两种情况，目标是同一个：让文字部分立刻收敛成链接文字，而不是先把
     * `[文字](h` 这串字面量显示出来、等地址写完再突然变成「文字」。
     *  - 地址已经看得出是合法目标（http(s):// / mailto: / # / /）：补右括号即可，
     *    文字不会再变，只有 href 在增长；
     *  - 地址还只是一小截（`h`、`ht`、`htt`…）：换成安全的站内锚点 `#`。
     *    这里**不能**用占位域名去补 —— 那样点一下会真的去打开一个不存在的网址。
     */
    const partialLink = /\[([^\]\n]*)\]\(([^)\s]*)$/.exec(value);
    if (partialLink) {
      const target = partialLink[2];
      if (!target) return `${value}#)`;
      if (/^(?:https?:\/\/|mailto:|#|\/)/i.test(target)) return `${value})`;
      return `${value.slice(0, value.length - target.length)}#)`;
    }

    value = repairStars(value);
    value = repairTildes(value);

    return value;
  }

  /**
   * 补全一段正在流式输出的 markdown。
   *
   * @param {string} text 当前已经收到的完整正文
   * @returns {string} 补全后的正文（绝大多数情况下原样返回）
   */
  function repairStreamingMarkdown(text) {
    const value = String(text || '');
    if (!value) return value;
    // 围栏代码块里写的是原文，不能当行内语法补。
    if (insideOpenFence(value)) return value;
    const tail = tailSegment(value);
    if (!tail.trim()) return value;
    // 尾段以围栏开头：这是代码块的开头，同样不补。
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(tail)) return value;
    const repaired = repairTail(tail);
    if (repaired === tail) return value;
    return value.slice(0, value.length - tail.length) + repaired;
  }

  /**
   * 这一段现在是否需要补全（尾部还有没收尾的标记）。
   *
   * 渲染这边用它决定「能不能走原地追加」：原地追加只是把字符贴到文本节点上，
   * 不会再走一遍行内解析，所以当尾部正处在一个没闭合的 `**` / `~~` / `` ` `` 里时，
   * 必须老老实实重排一次，补全才会生效——否则用户会先看到 `**重点` 这样的字面量，
   * 等收尾符到了才突然变粗，仍然是一次可见的跳动。
   */
  function needsRepair(text) {
    const value = String(text || '');
    return repairStreamingMarkdown(value) !== value;
  }

  globalThis.HWChatStreamRepair = { repairStreamingMarkdown, needsRepair };
})();
