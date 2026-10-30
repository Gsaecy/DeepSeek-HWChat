/**
 * 新对话的初始运行时设置 + 运行中切换预设的作用范围。
 *
 * 用户要求（两条，缺一条都算没做到）：
 *  1. **新对话固定从「每次询问 / 24 步 / 默认（模型官方）」开始**，
 *     不受 settings.json 里残留的 `permissionPreset: autopilot`、
 *     `agentMaxSteps: 0`、`reasoningEffort: high` 影响。
 *  2. **任务运行中也能切换权限预设**，但只对下一次对话生效，
 *     正在执行的 Agent 任务继续用它开始时的那份快照。
 *
 * 现场：用户设置里留着旧版本自动写入的 autopilot + 0 步，于是每条新对话一开
 * 就自动执行、无限步；界面上却写着「每次询问 / 24 步」。第 1 条把这个缺口堵死。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NEW_CONVERSATION_CONTROLS,
  presetChangeScope,
  resolveConversationControls,
  resolveNewConversationControls,
} from '../core/conversationControls';
import { DEFAULT_AGENT_MAX_STEPS, AGENT_STEP_PRESETS, AGENT_STEP_SAFETY_CAP } from '../core/agentLimits';
import { DEFAULT_PERMISSION_PRESET } from '../core/permissions';
import { DEFAULT_REASONING_EFFORT, readSettings } from '../core/settings';
import { setConfiguration, setFolderConfiguration, setWorkspaceRoots } from './support/vscodeMock';

const ROOT = process.cwd();

test('新对话初始值：每次询问 / 24 步 / 模型官方思考默认', () => {
  assert.deepEqual({ ...NEW_CONVERSATION_CONTROLS }, {
    permissionPreset: 'askAll',
    internetReference: false,
    agentMaxSteps: 24,
    reasoningEffort: 'default',
  });
  // 三个常量必须与各自的唯一出处一致，改了一处不会留下不一致的副本。
  assert.equal(NEW_CONVERSATION_CONTROLS.permissionPreset, DEFAULT_PERMISSION_PRESET);
  assert.equal(NEW_CONVERSATION_CONTROLS.agentMaxSteps, DEFAULT_AGENT_MAX_STEPS);
  assert.equal(NEW_CONVERSATION_CONTROLS.reasoningEffort, DEFAULT_REASONING_EFFORT);
  // 步数四档就是 24 / 68 / 120 / 不限制（0）。
  assert.deepEqual([...AGENT_STEP_PRESETS], [24, 68, 120, 0]);
});

test('新对话初始值不受 settings.json 里的旧声明影响（真实故障的完整复现）', () => {
  // 这就是本机用户设置里的真实内容：旧版本把面板选择写进了全局配置。
  setWorkspaceRoots([ROOT]);
  setConfiguration({
    'hwchat.permissionPreset': 'autopilot',
    'hwchat.agentMaxSteps': 0,
    'hwchat.reasoningEffort': 'high',
    'hwchat.fileReadPolicy': 'allow',
    'hwchat.fileWritePolicy': 'allow',
    'hwchat.commandPolicy': 'allow',
  });
  setFolderConfiguration(ROOT, { 'hwchat.permissionPreset': 'autopilot' });

  // 全局设置对象本身已经是固定值……
  const settings = readSettings();
  assert.equal(settings.permissionPreset, 'askAll');
  assert.equal(settings.agentMaxSteps, 24);
  assert.equal(settings.reasoningEffort, 'default');

  // ……草稿（新对话）也只取固定值，不叠加任何环境声明。
  const fresh = resolveNewConversationControls();
  assert.deepEqual(fresh, { permissionPreset: 'askAll', agentMaxSteps: 24, reasoningEffort: 'default', internetReference: false });
  assert.deepEqual(resolveNewConversationControls({}), fresh);
  // 脏值不能把初始值带偏：负数 / 非法预设 / 非法深度都回落到固定值。
  assert.deepEqual(
    resolveNewConversationControls({ permissionPreset: 'custom', agentMaxSteps: -1, reasoningEffort: 'ultra' }),
    fresh,
  );
  setConfiguration({});
  setFolderConfiguration(ROOT, {});
});

test('草稿上的临时选择仍然生效（只是不跨对话）', () => {
  assert.deepEqual(
    resolveNewConversationControls({ permissionPreset: 'review', agentMaxSteps: 68, reasoningEffort: 'high', internetReference: false }),
    { permissionPreset: 'review', agentMaxSteps: 68, reasoningEffort: 'high', internetReference: false },
  );
  // 「不限制」是显式选择，必须原样保留。
  assert.equal(resolveNewConversationControls({ agentMaxSteps: 0 }).agentMaxSteps, 0);
  // 超上限仍被夹住。
  assert.equal(resolveNewConversationControls({ agentMaxSteps: 10_000 }).agentMaxSteps, AGENT_STEP_SAFETY_CAP);
});

test('已有对话的存档值优先于固定初始值（升级不丢用户选择）', () => {
  const controls = resolveConversationControls(NEW_CONVERSATION_CONTROLS, {
    permissionPreset: 'autopilot',
    internetReference: false,
    agentMaxSteps: 120,
    reasoningEffort: 'max',
  });
  assert.deepEqual(controls, { permissionPreset: 'autopilot', agentMaxSteps: 120, reasoningEffort: 'max', internetReference: false });
});

test('运行中切换预设：只对下一次对话生效', () => {
  // 正在跑的任务持有它开始时的快照（autopilot）；用户改成每次询问。
  assert.equal(presetChangeScope({ runningPreset: 'autopilot', requested: 'askAll' }), 'next-turn-only');
  // 反向同理：运行中把预设放宽，也不能改变正在执行的任务。
  assert.equal(presetChangeScope({ runningPreset: 'askAll', requested: 'full' }), 'next-turn-only');
  // 没有正在运行的任务：立即生效。
  assert.equal(presetChangeScope({ requested: 'review' }), 'immediate');
  // 选的就是当前值：没有「下一次才生效」可讲。
  assert.equal(presetChangeScope({ runningPreset: 'review', requested: 'review' }), 'immediate');
});

test('运行中改预设的接线：面板必须允许、且只写对话存档', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const panel = await readFile(join(process.cwd(), 'src/views/chatPanel.ts'), 'utf8');

  const start = panel.indexOf('private async setPermissionPreset(');
  assert.ok(start > 0, '找不到 setPermissionPreset');
  const body = panel.slice(start, panel.indexOf('\n  private async setAgentMaxSteps(', start));
  // 旧实现开头是 `if (... || this.viewingBusy) return;`：运行中直接不响应。
  assert.doesNotMatch(body, /viewingBusy/, '运行中必须允许切换预设');
  // 新预设落在这条对话的存档里 → 下一次 send() 才会读到它。
  assert.match(body, /persistControls\(/, '预设必须写入对话存档');
  assert.match(body, /presetChangeScope\(/, '必须区分「立即生效」与「下一次生效」');
  // 正在跑的任务用自己那份快照判定，面板不能去改它。
  assert.doesNotMatch(body, /run\.settings\s*=/, '不得修改正在运行任务的设置快照');

  const webview = await readFile(join(process.cwd(), 'media/chat.js'), 'utf8');
  assert.match(
    webview,
    /elements\.permissionPresetInput\.disabled = archived \|\| state\.permissionPresetPending;/,
    'webview 在流式输出期间不能禁用预设下拉',
  );
  assert.match(webview, /chat\.permissionPresetNextTurnHint/, '运行中切换要提示「下一次生效」');
});
