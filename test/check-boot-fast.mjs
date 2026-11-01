// 启动速度的回归守门人。
//
// 现场（用户反馈）：「hwchat 0.3.1 版本安装后一直在启动中，过了一分钟才加载好」。
//
// 根因是 `activate()` 里 `await skills.refresh()` —— 而一次扫描在旧实现里是**三条**
// `findFiles`，每条都是一次真实的全工作区遍历。本机实测（21 个目录 / 64GB 多根工作区）：
//   · 本项目真实工作区（~/AI projects）：refresh() 全量扫描 **6754 ms**
//   · hydrate()（读两个本地技能目录 + 上次扫描存下的路径）：首次 **17 ms**，有缓存 **4 ms**
//   · 合并三条 pattern 为一个花括号 glob 后，遍历次数 3 → 1（实测 3.2s × 3 → 3.35s）
// 而 VS Code 会等 activate() 返回才去解析该扩展的视图，所以这段等待直接表现为
// 「面板一直在转」。
//
// 现在的不变量（本脚本逐条检查）：
//   1. `activate()` 只水合，不 await 全量扫描；
//   2. 后台扫描必须真的发起（`void ...refresh()`），否则新建的工作区技能永远看不到；
//   3. 面板打开 / 新建对话 / 发送消息 三条交互路径都不 await 全量扫描；
//   4. 一次扫描只发**一次**工作区遍历（三条 pattern 合并成一个 glob）；
//   5. 水合不更新 `hasScanned`（水合不是可信扫描，后台扫描必须照样跑）。
//
// 运行：node test/check-boot-fast.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const EXT = readFileSync('src/extension.ts', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const REGISTRY = readFileSync('src/agent/skillRegistry.ts', 'utf8');

/** 去注释，避免注释里的示例写法骗过断言。 */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 取一个函数/方法体（锚定行首缩进，避免匹配到调用点）。 */
function body(source, name, indent = '  ') {
  const index = source.search(new RegExp(`\\n${indent}(?:private |public |export )?(?:async )?${name}\\s*\\(`));
  assert.ok(index >= 0, `找不到 ${name} 的定义`);
  // 方法签名可能跨多行（参数带注释），所以从签名之后**第一个行首缩进收尾括号**算结束。
  const end = source.indexOf(`\n${indent}}`, index);
  assert.ok(end > index, `${name} 的函数体没有正常结束`);
  return source.slice(index, end);
}

/** 取类方法的**完整**源码（含返回类型注解尾部），用于数调用次数。 */
function methodSource(source, name) {
  const index = source.search(new RegExp(`\\n  (?:private |public )?(?:async )?${name}\\s*\\(`));
  assert.ok(index >= 0, `找不到 ${name} 的方法定义`);
  const next = source.indexOf('\n  private ', index + 1);
  const nextPublic = source.indexOf('\n  async ', index + 1);
  const candidates = [next, nextPublic].filter((value) => value > index);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(index, end);
}

