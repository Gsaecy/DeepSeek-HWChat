import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * 长用户消息默认折叠。
 *
 * 现场需求：贴进来的长篇需求（ADR、决策表）会把对话框顶成几屏，自己刚说的话
 * 反倒把回复挤出视野。所以要「够长就折起来，给一个展开全文」。
 *
 * 这里钉住阈值判定与 CSS/接线，因为折叠本身的观感只能靠浏览器实测（已用
 * headless Chromium 验过：折叠 216px / 展开 472px、按钮文案与 aria-expanded
 * 同步、整段重建后仍保持展开）。
 */

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const CHAT_CSS = readFileSync('media/chat.css', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

function numberConst(name: string): number {
  const match = CHAT_JS.match(new RegExp(`const ${name} = ([0-9_]+);`));
  assert.ok(match, `media/chat.js 里找不到 ${name}`);
  return Number(match[1]!.replace(/_/g, ''));
}

/** 与 chat.js 里 isLongUserMessage 完全一致的判定（同一组阈值常量）。 */
function isLong(content: string): boolean {
  const chars = numberConst('USER_CLAMP_CHARS');
  const lines = numberConst('USER_CLAMP_LINES');
  return content.length > chars || content.split('\n').length > lines;
}

test('短消息不折叠：只有一个问题、一两句话', () => {
  assert.equal(isLong('帮我把登录页的按钮改成主色。'), false);
  assert.equal(isLong('这段代码为什么会报错？\n\n`auth.ts:42`'), false);
});

test('长消息折叠：字符数超阈值', () => {
  const chars = numberConst('USER_CLAMP_CHARS');
  assert.equal(isLong('字'.repeat(chars)), false, '刚好等于阈值不折（免得边界上抖）');
  assert.equal(isLong('字'.repeat(chars + 1)), true);
});

test('长消息折叠：行数超阈值（Markdown 表格字符不多但行很多）', () => {
  const lines = numberConst('USER_CLAMP_LINES');
  const table = ['| 决策 | 建议 |', '| --- | --- |', ...Array.from({ length: lines }, (_, i) => `| 第 ${i} 项 | 建议 |`)].join('\n');
  assert.equal(isLong(table), true, '行多的表格必须折起来');
});

test('空白内容不折叠（不该给空消息挂一个展开按钮）', () => {
  assert.equal(CHAT_JS.includes("if (!raw.trim()) return false;"), true);
  assert.equal(CHAT_JS.includes("if (message.role !== 'user') return false;"), true, '只对用户消息生效');
});

test('折叠只加 class、不重建节点', () => {
  assert.match(CHAT_JS, /function attachUserMessageClamp\(contentNode, message\)/);
  assert.match(CHAT_JS, /contentNode\.classList\.toggle\('is-clamped', !expanded\)/);
  // 不允许在折叠函数里重建内容（会把选中状态、文件标签、代码块全部丢掉）
  const body = CHAT_JS.slice(CHAT_JS.indexOf('function attachUserMessageClamp('));
  const fn = body.slice(0, body.indexOf('\n  }\n'));
  assert.equal(/innerHTML|replaceChildren|createElement\('div'\)/.test(fn), false, '折叠不能重建 DOM');
});

test('展开状态记在模块级集合里，整段重建后仍保持展开', () => {
  assert.match(CHAT_JS, /const expandedUserMessages = new Set\(\);/);
  assert.match(CHAT_JS, /const expanded = expandedUserMessages\.has\(message\.id\);/);
  assert.match(CHAT_JS, /if \(next\) expandedUserMessages\.add\(message\.id\); else expandedUserMessages\.delete\(message\.id\);/);
});

test('CSS：折叠有高度上限，且靠 mask 渐隐（不靠叠渐变底色）', () => {
  assert.match(CHAT_CSS, /\.message\.user \.message-content\.is-clamped\s*\{[^}]*max-height:\s*\d+px/);
  assert.match(CHAT_CSS, /\.message\.user \.message-content\.is-clamped\s*\{[^}]*mask-image:\s*linear-gradient/);
  assert.match(CHAT_CSS, /\.message-clamp-toggle\s*\{/, '展开按钮必须有独立样式');
});

test('按钮有 aria-expanded，且与状态同步', () => {
  assert.match(CHAT_JS, /toggle\.setAttribute\('aria-expanded', String\(expanded\)\)/);
  assert.match(CHAT_JS, /toggle\.setAttribute\('aria-expanded', String\(next\)\)/);
});

test('文案走 i18n，中英都有', () => {
  for (const key of ['chat.expandMessage', 'chat.collapseMessage', 'chat.expandMessageHint']) {
    const start = I18N.indexOf(`'${key}':`);
    assert.ok(start >= 0, `i18n 缺 ${key}`);
    // 条目可能写成单行，也可能跨行（{ zh: …, en: … }），取到下一个条目之前都算它的内容。
    const rest = I18N.slice(start + key.length);
    const next = rest.search(/\n  '[a-zA-Z]/);
    const block = next >= 0 ? rest.slice(0, next) : rest.slice(0, 400);
    assert.match(block, /zh:/, `${key} 缺中文`);
    assert.match(block, /en:/, `${key} 缺英文`);
  }
});
