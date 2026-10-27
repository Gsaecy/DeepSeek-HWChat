import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentCacheName, imageExtensionFor, planAttachmentOpen } from '../agent/attachmentOpen';

/**
 * 附件「点击打开」的决策规则。
 *
 * 这组测试守的是一条用户明确提过的约束：打开附件不能影响附件本身的位置。
 * 所以三条分支必须各自独立可验证 —— 有路径的走原文件、只有内存文本的走
 * 未命名文档、只有内存图片的才派生副本。任何一条被合并或调换顺序，
 * 都会重新引入「为了查看而复制/移动文件」的风险。
 */

test('有 path 时打开磁盘上的原文件，不碰内存副本', () => {
  const plan = planAttachmentOpen({
    label: 'src/a.ts',
    path: 'src/a.ts',
    kind: 'file',
    content: 'export const a = 1;',
  });
  assert.deepEqual(plan, { action: 'path', path: 'src/a.ts' });
});

test('path 优先于图片分支：磁盘图片直接打开原文件', () => {
  const plan = planAttachmentOpen({
    label: 'logo.png',
    path: 'assets/logo.png',
    kind: 'image',
    mimeType: 'image/png',
    dataBase64: 'iVBORw0KGgo=',
  });
  assert.deepEqual(plan, { action: 'path', path: 'assets/logo.png' });
});

test('粘贴的图片没有 path，走派生副本分支', () => {
  const plan = planAttachmentOpen({ label: '粘贴的图片', kind: 'image', mimeType: 'image/png', dataBase64: 'AAAA' });
  assert.deepEqual(plan, { action: 'image', dataBase64: 'AAAA', extension: 'png' });
});

test('粘贴的 jpeg 用 jpg 扩展名，未知类型退回 png', () => {
  assert.equal(imageExtensionFor('image/jpeg'), 'jpg');
  assert.equal(imageExtensionFor('IMAGE/JPEG'), 'jpg');
  assert.equal(imageExtensionFor('image/heic'), 'png');
  assert.equal(imageExtensionFor(undefined), 'png');
});

test('粘贴的文本走未命名文档，内容原样带过去', () => {
  const plan = planAttachmentOpen({ label: '粘贴的文件', kind: 'file', content: 'line 1\nline 2' });
  assert.deepEqual(plan, { action: 'text', content: 'line 1\nline 2', language: undefined });
});

test('声明是图片但正文已清理时退回文本或不可用，而不是报错', () => {
  assert.deepEqual(
    planAttachmentOpen({ label: 'x', kind: 'image', mimeType: 'image/png', content: 'fallback' }),
    { action: 'text', content: 'fallback', language: undefined },
  );
  assert.deepEqual(planAttachmentOpen({ label: 'x', kind: 'image', mimeType: 'image/png' }), { action: 'unavailable' });
});

test('空白 path 视为没有路径', () => {
  assert.deepEqual(planAttachmentOpen({ label: 'x', path: '   ', content: 'body' }), {
    action: 'text',
    content: 'body',
    language: undefined,
  });
});

test('空附件判定为不可用，不产生任何打开动作', () => {
  assert.deepEqual(planAttachmentOpen({ label: '空' }), { action: 'unavailable' });
  assert.deepEqual(planAttachmentOpen({ label: '空', content: '' }), { action: 'unavailable' });
});

test('缓存副本按内容寻址：同图同名、异图异名', () => {
  const first = attachmentCacheName({ dataBase64: 'AAAA', mimeType: 'image/png' });
  const again = attachmentCacheName({ dataBase64: 'AAAA', mimeType: 'image/png' });
  const other = attachmentCacheName({ dataBase64: 'BBBB', mimeType: 'image/png' });
  assert.equal(first, again, '同一张图点开两次必须命中同一个文件，否则会堆重复截图');
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{32}\.png$/);
  assert.match(attachmentCacheName({ dataBase64: 'AAAA', mimeType: 'image/jpeg' }), /\.jpg$/);
});
