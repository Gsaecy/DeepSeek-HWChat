/**
 * 新对话的默认权限预设 = 「每次询问」（`askAll`）。
 *
 * 这条需求有两个半边，缺一半都不算做到：
 *
 * 1. **没得选的时候从严**：用户什么都没设，Agent 只能先问。默认值决定“用户开口
 *    之前 Agent 能自己做什么”，这类默认值出错是不可撤销的——一条没被确认的
 *    递归删除发出去就收不回来。所以默认取最严格的一档，而不是 `review`
 *    （`review` 会静默执行常规命令）。
 * 2. **用户选了就不许顶回去**：切换是用户主动动作，只影响当前这条对话 / 草稿；
 *    重新渲染、发送、切对话都不能把手动选择重置回默认值。
 *
 * 默认值散落在三层：`core/permissions.ts`（唯一出处）、`settings.ts`（读取时兜底）、
 * `package.json` + `media/*.js`（设置页与 webview 的兜底）。任何一层漂了，用户
 * 都会看到“设置里写着每次询问、实际却在自动执行”，所以这里把每一层都钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PERMISSION_PRESET,
  PERMISSION_PRESET_PROFILES,
  permissionPresetDetail,
} from '../core/permissions';
import { normalizePermissionPreset, readSettings, applyRuntimeControls } from '../core/settings';
import { resolveConversationControls } from '../core/conversationControls';
import { setConfiguration, setFolderConfiguration, setWorkspaceRoots } from './support/vscodeMock';

const ROOT = process.cwd();

/** 源码可能从项目根或仓库根运行（`npm test` 两种都见过）。 */
function repositoryFile(...segments: string[]): string {
  const candidates = [
    path.join(process.cwd(), ...segments),
    path.join(process.cwd(), 'DeepSeek-HWChat', ...segments),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found, `找不到 ${segments.join('/')}`);
  return readFileSync(found, 'utf8');
}

function nothingConfigured(): void {
  setWorkspaceRoots([ROOT]);
  setConfiguration({});
  setFolderConfiguration(ROOT, {});
}

test('默认预设是每次询问，且是四档里最严格的一档', () => {
  assert.equal(DEFAULT_PERMISSION_PRESET, 'askAll');

  // 默认档的语义：读、写、只读命令、正常命令全部逐次确认，危险命令直接拒绝，
  // 敏感文件禁止——四档里只有它一项都不自动放行。
  const profile = PERMISSION_PRESET_PROFILES[DEFAULT_PERMISSION_PRESET];
  assert.equal(profile.fileReadPolicy, 'ask');
  assert.equal(profile.fileWritePolicy, 'ask');
  assert.equal(profile.readOnlyCommandPolicy, 'ask');
  assert.equal(profile.commandPolicy, 'ask');
  assert.equal(profile.dangerousCommandPolicy, 'deny');
  assert.equal(profile.sensitiveFilePolicy, 'deny');
});

test('什么都没配置时，读到的预设就是每次询问', () => {
  nothingConfigured();

  const settings = readSettings();
  assert.equal(settings.permissionPreset, 'askAll');
  // 顺手确认策略确实跟着预设走，而不是只有名字对。
  assert.equal(settings.fileReadPolicy, 'ask');
  assert.equal(settings.commandPolicy, 'ask');
  assert.equal(settings.dangerousCommandPolicy, 'deny');
  assert.equal(settings.sensitiveFilePolicy, 'deny');
  // 另外两项「新对话默认值」同理：24 步 + 模型官方思考默认（`default` = 不发参数）。
  assert.equal(settings.agentMaxSteps, 24);
  assert.equal(settings.reasoningEffort, 'default');
});

