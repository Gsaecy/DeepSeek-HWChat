/**
 * 「方案决策」闸门：让 agent 在关键岔路口停下来，把选项摆给用户挑。
 *
 * 用户原话（2026-10-31）：「hwchat 只会闷着头执行，也不和我沟通，经常导致做出来的
 * 东西不能用。有没有办法，让它在遇到方案决策的时候，告诉我每个方案能做成什么、
 * 做到什么地步、代价是什么，让我决策。而不是闷头做，结果做出一堆不能用毫无逻辑的东西。」
 *
 * 为什么只写提示词不够、必须给一个**工具**：
 * 文本里问一句「你希望 A 还是 B？」会把决定埋在几十行输出的中间，而且 agent 可以
 * 自己往下猜一个继续做。有了 `ask_user_choice` 这个工具，问句会变成面板里一张
 * 可点的卡片，并且工具**在用户回答前不返回** —— agent 想往下走也走不了。
 *
 * 为什么每项必须写清「能做成什么 / 做到什么地步 / 代价」：
 * 只说「方案 A / 方案 B」等于把决策成本推回给用户。用户要的是能据此拍板的对比，
 * 所以这三项在 schema 里都是必填，缺一个就不接受。
 */

/** 一次最多几个选项：超过 5 个，用户又得做一轮筛选。 */
export const MAX_DECISION_OPTIONS = 5;
export const MIN_DECISION_OPTIONS = 2;

export interface DecisionOption {
  /** 一句话说清这个方案是什么（动词开头，别用抽象名次）。 */
  title: string;
  /** 做成之后用户能得到什么（看得见的结果）。 */
  achieves: string;
  /** 做到什么地步：范围内 / 范围外，以及哪里是已知的粗糙处。 */
  extent: string;
  /** 代价：时间、改动面、风险、后续维护。 */
  cost: string;
}

export interface DecisionRequest {
  /** 需要用户拍板的问题本身（一句话）。 */
  question: string;
  /** 为什么现在必须问 —— 不问会错在哪。 */
  why?: string;
  options: DecisionOption[];
}

export interface NormalizedDecision {
  request: DecisionRequest;
  /** 提示给调用方的规整问题（例如选项被裁剪）。 */
  warnings: string[];
}

const FIELD_LIMITS = { title: 80, achieves: 200, extent: 200, cost: 200, question: 200, why: 240 } as const;

function text(value: unknown, limit: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * 校验并规整模型给的选项。
 *
 * 宁可**拒绝**也不接受残缺的方案：少了「代价」的方案会让用户以为那是免费的，
 * 少了「做到什么地步」的方案会让用户以为它全做完了 —— 这正是用户抱怨的
 * 「做出一堆不能用的东西」的来源之一。所以缺字段时返回 `error`，让模型补。
 */
export function normalizeDecision(raw: unknown): NormalizedDecision | { error: string } {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const question = text(record.question, FIELD_LIMITS.question);
  if (!question) return { error: 'question 不能为空：一句话说清要用户决定什么。' };
  const list = Array.isArray(record.options) ? record.options : [];
  if (list.length < MIN_DECISION_OPTIONS) {
    return { error: `至少需要 ${MIN_DECISION_OPTIONS} 个选项（只给一个等于没得选，那就不要问，直接说明你要怎么做）。` };
  }
  const warnings: string[] = [];
  if (list.length > MAX_DECISION_OPTIONS) {
    warnings.push(`只保留前 ${MAX_DECISION_OPTIONS} 个选项（一次给太多等于让用户再筛一轮）。`);
  }
  const options: DecisionOption[] = [];
  for (const entry of list.slice(0, MAX_DECISION_OPTIONS)) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const option: DecisionOption = {
      title: text(item.title, FIELD_LIMITS.title),
      achieves: text(item.achieves ?? item.canDo, FIELD_LIMITS.achieves),
      extent: text(item.extent ?? item.scope, FIELD_LIMITS.extent),
      cost: text(item.cost, FIELD_LIMITS.cost),
    };
    const missing = (['title', 'achieves', 'extent', 'cost'] as const).filter((key) => !option[key]);
    if (missing.length) {
      return {
        error: `第 ${options.length + 1} 个选项缺少 ${missing.join(' / ')}。每个选项都必须写清：能做成什么（achieves）、做到什么地步（extent）、代价是什么（cost）—— 只说「方案 A/B」等于没给用户判断依据。`,
      };
    }
    options.push(option);
  }
  return {
    request: { question, why: text(record.why, FIELD_LIMITS.why) || undefined, options },
    warnings,
  };
}

