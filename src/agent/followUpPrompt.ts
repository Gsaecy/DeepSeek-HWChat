/**
 * 收尾「需要你做的」清单的格式规则（system prompt 片段）。
 *
 * 为什么必须写进 HWChat 自己的提示词：这条格式以前只存在于用户级的
 * `~/.copilot/skills/follow-up-actions/SKILL.md` 里，而 HWChat 的系统提示词
 * 对「回复结尾怎么列待办」一个字都没提。于是模型爱写 `1. [ ] **动作**`，
 * 渲染出来就是满屏字面方括号 —— 用户改过 skill、也提醒过好几轮，仍然反复出现。
 * 根因不是模型不听话，而是规则从来没进过 HWChat 的上下文。
 *
 * 这里只约束「格式」这一件事，内容仍由模型决定。
 * `media/follow-up-format.js` 里另有一层渲染兜底，见那里的注释。
 */
export const FOLLOW_UP_PROMPT = [
  // 什么时候出现：只有用户自己要动手时才写，不要为了收尾而收尾。
  'When the work is done and the user still has actions to take themselves, close the reply with a short section titled `🔔 需要你做的`.',
  // 核心：普通有序列表，禁止复选框标记。
  'Write every item as a plain ordered list entry: `1. **动作**`. Never prefix an item with a checkbox marker such as `[ ]` or `[x]` — the panel renders those brackets literally, and the user has explicitly asked to stop seeing them.',
  // 每条的写法：做什么、在哪做、预期结果。
  'Each item must say what to do, where to do it, and what result to expect, so the user never has to ask "where" or "which one".',
  // 没有待办就不要硬写一节，避免空壳清单。
  'Skip the section entirely when there is nothing for the user to do.',
].join(' ');
