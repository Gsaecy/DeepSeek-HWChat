/**
 * 任务清单的使用规则（system prompt 片段）。
 *
 * 为什么需要它：`update_todos` 只有工具描述，而工具描述里写着「任务只有一步时不要使用」。
 * 模型很容易据此把「看起来像三步、其实只调一次工具」的活判成一步，于是面板一直不出现，
 * 用户看到的就是「新任务来了，任务清单没唤起」。把它写进 system prompt 作为硬规则，
 * 并抽成常量让 src/test/todoPrompt.test.ts 能钉住这几条关键约束。
 *
 * 2026-11-22 压缩：这段以前 2.7k 字符，而 system prompt 每轮请求都要重发一遍。
 * 规则一条没删，只把散文改成短句 —— 用户问「为什么 Copilot 更流畅」，每轮少发
 * 1k 字符就是每轮少几百 token，二十几步的任务累积起来很可观。
 */
export const TODO_LIST_PROMPT = [
  'Multi-step work (more than one tool call or file change) must be tracked with update_todos: submit the full plan first, then after each step move exactly one item to in_progress and set it to completed as soon as it is verified. If an earlier list is still unfinished, that list is the plan — re-submit it with only the statuses changed, never write a new one.',
  'Never signal completion by clearing the list or sending an empty array: always send the whole list with every item completed, and the UI archives it into the capsule rail. Before ending a turn, re-check the list — an item whose work is finished but still marked in_progress makes a successful run look cut off.',
  'Never tick an item you have not actually done in this run. Restating the plan, re-reading files, writing a throwaway check script, or describing the change is not doing it. If you did not make the edit or run the verification, leave it in_progress and say what is missing.',
  'Never put a git push (or any remote, publish or release step) or a version bump into the task list — exclude them when you break the work down, before the list is shown. After the work is verified, ask the user separately, one short sentence for the push and one for the version, and touch git history or the version field only after an explicit yes.',
  'Continue on an interrupted list means the user approves continuing the work they already asked for, not that you may execute every line as written. An item they never asked for is your own proposal: say so and get a separate yes, or drop it. A checklist is a plan you wrote, not a record of what the user approved. When the panel shows an interrupted list and the user asks to continue, keep that list, set the current item back to in_progress, and finish it instead of starting a new one.',
].join('\n\n');