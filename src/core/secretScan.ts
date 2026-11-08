/**
 * 敏感信息识别（宿主侧唯一判据）。
 *
 * 为什么要有这一份（2026-11-08 外部评审 ⑥/⑮）：
 * 界面层的 `media/secret-scan.js` 只能「提醒用户」，管不到**数据出站**。
 * 同一段文字会经三条通道离开本机：
 *
 *   1. 发给聊天模型（`read_file` / 命令输出 / 对话正文）
 *   2. 发给向量服务（`embeddingInput(message.content)`）
 *   3. 写进审计与日志
 *
 * 所以判据必须在宿主侧、且只有一份：本文件不 import `vscode`，可以被扩展、
 * 单测、守护脚本共用。`media/secret-scan.js` 保留给界面（webview 不能 import TS），
 * 两者的一致性由 `test/check-secret-egress.mjs` 用同一组语料比对。
 *
 * 设计取舍（与界面层一致，避免「狼来了」）：
 *  - 只认有名字的密钥格式 + 显式的字段赋值；
 *  - 排除占位符与「值在别处」的引用；
 *  - 不做熵判断（会把 commit hash、base64 图片、版本号全算成泄露）。
 */

export type SecretKind =
  | 'privateKey' | 'awsAccessKey' | 'githubToken' | 'anthropicKey'
  | 'googleApiKey' | 'slackToken' | 'openaiKey' | 'jwt' | 'bearerToken'
  | 'credentialAssignment'
  | 'idCard' | 'bankCard' | 'phoneNumber';

export interface SecretFinding {
  kind: SecretKind;
  /** 仅 `credentialAssignment` 有：命中的字段名（不含值）。 */
  field?: string;
  /** 命中的长度：用于告知「有多少字符」，绝不回显内容。 */
  length: number;
  /** 在原文中的起点。 */
  index: number;
  /** 在原文中的终点（用于精确遮罩整段命中，含 `field=` 前缀）。 */
  end: number;
  category: 'credential' | 'privacy';
}

interface Rule {
  kind: SecretKind;
  pattern: RegExp;
  category?: 'credential' | 'privacy';
  validate?: (value: string) => boolean;
}

