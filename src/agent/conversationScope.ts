import { basename } from 'node:path';

/**
 * 对话作用域：git 写操作的判定，以及「本次对话属于哪个项目」的推断。
 *
 * 背景（真实缺陷）：
 * 1. `run_command` 的 `cwd` 默认值是 `'.'`，而多根工作区里 `'.'` 会解析到**第一个**
 *    工作区根目录。于是「提交一下」这类指令可能在 `Safevault_android` 里执行，
 *    而不是当前正在优化的项目 —— 而且默认预设会把 `git add` / `git commit`
 *    直接放行，错误仓库的提交会静默成功。
 * 2. 没有任何一处区分「用户要求提交」和「模型自己想提交」，模型可以把提交当成
 *    「顺手做的事」写进收尾步骤。
 *
 * 本模块只做纯计算，不 import vscode，便于把边界写成单元测试。
 */

export type GitOperationKind = 'read' | 'write';

export interface GitOperation {
  kind: GitOperationKind;
  /** 子命令本身，用于提示文案（例如 commit / push）。 */
  verb: string;
}

/**
 * 明确只读的 git 子命令。
 * 只列真正不写仓库、不改索引、不动引用的那些。
 */
const GIT_READ_VERBS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'describe', 'blame', 'shortlog',
  'ls-files', 'ls-tree', 'cat-file', 'show-ref', 'for-each-ref', 'name-rev',
  'whatchanged', 'count-objects', 'grep', 'version', 'help', 'var', 'merge-base',
  'diff-tree', 'diff-files', 'diff-index', 'rev-list', 'verify-commit', 'verify-tag',
  'fsck', 'check-ignore', 'check-attr', 'show-branch', 'cherry', 'range-diff',
]);

/**
 * 明确会写仓库的 git 子命令：提交、推送、改索引/引用、改历史、搬文件都算。
 * 未列出的子命令一律不判为写操作（避免把无关命令误杀）；真正危险的是
 * commit / push / add / reset / clean 这些，全部在列表内。
 */
const GIT_WRITE_VERBS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit',
  'commit-tree', 'fetch', 'filter-branch', 'format-patch', 'gc', 'init', 'merge',
  'mv', 'prune', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm',
  'repack', 'switch', 'update-ref', 'bisect', 'histogram', 'maintenance',
]);

/** 既可读也可写的子命令：看参数决定。 */
const GIT_MIXED_VERBS = new Set(['branch', 'remote', 'config', 'tag', 'stash', 'reflog', 'notes', 'worktree', 'submodule', 'bisect']);

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix',
]);

/**
 * 取出命令里所有的 git 子命令。
 *
 * 只看「命令头就是 git」的段落：`echo git commit`、`grep 'git push' log.txt`
 * 这类把 git 当参数而不是当命令的写法不会命中，避免误杀正常命令。
 */
export function gitOperationsIn(command: string): GitOperation[] {
  const operations: GitOperation[] = [];
  for (const segment of splitSegments(command)) {
    const operation = gitOperationInSegment(segment);
    if (operation) operations.push(operation);
  }
  return operations;
}

/** 命令里第一个 git 写操作；没有则返回 undefined。 */
export function gitWriteOperation(command: string): GitOperation | undefined {
  return gitOperationsIn(command).find((operation) => operation.kind === 'write');
}

/** 命令里是否出现 git 写操作。 */
export function isGitWriteCommand(command: string): boolean {
  return gitWriteOperation(command) !== undefined;
}

/**
 * 桥接工具的 JSON 参数里是否夹带 git 写操作。
 *
 * VS Code 侧工具（例如 run_in_terminal）会把命令放在参数里，而它们的授权由
 * VS Code 自己决定——如果只拦 HWChat 原生 `run_command`，模型换个通道提交就绕过去了。
 * 这里把参数里所有字符串取出来逐个判定，宁可多拦一次也不放过。
 */