/**
 * 取一个**顶层**函数的函数体。
 *
 * 不能按大括号配平：函数体里到处是模板字符串与 `${...}`，靠数括号会被字符串里的
 * `}` 带跑（实测会把后面十几个命令注册函数一起吃进来，然后误报「activate 里 await 了
 * 全量扫描」）。顶层函数以行首 `}` 收尾，按行找最稳。
 */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到 ${signature}`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `${signature} 没有以行首 } 收尾`);
  return source.slice(start, end + 2);
}

/* 1. activate() 只水合 */
/**
 * 命令注册也在 `activate()` 里，所以要先把「用户主动点重新扫描」那段摘掉。
 *
 * `hwchat.rescanSkills` 是用户明确要求扫一遍，它 await 全量扫描完全正当 ——
 * 把它算进来会让断言误报，然后有人为了「让测试过」而删掉正确的代码。
 */
function withoutRescanCommand(source) {
  const start = source.indexOf("['hwchat.rescanSkills'");
  assert.ok(start >= 0, '找不到 hwchat.rescanSkills 的注册（命令改名了？同步更新本检查）');
  const end = source.indexOf('}],', start);
  assert.ok(end > start, 'hwchat.rescanSkills 的处理器没有正常结束');
  return source.slice(0, start) + source.slice(end + 3);
}

const activate = withoutRescanCommand(functionBody(EXT, 'export async function activate('));
assert.doesNotMatch(code(activate), /await\s+skills\.refresh\(/, 'activate() 不许 await 全量扫描：那会把视图一直挡在「启动中」');
assert.match(code(activate), /await skills\.hydrate\(/, 'activate() 必须先水合，否则首屏技能列表是空的');

/* 2. 后台扫描必须发起 */
assert.match(
  code(activate),
  /void skills\.refresh\(\)/,
  'activate() 必须在后台发起真实扫描，否则新建的工作区技能永远看不到',
);
// 订阅在 ChatPanel 侧：扫描结束要让面板重推一次状态，否则用户得手动重开面板。
assert.match(
  code(PANEL),
  /skills\.onDidChangeSkills\.event\(/,
  'ChatPanel 必须订阅 onDidChangeSkills：后台扫描结束后面板才能补上新增/删除的技能',
);

/* 3. 三条交互路径 */
const open = body(PANEL, 'open');
assert.doesNotMatch(code(open), /await this\.skills\.refresh\(\)/, 'open() 不许 await 全量扫描：点「打开聊天」会卡住');
assert.match(code(open), /void this\.skills\.refresh\(\)/, 'open() 要在后台发起扫描');

const newChat = body(PANEL, 'newChat');
assert.doesNotMatch(code(newChat), /await this\.skills\.refresh\(\)/, 'newChat() 不许 await 全量扫描');
assert.match(code(newChat), /void this\.skills\.refresh\(\)/, 'newChat() 要在后台发起扫描');

const prepare = body(PANEL, 'prepareSkillsForSend');
assert.doesNotMatch(code(prepare), /await this\.skills\.refresh\(\)/, '发送路径不许 await 全量扫描');
assert.match(code(prepare), /void this\.skills\.refresh\(\)/, '发送路径要在后台发起扫描');

/* 4. 一次扫描只发一次遍历 */
assert.match(REGISTRY, /const WORKSPACE_SKILL_GLOB = '\{\*\*\/[^']+\}'/, '必须有一个合并后的花括号 glob 常量');
const scanWorkspace = methodSource(REGISTRY, 'scanWorkspaceSkills');
const traversals = (code(scanWorkspace).match(/searchWorkspace\(/g) ?? []).length;
assert.equal(traversals, 1, `scanWorkspaceSkills() 只许发一次工作区遍历，实际 ${traversals} 次`);
const scan = body(REGISTRY, 'scan');
assert.doesNotMatch(code(scan), /for \(const pattern of WORKSPACE_PATTERNS\)/, 'scan() 不许再按 pattern 逐条遍历');
assert.match(code(scan), /scanWorkspaceSkills\(\)/, 'scan() 要用合并后的单次遍历');
assert.match(code(scan), /writeWorkspaceCache\(/, 'scan() 扫完必须把 workspace 路径存盘，下次才能水合');

/* 5. 水合不可信：不更新 hasScanned */
const hydrate = body(REGISTRY, 'hydrate');
assert.doesNotMatch(code(hydrate), /lastRefreshAt\s*=/, 'hydrate() 不许更新 lastRefreshAt：它会让后台真实扫描被 TTL 挡掉');
assert.match(code(hydrate), /readWorkspaceCache\(\)/, 'hydrate() 要用上次扫描的缓存路径');
assert.match(code(hydrate), /localCandidates\(\)/, 'hydrate() 要读本地技能目录');
assert.match(REGISTRY, /get hasScanned\(\): boolean \{\s*\n\s*return Boolean\(this\.lastRefreshAt\);/, 'hasScanned 仍应由 lastRefreshAt 决定');

/* 6. 缓存写坏了不许影响结果 */
assert.match(
  code(methodSource(REGISTRY, 'writeWorkspaceCache')),
  /catch \{/,
  'writeWorkspaceCache() 必须吞掉写入失败：写不进去只意味着下次还要再遍历',
);
assert.match(
  code(methodSource(REGISTRY, 'readWorkspaceCache')),
  /catch \{/,
  'readWorkspaceCache() 必须吞掉读取失败：没有缓存只是这次水合少几项',
);

console.log('✓ activate() 只水合（17ms），不 await 全量扫描（6754ms）');
console.log('✓ 后台真实扫描必须发起，并通过 onDidChangeSkills 通知面板');
console.log('✓ 打开面板 / 新建对话 / 发送消息 三条路径都不 await 全量扫描');
console.log('✓ 一次扫描只发一次工作区遍历（三条 pattern 已合并）');
console.log('✓ 水合不更新 hasScanned，缓存读写失败都不影响结果');
console.log('\n全部通过：启动不再等全工作区扫描');
