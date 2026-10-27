import { AgentTaskNode, AgentTaskTreeState, ChatRequestMessage, UsageInfo } from '../core/types';
import { createId, shortTitle } from '../core/ids';

export type TaskRelation = 'related' | 'queued';

export interface AgentTaskBinding {
  userMessageId?: string;
  assistantMessageId?: string;
}

export interface AgentTaskUpdate extends AgentTaskBinding {
  nodeId: string;
  request: ChatRequestMessage;
  relation: TaskRelation;
}

interface PendingTask extends AgentTaskUpdate {}

export class AgentTaskQueue {
  private readonly nodes: AgentTaskNode[];
  private readonly related: PendingTask[] = [];
  private readonly queued: PendingTask[] = [];
  private routingTail: Promise<void> = Promise.resolve();
  private currentNodeId: string;
  /**
   * 根节点是「续跑绑定」时记下它的 id。
   *
   * 续跑的作用域来自暂停清单，语义只对根节点成立；一旦 `take()` 换到排队分支，
   * `currentNodeId` 就变了，判定随之失效——否则一个已经结束的续跑会继续污染后续分支。
   */
  private readonly resumeNodeId: string | undefined;
  private accepting = true;
  private usage: UsageInfo | undefined;

  constructor(rootTitle: string, options: { resumeScope?: boolean } = {}) {
    const rootId = createId('task');
    this.currentNodeId = rootId;
    this.resumeNodeId = options.resumeScope === true ? rootId : undefined;
    this.nodes = [{
      id: rootId,
      title: shortTitle(rootTitle, '当前任务'),
      status: 'active',
      relation: 'root',
    }];
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  currentTitle(): string {
    const current = this.nodes.find((node) => node.id === this.currentNodeId)?.title ?? '当前任务';
    const merged = this.nodes
      .filter((node) => node.parentId === this.currentNodeId && node.status === 'merged')
      .slice(-4)
      .map((node) => node.title);
    return [current, ...merged].join('；');
  }

  classifierUsage(): UsageInfo | undefined {
    return this.usage ? { ...this.usage } : undefined;
  }

  state(): AgentTaskTreeState {
    return {
      active: this.accepting,
      currentNodeId: this.currentNodeId,
      nodes: this.nodes.map((node) => ({ ...node })),
      usage: this.classifierUsage(),
    };
  }

  enqueue(
    title: string,
    request: ChatRequestMessage,
    classify: (currentTask: string, incomingTask: string, resumeScope: boolean) => Promise<{ relation: TaskRelation; usage?: UsageInfo }>,
    onChange: (state: AgentTaskTreeState) => void | Promise<void>,
    binding: AgentTaskBinding = {},
  ): AgentTaskNode {
    if (!this.accepting) throw new Error('当前 Agent 已进入收尾阶段。');
    const node: AgentTaskNode = {
      id: createId('task'),
      parentId: this.currentNodeId,
      title: shortTitle(title, '新消息'),
      status: 'routing',
      relation: 'pending',
    };
    this.nodes.push(node);
    void onChange(this.state());
    this.routingTail = this.routingTail.then(async () => {
      let classified: { relation: TaskRelation; usage?: UsageInfo };
      try {
        classified = await classify(this.currentTitle(), title, this.currentNodeId === this.resumeNodeId);
      } catch {
        if (!this.accepting) {
          node.status = 'cancelled';
          await onChange(this.state());
          return;
        }
        classified = { relation: fallbackTaskRelation(this.currentTitle(), title) };
      }
      this.usage = addUsage(this.usage, classified.usage);
      node.relation = classified.relation;
      if (classified.relation === 'related') {
        node.parentId = this.currentNodeId;
        node.status = 'merged';
        this.related.push({ nodeId: node.id, request, relation: 'related', ...binding });
      } else {
        node.parentId = this.nodes[0]?.id;
        node.status = 'queued';
        this.queued.push({ nodeId: node.id, request, relation: 'queued', ...binding });
      }
      await onChange(this.state());
    }).catch(async () => {
      node.relation = 'queued';
      node.status = 'queued';
      this.queued.push({ nodeId: node.id, request, relation: 'queued', ...binding });
      await onChange(this.state());
    });
    return { ...node };
  }

  async take(phase: 'replan' | 'complete', onChange: (state: AgentTaskTreeState) => void | Promise<void>): Promise<AgentTaskUpdate[]> {
    await this.settleRouting();
    if (this.related.length) {
      const task = this.related.shift();
      await onChange(this.state());
      return task ? [{ ...task, request: withTaskInstruction(task.request, 'related') }] : [];
    }
    if (phase === 'replan') return [];

    const current = this.nodes.find((node) => node.id === this.currentNodeId);
    if (current && current.status === 'active') current.status = 'complete';
    const next = this.queued.shift();
    if (next) {
      const node = this.nodes.find((candidate) => candidate.id === next.nodeId);
      if (node) node.status = 'active';
      this.currentNodeId = next.nodeId;
      await onChange(this.state());
      return [{ ...next, request: withTaskInstruction(next.request, 'queued') }];
    }
    this.accepting = false;
    await onChange(this.state());
    return [];
  }

  async finish(status: 'complete' | 'cancelled' | 'error', onChange: (state: AgentTaskTreeState) => void | Promise<void>): Promise<void> {
    await this.settleRouting();
    this.accepting = false;
    for (const node of this.nodes) {
      if (node.status === 'routing' || node.status === 'active' || node.status === 'queued') {
        node.status = status;
      }
    }
    await onChange(this.state());
  }

  private async settleRouting(): Promise<void> {
    while (true) {
      const tail = this.routingTail;
      await tail;
      if (tail === this.routingTail) return;
    }
  }
}

function withTaskInstruction(request: ChatRequestMessage, relation: TaskRelation): ChatRequestMessage {
  const prefix = relation === 'related'
    ? '[任务树更新：相关指导]\n立即重新评估当前分支。保留已经完成且仍有效的工作，取消尚未执行且与新要求冲突的旧步骤，并根据这条消息调整计划：\n'
    : '[任务树分支：排队任务]\n前一个分支已经完成。现在开始处理这个独立任务，不要把它与上一分支的目标混淆：\n';
  if (typeof request.content === 'string') return { ...request, content: `${prefix}${request.content}` };
  const parts = request.content.map((part) => part.type === 'text' ? { ...part } : { ...part, image_url: { ...part.image_url } });
  const text = parts.find((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text');
  if (text) text.text = `${prefix}${text.text}`;
  else parts.unshift({ type: 'text', text: prefix });
  return { ...request, content: parts };
}

export function fallbackTaskRelation(currentTask: string, incomingTask: string): TaskRelation {
  const incoming = tokenize(incomingTask);
  const current = tokenize(currentTask);
  if (!incoming.size || !current.size) return 'queued';
  const shared = [...incoming].filter((token) => current.has(token)).length;
  const correction = /^(继续|补充|另外|改成|不要|需要|请把|刚才|当前|这个|上述|修复|调整|同时|以及|然后)/i.test(incomingTask.trim());
  return correction || shared >= Math.min(2, Math.ceil(incoming.size / 3)) ? 'related' : 'queued';
}

function tokenize(value: string): Set<string> {
  const english = value.toLocaleLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [];
  const chinese = value.match(/[\u4e00-\u9fff]{2,}/g)?.flatMap((word) => {
    const pairs: string[] = [];
    for (let index = 0; index < word.length - 1; index += 1) pairs.push(word.slice(index, index + 2));
    return pairs;
  }) ?? [];
  return new Set([...english, ...chinese]);
}

function addUsage(total: UsageInfo | undefined, current: UsageInfo | undefined): UsageInfo | undefined {
  if (!current) return total;
  return {
    promptTokens: (total?.promptTokens ?? 0) + (current.promptTokens ?? 0),
    completionTokens: (total?.completionTokens ?? 0) + (current.completionTokens ?? 0),
    totalTokens: (total?.totalTokens ?? 0) + (current.totalTokens ?? 0),
  };
}