test('package.json 里三项新对话默认值与代码一致（每次询问 / 24 步 / 模型官方默认）', () => {
  const pkg = JSON.parse(repositoryFile('package.json')) as {
    contributes?: { configuration?: { properties?: Record<string, { default?: unknown; minimum?: number; enum?: string[]; deprecationMessage?: string }> } };
  };
  const properties = pkg.contributes?.configuration?.properties;
  assert.ok(properties, 'package.json 里找不到 contributes.configuration.properties');
  assert.equal(properties['hwchat.permissionPreset']?.default, 'askAll');
  assert.equal(properties['hwchat.agentMaxSteps']?.default, 24);
  // 「无限制」用 0 表示，所以最小值必须是 0（写 1 会让用户手填 0 时被设置页标红）。
  assert.equal(properties['hwchat.agentMaxSteps']?.minimum, 0);
  assert.equal(properties['hwchat.reasoningEffort']?.default, 'default');
  assert.deepEqual(properties['hwchat.reasoningEffort']?.enum, ['default', 'low', 'medium', 'high', 'max']);
  // 这三项已改为「按对话」：键仍注册（旧 settings.json 不报未知项），但必须标记废弃，
  // 否则用户会以为改它们还能影响新对话。
  for (const key of ['hwchat.permissionPreset', 'hwchat.agentMaxSteps', 'hwchat.reasoningEffort']) {
    assert.ok(properties[key]?.deprecationMessage, `${key} 缺少 deprecationMessage`);
  }
});

test('非法/旧存档值一律回落到每次询问，而不是某个更宽的档位', () => {
  // 旧版本可能存着已移除的 'custom'，也可能被手改成拼错的字符串。
  assert.equal(normalizePermissionPreset('custom'), 'askAll');
  assert.equal(normalizePermissionPreset(''), 'askAll');
  assert.equal(normalizePermissionPreset(undefined), 'askAll');
  assert.equal(normalizePermissionPreset(3), 'askAll');
  // 合法值原样保留，不能被兜底逻辑吃掉。
  for (const preset of ['askAll', 'review', 'autopilot', 'full'] as const) {
    assert.equal(normalizePermissionPreset(preset), preset);
  }
});

test('未知预设取说明文案时回落到默认档，不会取到错的档位', () => {
  // 以前这里是 `details[1]`（写死 review）：默认值一改就错位。
  const detail = permissionPresetDetail('nope' as never, 'zh');
  assert.equal(detail.id, DEFAULT_PERMISSION_PRESET);
});

test('用户切换后保持不变：对话里的值压过默认值，缺省才用默认值', () => {
  const defaults = {
    permissionPreset: DEFAULT_PERMISSION_PRESET,
    agentMaxSteps: 40,
    reasoningEffort: 'high' as const,
  };

  // 手动切到更宽的档位后，读回来必须还是它——不能被默认值顶回去。
  for (const preset of ['review', 'autopilot', 'full'] as const) {
    assert.equal(
      resolveConversationControls(defaults, { permissionPreset: preset }).permissionPreset,
      preset,
      `${preset} 应当被保留`,
    );
  }

  // 没有任何值的对话（新建、或存档里被丢弃的非法值）才用默认值。
  assert.equal(resolveConversationControls(defaults).permissionPreset, 'askAll');
  assert.equal(resolveConversationControls(defaults, {}).permissionPreset, 'askAll');
  assert.equal(
    resolveConversationControls(defaults, { permissionPreset: 'custom' as never }).permissionPreset,
    'askAll',
  );
});

test('webview 的兜底默认值同样是每次询问', () => {
  const chat = repositoryFile('media', 'chat.js');
  const settings = repositoryFile('media', 'settings.js');

  // 三条兜底：初始 state、收到 state 之后、收到 permissionPresetChanged 之后。
  // 任何一条留在 'review'，界面就会在扩展侧没给值时自己显示成风险操作询问。
  assert.doesNotMatch(
    chat,
    /permissionPreset[^\n]{0,80}\|\|\s*'review'/,
    'media/chat.js 里仍有回落到 review 的写法',
  );
  assert.match(chat, /permissionPreset:\s*'askAll'/, 'media/chat.js 的初始 state 应默认 askAll');
  // 设置页不再有预设下拉：它只显示固定说明 + 说明矩阵，避免出现「改了却不生效」的控件。
  assert.doesNotMatch(settings, /fields\.permissionPreset/, 'media/settings.js 不该再有预设下拉');
  assert.match(
    repositoryFile('src', 'views', 'settingsPanel.ts'),
    /settings\.fixedDefaults\.body/,
    '设置页要明确写出新对话的三项固定初始值',
  );
});

