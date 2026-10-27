/*
 * toast 的显示时长（webview 与单元测试共用的纯函数）。
 *
 * 为什么需要它：原来所有 toast 一律 4.2 秒，与文字长度、严重程度都无关。
 * 短提示（「标题已保存」）4.2 秒足够，但停滯提醒那种六十多个汉字的警告
 * 在 4.2 秒里根本读不完 —— 用户反馈「弹了一次但消失太快，没看清」。
 * 提示的价值取决于它能不能被读完，所以时长必须跟文字长度走。
 *
 * 三条刻意的取舍：
 *   1. 按「阅读单位」算，不按字符数。中文一字一个单位，拉丁字符约 0.4 个
 *      （英文按词读，速度是中文的两三倍）。否则英文界面会得到两三倍过长的
 *      toast，一样是噪音。
 *   2. 语气只抬下限，不改上限。warning / error 更该被读，所以起点更长；
 *      但真正的时长仍由文字量决定。
 *   3. 封顶 20 秒。再长就该改成常驻卡片，而不是让 toast 一直挂着挡视野。
 *
 * 只做数值计算，不碰 DOM、不读文案：文案按语言翻译是调用方的事。
 */
(() => {
  'use strict';

  /** 中文 / 日文假名 / 韩文 / 全角标点 —— 一字算一个阅读单位。 */
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/;

  /** 每秒读完多少个「阅读单位」。中文约 300–500 字/分，取 6 字/秒偏宽裕。 */
  const UNITS_PER_SECOND = 6;

  /** 各语气的下限。warning / error 不该一闪而过。 */
  const MIN_MS = { neutral: 4000, warning: 6000, error: 7000 };

  /** 上限：再长就不该用 toast 表达了。 */
  const MAX_MS = 20000;

  function readingUnits(text) {
    let units = 0;
    // for...of 按码点走，代理对（emoji 等）不会被拆成两个字符。
    for (const ch of String(text == null ? '' : text)) {
      units += CJK.test(ch) ? 1 : 0.4;
    }
    return units;
  }

  function toastDurationMs(text, tone) {
    const min = MIN_MS[tone] || MIN_MS.neutral;
    const reading = Math.round((readingUnits(text) / UNITS_PER_SECOND) * 1000);
    return Math.min(MAX_MS, Math.max(min, reading));
  }

  globalThis.HWChatToastTiming = { toastDurationMs, readingUnits, MIN_MS, MAX_MS };
})();
