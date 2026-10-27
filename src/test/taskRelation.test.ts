import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTaskRelation } from '../agent/taskRouter';

/**
 * 任务树的关联判定解析。
 *
 * 这一组测试对应一个真实故障：用户在同一条对话里提出了**不相关**的新需求，
 * 任务树却把它标成「已合并」。根因是判定用了 `includes('RELATED')`，
 * 而 `UNRELATED` 里正好含有子串 `RELATED` —— 模型回答「不相关」，
 * 代码读出来却是「相关」。
 */

test('直白回答能正确解析', () => {
  assert.equal(parseTaskRelation('RELATED'), 'related');
  assert.equal(parseTaskRelation('QUEUED'), 'queued');
});

test('否定形式不能再被判成相关（回归）', () => {
  assert.equal(parseTaskRelation('UNRELATED'), 'queued');
  assert.equal(parseTaskRelation('NOT RELATED'), 'queued');
  assert.equal(parseTaskRelation('not related'), 'queued');
  assert.equal(parseTaskRelation('IRRELEVANT'), 'queued');
});

test('大小写与标点不影响判定', () => {
  assert.equal(parseTaskRelation('related.'), 'related');
  assert.equal(parseTaskRelation('  Queued\n'), 'queued');
  assert.equal(parseTaskRelation('ANSWER: RELATED'), 'related');
});

test('带解释的回复按关键词判定', () => {
  assert.equal(parseTaskRelation('RELATED — it refines the same deliverable'), 'related');
  assert.equal(parseTaskRelation('QUEUED because this is a separate feature'), 'queued');
});

test('看不懂时返回 undefined，交给关键词兜底', () => {
  assert.equal(parseTaskRelation(''), undefined);
  assert.equal(parseTaskRelation('I am not sure.'), undefined);
});
