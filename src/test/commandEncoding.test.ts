import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandOutputDecoder } from '../agent/commandEncoding';

/**
 * Windows 控制台（代码页 936）输出的中文报错，模型必须读得懂。
 *
 * 真实现场（2026-11-18）：
 *   `dir /b out` → `ϵͳ�Ҳ���ָ����·����`
 * 模型看不懂「系统找不到指定的路径」，换个写法又撞一次，连续三轮全失败后停机。
 */

/** GBK 编码的「系统找不到指定的路径」。 */
const GBK_PATHS = Buffer.from([
  0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4, 0xc2, 0xb7, 0xbe, 0xb6,
]);

test('GBK 输出解成中文，而不是替换字符', () => {
  const decoder = new CommandOutputDecoder();
  assert.equal(decoder.decode(GBK_PATHS), '系统找不到指定的路径');
  assert.equal(decoder.flush(), '');
});

test('纯 ASCII 与 UTF-8 原样通过', () => {
  const decoder = new CommandOutputDecoder();
  assert.equal(decoder.decode(Buffer.from('exit code 1\n')), 'exit code 1\n');
  const utf8 = Buffer.from('系统找不到指定的路径', 'utf8');
  assert.equal(decoder.decode(utf8), '系统找不到指定的路径');
});

test('跨 chunk 的 UTF-8 汉字不会被误判成 GBK', () => {
  const decoder = new CommandOutputDecoder();
  const utf8 = Buffer.from('错误：路径不存在', 'utf8');
  // 故意在汉字中间切开
  const cut = 4;
  const first = decoder.decode(utf8.subarray(0, cut));
  const second = decoder.decode(utf8.subarray(cut));
  assert.equal(`${first}${second}${decoder.flush()}`, '错误：路径不存在');
});

test('一旦认出是 GBK，后面纯 ASCII 的分段也照常可读', () => {
  const decoder = new CommandOutputDecoder();
  const first = decoder.decode(Buffer.concat([GBK_PATHS, Buffer.from('\r\n')]));
  const second = decoder.decode(Buffer.from('usage: dir\r\n'));
  assert.equal(first, '系统找不到指定的路径\r\n');
  assert.equal(second, 'usage: dir\r\n');
});
