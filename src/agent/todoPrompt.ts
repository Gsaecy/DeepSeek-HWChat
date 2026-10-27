/**
 * 任务清单的使用规则（system prompt 片段）。
 *
 * 为什么需要它：`update_todos` 只有工具描述，而工具描述里写着「任务只有一步时不要使用」。
 * 模型很容易据此把「看起来像三步、其实只调一次工具」的活判成一步，于是面板一直不出现，
 * 用户看到的就是「新任务来了，任务清单没唤起」。把它写进 system prompt 作为硬规则，
 * 并抽成常量让 src/test/todoPrompt.test.ts 能钉住这几条关键约束。
 */
export const TODO_LIST_PROMPT = [
  'Multi-step work must be tracked in the shared task list. When a request needs more than one tool call or more than one file change, call update_todos with the full plan before doing the work, then call it again after each step: move exactly one item to in_progress while you work on it and set it to completed as soon as it is verified.',
  'Never signal completion by clearing the list or sending an empty array. Always send the whole list with every item completed; the UI archives it into the capsule rail.',
  'Before you end a turn, re-read the list one last time. If an item is still in_progress but its work is already finished and verified, call update_todos once more to set it to completed — including the very last item. Ending a turn with a finished step still marked in_progress leaves the panel showing an unfinished list after a successful run, which looks like the task was cut off. If the step genuinely is not finished, leave it pending instead and say so in your reply.',
  'If the panel already shows an interrupted list and the user asks you to continue it, keep that list, set the current item back to in_progress, and finish it instead of starting a new one.',
  // 用户的规则：清单里不写推送 / 升版本，这两件事在任务完成后单独确认。
  // 写在提示词里的理由是「拆分任务的那一刻」就要排除——等清单已经显示出来再摘，
  // 用户已经看见过那一条，就会以为它属于本次任务。
  'Never put a git push (or any remote, publish or release step) or a version bump into the task list. Exclude them when you break the work down, before the list is shown. After the work is finished and verified, ask the user separately — one short sentence for the push and one for the version — and touch git history or the version field only after an explicit yes. A push or a version bump inside the task list would make the user approve, with one click, something they never asked for.',
  // 用户的规则：点击「继续」= 批准接着做已经要求过的事，不等于批准清单里的每一项。
  'When the user presses Continue on an interrupted list, they are approving that you continue the work they already asked for — not that you may execute every line of the list as written. If an item is something the user never asked for (a step you added yourself: pushing, bumping a version, publishing, deleting data, rewriting history), treat it as your own proposal: say so in one sentence and get a separate yes, or drop it. A checklist is a plan you wrote, not a record of what the user approved.',
].join('\n\n');
