import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isGenericResume, resolveResumeScope, resumeScopeTitle } from '../agent/resumeScope';
import { TodoItem } from '../core/types';

const I18N = readFileSync('src/core/i18n.ts', 'utf8');

/** 直接取官方续跑文案，避免测试里抄一份、以后和 i18n 漂移。 */
function resumeInstruction(locale: 'zh' | 'en'): string {
  const prefix = locale === 'zh' ? '继续执行' : 'Continue the unfinished';
  const match = new RegExp(`${locale}: '(${prefix}[^']*)'`).exec(I18N);
  assert.ok(match, `i18n 里必须仍有 todo.resumeInstruction 的 ${locale} 文案`);
  return match[1]!;
}

const todos = (...statuses: TodoItem['status'][]): TodoItem[] =>
  statuses.map((status, index) => ({ content: `步骤 ${index + 1}`, status }));

test('官方续跑文案（中英）都判定为通用续跑', () => {
  // 这两个字符串由 HWChat 自己的「继续执行」按钮发出，必须被识别，
  // 否则按钮那条路径又会把「继续执行当前任务清单…」当成任务身份。
  assert.equal(isGenericResume(resumeInstruction('zh')), true);
  assert.equal(isGenericResume(resumeInstruction('en')), true);
});

test('裸续跑语气也识别（继续 / 继续吧 / 接着做）', () => {
  assert.equal(isGenericResume('继续'), true);
  assert.equal(isGenericResume('继续吧'), true);
  assert.equal(isGenericResume('接着做'), true);
  assert.equal(isGenericResume('继续执行'), true);
  assert.equal(isGenericResume('resume'), true);
  assert.equal(isGenericResume('continue'), true);
});

test('带具体交付物的续修不算通用续跑', () => {
  // 这些消息自己就说明了要做什么，范围不能被暂停清单顶掉。
  assert.equal(isGenericResume('继续修复登录刷新并发问题'), false);
  assert.equal(isGenericResume('继续把侧边栏改成蓝色'), false);
  assert.equal(isGenericResume('继续做附件点击打开'), false);
});

test('带路径或代码片段的续跑不算通用续跑', () => {
  assert.equal(isGenericResume('接着改 src/views/chatPanel.ts 的标题'), false);
  assert.equal(isGenericResume('继续看 `chat.js` 里那段样式'), false);
  assert.equal(isGenericResume('继续处理 out/extension.js'), false);
});

test('普通消息不会被误判', () => {
  assert.equal(isGenericResume('将 hwchat 侧边栏的对话卡片显示的运行状态，运行中显示为蓝色文字'), false);
  assert.equal(isGenericResume(''), false);
  assert.equal(isGenericResume('   '), false);
});

test('作用域只取未完成条目，已完成的不会再被拉回比较范围', () => {
  const scope = resumeScopeTitle([
    { content: '已完成的事', status: 'completed' },
    { content: '粘贴的附件可点击打开', status: 'pending' },
    { content: '发送后的图片也可点击查看', status: 'in_progress' },
  ]);
  assert.equal(scope, '粘贴的附件可点击打开；发送后的图片也可点击查看');
});

test('没有未完成条目时没有作用域（通用指令不生效）', () => {
  assert.equal(resumeScopeTitle(todos('completed', 'completed')), undefined);
  assert.equal(resumeScopeTitle([]), undefined);
  assert.equal(resumeScopeTitle(undefined), undefined);
});

test('续跑绑定到暂停清单的作用域', () => {
  const scope = resolveResumeScope({
    text: resumeInstruction('zh'),
    todos: [
      { content: '附件点击打开', status: 'pending' },
      { content: '运行中显示蓝色', status: 'completed' },
    ],
  });
  assert.equal(scope, '附件点击打开');
});

test('按钮路径用显式标记，不依赖文本猜测', () => {
  const scope = resolveResumeScope({
    text: '随便什么文本',
    todos: [{ content: '步骤 1', status: 'pending' }],
    explicitResume: true,
  });
  assert.equal(scope, '步骤 1');
});

test('没有暂停清单时不绑定，即使显式续跑也一样', () => {
  assert.equal(resolveResumeScope({ text: resumeInstruction('zh'), todos: [] }), undefined);
  assert.equal(resolveResumeScope({ text: resumeInstruction('zh'), explicitResume: true }), undefined);
  assert.equal(
    resolveResumeScope({ text: '继续', todos: todos('completed'), explicitResume: true }),
    undefined,
  );
});

test('具体需求不会被暂停清单劫持（一次性语义的边界）', () => {
  // 关键：清单还暂停着，但用户这一轮说的是另一件事 —— 必须用它自己的原文当范围。
  const scope = resolveResumeScope({
    text: '将侧边栏的运行状态改成蓝色',
    todos: [{ content: '附件点击打开', status: 'pending' }],
  });
  assert.equal(scope, undefined);
});
