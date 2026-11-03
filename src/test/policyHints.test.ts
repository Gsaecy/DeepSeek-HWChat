import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutor } from '../agent/toolExecutor';
import { AuditLog } from '../agent/auditLog';
import { commandPathViolation, maskPatternFlagArguments } from '../agent/commandPaths';
import { ChatSettings, PermissionPreset, ToolCall, ToolExecutionResult } from '../core/types';
import { PERMISSION_PRESET_PROFILES } from '../core/permissions';
import { setWorkspaceRoots } from './support/vscodeMock';

/**
 * 守卫拦截后的「可执行提示」与「模式参数不是文件访问」。
 *
 * 用户原话（2026-11-03）：「三次失败就停止了任务，为什么不直接更改执行策略使用工作区内的
 * 文件夹（auto模式下）」。现场是三条命令连续被拒：
 *
 *   1. `tar czf /tmp/x.tgz … --exclude '.env'`   → 路径隔离（/tmp 在工作区外）
 *   2. `tar czf ../../tmp/x.tgz …`                → 路径隔离（解析后仍在工作区外）
 *   3. `tar czf <工作区>/tmp/x.tgz --exclude '.env' …` → 敏感文件守卫（命令里出现 `.env`）
 *
 * 第 1、2 条是同一个错误换拼法；第 3 条其实是**误报** —— `--exclude` 的值是排除模式，
 * 不是要读的文件。三轮全失败 → 停机等用户，用户因此质疑为什么不换方案。
 */

const SENSITIVE_FLAGS = ['--exclude', '--exclude-dir', '--include', '--include-dir', '--ignore', '--ignore-pattern', '--glob', '-name', '-iname', '-path'];

test('maskPatternFlagArguments：--exclude 的值不再算文件访问', () => {
  assert.equal(maskPatternFlagArguments("tar czf out.tgz --exclude '.env' server"), 'tar czf out.tgz --exclude pattern server');
  assert.equal(maskPatternFlagArguments('tar czf out.tgz --exclude .env server'), 'tar czf out.tgz --exclude pattern server');
  assert.equal(maskPatternFlagArguments('tar czf out.tgz --exclude=.env server'), 'tar czf out.tgz pattern server');
  assert.equal(maskPatternFlagArguments("grep -rn foo . --exclude-dir '.ssh'"), 'grep -rn foo . --exclude-dir pattern');
  assert.equal(maskPatternFlagArguments("find . -name '.env'"), 'find . -name pattern');
});

test('maskPatternFlagArguments：读文件的选项保持原样', () => {
  // 指向真实文件（不是模式）的选项不能被掩码，否则等于开了一个绕过守卫的口子。
  assert.equal(maskPatternFlagArguments("tar czf out.tgz --exclude-from '.env' server"), "tar czf out.tgz --exclude-from '.env' server");
  assert.equal(maskPatternFlagArguments("grep -f '.env' file.txt"), "grep -f '.env' file.txt");
});

test('每个模式选项都在名单里（防止只修 --exclude 一个）', () => {
  for (const flag of SENSITIVE_FLAGS) {
    const masked = maskPatternFlagArguments(`cmd ${flag} '.env' target`);
    assert.ok(!masked.includes('.env'), `${flag} 的值没有被掩码：${masked}`);
  }
});

test('路径拦截的话术要给出下一步，不能只说「被拦截」', () => {
  const roots = ['/tmp/hwchat-policy-root'];
  const blocked = commandPathViolation('tar czf /tmp/x.tgz .', roots, roots[0]);
  assert.ok(blocked, '工作区外的路径必须仍然被拒');
  assert.match(blocked!, /工作区内|<workspace root>/);
  assert.match(blocked!, /不要重试同一写法|instead of retrying/);
});

/* ── 端到端：真实执行器 ───────────────────────────────────────────────── */

let base: string;
let project: string;
let executor: ToolExecutor;

function settings(preset: PermissionPreset): ChatSettings {
  const profile = PERMISSION_PRESET_PROFILES[preset];
  return {
    internetReference: false,
    apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid/v1', models: ['deepseek-chat'], requestHeaders: {} }],
    activeApiProfileId: 'default',
    baseUrl: 'https://example.invalid/v1',
    model: 'deepseek-chat',
    temperature: 0,
    maxTokens: 0,
    systemPrompt: '',
    sendOnEnter: true,
    historyRetentionDays: 30,
    taskCacheRetentionHours: 24,
    cacheBudgetMB: 100,
    cleanupIntervalMinutes: 10,
    maxMessagesInContext: 20,
    requestHeaders: {},
    requestTimeoutSeconds: 30, proxy: '',
    defaultMode: 'agent',
    agentMaxSteps: 0,
    reasoningEffort: 'default',
    permissionPreset: preset,
    maxReadBytes: 512_000,
    maxToolOutputBytes: 200_000,
    maxCommandSeconds: 60,
    auditRetentionDays: 30,
    language: 'auto',
    ...profile,
  } as ChatSettings;
}

function call(command: string, cwd?: string): ToolCall {
  return {
    id: `call-${Math.random().toString(36).slice(2)}`,
    type: 'function',
    function: { name: 'run_command', arguments: JSON.stringify(cwd ? { command, cwd } : { command }) },
  };
}

async function run(command: string, preset: PermissionPreset = 'autopilot'): Promise<ToolExecutionResult> {
  return executor.execute(
    call(command),
    'agent',
    settings(preset),
    async () => true,
    'conv-policy',
    { gitWriteAllowed: true, projectRoot: project },
  );
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'hwchat-policy-'));
  project = join(base, 'Proj');
  await mkdir(join(project, 'server'), { recursive: true });
  await writeFile(join(project, 'server', 'package.json'), '{"name":"s","version":"1.0.0"}\n', 'utf8');
  await writeFile(join(project, 'server', '.env'), 'SECRET=1\n', 'utf8');
  setWorkspaceRoots([project]);
  executor = new ToolExecutor(new AuditLog(join(base, 'audit.jsonl')), () => true);
});

after(async () => {
  setWorkspaceRoots([]);
  await rm(base, { recursive: true, force: true });
});

test('端到端：tar --exclude .env 在工作区内能正常打包（不再被敏感文件守卫误拦）', async () => {
  await mkdir(join(project, 'tmp'), { recursive: true });
  const result = await run(
    "tar czf tmp/out.tgz --exclude 'node_modules' --exclude '.env' --exclude '.DS_Store' server",
    'askAll',
  );
  assert.notEqual(result.status, 'denied', `不该被拒：${result.content}`);
  assert.ok(existsSync(join(project, 'tmp', 'out.tgz')), `压缩包应真的生成：${result.content}`);
  assert.ok(!/敏感文件/.test(result.content), result.content);
});

test('端到端：写到 /tmp 仍然被拒，且提示要能照着做', async () => {
  const result = await run('tar czf /tmp/should-not-exist.tgz server', 'autopilot');
  assert.equal(result.status, 'denied');
  assert.match(result.content, /工作区内|<workspace root>/);
});
