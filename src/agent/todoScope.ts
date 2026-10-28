import { TodoItem } from '../core/types';
import { gitOperationsIn } from './conversationScope';
import { hasVersionBumpIntent, versionBumpCommand } from './releasePolicy';

/**
 * 任务清单的范围：推送与版本更新不属于清单条目。
 *
 * 用户原话（这是规则的来源）：
 * 「任务清单里不要涉及 git 推送和版本号更新，拆分任务的时候就排除掉，
 *   执行完任务再找用户单独确认推送和版本更新。」
 *
 * 为什么只靠提示词不够：
 * 清单一旦写上 `6. 提交并推送`，用户点「继续执行」时看到的就是这六条，
 * 而「点击继续」= 认可接下来要做的事。于是用户没说过的词（推送）借清单
 * 获得了授权。这不是模型故意夹带，而是「顺手把提交做完整」这种合理扩写，
 * 恰恰最不容易被用户逐条核对。
 *
 * 所以这里做一层运行时可判定的过滤：清单落库前把这类条目摘出去，并在工具
 * 返回里显式告知模型「事后要单独征询」，避免它以为这一步被丢掉了。
 *
 * 判定刻意保守：`实现消息推送` / `推送通知` 是正常功能任务，绝不能误摘。
 * 只有出现 `git push` 或「推送到远端 / origin / 分支」这类**仓库动作**才命中。
 *
 * 版本一侧不自己列工具名单，直接复用 releasePolicy 里的 `versionBumpCommand`：
 * 两边各写一份工具表，迟早会在「新工具支持了吗」这个问题上分叉。
 *
 * 本模块只做纯计算，不 import vscode，便于把边界写成单元测试。
 */

/** 为什么这条不属于任务清单。 */
export type TodoScopeReason = 'push' | 'version';

export interface TodoScopeExclusion {
  todo: TodoItem;
  reason: TodoScopeReason;
}

export interface TodoScopeSplit {
  /** 留在清单里的条目，顺序不变（顺序就是执行顺序）。 */
  kept: TodoItem[];
  /** 被摘出去的条目，用于回告模型「这些事要单独确认」。 */
  excluded: TodoScopeExclusion[];
}

/** 显式的 git 推送：清单里这么写就是仓库动作，不存在歧义。 */
const GIT_PUSH_TEXT = /\bgit\s+push\b/i;

/**
 * 中文的「推送到远端 / 主干」：必须带目标，否则「推送通知」会被误伤。
 * 允许中间夹一小段宾语（`推送代码到 origin`），但目标词仍严格限定在仓库概念上，
 * 所以 `推送通知到用户设备` 不会命中。
 */
const PUSH_TO_REMOTE = /推送[^。；;\n]{0,8}(?:到|至)\s*(?:远端|远程|origin|github|gitlab|gitee|仓库|分支|主干|main\b|master\b)/i;

/** 英文的 push 加目标：同样要求带目标，避免把「推送实现」当成仓库动作。 */
const PUSH_TO_EN = /\bpush\b[^.;。；\n]{0,12}\b(?:to|into)\b[^.;。；\n]{0,12}\b(?:remote|origin|github|gitlab|gitee|main|master)\b/i;

/**
 * 「升到 0.2.4」这种只给数字、不带「版本」二字的写法。
 *
 * `hasVersionBumpIntent` 要求句子里出现「版本 / version」这个词，抓不到这一种；
 * 所以额外认「升级动词 + 到 + 三段版本号」。动词限定为升级类，
 * `打包到 0.2.3`、`切到 0.2.3` 都不会命中——那是构建，不是改号。
 */
const VERSION_TO_NUMBER = /(?:升级|升|提升|bump|upgrade)[^.;。；\n]{0,8}(?:到|至|to)\s*v?\d+\.\d+\.\d+/i;

/** 这条清单内容属于哪一类「清单外」动作；undefined 表示它就该留在清单里。 */
export function todoScopeReason(content: string): TodoScopeReason | undefined {
  const value = content.replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  // 先判推送：`git push tag v1.0.0` 同时踩中版本判定，应归为推送。
  if (GIT_PUSH_TEXT.test(value)) return 'push';
  if (PUSH_TO_REMOTE.test(value) || PUSH_TO_EN.test(value)) return 'push';
  if (gitOperationsIn(value).some((operation) => operation.verb.toLocaleLowerCase() === 'push')) return 'push';
  // 版本工具复用既有解析：它只看命令头，`echo "..."` 这种引用不会命中。
  if (versionBumpCommand(value)) return 'version';
  if (VERSION_TO_NUMBER.test(value)) return 'version';
  if (hasVersionBumpIntent(value)) return 'version';
  return undefined;
}

