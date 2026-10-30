import { AgentTaskQueue, TaskRelation, userTextOfTaskRequest } from './taskQueue';
import { AgentTaskTreeState } from '../core/types';

export interface ReviewOutcome {
  /** 判为「属于当前分支」并当场并进去的消息（任务树里会显示成已合并）。 */
  merged: string[];
  /** 判为「独立任务」、继续排队的消息。 */
  kept: string[];
}

export interface ReviewOptions {
  /** 关系判定。实现方负责调模型；这里只管节奏与记账。 */
  classify: (currentTask: string, incomingTask: string, liveContext: string) => Promise<TaskRelation>;
  /** 「现在到底在做什么」的实时上下文（清单进度、最近几步）。 */
  liveContext: () => string | Promise<string>;
  onChange: (state: AgentTaskTreeState) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * 小任务边界上的「新消息重判」。
 *
 * 用户原话：「对话框 agent 正在运行，新消息进来，agent 需要执行完小任务后，先读取新消息，
 * 如果新消息和正在运行的任务相关，就合并，不管新消息和正在执行的消息之间间隔了多少条
 * 消息，都要先停下来判断一下再继续。」
 *
 * 原来的行为：相关与否只在**发消息那一刻**判一次（判据只有分支标题），判成「排队」就
 * 一直压到整条分支结束 —— 分支可能跑几十轮，这条消息既不会被读、也不会被重新考虑，
 * 于是「间隔了多少条」变成了隐式规则：隔得远就等于被无限期搁置。
 *
 * 现在的做法：每次模型调用之前（也就是一个小任务做完之后）把**所有**还没在本分支判断
 * 过的排队消息扫一遍，带上实时上下文重新判；判为相关的当场并进本分支，并且立刻交给
 * agent 读（`related` 队列会在同一轮 `take()` 里被取走）。
 *
 * 成本：每条消息在**同一条分支**上只重判一次（队列里用 `reviewedFor` 记账），
 * 所以上限是「排队条数」，不会把这笔开销摊到每一步上。
 *
 * 出错时**不记账**：判定失败（网络抖动、模型没回话）时这条消息仍是「没判过」，
 * 下个边界会再试 —— 宁可多问一次，也不能把用户的话静默当成「已处理」。
 */
export async function reviewQueuedTasks(queue: AgentTaskQueue, options: ReviewOptions): Promise<ReviewOutcome> {
  const outcome: ReviewOutcome = { merged: [], kept: [] };
  if (!queue.isAccepting()) return outcome;
  // 先等在途分类落定：刚落库的那条要先被分进 related / queued，才轮得到边界重判。
  await queue.awaitRouting();
  const pending = queue.pendingReview();
  if (!pending.length) return outcome;
  const live = await options.liveContext();
  for (const task of pending) {
    if (!queue.isAccepting() || options.signal?.aborted) return outcome;
    const incoming = userTextOfTaskRequest(task.request);
    if (!incoming) continue;
    let relation: TaskRelation;
    try {
      relation = await options.classify(queue.currentTitle(), incoming, live);
    } catch {
      if (options.signal?.aborted) return outcome;
      continue;
    }
    // 判定期间用户点了停止：这次结论已经过期，不应用、也不记账 —— 恢复后重新判。
    if (!queue.isAccepting() || options.signal?.aborted) return outcome;
    // settle / 撤单 / 编辑都可能在判定期间发生，逐条重新确认它还在队列里。
    const resolved = await queue.resolveReview(task.nodeId, relation, options.onChange);
    if (resolved === 'merged') outcome.merged.push(task.nodeId);
    else outcome.kept.push(task.nodeId);
  }
  return outcome;
}
