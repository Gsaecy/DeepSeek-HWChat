import { basename } from 'node:path';
import { commandSegments, tokenizeCommand } from './conversationScope';

/**
 * 版本管理策略：HWChat 不主动升版本，只在任务完成后**询问**用户。
 *
 * 背景（用户规则第 4 条）：
 * - 短任务：把这一轮对话里提到的所有问题都做完之后，才问「要不要升版本 / 要不要提交」；
 * - 长任务：只在明确的阶段边界、或者整个任务做完之后问；
 * - 中间过程里，除非用户自己要求，既不升版本也不提交 git。
 *
 * 只靠提示词约束并不可靠：模型很容易把「顺手把版本号也改了」当成收尾步骤。
 * 所以这里再提供一层运行时可判定的规则——把「升级版本」这件事本身识别出来：
 * 1. 文件侧：写入版本清单（package.json 等）时，项目自身的 version 字段是否被改动；
 * 2. 命令侧：是否在跑 `npm version` / `yarn version` / `standard-version` 这类工具。
 *
 * 本模块只做纯计算，不 import vscode，便于把边界写成单元测试。
 */

/** 项目版本号发生变化的一次尝试。 */
export interface VersionBump {
  from: string;
  to: string;
}

/** 顶层/根包 `version` 字段的 JSON 清单。 */
const JSON_MANIFESTS = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'manifest.json',
  'composer.json',
  'bower.json',
]);

/** `[package]` / `[project]` / `[tool.poetry]` 里写 `version = "x"` 的清单。 */
const TOML_MANIFESTS = new Set(['Cargo.toml', 'pyproject.toml']);

/** `version: 1.0.0+1` 形式的清单。 */
const YAML_MANIFESTS = new Set(['pubspec.yaml']);

/** Info.plist 里由 CFBundleShortVersionString 承担版本号。 */
const PLIST_MANIFESTS = new Set(['Info.plist']);

/** MSBuild 项目文件：`<Version>` / `<VersionPrefix>`。 */
const XML_SUFFIXES = ['.csproj', '.fsproj', '.vbproj', '.props', '.targets'];

/** 这些可执行文件本身就是在改版本号，不需要再看子命令。 */
const DIRECT_VERSION_TOOLS = new Set([
  'standard-version',
  'bumpversion',
  'bump2version',
  'bump-my-version',
]);

/** 包管理器里 `version` 子命令就是升版本（其它子命令不是）。 */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'poetry', 'changeset', 'lerna', 'rush']);

/** `npx standard-version` 这类包一层的前缀。 */
const RUN_AS_PREFIXES = new Set(['npx', 'pnpx', 'bunx']);

/**
 * 提示词里的版本规则。
 *
 * 写成常量而不是散在 chatPanel 的字符串数组里，是为了让「询问时机」这段规则
 * 能被测试直接引用，避免以后改文案时顺手把时机改掉。
 */
export const VERSION_RULE_PROMPT = [
  'Version numbers are the user\'s decision, not a finishing step: never bump a project version on your own — that includes editing the `version` field of package.json / package-lock.json / manifest.json and similar manifests, and running `npm version`, `yarn version`, `cargo set-version`, `standard-version` or git tag.',
  'When you believe a version bump and/or a git commit is due, ask the user in one short sentence and wait for an explicit yes. Ask only at these moments: (a) a short task — after every problem mentioned in this conversation is finished and verified; (b) a long task — at a clear phase boundary, or after the whole task is done.',
  'Never ask mid-task, never ask repeatedly, and never bundle the question into the middle of an unfinished step. Until the user answers yes, keep versions and git history untouched and continue with the remaining work.',
].join(' ');

/** 文件名本身是否属于「带项目版本号」的清单。 */
export function isVersionManifest(fileName: string): boolean {
  const name = basename(fileName.replace(/\\/g, '/'));
  const lower = name.toLocaleLowerCase();
  return JSON_MANIFESTS.has(name)
    || TOML_MANIFESTS.has(name)
    || YAML_MANIFESTS.has(name)
    || PLIST_MANIFESTS.has(name)
    || XML_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * 取出一份清单里**项目自身**的版本号。
 *
 * 只认项目级字段：`package-lock.json` 里成百上千个依赖版本不参与比较，
 * 否则 `npm install` 顺手更新依赖就会被误判成「升级版本」。
 * 解析失败返回 undefined —— 此时不做拦截（宁可放过，也不要拦住正常的文件修复）。
 */
export function projectVersionOf(fileName: string, content: string): string | undefined {
  const name = basename(fileName.replace(/\\/g, '/'));
  if (JSON_MANIFESTS.has(name)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') {
      const packages = record.packages;
      if (packages && typeof packages === 'object') {
        const root = (packages as Record<string, unknown>)[''];
        if (root && typeof root === 'object') {
          const version = (root as Record<string, unknown>).version;
          if (typeof version === 'string' && version) return version;
        }
      }
    }
    return typeof record.version === 'string' && record.version ? record.version : undefined;
  }
  if (TOML_MANIFESTS.has(name)) {
    // 只认行首的 `version = "x"`：`serde = { version = "1" }` 这类依赖声明不会命中。
    const match = /(?:^|\n)[ \t]*version[ \t]*=[ \t]*["']([^"']+)["']/.exec(content);
    return match?.[1];
  }
  if (YAML_MANIFESTS.has(name)) {
    const match = /(?:^|\n)[ \t]*version[ \t]*:[ \t]*([^\s#]+)/.exec(content);
    return match?.[1];
  }
  if (PLIST_MANIFESTS.has(name)) {
    const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]+)<\/string>/.exec(content);
    return match?.[1]?.trim();
  }
  if (XML_SUFFIXES.some((suffix) => name.toLocaleLowerCase().endsWith(suffix))) {
    const match = /<(?:Version|VersionPrefix)>\s*([^<]+?)\s*<\/(?:Version|VersionPrefix)>/.exec(content);
    return match?.[1];
  }
  return undefined;
}

