/**
 * 权限设置的作用域解析。
 *
 * 现场缺陷：用户在某个根目录的 `.vscode/settings.json` 里写
 * `"hwchat.permissionPreset": "review"`，但 `readSettings()` 用的是不带 resource 的
 * `getConfiguration('hwchat')`。按 vscode.d.ts，`workspaceFolderValue` 只属于
 * “请求的资源所属的工作区文件夹”，所以多根工作区里这份配置完全读不到——实际仍在
 * 用户设置的 autopilot 下运行，`chmod 777` 这类危险命令不会弹确认。
 *
 * 这些用例锁定“最具体优先、同级冲突取最严格”的解析规则。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describePermissionScope, formatPermissionScope, readSettings } from '../core/settings';
import { setConfiguration, setFolderConfiguration, setWorkspaceRoots } from './support/vscodeMock';

const ROOT_A = process.cwd();
const ROOT_B = process.cwd();

function roots(...paths: string[]): void {
  setWorkspaceRoots(paths);
}

test('文件夹级 permissionPreset 覆盖全局的 autopilot', () => {
  roots(ROOT_A);
  setConfiguration({ 'hwchat.permissionPreset': 'autopilot' });
  setFolderConfiguration(ROOT_A, { 'hwchat.permissionPreset': 'review' });

  const settings = readSettings();
  assert.equal(settings.permissionPreset, 'review');
  // review 的关键语义：危险命令逐次确认，而不是静默执行。
  assert.equal(settings.dangerousCommandPolicy, 'ask');
});

test('没有文件夹级配置时沿用用户设置', () => {
  roots(ROOT_A);
  setConfiguration({ 'hwchat.permissionPreset': 'autopilot' });

  const settings = readSettings();
  assert.equal(settings.permissionPreset, 'autopilot');
  assert.equal(settings.dangerousCommandPolicy, 'allow');
});

test('多根工作区里不同文件夹声明取最严格', () => {
  setWorkspaceRoots([ROOT_A, `${ROOT_A}/src`, `${ROOT_A}/media`]);
  setConfiguration({ 'hwchat.permissionPreset': 'full' });
  setFolderConfiguration(`${ROOT_A}/src`, { 'hwchat.permissionPreset': 'autopilot' });
  setFolderConfiguration(`${ROOT_A}/media`, { 'hwchat.permissionPreset': 'review' });

  assert.equal(readSettings().permissionPreset, 'review');
});

test('完全没配置时回落到 review 默认值', () => {
  roots(ROOT_A);
  setConfiguration({});

  assert.equal(readSettings().permissionPreset, 'review');
});

test('策略列由预设推导，手写的单项设置不会覆盖预设', () => {
  setWorkspaceRoots([ROOT_A, `${ROOT_A}/src`]);
  setConfiguration({ 'hwchat.permissionPreset': 'review', 'hwchat.fileWritePolicy': 'deny' });
  setFolderConfiguration(`${ROOT_A}/src`, { 'hwchat.fileWritePolicy': 'deny' });
  setFolderConfiguration(ROOT_A, { 'hwchat.fileWritePolicy': 'ask' });

  const settings = readSettings();
  assert.equal(settings.permissionPreset, 'review');
  // 自定义档位已移除：review 预设本身就是“自动读写”，手写的 deny 不再生效。
  assert.equal(settings.fileWritePolicy, 'allow');
});

test('文件夹级 sensitiveFilePolicy 不覆盖预设', () => {
  roots(ROOT_A);
  setConfiguration({ 'hwchat.permissionPreset': 'review' });
  setFolderConfiguration(ROOT_A, { 'hwchat.sensitiveFilePolicy': 'ask' });

  // review 预设固定禁止敏感文件，单项设置不再起作用。
  assert.equal(readSettings().sensitiveFilePolicy, 'deny');
});

test('旧配置里的 custom 预设回落到 review，不残留单项策略', () => {
  roots(ROOT_A);
  // 这个值已不是合法预设：读取时必须安全回落，不能让策略表出现查不到的档位。
  setConfiguration({ 'hwchat.permissionPreset': 'custom', 'hwchat.fileReadPolicy': 'deny' });

  const settings = readSettings();
  assert.equal(settings.permissionPreset, 'review');
  assert.equal(settings.fileReadPolicy, 'allow');
  assert.equal(settings.commandPolicy, 'allow');
});

test('权限来源报告能指出生效值与它是从哪一层读到的', () => {
  roots(ROOT_A);
  setConfiguration({ 'hwchat.permissionPreset': 'autopilot' });
  setFolderConfiguration(ROOT_A, { 'hwchat.permissionPreset': 'review' });

  const report = describePermissionScope();
  assert.equal(report.preset, 'review');
  const presetEntry = report.entries.find((entry) => entry.key === 'permissionPreset');
  assert.ok(presetEntry);
  assert.equal(presetEntry.resolved, 'review');
  assert.ok(presetEntry.folders.some((folder) => folder.value === '"review"'));
  assert.equal(presetEntry.globalValue, '"autopilot"');

  const lines = formatPermissionScope(report).join('\n');
  assert.match(lines, /权限预设：review/);
  assert.match(lines, /permissionPreset → review/);
});

test('没有任何一层声明时，报告如实标注“无”', () => {
  roots(ROOT_A);
  setConfiguration({});
  setFolderConfiguration(ROOT_A, {});

  const report = describePermissionScope();
  assert.equal(report.preset, 'review');
  const entry = report.entries.find((item) => item.key === 'commandPolicy');
  assert.ok(entry);
  assert.equal(entry.workspaceValue, undefined);
  assert.equal(entry.globalValue, undefined);
  // review 预设下常规命令是自动允许，报告要给出真正生效值而不是配置原值。
  assert.match(formatPermissionScope(report).join('\n'), /commandPolicy → allow｜文件夹: 无/);
});