export function argumentsMentionGitWrite(rawArguments: string): boolean {
  if (!rawArguments) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    // 解析失败时按原文判断：命令通常仍以明文出现在字符串里。
    return mentionsGitWrite(rawArguments);
  }
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(parsed);
  return values.some((value) => isGitWriteCommand(value) || mentionsGitWrite(value));
}

/**
 * 自由文本（技能正文、JSON 片段）里是否提到 git 写操作。
 *
 * 技能正文是给人和模型读的说明文字，"完成后执行 git commit" 这类句子的命令头
 * 并不是 git，用严格的命令解析抓不到；这里放宽成「出现 git + 写子命令」即可。
 * 只用于「授予权限」和「桥接通道兜底」，不用于原生命令的精确放行判断。
 */
export function mentionsGitWrite(text: string): boolean {
  return /\bgit(?:\.exe)?\s+(?:add|am|apply|checkout|cherry-pick|clean|clone|commit|fetch|filter-branch|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag|update-ref)(?![A-Za-z0-9_-])/i.test(text);
}

/**
 * 用户这一轮是否**明确要求**了 git 写操作。
 *
 * 只作为「允许」的判据之一，不作为禁止的判据：即使这里判 false，模型仍可能
 * 自己想提交，那正是要拦的情况。否定写法（不要提交 / don't commit）优先。
 */
export function hasGitWriteIntent(text: string): boolean {
  const value = text.trim().toLocaleLowerCase();
  if (!value) return false;
  if (/(?:不要|不用|无需|别|禁止|不得|先不|暂不)\s*(?:提交|推送|commit|push)/i.test(value)) return false;
  if (/(?:don'?t|do not|never|no need to|without)\s+(?:git\s+)?(?:commit|push|add|tag)/i.test(value)) return false;
  return /(?:提交|推送|打\s*tag|打标签|git\s+add|git\s+commit|git\s+push|\bcommit\b|\bpush\b)/i.test(value);
}

/**
 * 技能规则是否要求「完成后提交」。
 *
 * 用户的原话：调用「完成任务后执行提交 git」的技能规则，等同于用户要求提交。
 * 技能正文里出现 git 写操作即视为授权；技能是用户自己启用并加载的，
 * 因此它和用户口头要求具有同等效力。
 *
 * 技能正文是说明文字而不是命令，这里用宽松匹配（`完成后再 git commit`
 * 这种句子的命令头同样不是 git），否则会把授权漏判成「用户没要求」。
 */
export function hasSkillGitWriteRule(skillPrompt: string): boolean {
  if (!skillPrompt) return false;
  return mentionsGitWrite(skillPrompt) || gitOperationsIn(skillPrompt).some((operation) => operation.kind === 'write');
}

/**
 * git 写操作是否已获授权。
 *
 * 注意返回值只用于「放行」，未授权时调用方必须拒绝并给出可执行的下一步，
 * 不能让模型凭历史记忆继续尝试。
 */
export function gitWriteAuthorization(input: {
  userText?: string;
  skillPrompt?: string;
}): 'user' | 'skill' | undefined {
  if (hasGitWriteIntent(input.userText ?? '')) return 'user';
  if (hasSkillGitWriteRule(input.skillPrompt ?? '')) return 'skill';
  return undefined;
}

/**
 * 把一条命令拆成可以独立判断的段落。
 *
 * 导出给同目录的 releasePolicy 复用：版本号工具的识别同样需要「按命令头判断」，
 * 各写一套分词会在 `echo "npm version"` 这类地方逐渐分叉。
 */
export function commandSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|&\n])/).map((segment) => segment.trim()).filter(Boolean);
}

const splitSegments = commandSegments;

function gitOperationInSegment(segment: string): GitOperation | undefined {
  const tokens: string[] = tokenizeCommand(segment);
  let index = 0;
  // 跳过 `FOO=bar git status` 这类前置赋值。
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1;
  const head = tokens[index];
  if (!head) return undefined;
  if (basename(head.replace(/\\/g, '/')).toLocaleLowerCase() !== 'git' && basename(head.replace(/\\/g, '/')).toLocaleLowerCase() !== 'git.exe') {
    return undefined;
  }
  index += 1;
  // 跳过 `git -C <path>`、`git --no-pager` 这类全局选项。
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (!token.startsWith('-')) break;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('--') && token.includes('=')) {
      index += 1;
      continue;
    }
    index += 1;
  }
  const verb = tokens[index]?.toLocaleLowerCase();
  if (!verb) return undefined;
  const rest = tokens.slice(index + 1);
  const kind = classifyGitVerb(verb, rest);
  return kind ? { kind, verb } : undefined;
}

