import * as vscode from 'vscode';
import {
  APPROVAL_LEVEL_DETAILS,
  APPROVAL_TARGETS,
  ApprovalBridgeLevel,
  ApprovalLevelDetail,
  ApprovalPlan,
  ApprovalTargetState,
  planApprovalBridge,
  splitSettingId,
} from './approvalPlan';

/**
 * 改写 VS Code 自己的 Agent 审批设置（chat.tools.*）。
 *
 * 为什么需要它：桥接工具（run_in_terminal 等）的确认由 VS Code 决定
 * （agent/vscodeTools.ts 传 delegateApproval: true），HWChat 的
 * permissionPreset 只作用于自己实现的工具。想让“只读命令不要每次弹窗”，
 * 只能改 VS Code 那一侧的设置。
 *
 * 安全约定：
 * 1. 只写用户设置（ConfigurationTarget.Global），不动工作区/文件夹设置；
 * 2. 只在受信任工作区里执行；
 * 3. 写入前先展示完整改动清单，需要逐次确认；
 * 4. 首次写入前把旧值备份到 globalState，可一键还原。
 */

const BACKUP_KEY = 'hwchat.vscodeApprovals.backup.v1';
const LEVEL_KEY = 'hwchat.vscodeApprovals.level.v1';

interface ApprovalBackupEntry {
  id: string;
  value: unknown;
}

/** 探测当前 VS Code 版本里真实注册了哪些审批键。 */
export function readApprovalTargets(): ApprovalTargetState[] {
  return APPROVAL_TARGETS.map((target) => {
    const { section, key } = splitSettingId(target.id);
    const configuration = vscode.workspace.getConfiguration(section);
    const inspection = configuration.inspect(key);
    if (inspection === undefined) {
      // 未注册的键 inspect 返回 undefined；已注册的一定返回对象。
      return { ...target, available: false, current: undefined };
    }
    const folderOverride = (vscode.workspace.workspaceFolders ?? []).some((folder) => (
      vscode.workspace
        .getConfiguration(section, folder.uri)
        .inspect(key)?.workspaceFolderValue !== undefined
    ));
    return {
      ...target,
      available: true,
      // 只用用户设置里的显式值作为基准，避免把默认值当成用户配置写回去。
      current: inspection.globalValue,
      workspaceOverride: folderOverride || inspection.workspaceValue !== undefined,
    };
  });
}

