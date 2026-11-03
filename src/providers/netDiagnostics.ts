/**
 * 网络错误的可读化与有限重试。
 *
 * 现场（用户反馈）：「hwchat对话弹出：请求失败：无法连接到接口：fetch failed」。
 *
 * `fetch failed` 是 undici 的**外层**错误，真正的原因全在 `error.cause` 里
 * （`ENOTFOUND` / `ECONNREFUSED` / `UND_ERR_CONNECT_TIMEOUT` / 证书错误…）。
 * 把它原样丢给用户等于什么都没说：DNS 挂了、代理没开、证书不对，看到的都是同一句
 * 「fetch failed」，只能靠猜。
 *
 * 这个模块做两件事，都不依赖 `vscode`，所以可以直接单测：
 *   1. 沿 `cause` 链（含 `AggregateError.errors`）找到最内层错误，归类成
 *      阶段（dns / connect / tls / http）+ 代码 + 一句能照着做的建议；
 *   2. 给出「这个错误重试有没有意义」的判断，并实现带退避的有限重试。
 *
 * 重试的安全性：只重试 **fetch 本身抛出**的情况 —— 那意味着连响应头都没拿到，
 * 请求不可能已经被服务端处理并计费。拿到响应之后的失败（流中断）一律不重试，
 * 避免重复扣费或重复生成。
 */

/** 失败发生在哪一环。诊断命令与错误提示都按它分类。 */
export type NetworkStage = 'dns' | 'connect' | 'tls' | 'http' | 'unknown';

export interface NetworkCause {
  stage: NetworkStage;
  /** 最内层错误代码（`ENOTFOUND` / `ECONNREFUSED` / `CERT_HAS_EXPIRED` …）。 */
  code: string;
  /** 目标主机名（尽力而为：URL 解析失败时为空串）。 */
  host: string;
  /** 原始错误信息，供日志/详情展示。 */
  detail: string;
  /** 一句能照着做的中文建议。 */
  hint: string;
  /** 重试是否有意义（只在「响应头都还没拿到」时才有意义）。 */
  retryable: boolean;
}

const STAGE_LABEL: Record<NetworkStage, string> = {
  dns: '域名解析',
  connect: '建立连接',
  tls: 'TLS 握手',
  http: 'HTTP 请求',
  unknown: '网络',
};

export function stageLabel(stage: NetworkStage): string {
  return STAGE_LABEL[stage];
}

/** 已知代码 → 阶段 + 建议。表里查不到的按阶段兜底。 */
function describeCode(code: string, host: string): { stage: NetworkStage; hint: string; retryable: boolean } {
  const key = code.toUpperCase();
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME', 'EAI_FAIL'].includes(key)) {
    return {
      stage: 'dns',
      hint: `解析不到 ${host || '目标域名'}。检查网络与 DNS（终端里试 \`nslookup ${host || 'example.com'}\`）；如果用代理，确认代理规则放行了这个域名。`,
      retryable: true,
    };
  }
  if (['ECONNREFUSED'].includes(key)) {
    return {
      stage: 'connect',
      // 本机端口被拒绝几乎只有一个原因：那个代理/服务没在跑。
      hint: '目标端口拒绝连接。如果配置里填的是本机代理端口（如 127.0.0.1:8080），说明代理没有运行 —— 先启动代理，或把它关掉改走直连。',
      retryable: true,
    };
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(key)) {
    return {
      stage: key.includes('HEADERS') || key.includes('BODY') ? 'http' : 'connect',
      hint: '连接超时：网络到不了目标（或在代理/防火墙处被丢弃）。检查是否需要代理、以及代理是否放行了该域名。',
      retryable: true,
    };
  }
  if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ENETRESET'].includes(key)) {
    return {
      stage: 'connect',
      hint: '连接被中途重置（常见于 keep-alive 长连接被中间设备回收）。已自动重试过；持续出现说明链路上有设备在掐连接。',
      retryable: true,
    };
  }
  if (['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL'].includes(key)) {
    return {
      stage: 'connect',
      hint: '网络不可达：本机没有到目标的路由（断网、VPN 掉线或路由表异常）。',
      retryable: true,
    };
  }
  if ([
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_UNTRUSTED',
  ].includes(key)) {
    return {
      stage: 'tls',
      hint: 'TLS 证书校验失败。最常见的原因是**代理做了中间人**：把代理的根证书装进系统信任链，或关掉该代理再试。',
      retryable: false,
    };
  }
  if (['ERR_INVALID_PROXY', 'ERR_SOCKS_UNSUPPORTED', 'ERR_PROXY_CONNECT'].includes(key)) {
    // 代理地址写错、不支持 socks、代理拒绝建隧道：改配置才能解决，重试毫无意义。
    return { stage: 'connect', hint: '代理配置有问题：检查 HWChat 设置里的「接口代理」（形如 http://127.0.0.1:8080，不支持 socks://）。', retryable: false };
  }
  if (['ERR_INVALID_URL', 'ERR_INVALID_PROTOCOL'].includes(key)) {
    return { stage: 'unknown', hint: '接口地址不合法：检查设置里的接口地址（需要以 http:// 或 https:// 开头）。', retryable: false };
  }
  return { stage: 'unknown', hint: '网络错误。可先运行命令「HWChat: 测试网络连接」查看是 DNS、连接还是证书出了问题。', retryable: true };
}

