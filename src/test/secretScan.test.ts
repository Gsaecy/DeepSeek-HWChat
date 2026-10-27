import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/** 一条命中结果。注意：**没有 value 字段** —— 模块刻意不回显凭据原文。 */
interface SecretFinding {
  kind: string;
  field: string;
  length: number;
  index: number;
  /** 归属：凭据（credential）还是个人隐私（privacy）。界面按它分段给建议。 */
  category: 'credential' | 'privacy';
}

/** media/secret-scan.js 暴露的接口。 */
interface SecretScan {
  kinds: () => string[];
  isPlaceholder: (value: unknown) => boolean;
  scanSecrets: (text: unknown) => SecretFinding[];
}

/**
 * 在 Node 里跑 webview 的纯函数脚本（与 calloutMeta.test.ts 同一做法）。
 *
 * 测的是「什么算明文凭据」这条判断本身：它决定用户消息下方会不会出现红色提醒。
 * 判断错的两个方向都有代价 —— 漏报是密钥已经泄漏却没人提醒，
 * 误报是每次提问都弹红框、很快没人再看。
 */
function loadSecretScan(): SecretScan {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/secret-scan.js', 'utf8'), sandbox);
  const api = sandbox.HWChatSecretScan as SecretScan | undefined;
  assert.ok(api, 'media/secret-scan.js 必须挂载 HWChatSecretScan');
  return api;
}

/** 取命中的类型列表，便于断言。 */
function kindsOf(text: string): string[] {
  return loadSecretScan()
    .scanSecrets(text)
    .map((finding) => finding.kind);
}

test('有名的密钥格式必须被识别', () => {
  const cases: Array<[string, string]> = [
    ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'anthropicKey'],
    ['sk-proj-AbCdEfGhIjKlMnOpQrStUv', 'openaiKey'],
    ['AKIAIOSFODNN7EXAMPLE', 'awsAccessKey'],
    ['ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'githubToken'],
    ['AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz01234567', 'googleApiKey'],
    // 拼接而不是直接写字面量：整串 `xoxb-…` 会被 GitHub push protection
    // 判成真 token 并拒绝推送。拼接后源码里不存在连续的模式，扫描器仍能认出运行期的值。
    [['xoxb', '123456789012', 'AbCdEfGhIjKlMn'].join('-'), 'slackToken'],
    ['Bearer AbCdEfGhIjKlMnOpQrStUvWxYz01', 'bearerToken'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'privateKey'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'privateKey'],
    [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
      'jwt',
    ],
  ];
  for (const [text, expected] of cases) {
    // 跨 vm 边界的数组不能直接 deepEqual（原型不同域），拼成字符串比较。
    assert.equal(kindsOf(text).join(','), expected, `应识别为 ${expected}：${text}`);
  }
});

test('同一条密钥只报一次：sk-ant 归为 Anthropic，不重复报成 OpenAI', () => {
  const findings = loadSecretScan().scanSecrets('key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'anthropicKey');
});

test('绝不回显凭据原文：命中结果里只有类型、字段名与长度', () => {
  const secret = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz';
  const findings = loadSecretScan().scanSecrets(`这是我的 key：${secret}`);
  assert.equal(findings.length, 1);
  // 提醒本身再把密钥打印一遍就是二次泄漏，所以结果里不许出现原文的任何片段。
  const serialized = JSON.stringify(findings);
  assert.ok(!serialized.includes(secret), '不得包含密钥原文');
  assert.ok(!serialized.includes('AbCdEf'), '不得包含密钥片段');
  assert.equal(findings[0]?.length, secret.length);
});

test('占位符必须被排除：教程与示例写法不能触发红框', () => {
  const api = loadSecretScan();
  const placeholders = [
    'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
    'sk-your-api-key-here',
    'AKIAXXXXXXXXXXXXXXXX',
    'api_key = "your_api_key_here"',
    'password: changeme',
    'token = "<YOUR_TOKEN>"',
    'password = "${DB_PASSWORD}"',
    'secret_key = "{{SECRET}}"',
    'api_key = "sk-..."',
    'password = "aaaaaaaaaaaa"',
  ];
  for (const text of placeholders) {
    assert.equal(api.scanSecrets(text).length, 0, `占位符不该触发提醒：${text}`);
  }
});

test('纯数字的弱密码仍然上报：它可能就是真实密码，不能当占位符放过', () => {
  // 这是一个刻意的取舍：`1234567890` 在示例里常见，但也是真实存在的弱密码。
  // 相比漏报一条真密码，多一次提示的代价更小 —— 所以只有全同字符（0000000000）
  // 才被判为填充值。
  assert.equal(kindsOf('password = "1234567890"').join(','), 'credentialAssignment');
  assert.equal(kindsOf('password = "0000000000"').join(','), '');
});

test('显式赋值字段：报出字段名，方便用户定位是哪一项', () => {
  const findings = loadSecretScan().scanSecrets('DB password = "hunter2really"');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'credentialAssignment');
  assert.equal(findings[0]?.field, 'password');
  assert.equal(findings[0]?.length, 'hunter2really'.length);
});

