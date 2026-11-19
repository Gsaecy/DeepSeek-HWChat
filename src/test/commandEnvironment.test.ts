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

test('Windows：cmd 下的 PowerShell cmdlet 给出「别混写」的做法', () => {
  /*
   * 真实故障（2026-11-19）：`git fetch --quiet; "…" ; (git status | Measure-Object).Count`
   * 与 `a & b` 混写，cmd 里报「'Select-String' 不是内部或外部命令」，
   * 模型只能换个写法再撞一次。
   */
  const hint = commandEnvironmentHint(
    "git status --porcelain | Select-String pat",
    "'Select-String' 不是内部或外部命令，也不是可运行的程序或批处理文件。",
    'win32',
  );
  assert.equal(hint?.key, 'tool.runCommand.powerShellCmdlet');
  assert.equal(hint?.values?.name, 'Select-String');

  const english = commandEnvironmentHint('x | Where-Object', "'Where-Object' is not recognized as an internal or external command", 'win32');
  assert.equal(english?.key, 'tool.runCommand.powerShellCmdlet');
});

test('Windows：cmd 自己的命令缺失不算 cmdlet 误报', () => {
  assert.equal(
    commandEnvironmentHint('foo', "'foo' 不是内部或外部命令，也不是可运行的程序或批处理文件。", 'win32'),
    undefined,
  );
  // 非 Windows 平台不触发
  assert.equal(
    commandEnvironmentHint('x | Select-String pat', "'Select-String' is not recognized as an internal or external command", 'darwin'),
    undefined,
  );
});
