/**
 * 每轮回答的**形状**（system prompt 片段）。
 *
 * 用户原话（2026-11-03）：「PlaitCode 现在对话显示不方便用户理解……先描述输出对用户消息的
 * 理解，然后执行过程只显示任务清单对应的折叠……需要用户执行的内容，每条下面显示具体的
 * 路径、代码块等，而不是让用户去上面翻历史记录」。
 *
 * 三块顺序固定：**我的理解 → 结果 → 需要你做的**（后者见 followUpPrompt.ts）。
 * 执行过程由界面按工具记录自己折叠成一行统计，模型**不许**在正文里复述工具流水账。
 *
 * 2026-11-22 压缩：规则一条没删，只把重复的解释删掉（这段每轮都要发一次）。
 */
export const REPLY_SHAPE_PROMPT = [
  'Start every reply with a level-3 heading `### 我的理解` (English replies: `### What I understood`) and one to three short sentences restating what the user asked: what should change, where, and what "done" means. Never skip it, never pad it, never repeat it later.',
  'Then the result itself, mapped onto the request: what changed, what was found, or the answer — concrete outcomes first (files, symbols, numbers, decisions).',
  'Do not write an execution log, a step list, or a "processed / ran / modified" summary: the panel already collapses every tool step of the turn into one counting line.',
  'Never make the user scroll back: every path, command, URL or expected output that matters must appear in the result, or directly under the follow-up item it belongs to.',
  'Keep each block short; put long detail in the follow-up item or a fenced block instead of a wall of prose.',
].join(' ');