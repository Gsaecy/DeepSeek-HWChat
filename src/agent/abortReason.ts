/**
 * 「这一轮是怎么结束的」的统一判定。
 *
 * 现场（用户 2026-11-06，面板上原样显示）：
 *
 *     请求失败：aborted
 *
 * 没有任何可操作信息：不知道是超时、代理断了、被停止，还是模型服务把连接关了；
 * 也不知道「那 27 条命令算不算跑过」。目录日志里那一刻**一行都没有** ——
 * 连事后复盘都没线索。
 *
 * 根因是分类只看 `RequestCancelledError` 与 `signal.aborted`，其它任何
 * abort 形状的错误都原样拼进「请求失败：{error}」。而 abort 的形状在真实环境里
 * 至少有四种：
 *  1. `DOMException` / `AbortError`（fetch 被取消）；
 *  2. `Error('aborted')`（我们自己的等待辅助函数在取消时这么 reject）；
 *  3. 字符串 `'aborted'`（`AbortController.abort('aborted')` 之后 fetch 会以该值拒绝）；
 *  4. 各种包装器把上面几种拼进 `cause` 链。
 *
 * 所以这里把「像不像中止」与「该怎么说」抽成纯函数：**中止永远不等于失败**，
 * 而且要告诉用户这是可恢复的（重发即继续），不是「服务坏了」。
 */

/** 错误链上的每一条（`cause` 最多看 4 层，防循环引用）。 */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    if (typeof current !== 'object' || !('cause' in current)) break;
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * 这条错误是不是「中止 / 取消」形状。
 *
 * 判据刻意收窄到**明确的取消信号**，不把任何含 `abort` 字样的业务报错都算进来：
 *  - `name` 是 `AbortError` / `TimeoutError` / `RequestCancelledError`；
 *  - 错误本身就是字符串 `'aborted'`（fetch 以 abort 原因拒绝时就是这个）；
 *  - 消息**整体**等于 `aborted`（而不是「某段文字里出现 abort」）。
 */
/**
 * 连接被对端关掉（不是我们取消、也不是服务端返回 4xx/5xx）。
 *
 * 现场（用户 2026-11-09 14:03）：一次正常的运行中途弹出
 * 「请求失败：terminated」——`terminated` 是 undici 在 socket 被提前关闭时抛的
 * 通用错误，字面上什么都没说，而且被当成「失败」让 agent 停下了。
 * 它其实是**可以接着做**的中断：已经写出来的内容、执行过的步骤都在。
 */
const TRANSPORT_ERROR_TEXT = /^(?:terminated|other side closed|socket hang up|premature close|aborted)$/i;
const TRANSPORT_ERROR_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ETIMEDOUT',
]);

/** 这条错误是不是「连接被掐断」这一类（含 undici 的 `terminated`）。 */
export function isTransportDropError(error: unknown): boolean {
  return errorChain(error).some((item) => {
    if (!(item instanceof Error)) return false;
    if (TRANSPORT_ERROR_TEXT.test(item.message.trim())) return true;
    const code = (item as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code)) return true;
    const cause = (item as { cause?: unknown }).cause;
    if (cause && cause !== item) return isTransportDropError(cause);
    return false;
  });
}

export function isAbortLikeError(error: unknown): boolean {
  if (isTransportDropError(error)) return true;
  return errorChain(error).some((item) => {
    if (typeof item === 'string') return item.trim().toLowerCase() === 'aborted';
    if (item instanceof Error) {
      const name = item.name;
      /*
       * `StreamStalledError` 也必须算「被掐断」：它是我们自己的空闲判定，
       * 不是服务端报错。不算进来的后果（用户 2026-11-09 看到的）：
       * 「卡住」被当成「请求失败」，界面上显示成一次失败而不是可续的中断。
       */
      if (name === 'AbortError' || name === 'TimeoutError' || name === 'RequestCancelledError' || name === 'StreamStalledError') return true;
      return item.message.trim().toLowerCase() === 'aborted';
    }
    return false;
  });
}

/**
 * 中止的真实来源 —— 说法不同，能做的事也不同。
 *
 * `stalled` 与 `timeout` 必须分开：`timeout` 是「连不上 / 等不到响应头」，
 * `stalled` 是「连上了，但 N 秒没有新数据」。前者要查网络与代理，后者多半只要
 * 调大超时或给该域名直连 —— 混成一个说法，用户只能瞎试。
 */
export type AbortCause = 'timeout' | 'stalled' | 'network' | 'user';

/**
 * 判断是哪一种中止。
 *
 * - `user`：用户点了停止 / 切换了对话（`signal.aborted` 为真，但没有超时或网络特征）；
 * - `stalled`：连上了，但 N 秒没有新数据（我们自己的空闲判定）；
 * - `timeout`：明确的超时错误（`TimeoutError` 或消息里带超时）；
 * - `network`：其余情况都按「连接被外部断开」处理（代理断线、服务端关连接）。
 */
export function classifyAbort(error: unknown, signalAborted: boolean): AbortCause {
  const chain = errorChain(error);
  /*
   * 我们自己的空闲判定（`StreamStalledError`）优先于其它判断：
   * 它的 `name` 不含 timeout，混进下面的正则会被误判成 network（也就是用户看到的
   * 「网络失败」）。signal 被用户取消时仍然是 user。
   */
  if (!signalAborted && chain.some((item) => item instanceof Error && item.name === 'StreamStalledError')) {
    return 'stalled';
  }
  const text = chain
    .map((item) => (item instanceof Error ? `${item.name} ${item.message}` : String(item)))
    .join(' ')
    .toLowerCase();
  if (/timeout|timed out|超时/.test(text)) return 'timeout';
  if (signalAborted) return 'user';
  return 'network';
}
