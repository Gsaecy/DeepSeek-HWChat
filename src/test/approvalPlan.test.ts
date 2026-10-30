import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVAL_TARGETS,
  ApprovalTargetState,
  MANAGED_RULE_PATTERNS,
  planApprovalBridge,
  splitSettingId,
  valuesEqual,
} from '../core/approvalPlan';

function target(
  id: string,
  kind: 'boolean' | 'map',
  current: unknown,
  available = true,
): ApprovalTargetState {
  const descriptor = APPROVAL_TARGETS.find((item) => item.id === id);
  assert.ok(descriptor, `未定义的审批目标：${id}`);
  return { ...descriptor, kind, available, current };
}

/** 默认全部可用、均为空。 */
function targets(overrides: Partial<Record<string, unknown>> = {}): ApprovalTargetState[] {
  return [
    target('chat.tools.terminal.autoApprove', 'map', overrides['map'], true),
    target('chat.tools.terminal.enableAutoApprove', 'boolean', overrides['enable'], true),
    target('chat.tools.global.autoApprove', 'boolean', overrides['global'], true),
  ];
}

function operationMap(plan: ReturnType<typeof planApprovalBridge>, id: string): unknown {
  return plan.operations.find((operation) => operation.id === id)?.after;
}

function keys(map: unknown): string[] {
  return Object.keys(map as Record<string, unknown>);
}

test('safeCommands 只放行只读命令，并显式禁止删除', () => {
  const plan = planApprovalBridge('safeCommands', targets());
  const map = operationMap(plan, 'chat.tools.terminal.autoApprove') as Record<string, unknown>;

  assert.ok(keys(map).some((key) => key.includes('ls|dir')), '缺少只读命令规则');
  assert.ok(keys(map).some((key) => key.includes('git (?:status')), '缺少 git 只读规则');
  assert.equal(map['/^rm\\b/'], false, 'rm 必须是禁止');
  assert.equal(map['/^(?:sudo|doas|su)\\b/'], false, '提权必须是禁止');
  assert.ok(!keys(map).some((key) => key.includes('npm|pnpm|yarn) (?:test')), '只读档不该放行构建');

  assert.equal(operationMap(plan, 'chat.tools.terminal.enableAutoApprove'), true);
  assert.equal(operationMap(plan, 'chat.tools.global.autoApprove'), false);
});

test('禁止规则排在放行规则之后，保证后写入者优先', () => {
  const plan = planApprovalBridge('standard', targets());
  const map = keys(operationMap(plan, 'chat.tools.terminal.autoApprove'));
  const firstAllow = map.findIndex((key) => key.includes('ls|dir'));
  const firstDeny = map.findIndex((key) => key === '/^rm\\b/');
  assert.ok(firstAllow >= 0 && firstDeny >= 0);
  assert.ok(firstDeny > firstAllow, '禁止规则必须在放行规则之后');
});

test('standard 额外放行构建与类型检查，并给出 postinstall 警告', () => {
  const plan = planApprovalBridge('standard', targets());
  const map = operationMap(plan, 'chat.tools.terminal.autoApprove') as Record<string, unknown>;
  assert.ok(keys(map).some((key) => key.includes('npm|pnpm|yarn) (?:test')));
  assert.ok(keys(map).some((key) => key.includes('tsc')));
  assert.equal(operationMap(plan, 'chat.tools.global.autoApprove'), false);
  assert.ok(plan.warnings.some((warning) => warning.includes('postinstall')));
});

test('everything 只开总开关，不改动逐条批准表', () => {
  const plan = planApprovalBridge('everything', targets({ map: { '/^foo/': true } }));
  assert.equal(operationMap(plan, 'chat.tools.terminal.autoApprove'), undefined);
  assert.equal(operationMap(plan, 'chat.tools.global.autoApprove'), true);
  assert.equal(operationMap(plan, 'chat.tools.terminal.enableAutoApprove'), true);
  assert.ok(plan.warnings.some((warning) => warning.includes('提权')));
});

test('关闭档清空自建条目但保留用户自己的条目', () => {
  const custom = '/^echo hello$/';
  const plan = planApprovalBridge('off', targets({
    map: { '/^rm\\b/': false, [custom]: true },
    enable: true,
    global: true,
  }));
  const map = operationMap(plan, 'chat.tools.terminal.autoApprove') as Record<string, unknown>;
  assert.deepEqual(keys(map), [custom], '只应保留用户自定义条目');
  assert.equal(operationMap(plan, 'chat.tools.terminal.enableAutoApprove'), false);
  assert.equal(operationMap(plan, 'chat.tools.global.autoApprove'), false);
});

