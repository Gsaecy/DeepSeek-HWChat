import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  INTERNET_REFERENCE_PROMPT,
  checkFetchableUrl,
  decodeEntities,
  formatHits,
  htmlToText,
  isPrivateHost,
  parseFeedItems,
  parseGitHubRepos,
  withInternetReference,
} from '../core/research';

/**
 * 「互联网参考」：开启后 agent 必须先上网找成熟方案再动手。
 *
 * 这里钉住三件容易做坏的事：
 *  1. 提示词必须**真的**要求先调研再执行，并且明确「搜不到就说搜不到」；
 *  2. 取网页的地址过滤必须挡住本机与内网（模型会顺手拼 localhost）；
 *  3. 解析器只按**实测过的真实响应**形状写：GitHub 搜索 API 的 JSON、RSS 的 item。
 */

const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');
const RUNNER = readFileSync('src/agent/agentRunner.ts', 'utf8');
const CSS = readFileSync('media/chat.css', 'utf8');
const I18N = readFileSync('src/core/i18n.ts', 'utf8');

test('地址过滤：只放行公开的 http(s)', () => {
  assert.equal(checkFetchableUrl('https://threejs.org/docs/').ok, true);
  assert.equal(checkFetchableUrl('http://example.com/a?b=1').ok, true);
  assert.equal(checkFetchableUrl('  https://developer.mozilla.org/x  ').ok, true, '两侧空白要容忍');
  // 非 http 协议
  assert.equal(checkFetchableUrl('file:///etc/passwd').ok, false);
  assert.equal(checkFetchableUrl('javascript:alert(1)').ok, false);
  assert.equal(checkFetchableUrl('data:text/html,hi').ok, false);
  // 不是 URL
  assert.equal(checkFetchableUrl('').ok, false);
  assert.equal(checkFetchableUrl('example.com').ok, false);
  // URL 里带凭据
  assert.equal(checkFetchableUrl('https://user:pass@example.com/').ok, false);
});

test('地址过滤：本机与内网一律拒绝（模型会顺手拼 localhost）', () => {
  for (const url of [
    'http://localhost:3000/',
    'http://127.0.0.1:8080/',
    'http://0.0.0.0/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.3.4/',
    'http://172.31.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://mybox.local/',
    'http://intranet/',
  ]) {
    assert.equal(checkFetchableUrl(url).ok, false, `${url} 不该放行`);
  }
  // 边界：172.32 与 172.15 不是私有段
  assert.equal(checkFetchableUrl('http://172.32.0.1/').ok, true);
  assert.equal(checkFetchableUrl('http://172.15.0.1/').ok, true);
  assert.equal(isPrivateHost('8.8.8.8'), false);
});

