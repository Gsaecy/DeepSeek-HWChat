import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_DETAIL_CHARS,
  buildLedger,
  clip,
  groupAgreement,
  makeGroupMessage,
  renderGroupTranscript,
  findDivergences,
  makeNote,
  makeReport,
  makeRequirement,
  notePromptForLocal,
  pairingMatches,
  parseSyncMessage,
  renderLedger,
  requirementPromptForLocal,
  shouldAutoRespond,
  type SyncPeer,
} from '../sync/lanProtocol';

/**
 * 局域网跨平台对齐（用户 2026-11-23）：
 * 「Windows 版本和 macOS 版本经常两边功能对不齐，甚至有差别」
 * 「一个设备上发起更新功能需求，两边能一起执行」「两边的 agent 像同事一样沟通」。
 *
 * 这里钉住三件事：网络输入必须校验、账本能指出分歧、agent 之间不会互相客套刷屏。
 */

const win: SyncPeer = { id: 'p-win', name: 'PC · Windows', platform: 'win32', project: 'app-windows', version: '0.4.26' };
const mac: SyncPeer = { id: 'p-mac', name: 'MacBook · macOS', platform: 'darwin', project: 'app-macos', version: '0.4.26' };

test('需求：正文按上限截断，标题取第一行，id 稳定且带时间', () => {
  const requirement = makeRequirement(win, '一\n' + 'x'.repeat(MAX_DETAIL_CHARS + 500), 1000, 'seed');
  assert.ok(requirement);
  assert.equal(requirement!.title, '一');
  assert.ok(requirement!.detail.length <= MAX_DETAIL_CHARS);
  assert.match(requirement!.id, /^r/);
  assert.equal(makeRequirement(win, 'a', 1000, 'seed')!.id, requirement!.id, '同样的时间与种子必须给出同样的 id');
  assert.notEqual(makeRequirement(win, 'a', 1001, 'seed')!.id, requirement!.id);
});

test('网络输入：畸形与超长一律丢弃，不抛异常', () => {
  assert.equal(parseSyncMessage('not json'), undefined);
  assert.equal(parseSyncMessage({ kind: 'requirement' }), undefined, '缺 from 直接丢');
  assert.equal(parseSyncMessage({ kind: 'requirement', from: win, id: 'r1' }), undefined, '缺正文直接丢');
  assert.equal(parseSyncMessage({ kind: 'unknown', from: win }), undefined);
  assert.equal(parseSyncMessage('x'.repeat(200_000)), undefined, '超长不解析');

  const parsed = parseSyncMessage({ kind: 'requirement', from: { id: 'a' }, id: 'r1', detail: 'do it' });
  assert.ok(parsed && parsed.kind === 'requirement');
  assert.equal(parsed!.from.platform, 'linux', '未知平台回落到 linux 而不是崩掉');
});

test('协作消息：解析、正文截断、replyTo 保留', () => {
  const note = makeNote(mac, { body: '这边标题栏改成了自绘，你那边的窗口边距要不要一起调？', topic: '窗口' }, 5, 'seed');
  assert.ok(note);
  const parsed = parseSyncMessage(JSON.parse(JSON.stringify(note)));
  assert.ok(parsed && parsed.kind === 'note');
  assert.equal(parsed!.topic, '窗口');
  assert.equal(parsed!.replyTo, '');
  assert.ok(makeNote(mac, { body: '   ' }) === undefined, '空消息不该产生记录');
});

