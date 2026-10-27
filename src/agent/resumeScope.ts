import { TodoItem } from '../core/types';

/**
 * 通用「继续」指令的作用域绑定。
 *
 * 真实故障：用户点「继续执行」后，`send()` 收到的是一句固定文案
 * 「继续执行当前任务清单里尚未完成的条目…」。任务队列的根标题直接取这句话，
 * 于是它成了「当前任务」。这句话没有交付物、没有文件范围，后面任何新需求拿去跟它比
 * 都像「同一个目标」，被判成 related —— 任务树里就把不相干的任务标成「已合并」。
 *
 * 规则：这类通用指令不构成任务身份，它只是对「暂停中的清单」的一次性唤醒。
 * 续跑时改用清单自身的未完成条目当作任务作用域，通用原文不参与后续分类；
 * 没有暂停中的清单时它不生效，退回普通消息。
 */

/** 续跑语气。没有它就不可能是「接着做」，后面两条判断也就不必看。 */
const CONTINUATION = /(继续|接着|往下|恢复|下去|resume|continue|carry on|pick up where|keep going|go on)/i;

/**
 * 指向「任务清单」本身。
 *
 * 与下面的「裸续跑」二者取一：带清单指向的是通用指令，不带清单指向又只剩续跑语气的是
 * 极简说法（「继续」「接着做」）。像「继续修复登录并发问题」这种既无清单指向、又不裸的，
 * 属于带具体交付物的续修，绝不能被当成通用续跑。
 */
const LIST_REFERENCE = /(任务清单|待办清单|清单|待办|未完成|尚未完成|中断|进度|todo|task list|checklist)/i;

/**
 * 具体锚点：代码片段、带斜杠的路径、带扩展名的文件名。
 * 出现任何一个就说明这条消息指向具体交付物，不能当成通用续跑。
 *
 * 注意不能把 `update_todos` / `in_progress` 这类工具名与状态词当成锚点——官方续跑文案里
 * 就带着它们，误判会让按钮那条路径失效。
 */
const CONCRETE_ANCHOR = /(`[^`]+`|(?:^|[\s(])\/[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.[A-Za-z]{1,6}\b)/;

/** 去掉续跑语气与客套话后是否什么都不剩（用于识别「继续」「接着做」「continue」这类裸指令）。 */
function isBareContinuation(value: string): boolean {
  const stripped = value
    .replace(/[\s，,。.、；;：:！!？?~～\-—…"'“”]/g, '')
    .replace(/继续|接着|往下|恢复|下去|执行|请|帮我|麻烦|一次/g, '')
    .replace(/做|干|来|吧|呢|了|啊|呀/g, '')
    .replace(/resume|continue|carryon|pickupwhereyouleftoff|keepgoing|goon|please|now|okay|ok/g, '');
  return stripped === '';
}

/**
 * 这条消息是不是「没有具体文件范围的通用续跑指令」。
 *
 * 判定刻意保守：拿不准时返回 false。误判成通用续跑会把它自己的范围抹掉，
 * 比漏判（保持现状）更糟。
 */
export function isGenericResume(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim();
  if (!value || value.length > 600) return false;
  if (!CONTINUATION.test(value)) return false;
  if (CONCRETE_ANCHOR.test(value)) return false;
  return LIST_REFERENCE.test(value) || isBareContinuation(value);
}

/**
 * 从暂停中的清单派生出任务作用域。
 *
 * 只取**未完成**条目：已经打勾的是既成事实，再把它当作用域会把已完成的工作重新拉回比较范围。
 * 全部完成或没有清单时返回 `undefined` —— 没有暂停中的任务，这条指令就不该生效。
 */
export function resumeScopeTitle(todos: readonly TodoItem[] | undefined): string | undefined {
  const pending = (todos ?? [])
    .filter((todo) => todo.status !== 'completed')
    .map((todo) => todo.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!pending.length) return undefined;
  return pending.join('；');
}

export interface ResumeScopeInput {
  /** 用户这一轮真正发出的文本。 */
  text: string;
  /** 发送瞬间该对话上留存的清单（续跑按钮会先清中断标记，但清单本身还在）。 */
  todos?: readonly TodoItem[];
  /** 来自「继续执行」按钮：由 HWChat 自己生成，不需要再靠文本猜测。 */
  explicitResume?: boolean;
}

/**
 * 解析这一轮是否要绑定到暂停中的清单，返回应当使用的任务作用域。
 *
 * `undefined` 表示不绑定（照旧用消息原文当任务标题）。
 *
 * 「只生效一次」在这里体现为两点：
 * - 绑定是发送瞬间对清单的一次快照，不写回任何状态，下一轮要么重新判定、要么就没有了；
 * - 清单全部完成（没有未完成条目）时直接不生效，通用指令不会留下来变成常驻的任务身份。
 */
export function resolveResumeScope(input: ResumeScopeInput): string | undefined {
  const resume = input.explicitResume === true || isGenericResume(input.text);
  if (!resume) return undefined;
  return resumeScopeTitle(input.todos);
}
