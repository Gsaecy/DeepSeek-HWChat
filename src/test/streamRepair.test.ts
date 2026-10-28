import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * 流式输出时补全未闭合的 markdown。
 *
 * 依据：Vercel AI SDK 官方 Streamdown 组件用 `remend` 做这件事——「自动补全
 * bold / italic / inline code / links / strikethrough」，让还在流的半截语法
 * 直接按最终形态渲染。不补全的后果就是 `**重点` 先按字面量显示、收尾符一到
 * 就跳成粗体（星号消失、宽度变化），也就是用户看到的「已经输出的文字在跳」。
 */

interface Repair {
  repairStreamingMarkdown: (text: string) => string;
  needsRepair: (text: string) => boolean;
}

function load(): Repair {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/stream-repair.js', 'utf8'), sandbox);
  const api = sandbox.HWChatStreamRepair as Repair | undefined;
  assert.ok(api, 'media/stream-repair.js 必须挂载 HWChatStreamRepair');
  return api;
}

test('未闭合的粗体补成粗体（不是「斜体 + 多余星号」）', () => {
  const { repairStreamingMarkdown } = load();
  assert.equal(repairStreamingMarkdown('结果是 **重点'), '结果是 **重点**');
  // 这一条是修复前真正的病根：`**重点` 会被斜体规则吃掉一个星号
  assert.equal(repairStreamingMarkdown('结果是 **重点*'), '结果是 **重点**');
});

test('未闭合的斜体 / 粗斜体 / 删除线都补', () => {
  const { repairStreamingMarkdown } = load();
  assert.equal(repairStreamingMarkdown('这是 *斜'), '这是 *斜*');
  assert.equal(repairStreamingMarkdown('这是 ***粗斜'), '这是 ***粗斜***');
  assert.equal(repairStreamingMarkdown('这是 ~~删'), '这是 ~~删~~');
  // 收尾符只写了一半：补 1 个就够，补 2 个会多出可见的符号
  assert.equal(repairStreamingMarkdown('这是 ~~删~'), '这是 ~~删~~');
});

test('区间写法里的单个波浪号绝不能被补成删除线', () => {
  const { repairStreamingMarkdown } = load();
  assert.equal(repairStreamingMarkdown('耗时 20~25 秒'), '耗时 20~25 秒');
  assert.equal(repairStreamingMarkdown('3~5 天'), '3~5 天');
});

test('未闭合的行内代码补反引号', () => {
  const { repairStreamingMarkdown } = load();
  assert.equal(repairStreamingMarkdown('运行 `npm test'), '运行 `npm test`');
});

test('写到一半的链接补右括号（方括号不要先露出来再消失）', () => {
  const { repairStreamingMarkdown } = load();
  assert.equal(repairStreamingMarkdown('见 [文档](https://example.com/a'), '见 [文档](https://example.com/a)');
});

test('已经写完的内容一个字符都不改', () => {
  const { repairStreamingMarkdown } = load();
  for (const text of [
    '结果是 **重点** 通过。',
    '运行 `npm test` 确认。',
    '见 [文档](https://example.com/a)。',
    '普通文字，没有标记。',
    '',
  ]) {
    assert.equal(repairStreamingMarkdown(text), text, `不该改动：${text}`);
  }
});

test('列表符号、行内乘法星号不会被误补', () => {
  const { repairStreamingMarkdown } = load();
  assert.equal(repairStreamingMarkdown('步骤：\n- 第一步\n- 第二步'), '步骤：\n- 第一步\n- 第二步');
  assert.equal(repairStreamingMarkdown('* 甲\n* 乙'), '* 甲\n* 乙');
});

test('只补尾部那一段，前面已完成的段落不动', () => {
  const { repairStreamingMarkdown } = load();
  assert.equal(
    repairStreamingMarkdown('第一段已经写完，有 **粗体** 与 `代码`。\n\n第二段还在写 **重点'),
    '第一段已经写完，有 **粗体** 与 `代码`。\n\n第二段还在写 **重点**',
  );
});

test('前面段落里有未闭合标记时，不会补到别处', () => {
  const { repairStreamingMarkdown } = load();
  // `## **标题` 里的 ** 是上一段的内容（不是尾部），补到末尾会变成正文里的字面量。
  const text = '## **小标题\n\n正文已经写完。';
  assert.equal(repairStreamingMarkdown(text), text);
});

test('needsRepair：只有尾部还需要收尾时才为真', () => {
  const { needsRepair } = load();
  assert.equal(needsRepair('结果是 **重点'), true, '半截粗体要补');
  assert.equal(needsRepair('结果是 **重点**'), false, '写完了不用补');
  assert.equal(needsRepair('**'), false, '刚写下开启符、还没内容时不动');
  assert.equal(needsRepair('普通文字'), false);
  assert.equal(needsRepair('20~25'), false, '单个波浪号是区间，不是删除线');
});

test('围栏代码块里不做行内补全', () => {
  const { repairStreamingMarkdown } = load();
  const openFence = '待跑：\n\n```zsh\nnpm run build **';
  assert.equal(repairStreamingMarkdown(openFence), openFence, '代码块里的星号是原文');
  const tailIsFence = '说明：**粗**\n\n```zsh';
  assert.equal(repairStreamingMarkdown(tailIsFence), tailIsFence, '尾段刚开围栏');
});
