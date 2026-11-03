// git 访问规则的守门人。
//
// 用户原话（2026-11-03）：「hwchat是不是会拦截拉去克隆仓库到本地，现在即使弹窗
// 点击确认了，还是运行拉取失败」→「请放开git权限，不要影响git正常功能」。
//
// 实测出来的三个真问题：
//   ① `hasGitWriteIntent('克隆仓库到本地')` = false —— 授权词表里只有英文 `clone`，
//      没有中文「克隆」。于是 `git clone` 被「本次对话没有要求 git 写操作」拒绝。
//   ② 那道闸门在**确认卡片之后**才执行。用户点了「允许」，闸门仍按关键词否决 ——
//      人的明确授权被字符串匹配覆盖，这就是「点了确认还是失败」。
//   ③ `clone` / `init` 还要过「上一级没有 git 仓库」「项目根没绑定」两道检查，
//      而「创建一个新仓库」本身就还没有仓库，逻辑自相矛盾。
//
// 运行：node test/check-git-access.mjs
import { readFileSync } from 'node:fs';

const EXECUTOR = readFileSync('src/agent/toolExecutor.ts', 'utf8');
const SCOPE = readFileSync('src/agent/conversationScope.ts', 'utf8');
const GATE_TESTS = readFileSync('src/test/gitGate.test.ts', 'utf8');
const SCOPE_TESTS = readFileSync('src/test/conversationScope.test.ts', 'utf8');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* ── ① 用户点过确认 = 授权 ─────────────────────────────────────────────── */
check('execute() 记录了「这次调用用户点过确认」',
  /const userApproved = Boolean\(approvalRequest\);/.test(EXECUTOR),
  '没有这个信号，闸门就看不见用户刚点的按钮');
check('该信号被传进 run_command',
  /this\.runCommand\(args, settings, scope, metrics, userApproved\)/.test(EXECUTOR),
  'runCommand 拿不到 userApproved');
check('闸门接受并认可该信号',
  /userApproved = false,\s*\n\s*\): Promise<string \| undefined>/.test(EXECUTOR)
  && /if \(needsIntent && !scope\?\.gitWriteAllowed && !userApproved\)/.test(EXECUTOR),
  '确认过仍被关键词否决');

/* ── ② 不改变远端归属的操作不需要「用户开口」 ──────────────────────────── */
check('clone / init / fetch / pull 列入免授权集合',
  /export const GIT_VERBS_WITHOUT_INTENT: ReadonlySet<string> = new Set\(\['clone', 'init', 'fetch', 'pull'\]\)/.test(SCOPE),
  '「克隆仓库」这种正常需求不该要求用户背关键词');
check('会改写历史/推送的操作仍不在免授权集合里',
  !/'clone', 'init', 'fetch', 'pull'[^\]]*(?:commit|push|reset|clean|merge|rebase)/.test(SCOPE),
  'push / commit 这些必须仍然要求授权');
check('闸门用的是这个集合',
  /const needsIntent = !GIT_VERBS_WITHOUT_INTENT\.has\(verb\);/.test(EXECUTOR), '');
check('中文「克隆」「检出」进授权词表',
  /克隆\|检出/.test(SCOPE), '中文说法不被识别，等于没放开');

/* ── ③ clone / init 不做仓库归属检查 ──────────────────────────────────── */
check('clone / init 在仓库检查之前直接放行',
  /if \(verb === 'clone' \|\| verb === 'init'\) return undefined;/.test(EXECUTOR),
  '新仓库还没有仓库可查，这两道检查对它是死循环');
check('单根工作区不再要求先绑定项目',
  /if \(!explicitCwd && roots\.length > 1\) return tt\('tool\.gitProjectUnknown'\);/.test(EXECUTOR),
  '`.` 在单根工作区没有歧义，不该拦');

/* ── ④ 已有行为不能被放开破坏 ─────────────────────────────────────────── */
check('多根工作区的歧义保护仍在',
  /roots\.length > 1/.test(EXECUTOR) && /tool\.gitForeignProject/.test(EXECUTOR),
  '提交错项目的风险必须仍然挡住');
check('用户拒绝确认时仍然不执行',
  /if \(!approved\) \{\s*\n\s*const result = deniedResult\(tt\('tool\.deniedByUser'\)\);/.test(EXECUTOR), '');

/* ── ⑤ 必须有真实 git 仓库的端到端测试 ────────────────────────────────── */
for (const [label, pattern] of [
  ['clone 在 review 预设下真的落盘', /git clone：用户没开口、也没有确认卡片，照样能克隆/],
  ['init 不被「上一级没有仓库」拦住', /git init：在普通目录里初始化新仓库/],
  ['点确认后 commit 能通过', /git commit：用户点了确认就不再被/],
  ['拒绝确认后不产生提交', /git commit：用户拒绝确认时仍然不执行/],
  ['无人确认且未要求时仍拒绝', /git commit：自动执行（无人确认）且用户没要求时仍然拒绝/],
  ['push 仍未放行', /git push：用户没要求时仍然拒绝/],
  ['单根工作区免绑定', /单根工作区未绑定项目/],
  ['多根工作区仍拦', /多根工作区未绑定项目且没有显式 cwd/],
]) {
  check(`回归测试：${label}`, pattern.test(GATE_TESTS), '缺测试就等于没修');
}
check('授权词表的单测覆盖中文「克隆」',
  /克隆仓库到本地/.test(SCOPE_TESTS), '词表扩展没有测试钉住');

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