test('切换后的权限只看当前预设，切换前（全局）那一份不参与判定', () => {
  // 全局保存着「完全访问」：它不再影响任何新对话。
  setWorkspaceRoots([ROOT]);
  setConfiguration({ 'hwchat.permissionPreset': 'full' });
  const global = readSettings();
  assert.equal(global.permissionPreset, 'askAll');
  assert.equal(global.sensitiveFilePolicy, 'deny');

  // 这条对话被切到「每次询问」后，展开出来的策略必须整套换成每次询问的，
  // 不能让全局那份 allow / ask 跟着一起用下去。
  const narrowed = applyRuntimeControls(global, 'askAll');
  assert.equal(narrowed.permissionPreset, 'askAll');
  assert.equal(narrowed.fileReadPolicy, 'ask');
  assert.equal(narrowed.fileWritePolicy, 'ask');
  assert.equal(narrowed.commandPolicy, 'ask');
  assert.equal(narrowed.dangerousCommandPolicy, 'deny');
  assert.equal(narrowed.sensitiveFilePolicy, 'deny');

  // 反向同样成立：全局是每次询问，对话切到完全访问后整套跟着放宽。
  setConfiguration({});
  const widened = applyRuntimeControls(readSettings(), 'full');
  assert.equal(widened.permissionPreset, 'full');
  assert.equal(widened.fileWritePolicy, 'allow');
  assert.equal(widened.dangerousCommandPolicy, 'allow');
  assert.equal(widened.sensitiveFilePolicy, 'ask');
});

/** 取一个类方法的方法体（到下一个同级方法声明为止），用于源码级接线断言。 */
function methodSource(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `找不到 ${declaration}`);
  const next = source.indexOf('\n  async ', start + declaration.length);
  return source.slice(start, next < 0 ? source.length : next);
}

test('附件读取按当前对话的预设判定，而不是全局默认值', () => {
  const panel = repositoryFile('src', 'views', 'chatPanel.ts');
  /*
   * 判定被抽进了 `attachmentSettings()`（「选文件」与「复用已发出的附件」两条入口共用，
   * 两处各写一遍迟早走样），所以这里盯**那个方法**的口径，再确认两条入口都经过它。
   */
  const resolve = methodSource(panel, 'private async attachmentSettings(');
  const attach = methodSource(panel, 'async attachFiles(');
  const reuse = methodSource(panel, 'private async attachMessageAttachment(');

  // 正例：先取这条对话的生效控件，再用它展开策略。
  assert.match(resolve, /this\.currentControls\(/, 'attachmentSettings 没有取本对话的生效预设');
  assert.match(resolve, /applyRuntimeControls\(/, 'attachmentSettings 没有按本对话预设展开策略');
  // 反例：直接拿 readSettings() 的结果当判定依据，就会出现“全局是每次询问、
  // 当前对话已切到完全访问”时仍然被敏感文件禁止挡下的情况。
  assert.doesNotMatch(
    resolve,
    /return readSettings\(\);/,
    'attachmentSettings 又直接用全局设置了：附件的敏感文件判定必须跟当前对话的预设走',
  );
  // 两条入口都必须经过同一个解析，不能有一条自己拿全局设置。
  assert.match(attach, /this\.attachmentSettings\(/, 'attachFiles 没有走统一的附件设置解析');
  assert.match(reuse, /this\.attachmentSettings\(/, '复用已发出的附件也必须走同一个设置解析');

  // `readAttachment` 自己也不许再兜底读全局：默认值就是那个漏点。
  const executor = repositoryFile('src', 'agent', 'toolExecutor.ts');
  assert.match(
    executor,
    /async readAttachment\(uri: vscode\.Uri, settings: ChatSettings\)/,
    'readAttachment 的 settings 必须是必填参数',
  );
  assert.doesNotMatch(
    executor,
    /readAttachment\(uri: vscode\.Uri, settings = readSettings\(\)\)/,
    'readAttachment 不能再用全局设置做默认值',
  );
});