function classifyGitVerb(verb: string, rest: readonly string[]): GitOperationKind | undefined {
  if (GIT_READ_VERBS.has(verb)) return 'read';
  if (GIT_WRITE_VERBS.has(verb)) return 'write';
  if (!GIT_MIXED_VERBS.has(verb)) return undefined;
  const sub = rest.find((token) => !token.startsWith('-'))?.toLocaleLowerCase();
  switch (verb) {
    case 'branch':
      if (!rest.length) return 'read';
      if (rest.some((token) => /^-(?:d|D|m|M|c|C|f|u|set-upstream-to)(?:$|=)/.test(token))) return 'write';
      if (rest.some((token) => /^--(?:delete|move|copy|force|set-upstream-to)/.test(token))) return 'write';
      // 带裸分支名（无 - 开头参数）视为创建分支。
      return rest.some((token) => !token.startsWith('-')) ? 'write' : 'read';
    case 'remote':
      if (!rest.length) return 'read';
      if (rest.some((token) => /^(?:add|remove|rename|set-url|set-head|prune|update)$/i.test(token))) return 'write';
      return 'read';
    case 'config':
      if (rest.some((token) => /^(?:--get|--get-all|--get-regexp|--list|-l|--show-origin)$/i.test(token))) return 'read';
      return rest.length ? 'write' : 'read';
    case 'tag':
      if (!rest.length) return 'read';
      if (rest.some((token) => /^(?:-l|--list|-n\d*|-v|--verify|-d|--delete|-f|--force|-a|--annotate|-s|--sign|-m|--message)$/i.test(token))) {
        return rest.some((token) => /^(?:-d|--delete|-f|--force|-a|--annotate|-s|--sign|-m|--message)$/i.test(token)) ? 'write' : 'read';
      }
      return rest.some((token) => !token.startsWith('-')) ? 'write' : 'read';
    case 'stash':
      if (!rest.length) return 'write';
      if (['list', 'show', 'create', 'branch'].includes(sub ?? '')) return 'read';
      return 'write';
    case 'reflog':
      if (!rest.length) return 'read';
      return ['expire', 'delete', 'drop'].includes(sub ?? '') ? 'write' : 'read';
    case 'notes':
      if (!rest.length) return 'read';
      return ['list', 'show'].includes(sub ?? '') ? 'read' : 'write';
    case 'worktree':
      if (!rest.length) return 'read';
      return sub === 'list' ? 'read' : 'write';
    case 'submodule':
      if (!rest.length) return 'read';
      return ['status', 'summary'].includes(sub ?? '') ? 'read' : 'write';
    case 'bisect':
      if (!rest.length) return 'read';
      return ['log', 'view'].includes(sub ?? '') ? 'read' : 'write';
    default:
      return undefined;
  }
}

/** 极简分词：只处理引号与转义，够定位命令头与子命令。导出给 releasePolicy 复用。 */
export function tokenizeCommand(segment: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < segment.length) {
    if (/\s/.test(segment[index]!)) {
      index += 1;
      continue;
    }
    let text = '';
    while (index < segment.length && !/\s/.test(segment[index]!)) {
      const current = segment[index]!;
      if (current === "'" || current === '"') {
        const quote = current;
        index += 1;
        while (index < segment.length && segment[index] !== quote) {
          if (quote === '"' && segment[index] === '\\' && index + 1 < segment.length) index += 1;
          text += segment[index];
          index += 1;
        }
        index += 1;
        continue;
      }
      text += current;
      index += 1;
    }
    if (text) tokens.push(text);
  }
  return tokens;
}