const PREFIX_RULES: readonly Rule[] = [
  { kind: 'privateKey', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
  { kind: 'awsAccessKey', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'githubToken', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: 'anthropicKey', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'googleApiKey', pattern: /\bAIza[0-9A-Za-z_-]{35,}/g },
  { kind: 'slackToken', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'openaiKey', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  { kind: 'bearerToken', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  { kind: 'idCard', pattern: /\b\d{17}[\dXx]\b/g, category: 'privacy', validate: isValidIdCard },
  { kind: 'bankCard', pattern: /\b\d{16,19}\b/g, category: 'privacy', validate: isValidBankCard },
  { kind: 'phoneNumber', pattern: /\b1[3-9]\d{9}\b/g, category: 'privacy' },
];

const ASSIGNMENT_RULE =
  /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|pwd)\b\s*[:=]\s*["'`]?([^\s"'`,;)}]{8,})["'`]?|([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY))\s*[:=]\s*["'`]?([^\s"'`,;)}]{8,})["'`]?/gi;

const PLACEHOLDER = /(?:your|example|sample|placeholder|dummy|redacted|changeme|change[_-]?me|insert|replace|todo|fixme|<|>|\$\{|\{\{|\.\.\.|x{3,}|X{3,}|\*{3,})/;
const REPEATED = /^(.)\1+$/;
const MIN_VALUE_LENGTH = 8;

/** 「值在别处」：这几种写法后面跟的不是密钥本身。 */
const REFERENCE_PATTERNS: readonly RegExp[] = [
  /^(?:process\.env|import\.meta\.env|Deno\.env|os\.environ|os\.getenv|env|getenv)\b/i,
  /^(?:\$\{|\$[A-Za-z_]|%[A-Za-z_][\w]*%$)/,
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/,
  /^(?:undefined|null|true|false)$/i,
];

function isReference(value: string): boolean {
  return !value || REFERENCE_PATTERNS.some((pattern) => pattern.test(value));
}

function isPlaceholder(value: string): boolean {
  if (value.length < MIN_VALUE_LENGTH) return true;
  if (REPEATED.test(value)) return true;
  return PLACEHOLDER.test(value);
}

function isValidIdCard(value: string): boolean {
  const text = value.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(text)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkTable = '10X98765432';
  let sum = 0;
  for (let index = 0; index < 17; index += 1) sum += Number(text[index]) * weights[index]!;
  if (checkTable[sum % 11] !== text[17]) return false;
  const year = Number(text.slice(6, 10));
  const month = Number(text.slice(10, 12));
  const day = Number(text.slice(12, 14));
  return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function looksLikeIdCardShape(text: string): boolean {
  if (text.length !== 18 || !/^\d{17}[\dX]$/i.test(text)) return false;
  const province = Number(text.slice(0, 2));
  if (province < 11 || province > 82) return false;
  const year = Number(text.slice(6, 10));
  const month = Number(text.slice(10, 12));
  const day = Number(text.slice(12, 14));
  return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function isValidBankCard(value: string): boolean {
  if (!/^\d{16,19}$/.test(value)) return false;
  if (REPEATED.test(value)) return false;
  if (looksLikeIdCardShape(value)) return false;
  let sum = 0;
  let doubling = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubling) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubling = !doubling;
  }
  return sum % 10 === 0;
}

/**
 * 扫描一段文本里的明文凭据/隐私。
 *
 * 返回按出现位置排序、互不重叠的条目；**只含类型与长度，不含原文**。
 */
export function scanSecrets(text: string): SecretFinding[] {
  const source = String(text ?? '');
  if (!source.trim()) return [];

  const claimed: Array<[number, number]> = [];
  const findings: SecretFinding[] = [];
  const claim = (start: number, end: number): boolean => {
    if (end <= start) return false;
    for (const range of claimed) {
      if (start < range[1] && range[0] < end) return false;
    }
    claimed.push([start, end]);
    return true;
  };

  for (const rule of PREFIX_RULES) {
    for (const match of source.matchAll(rule.pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const value = match[0];
      if (rule.validate && !rule.validate(value)) continue;
      if (rule.category !== 'privacy' && isPlaceholder(value)) continue;
      if (!claim(start, end)) continue;
      findings.push({
        kind: rule.kind,
        length: value.length,
        index: start,
        end,
        category: rule.category ?? 'credential',
      });
    }
  }

  for (const match of source.matchAll(ASSIGNMENT_RULE)) {
    const field = match[1] ?? match[3] ?? '';
    const value = match[2] ?? match[4] ?? '';
    if (!field || !value) continue;
    if (isPlaceholder(value) || isReference(value)) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!claim(start, end)) continue;
    findings.push({
      kind: 'credentialAssignment',
      field: field.toLowerCase(),
      length: value.length,
      index: start,
      end,
      category: 'credential',
    });
  }

  return findings.sort((a, b) => a.index - b.index);
}

/** 是否命中任何敏感内容。 */
export function hasSecrets(text: string): boolean {
  return scanSecrets(text).length > 0;
}

/** 去重后的类型名（用于提示；不暴露值）。 */
export function secretKinds(findings: readonly SecretFinding[]): string[] {
  return [...new Set(findings.map((item) => item.kind))];
}

/**
 * 出站前的最后一道：把命中的值替换成占位符。
 *
 * 只在「明确不需要原文」的通道上使用（向量索引入参）；`read_file` 不能用它 ——
 * 模型要靠原文做精确替换，改写会让 `replace_in_file` 失配。
 */
export function maskSecrets(text: string): string {
  const source = String(text ?? '');
  const findings = scanSecrets(source);
  if (!findings.length) return source;
  let output = '';
  let cursor = 0;
  for (const finding of findings) {
    if (finding.index < cursor) continue;
    output += source.slice(cursor, finding.index);
    output += `[REDACTED:${finding.kind}]`;
    cursor = finding.end;
  }
  return output + source.slice(cursor);
}
