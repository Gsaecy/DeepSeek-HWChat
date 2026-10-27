import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { COMMAND_BLOCK_PROMPT } from '../agent/commandPrompt';

/** media/code-block-meta.js 暴露的接口。 */
interface CodeBlockMeta {
  isShellLanguage: (value: string) => boolean;
  canonicalTool: (value: string) => string;
  normalizeLocation: (value: string) => string;
  parseFenceInfo: (value: string) => { language: string; location: string; tool: string };
  matchFenceStart: (value: string) => string | null;
  collectFenceBlock: (lines: string[], start: number) => { info: string; code: string; nextIndex: number } | null;
  dedentCode: (value: string) => string;
}

/**
 * 在 Node 里跑 webview 的纯函数脚本。
 *
 * media/ 下的文件是给 webview 用的普通脚本（不是模块），所以只能放进 vm 上下文里执行，
 * 再把它挂到全局的名字取回来。这样围栏解析规则就有了真正的测试，而不是只靠肉眼看渲染。
 */
function loadMeta(): CodeBlockMeta {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/code-block-meta.js', 'utf8'), sandbox);
  const meta = sandbox.HWChatCodeBlockMeta as CodeBlockMeta | undefined;
  assert.ok(meta, 'media/code-block-meta.js 必须挂载 HWChatCodeBlockMeta');
  return meta;
}

const meta = loadMeta();

/**
 * 取一份当前域里的普通对象再比较。
 *
 * vm 里创建的对象原型来自另一个 realm，assert 的严格深比较会因原型不同而失败，
 * 所以先展开成普通对象 —— 这里要断言的是字段值，不是原型。
 */
const parse = (info: string): { language: string; location: string; tool: string } => ({ ...meta.parseFenceInfo(info) });

test('parseFenceInfo：只写语言时保持旧行为', () => {
  assert.deepEqual(parse('bash'), { language: 'bash', location: '', tool: '' });
  assert.deepEqual(parse(''), { language: '', location: '', tool: '' });
  assert.deepEqual(parse(null as unknown as string), { language: '', location: '', tool: '' });
});

test('parseFenceInfo：认出位置与工具标注', () => {
  assert.deepEqual(parse('bash loc=local tool=bash'), { language: 'bash', location: 'local', tool: 'bash' });
  assert.deepEqual(parse('powershell loc=local tool=powershell'), { language: 'powershell', location: 'local', tool: 'powershell' });
  assert.deepEqual(parse('sh loc=server tool=bash'), { language: 'sh', location: 'server', tool: 'bash' });
  // 没有语言标记、只有标注时也要能解析
  assert.deepEqual(parse('loc=server'), { language: '', location: 'server', tool: '' });
});

test('parseFenceInfo：带引号的自定义位置可以含空格', () => {
  assert.deepEqual(parse('bash loc="GitHub Actions runner"'), {
    language: 'bash',
    location: 'GitHub Actions runner',
    tool: '',
  });
});

test('parseFenceInfo：别名与未知键', () => {
  // shell / where / host 都是位置的别名，pwsh 归一成 powershell
  assert.equal(meta.parseFenceInfo('sh where=remote').location, 'server');
  assert.equal(meta.parseFenceInfo('sh host=server').location, 'server');
  assert.equal(meta.parseFenceInfo('pwsh tool=pwsh').tool, 'powershell');
  // 未知键不影响其它字段
  const parsed = meta.parseFenceInfo('bash loc=local title="随便写" noise=1');
  assert.equal(parsed.language, 'bash');
  assert.equal(parsed.location, 'local');
});

test('normalizeLocation：本地 / 服务器 / 自定义 / 未标注', () => {
  for (const value of ['local', 'Local', '本地', '本地终端', '本机']) {
    assert.equal(meta.normalizeLocation(value), 'local', `应识别为本地：${value}`);
  }
  for (const value of ['server', 'remote', 'SSH', '服务器', '服务器终端', '远程服务器']) {
    assert.equal(meta.normalizeLocation(value), 'server', `应识别为服务器：${value}`);
  }
  // 自定义位置原样保留（界面直接显示）
  assert.equal(meta.normalizeLocation('Docker 容器'), 'Docker 容器');
  assert.equal(meta.normalizeLocation('  '), '');
  assert.equal(meta.normalizeLocation(null as unknown as string), '');
});

test('canonicalTool / isShellLanguage：工具归一', () => {
  assert.equal(meta.canonicalTool('pwsh'), 'powershell');
  assert.equal(meta.canonicalTool('PS1'), 'powershell');
  assert.equal(meta.canonicalTool('bat'), 'cmd');
  assert.equal(meta.canonicalTool('CMD.EXE'), 'cmd');
  assert.equal(meta.canonicalTool('Bash'), 'bash');
  assert.equal(meta.canonicalTool(''), '');

  for (const value of ['bash', 'zsh', 'sh', 'powershell', 'cmd', 'bat', 'shell']) {
    assert.ok(meta.isShellLanguage(value), `应认作终端命令：${value}`);
  }
  for (const value of ['js', 'typescript', 'json', 'python', '']) {
    assert.ok(!meta.isShellLanguage(value), `不应认作终端命令：${value}`);
  }
});

