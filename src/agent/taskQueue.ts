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
  /** 每个节点对应的消息 id：节点被取走执行之后，队列里的那条就没了，界面仍需要它。 */
  private readonly bindings = new Map<string, AgentTaskBinding>();

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

  /**
   * 给已有节点补记消息 id。
   *
   * 根节点是在构造函数里建的，那时用户消息还没落库；等 `send()` 把一问一答写进存储后
   * 再补登记，界面才能对根节点也提供「编辑后重发」。
   */
  bind(nodeId: string, binding: AgentTaskBinding): void {
    this.bindings.set(nodeId, { ...this.bindings.get(nodeId), ...binding });
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
    /**
     * 还在队列里的节点才是「未执行」：改动会直接影响下一轮真正读到的 request。
     *
     * `routing` 也算：它刚发出去、分类还没回来，这时候用户最想改。编辑会先等分类
     * 落定再决定改哪一条（见 editPending），所以界面可以放心地把它当成可编辑。
     */
    const held = new Set([...this.related, ...this.queued].map((task) => task.nodeId));
    for (const node of this.nodes) {
      if (node.status === 'routing') held.add(node.id);
    }
    return {
      active: this.accepting,
      currentNodeId: this.currentNodeId,
      nodes: this.nodes.map((node) => ({
        ...node,
        userMessageId: this.bindingOf(node.id)?.userMessageId,
        pending: held.has(node.id),
      })),
      usage: this.classifierUsage(),
    };
  }

  /** 找到某个节点在队列里持有的那一条（已执行的节点返回 undefined）。 */
  private pendingOf(nodeId: string): { list: PendingTask[]; task: PendingTask } | undefined {
    for (const list of [this.related, this.queued]) {
      const task = list.find((candidate) => candidate.nodeId === nodeId);
      if (task) return { list, task };
    }
    return undefined;
  }

  /** 节点对应的消息 id（队列里的从 request 携带的绑定取，已执行的从 responses 侧取不到，退回 undefined）。 */
  private bindingOf(nodeId: string): AgentTaskBinding | undefined {
    const held = this.pendingOf(nodeId);
    if (held) return { userMessageId: held.task.userMessageId, assistantMessageId: held.task.assistantMessageId };
    return this.bindings.get(nodeId);
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
    this.bindings.set(node.id, { ...binding });
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

  /**
   * 改一条**还没被执行**的排队消息。
   *
   * 排队中的任务只是队列里的一条 request，agent 还没读过它，所以这里直接换掉
   * request 的内容就等于「改完立刻生效」——下一轮 `take()` 取到的就是新内容，
   * 不需要撤单再重发（那样会多出一条消息、也多一次分类调用）。
   *
   * 返回 false 表示这条已经不在队列里了（已被 agent 取走执行）。此时调用方应当
   * 把编辑后的内容当成一条新消息发出去：历史不能改写，但用户的意图可以再表达一次。
   */
  async editPending(nodeId: string, text: string, onChange: (state: AgentTaskTreeState) => void | Promise<void>): Promise<boolean> {
    // 先等在途的分类落定：`routing` 期间还没有队列项，直接判「不可编辑」会把
    // 刚发出去还没分类完的消息误报成已执行。
    await this.settleRouting();
    const held = this.pendingOf(nodeId);
    if (!held) return false;
    const task = held.task;
    const content = text.trim();
    if (!content) return false;
    held.list[held.list.indexOf(task)] = { ...task, request: withPlainText(task.request, content) };
    const node = this.nodes.find((candidate) => candidate.id === nodeId);
    if (node) node.title = shortTitle(content, node.title);
    await onChange(this.state());
    return true;
  }

  /**
   * 撤掉一条**还没被执行**的排队消息。
   *
   * 节点标成 `cancelled` 而不是删掉：任务树是这一轮发生过什么的时间线，
   * 抹掉节点会让「我明明发过一句话」变成没发生过；标成取消才能对上界面。
   */
  async removePending(nodeId: string, onChange: (state: AgentTaskTreeState) => void | Promise<void>): Promise<boolean> {
    await this.settleRouting();
    const held = this.pendingOf(nodeId);
    if (!held) return false;
    held.list.splice(held.list.indexOf(held.task), 1);
    const node = this.nodes.find((candidate) => candidate.id === nodeId);
    if (node) node.status = 'cancelled';
    await onChange(this.state());
    return true;
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

/**
 * 任务树给用户消息加的前缀。
 *
 * 导出是为了让**权限判定**能把外壳剥掉、只看用户真正说的话：这些前缀是我们自己
 * 拼上去的说明文字，不该参与「用户是否要求提交」这类判断（否则「提交」两个字
 * 会不会被认出来，就取决于它是不是刚好处在某个前缀后面）。
 */
export const TASK_INSTRUCTION_PREFIXES = {
  related: '[任务树更新：相关指导]\n立即重新评估当前分支。保留已经完成且仍有效的工作，取消尚未执行且与新要求冲突的旧步骤，并根据这条消息调整计划：\n',
  queued: '[任务树分支：排队任务]\n前一个分支已经完成。现在开始处理这个独立任务，不要把它与上一分支的目标混淆：\n',
} as const;

/**
 * 把一条 request 的文本换成新内容，其余（图片等）原样保留。
 *
 * 编辑排队消息时用户改的是那段文字，附件不该被顺手丢掉；纯文本 request 直接替换。
 */
export function withPlainText(request: ChatRequestMessage, text: string): ChatRequestMessage {
  if (typeof request.content === 'string') return { ...request, content: text };
  const parts = request.content.filter((part) => part.type !== 'text');
  return { ...request, content: [{ type: 'text', text }, ...parts] };
}

/** 剥掉任务树前缀，返回用户真正输入的那句话。 */
export function withoutTaskInstruction(text: string): string {
  let value = text;
  for (const prefix of Object.values(TASK_INSTRUCTION_PREFIXES)) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }
  return value;
}

/** 从一次任务更新的请求里取出用户原话（纯文本；纯附件消息返回空串）。 */
export function userTextOfTaskRequest(request: ChatRequestMessage): string {
  const content = request.content;
  const raw = typeof content === 'string'
    ? content
    // 多段内容里前缀常常自己占一段，拼起来会多一个换行，最后统一 trim。
    : content.filter((part) => part.type === 'text').map((part) => (part as { text?: string }).text ?? '').join('\n');
  return withoutTaskInstruction(raw).trim();
}

function withTaskInstruction(request: ChatRequestMessage, relation: TaskRelation): ChatRequestMessage {
  const prefix = relation === 'related' ? TASK_INSTRUCTION_PREFIXES.related : TASK_INSTRUCTION_PREFIXES.queued;
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