/** 错误对象上可能出现的字段（Node / undici 都会带一部分）。 */
interface ErrorLike {
  name?: string;
  message?: string;
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
  address?: unknown;
  port?: unknown;
  cause?: unknown;
  errors?: unknown;
}

/** 把任意 throw 出来的东西拆成「最内层」的一条错误链（由内向外）。 */
function flattenError(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (!value || depth > 6 || typeof value !== 'object') return;
    const candidate = value as ErrorLike;
    chain.push(candidate);
    // undici 在「多个地址都连不上」时用 AggregateError 包一层。
    if (Array.isArray(candidate.errors)) {
      for (const inner of candidate.errors) visit(inner, depth + 1);
    }
    visit(candidate.cause, depth + 1);
  };
  visit(error, 0);
  return chain;
}

function codeOf(candidate: ErrorLike): string {
  if (typeof candidate.code === 'string' && candidate.code) return candidate.code;
  if (typeof candidate.errno === 'string' && candidate.errno) return candidate.errno;
  return '';
}

function hostOfTarget(target: string): string {
  try {
    return new URL(target).hostname;
  } catch {
    return '';
  }
}

/**
 * 环境里是否配了代理变量。
 *
 * 这条信息很关键：Node 的全局 `fetch`（undici）**不会**自动使用 `HTTPS_PROXY`，
 * 而 VS Code 的 `http.proxy` 也不覆盖扩展的 `fetch`（官方文档：*Extensions don't
 * benefit yet from the same proxy support that VS Code supports*）。所以「代理开着、
 * 扩展却连不上」是真实存在的一类故障，提示里必须点出来，否则用户只会怀疑网络。
 */
