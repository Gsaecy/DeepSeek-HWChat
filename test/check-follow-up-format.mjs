/*
 * 校验「需要你做的」清单里的方括号真的不会出现在界面上。
 *
 * 为什么不能只靠静态断言：干净的那一半靠提示词（模型别写），
 * 兜底的那一半靠 chat.js 渲染时剥掉标记。静态 grep 只能证明代码在，
 * 证明不了列表渲染出来是什么样。所以这里把 chat.js 里真正的 appendList
 * 原样切出来跑一遍，检查最终的列表项文本。
 *
 * 用法：node test/check-follow-up-format.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let checks = 0;
let failures = 0;
function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}`);
}

/** 最小 DOM 节点：够 appendList 用即可。 */
function makeNode(tag) {
  return {
    tagName: tag,
    start: undefined,
    textContent: '',
    children: [],
    append(...nodes) { this.children.push(...nodes); },
    after(node) { this.next = node; },
  };
}

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');

/** 从 chat.js 切出列表解析那一段（isListLine → appendList 结束）。 */
function extractListBlock(source) {
  const start = source.indexOf('function isListLine(line)');
  const next = source.indexOf('function splitTableRow(line)');
  if (start < 0 || next <= start) throw new Error('没找到 chat.js 里的列表解析代码');
  return source.slice(start, next);
}

function loadListItemTexts(authoritative) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  // 认准真实的媒体模块；`authoritative` 为 false 时不挂载，模拟模块没加载成功。
  if (authoritative) {
    vm.createContext(sandbox.globalThis);
    vm.runInContext(readFileSync('media/follow-up-format.js', 'utf8'), sandbox);
  }
  sandbox.followUpFormat = sandbox.HWChatFollowUpFormat || null;
  sandbox.document = { createElement: (tag) => makeNode(tag) };
  sandbox.codeMeta = { collectFenceBlock: () => null };
  // 正文怎么排不关心：appendListItemContent 会用 appendInline 往 li 里写文字，
  // 这里把它收成纯文本，断言只看算出来的列表项文本。
  sandbox.appendInline = (li, text) => { li.textContent += String(text); };
  sandbox.codeBlockNode = () => makeNode('pre');
  vm.createContext(sandbox);
  vm.runInContext(`${extractListBlock(CHAT_JS)}\nglobalThis.__appendList = appendList;`, sandbox);
  return (lines, start = 0) => {
    const container = makeNode('div');
    sandbox.__appendList(container, lines, start);
    const collect = (node, out = []) => {
      for (const child of node.children || []) {
        if (child.tagName === 'li') out.push(child.textContent);
        collect(child, out);
      }
      return out;
    };
    return collect(container);
  };
}

const render = loadListItemTexts(true);

/* ── 1. 真实渲染 ─────────────────────────────────────────── */

// 用户截图里的原样。
const screenshot = [
  '🔔 需要你做的',
  '1. [ ] **先确认重载过没有**：如果上一轮之后没执行 Reload Window。',
  '2. [ ] **回一个「跑到 40 秒」**：我用 sleep 200 + 上限 75 秒跑一条。',
  '3. [x] **验 toast 时长**：下次它出现时，点它一下。',
];
const rendered = render(screenshot, 1);
check(`有序列表渲染出 3 项（实际 ${rendered.length}）`, rendered.length === 3);
check('第 1 项不再含 [ ]', !rendered[0].includes('[') && rendered[0].startsWith('**先确认重载过没有**'));
check('第 2 项不再含 [ ]', !rendered[1].includes('['));
check('第 3 项把 [x] 也剥掉了', !rendered[2].includes('[') && rendered[2].startsWith('**验 toast 时长**'));

// 真正的任务列表不能被动。
const taskList = render(['- [ ] 修复登录', '- [x] 补测试']);
check('无序任务列表保持原样（不误伤 GFM 语义）', taskList[0] === '[ ] 修复登录' && taskList[1] === '[x] 补测试');

// 正文里出现的方括号不能被当成标记吃掉。
const prose = render(['1. 数组 arr[ ] 是空的', '2. 见 [文档](https://example.com)']);
check('正文中的方括号不受影响', prose[0] === '数组 arr[ ] 是空的');
check('行内链接不受影响', prose[1].includes('文档'));

// 数学：以 `[x]` 紧贴文字（没有空格）时不是标记。
const tight = render(['1. [x]紧贴文字']);
check('紧贴的 [x] 不当标记', tight[0] === '[x]紧贴文字');

/* ── 2. 模块缺失时的退化 ─────────────────────────────────── */

const renderWithoutModule = loadListItemTexts(false);
const degraded = renderWithoutModule(['1. [ ] **动作**']);
check('模块没加载成功时原样显示（行为与改动前一致）', degraded[0] === '[ ] **动作**');

/* ── 3. 接线断言 ─────────────────────────────────────────── */

check('chat.js 读取 globalThis.HWChatFollowUpFormat', CHAT_JS.includes('const followUpFormat = globalThis.HWChatFollowUpFormat || null;'));
check('appendList 通过 listItemText 取正文', CHAT_JS.includes('followUpFormat.listItemText(match[2], match[3])') || CHAT_JS.includes('followUpFormat ? followUpFormat.listItemText(match[2], match[3]) : match[3]'));
check('chatPanel 注入 follow-up-format.js', PANEL.includes("mediaUri(webview, this.extensionUri, 'follow-up-format.js')"));
check('页面里有 followUpFormatScript 的 script 标签', PANEL.includes('src="${followUpFormatScript}"'));

const injected = PANEL.indexOf('src="${followUpFormatScript}"');
const chatTag = PANEL.indexOf('src="${script}"');
check('注入早于 chat.js（否则加载时读不到模块）', injected > 0 && chatTag > injected);

/* ── 4. 提示词接线 ───────────────────────────────────────── */

check('系统提示词引用 FOLLOW_UP_PROMPT', PANEL.includes('FOLLOW_UP_PROMPT,'));
const promptAt = PANEL.indexOf('FOLLOW_UP_PROMPT,');
const historyAt = PANEL.indexOf('historyPrompt,');
check('提示词排在历史摘要之前', promptAt > 0 && historyAt > promptAt);

console.log('');
if (failures) {
  console.log(`${failures} 项失败 / 共 ${checks} 项`);
  process.exit(1);
}
console.log(`全部通过：${checks} 项`);
