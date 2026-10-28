import assert from 'node:assert/strict';
import test from 'node:test';
import { hasGitWriteIntent } from '../agent/conversationScope';
import { hasVersionBumpIntent } from '../agent/releasePolicy';
import { TODO_LIST_PROMPT } from '../agent/todoPrompt';
import { splitTodoScope, todoScopeReason } from '../agent/todoScope';
import { messageEntry } from '../core/i18n';
import { renderTodoContext } from '../core/todos';
import { TodoItem } from '../core/types';

/**
 * 「任务清单里不写推送 / 版本号」这条规则的两层实现。
 *
 * 光有提示词不够：清单一旦显示在面板上，用户点「继续执行」就等于认可了它，
 * 于是用户没说过的「推送」借清单拿到了授权。所以还必须在清单落库前过滤。
 * 这里同时钉住两件事：
 * 1. 该摘的摘得掉（含各种真实说法）；
 * 2. 不该摘的绝不误伤（「实现消息推送」是正常功能任务）。
 */

function todo(content: string, status: TodoItem['status'] = 'pending'): TodoItem {
  return { content, status };
}

/* ── 1. 推送类条目 ───────────────────────────────────────── */

test('git 推送的各种写法都会被识别', () => {
  const cases = [
    'git push origin main',
    '提交并推送到远端',
    '推送代码到 origin',
    '把分支推送到远端仓库',
    'push the branch to origin',
    'git push --force',
  ];
  for (const content of cases) {
    assert.equal(todoScopeReason(content), 'push', `${content} 应判为推送`);
  }
});

test('「推送通知 / 消息推送」是正常功能任务，不能误摘', () => {
  const cases = [
    '实现消息推送功能',
    '推送通知的开关设置',
    '给用户推送提醒',
    '写一个 web push 的 service worker',
    '推送通知到用户设备',
  ];
  for (const content of cases) {
    assert.equal(todoScopeReason(content), undefined, `${content} 不应判为推送`);
  }
});

/* ── 2. 版本号类条目 ─────────────────────────────────────── */

test('版本号更新的各种写法都会被识别', () => {
  const cases = [
    '升级版本号到 0.2.4',
    '把版本号改成 0.2.4',
    'npm version patch',
    '升到 0.2.4',
    'bump the version to 0.2.4',
  ];
  for (const content of cases) {
    assert.equal(todoScopeReason(content), 'version', `${content} 应判为版本更新`);
  }
});

test('构建与文案改动不算版本更新', () => {
  const cases = [
    '更新文档',
    '重新打包为 0.2.3 版本',
    '修复版本号显示错误的 bug',
    '在 README 里写明支持的 Node 版本',
  ];
  for (const content of cases) {
    assert.equal(todoScopeReason(content), undefined, `${content} 不应判为版本更新`);
  }
});

/* ── 3. 拆分：顺序不变、只摘该摘的、已完成也摘 ───────────── */

test('拆分时保留顺序，只摘推送与版本条目', () => {
  const todos = [
    todo('读代码', 'completed'),
    todo('提交并推送到远端'),
    todo('改实现'),
    todo('升级版本号到 0.2.4'),
    todo('跑测试'),
  ];
  const { kept, excluded } = splitTodoScope(todos);
  assert.deepEqual(kept.map((item) => item.content), ['读代码', '改实现', '跑测试']);
  assert.deepEqual(excluded.map((entry) => entry.todo.content), ['提交并推送到远端', '升级版本号到 0.2.4']);
  assert.deepEqual(excluded.map((entry) => entry.reason), ['push', 'version']);
});

test('已完成的推送条目也要摘：规则是清单里不该出现，与进度无关', () => {
  const { kept, excluded } = splitTodoScope([todo('git push origin main', 'completed'), todo('改实现')]);
  assert.deepEqual(kept.map((item) => item.content), ['改实现']);
  assert.equal(excluded.length, 1);
});

test('整份清单都是推送 / 版本号时，保留部分为空（调用方据此不覆盖旧清单）', () => {
  const { kept, excluded } = splitTodoScope([todo('git push origin main'), todo('升到 0.2.4')]);
  assert.equal(kept.length, 0);
  assert.equal(excluded.length, 2);
});