/** 工具说明：把「什么时候该问」直接写进工具描述，模型才会在对的时机调用。 */
export const DECISION_TOOL_DESCRIPTION = [
  'Ask the user to choose between concrete approaches before you build the wrong thing.',
  'Use it when different approaches lead to materially different results, scope or cost, when the requirement leaves a real choice open, or when the work is hard to undo.',
  'Do NOT use it for trivial or single-obvious-way decisions, for things you can settle by reading the code, or when the user already decided.',
  'While the user is deciding, the tool does not return — do not start implementing, do not guess a default, and do not send the same question twice.',
  'Keep question and the three per-option fields short (one line each): the card must stay readable, and it can be collapsed by the user while they re-read the conversation.',
  'Every option MUST fill in: achieves (what the user visibly gets), extent (how far it goes, including what it deliberately leaves out and where it is rough), cost (time, blast radius, risk, follow-up maintenance).',
].join(' ');

/**
 * 系统提示词里的「决策闸门」规则。
 *
 * 只写「遇到决策要问」会把 agent 变成每步都问 —— 那是另一种不能用。所以这一条同时
 * 定义了**必须问**与**不许问**两组条件，并强制每个选项带三项对比。
 */
export const DECISION_GATE_PROMPT = [
  'Before implementing, find the decision points and hand the choice to the user instead of deciding silently.',
  'You MUST stop and ask with ask_user_choice when any of these is true:',
  '(1) two or more approaches are genuinely viable and lead to materially different user-visible outcomes;',
  '(2) the requirement leaves a real choice open (which entry point, which data source, how far to go, replace vs. extend);',
  '(3) the change is expensive or hard to undo (data migration, protocol/format change, deleting working code, public API);',
  '(4) you are about to build something the user can only judge by looking at it (a UI, a flow, a generated artifact) and the layout/behaviour was not specified.',
  'Do NOT ask when: there is only one reasonable way; the answer is already in the code or the conversation; the choice is cosmetic and reversible; the user already decided; or it is a routine step of a plan the user approved.',
  'When you ask, every option must state three things in the user\'s terms: what it will be able to do (achieves), how far it goes and where it is still rough (extent), and what it costs (cost: time, blast radius, risk, follow-up). Never present bare labels like "Option A / Option B".',
  'State plainly which option you recommend and why, but never act before the answer arrives. If the user picks an option, follow it; if the user says "you decide", pick the recommended one and say so in one line.',
  'If you already started implementing and then discover a decision point, stop at the next safe boundary (a completed, verified step), explain what is done, and ask before continuing.',
  'The user may answer in their own words instead of picking an option — that answer replaces the options entirely. Follow their approach, do not map it onto one of your options, and do not add scope they did not ask for.',
].join(' ');

/**
 * 用户没选任何预设、自己写了做法时，回给模型的工具结果。
 *
 * 这是必须支持的一条路：三个方案都不合意时，用户不该被逼着选一个「最不差」的。
 * 而且要**明确禁止**模型把它硬套进某个预设方案 —— 用户给的是自己的做法，不是
 * 「方案 2 的变体」。
 */
export function formatCustomDecisionAnswer(request: DecisionRequest, custom: string): string {
  const text = String(custom ?? '').trim();
  if (!text) return formatDecisionAnswer(request, -1);
  return [
    '用户没有采用你给的任何方案，而是自己给出了做法：',
    '<<<用户原话',
    text,
    '用户原话>>>',
    '',
    '按用户这个做法继续。不要把它套成上面某个方案，也不要擅自补充用户没说过的范围；'
    + '如果你认为这个做法做不到、或与已完成的改动冲突，先说明原因再重新征询，不要自己改成别的方案。',
  ].join('\n');
}

/** 把用户的选择变成工具结果：模型据此继续，且知道「用户亲手选的」不许擅自改。 */
export function formatDecisionAnswer(request: DecisionRequest, chosenIndex: number): string {
  const option = request.options[chosenIndex];
  if (!option) return '用户没有选择任何方案（已取消）。';
  return [
    `用户选择了方案 ${chosenIndex + 1}：${option.title}`,
    `能做成什么：${option.achieves}`,
    `做到什么地步：${option.extent}`,
    `代价：${option.cost}`,
    '',
    '按这个方案继续。不要擅自扩大范围；如果你发现这个方案做不到用户期待的结果，先说明原因再重新征询，不要自己换一个方案继续做。',
  ].join('\n');
}
