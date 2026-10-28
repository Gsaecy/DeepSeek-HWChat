/*
 * 校验「任务清单不写推送 / 版本号」这条规则真的接上了两层。
 *
 * 回归的故障：清单里写了 `6. 提交并推送`，用户点「继续执行」就等于认可了这六条，
 * 于是用户没说过的「推送」借清单拿到了授权。规则要生效必须两层都在：
 *   第一层 提示词 —— 拆分任务时就不写进去；
 *   第二层 落库前过滤 —— 模型还是写了也要摘掉，否则一条漏网就够。
 *
 * 判定逻辑本身由 src/test/todoScope.test.ts（11 条）用真实代码跑过。
 * 这个脚本只管接线：任何一处被删掉，规则就会悄悄失效。
 *
 * 用法：node test/check-todo-scope.mjs
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
const SCOPE = readFileSync('src/agent/todoScope.ts', 'utf8');
const PROMPT = readFileSync('src/agent/todoPrompt.ts', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

/* ── 1. 过滤模块 ─────────────────────────────────────────── */

check('todoScope 导出 todoScopeReason', /export function todoScopeReason/.test(SCOPE));
check('todoScope 导出 splitTodoScope', /export function splitTodoScope/.test(SCOPE));
check(
  '版本一侧复用 releasePolicy 的解析器（不自己列工具名单）',
  /import \{[^}]*versionBumpCommand[^}]*\} from '\.\/releasePolicy'/.test(SCOPE),
);
// 单一口径：如果这里再列一份工具名，两套判定迟早分叉。
check('没有重复声明版本工具名单', !/DIRECT_VERSION_TOOLS|PACKAGE_MANAGERS/.test(SCOPE));
check(
  '推送判定要求带仓库目标，避免误摘「实现推送功能」',
  /远端\|远程\|origin\|github/.test(SCOPE),
);

/* ── 2. 落库前过滤的接线 ─────────────────────────────────── */

check('chatPanel 引入 splitTodoScope', /import \{[^}]*\bsplitTodoScope\b[^}]*\} from '\.\.\/agent\/todoScope'/.test(PANEL));
// 续跑时「整份换掉清单」的守卫：发现丢了已完成项就拒绝写库（见 agent/todoScope 的 droppedCompletedTodos）。
check('chatPanel 引入 droppedCompletedTodos', /import \{[^}]*\bdroppedCompletedTodos\b[^}]*\} from '\.\.\/agent\/todoScope'/.test(PANEL));
check('丢进度的替换在落库前被拦下', /const dropped = allowReplan \? \[\] : droppedCompletedTodos\(previous\?\.todos, todos\)/.test(PANEL));
check('被拦下时返回 error 且不写库', /status: 'error',\s*\n\s*summary: tt\('todo\.replacementBlockedSummary'/.test(PANEL));
check('重规划意图来自本轮用户文本', /hasTodoReplanIntent\(content\)/.test(PANEL));
// 关键写法：保留部分直接重命名为 todos，后面任何一处都不可能再拿到未过滤的清单。
check(
  '保留部分重新绑定为 todos，杜绝误用未过滤清单',
  /const \{ kept: todos, excluded \} = splitTodoScope\(submitted\)/.test(PANEL),
);
// 过滤后的清单才允许落库 / 推给面板。这里不钉具体字面量（写入口后来加上了
// 「全部完成就归档」的分支，存档里可能是 `null`），而是钉住两点：
// 1) 写存档、推面板用的都是过滤后的 `todos`，一个 `submitted` 都不许漏出来；
// 2) 过滤发生在这两处之前。
const filterAt = PANEL.indexOf('splitTodoScope(submitted)');
// 从过滤那行往后找：`send()` 里也有一次 `updateConversation(conversationId, {`，从文件头找会锚错位置。
const writeAt = PANEL.indexOf('await this.storage.updateConversation(conversationId, {', filterAt);
const writeBlock = writeAt < 0 ? '' : PANEL.slice(writeAt, PANEL.indexOf("type: 'todoArchives'", writeAt));
check(
  '过滤发生在写入存档之前',
  filterAt >= 0 && writeAt > filterAt,
);
check('存档写入用的是过滤后的 todos', /todos: keepList \? todos : null,/.test(writeBlock));
check('推给面板的也是过滤后的 todos', /todos: keepList \? todos : \[\],/.test(writeBlock));
check(
  '写入口里没有任何地方直接用未过滤的 submitted',
  writeBlock.length > 0 && !/\bsubmitted\b/.test(writeBlock),
  '存档 / 推送区块出现了 submitted',
);

/* ── 3. 整份都被摘掉时不覆盖旧清单 ───────────────────────── */

check('存在「整份都是推送 / 版本号」的分支', /if \(!todos\.length\)/.test(PANEL));
check(
  '该分支返回 success 而不是 error（不是工具调用错误）',
  /summary: tt\('todo\.scopeExcludedOnlySummary'/.test(PANEL),
);
// 这条最容易漏：写空清单会把正在跑的清单和进度一起清掉。
const onlyBranchStart = PANEL.indexOf("tt('todo.scopeExcludedOnlySummary'");
const onlyBranchEnd = PANEL.indexOf('const previous = await this.storage.getConversation(conversationId)', onlyBranchStart);
const onlyBranch = onlyBranchStart > 0 && onlyBranchEnd > onlyBranchStart ? PANEL.slice(onlyBranchStart, onlyBranchEnd) : '';
check('该分支不写存档、不推空清单', onlyBranch.length > 0 && !/updateConversation|type: 'todos'/.test(onlyBranch));

/* ── 4. 摘掉之后要回告模型「单独征询」 ───────────────────── */

check('摘要里体现被移出的条数', /tt\('todo\.scopeExcludedSummary'/.test(PANEL));
check('工具返回正文附带移出说明', /excludedNotice \? `\\n\\n\$\{excludedNotice\}`/.test(PANEL));

/* ── 5. 文案键 ───────────────────────────────────────────── */

for (const key of [
  'todo.scopeExcludedSummary',
  'todo.scopeExcludedNotice',
  'todo.scopeExcludedOnlySummary',
  'todo.scopeExcludedOnlyNotice',
]) {
  check(`i18n 存在 ${key}`, I18N.includes(`'${key}'`));
}
check(
  '文案明确要求「完成后再单独征询」',
  /工作完成并验证后，请单独用一句话征询用户确认/.test(I18N),
);

/* ── 6. 提示词规则 ───────────────────────────────────────── */

check('提示词禁止把推送 / 升版本写进清单', /Never put a git push/.test(PROMPT));
check('提示词要求在拆分时就排除（不是事后补）', /Exclude them when you break the work down/.test(PROMPT));
check('提示词要求完成后单独征询', /ask the user separately/.test(PROMPT));
check('提示词声明点继续 ≠ 批准清单每一项', /not that you may execute every line/.test(PROMPT));
check('提示词点明清单是计划而非用户批准记录', /not a record of what the user approved/.test(PROMPT));

console.log(`\n${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
