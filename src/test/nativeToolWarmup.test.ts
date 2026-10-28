/**
 * 语言模型工具扩展的预热行为。
 *
 * 现场（真实故障链）：HWChat 在 `onStartupFinished` 就会激活，旧代码在构造
 * ChatPanel 一秒钟后无条件调用 `warmToolContributors()`，对**所有**声明了
 * `languageModelTools` 的扩展执行 `extension.activate()`。本机日志里可以直接
 * 看到这条链（`root cause: honor-world.hwchat`）。在装了 Copilot Chat、
 * Claude Code、Codex 这类重扩展的机器上，等于「装了 HWChat，开机就被别人吃 CPU」。
 *
 * 现在只在打开聊天面板 / 发送消息时预热，并且只预热声明了语言模型工具的扩展；
 * 所有调用方共享同一次预热（否则 `send()` 会在激活完成前就去读工具列表）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { VscodeToolBridge } from '../agent/vscodeTools';
import type { ToolExecutor } from '../agent/toolExecutor';
import { extensions } from './support/vscodeMock';

interface FakeExtension {
  isActive: boolean;
  packageJSON?: unknown;
  activate: () => Promise<void>;
}

const bridge = new VscodeToolBridge({} as unknown as ToolExecutor);

function resetExtensions(...items: FakeExtension[]): void {
  extensions.all.splice(0, extensions.all.length, ...items);
}

test('native tools: only language-model-tool contributors are activated', async () => {
  let contribActivations = 0;
  let unrelatedActivations = 0;
  resetExtensions(
    { isActive: false, packageJSON: { contributes: { languageModelTools: [{ name: 'a' }] } }, activate: async () => { contribActivations += 1; } },
    { isActive: false, packageJSON: { activationEvents: ['onLanguageModelTool:b'] }, activate: async () => { contribActivations += 1; } },
    { isActive: false, packageJSON: { contributes: { commands: [] } }, activate: async () => { unrelatedActivations += 1; } },
    { isActive: true, packageJSON: { contributes: { languageModelTools: [{ name: 'c' }] } }, activate: async () => { contribActivations += 1; } },
  );

  await new VscodeToolBridge({} as unknown as ToolExecutor).warmToolContributors();

  assert.equal(contribActivations, 2, '只激活尚未运行、且贡献了语言模型工具的扩展');
  assert.equal(unrelatedActivations, 0, '无关扩展不得因为 HWChat 而被拉起');
  resetExtensions();
});

test('native tools: concurrent callers share one warm-up and all await it', async () => {
  let activations = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  resetExtensions({
    isActive: false,
    packageJSON: { contributes: { languageModelTools: [{ name: 'slow' }] } },
    activate: async () => {
      activations += 1;
      await gate;
    },
  });

  const instance = new VscodeToolBridge({} as unknown as ToolExecutor);
  const first = instance.warmToolContributors();
  const second = instance.warmToolContributors();
  assert.equal(first, second, '并发调用必须共享同一个预热 Promise');

  let settled = false;
  void first.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, '预热未完成时不得提前 resolve（否则工具列表会缺项）');

  release?.();
  await Promise.all([first, second]);
  assert.equal(activations, 1, '只激活一次');

  await instance.warmToolContributors();
  assert.equal(activations, 1, '再次调用不应重复激活');
  resetExtensions();
});

test('native tools: a failing extension does not break the warm-up', async () => {
  resetExtensions(
    { isActive: false, packageJSON: { contributes: { languageModelTools: [{ name: 'bad' }] } }, activate: async () => { throw new Error('boom'); } },
    { isActive: false, packageJSON: { contributes: { languageModelTools: [{ name: 'good' }] } }, activate: async () => undefined },
  );

  await assert.doesNotReject(bridge.warmToolContributors());
  resetExtensions();
});