test('有名格式优先于赋值规则：api_key = "sk-..." 只报一条', () => {
  const findings = loadSecretScan().scanSecrets('api_key = "sk-proj-AbCdEfGhIjKlMnOpQrStUv"');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'openaiKey');
});

test('不该误报的内容：普通提问、commit hash、版本号、路径', () => {
  const safe = [
    '帮我看一下 src/views/chatPanel.ts 里的 renderMessage 函数',
    'commit 08c07c6f9a2b1c3d4e5f6a7b8c9d0e1f2a3b4c5d 这次改动是什么',
    '把 @openai/sdk 从 4.12.0 升到 4.13.2',
    'const token = 0;',
    'password 字段不能为空',
    '',
    '   ',
  ];
  for (const text of safe) {
    assert.equal(kindsOf(text).join(','), '', `不该触发：${text}`);
  }
});

test('短值不触发：长度不足 8 的赋值当作变量名而非密钥', () => {
  assert.equal(kindsOf('password = "short"').join(','), '');
  assert.equal(kindsOf('api_key = "abc"').join(','), '');
});

test('多条命中按出现位置排序', () => {
  const findings = loadSecretScan().scanSecrets(
    'first sk-proj-AbCdEfGhIjKlMnOpQrStUv then AKIAIOSFODNN7EXAMPLE',
  );
  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.kind, 'openaiKey');
  assert.equal(findings[1]?.kind, 'awsAccessKey');
  assert.ok((findings[0]?.index ?? 0) < (findings[1]?.index ?? 0));
});

test('kinds 暴露全部可识别的类型，供界面翻译', () => {
  const kinds = loadSecretScan().kinds();
  for (const kind of [
    'privateKey',
    'awsAccessKey',
    'githubToken',
    'anthropicKey',
    'openaiKey',
    'googleApiKey',
    'slackToken',
    'bearerToken',
    'jwt',
    'credentialAssignment',
  ]) {
    assert.ok(kinds.includes(kind), `kinds 必须包含 ${kind}`);
  }
});

/*
 * 个人隐私类：用户 2026-10 追加的定义 —— 不只是密钥，身份证号、银行卡号、手机号
 * 泄漏后一样能造成实际损失（盗刷、冒用身份、精准诈骗），同样要触发危险提醒。
 *
 * 下面这些样本都是「按算法算出来的合法值」，不是随手编的数字串：
 *   身份证 110101199003071233 的末位由前 17 位按 mod 11 算出；
 *   卡号 6222021234567894 / 6222021234567890128 满足 Luhn。
 * 用合法样本才能区分「规则真的在算校验位」和「规则只数了位数」。
 */
const VALID_ID = '110101199003071233';
const VALID_CARD_16 = '6222021234567894';
const VALID_CARD_19 = '6222021234567890128';

test('隐私类必须被识别，并带上 privacy 分类', () => {
  const cases: Array<[string, string]> = [
    [`我的身份证号是 ${VALID_ID}`, 'idCard'],
    [`银行卡 ${VALID_CARD_16}`, 'bankCard'],
    [`卡号 ${VALID_CARD_19}`, 'bankCard'],
    ['手机号 13800138000', 'phoneNumber'],
  ];
  for (const [text, expected] of cases) {
    const findings = loadSecretScan().scanSecrets(text);
    assert.equal(findings.length, 1, `应识别出 1 条：${text}`);
    assert.equal(findings[0]?.kind, expected);
    assert.equal(findings[0]?.category, 'privacy');
    // 隐私类和凭据类一样：只报类型与长度，绝不回显号码本身。
    assert.equal(findings[0]?.length, expected === 'phoneNumber' ? 11 : text.match(/\d+/)?.[0].length);
  }
});

test('凭据类仍然带 credential 分类，两类可区分', () => {
  const findings = loadSecretScan().scanSecrets('api_key=[REDACTED_KEY]');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, 'credential');
});

test('身份证校验位不对 → 不报；也不能被误报成银行卡号', () => {
  // 只错最后一位：形状像身份证、Luhn 又刚好通过，这正是最容易报错类型的情况。
  assert.equal(kindsOf(`身份证 ${VALID_ID.slice(0, 17)}5`).join(','), '');
  assert.equal(kindsOf(`身份证 ${VALID_ID.slice(0, 17)}X`).join(','), '');
});

test('银行卡 Luhn 不对 → 不报', () => {
  assert.equal(kindsOf('订单号 6222021234567890124').join(','), '');
  assert.equal(kindsOf('单号 6222021234567895').join(','), '');
});

test('隐私类的误报防线：时间戳、版本号、全同数字都不触发', () => {
  const safe = [
    '时间戳 1759837200000',
    '把 @openai/sdk 从 4.12.0 升到 4.13.2',
    '构建号 20240101120000',
    '0000000000000000',
    '订单流水 62220212345678901234',
    '手机号请填 138****8000',
  ];
  for (const text of safe) {
    assert.equal(kindsOf(text).join(','), '', `不该触发：${text}`);
  }
});

test('kinds 必须包含隐私类，供界面翻译类型名', () => {
  const kinds = loadSecretScan().kinds();
  for (const kind of ['idCard', 'bankCard', 'phoneNumber']) {
    assert.ok(kinds.includes(kind), `kinds 必须包含 ${kind}`);
  }
});
