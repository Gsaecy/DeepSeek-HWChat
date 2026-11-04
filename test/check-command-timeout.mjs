/*
 * 「要求 900 秒、实际只给了 120 秒」的守护。
 *
 * 现场（用户 2026-11-04）：
 *
 *     {"command":"cd … && cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -40",
 *      "timeoutSeconds": 900}
 *     → 超时（120 秒）·（无输出）
 *
 * `run_command` 里 `Math.min(settings.maxCommandSeconds, requested)` 把 900 静默压成 120，
 * 结果只说「超时（120 秒）」：既没说是被上限截断的，也没说可以调大设置或换后台跑。
 * 模型只能再猜一次。
 *
 * 用法：node test/check-command-timeout.mjs
 */
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

const read = (path) => readFileSync(path, 'utf8');
const EXECUTOR = read('src/agent/toolExecutor.ts');
const I18N = read('src/core/i18n.ts');

/* ── 1. 接线 ─────────────────────────────────────────────────────── */
check(
  'runCommand 用 effectiveTimeoutSeconds 算出「请求值 / 生效值」',
  /const timeoutPlan = effectiveTimeoutSeconds\(/.test(EXECUTOR) && /const timeout = timeoutPlan\.effective/.test(EXECUTOR),
  '仍然直接 Math.min 就等于继续静默截断',
);
check(
  '超时时把「被截断」写进摘要（用户一眼能看到）',
  /result\.timedOut \? timeoutClampSummary\(timeoutPlan, tt\) : ''/.test(EXECUTOR),
);
check(
  '超时时把「原因 + 下一步」写进结果内容',
  /result\.timedOut[\s\S]{0,200}timeoutClampNotice\(/.test(EXECUTOR)
    && /result\.timedOut[\s\S]{0,400}timeoutAdvice\(/.test(EXECUTOR),
);
check(
  '超时一定算 error（即使退出码碰巧是 0）',
  /result\.code === 0 && !result\.timedOut \? 'success' : 'error'/.test(EXECUTOR),
);
check(
  '设置名与上限集中定义，避免和 package.json 漂移',
  /COMMAND_TIMEOUT_SETTING = 'hwchat\.maxCommandSeconds'/.test(EXECUTOR)
    && /COMMAND_TIMEOUT_MAX = 900/.test(EXECUTOR),
);

/* ── 2. 文案：三件事必须说清 ─────────────────────────────────────── */
for (const key of [
  'tool.runCommand.timeoutClamped',
  'tool.runCommand.timeoutClampedShort',
  'tool.runCommand.timeoutAdvice',
]) {
  const line = I18N.split('\n').find((row) => row.includes(`'${key}'`)) ?? '';
  check(`文案 ${key} 中英都有`, /\bzh:/.test(line) && /\ben:/.test(line), line.slice(0, 100));
}
const adviceLine = I18N.split('\n').find((row) => row.includes("'tool.runCommand.timeoutAdvice'")) ?? '';
check('建议里点名 `| tail` 会缓冲输出（用户那次「无输出」的真身）', /\| tail/.test(adviceLine));
check('建议里给出后台跑 + 轮询日志的具体写法', /background/.test(adviceLine) && /tail -n/.test(adviceLine));
check('建议里说明「重试无用」（上限没变）', /重试一定同样超时/.test(adviceLine));
check('示例 JSON 是单层大括号（`{{` 会原样显示给模型）', !adviceLine.includes('{{"command"'));

/* ── 2.5 「cd 到自己所在目录」：能去掉就执行，去不掉就说明 ──────────── */
const HINTS = read('src/agent/commandHints.ts');
check('runCommand 会用去掉多余 cd 之后的命令执行', /const effectiveCommand = strippedCd\.command;/.test(EXECUTOR));
check('去掉什么会写进结果（不偷偷改命令）', /tool\.runCommand\.cdStripped/.test(EXECUTOR) && /tool\.runCommand\.cdStripped/.test(I18N));
check('三条判据都在（单参数 + 目标不存在 + 末段等于 cwd 名）',
  /if \(exists\(resolve\(cwd, target\)\)\) return \{ command \};/.test(HINTS)
  && /last !== basename\(resolve\(cwd\)\)/.test(HINTS),
  '少一条就会把真正存在的同名子目录也去掉');

/* ── 3. 纯函数真的按这个语义算 ───────────────────────────────────── */
buildSync({
  entryPoints: ['src/agent/commandTimeout.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/check/commandTimeout.cjs',
  logLevel: 'silent',
});
const { createRequire } = await import('node:module');
const { resolve } = await import('node:path');
const require = createRequire(import.meta.url);
const { effectiveTimeoutSeconds } = require(resolve('out/check/commandTimeout.cjs'));

const real = effectiveTimeoutSeconds(900, 120);
check('要求 900 / 上限 120 → 生效 120 且标记截断', real.effective === 120 && real.clamped === true, JSON.stringify(real));
const none = effectiveTimeoutSeconds(undefined, 120);
check('没传 timeoutSeconds → 不产生「截断」噪声', none.clamped === false && none.effective === 120, JSON.stringify(none));
const raised = effectiveTimeoutSeconds(900, 900);
check('用户把上限调到 900 后，请求 900 完全生效', raised.effective === 900 && raised.clamped === false, JSON.stringify(raised));

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('「命令超时」这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('超时会说清「被上限截断」并给出可执行的下一步，不再让模型瞎猜。');
}
