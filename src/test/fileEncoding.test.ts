import assert from 'node:assert/strict';
import test from 'node:test';
import { canEncodeTextFile, decodeTextFile, decodeWebText, encodeTextFile } from '../agent/fileEncoding';

/**
 * 文本文件编码的识别与写回。
 *
 * 真实故障（2026-11-18）：`replace_in_file` 对 GBK 文件「UTF-8 读 → UTF-8 写」，
 * 一圈下来文件里的中文全变成替换字符。这里的每条断言都对应一个会毁数据的边界。
 */

const GBK_CHINESE = Buffer.from([0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4, 0xc2, 0xb7, 0xbe, 0xb6]);

test('UTF-8 文件：正文与编码都认得出来', () => {
  const decoded = decodeTextFile(new TextEncoder().encode('const 名称 = "测试";'));
  assert.equal(decoded.text, 'const 名称 = "测试";');
  assert.equal(decoded.encoding, 'utf8');
  assert.equal(decodeTextFile(Buffer.from('plain ascii')).encoding, 'utf8');
});

test('UTF-8 BOM：读的时候剥掉，写回去原样带上', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文', 'utf8')]);
  const decoded = decodeTextFile(withBom);
  assert.equal(decoded.text, '中文', 'BOM 不该混进正文，否则 oldText 匹配会莫名失配');
  assert.equal(decoded.encoding, 'utf8-bom');
  assert.deepEqual(Buffer.from(encodeTextFile(decoded.text, decoded.encoding)!), withBom, '写回必须保持 BOM');
});

test('GBK 文件：中文能正确读出，但拒绝写回（避免毁掉正文）', () => {
  const decoded = decodeTextFile(GBK_CHINESE);
  assert.equal(decoded.text, '系统找不到指定的路径');
  assert.equal(decoded.encoding, 'gbk');
  assert.equal(canEncodeTextFile(decoded.encoding), false);
  assert.equal(encodeTextFile(decoded.text, decoded.encoding), undefined, '没有编码器就不许假装能写');
});

test('UTF-16 LE / BE：解码正确，写回与原文件逐字节一致', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文A', 'utf16le')]);
  const decodedLe = decodeTextFile(le);
  assert.equal(decodedLe.text, '中文A');
  assert.equal(decodedLe.encoding, 'utf16le');
  assert.deepEqual(Buffer.from(encodeTextFile(decodedLe.text, decodedLe.encoding)!), le);

  const beBody = Buffer.from('中文A', 'utf16le').swap16();
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
  const decodedBe = decodeTextFile(be);
  assert.equal(decodedBe.text, '中文A');
  assert.equal(decodedBe.encoding, 'utf16be');
  assert.deepEqual(Buffer.from(encodeTextFile(decodedBe.text, decodedBe.encoding)!), be);
});

test('网页：声明 charset=gbk 时按 GBK 解，不再整页乱码', () => {
  const html = Buffer.concat([
    Buffer.from('<html><body>'),
    GBK_CHINESE,
    Buffer.from('</body></html>'),
  ]);
  assert.match(decodeWebText(html, 'text/html; charset=gbk'), /系统找不到指定的路径/);
  assert.match(decodeWebText(html, 'text/html; charset=GB2312'), /系统找不到指定的路径/, 'gb2312 也按 GBK 解');
});

test('网页：只在 HTML 里声明 charset 也要认', () => {
  const html = Buffer.concat([
    Buffer.from('<meta charset="gbk">'),
    GBK_CHINESE,
  ]);
  assert.match(decodeWebText(html, 'text/html'), /系统找不到指定的路径/);
});

test('网页：什么都没声明时，UTF-8 页面不受影响', () => {
  const html = Buffer.from('<p>正常中文</p>', 'utf8');
  assert.equal(decodeWebText(html, 'text/html'), '<p>正常中文</p>');
});
