import assert from 'node:assert/strict';
import test from 'node:test';
import { commandSummary, redactCommandForSummary } from '../agent/toolExecutor';
import { formatDecisionAnswer, normalizeDecision } from '../core/decisionGate';

/**
 * 两件事一起测：
 *  1. **命令摘要要能读出「在干什么」** —— 用户截图里一次运行有 20 多行「命令退出码 0」，
 *     完全看不出在做什么，这正是「闷头做」在界面上的样子；
 *  2. **方案决策的选项必须完整** —— 缺「代价」等于告诉用户那是免费的；缺「做到什么地步」
 *     等于让用户以为全做完了。用户明确要求每项都写清「能做成什么 / 做到什么地步 / 代价」。
 */

test('命令摘要：带上命令本身与耗时，不再只有退出码', () => {
  const summary = commandSummary('npm test', { code: 0, timedOut: false }, 120, 12_400);
  assert.match(summary, /npm test/);
  assert.match(summary, /0/);
  assert.match(summary, /12\.4s/);
  assert.doesNotMatch(summary, /^命令退出码 0$/, '不能退回旧文案');
});

test('命令摘要：失败也算退出码与耗时', () => {
  const summary = commandSummary('tsc --noEmit', { code: 1, timedOut: false }, 120, 3_100);
  assert.match(summary, /tsc --noEmit/);
  assert.match(summary, /1/);
  assert.match(summary, /3\.1s/);
});

test('命令摘要：超时走另一套文案，并说清多少秒', () => {
  const summary = commandSummary('npm run dev', { code: null, timedOut: true }, 120);
  assert.match(summary, /npm run dev/);
  assert.match(summary, /120/);
  assert.doesNotMatch(summary, /12\.4s/, '超时没有耗时概念');
});

test('命令摘要：没有耗时数据时不编造秒数', () => {
  const summary = commandSummary('ls', { code: 0, timedOut: false }, 120);
  assert.doesNotMatch(summary, /·\s*\ds/, `不该出现耗时：${summary}`);
});

test('命令摘要：多行命令压成一行（列表一行放得下）', () => {
  const summary = commandSummary('cd app &&\n  npm ci &&\n  npm test', { code: 0, timedOut: false }, 120, 1_000);
  assert.doesNotMatch(summary, /\n/, '摘要里不能有换行');
  assert.match(summary, /cd app && npm ci && npm test/);
});

test('命令摘要：超长命令截断并显式加省略号', () => {
  const long = `node -e "${'x'.repeat(300)}"`;
  const summary = commandSummary(long, { code: 0, timedOut: false }, 120, 800);
  assert.match(summary, /…/, '超长要显式省略，不能静默截');
  assert.ok(summary.length < 140, `摘要不该过长：${summary.length}`);
});

test('命令摘要：凭据必须脱敏（摘要会进界面与审计）', () => {
  const withHeader = redactCommandForSummary('curl -H "Authorization: Bearer sk-live-abcdef123456" https://api.example.com');
  assert.doesNotMatch(withHeader, /sk-live-abcdef123456/, withHeader);
  assert.match(withHeader, /Authorization: \*\*\*/);

  const withQuery = redactCommandForSummary('curl "https://example.com/data?token=deadbeef&page=2"');
  assert.doesNotMatch(withQuery, /deadbeef/, withQuery);
  assert.match(withQuery, /page=2/, '非敏感参数要保留，否则认不出命令');

  const withEnv = redactCommandForSummary('API_KEY=abc123 npm run deploy');
  assert.doesNotMatch(withEnv, /abc123/, withEnv);
});

test('命令摘要：正常命令不被误改', () => {
  assert.equal(redactCommandForSummary('git status --short'), 'git status --short');
  assert.equal(redactCommandForSummary('npm run build'), 'npm run build');
});

// ── 方案决策 ──────────────────────────────────────────────

