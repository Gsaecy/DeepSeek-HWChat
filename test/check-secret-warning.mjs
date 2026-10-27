/*
 * 校验「用户消息里有明文凭据」时，界面真的会显示一条危险提醒，且不回显密钥。
 *
 * 为什么必须单独校验：单元测试只覆盖 media/secret-scan.js 的判断（什么算凭据），
 * 而用户看到的是 chat.js 造出来的 DOM。中间任何一处脱节都不会报错，
 * 症状是「密钥贴进去了但没有任何提示」—— 这恰恰是最不能静默失败的地方。
 * 所以这里把 chat.js 里真正的 secretWarningNode 原样切出来跑。
 *
 * 用法：node test/check-secret-warning.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let checks = 0;
let failures = 0;
function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}`);
}

/** 最小 DOM 节点：够 calloutNode / iconNode / secretWarningNode 用即可。 */
function makeNode(tag) {
  const classes = new Set();
  return {
    tagName: tag,
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      contains(name) { return classes.has(name); },
    },
    append(...nodes) { this.children.push(...nodes); },
  };
}

/** 取出节点树里所有可见文字，用来断言「密钥原文没有出现在提醒里」。 */
function collectText(node) {
  if (!node) return '';
  const own = typeof node.textContent === 'string' ? node.textContent : '';
  const childText = (node.children || []).map(collectText).join('');
  return own + childText;
}

/** 加载纯解析模块。 */
function loadModule(file, globalName) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox);
  return { sandbox, api: sandbox[globalName] };
}

/**
 * 从 chat.js 里切出「提醒块 + 凭据提醒」那段代码。
 *
 * 与 check-callout-dom.mjs 用同一段区间：起点是 uiIcons 常量，
 * 终点在 flattenEmojiIcons 之前（中间依次是 iconNode → calloutNode → secretWarningNode）。
 */
function extractRegion(source) {
  const start = source.indexOf('const uiIcons = globalThis.HWChatIcons || null;');
  const stop = source.indexOf('function flattenEmojiIcons(root)');
  if (start < 0 || stop <= start) throw new Error('没找到 chat.js 里的图标 / 提醒代码');
  const region = source.slice(start, stop);
  const end = region.lastIndexOf('\n  }');
  if (end < 0) throw new Error('没找到区间结尾');
  const code = region.slice(0, end + 4);
  if (!code.includes('function secretWarningNode')) throw new Error('切出来的区间里没有 secretWarningNode');
  return code;
}

const icons = loadModule('media/ui-icons.js', 'HWChatIcons').api;
const secretScanApi = loadModule('media/secret-scan.js', 'HWChatSecretScan').api;

const I18N_STUB = {
  'chat.calloutDanger': '危险',
  'chat.calloutImportant': '重要',
  'chat.secretWarnTitle': '危险：这条消息里有明文凭据',
  'chat.secretWarnItem': '检测到 {kind}（{length} 个字符）',
  'chat.secretWarnFieldItem': '检测到 {field} 字段的明文值（{length} 个字符）',
  'chat.secretWarnBody': '请立刻吊销并重新生成这把凭据。',
  'chat.secretKind.privateKey': '私钥',
  'chat.secretKind.awsAccessKey': 'AWS 访问密钥',
  'chat.secretKind.githubToken': 'GitHub 令牌',
  'chat.secretKind.anthropicKey': 'Anthropic API 密钥',
  'chat.secretKind.openaiKey': 'OpenAI 风格 API 密钥',
  'chat.secretKind.googleApiKey': 'Google API 密钥',
  'chat.secretKind.slackToken': 'Slack 令牌',
  'chat.secretKind.bearerToken': 'Bearer 令牌',
  'chat.secretKind.jwt': 'JWT 令牌',
  'chat.secretKind.credentialAssignment': '明文凭据',
  'chat.secretKind.idCard': '身份证号',
  'chat.secretKind.bankCard': '银行卡号',
  'chat.secretKind.phoneNumber': '手机号',
  'chat.secretWarnPrivacyTitle': '危险：这条消息里有个人隐私信息',
  'chat.secretWarnMixedTitle': '危险：这条消息里有明文凭据与个人隐私',
  'chat.secretWarnPrivacyBody': '身份证号、银行卡号、手机号不像密钥那样能吊销，发出去就是永久的。',
};

/**
 * 在沙箱里跑 chat.js 的那段代码。
 *
 * options.scan 传 undefined 模拟「secret-scan.js 没加载成功」，
 * options.throwOnScan 模拟扫描器自己抛异常 —— 两种退化路径都不该拖垮消息渲染。
 */