test('未注册的审批键不生成操作，并被列为不可用', () => {
  const plan = planApprovalBridge('safeCommands', [
    target('chat.tools.terminal.autoApprove', 'map', undefined, false),
    target('chat.tools.terminal.enableAutoApprove', 'boolean', undefined, false),
  ]);
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.unavailable.length, 2);
  assert.deepEqual(plan.unavailable.map((item) => item.id).sort(), [
    'chat.tools.terminal.autoApprove',
    'chat.tools.terminal.enableAutoApprove',
  ]);
});

test('用户自己的非托管条目原样保留', () => {
  const custom = '/^ansible-playbook/';
  const plan = planApprovalBridge('safeCommands', targets({ map: { [custom]: true } }));
  const map = operationMap(plan, 'chat.tools.terminal.autoApprove') as Record<string, unknown>;
  assert.equal(map[custom], true);
});

test('用户手动禁止的只读命令不被放开，并给出提示', () => {
  const allowKey = MANAGED_RULE_PATTERNS.find((pattern) => pattern.includes('ls|dir'));
  assert.ok(allowKey);
  const plan = planApprovalBridge('safeCommands', targets({ map: { [allowKey]: false } }));
  const map = operationMap(plan, 'chat.tools.terminal.autoApprove') as Record<string, unknown>;
  assert.equal(map[allowKey], false, '不应覆盖用户更严格的设置');
  assert.ok(plan.warnings.some((warning) => warning.includes('原本手动禁止')));
});

test('用户手动放行的危险命令被改回禁止，并给出提示', () => {
  const plan = planApprovalBridge('safeCommands', targets({ map: { '/^rm\\b/': true } }));
  const map = operationMap(plan, 'chat.tools.terminal.autoApprove') as Record<string, unknown>;
  assert.equal(map['/^rm\\b/'], false);
  assert.ok(plan.warnings.some((warning) => warning.includes('已被改为禁止')));
});

test('重复应用同一档位不产生新操作（幂等）', () => {
  const first = planApprovalBridge('standard', targets());
  const applied: Partial<Record<string, unknown>> = {};
  for (const operation of first.operations) applied[operation.id] = operation.after;
  const second = planApprovalBridge('standard', targets({
    map: applied['chat.tools.terminal.autoApprove'],
    enable: applied['chat.tools.terminal.enableAutoApprove'],
    global: applied['chat.tools.global.autoApprove'],
  }));
  assert.equal(second.operations.length, 0);
});

test('find 规则排除 -exec / -delete 这类副作用参数', () => {
  const findKey = MANAGED_RULE_PATTERNS.find((pattern) => pattern.startsWith('/^find'));
  assert.ok(findKey);
  const rule = new RegExp(findKey.slice(1, -1));
  assert.equal(rule.test('find . -name "*.ts"'), true);
  assert.equal(rule.test('find . -name "*.ts" -delete'), false);
  assert.equal(rule.test('find . -exec rm {} \\;'), false);
});

test('工作区级已定义同一键时给出覆盖提示', () => {
  const descriptor = APPROVAL_TARGETS.find((item) => item.id === 'chat.tools.terminal.enableAutoApprove');
  assert.ok(descriptor);
  const plan = planApprovalBridge('safeCommands', [
    { ...descriptor, available: true, current: undefined, workspaceOverride: true },
  ]);
  assert.ok(plan.warnings.some((warning) => warning.includes('工作区设置里已定义')));
});

test('splitSettingId 按最后一个点拆分', () => {
  assert.deepEqual(splitSettingId('chat.tools.terminal.autoApprove'), {
    section: 'chat.tools.terminal',
    key: 'autoApprove',
  });
  assert.deepEqual(splitSettingId('nodot'), { section: 'nodot', key: '' });
});

test('valuesEqual 忽略对象键顺序', () => {
  assert.equal(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(valuesEqual({ a: 1 }, { a: 2 }), false);
  assert.equal(valuesEqual(undefined, {}), false);
});

test('不再管理 chat.tools.edits.autoApprove（VS Code 1.144 声明成对象映射，布尔是类型错误）', () => {
  assert.equal(
    APPROVAL_TARGETS.some((item) => item.id === 'chat.tools.edits.autoApprove'),
    false,
    '这个键不能出现在目标列表里，否则某个档位会往对象里写 true/false',
  );
  // 它的默认值已经放行所有编辑（只排除 .git / package.json 等敏感路径），
  // 要全放行走总开关 chat.tools.global.autoApprove。
  for (const level of ['off', 'safeCommands', 'standard', 'everything'] as const) {
    const plan = planApprovalBridge(level, targets());
    assert.equal(
      plan.operations.some((operation) => operation.id === 'chat.tools.edits.autoApprove'),
      false,
      `${level} 档不该生成 edits.autoApprove 操作`,
    );
  }
});
