import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutor, type ToolApprovalRequest, type ToolExecutionScope } from '../agent/toolExecutor';
import { AuditLog } from '../agent/auditLog';
import { ChatSettings, PermissionPreset, ToolCall, ToolExecutionResult } from '../core/types';
import { PERMISSION_PRESET_PROFILES } from '../core/permissions';
import { setWorkspaceRoots } from './support/vscodeMock';

/**
 * 版本管理闸门的端到端用例（用户规则第 4 条：HWChat 不主动升版本）。
 *
 * 为什么放在执行器层而不是只测纯函数：只有在「写入真的被挡在落盘之前」
 * 被验证过，「提示词说不许升版本」才算有约束力。
 */

let workspaceRoot: string;
let root: string;
let executor: ToolExecutor;

before(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'hwchat-version-'));
  root = join(workspaceRoot, 'Demo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    '{\n  "name": "demo",\n  "version": "0.2.2",\n  "description": "old"\n}\n',
    'utf8',
  );
  setWorkspaceRoots([root]);
  executor = new ToolExecutor(new AuditLog(join(workspaceRoot, 'audit.jsonl')), () => true);
});

after(async () => {
  setWorkspaceRoots([]);
  await rm(workspaceRoot, { recursive: true, force: true });
});

function settings(preset: PermissionPreset = 'autopilot'): ChatSettings {
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
    requestTimeoutSeconds: 30,
    defaultMode: 'agent',
    agentMaxSteps: 0,
    reasoningEffort: 'default',
    permissionPreset: preset,
    fileReadPolicy: 'allow',
    fileWritePolicy: 'allow',
    commandPolicy: 'allow',
    dangerousCommandPolicy: 'ask',
    sensitiveFilePolicy: 'deny',
    maxReadBytes: 512_000,
    maxToolOutputBytes: 200_000,
    maxCommandSeconds: 120,
    auditRetentionDays: 30,
    language: 'auto',
    ...(profile
      ? {
          fileReadPolicy: profile.fileReadPolicy,
          fileWritePolicy: profile.fileWritePolicy,
          commandPolicy: profile.commandPolicy,
          dangerousCommandPolicy: profile.dangerousCommandPolicy,
          sensitiveFilePolicy: profile.sensitiveFilePolicy,
        }
      : {}),
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const approveAll = async (_request: ToolApprovalRequest): Promise<boolean> => true;

function run(
  name: string,
  args: Record<string, unknown>,
  scope: ToolExecutionScope,
): Promise<ToolExecutionResult> {
  return executor.execute(call(name, args), 'agent', settings(), approveAll, undefined, scope);
}

const bumpedPackage = '{\n  "name": "demo",\n  "version": "0.3.0",\n  "description": "old"\n}\n';
const originalPackage = '{\n  "name": "demo",\n  "version": "0.2.2",\n  "description": "old"\n}\n';

test('版本闸门：未获授权时 package.json 的 version 改动被拒绝，且文件保持原样', async () => {
  const denied = await run('write_file', { path: 'package.json', content: bumpedPackage }, { projectRoot: root });
  assert.equal(denied.status, 'denied', `应拒绝，实际：${denied.status} / ${denied.summary}`);
  assert.match(denied.summary, /0\.2\.2/, '拒绝理由要写清原来的版本号');
  assert.match(denied.summary, /0\.3\.0/, '拒绝理由要写清想改成什么');
  assert.equal(
    await readFile(join(root, 'package.json'), 'utf8'),
    originalPackage,
    '被拒绝的写入不能在文件里留下半成品',
  );
});

test('版本闸门：用户明确要求（versionBumpAllowed）时照常写入', async () => {
  const allowed = await run(
    'write_file',
    { path: 'package.json', content: bumpedPackage },
    { projectRoot: root, versionBumpAllowed: true },
  );
  assert.equal(allowed.status, 'success', `应放行，实际：${allowed.status} / ${allowed.summary}`);
  assert.match(await readFile(join(root, 'package.json'), 'utf8'), /0\.3\.0/);

  // 复原，避免用例之间互相污染。
  await writeFile(join(root, 'package.json'), originalPackage, 'utf8');
});

test('版本闸门：只改普通字段或不碰清单时不拦', async () => {
  const replace = await run(
    'replace_in_file',
    { path: 'package.json', oldText: '"description": "old"', newText: '"description": "new"' },
    { projectRoot: root },
  );
  assert.equal(replace.status, 'success', `普通字段应放行，实际：${replace.status} / ${replace.summary}`);

  const source = await run(
    'write_file',
    { path: 'src/index.ts', content: 'export const version = "9.9.9";\n' },
    { projectRoot: root },
  );
  assert.equal(source.status, 'success', `非清单文件不应受影响，实际：${source.status} / ${source.summary}`);

  // 复原。
  await writeFile(join(root, 'package.json'), originalPackage, 'utf8');
});

test('版本闸门：未获授权时 npm version 一类命令被拒绝，只读查询仍放行', async () => {
  const denied = await run('run_command', { command: 'npm version patch', cwd: '.' }, { projectRoot: root });
  assert.equal(denied.status, 'denied', `应拒绝，实际：${denied.status} / ${denied.summary}`);
  assert.match(denied.summary, /npm version/);

  const readOnly = await run('run_command', { command: 'npm --version', cwd: '.' }, { projectRoot: root });
  assert.notEqual(readOnly.status, 'denied', `npm --version 不应被拦截：${readOnly.summary}`);
});
