/*
 * 校验「通用续跑只绑定暂停清单、且只生效一次」这条链路真的接上了。
 *
 * 回归的故障：用户点「继续执行」后，任务队列的根标题取的是那句通用文案
 * 「继续执行当前任务清单里尚未完成的条目…」。它没有交付物，于是后面任何新需求
 * 拿去跟它比较都像「同一个目标」，被判成 related —— 任务树里把不相干的任务标成「已合并」。
 *
 * 判定逻辑本身由 src/test/resumeScope.test.ts（11 条）+ src/test/taskQueue.test.ts（4 条）
 * 用真实代码跑过。这个脚本只管接线：任何一处被删掉，规则就会悄悄失效。
 *
 * 用法：node test/check-resume-scope.mjs
 */
import { readFileSync } from 'node:fs';

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

const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const QUEUE = readFileSync('src/agent/taskQueue.ts', 'utf8');
const ROUTER = readFileSync('src/agent/taskRouter.ts', 'utf8');
const SCOPE = readFileSync('src/agent/resumeScope.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

/* ── 1. 模块本身 ─────────────────────────────────────────── */

check('resumeScope 导出 isGenericResume', /export function isGenericResume/.test(SCOPE));
check('resumeScope 导出 resumeScopeTitle', /export function resumeScopeTitle/.test(SCOPE));
check('resumeScope 导出 resolveResumeScope', /export function resolveResumeScope/.test(SCOPE));
const guardIndex = SCOPE.indexOf('if (CONCRETE_ANCHOR.test(value)) return false');
const listIndex = SCOPE.indexOf('LIST_REFERENCE.test(value) || isBareContinuation(value)');
check(
  '先排除具体锚点（路径 / 代码片段 / 扩展名），再看清单指向',
  guardIndex > 0 && listIndex > guardIndex,
);
check(
  '作用域只取未完成条目',
  /filter\(\(todo\) => todo\.status !== 'completed'\)/.test(SCOPE),
);
check(
  '没有未完成条目时不绑定',
  /if \(!pending\.length\) return undefined/.test(SCOPE),
);

/* ── 2. 发送侧接线 ───────────────────────────────────────── */

check('chatPanel 导入 resolveResumeScope', /import \{ resolveResumeScope \} from '\.\.\/agent\/resumeScope'/.test(PANEL));
check('send() 接受 SendOptions', /options\?: SendOptions,/.test(PANEL));
check('SendOptions 带 resumedTodos', /interface SendOptions \{[^}]*resumedTodos\?: boolean;/.test(PANEL));
check(
  '续跑时用清单作用域取代原文当任务标题',
  /const resumeScope = resolveResumeScope\(\{[\s\S]{0,300}\}\);\s*const fallbackTaskTitle[\s\S]{0,300}new AgentTaskQueue\(resumeScope \?\? fallbackTaskTitle/.test(PANEL),
);
check(
  '显式续跑标记参与判定',
  /explicitResume: options\?\.resumedTodos === true/.test(PANEL),
);
check(
  '「继续执行」按钮显式传标记（不靠文本猜测）',
  /tt\('todo\.resumeInstruction'\)[\s\S]{0,200}resumedTodos: true/.test(PANEL),
);
check(
  '续跑根节点标记传给队列',
  /new AgentTaskQueue\(resumeScope \?\? fallbackTaskTitle, \{ resumeScope: resumeScope !== undefined \}\)/.test(PANEL),
);
check(
  '分类回调把续跑标记透传下去',
  /\(currentTask, incomingTask, resumeScope\) => classifyTaskRelation\([\s\S]{0,200}resumeScope\)/.test(PANEL),
);
check(
  '旧的单参构造已不存在（否则会绕过续跑绑定）',
  !/new AgentTaskQueue\(content \|\|/.test(PANEL),
);

/* ── 3. 队列侧：一次性语义 ───────────────────────────────── */

check('队列记住续跑根节点 id', /private readonly resumeNodeId: string \| undefined;/.test(QUEUE));
check(
  '只有根节点被标记为续跑',
  /this\.resumeNodeId = options\.resumeScope === true \? rootId : undefined;/.test(QUEUE),
);
check(
  '分类时按当前节点判定，换到排队分支即失效',
  /classify\(this\.currentTitle\(\), title, this\.currentNodeId === this\.resumeNodeId\)/.test(QUEUE),
);

/* ── 4. 分类器加固 ───────────────────────────────────────── */

check(
  'classifyTaskRelation 接受续跑标记',
  /signal: AbortSignal,\s*resumeScope = false,/.test(ROUTER),
);
check(
  '续跑作用域明确不吸收不同交付物',
  /CURRENT TASK is a resumed work list/.test(ROUTER),
);
check(
  '默认（非续跑）不追加该规则',
  /\.\.\.\(resumeScope\s*\? \[/.test(ROUTER),
);

/* ── 5. 官方文案仍然存在 ─────────────────────────────────── */

check('i18n 仍有中文续跑文案', /todo\.resumeInstruction[\s\S]{0,200}zh: '继续执行/.test(I18N));
check('i18n 仍有英文续跑文案', /todo\.resumeInstruction[\s\S]{0,400}en: 'Continue the unfinished/.test(I18N));

console.log(`\n${checks - failures}/${checks} 通过`);
process.exit(failures ? 1 : 0);