export async function applyApprovalPlan(
  plan: ApprovalPlan,
): Promise<{ applied: string[]; failed: Array<{ id: string; message: string }> }> {
  const applied: string[] = [];
  const failed: Array<{ id: string; message: string }> = [];
  for (const operation of plan.operations) {
    const { section, key } = splitSettingId(operation.id);
    try {
      const configuration = vscode.workspace.getConfiguration(section);
      // 值为空对象时显式写 undefined，让配置项回到未设置状态而不是留下 {}。
      const value = isEmptyObject(operation.after) ? undefined : operation.after;
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
      applied.push(operation.id);
    } catch (error) {
      failed.push({
        id: operation.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { applied, failed };
}

/** 交互入口：选择档位 → 预览改动 → 确认写入。 */
export async function showApprovalBridge(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('请在受信任的工作区里调整 VS Code 审批设置。');
    return;
  }

  const targets = readApprovalTargets();
  const available = targets.filter((target) => target.available);
  if (!available.length) {
    void vscode.window.showWarningMessage(
      '当前 VS Code 版本没有暴露 chat.tools.* 审批设置，无法从这里同步。请在设置里搜索 auto approve 手动调整。',
    );
    return;
  }

  const currentLevel = context.globalState.get<ApprovalBridgeLevel>(LEVEL_KEY);
  const picked = await vscode.window.showQuickPick(
    APPROVAL_LEVEL_DETAILS.map((detail) => ({
      label: detail.id === currentLevel ? `${detail.label}（当前）` : detail.label,
      description: detail.id,
      detail: detail.detail,
      level: detail,
    })),
    {
      title: 'HWChat：同步 VS Code 审批预设',
      placeHolder: '选择 VS Code 侧 Agent 工具的审批档位',
      ignoreFocusOut: true,
    },
  );
  if (!picked) return;

  const plan = planApprovalBridge(picked.level.id, targets);
  if (!plan.operations.length) {
    await context.globalState.update(LEVEL_KEY, picked.level.id);
    void vscode.window.showInformationMessage('VS Code 审批设置已经与所选档位一致，无需修改。');
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    describePlan(plan, picked.level),
    { modal: true },
    '写入 VS Code 设置',
  );
  if (confirmed !== '写入 VS Code 设置') return;

  await backupBeforeWrite(context, plan);
  const { applied, failed } = await applyApprovalPlan(plan);

  if (failed.length) {
    void vscode.window.showErrorMessage(
      `部分设置写入失败：${failed.map((item) => `${item.id}（${item.message}）`).join('；')}`,
    );
    return;
  }

  await context.globalState.update(LEVEL_KEY, picked.level.id);
  const skipped = plan.unavailable.length
    ? `；当前版本不存在：${plan.unavailable.map((target) => target.id).join('、')}`
    : '';
  void vscode.window.showInformationMessage(
    `已写入 ${applied.length} 项 VS Code 审批设置${skipped}。可用「HWChat: 还原 VS Code 审批设置」撤回。`,
  );
}

/** 还原到上一次写入前的值。 */
export async function revertApprovalBridge(context: vscode.ExtensionContext): Promise<void> {
  const backup = context.globalState.get<ApprovalBackupEntry[]>(BACKUP_KEY);
  if (!backup?.length) {
    void vscode.window.showInformationMessage('没有可还原的备份（尚未通过 HWChat 写入过审批设置）。');
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `将把 ${backup.length} 项 VS Code 审批设置还原为写入前的值。`,
    { modal: true },
    '还原',
  );
  if (confirmed !== '还原') return;

  const failed: string[] = [];
  for (const entry of backup) {
    const { section, key } = splitSettingId(entry.id);
    try {
      const value = isEmptyObject(entry.value) ? undefined : entry.value;
      await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
    } catch (error) {
      failed.push(`${entry.id}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  if (failed.length) {
    void vscode.window.showErrorMessage(`部分设置还原失败：${failed.join('；')}`);
    return;
  }
  await context.globalState.update(BACKUP_KEY, undefined);
  await context.globalState.update(LEVEL_KEY, undefined);
  void vscode.window.showInformationMessage('VS Code 审批设置已还原。');
}

/**
 * 只在首次写入时备份，避免连续切换档位把“初始值”覆盖成本次改动前的值。
 */
async function backupBeforeWrite(context: vscode.ExtensionContext, plan: ApprovalPlan): Promise<void> {
  const existing = context.globalState.get<ApprovalBackupEntry[]>(BACKUP_KEY) ?? [];
  const known = new Set(existing.map((entry) => entry.id));
  const additions = plan.operations
    .filter((operation) => !known.has(operation.id))
    .map((operation) => ({ id: operation.id, value: operation.before }));
  if (!additions.length) return;
  await context.globalState.update(BACKUP_KEY, [...existing, ...additions]);
}

function describePlan(plan: ApprovalPlan, level: ApprovalLevelDetail): string {
  const lines = plan.operations.map((operation) => {
    const before = isEmptyObject(operation.before) ? '未设置' : summarize(operation.before);
    return `• ${operation.id}\n  ${before} → ${summarize(operation.after)}`;
  });
  const warnings = plan.warnings.length ? `\n\n注意：\n${plan.warnings.join('\n')}` : '';
  return `${level.label}\n\n${level.detail}\n\n将修改 ${plan.operations.length} 项用户设置：\n${lines.join('\n')}${warnings}`;
}

function summarize(value: unknown): string {
  if (value === undefined) return '未设置';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'object' && value !== null) {
    const count = Object.keys(value).length;
    const allow = Object.values(value).filter((item) => item === true).length;
    const deny = Object.values(value).filter((item) => item === false).length;
    return `${count} 条规则（放行 ${allow} / 禁止 ${deny}）`;
  }
  return String(value);
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}