test('matchFenceStart：识别围栏开头，放过普通正文', () => {
  assert.equal(meta.matchFenceStart('```bash'), 'bash');
  assert.equal(meta.matchFenceStart('   ```bash loc=local'), 'bash loc=local');
  assert.equal(meta.matchFenceStart('````'), '');
  assert.equal(meta.matchFenceStart('  ```'), '');
  assert.equal(meta.matchFenceStart('正文里的 ``` 不算围栏开头'), null);
  assert.equal(meta.matchFenceStart('普通一行'), null);
  assert.equal(meta.matchFenceStart(''), null);
});

test('collectFenceBlock：列表里缩进的围栏能整块收走', () => {
  const lines = [
    '   ```bash loc=local',
    '   cd "/tmp/a b"',
    '   npm test',
    '   ```',
    '   预期：通过',
  ];
  const block = meta.collectFenceBlock(lines, 0);
  assert.ok(block);
  assert.equal(block.info, 'bash loc=local');
  assert.equal(block.code, '   cd "/tmp/a b"\n   npm test');
  // 结束围栏之后的一行由外层继续处理
  assert.equal(block.nextIndex, 4);
});

test('collectFenceBlock：流式输出没有结束围栏时，剩余行全算代码', () => {
  const lines = ['```bash', 'echo one', 'echo two'];
  const block = meta.collectFenceBlock(lines, 0);
  assert.ok(block);
  assert.equal(block.code, 'echo one\necho two');
  assert.equal(block.nextIndex, lines.length);
});

test('collectFenceBlock：结束围栏允许尾随空格，且不是围栏时返回 null', () => {
  const block = meta.collectFenceBlock(['```sh', 'ls', '```   ', 'after'], 0);
  assert.ok(block);
  assert.equal(block.code, 'ls');
  assert.equal(block.nextIndex, 3);
  assert.equal(meta.collectFenceBlock(['普通一行'], 0), null);
});

test('dedentCode：只删公共缩进，代码自身的层级保留', () => {
  assert.equal(meta.dedentCode('   cd /tmp\n   npm test'), 'cd /tmp\nnpm test');
  // 相对缩进必须保留（YAML / Python 依赖缩进）
  assert.equal(meta.dedentCode('  key:\n    - a\n    - b'), 'key:\n  - a\n  - b');
  // 空行不被当成缩进 0
  assert.equal(meta.dedentCode('  a\n\n  b'), 'a\n\nb');
  // 本来就顶格的内容不动
  assert.equal(meta.dedentCode('a\n  b'), 'a\n  b');
  // Windows 换行统一成 \n，复制出去不会带 \r
  assert.equal(meta.dedentCode('  a\r\n  b'), 'a\nb');
  assert.equal(meta.dedentCode(''), '');
});

test('提示词里的示例写法都能被解析器认出来', () => {
  // 从 prompt 里抽出示例（```lang loc=... tool=...），逐个过一遍解析器。
  // 这样「提示词教模型写什么」与「前端能读什么」不会各自跑偏。
  const examples = [...COMMAND_BLOCK_PROMPT.matchAll(/`{3}((?:bash|powershell|sh|zsh|cmd)\s[^`,。]+)/g)].map((match) => String(match[1] ?? '').trim());
  assert.ok(examples.length >= 3, `提示词里的围栏示例偏少：${examples.length}`);
  for (const example of examples) {
    const parsed = meta.parseFenceInfo(example);
    assert.ok(meta.isShellLanguage(parsed.language), `示例语言未被识别：${example}`);
    assert.ok(parsed.location, `示例缺少位置标注：${example}`);
    assert.ok(parsed.tool, `示例缺少工具标注：${example}`);
  }
});

test('提示词要求三种位置写法，并禁止把标注写进代码', () => {
  assert.match(COMMAND_BLOCK_PROMPT, /loc=local/);
  assert.match(COMMAND_BLOCK_PROMPT, /loc=server/);
  assert.match(COMMAND_BLOCK_PROMPT, /loc="<short label>"/);
  assert.match(COMMAND_BLOCK_PROMPT, /tool=cmd/);
  assert.match(COMMAND_BLOCK_PROMPT, /indent the fence/i);
  assert.match(COMMAND_BLOCK_PROMPT, /never put the location/i);
  assert.match(COMMAND_BLOCK_PROMPT, /verbatim/i);
});

test('webview 真的用上了这套解析（防止前端被改回旧写法）', () => {
  const chat = readFileSync('media/chat.js', 'utf8');
  assert.match(chat, /const codeMeta = globalThis\.HWChatCodeBlockMeta/, 'chat.js 必须读取 HWChatCodeBlockMeta');
  assert.match(chat, /codeMeta\.collectFenceBlock/, '围栏收集必须走公共实现');
  assert.match(chat, /codeMeta\.parseFenceInfo/, '位置/工具标注必须走公共实现');
  assert.match(chat, /codeMeta\.dedentCode/, '代码块必须去掉列表缩进');
  assert.match(chat, /appendListItemContent/, '列表条目必须能渲染内嵌代码块');
  // 降级路径必须仍然能收围栏，否则脚本没加载时代码块会退成正文
  assert.match(chat, /collectFenceBlock: \(lines, startIndex\) =>/, '降级实现必须自带围栏收集');

  const panel = readFileSync('src/views/chatPanel.ts', 'utf8');
  const metaIndex = panel.indexOf('src="${metaScript}"');
  const chatIndex = panel.indexOf('src="${script}"');
  assert.ok(metaIndex > 0, 'chatPanel 必须注入 code-block-meta.js');
  assert.ok(chatIndex > 0, 'chatPanel 必须注入 chat.js');
  assert.ok(metaIndex < chatIndex, 'code-block-meta.js 必须在 chat.js 之前加载');
});
