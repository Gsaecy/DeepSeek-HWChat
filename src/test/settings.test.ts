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
import * as vscode from 'vscode';
import { applyRuntimeControls, describePermissionScope, formatPermissionScope, readSettings, updateSettings } from '../core/settings';
import { setConfiguration, setFolderConfiguration, setWorkspaceRoots } from './support/vscodeMock';

const ROOT_A = process.cwd();
const ROOT_B = process.cwd();

function roots(...paths: string[]): void {
  setWorkspaceRoots(paths);
}

test('文件夹级与用户级的 permissionPreset 声明都不再影响新对话', () => {
  roots(ROOT_A);
  setConfiguration({ 'hwchat.permissionPreset': 'autopilot' });
  setFolderConfiguration(ROOT_A, { 'hwchat.permissionPreset': 'review' });

  const settings = readSettings();
  // 新规则：新对话固定「每次询问」。声明值只出现在权限来源报告里，不参与判定。
  assert.equal(settings.permissionPreset, 'askAll');
  assert.equal(settings.dangerousCommandPolicy, 'deny', '危险命令直接拒绝');
  assert.equal(settings.sensitiveFilePolicy, 'deny');
});

test('没有任何声明时同样是每次询问（默认值唯一出处）', () => {
  roots(ROOT_A);
  setConfiguration({});
  setFolderConfiguration(ROOT_A, {});

  const settings = readSettings();
  assert.equal(settings.permissionPreset, 'askAll');
  assert.equal(settings.dangerousCommandPolicy, 'deny');
});

test('多根工作区里任何文件夹的声明都不会放宽新对话', () => {
  setWorkspaceRoots([ROOT_A, `${ROOT_A}/src`, `${ROOT_A}/media`]);
  setConfiguration({ 'hwchat.permissionPreset': 'full' });
  setFolderConfiguration(`${ROOT_A}/src`, { 'hwchat.permissionPreset': 'autopilot' });
  setFolderConfiguration(`${ROOT_A}/media`, { 'hwchat.permissionPreset': 'review' });

  // 以前这里是「同级取最严格」的 review；现在三项都归属对话，声明一律不生效。
  assert.equal(readSettings().permissionPreset, 'askAll');
});

test('完全没配置时回落到每次询问默认值', () => {
  roots(ROOT_A);
  setConfiguration({});

  // 默认值决定“用户开口之前 Agent 能自己做什么”，所以取最严格的一档。
  assert.equal(readSettings().permissionPreset, 'askAll');
});

test('策略列由预设推导，手写的单项设置不会覆盖预设', () => {
  setWorkspaceRoots([ROOT_A, `${ROOT_A}/src`]);
  setConfiguration({ 'hwchat.permissionPreset': 'review', 'hwchat.fileWritePolicy': 'deny' });
  setFolderConfiguration(`${ROOT_A}/src`, { 'hwchat.fileWritePolicy': 'deny' });
  setFolderConfiguration(ROOT_A, { 'hwchat.fileWritePolicy': 'ask' });

  // 预设与五项单项策略都已改为「按对话」，配置里的声明值一律不参与判定：
  // 新对话从最严格的每次询问开始，_settings.json 里写什么都不改变它。
  const settings = readSettings();
  assert.equal(settings.permissionPreset, 'askAll');
  assert.equal(settings.fileWritePolicy, 'ask');
  assert.equal(settings.fileReadPolicy, 'ask');
});

test('文件夹级 sensitiveFilePolicy 不覆盖预设', () => {
  roots(ROOT_A);
  setConfiguration({ 'hwchat.permissionPreset': 'review' });
  setFolderConfiguration(ROOT_A, { 'hwchat.sensitiveFilePolicy': 'ask' });

  // 新对话固定每次询问：敏感文件禁止，声明值不参与判定。
  assert.equal(readSettings().sensitiveFilePolicy, 'deny');
});

test('旧配置里的 custom 预设回落到每次询问，不残留单项策略', () => {
  roots(ROOT_A);
  // 这个值已不是合法预设：读取时必须安全回落，不能让策略表出现查不到的档位。
  setConfiguration({ 'hwchat.permissionPreset': 'custom', 'hwchat.fileReadPolicy': 'deny' });

  const settings = readSettings();
  assert.equal(settings.permissionPreset, 'askAll');
  assert.equal(settings.fileReadPolicy, 'ask');
  assert.equal(settings.commandPolicy, 'ask');
});

test('权限来源报告照实列出声明值，同时说明生效值固定为每次询问', () => {
  roots(ROOT_A);
  setConfiguration({ 'hwchat.permissionPreset': 'autopilot' });
  setFolderConfiguration(ROOT_A, { 'hwchat.permissionPreset': 'review' });

  const report = describePermissionScope();
  // 生效值固定：预设不再从任何一层读取。
  assert.equal(report.preset, 'askAll');
  const presetEntry = report.entries.find((entry) => entry.key === 'permissionPreset');
  assert.ok(presetEntry);
  assert.equal(presetEntry.resolved, 'askAll');
  // 但声明值必须原样摊开：排障时「我明明写了 review」要能立刻看到它确实被读到了。
  assert.ok(presetEntry.folders.some((folder) => folder.value === '"review"'));
  assert.equal(presetEntry.globalValue, '"autopilot"');

  const lines = formatPermissionScope(report).join('\n');
  assert.match(lines, /权限预设：askAll/);
  assert.match(lines, /声明值不参与判定/);
  assert.match(lines, /permissionPreset → askAll/);
});

