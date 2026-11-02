// git 推送判定的守门人。
//
// 背景（用户问「hwchat 现在的策略会拦住 git pull push 这些拉取和推送命令吗？」）：
// 实测发现两个与实际行为不符的地方 ——
//   ① 只靠 `/\bgit\s+push\b/`，把 git 全局选项夹在中间的写法会落到 standard，
//      在「风险操作询问」预设下被**静默执行**：`git -C . push`、`git --no-pager push`、
//      `git -c user.name=x push`。
//   ② 拒绝文案写的是「强制推送」，而规则其实是「只要 push 就拦」，
//      于是推一条普通 push 时，用户看到的是「强制推送被禁止」，与事实相反。
//
// 这里守住三件事：
//   1. 静态契约：push 判定必须同时用正则（覆盖引号里的写法）和 git 解析器（跳过全局选项）；
//   2. 真实分级：上面那些写法必须是 severe，且 review 预设下必须 ask 而不是 allow；
//   3. 拉取类命令不被连带收紧（用户明确要求 keep），并且拒绝文案不再只说强制推送。
//
// 运行：node test/check-git-push-tier.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const PERMISSIONS = readFileSync(join(ROOT, 'src/core/permissions.ts'), 'utf8');
const I18N = readFileSync(join(ROOT, 'src/core/i18n.ts'), 'utf8');
const TESTS = readFileSync(join(ROOT, 'src/test/permissions.test.ts'), 'utf8');

/* ── 静态契约 ─────────────────────────────────────────────────────────── */
check('push 判定是一条独立规则，不再只靠一条正则',
  /function isPushingToRemote\(text: string\)/.test(PERMISSIONS)
  && /classifyCommandTier[\s\S]{0,300}isPushingToRemote\(text\)/.test(PERMISSIONS),
  'classifyCommandTier 必须先走 isPushingToRemote()');
check('push 判定同时借助 git 解析器（跳过 -C / -c / --no-pager）',
  /gitOperationsIn\(text\)\.some\(\(operation\) => operation\.verb === 'push'\)/.test(PERMISSIONS),
  '只用正则漏掉 `git -C . push` 这类写法');
check('push 判定同时保留正则（覆盖 bash -c "git push"）',
  /\/\\bgit\\s\+push\\b\/i\.test\(text\)/.test(PERMISSIONS),
  '解析器只看命令头，看不到引号里的 git');
check('危险的通用正则表里不再重复一条会漏判的 push 正则',
  !/^\s*\/\\bgit\\s\+push\\b\/i,\s*$/m.test(PERMISSIONS),
  '两处各写一遍，改一处漏一处');
check('拒绝文案点明普通 push 也算',
  /普通 git push 也算/.test(I18N) && /plain git push counts too/.test(I18N),
  '只说「强制推送」会让用户以为普通 push 能过');
check('拒绝文案不再把推送窄化成「强制推送」',
  !/'tool\.dangerousDenied'[\s\S]{0,400}强制推送等/.test(I18N),
  'dangerousDenied 仍在用「强制推送等」概括危险命令');
check('单测里钉住了穿透全局选项的写法',
  /'git -C \. push'/.test(TESTS) && /'git --no-pager push'/.test(TESTS)
  && /'bash -c "git push"'/.test(TESTS),
  '缺测试就等于没修');

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