/**
 * 判断一次文件写入是否改动了项目版本号。
 *
 * - 非版本清单、新建文件（before 为空）、解析不出版本号 → 一律不判定为升版本；
 * - 只改依赖版本 / 只改格式 → 不判定。
 */
export function detectVersionBump(
  fileName: string,
  before: string | undefined,
  after: string,
): VersionBump | undefined {
  if (!before || !isVersionManifest(fileName)) return undefined;
  const from = projectVersionOf(fileName, before);
  if (!from) return undefined;
  const to = projectVersionOf(fileName, after);
  if (!to || to === from) return undefined;
  return { from, to };
}

/**
 * 命令里是否在**升级版本**，返回被识别的工具名（例如 `npm version`）。
 *
 * 只看命令头：`git commit -m "bump version"`、`echo "npm version"` 这类
 * 把工具名当参数或提交说明的写法不会命中。
 */
export function versionBumpCommand(command: string): string | undefined {
  for (const segment of commandSegments(command)) {
    const hit = versionBumpCommandInSegment(segment);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 桥接工具的 JSON 参数里是否夹带升版本命令。
 *
 * 与 conversationScope.argumentsMentionGitWrite 同样的理由：VS Code 侧工具
 * （例如 run_in_terminal）的授权由 VS Code 自己决定，如果只拦原生 run_command，
 * 模型换个通道跑 `npm version` 就绕过去了。
 */
export function argumentsMentionVersionBump(rawArguments: string): boolean {
  if (!rawArguments) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return versionBumpCommand(rawArguments) !== undefined;
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
  return values.some((value) => versionBumpCommand(value) !== undefined);
}

/**
 * 用户这一轮是否**明确要求**升级版本。
 *
 * 与 git 的判定口径一致：这里只用于「放行」，判 false 不代表用户不想升版本，
 * 只代表没有明确要求——那正是要拦的情况。否定写法（不要升版本）优先。
 *
 * 已知误判面：`这个版本改了缓存` 这类把「版本」当普通名词、又恰好带了「改」字的句子
 * 会被判为授权。方向上是「不拦可能的真实请求」，代价是需要用户自己纠正。
 */
export function hasVersionBumpIntent(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (VERSION_NEGATION.test(value)) return false;
  return VERSION_BUMP_PATTERN.test(value);
}

/**
 * 技能规则是否要求升级版本。
 *
 * 与 git 技能规则同等效力：技能是用户自己启用并加载的，视同用户要求。
 */
export function hasSkillVersionRule(skillPrompt: string): boolean {
  return VERSION_BUMP_PATTERN.test(skillPrompt ?? '');
}

/**
 * 版本写操作是否已获授权。
 *
 * 返回 undefined 时调用方必须拒绝，并提示模型「先去问用户」，
 * 不能让模型凭历史记忆继续重试。
 */
export function versionBumpAuthorization(input: {
  userText?: string;
  skillPrompt?: string;
}): 'user' | 'skill' | undefined {
  if (hasVersionBumpIntent(input.userText ?? '')) return 'user';
  if (hasSkillVersionRule(input.skillPrompt ?? '')) return 'skill';
  return undefined;
}

/** 「版本」与「升级动作」在同一句里、且距离很近。 */
const VERSION_BUMP_PATTERN = new RegExp(
  [
    '(?:版本号?|version)[^。；;!?\\n]{0,8}(?:升级|升|提升|改|更新|调整|设为|定为|bump|upgrade|increment|change|update|set)',
    '(?:升级|升|提升|修改|更改|改|更新|调整|bump|upgrade|increment|change|set)[^。；;!?\\n]{0,6}(?:版本号?|version)',
  ].join('|'),
  'i',
);

/** 明确否定：`不要自己升级版本` / `don't bump the version`。 */
const VERSION_NEGATION = new RegExp(
  [
    '(?:不要|不用|无需|别|禁止|不得|先不|暂不|不需要)[^。；;\\n]{0,12}(?:版本号?|version)',
    "(?:don'?t|do not|never|no need to)[^.;\\n]{0,20}(?:version)",
  ].join('|'),
  'i',
);

function versionBumpCommandInSegment(segment: string): string | undefined {
  const tokens = tokenizeCommand(segment);
  let index = 0;
  // 跳过 `FOO=bar npm version` 这类前置赋值。
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1;
  let head = tokens[index];
  if (!head) return undefined;
  let name = basename(head.replace(/\\/g, '/')).toLocaleLowerCase();
  if (RUN_AS_PREFIXES.has(name)) {
    index += 1;
    while (index < tokens.length && tokens[index]!.startsWith('-')) index += 1;
    head = tokens[index];
    if (!head) return undefined;
    name = basename(head.replace(/\\/g, '/')).toLocaleLowerCase();
    index += 1;
  } else {
    index += 1;
  }
  if (DIRECT_VERSION_TOOLS.has(name)) return name;
  const verb = tokens[index]?.toLocaleLowerCase();
  if (!verb) return undefined;
  // `npm --version`（打印版本）不会被当成升版本：那是全局选项，不是子命令。
  if (PACKAGE_MANAGERS.has(name) && verb === 'version') return `${name} version`;
  if (name === 'cargo' && verb === 'set-version') return 'cargo set-version';
  return undefined;
}
