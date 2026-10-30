import assert from 'node:assert/strict';
import test from 'node:test';
import { checkReuseLimits, MAX_PENDING_ATTACHMENTS, planAttachmentReuse, reuseCopy } from '../core/attachmentReuse';
import { MessageContext } from '../core/types';

/**
 * 「把已经发出去的附件再拿一份放进输入框」的判定。
 *
 * 用户原话：「已经发到聊天框的消息里面的图片，想要拖动，或者复制到输入框显示成新的附件」。
 *
 * 这里锁的都是**静默出错**的类型：拿错来源、句柄串号、索引淘汰后什么都不发生、
 * 或者拖拽这条路悄悄突破上限。
 */

const image: MessageContext = {
  id: 'att-1',
  label: 'failure-screenshot.png',
  kind: 'image',
  bytes: 5620,
  mimeType: 'image/png',
  dataBase64: 'iVBORw0KGgo=',
  thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
};

const textFile: MessageContext = {
  id: 'att-2',
  label: 'src/AuthManager.ts',
  path: 'src/AuthManager.ts',
  kind: 'file',
  bytes: 8421,
  content: 'export const a = 1;',
};

const base = { pendingCount: 0, pendingBytes: 0, maxTotalBytes: 12 * 1024 * 1024 };

test('内存里有图片内容 → 直接复制，不去读磁盘', () => {
  const plan = planAttachmentReuse({ ...base, known: image });
  assert.equal(plan.action, 'add');
  if (plan.action !== 'add') return;
  assert.equal(plan.attachment.dataBase64, image.dataBase64);
  assert.equal(plan.attachment.kind, 'image');
});

test('复制出来的附件不带 id（否则两条附件共用一个句柄）', () => {
  const plan = planAttachmentReuse({ ...base, known: image });
  assert.equal(plan.action, 'add');
  if (plan.action !== 'add') return;
  assert.equal(plan.attachment.id, undefined);
  // 也不能改到源对象：源附件还要继续用来渲染历史消息。
  assert.equal(image.id, 'att-1');
  assert.equal(reuseCopy(textFile).id, undefined);
  assert.equal(textFile.id, 'att-2');
});

test('文本附件同样能从内存复制（正文原样）', () => {
  const plan = planAttachmentReuse({ ...base, known: textFile });
  assert.equal(plan.action, 'add');
  if (plan.action !== 'add') return;
  assert.equal(plan.attachment.content, 'export const a = 1;');
  assert.equal(plan.attachment.path, 'src/AuthManager.ts');
});

test('索引被淘汰（没有内容）但有路径 → 回落到磁盘读取', () => {
  const evicted: MessageContext = { label: 'shot.png', path: 'screens/shot.png', kind: 'image', bytes: 100 };
  const plan = planAttachmentReuse({ ...base, known: evicted });
  assert.deepEqual(plan, { action: 'read', path: 'screens/shot.png' });
});

test('只有 id 且内容已淘汰 → 明确报「取不回来」，不是静默什么都不做', () => {
  const plan = planAttachmentReuse({ ...base, known: { label: 'shot.png', kind: 'image' } });
  assert.equal(plan.action, 'unavailable');
});

test('界面只回传了路径（没有 id）也能走通', () => {
  const plan = planAttachmentReuse({ ...base, path: 'src/AuthManager.ts' });
  assert.deepEqual(plan, { action: 'read', path: 'src/AuthManager.ts' });
});

test('既没命中也没路径 → unavailable', () => {
  assert.equal(planAttachmentReuse({ ...base }).action, 'unavailable');
  assert.equal(planAttachmentReuse({ ...base, path: '   ' }).action, 'unavailable');
});

test('数量上限：满 20 条就不再收', () => {
  const plan = planAttachmentReuse({ ...base, known: image, pendingCount: MAX_PENDING_ATTACHMENTS });
  assert.equal(plan.action, 'too-many');
});

test('数量上限在读盘之前就挡住（不为一注定放不下的附件读几 MB）', () => {
  const plan = planAttachmentReuse({ ...base, known: { label: 'x.png', path: 'x.png' }, pendingCount: MAX_PENDING_ATTACHMENTS });
  assert.equal(plan.action, 'too-many');
});

test('总量上限：再加这一条会超就拒绝', () => {
  const plan = planAttachmentReuse({ ...base, known: image, pendingBytes: base.maxTotalBytes - 1000 });
  assert.equal(plan.action, 'too-large');
});

test('总量正好等于上限时允许（边界不能差一个字节）', () => {
  const plan = planAttachmentReuse({ ...base, known: image, pendingBytes: base.maxTotalBytes - 5620 });
  assert.equal(plan.action, 'add');
});

test('checkReuseLimits：磁盘读完之后的复核口径与前面一致', () => {
  assert.equal(checkReuseLimits(1000, 0, 0, 5000), 'ok');
  assert.equal(checkReuseLimits(5001, 0, 0, 5000), 'too-large');
  assert.equal(checkReuseLimits(0, MAX_PENDING_ATTACHMENTS, 0, 5000), 'too-many');
  // 未知大小（0）不该被判成超限
  assert.equal(checkReuseLimits(0, 0, 4999, 5000), 'ok');
});
