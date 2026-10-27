/*
 * 用户消息里的「敏感信息」识别（webview 与单元测试共用的纯函数）。
 *
 * 为什么需要它：提醒分级原本只靠模型自觉。但「用户自己把 API key 贴进对话」这件事，
 * 模型不一定会提，而且它已经发出去了 —— 等模型说话时已经晚了。所以这一类
 * 必须在界面层自己认出来，不依赖模型。
 *
 * 覆盖两类，都属于危险级别：
 *   凭据（category: credential）—— 密码、私钥、API key、token。
 *   隐私（category: privacy）  —— 身份证号、银行卡号、手机号。
 *
 * 判据（用户 2026-10 定义）：密码、私钥、API key 等泄漏后会造成「项目被读走、
 * 失去项目控制权、被入侵」；身份证 / 银行卡 / 手机号泄漏后会被盗刷、冒用身份、
 * 精准诈骗 —— 两者都算危险，都要走红色提醒。
 *
 * 三条刻意的取舍：
 *   1. 只报类型与长度，绝不回显原文 —— 提醒本身再把密钥打印一遍就是二次泄漏。
 *   2. 排除占位符（`sk-xxxx`、`your_api_key_here`、`<填这里>` 等）。
 *      教程和代码示例里全是这种写法，不加排除的话每次提问都要弹红框，
 *      红色很快就会变成"狼来了"。
 *   3. 宁可漏一点也不要大面积误报：只认有名的密钥格式和显式的字段赋值，
 *      不做「看着像随机字符串」的熵判断 —— 那会把 commit hash、base64 图片、
 *      依赖版本号全算成泄露。
 *
 * 只做字符串处理，不碰 DOM、不读文案：类型名交给调用方按语言翻译。
 */
