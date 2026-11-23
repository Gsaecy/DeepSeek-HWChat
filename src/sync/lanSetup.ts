/**
 * 把局域网同步接到 VS Code：读设置、拼本机身份、注册命令与状态栏、写账本文件。
 *
 * 单独成文件而不是塞进 `extension.ts`：激活函数已经很长，而这段是**可选功能**，
 * 让它自成一块，关闭时就真的什么都不做。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { ALIGNMENT_FILE } from './lanProtocol';
import { LanSyncService, defaultDeviceName, defaultPlatform, lanAddresses, peerIdFor, type LanSyncBridge } from './lanSync';
import type { SyncPeer } from './lanProtocol';

export interface LanSetupOptions {
  context: vscode.ExtensionContext;
  output: vscode.LogOutputChannel;
  chat: {
    setLanSync(service: LanSyncService | undefined): void;
    runSyncRequirement(requirement: import('./lanProtocol').SyncRequirement): Promise<boolean>;
    runSyncNote(note: import('./lanProtocol').SyncNote): Promise<boolean>;
  };
  version: string;
}

export interface LanSetupResult {
  service: LanSyncService;
  disposables: vscode.Disposable[];
}

/** 本机身份：同一台机器每次都得到同一个 id，换机才不同。 */
export function localPeer(input: {
  deviceName: string;
  version: string;
  project: string;
}): SyncPeer {
  const platform = defaultPlatform();
  const name = input.deviceName.trim() || defaultDeviceName();
  return {
    id: peerIdFor(`${name}:${platform}`),
    name,
    platform,
    project: input.project,
    version: input.version,
  };
}

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('hwchat').get<T>(key, fallback);
}

/** 当前工作区里写账本的目录（多根工作区取第一个，和「项目根」的口径一致）。 */
function ledgerTarget(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return folder.uri.fsPath;
}