function loadSecretWarningNode(options = {}) {
  const source = readFileSync('media/chat.js', 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.HWChatIcons = icons;
  sandbox.HWChatSecretScan = options.scan === undefined ? secretScanApi : options.scan;
  sandbox.document = {
    createElement: (tag) => makeNode(tag),
    importNode: (node) => ({ tagName: node.tagName, imported: true }),
  };
  sandbox.DOMParser = class {
    parseFromString(markup) {
      const match = String(markup).match(/^<([a-zA-Z]+)/);
      return { documentElement: { tagName: match ? match[1] : 'parsererror' } };
    }
  };
  sandbox.t = (key, vars) => {
    const template = I18N_STUB[key];
    if (typeof template !== 'string') return key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
  };
  // 正文渲染用桩：只把文字记到节点上，不关心 markdown 细节。
  sandbox.appendRichText = (node, text) => { node.textContent = String(text || ''); };
  vm.createContext(sandbox);
  vm.runInContext(`${extractRegion(source)}\nglobalThis.__secretWarningNode = secretWarningNode;`, sandbox);
  return sandbox.__secretWarningNode;
}

const secretWarningNode = loadSecretWarningNode();

// ① 正常命中：OpenAI 风格密钥 → 危险提醒。
const OPENAI_KEY = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz';
{
  const node = secretWarningNode(`帮我看看这个 key：${OPENAI_KEY}`);
  check('命中凭据 → 生成提醒节点', node && node.className === 'message-callout');
  check('命中凭据 → 必须是 danger 级别（红色标题 + 亮黄图标）', node.dataset.tone === 'danger');
  const [head, body] = node.children;
  check('命中凭据 → 标题取危险文案', head.children[1].textContent === '危险：这条消息里有明文凭据');
  check('命中凭据 → 图标真的产出了 svg', head.children[0].children[0].tagName === 'svg');
  const text = collectText(node);
  check('命中凭据 → 说明里点名是哪一种凭据', text.includes('OpenAI 风格 API 密钥'));
  check('命中凭据 → 说明里给出长度', text.includes(String(OPENAI_KEY.length)));
  check('命中凭据 → 给出吊销建议', text.includes('吊销'));
  // 这一条是整个功能的安全底线。
  check('绝不回显密钥原文', !text.includes(OPENAI_KEY));
  check('绝不回显密钥片段', !text.includes('AbCdEf'));
}

// ② 没有凭据：必须是 null，否则每条消息都会挂一个红框。
{
  check('普通提问 → 不生成提醒', secretWarningNode('帮我看一下 renderMessage 函数') === null);
  check('空输入 → 不生成提醒', secretWarningNode('') === null);
  check('占位符 → 不生成提醒', secretWarningNode('api_key = "your_api_key_here"') === null);
  check('commit hash → 不生成提醒', secretWarningNode('commit 08c07c6f9a2b1c3d4e5f6a7b8c9d0e1f') === null);
}

// ③ 多种凭据同时出现：每种一条，都写进同一个提醒。
{
  const node = secretWarningNode('db 密码 password = "hunter2really"，还有 AKIAIOSFODNN7EXAMPLE');
  const text = collectText(node);
  check('多命中 → 同一条提醒里列出全部', text.includes('AWS 访问密钥') && text.includes('password'));
  // 列表排版要看正文节点本身：collectText 会把标题拼在前面，破坏行首判断。
  const bodyText = node.children[1] ? node.children[1].textContent : '';
  check('多命中 → 用破折号列表排版', (bodyText.match(/^- /gm) || []).length >= 2);
}

// ④ 退化路径：不能因为探测失败就把消息渲染搞崩。
{
  const noModule = loadSecretWarningNode({ scan: null });
  check('secret-scan.js 未加载 → 返回 null 而不是抛错', noModule('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz') === null);

  const brokenScan = loadSecretWarningNode({
    scan: { kinds: () => [], isPlaceholder: () => false, scanSecrets: () => { throw new Error('boom'); } },
  });
  check('扫描器抛异常 → 返回 null 而不是抛错', brokenScan('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz') === null);
}

// ⑤ 接线：提醒必须只在用户消息上触发，且注入顺序不能错。
{
  const chat = readFileSync('media/chat.js', 'utf8');
  check('chat.js 读取 HWChatSecretScan', chat.includes('globalThis.HWChatSecretScan'));
  check(
    '仅在用户消息上调用 secretWarningNode',
    /if \(message\.role === 'user'\) \{\s*const warning = secretWarningNode\(message\.content \|\| ''\);/.test(chat),
  );
  // 助手输出里也可能出现密钥，但那条由提示词约束「不许复述」；
  // 这里只断言用户侧一定有，避免两边都挂导致同一条密钥提示两遍。
  check('助手消息不额外挂凭据提醒', !/message\.role !== 'user'\) \{\s*const warning = secretWarningNode/.test(chat));

  const panel = readFileSync('src/views/chatPanel.ts', 'utf8');
  const secretTag = panel.indexOf('src="${secretScanScript}"');
  const chatTag = panel.indexOf('src="${script}"');
  check('chatPanel.ts 注入了 secret-scan.js', secretTag > 0 && secretScanApi);
  check('secret-scan.js 必须在 chat.js 之前注入', secretTag > 0 && chatTag > secretTag);
}

// ⑥ 文案齐全：每一种凭据类型都要有可读名字，否则会显示成 chat.secretKind.xxx。
{
  const i18n = readFileSync('src/core/i18n.ts', 'utf8');
  const missing = secretScanApi
    .kinds()
    .filter((kind) => !i18n.includes(`'chat.secretKind.${kind}'`));
  check(`每种凭据类型都有中文名（缺 ${missing.join(',') || '无'}）`, missing.length === 0);
  check('提醒标题有文案', i18n.includes("'chat.secretWarnTitle'"));
  check('吊销建议有文案', i18n.includes("'chat.secretWarnBody'"));
}

// ⑦ 个人隐私：身份证号 / 银行卡号 / 手机号同样触发危险提醒，且不回显号码。
{
  const idNumber = '110101199003071233';
  const cardNumber = '6222021234567894';

  const idNode = secretWarningNode(`我的身份证号是 ${idNumber}`);
  check('命中身份证号 → 生成提醒节点', idNode && idNode.className === 'message-callout');
  check('命中身份证号 → 必须是 danger 级别', idNode.dataset.tone === 'danger');
  const idText = collectText(idNode);
  check('命中身份证号 → 标题走隐私文案', idText.includes('个人隐私信息'));
  check('命中身份证号 → 点名是哪一类隐私', idText.includes('身份证号'));
  check('命中身份证号 → 给出去号码无法吊销的说明', idText.includes('吊销') || idText.includes('永久'));
  check('绝不回显身份证号原文', !idText.includes(idNumber));

  const cardNode = secretWarningNode(`银行卡 ${cardNumber}`);
  const cardText = collectText(cardNode);
  check('命中银行卡号 → 生成危险提醒', cardNode.dataset.tone === 'danger');
  check('命中银行卡号 → 点名银行卡号', cardText.includes('银行卡号'));
  check('绝不回显银行卡号原文', !cardText.includes(cardNumber));

  const phoneNode = secretWarningNode('手机号 13800138000');
  check('命中手机号 → 生成危险提醒', phoneNode && phoneNode.dataset.tone === 'danger');
  check('绝不回显手机号原文', !collectText(phoneNode).includes('13800138000'));

  // 两类同时出现：标题要说明两类都有，且两段处置建议都要给出。
  // 用拼接出来的假密钥，避免源码里放一个形态真实、又会被各种工具遮掉的字符串。
  const fakeKey = ['sk', 'proj', 'AbCdEfGhIjKlMnOpQrStUv'].join('-');
  const mixed = secretWarningNode(`key ${fakeKey} [REDACTED_KEY] 身份证 ${idNumber}`);
  const mixedText = collectText(mixed);
  check('凭据 + 隐私 → 标题说明两类都有', mixedText.includes('明文凭据与个人隐私'));
  check('凭据 + 隐私 → 两段建议都在', mixedText.includes('吊销') && mixedText.includes('永久'));

  // 误报防线：这几种最常见，任何一条触发都会让红色警告变成噪音。
  for (const [label, text] of [
    ['时间戳', '时间戳 1759837200000'],
    ['版本号', '把 sdk 从 4.12.0 升到 4.13.2'],
    ['校验位错误的身份证', '身份证 110101199003071235'],
    ['打码手机号', '手机号 138****8000'],
  ]) {
    check(`不误报：${label}`, secretWarningNode(text) === null);
  }
}

console.log('');
if (failures === 0) {
  console.log(`全部通过（${checks} 项）`);
} else {
  console.log(`失败 ${failures} / ${checks} 项`);
  process.exitCode = 1;
}