test('HTML → 正文：去脚本样式、块级换行、解实体、截断', () => {
  const html = `<html><head><style>.a{color:red}</style><script>alert('x')</script></head>
    <body><h1>标题 &amp; 结论</h1><p>第一段 &lt;ok&gt;</p><ul><li>条目一</li><li>条目二</li></ul>
    <!-- 注释不该出现 --><pre>code  line</pre></body></html>`;
  const text = htmlToText(html);
  assert.doesNotMatch(text, /alert\(/, '脚本内容必须去掉');
  assert.doesNotMatch(text, /color:red/, '样式内容必须去掉');
  assert.doesNotMatch(text, /注释不该出现/);
  assert.match(text, /标题 & 结论/, '实体要解码');
  assert.match(text, /第一段 <ok>/);
  assert.match(text, /条目一\n/);
  assert.match(text, /code {2}line/, 'pre 里的空格要保留');
  const long = htmlToText(`<p>${'字'.repeat(500)}</p>`, 100);
  assert.ok(long.length < 200, '超长内容要截断');
  assert.match(long, /已截断/);
});

test('实体解码：十进制 / 十六进制 / 命名，未知实体原样保留', () => {
  assert.equal(decodeEntities('a&#39;b'), "a'b");
  assert.equal(decodeEntities('a&#x27;b'), "a'b");
  assert.equal(decodeEntities('&lt;tag&gt; &amp; &quot;q&quot;'), '<tag> & "q"');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
  assert.equal(decodeEntities('&#xD800;'), '', '非法码点不能抛异常');
});

test('RSS 解析：按真实 Bing format=rss 的形状取标题/链接/摘要', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Three.js docs</title><link>https://threejs.org/docs/</link>
      <description>官方文档 &lt;b&gt;正文&lt;/b&gt;</description></item>
    <item><title><![CDATA[InstancedMesh]]></title><link><![CDATA[https://example.com/a?b=1&amp;c=2]]></link>
      <description><![CDATA[参考实现]]></description></item>
    <item><title>没有链接的条目</title></item>
  </channel></rss>`;
  const hits = parseFeedItems(xml);
  assert.equal(hits.length, 2, '没有 link 的条目要丢掉');
  assert.equal(hits[0]?.title, 'Three.js docs');
  assert.equal(hits[0]?.url, 'https://threejs.org/docs/');
  assert.equal(hits[0]?.snippet, '官方文档 正文', '摘要里的标签要去掉');
  // CDATA 里的内容是**字面量**（XML 规范：CDATA 不做实体解码），所以 `&amp;` 原样保留；
  // 真实 feed 里的链接用的是实体编码而不是 CDATA，那条由上面的「普通 link」覆盖。
  assert.equal(hits[1]?.url, 'https://example.com/a?b=1&amp;c=2', 'CDATA 按字面量保留');
});

test('GitHub 解析：按真实 search/repositories 响应的字段取仓库信息', () => {
  const json = {
    total_count: 73,
    items: [
      {
        full_name: 'luciopaiva/chladni',
        html_url: 'https://github.com/luciopaiva/chladni',
        description: 'Chladni plate simulation made with vanilla Javascript.',
        stargazers_count: 63,
        language: 'JavaScript',
        license: { spdx_id: 'MIT' },
        pushed_at: '2024-05-01T10:00:00Z',
        topics: ['simulation', 'canvas'],
      },
      { full_name: 'no-url/repo' },
      {
        full_name: 'someone/nolicense',
        html_url: 'https://github.com/someone/nolicense',
        description: null,
        stargazers_count: 3,
        license: { spdx_id: 'NOASSERTION' },
      },
    ],
  };
  const hits = parseGitHubRepos(json);
  assert.equal(hits.length, 2, '没有 html_url 的条目要丢掉');
  assert.equal(hits[0]?.title, 'luciopaiva/chladni');
  assert.equal(hits[0]?.stars, 63);
  assert.equal(hits[0]?.license, 'MIT');
  assert.equal(hits[0]?.updatedAt, '2024-05-01');
  assert.match(hits[0]?.snippet ?? '', /simulation · canvas|canvas/);
  assert.equal(hits[1]?.license, undefined, 'NOASSERTION 不是许可证，不能显示');
  assert.equal(hits[1]?.snippet, '');
  assert.deepEqual(parseGitHubRepos(null), []);
  assert.deepEqual(parseGitHubRepos({ items: 'nope' }), []);
});

test('结果格式化：星数/语言/许可证/日期都要露出来，并声明摘要只是线索', () => {
  const text = formatHits([
    { title: 'a/b', url: 'https://github.com/a/b', snippet: 'desc', stars: 12, language: 'Rust', license: 'Apache-2.0', updatedAt: '2025-01-02' },
  ], '相关项目');
  assert.match(text, /a\/b/);
  assert.match(text, /12 ★/);
  assert.match(text, /Rust/);
  assert.match(text, /Apache-2\.0/);
  assert.match(text, /2025-01-02/);
  assert.match(text, /线索/, '必须提醒摘要不是依据');
  assert.match(formatHits([], '相关项目'), /0 条结果/);
});

test('提示词：先调研 → 并入清单 → 才执行，且必须有 URL', () => {
  assert.match(INTERNET_REFERENCE_PROMPT, /Phase 1/, '要有明确的调研阶段');
  assert.match(INTERNET_REFERENCE_PROMPT, /fetch_url/, '要指到读原文的工具');
  assert.match(INTERNET_REFERENCE_PROMPT, /search_github_repos/, '要指到找成熟项目的工具');
  assert.match(INTERNET_REFERENCE_PROMPT, /Phase 2[\s\S]*update_todos/, '调研结论必须并入任务清单');
  assert.match(INTERNET_REFERENCE_PROMPT, /update_todos[\s\S]*Phase 3/, '清单要在执行之前调整');
  assert.match(INTERNET_REFERENCE_PROMPT, /Never state a technical conclusion without the URL/, '结论必须带 URL');
  assert.match(INTERNET_REFERENCE_PROMPT, /did not find an authoritative solution/, '搜不到要明说');
  assert.match(INTERNET_REFERENCE_PROMPT, /Never disguise a guess as research/, '不许把猜的包装成调研');
  assert.match(INTERNET_REFERENCE_PROMPT, /license/, '引用代码要先看许可证');
});

test('提示词注入：关闭时逐字节保持原样，开启时追加协议', () => {
  const base = 'You are HWChat.\n';
  assert.equal(withInternetReference(base, false), base, '关闭时不能改动提示词');
  const on = withInternetReference(base, true);
  assert.ok(on.startsWith('You are HWChat.'), '原提示词要保留在前');
  assert.match(on, /INTERNET REFERENCE IS ON/);
  assert.equal(withInternetReference('', true), INTERNET_REFERENCE_PROMPT, '空提示词时只给协议');
});

test('接线：开关按对话存储，运行开始时快照；工具与提示词都跟着它', () => {
  // 1) 只有布尔 true 才算开启
  const SETTINGS = readFileSync('src/core/settings.ts', 'utf8');
  assert.match(SETTINGS, /internetReference: internetReference === true/, 'applyRuntimeControls 的入参判定（只有布尔 true 打开）');
  assert.match(PANEL, /applyRuntimeControls\(configuredSettings, effectivePreset, effectiveSteps, controls\.internetReference\)/, 'send 时按对话快照');
  // 2) 提示词随每次请求注入（含「继续」）
  assert.match(PANEL, /withInternetReference\(this\.agentSystemPrompt/, '系统提示词要按开关注入');
  // 3) 工具按开关下发
  assert.match(RUNNER, /this\.tools\.definitions\(options\.mode, \{ internetReference: options\.settings\.internetReference \}\)/, 'runner 要按开关下发联网工具');
  // 4) 界面开关 → 消息 → 持久化
  assert.match(CHAT_JS, /post\('setInternetReference', \{ enabled: next \}\)/, '点击要上报');
  assert.match(PANEL, /persistControls\(this\.activeConversationId, \{ internetReference: value \}\)/, '要写进对话存档');
  assert.match(CHAT_JS, /case 'internetReferenceChanged'/, '后端回推要收');
  // 5) 关着的时候界面上不能出现旧的手动刷新按钮
  assert.equal(/refreshModelsButton/.test(CHAT_JS), false, '手动刷新按钮已经移除');
});

test('文案与样式：开关有中英文案，开启态有独立样式', () => {
  for (const key of ['chat.internetReference', 'chat.internetReferenceOn.hint', 'chat.internetReferenceOff.hint', 'chat.internetReferenceOn', 'chat.internetReferenceOff']) {
    const at = I18N.indexOf(`'${key}':`);
    assert.ok(at > 0, `缺少 ${key}`);
    const rest = I18N.slice(at, at + 600);
    assert.match(rest, /zh:/);
    assert.match(rest, /en:/);
  }
  assert.match(CSS, /\.toolbar-toggle\[aria-pressed="true"\]/, '开启态要有可见样式');
  assert.match(CSS, /\.toolbar-toggle\[aria-pressed="false"\]/, '关闭态也要有自己的样式');
});