/* ── 4. 提示词：两层规则都要写进去 ───────────────────────── */

test('提示词要求清单排除推送与版本号，并单独征询', () => {
  assert.match(TODO_LIST_PROMPT, /never put a git push/i);
  assert.match(TODO_LIST_PROMPT, /version bump into the task list/i);
  assert.match(TODO_LIST_PROMPT, /ask the user separately/i);
});

test('提示词声明「点击继续」不等于批准清单里的每一项', () => {
  assert.match(TODO_LIST_PROMPT, /Continue on an interrupted list/i);
  assert.match(TODO_LIST_PROMPT, /not that you may execute every line/i);
  assert.match(TODO_LIST_PROMPT, /a plan you wrote, not a record of what the user approved/i);
});

/* ── 5. 结构上的证明：点继续这条路径本身不授予推送 / 版本权限 ── */

test('「继续执行」发出的正文不构成推送或版本授权', () => {
  // 这是规则的运行时依据：授权判定只看用户文本，而按钮发出的是固定文案。
  // 所以「点继续」在结构上就不可能授权推送或升版本——不需要靠模型自觉。
  for (const language of ['zh', 'en'] as const) {
    const entry = messageEntry('todo.resumeInstruction');
    assert.ok(entry, 'todo.resumeInstruction 必须存在');
    const text = language === 'zh' ? entry.zh : entry.en;
    assert.equal(hasGitWriteIntent(text), false, `${language} 续跑文案不应授予 git 写操作`);
    assert.equal(hasVersionBumpIntent(text), false, `${language} 续跑文案不应授予版本升级`);
  }
});

test('用户自己要求推送时，授权判定仍按原文放行（规则只管清单，不拦真实请求）', () => {
  assert.equal(hasGitWriteIntent('提交并推送'), true);
  assert.equal(hasVersionBumpIntent('升级版本号到 0.2.4'), true);
});

/**
 * 「点了继续执行，清单卡在原地不动」。
 *
 * 根因：模型只收到一句「继续执行清单里未完成的条目」，却看不到清单本身 ——
 * `requestMessages()` 跳过所有 `role: 'tool'` 消息（`update_todos` 的返回值就在
 * 里面），清单又只存在对话摘要的 `todos` 字段里。这里锁住注入的产物：
 * 带状态的完整列表 + 明确的下一条，模型才能接着做。
 */
test('renderTodoContext：注入带状态的完整清单，并指出下一条', () => {
  const text = renderTodoContext([
    { content: '验证 tray-icon 特性与单实例插件可离线编译', status: 'completed' },
    { content: '实现单实例锁', status: 'completed' },
    { content: '跑完质量门禁', status: 'pending' },
    { content: '同步 README', status: 'in_progress' },
  ], { interrupted: true });

  assert.match(text, /<task_list>/, '要有明确边界，避免和正文混淆');
  assert.match(text, /1\. \[x\] 验证 tray-icon/, '已完成的要标 [x]，模型据此不重复');
  assert.match(text, /3\. \[ \] 跑完质量门禁/, '未开始的标 [ ]');
  assert.match(text, /4\. \[>\] 同步 README/, '进行中的标 [>]');
  assert.match(text, /2 of 4 item\(s\) are not finished/, '要给出未完成数量');
  assert.match(text, /Next item to work on: #3/, '要明确指出下一条（跳过已完成的）');
  assert.match(text, /interrupted/, '续跑时要说明这是被中断的清单');
  assert.match(text, /never an empty array/, '重申不能用空数组清空清单');
});

test('renderTodoContext：清单全完成或没有清单时不注入', () => {
  assert.equal(renderTodoContext([]), '');
  assert.equal(renderTodoContext(undefined), '');
  assert.equal(renderTodoContext([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
  ]), '', '全部完成时不再注入（该归档了）');
});

test('renderTodoContext：空内容条目被忽略，不会出现空行', () => {
  const text = renderTodoContext([
    { content: '   ', status: 'pending' },
    { content: '真正的一条', status: 'pending' },
  ]);
  assert.match(text, /1\. \[ \] 真正的一条/, '空白条目不该占号');
  assert.equal(text.includes('2. '), false);
});
