import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeQr, qrSvg } from '../sync/qr';

/**
 * 二维码是自己写的编码器（不引依赖、不联网生成图片），所以这里钉住结构：
 * 定位图案、定时图案、暗模块、版本选择、罚分掩码的确定性。
 *
 * 真正的「扫得出来」由 `tmp-qr-check.js` + OpenCV 解码验证（一次性脚本，不进仓库）。
 */

test('二维码：版本 1 的定位图案、定时图案与暗模块都在规范位置', () => {
  const matrix = encodeQr('HWCHAT');
  assert.equal(matrix.version, 1);
  assert.equal(matrix.size, 21);

  // 左上定位图案：7×7 黑框 / 白圈 / 3×3 黑心
  assert.equal(matrix.dark[0]![0], true);
  assert.equal(matrix.dark[1]![1], false);
  assert.equal(matrix.dark[3]![3], true);
  // 右上、左下各一个
  assert.equal(matrix.dark[0]![matrix.size - 1], true);
  assert.equal(matrix.dark[matrix.size - 1]![0], true);
  // 定位图案外侧隔离带必须是白的，否则扫码器找不到边界
  assert.equal(matrix.dark[7]![7], false);

  // 定时图案：第 6 行 / 第 6 列黑白交替
  for (let index = 8; index < matrix.size - 8; index += 1) {
    assert.equal(matrix.dark[index]![6], index % 2 === 0, `行定时 ${index}`);
    assert.equal(matrix.dark[6]![index], index % 2 === 0, `列定时 ${index}`);
  }

  // 固定的暗模块（右下角上方那一格）
  assert.equal(matrix.dark[matrix.size - 8]![8], true);
});

test('二维码：内容越长版本越大，且同一输入结果稳定', () => {
  const short = encodeQr('http://192.168.1.5:47821/m?c=123456');
  const long = encodeQr(`http://192.168.1.5:47821/m?c=123456&note=${'x'.repeat(120)}`);
  assert.ok(long.version > short.version, `${long.version} 应大于 ${short.version}`);
  assert.ok(short.version >= 2);

  const again = encodeQr('http://192.168.1.5:47821/m?c=123456');
  assert.equal(again.version, short.version);
  assert.equal(again.mask, short.mask);
  assert.deepEqual(again.dark, short.dark);
});

test('二维码：放不下的内容直接报错，不返回半张坏图', () => {
  assert.throws(() => encodeQr('x'.repeat(400)), /放不下/);
});

test('二维码 SVG：静区、尺寸与路径都按模块数算', () => {
  const matrix = encodeQr('HWCHAT');
  const svg = qrSvg('HWCHAT', { module: 4, quiet: 4 });
  const dimension = (matrix.size + 8) * 4;
  assert.match(svg, new RegExp(`width="${dimension}"`));
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /<path d="M/);
  // 每个黑模块一个 h/v 子路径，数量应与黑点总数一致
  const darkCount = matrix.dark.flat().filter(Boolean).length;
  assert.equal((svg.match(/h4v4h-4z/g) ?? []).length, darkCount);
});