const goodOption = {
  title: '独立窗口',
  achieves: '可以单独拖动、单独快捷键唤出',
  extent: '只做 mac，Windows 留空；多屏拖拽粗糙',
  cost: '约 2 天；新增一个进程；后续要处理焦点与置顶',
};

test('决策：完整选项直接通过，字段原样保留', () => {
  const result = normalizeDecision({ question: '窗口怎么做？', why: '做完再改要重做交互', options: [goodOption, { ...goodOption, title: '嵌进面板' }] });
  assert.ok(!('error' in result), JSON.stringify(result));
  if ('error' in result) return;
  assert.equal(result.request.question, '窗口怎么做？');
  assert.equal(result.request.why, '做完再改要重做交互');
  assert.equal(result.request.options.length, 2);
  assert.equal(result.request.options[0]!.cost, goodOption.cost);
});

test('决策：少于两个选项 → 拒绝（只给一个等于没得选）', () => {
  const result = normalizeDecision({ question: '怎么做？', options: [goodOption] });
  assert.ok('error' in result);
  assert.match((result as { error: string }).error, /至少需要 2 个选项/);
});

test('决策：缺「代价」→ 拒绝，并说清缺什么', () => {
  const { cost, ...withoutCost } = goodOption;
  void cost;
  const result = normalizeDecision({ question: '怎么做？', options: [withoutCost, goodOption] });
  assert.ok('error' in result);
  const message = (result as { error: string }).error;
  assert.match(message, /cost/);
  assert.match(message, /代价/);
});

test('决策：缺「能做成什么」或「做到什么地步」都要拒绝', () => {
  for (const key of ['achieves', 'extent', 'title'] as const) {
    const incomplete: Record<string, unknown> = { ...goodOption };
    delete incomplete[key];
    const result = normalizeDecision({ question: '怎么做？', options: [incomplete, goodOption] });
    assert.ok('error' in result, `缺 ${key} 时应拒绝`);
  }
});

test('决策：问题为空 → 拒绝', () => {
  const result = normalizeDecision({ question: '   ', options: [goodOption, goodOption] });
  assert.ok('error' in result);
});

test('决策：超过上限只留前 5 个，并给出提示', () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ ...goodOption, title: `方案 ${index + 1}` }));
  const result = normalizeDecision({ question: '怎么做？', options: many });
  assert.ok(!('error' in result));
  if ('error' in result) return;
  assert.equal(result.request.options.length, 5);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /只保留前 5 个/);
});

test('决策：接受 canDo / scope 这类别名（模型偶尔换个字段名）', () => {
  const result = normalizeDecision({
    question: '怎么做？',
    options: [
      { title: 'A', canDo: '能做 X', scope: '只做一半', cost: '1 天' },
      { title: 'B', achieves: '能做 Y', extent: '做全', cost: '2 天' },
    ],
  });
  assert.ok(!('error' in result));
  if ('error' in result) return;
  assert.equal(result.request.options[0]!.achieves, '能做 X');
  assert.equal(result.request.options[0]!.extent, '只做一半');
});

test('决策：工具结果把用户选的那一项完整回传给模型，并禁止擅自换方案', () => {
  const result = normalizeDecision({ question: '怎么做？', options: [goodOption, { ...goodOption, title: '嵌进面板' }] });
  assert.ok(!('error' in result));
  if ('error' in result) return;
  const text = formatDecisionAnswer(result.request, 1);
  assert.match(text, /用户选择了方案 2：嵌进面板/);
  assert.match(text, /能做成什么/);
  assert.match(text, /做到什么地步/);
  assert.match(text, /代价/);
  assert.match(text, /不要自己换一个方案/, '必须禁止模型擅自换方案继续做');
});

test('决策：下标越界（界面传了脏数据）不崩，返回可读结果', () => {
  const result = normalizeDecision({ question: '怎么做？', options: [goodOption, goodOption] });
  assert.ok(!('error' in result));
  if ('error' in result) return;
  assert.match(formatDecisionAnswer(result.request, 99), /没有选择任何方案/);
});