(() => {
  'use strict';

  /**
   * 有名的密钥格式。
   *
   * 顺序有意义：越具体的规则排越前。同一段文本只能被一条规则认领
   * （见 claim），否则 `sk-ant-...` 会同时被 anthropicKey 和 openaiKey 命中，
   * 提醒里就会出现两条重复项。
   */
  const PREFIX_RULES = [
    { kind: 'privateKey', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
    { kind: 'awsAccessKey', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    { kind: 'githubToken', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
    { kind: 'anthropicKey', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
    { kind: 'googleApiKey', pattern: /\bAIza[0-9A-Za-z_-]{35,}/g },
    { kind: 'slackToken', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { kind: 'openaiKey', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
    { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
    { kind: 'bearerToken', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
    // 个人隐私类：不是「密钥」，但泄漏后一样造成实际损失（盗刷、冒用身份、精准诈骗）。
    // 这三条都带结构校验，不用「看着像一串数字」判 —— 否则订单号、流水号、
    // 时间戳、版本号全会被算成隐私泄漏，红色警告很快就没人看。
    { kind: 'idCard', pattern: /\b\d{17}[\dXx]\b/g, category: 'privacy', skipPlaceholder: true, validate: isValidIdCard },
    { kind: 'bankCard', pattern: /\b\d{16,19}\b/g, category: 'privacy', skipPlaceholder: true, validate: isValidBankCard },
    { kind: 'phoneNumber', pattern: /\b1[3-9]\d{9}\b/g, category: 'privacy', skipPlaceholder: true },
  ];

  /**
   * 中国大陆居民身份证号校验（18 位，末位可为 X）。
   *
   * 前 17 位加权求和后按 mod 11 查表，末位必须对得上；另外出生日期必须是
   * 真实存在的日期。只靠「18 位数字」判定会把订单号、流水号一起算进来，
   * 加上校验位能把误报压到很低。
   */
  function isValidIdCard(value) {
    const text = String(value).toUpperCase();
    if (!/^\d{17}[\dX]$/.test(text)) return false;
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checkTable = '10X98765432';
    let sum = 0;
    for (let i = 0; i < 17; i += 1) sum += Number(text[i]) * weights[i];
    if (checkTable[sum % 11] !== text[17]) return false;
    const year = Number(text.slice(6, 10));
    const month = Number(text.slice(10, 12));
    const day = Number(text.slice(12, 14));
    return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }

  /**
   * 像身份证号、但校验位不对。
   *
   * 用途：把 18 位、前 6 位是省码、中间是合法日期、但校验位算错的串从银行卡规则里排除。
   * 否则一个打错一位的身份证号会被报成「银行卡号」—— 类型报错比不报更误导人。
   */
  function looksLikeIdCardShape(text) {
    if (text.length !== 18) return false;
    if (!/^\d{17}[\dX]$/i.test(text)) return false;
    const province = Number(text.slice(0, 2));
    if (province < 11 || province > 82) return false;
    const year = Number(text.slice(6, 10));
    const month = Number(text.slice(10, 12));
    const day = Number(text.slice(12, 14));
    return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }

  /**
   * 银行卡号校验：16–19 位数字 + Luhn。
   *
   * 卡号不是密码，但它能直接用于盗刷，泄漏后果不比一把密钥轻。
   * 全同数字（`0000000000000000`）也满足 Luhn，必须单独排除。
   */
  function isValidBankCard(value) {
    const text = String(value);
    if (!/^\d{16,19}$/.test(text)) return false;
    if (REPEATED.test(text)) return false;
    if (looksLikeIdCardShape(text)) return false;
    let sum = 0;
    let doubling = false;
    for (let i = text.length - 1; i >= 0; i -= 1) {
      let digit = Number(text[i]);
      if (doubling) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      doubling = !doubling;
    }
    return sum % 10 === 0;
  }

  /**
   * `字段名: 值` / `字段名 = 值` 这类赋值。
   *
   * 放在最后跑：先让有名的格式认领自己的位置，剩下没被认领的才按赋值规则判，
   * 这样 `api_key = "sk-..."` 只报一条（报成 API 密钥），不会既有「OpenAI 密钥」
   * 又有「api_key 字段」。
   */
  const ASSIGNMENT_RULE = {
    kind: 'credentialAssignment',
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|pwd)\b\s*[:=]\s*["'`]?([^\s"'`,;)}]{8,})["'`]?/gi,
  };

  /**
   * 占位符特征。
   *
   * 这一条决定「提醒值不值得信」。教程里的 `sk-your-key-here`、`<YOUR_TOKEN>`、
   * `password: changeme` 都是要排除的；不排除的话，问一句「怎么写配置」
   * 就会满屏红框。
   */
  const PLACEHOLDER = /(?:your|example|sample|placeholder|dummy|redacted|changeme|change[_-]?me|insert|replace|todo|fixme|<|>|\$\{|\{\{|\.\.\.|x{3,}|X{3,}|\*{3,})/;

  /** 同一个字符重复多次：`aaaaaaa`、`00000000` 这类显然是填充。 */
  const REPEATED = /^(.)\1+$/;

  /** 凭据值的可见长度下限：短于这个长度的赋值大概率是变量名或单位，不是密钥。 */
  const MIN_VALUE_LENGTH = 8;

  /** 判断一个候选值是不是占位符。 */
  function isPlaceholder(value) {
    const text = String(value == null ? '' : value);
    if (text.length < MIN_VALUE_LENGTH) return true;
    if (REPEATED.test(text)) return true;
    return PLACEHOLDER.test(text);
  }

  /**
   * 扫描一段文本里的明文凭据。
   *
   * 返回按出现位置排序的数组，每项 { kind, field, length, index }：
   *   - kind  凭据类型（交给调用方翻译成人类可读的名字）
   *   - field 仅 credentialAssignment 有值，是那个字段名（如 api_key）
   *   - length 凭据长度：用来告知「这条密钥有多少字符」，而不必回显它
   *   - index  在原文中的起点，便于去重与排序
   */
  function scanSecrets(text) {
    const source = String(text == null ? '' : text);
    if (!source.trim()) return [];

    /** 已被认领的区间，避免同一条密钥被两条规则重复上报。 */
    const claimed = [];
    const findings = [];

    function claim(start, end) {
      if (end <= start) return false;
      for (const range of claimed) {
        if (start < range[1] && range[0] < end) return false;
      }
      claimed.push([start, end]);
      return true;
    }

    for (const rule of PREFIX_RULES) {
      rule.pattern.lastIndex = 0;
      let match = rule.pattern.exec(source);
      while (match) {
        const value = match[0];
        const start = match.index;
        // 私钥头本身是固定字样，没有"值"可判断，只要有 `BEGIN ... PRIVATE KEY` 就算。
        const needsValueCheck = rule.kind !== 'privateKey';
        // 隐私类靠结构校验（校验位 / Luhn）判断，不走占位符那套字符串特征。
        const structurallyValid = typeof rule.validate === 'function' ? rule.validate(value) : true;
        const passesPlaceholder =
          !needsValueCheck || rule.skipPlaceholder || !isPlaceholder(value);
        if (structurallyValid && passesPlaceholder && claim(start, start + value.length)) {
          findings.push({
            kind: rule.kind,
            field: '',
            length: value.length,
            index: start,
            category: rule.category || 'credential',
          });
        }
        match = rule.pattern.exec(source);
      }
    }

    ASSIGNMENT_RULE.pattern.lastIndex = 0;
    let match = ASSIGNMENT_RULE.pattern.exec(source);
    while (match) {
      const field = match[1];
      const value = match[2] || '';
      // 值总在匹配串末尾（前面是字段名、分隔符与可选引号），用它定位值本身。
      const valueStart = match.index + match[0].lastIndexOf(value);
      if (value && claim(valueStart, valueStart + value.length) && !isPlaceholder(value)) {
        findings.push({
          kind: ASSIGNMENT_RULE.kind,
          field: String(field).toLowerCase(),
          length: value.length,
          index: valueStart,
          category: 'credential',
        });
      }
      match = ASSIGNMENT_RULE.pattern.exec(source);
    }

    findings.sort((a, b) => a.index - b.index);
    return findings;
  }

  globalThis.HWChatSecretScan = {
    kinds: () => PREFIX_RULES.map((rule) => rule.kind).concat(ASSIGNMENT_RULE.kind),
    isPlaceholder,
    scanSecrets,
  };
})();