test('账本：同一平台多条报告只留最新一条', () => {
  const requirement = makeRequirement(win, '加托盘图标', 1, 'r')!;
  const rows = buildLedger([requirement], [
    makeReport(win, { requirementId: requirement.id, status: 'planned', summary: '计划中' }, 10),
    makeReport(win, { requirementId: requirement.id, status: 'done', summary: '已实现' }, 20),
    makeReport(mac, { requirementId: requirement.id, status: 'done', summary: '已实现', files: ['src/tray.swift'] }, 30),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reports.win32?.status, 'done', '要最终状态不是流水账');
  assert.equal(rows[0]!.reports.darwin?.files[0], 'src/tray.swift');
});

test('分歧：一边做完、另一边跳过 → 必须被点名', () => {
  const requirement = makeRequirement(win, '加托盘图标', 1, 'r')!;
  const rows = buildLedger([requirement], [
    makeReport(win, { requirementId: requirement.id, status: 'done', summary: '已实现' }, 10),
    makeReport(mac, { requirementId: requirement.id, status: 'skipped', note: 'macOS 没有系统托盘' }, 20),
  ]);
  const divergences = findDivergences(rows);
  assert.equal(divergences.length, 1);
  assert.deepEqual(divergences[0]!.doneOn, ['win32']);
  assert.deepEqual(divergences[0]!.skippedOn, ['darwin']);
  assert.match(divergences[0]!.skippedNotes.join(''), /没有系统托盘/);
});

test('分歧：只有「一端完成、另一端明确跳过」才算，缺失与进行中不算', () => {
  const requirement = makeRequirement(win, '加托盘图标', 1, 'r')!;
  const onlyOne = buildLedger([requirement], [
    makeReport(win, { requirementId: requirement.id, status: 'done' }, 10),
  ]);
  assert.equal(findDivergences(onlyOne).length, 0, '没人加入时不该报警');

  const inProgress = buildLedger([requirement], [
    makeReport(win, { requirementId: requirement.id, status: 'done' }, 10),
    makeReport(mac, { requirementId: requirement.id, status: 'in_progress', summary: '正在做' }, 20),
  ]);
  assert.equal(findDivergences(inProgress).length, 0, '另一端还在做属于进行中，不是分歧');

  const bothDone = buildLedger([requirement], [
    makeReport(win, { requirementId: requirement.id, status: 'done' }, 10),
    makeReport(mac, { requirementId: requirement.id, status: 'done' }, 20),
  ]);
  assert.equal(findDivergences(bothDone).length, 0, '两端都完成就是对齐的');
});

test('账本渲染：表格 + 差异小节，竖线不会把表格拆坏', () => {
  const requirement = makeRequirement(win, '支持 | 竖线标题', 1, 'r')!;
  const rows = buildLedger([requirement], [
    makeReport(win, { requirementId: requirement.id, status: 'done', summary: '好' }, 10),
    makeReport(mac, { requirementId: requirement.id, status: 'skipped', note: '做不了' }, 20),
  ]);
  const markdown = renderLedger(rows, 100);
  assert.match(markdown, /# 跨平台对齐账本/);
  assert.match(markdown, /支持 \\\| 竖线标题/, '单元格里的竖线要转义');
  assert.match(markdown, /## 需要对齐的差异/);
  assert.match(markdown, /macOS 已跳过/);
  assert.match(markdown, /做不了/);
});

test('空账本也给出可读文件，而不是空字符串', () => {
  const markdown = renderLedger([], 100);
  assert.match(markdown, /还没有跨平台需求/);
});

test('收到需求时的本地指令：按甲方的话解析、不确定先追问、达成一致才动手', () => {
  const requirement = makeRequirement(win, '在 Windows 上把设置页改成 Mica 材质', 1, 'r')!;
  const prompt = requirementPromptForLocal(requirement, mac, ['Windows · 乙方（产品经理）· 需求解析：把设置页做成半透明']);
  assert.match(prompt, /macOS/, '必须点名本机平台');
  assert.match(prompt, /甲方/, '要按甲乙方角色说话');
  assert.match(prompt, /不要出现变量名/, '解析必须用甲方听得懂的话');
  assert.match(prompt, /team_sync action=question/, '不确定必须追问');
  assert.match(prompt, /停下来等甲方回答/, '追问后必须停下，不许猜着做');
  assert.match(prompt, /team_sync action=confirm/, '达成一致后要发确认单');
  assert.match(prompt, /team_sync action=result/, '做完要报结果');
  assert.match(prompt, /PLATFORM-ALIGNMENT\.md/, '要写进共享账本');
  assert.match(prompt, /在 Windows 上把设置页改成 Mica 材质/, '原需求原文必须完整保留');
  assert.match(prompt, /队友说过的/, '要把群里的发言一起给它，避免重复提问');
});

test('对齐状态：追问 → 等甲方；甲方回答 → 等乙方；确认 → 可执行；结果 → 完成', () => {
  const requirement = makeRequirement(win, '加个深色开关', 1, 'r')!;
  const rid = requirement.id;
  const base = makeGroupMessage(win, { author: 'user', phase: 'requirement', body: '加个深色开关', requirementId: rid }, 10, 'g1')!;
  const analysis = makeGroupMessage(mac, { author: 'agent', phase: 'analysis', body: '我理解是设置页加开关', requirementId: rid }, 11, 'g2')!;
  const question = makeGroupMessage(mac, { author: 'agent', phase: 'question', body: '要跟随系统还是手动？', requirementId: rid }, 12, 'g3')!;
  const answer = makeGroupMessage(win, { author: 'user', phase: 'answer', body: '跟随系统就行', requirementId: rid }, 13, 'g4')!;
  const confirm = makeGroupMessage(mac, { author: 'agent', phase: 'confirm', body: '确认：跟随系统深浅色', requirementId: rid }, 14, 'g5')!;
  const result = makeGroupMessage(mac, { author: 'agent', phase: 'result', body: '已完成', requirementId: rid }, 15, 'g6')!;

  const withRequirement = [base];
  assert.equal(groupAgreement(withRequirement, rid), 'awaiting-analysis');
  assert.equal(groupAgreement([...withRequirement, analysis], rid), 'awaiting-analysis');
  assert.equal(groupAgreement([...withRequirement, analysis, question], rid), 'awaiting-user');
  assert.equal(groupAgreement([...withRequirement, analysis, question, answer], rid), 'awaiting-analysis');
  assert.equal(groupAgreement([...withRequirement, analysis, question, answer, confirm], rid), 'agreed');
  assert.equal(groupAgreement([...withRequirement, analysis, question, answer, confirm, result], rid), 'done');
});

test('群记录：按需求分组、标出甲乙方、不塞工具流水', () => {
  const requirement = makeRequirement(win, '加个深色开关', 1, 'r')!;
  const messages = [
    makeGroupMessage(win, { author: 'user', phase: 'requirement', body: '设置页加个深色开关', requirementId: requirement.id }, 10, 'a')!,
    makeGroupMessage(mac, { author: 'agent', phase: 'question', body: '跟随系统还是手动选？', requirementId: requirement.id }, 11, 'b')!,
  ];
  const markdown = renderGroupTranscript(messages, 100);
  assert.match(markdown, /# 团队群记录/);
  assert.match(markdown, /甲方/);
  assert.match(markdown, /乙方（产品经理）/);
  assert.match(markdown, /追问/);
  assert.match(markdown, /设置页加个深色开关/);
  assert.match(markdown, /需求 r/, '按需求分组');
});

test('队友消息的本地指令：先判断要不要动手，不要为了回应改代码', () => {
  const note = makeNote(mac, { body: '我把标题栏改成自绘了' }, 1, 's')!;
  const prompt = notePromptForLocal(note, win);
  assert.match(prompt, /队友消息/);
  assert.match(prompt, /Windows/);
  assert.match(prompt, /不要为了回应而改代码/);
  assert.match(prompt, /team_sync/);
  assert.match(prompt, new RegExp(note.id), 'replyTo 要给出这条消息的 id');
});

test('防接龙：只有真的在问或明确请求才自动跑一轮', () => {
  const statement = makeNote(mac, { body: '这边已经改好了' }, 1, 'a')!;
  assert.equal(shouldAutoRespond(statement), false, '纯陈述不该让对端开跑');

  const question = makeNote(mac, { body: '你那边的窗口边距是多少？' }, 1, 'b')!;
  assert.equal(shouldAutoRespond(question), true);

  const request = makeNote(mac, { body: '请把托盘图标的尺寸改成 16' }, 1, 'c')!;
  assert.equal(shouldAutoRespond(request), true);

  const english = makeNote(mac, { body: 'could you check the tray icon size' }, 1, 'd')!;
  assert.equal(shouldAutoRespond(english), true);
});

test('配对码比对：必须完全一致，长度不同也不泄露', () => {
  assert.equal(pairingMatches('ABCD-1234', 'ABCD-1234'), true);
  assert.equal(pairingMatches('ABCD-1235', 'ABCD-1234'), false);
  assert.equal(pairingMatches('ABCD-123', 'ABCD-1234'), false);
  assert.equal(pairingMatches(undefined, 'ABCD-1234'), false);
  assert.equal(pairingMatches('', ''), false, '空配对码永不通过');
});

test('clip：压平空白并截断，超长补省略号', () => {
  assert.equal(clip('  a\n b  ', 10), 'a b');
  assert.equal(clip('x'.repeat(20), 5), 'xxxx…');
  assert.equal(clip(123 as unknown, 5), '');
});