test('没有任何一层声明时，报告如实标注“无”', () => {
  roots(ROOT_A);
  setConfiguration({});
  setFolderConfiguration(ROOT_A, {});

  const report = describePermissionScope();
  assert.equal(report.preset, 'askAll');
  const entry = report.entries.find((item) => item.key === 'commandPolicy');
  assert.ok(entry);
  assert.equal(entry.workspaceValue, undefined);
  assert.equal(entry.globalValue, undefined);
  // 每次询问预设下常规命令要逐次确认，报告要给出真正生效值而不是配置原值。
  assert.match(formatPermissionScope(report).join('\n'), /commandPolicy → ask｜文件夹: 无/);
});

test('defaultMode 读设置，非法值回落 agent', () => {
  roots(ROOT_A);
  setConfiguration({ 'hwchat.defaultMode': 'plan' });
  assert.equal(readSettings().defaultMode, 'plan');

  setConfiguration({ 'hwchat.defaultMode': 'chat' });
  assert.equal(readSettings().defaultMode, 'chat');

  // 手写成非法字符串时不能把非法值一路传给运行时。
  setConfiguration({ 'hwchat.defaultMode': 'Ask' });
  assert.equal(readSettings().defaultMode, 'agent');

  setConfiguration({});
  assert.equal(readSettings().defaultMode, 'agent');
});

/**
 * 权限日志里出现的那一串（permissionPreset → autopilot、dangerousCommandPolicy → allow）
 * 必须能被解释清楚：它是 Autopilot 预设本身的语义，不是「用户级配置把权限放开了」。
 * 下面两条把这两件事钉死，避免以后有人把单项策略重新接回判定逻辑。
 */
test('用户级 autopilot 声明不会让新对话自动执行危险命令', () => {
  roots(ROOT_A);
  setFolderConfiguration(ROOT_A, {});
  setConfiguration({ 'hwchat.permissionPreset': 'autopilot', 'hwchat.dangerousCommandPolicy': 'deny' });

  const settings = readSettings();
  // 新规则：新对话固定每次询问（危险命令直接拒绝），声明值只用于排障展示。
  assert.equal(settings.permissionPreset, 'askAll');
  assert.equal(settings.dangerousCommandPolicy, 'deny');
  assert.equal(settings.sensitiveFilePolicy, 'deny');
  // 想用 autopilot 必须在那条对话的工具条上显式切换（放宽时还有二次确认）。
  const widened = applyRuntimeControls(settings, 'autopilot');
  assert.equal(widened.dangerousCommandPolicy, 'allow');
});

test('历史配置（含旧版本自动写入的 allow）无法放宽新对话的默认权限', () => {
  roots(ROOT_A);
  setFolderConfiguration(ROOT_A, {});
  setConfiguration({
    'hwchat.permissionPreset': 'review',
    'hwchat.fileReadPolicy': 'allow',
    'hwchat.fileWritePolicy': 'allow',
    'hwchat.commandPolicy': 'allow',
    'hwchat.dangerousCommandPolicy': 'allow',
    'hwchat.sensitiveFilePolicy': 'allow',
  });

  const settings = readSettings();
  // 这正是用户设置里真实存在的那一组残留值：一条都不生效。
  assert.equal(settings.fileReadPolicy, 'ask');
  assert.equal(settings.fileWritePolicy, 'ask');
  assert.equal(settings.commandPolicy, 'ask');
  assert.equal(settings.dangerousCommandPolicy, 'deny', '危险命令仍然直接拒绝');
  assert.equal(settings.sensitiveFilePolicy, 'deny', '敏感文件仍然禁止');
});

test('保存设置不再把废弃的单项策略写进用户配置', async () => {
  roots(ROOT_A);
  setFolderConfiguration(ROOT_A, {});
  setConfiguration({});

  await updateSettings({
    permissionPreset: 'review',
    // 面板传来的整份设置里仍带着这五项（内存里的预设推导值），但落盘时必须忽略：
    // 旧实现会把它们写成用户设置，留下一条「看起来能生效、实际被忽略」的配置。
    fileReadPolicy: 'allow',
    fileWritePolicy: 'allow',
    commandPolicy: 'allow',
    dangerousCommandPolicy: 'allow',
    sensitiveFilePolicy: 'allow',
  });

  const configuration = vscode.workspace.getConfiguration('hwchat');
  // 预设本身也不再落盘：它属于对话。
  assert.equal(configuration.get('permissionPreset'), undefined, 'permissionPreset 不应被写回配置');
  for (const key of ['fileReadPolicy', 'fileWritePolicy', 'commandPolicy', 'dangerousCommandPolicy', 'sensitiveFilePolicy']) {
    assert.equal(configuration.get(`hwchat.${key}`), undefined, `${key} 不应被写回配置`);
  }
  // 预设 / 步数 / 思考深度同样归属对话：写设置时不得落盘，否则下一次读配置的
  // 代码（或用户手改）会以为它们还能影响新对话。
  await updateSettings({ agentMaxSteps: 120, reasoningEffort: 'max' });
  assert.equal(configuration.get('agentMaxSteps'), undefined, 'agentMaxSteps 不应被写回配置');
  assert.equal(configuration.get('reasoningEffort'), undefined, 'reasoningEffort 不应被写回配置');

  // 正向对照：真正属于全局的设置仍然照常写入，证明上面不是「什么都没写」。
  await updateSettings({ defaultMode: 'plan' });
  assert.equal(configuration.get('defaultMode'), 'plan');
  setConfiguration({});
});