export async function setupLanSync(options: LanSetupOptions): Promise<LanSetupResult> {
  const { context, output, chat } = options;
  let deviceName = setting('lanSync.deviceName', '');
  let project = ledgerTarget() ? basename(ledgerTarget()!) : 'workspace';

  const bridge: LanSyncBridge = {
    peer: () => localPeer({
      deviceName,
      version: options.version,
      project: ledgerTarget() ? basename(ledgerTarget()!) : project,
    }),
    runRequirement: (requirement) => chat.runSyncRequirement(requirement),
    runNote: (note) => chat.runSyncNote(note),
    async writeLedger(markdown: string): Promise<void> {
      const root = ledgerTarget();
      if (!root) return;
      const target = join(root, ALIGNMENT_FILE);
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, markdown, 'utf8');
      } catch (error) {
        output.warn(`[sync] 写账本失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    log: (line, level) => {
      if (level === 'warn') output.warn(line);
      else output.info(line);
    },
  };

  const service = new LanSyncService(join(context.globalStorageUri.fsPath, 'lan-sync.json'), bridge);
  await service.load();
  // 设置里填了配对码就以设置为准：两台设备填同一个值才能互通。
  const configuredCode = setting('lanSync.pairingCode', '').trim();
  if (configuredCode) await service.setPairingCode(configuredCode);

  // 状态栏：一眼看到「现在是主机还是已加入、几台设备、几处待对齐」。
  const status = vscode.window.createStatusBarItem('hwchat.lanSync', vscode.StatusBarAlignment.Right, 90);
  status.command = 'hwchat.lanSync.status';
  const refreshStatus = (): void => {
    const state = service.state();
    if (state.role === 'off') {
      status.hide();
      return;
    }
    status.text = `$(broadcast) ${state.peers}台 · ${state.divergences ? `${state.divergences}处待对齐` : '已对齐'}`;
    status.tooltip = state.text;
    status.show();
  };
  bridge.onState = refreshStatus;
  chat.setLanSync(service);
  refreshStatus();

  const disposables: vscode.Disposable[] = [
    status,
    service,
    vscode.commands.registerCommand('hwchat.lanSync.start', async () => {
      const result = await service.startHub(setting('lanSync.port', 47821));
      await vscode.window.showInformationMessage(
        result.ok
          ? `${result.message}\n本机地址：${lanAddresses().join(' / ') || '（未发现局域网地址）'}\n配对码：${service.pairingCode()}`
          : result.message,
      );
      refreshStatus();
    }),
    vscode.commands.registerCommand('hwchat.lanSync.join', async () => {
      const address = await vscode.window.showInputBox({
        title: '加入另一台设备（局域网同步）— 1/2 主机地址',
        prompt: '留空会自动在同一个 WiFi 里寻找主机；也可以直接填主机的局域网 IP',
        placeHolder: '192.168.1.20',
        value: '',
        ignoreFocusOut: true,
      });
      if (address === undefined) return;
      const code = await vscode.window.showInputBox({
        title: '加入另一台设备（局域网同步）— 2/2 配对码',
        prompt: '两台设备必须用同一个配对码。主机上「启动主机」后会显示它自己的配对码，照抄过来即可。',
        value: service.pairingCode(),
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length >= 4 ? undefined : '配对码至少 4 位'),
      });
      if (code === undefined) return;
      await service.setPairingCode(code);
      const port = setting('lanSync.port', 47821);
      const result = await service.joinHub(address.trim() || undefined, port);
      await vscode.window.showInformationMessage(result.message);
      refreshStatus();
    }),
    vscode.commands.registerCommand('hwchat.lanSync.stop', () => {
      service.stop();
      refreshStatus();
      void vscode.window.showInformationMessage('局域网同步已停止（本机不再监听，也不再接收队友消息）。');
    }),
    vscode.commands.registerCommand('hwchat.lanSync.status', async () => {
      const state = service.state();
      const requirements = service.requirementTitles(6);
      const notes = service.recentNotes(6);
      const lines = [
        state.text,
        `配对码：${service.pairingCode()}`,
        `本机地址：${lanAddresses().join(' / ') || '（未发现局域网地址）'}`,
        '',
        requirements.length ? `最近需求：\n${requirements.join('\n')}` : '最近需求：（无）',
        '',
        notes.length ? `最近队友消息：\n${notes.map((note) => `${note.from.name}：${note.body.slice(0, 120)}`).join('\n')}` : '最近队友消息：（无）',
      ];
      for (const line of lines) output.info(line);
      output.show(true);
      await vscode.window.showInformationMessage(state.text, '打开对齐账本').then(async (choice) => {
        if (choice) await vscode.commands.executeCommand('hwchat.lanSync.openLedger');
      });
    }),
    vscode.commands.registerCommand('hwchat.lanSync.openLedger', async () => {
      const root = ledgerTarget();
      if (!root) {
        void vscode.window.showWarningMessage('当前没有打开工作区，无法定位对齐账本。');
        return;
      }
      await service.syncLedger();
      const target = vscode.Uri.file(join(root, ALIGNMENT_FILE));
      try {
        await vscode.workspace.fs.stat(target);
      } catch {
        void vscode.window.showInformationMessage('还没有跨平台需求，账本要等第一条需求之后才会生成。');
        return;
      }
      await vscode.window.showTextDocument(target, { preview: true });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('hwchat.lanSync')) return;
      deviceName = setting('lanSync.deviceName', '');
      project = ledgerTarget() ? basename(ledgerTarget()!) : project;
    }),
  ];

  // 设置里勾了「启用」就在激活时自动起主机模式（没有对端时也只是一个安静的监听）。
  if (setting('lanSync.enabled', false)) {
    const started = await service.startHub(setting('lanSync.port', 47821));
    if (!started.ok) output.warn(`[sync] 自动启动失败：${started.message}`);
    refreshStatus();
  }

  return { service, disposables };
}