/**
 * 把一份清单拆成「保留」与「摘出」两部分。
 *
 * 已完成的条目一样要摘：规则是「清单里不该出现这类条目」，与它跑到哪一步无关；
 * 留着会让用户以为推送 / 升版本是本次任务的一部分，而它其实是事后单独确认的事。
 */
export function splitTodoScope(todos: readonly TodoItem[]): TodoScopeSplit {
  const kept: TodoItem[] = [];
  const excluded: TodoScopeExclusion[] = [];
  for (const todo of todos) {
    const reason = todoScopeReason(todo.content);
    if (reason) excluded.push({ todo, reason });
    else kept.push(todo);
  }
  return { kept, excluded };
}

/**
 * 跨轮次比对清单条目的归一化键。
 *
 * 模型重述同一条时会改标点和空白（`同步 README、MVP 与周报` → `同步 README / MVP / 周报`），
 * 严格字符串比较会把「同一件事」判成两件事，所以这里抹掉分隔符再比。
 */
function todoKey(content: string): string {
  return content.replace(/\s+/g, ' ').replace(/[、，,。．。/／·・:：;；\-—]/g, '').trim().toLocaleLowerCase();
}

/**
 * 这次提交丢掉了上一份清单里的哪些「已完成」条目。
 *
 * 真实故障：用户点「继续执行」续跑 6/8 的清单，模型却重新拆了一份 4 项的新清单 ——
 * 前六条（含已验证通过的门禁与泄漏扫描）被整份替换掉，用户看到的是「进度全没了」。
 * 提示词里本来就有「keep that list… instead of starting a new one」，但它不是硬约束。
 *
 * 判定只看「已完成项是否还在」这一条：已完成是**已验证的事实**，任何重规划都不该抹掉它，
 * 而正常续跑 / 加项 / 把某项改回 pending 都会保留原条目文字，不会被误拦。
 * 上一份清单没有已完成项（没进度可丢）或已全部完成（该归档、新清单就是新任务）时放行。
 */
export function droppedCompletedTodos(
  previous: readonly TodoItem[] | undefined,
  submitted: readonly TodoItem[],
): string[] {
  if (!previous?.length) return [];
  const done = previous.filter((todo) => todo.status === 'completed');
  if (!done.length || done.length === previous.length) return [];
  const kept = new Set(submitted.map((todo) => todoKey(todo.content)));
  return done.filter((todo) => !kept.has(todoKey(todo.content))).map((todo) => todo.content);
}

/**
 * 用户这一轮是否明确要求「重做清单」。
 *
 * `droppedCompletedTodos` 的守卫默认拦下所有「丢进度」的替换；但用户说「重新规划清单」
 * 时那就是合法操作。判定要求出现**清单 + 重做动词**的组合，
 * 续跑指令（「继续执行当前任务清单里尚未完成的条目」）不含这些动词，不会被放过。
 */
const REPLAN_ZH = /(?:(?:重新|重|再|另外|换)\s*[^。；;，,\n]{0,6}?(?:规划|计划|拆分|列|排|开|做|来)[^。；;，,\n]{0,6}?(?:清单|任务|计划)|换(?:个|一份|一个)?\s*(?:清单|任务|计划)|(?:忘掉|丢掉|放弃|清空|不要|忽略|弃用)\s*(?:之前|原来|上一份|现有|旧)?\s*(?:的)?\s*(?:清单|任务|计划)|(?:之前|原来|上一份|现有|旧)\s*(?:的)?\s*(?:清单|任务|计划)\s*[^。；;，,\n]{0,4}?(?:丢掉|放弃|清空|不要|弃用|重来|重新))/;
const REPLAN_EN = /\b(?:re-?plan|start over|from scratch|new (?:task )?list|discard|forget|ignore|drop|reset)\b[^.;!?]{0,24}\b(?:list|plan|todos?)\b/i;

export function hasTodoReplanIntent(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim();
  if (!value) return false;
  return REPLAN_ZH.test(value) || REPLAN_EN.test(value);
}
