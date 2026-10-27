import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { NOTICE_PROMPT } from '../agent/noticePrompt';

/** 解析结果。tone 只可能是 danger / important 两种。 */
interface CalloutPlan {
  tone: 'danger' | 'important';
  title: string;
  body: string;
}

/** media/callout-meta.js 暴露的接口。 */
interface CalloutMeta {
  TONES: string[];
  markers: () => string[];
  toneFor: (marker: unknown) => string;
  parseCallout: (lines: unknown) => CalloutPlan | null;
}

/**
 * 在 Node 里跑 webview 的纯函数脚本（和 todo-panel-state 的做法一致）。
 *
 * 这里测的是「哪些内容算提醒」这条判断本身：它决定了红色标题会不会出现在
 * 一段普通说明上，所以必须逐条锁住，而不是靠人去看渲染结果。
 */
function loadCalloutMeta(): CalloutMeta {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/callout-meta.js', 'utf8'), sandbox);
  const api = sandbox.HWChatCalloutMeta as CalloutMeta | undefined;
  assert.ok(api, 'media/callout-meta.js 必须挂载 HWChatCalloutMeta');
  return api;
}

test('危险标记：DANGER 与 WARNING 同级，标题与正文被拆开', () => {
  const api = loadCalloutMeta();
  for (const marker of ['DANGER', 'WARNING']) {
    const plan = api.parseCallout([`[!${marker}] 会删掉数据`, '', '具体说明第一行', '第二行']);
    assert.ok(plan, `${marker} 必须被识别`);
    assert.equal(plan.tone, 'danger');
    assert.equal(plan.title, '会删掉数据');
    // 标记后那个空的 `>` 行属于分隔，不能留在正文开头顶出一段空白。
    assert.equal(plan.body, '具体说明第一行\n第二行');
  }
});

test('重要标记：只认 IMPORTANT，标题原样保留', () => {
  const api = loadCalloutMeta();
  const plan = api.parseCallout(['[!IMPORTANT] 先备份数据库', '备份完成后再继续。']);
  assert.ok(plan);
  assert.equal(plan.tone, 'important');
  assert.equal(plan.title, '先备份数据库');
  assert.equal(plan.body, '备份完成后再继续。');
});

test('没登记的标记返回 null：普通引用与 [!NOTE] 的外观必须完全不变', () => {
  const api = loadCalloutMeta();
  // 这是「其他的显示不变」这条要求的核心：只要不是这两个级别，就交回普通引用块。
  assert.equal(api.parseCallout(['[!NOTE] 随便一提', '正文']), null);
  assert.equal(api.parseCallout(['[!TIP] 小技巧']), null);
  assert.equal(api.parseCallout(['[!UNKNOWN] 什么也不是']), null);
  assert.equal(api.parseCallout(['就是一段普通引用']), null);
});

test('只有标记也要能渲染：标题为空、正文为空，不抛错', () => {
  const api = loadCalloutMeta();
  const plan = api.parseCallout(['[!DANGER]']);
  assert.ok(plan);
  assert.equal(plan.tone, 'danger');
  assert.equal(plan.title, '');
  assert.equal(plan.body, '');
});

test('大小写与行首空格都容忍：模型偶尔会写 [!danger] 或缩进', () => {
  const api = loadCalloutMeta();
  const plan = api.parseCallout(['   [!danger]   删库   ']);
  assert.ok(plan);
  assert.equal(plan.tone, 'danger');
  // 标题两端的空白要去掉，否则红色标题会凭空缩进一截。
  assert.equal(plan.title, '删库');
});

test('空输入不抛错：引用块收尾时可能拿到空数组', () => {
  const api = loadCalloutMeta();
  assert.equal(api.parseCallout([]), null);
  assert.equal(api.parseCallout(['', '   ']), null);
  assert.equal(api.parseCallout(null), null);
});

test('toneFor 是一张显式真值表，未知标记返回空字符串', () => {
  const api = loadCalloutMeta();
  assert.equal(api.toneFor('DANGER'), 'danger');
  assert.equal(api.toneFor('[!WARNING]'), 'danger');
  assert.equal(api.toneFor('important'), 'important');
  assert.equal(api.toneFor('NOTE'), '');
  assert.equal(api.toneFor(undefined), '');
  // WARNING 是 DANGER 的别名：模型两种写法都常见，容忍它不会让显示分叉。
  assert.equal(api.toneFor('WARNING'), 'danger');
  // 分级只有两种，渲染层按这个集合配色。
  // 跨 vm 边界的数组不能直接 deepEqual（原型不同域），拼成字符串比较。
  assert.equal(api.TONES.slice().sort().join(','), 'danger,important');
});

