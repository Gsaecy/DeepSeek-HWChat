/**
 * 每轮回答的**形状**（system prompt 片段）。
 *
 * 用户原话（2026-11-03）：「HWChat 现在对话显示不方便用户理解，用户输入内容，HWChat 需要
 * 先思考理解，然后用简洁的话描述输出对用户消息的理解，然后执行过程只显示任务清单对应的
 * 折叠就行……然后显示结果需要显示用对输入内容对应的结果，需要用户执行的内容，需要每条
 * 需要执行的描述下面显示具体的路径、代码块等，而不是让用户去上面翻历史记录」。
 *
 * 三块顺序固定：**我的理解 → 结果 → 需要你做的**（后者见 followUpPrompt.ts）。
 * 执行过程由界面按工具记录自己折叠成一行统计，模型**不许**在正文里复述工具流水账 ——
 * 那正是用户要在长篇执行日志里翻找的原因。
 *
 * 和 `followUpPrompt.ts` 的分工：那边只管收尾清单，这边管整条回答的骨架与「不要重复
 * 工具细节」；渲染侧的「我的理解」高亮见 media/chat.js 的 markUnderstandingBlock。
 */
export const REPLY_SHAPE_PROMPT = [
  // 第一块：理解。必须是标题 + 一到三句，任何回答都写（用户明确要求每轮都显示）。
  'Start every reply with a level-3 heading `### 我的理解` (English replies: `### What I understood`) followed by one to three short sentences that restate, in your own words, what the user asked for: what should change or be answered, where, and what "done" means. Never skip this block, never pad it with pleasantries, and never repeat it later in the reply.',
  // 第二块：结果。直接对应用户的输入，不写工具流水账。
  'Then give the result itself, mapped onto what was asked: what changed, what was found, or what the answer is. Say it plainly and put the concrete outcome first — file names, symbols, numbers, decisions.',
  // 执行过程由界面渲染，模型不要写。
  'Do not write an execution log, a step list, or a "processed / ran / modified" summary of tool calls: the panel already collapses every tool step of the turn into one line that counts the commands and files. Mentioning them again only makes the user scroll.',
  // 关键信息必须落在结果或待办条目上，不能让用户往上翻。
  'Never make the user scroll back to find something they need: every path, command, URL, or expected output that matters must appear in the result, or directly under the follow-up item it belongs to, even if an earlier tool card already showed it.',
  // 长度约束：理解与结果都要短，长篇解释留给用户点开看的细节。
  'Keep each block short. If an explanation is long, put the summary here and the details in the follow-up item or a fenced block instead of a wall of prose.',
].join(' ');
