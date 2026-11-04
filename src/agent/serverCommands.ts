/**
 * 「这条命令是不是起了就不会自己退出」—— 由宿主判断，而不是靠模型记得传 `background: true`。
 *
 * 现场（用户 2026-11-04）：「如果他生成命令说用 python3 启动，它不会真正的启动，
 * 会导致无法预览」。真实原因有两层：
 *
 *  1. `run_command` 的前台路径到点就 `SIGTERM` + `SIGKILL` **整个进程组**（见 `spawnCommand`）。
 *     所以 `python3 -m http.server 8790` 写在前台，它会"运行成功"到超时，然后连同服务一起被杀掉
 *     —— 命令看起来跑过了，端口上却什么都没有。
 *  2. 于是模型只好绕路写 `nohup … &`，再用 `pkill -f "http.server 8790"` 去停 —— 既没有 pid
 *     可追踪，`pkill -f` 还可能顺手杀掉别的项目起的同名服务。
 *
 * 这里把「服务类命令」的判据写死：命中就自动转到宿主管理的后台（有 id、有 pid、可停），
 * 不再依赖模型记得那个参数。
 */

/** 命中即认为是常驻服务：返回值是给人看的类别，便于写日志与测试断言。 */
export interface LongRunningMatch {
  category: string;
}

const SERVER_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  { category: 'python-http-server', pattern: /\bpython[0-9.]*\s+-m\s+http\.server\b/i },
  { category: 'node-http-server', pattern: /(?:^|[\s;&|])(?:npx\s+|bunx\s+)?http-server\b/i },
  { category: 'node-serve', pattern: /(?:^|[\s;&|])(?:npx\s+|pnpm\s+dlx\s+)?serve\s+(?:-s\b|-l\b|\.)/i },
  { category: 'live-server', pattern: /(?:^|[\s;&|])live-server\b/i },
  { category: 'vite', pattern: /(?:^|[\s;&|])(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:dev|start|preview)\b|\bvite(?:\s+preview)?\b|\bnext\s+dev\b|\bnuxt\s+dev\b|\bastro\s+dev\b/i },
  { category: 'webpack-dev-server', pattern: /\bwebpack(?:-dev-server|\s+serve)\b/i },
  { category: 'php-server', pattern: /\bphp\s+-S\b/i },
  { category: 'ruby-httpd', pattern: /\bruby\s+-run\s+-e\s+httpd\b/i },
  { category: 'docs-site', pattern: /\b(?:hugo\s+server|jekyll\s+serve|mkdocs\s+serve|docsify\s+serve)\b/i },
  { category: 'app-server', pattern: /\b(?:uvicorn|gunicorn|flask\s+run|manage\.py\s+runserver|rails\s+(?:server|s))\b/i },
];

/**
 * 命令自己已经脱离父 shell（`nohup … &`、`setsid`、`disown`）时不必再包一层后台：
 * 那种写法本来就会立刻返回，再包一层反而会让「后台命令没能常驻」误报。
 */
export function backgroundsItself(command: string): boolean {
  const value = command.trim();
  if (/\bsetsid\b/.test(value)) return true;
  if (/\bdisown\b/.test(value)) return true;
  if (/\bnohup\b/.test(value)) return true;
  // 末尾单独一个 `&`（不是 `&&`、不是 `2>&1`）
  return /(?:^|[^&])&\s*$/.test(value);
}

export function isLongRunningServerCommand(command: string): LongRunningMatch | undefined {
  const value = command.trim();
  if (!value) return undefined;
  for (const { category, pattern } of SERVER_PATTERNS) {
    if (pattern.test(value)) return { category };
  }
  return undefined;
}

/**
 * 是否应该**由宿主自动转后台**：
 * 服务类命令 + 没有显式要求前台 + 自己没做后台化。
 *
 * 「显式要求前台」不存在对应参数（`background: false` 与缺省的语义相同），
 * 所以这里只需要排除「本来就自己后台化」的那一类。
 */
export function shouldAutoBackground(command: string): LongRunningMatch | undefined {
  const match = isLongRunningServerCommand(command);
  if (!match) return undefined;
  if (backgroundsItself(command)) return undefined;
  return match;
}
