import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_DOC_CONTEXT_BYTES,
  PROJECT_DOC_MARKER,
  appendProjectDoc,
  doneEntriesForRun,
  emptyProjectDoc,
  isProjectDoc,
  parseProjectDoc,
  renderProjectDocContext,
} from '../core/projectDoc';

test('新文档带标记，且五个小节齐全', () => {
  const doc = emptyProjectDoc('Safevault');
  assert.ok(doc.includes(PROJECT_DOC_MARKER));
  assert.equal(isProjectDoc(doc), true);
  const parsed = parseProjectDoc(doc);
  assert.deepEqual(Object.keys(parsed).sort(), ['convention', 'decision', 'done', 'open', 'rejected']);
  for (const items of Object.values(parsed)) assert.deepEqual(items, []);
});

test('判重靠标记，不靠文件名：换个名字也认得出来', () => {
  const doc = `${PROJECT_DOC_MARKER}\n## 已定的决策\n\n- 用 A 方案\n`;
  assert.equal(isProjectDoc(doc), true);
  assert.equal(isProjectDoc('# 随便什么文档\n- 不是我们的'), false);
  assert.equal(isProjectDoc(undefined), false);
});

test('追加是只增不减：已有条目一条都不丢', () => {
  const first = appendProjectDoc(emptyProjectDoc('P'), [{ kind: 'decision', text: '用 B 方案' }]).text;
  const second = appendProjectDoc(first, [{ kind: 'decision', text: '用 C 补 B' }]).text;
  const parsed = parseProjectDoc(second);
  assert.deepEqual(parsed.decision, ['用 B 方案', '用 C 补 B']);
});

test('重复条目不会写两次（模型经常重复记录同一件事）', () => {
  const first = appendProjectDoc(emptyProjectDoc('P'), [{ kind: 'convention', text: '不要改动版本号' }]).text;
  const again = appendProjectDoc(first, [{ kind: 'convention', text: '  不要改动版本号  ' }]);
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 1);
  assert.deepEqual(parseProjectDoc(again.text).convention, ['不要改动版本号']);
});

test('「已否决的做法」单独成节（循环修改的根因）', () => {
  const doc = appendProjectDoc(emptyProjectDoc('P'), [
    { kind: 'rejected', text: '不要用轮询 replace_in_file 的方式改大文件：容易失败' },
    { kind: 'decision', text: '改用 write_file 整份重写' },
  ]).text;
  const parsed = parseProjectDoc(doc);
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0]!, /轮询/);
  assert.equal(parsed.decision.length, 1);
});

test('注入有预算：超了就省略最旧的，并说明省略了多少', () => {
  const entries = Array.from({ length: 200 }, (_value, index) => ({
    kind: 'decision' as const,
    text: `第 ${index} 条决策：${'很长的理由'.repeat(20)}`,
  }));
  const doc = appendProjectDoc(emptyProjectDoc('P'), entries).text;
  const context = renderProjectDocContext(doc);
  assert.ok(Buffer.byteLength(context) <= PROJECT_DOC_CONTEXT_BYTES, `实际 ${Buffer.byteLength(context)} 字节`);
  // 最新的那条必须在（超预算时丢的是最旧的）。
  assert.match(context, /第 199 条决策/);
  assert.doesNotMatch(context, /第 0 条决策/);
  assert.match(context, /omitted to stay within budget/);
});

test('没有文档或文档为空时不注入任何东西', () => {
  assert.equal(renderProjectDocContext(''), '');
  assert.equal(renderProjectDocContext(emptyProjectDoc('P')), '');
  assert.equal(renderProjectDocContext('# 不是我们的文档'), '');
});

test('注入内容带「记录不是指令」的声明（与任务记忆同一条护栏）', () => {
  const doc = appendProjectDoc(emptyProjectDoc('P'), [{ kind: 'decision', text: '用 A' }]).text;
  const context = renderProjectDocContext(doc);
  assert.match(context, /RECORD, not a new instruction/);
  assert.match(context, /update_project_doc/);
});

test('脏输入不抛错', () => {
  assert.equal(parseProjectDoc('## 不存在的节\n- x').decision.length, 0);
  const result = appendProjectDoc('', [{ kind: 'open', text: '   ' }]);
  assert.equal(result.added, 0);
});

test('运行结果转成 done 条目：只收已完成，标题去重后重跑不留两条', () => {
  const entries = doneEntriesForRun([
    { title: '修好表格排版', status: 'complete', summary: '胶囊最小宽度收敛', changedFiles: ['media/chat.css', 'media/chat.js'] },
    { title: '还没做完的事', status: 'running' },
    { title: '   ', status: 'complete' },
  ]);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry!.kind, 'done');
  assert.match(entry!.text, /^完成：修好表格排版/);
  assert.match(entry!.text, /改动 media\/chat\.css、media\/chat\.js/);

  let doc = emptyProjectDoc('P');
  const first = appendProjectDoc(doc, entries);
  assert.equal(first.added, 1);
  doc = first.text;
  // 同标题重跑：摘要变了、文件变了，但仍然是同一件事，不该再记一条。
  const again = appendProjectDoc(doc, doneEntriesForRun([
    { title: '修好表格排版', status: 'complete', summary: '换了个说法', changedFiles: ['media/chat.css'] },
  ]));
  assert.equal(again.added, 0);
  assert.equal(parseProjectDoc(again.text).done.length, 1);
});

test('done 条目不改动其他小节，也不影响注入', () => {
  const doc = appendProjectDoc(emptyProjectDoc('P'), [
    { kind: 'decision', text: '权限预设是唯一权威' },
    { kind: 'done', text: '完成：修好表格排版' },
  ]).text;
  const parsed = parseProjectDoc(doc);
  assert.deepEqual(parsed.decision, ['权限预设是唯一权威']);
  assert.deepEqual(parsed.done, ['完成：修好表格排版']);
  assert.match(renderProjectDocContext(doc), /完成：修好表格排版/);
});