test('提示词教出去的每一个标记都必须真的被识别', () => {
  const api = loadCalloutMeta();
  // 方向很重要：允许「解析器多认几个别名」，但绝不允许「提示词教了一个渲染不出来的标记」——
  // 后者会让 `[!XXX]` 原样显示成正文，用户看到一堆方括号。
  // noUncheckedIndexedAccess 下 match[1] 可能是 undefined，兜一个空串即可：
  // 真拿不到分组时后面的断言会直接失败，不需要在这里报错。
  const taught = [...NOTICE_PROMPT.matchAll(/\[!([A-Za-z]+)\]/g)].map((match) => (match[1] || '').toUpperCase());
  assert.ok(taught.length >= 2, '提示词至少要教两种标记');
  assert.ok(taught.includes('DANGER'), '提示词必须教 [!DANGER]');
  assert.ok(taught.includes('IMPORTANT'), '提示词必须教 [!IMPORTANT]');
  for (const marker of taught) {
    assert.ok(api.toneFor(marker), `提示词里的 ${marker} 必须被解析器识别`);
    assert.ok(api.parseCallout([`[!${marker}] 标题`]), `解析器必须识别 [!${marker}]`);
  }
});

test('解析器不认识的标记不许出现在提示词里', () => {
  const api = loadCalloutMeta();
  // 提示词里点名了 NOTE / TIP 之类的近似写法会把模型引向不会被识别的位置；
  // 这里反向确认提示词只教这两种。
  for (const candidate of ['NOTE', 'TIP', 'CAUTION']) {
    assert.equal(api.toneFor(candidate), '');
    assert.ok(!NOTICE_PROMPT.includes(`[!${candidate}]`), `提示词不该出现 ${candidate}`);
  }
});

/**
 * 下面几条钉住「什么算危险」的判定口径（用户 2026-10 定义）。
 * 这些词元不是文案洁癖：任何一个丢失，模型的分级就会漂回「大一点的操作都标红」。
 */
test('危险的判定必须覆盖项目、磁盘与系统三类破坏', () => {
  const text = NOTICE_PROMPT.toLowerCase();
  // 项目：删源码 / 未提交改动 / 历史，且无法恢复。
  assert.ok(text.includes('project'), '必须点到「项目」');
  assert.ok(text.includes('uncommitted'), '必须点到「未提交的改动」');
  assert.ok(text.includes('history'), '必须点到「历史记录」');
  // 磁盘：格式化 / 分区 / 裸写设备。
  assert.ok(text.includes('disk'), '必须点到「磁盘」');
  assert.ok(text.includes('formatting'), '必须点到「格式化」');
  assert.ok(text.includes('repartitioning'), '必须点到「重新分区」');
  assert.ok(text.includes('raw bytes'), '必须点到「裸写设备」');
  // 系统：shell / 终端配置被破坏。
  assert.ok(text.includes('system'), '必须点到「系统」');
  assert.ok(text.includes('sudoers'), '必须点到破坏提权配置');
  assert.ok(text.includes('path'), '必须点到破坏 PATH');
});

test('危险的判定必须覆盖凭据外泄及其后果', () => {
  const text = NOTICE_PROMPT.toLowerCase();
  for (const secret of ['password', 'private key', 'api key', 'token', 'certificate', '.env']) {
    assert.ok(text.includes(secret), `必须点到会泄露的凭据：${secret}`);
  }
  // 后果口径：别人拿到后能读项目、控制项目、进入机器。
  assert.ok(text.includes('take control'), '必须说明「失去项目控制权」这一后果');
  assert.ok(text.includes('get into the machine'), '必须说明「被入侵」这一后果');
});

test('对话里已经出现明文凭据时，必须要求立即吊销且不许复述密钥', () => {
  const text = NOTICE_PROMPT.toLowerCase();
  // 场景是「已经发生」，处理方式与「即将发生」不同：要吊销轮换，不是提醒小心。
  assert.ok(text.includes('already appears in plain text'), '必须覆盖「对话里已经出现凭据」这一情形');
  assert.ok(text.includes('revoke and rotate'), '必须要求吊销并轮换，而不是只提醒注意');
  assert.ok(text.includes('never repeat the value back'), '必须禁止复述密钥原文');
  // 复述就等于是二次泄漏，这里明确要求改为说类型与长度。
  assert.ok(text.includes('how many characters'), '必须改为说明长度而不是原文');
});

test('必须给出一条可自检的反向排除，避免滥用红色', () => {
  const text = NOTICE_PROMPT.toLowerCase();
  // 关键限定：能不能把工作和机器「原样拿回来」。可恢复的一律不算危险。
  assert.ok(text.includes('untouched'), '必须有「能否原样恢复」这一判据');
  assert.ok(text.includes('not [!danger]'), '必须明确写出「可恢复 ⇒ 不是 DANGER」');
  // 明确点名这些常见情形属于普通正文，防止临时文件被标红。
  assert.ok(text.includes('temporary'), '必须排除临时文件');
  assert.ok(text.includes('reversible'), '必须排除可逆改动');
});

test('IMPORTANT 必须被限定为「不会造成上述损失」', () => {
  const text = NOTICE_PROMPT.toLowerCase();
  assert.ok(
    text.includes('cannot cause any of that harm'),
    'IMPORTANT 必须显式排除上面的三类损失，否则会退化成「重要 ⇒ 标红」',
  );
});