export function proxyEnv(): string | undefined {
  const value = process.env.HTTPS_PROXY
    ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY
    ?? process.env.http_proxy
    ?? process.env.ALL_PROXY
    ?? process.env.all_proxy;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 把一个网络错误归类成可读的 `NetworkCause`。
 *
 * @param error  fetch / net 抛出的原始错误
 * @param target 请求的完整 URL（用来报出主机名）
 */
export function classifyNetworkError(error: unknown, target: string): NetworkCause {
  const host = hostOfTarget(target);
  const chain = flattenError(error);
  const name = error instanceof Error ? error.name : (error as { name?: string } | undefined)?.name ?? '';
  const outerMessage = (error instanceof Error ? error.message : String(error)) ?? '';
  /*
   * 超时与取消要**先**判断，且一律不可重试。
   *
   * 实测（Node 22 的 `AbortSignal.timeout`）：抛出的是 `DOMException`，
   * `name === 'TimeoutError'`、`code === 23`，**没有 cause**。如果落到下面的通用
   * 分支，会被判成不可知网络错误 → 重试 3 次；而一次请求的超时预算可能是 120 秒，
   * 重试三次就是 6 分钟，比直接报错糟糕得多。
   */
  if (name === 'TimeoutError' || /timed? ?out/i.test(outerMessage)) {
    return {
      stage: 'connect',
      code: 'ETIMEDOUT',
      host,
      detail: `连接超时（ETIMEDOUT）：${outerMessage}`,
      hint: '在超时时间内没有完成请求。可能是网络慢、被墙，或需要代理；已按超时处理，不重试。可运行命令「HWChat: 测试网络连接」定位卡在哪一环。',
      retryable: false,
    };
  }
  if (name === 'AbortError') {
    return {
      stage: 'unknown',
      code: 'ABORT_ERR',
      host,
      detail: `请求被取消：${outerMessage}`,
      hint: '这是你主动停止或切换对话导致的取消，不是网络故障。',
      retryable: false,
    };
  }
  // 由内向外找第一个带 code 的：最内层的信息最具体（外层通常是 fetch failed）。
  const withCode = [...chain].reverse().find((candidate) => codeOf(candidate));
  const rawCode = withCode ? codeOf(withCode) : '';
  // 汇总整条链的文字：有的实现只把原因写在 message 里（`other side closed` 就是典型）。
  const message = chain.map((candidate) => candidate.message ?? '').filter(Boolean).join(' / ') || outerMessage;
  const lowered = message.toLowerCase();
  const code = rawCode
    || ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE']
      .find((known) => lowered.includes(known.toLowerCase()))
    || (lowered.includes('other side closed') ? 'UND_ERR_SOCKET' : 'UNKNOWN');
  const described = describeCode(code, host);
  const proxy = proxyEnv();
  const proxyNote = proxy && described.stage !== 'tls'
    ? `\n另外：检测到代理环境变量 ${proxy}。扩展的请求不会自动走系统/环境代理（Node fetch 的已知行为），如果必须经代理，请让代理以 TUN/增强模式接管，或在代理规则里放行该域名。`
    : '';
  return {
    stage: described.stage,
    code,
    host,
    detail: `${stageLabel(described.stage)}失败（${code}）：${message}`,
    hint: described.hint + proxyNote,
    retryable: described.retryable,
  };
}

/** 只判断「重试有没有意义」，不构造完整描述（重试循环用）。 */
export function isRetryableNetworkError(error: unknown): boolean {
  return classifyNetworkError(error, 'https://placeholder.invalid').retryable;
}

/** 拼成给用户看的一句话（不含换行以外的格式）。 */
export function formatNetworkError(cause: NetworkCause): string {
  return `${cause.detail}\n${cause.hint}`;
}

export interface RetryEvent {
  attempt: number;
  maxAttempts: number;
  code: string;
  stage: NetworkStage;
  detail: string;
  waitMs: number;
}

export interface FetchWithRetryOptions {
  /** 总尝试次数（含第一次）。默认 3。 */
  attempts?: number;
  /** 退避基数：第 n 次等待 `baseDelayMs * 3^(n-1)`。默认 400ms → 400 / 1200。 */
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** 每次重试前上报一次（写日志用，不含正文与凭据）。 */
  onRetry?: (event: RetryEvent) => void;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new Error('aborted'));
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(new Error('aborted'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * 带有限退避重试的 fetch。
 *
 * 只重试「fetch 自己抛出来」的错误 —— 这时候连响应头都没拿到，请求不可能已经被
 * 服务端处理，重试不会造成重复计费或重复生成。拿到响应之后的一切失败（HTTP 状态码、
 * 流中断）**一律不重试**，交给调用方按原逻辑处理。
 *
 * `fetchImpl` 可注入，便于单测在毫秒级验证重试次数与退避。
 */
export async function fetchWithNetworkRetry<T = Response>(
  input: string,
  init: RequestInit,
  options: FetchWithRetryOptions = {},
  fetchImpl: (input: string, init: RequestInit) => Promise<T> = ((url, request) => fetch(url, request)) as (input: string, init: RequestInit) => Promise<T>,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 400);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      lastError = error;
      const cause = classifyNetworkError(error, input);
      const canRetry = cause.retryable && attempt < attempts && !options.signal?.aborted;
      if (!canRetry) {
        throw new Error(formatNetworkError(cause));
      }
      const waitMs = baseDelayMs * (3 ** (attempt - 1));
      options.onRetry?.({ attempt, maxAttempts: attempts, code: cause.code, stage: cause.stage, detail: cause.detail, waitMs });
      await sleep(waitMs, options.signal).catch(() => {
        // 退避期间被取消：按取消处理，不要把它当成网络错误。
        throw new Error(formatNetworkError(cause));
      });
    }
  }
  throw new Error(formatNetworkError(classifyNetworkError(lastError, input)));
}
