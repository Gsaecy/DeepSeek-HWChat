/**
 * 环境类失败：命令没错，环境缺东西。
 *
 * 现场（用户 2026-11-05，连着两条）：
 *   `/bin/sh: timeout: command not found`（macOS 自带没有 GNU timeout）
 *   `screencapture: capture error 这项操作无法完成`（屏幕录制没有授权）
 * 工具原来只把 stderr 原样还回去，模型只能换个写法再撞一次。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { commandEnvironmentHint } from '../agent/commandHints';

const TIMEOUT_CMD = 'curl -s https://example.com | timeout 25 cat';
const TIMEOUT_OUT = '/bin/sh: line 0: timeout: command not found';

test('macOS 上 timeout 缺失 → 指向 GNU coreutils 的差异', () => {
  assert.equal(commandEnvironmentHint(TIMEOUT_CMD, TIMEOUT_OUT, 'darwin')?.key, 'tool.runCommand.noTimeoutMac');
});

test('其它平台也给出提示（但不说 coreutils 的事）', () => {
  assert.equal(commandEnvironmentHint(TIMEOUT_CMD, TIMEOUT_OUT, 'linux')?.key, 'tool.runCommand.noTimeout');
});

test('screencapture 报 capture error → 屏幕录制权限', () => {
  const hint = commandEnvironmentHint('screencapture -v out.mov', 'screencapture: capture error 这项操作无法完成', 'darwin');
  assert.equal(hint?.key, 'tool.runCommand.screenCapturePermission');
});

test('screencapture 成功（有输出但无错误特征）不提示', () => {
  assert.equal(commandEnvironmentHint('screencapture -x shot.png', 'type any character to stop', 'darwin'), undefined);
});

test('无关失败不误报', () => {
  assert.equal(commandEnvironmentHint('npm test', '/bin/sh: npm: command not found', 'darwin'), undefined);
  assert.equal(commandEnvironmentHint('ls', 'ls: no such file or directory', 'darwin'), undefined);
});
