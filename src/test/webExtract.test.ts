import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_EXTRACTED_CHARS, extractReadableContent } from '../agent/webExtract';

/**
 * 网页正文抽取走成熟开源库（defuddle），不再自己用正则剥标签。
 *
 * 这条测试**真的调用抽取库**：esbuild 会把 defuddle 打进测试 bundle，
 * 所以它同时也是「这个依赖在我们的构建配置下能不能跑」的验证 ——
 * 只对依赖做字符串断言是抓不到 ESM/CJS 互操作问题的。
 */

/** 一个真实站点的骨架：导航、侧栏、页脚 + 一篇正文。 */
const DOCS_PAGE = `<!doctype html><html><head><title>overflow-anchor - CSS | MDN</title>
<style>.nav{display:flex}</style><script>window.analytics=1;</script></head>
<body>
  <nav class="nav"><a href="/">Skip to main content</a><a href="/docs">References</a>
    <a href="/plus">Get MDN Plus</a><a href="/theme">Theme</a></nav>
  <aside class="sidebar"><h2>On this page</h2><ul><li>Syntax</li><li>Examples</li><li>Specifications</li></ul></aside>
  <main>
    <h1>overflow-anchor</h1>
    <p>The <strong>overflow-anchor</strong> CSS property opts out of the browser's scroll anchoring
    behavior, which adjusts scroll position to minimize content shifts.</p>
    <h2>Syntax</h2>
    <pre><code>overflow-anchor: auto;
overflow-anchor: none;</code></pre>
    <h2>Values</h2>
    <ul><li><code>auto</code>: the browser selects an anchor element.</li>
    <li><code>none</code>: no anchor is selected.</li></ul>
    <h2>Specifications</h2>
    <table><tr><th>Specification</th></tr><tr><td>CSS Scroll Anchoring Module Level 1</td></tr></table>
  </main>
  <footer><p>Visit Mozilla Corporation's not-for-profit parent, the Mozilla Foundation.</p>
    <p>Portions of this content are ©1998–2026 by individual mozilla.org contributors.</p></footer>
  <div class="cookies">Cookie settings · Accept all cookies</div>
</body></html>`;

test('正文抽取：保留标题层级/列表/代码块，去掉导航与页脚', async () => {
  const result = await extractReadableContent(DOCS_PAGE, 'https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor', 20_000);
  assert.equal(result.via, 'defuddle', '正常文档页应走正文抽取');
  assert.ok(result.text.length > MIN_EXTRACTED_CHARS, `抽取结果太短：${result.text.length}`);
  // 正文结构要保住（这正是换库换来的东西）
  assert.match(result.text, /overflow-anchor/, '正文关键词');
  assert.match(result.text, /(^|\n)#{1,3} /, '要保留 Markdown 标题层级');
  assert.match(result.text, /```/, '代码块要保留（手写实现做不到）');
  assert.match(result.text, /\| *(Specification|CSS Scroll)/i, '表格要保留');
  // 噪声要被清掉
  for (const noise of ['Skip to main content', 'Get MDN Plus', 'On this page', 'Cookie settings', 'not-for-profit parent']) {
    assert.equal(result.text.includes(noise), false, `导航/页脚噪声没被去掉：${noise}`);
  }
  assert.equal(/window\.analytics/.test(result.text), false, '脚本不能进正文');
});

test('正文抽取：超长内容按 maxChars 截断（Markdown 形态不变）', async () => {
  const long = `<main><h1>标题</h1>${Array.from({ length: 200 }, (_, i) => `<p>第 ${i} 段：${'内容'.repeat(30)}</p>`).join('')}</main>`;
  const result = await extractReadableContent(long, 'https://example.com/doc', 1_500);
  assert.equal(result.via, 'defuddle');
  assert.ok(result.text.length < 2_000, `没有截断：${result.text.length}`);
  assert.match(result.text, /已截断到 1500 字符/, '截断要说明，模型才知道内容不全');
});

test('正文抽取：抽不到东西时回退整页文本，而不是给空内容', async () => {
  // 纯前端空壳：正文区几乎是空的
  const shell = '<html><body><div id="root"></div></body></html>';
  const result = await extractReadableContent(shell, 'https://app.example.com/', 20_000);
  assert.equal(result.via, 'text-fallback', '空壳页面必须回退');
  assert.ok(result.text.length >= 0);

  // 畸形 HTML 不能让「参考」功能整体失败
  const broken = '<p>只有一小段<';
  const fallback = await extractReadableContent(broken, 'https://example.com/x', 20_000);
  assert.equal(fallback.via, 'text-fallback');
  assert.match(fallback.text, /只有一小段/);
});

test('fetch_url 接线：HTML 走抽取、其它类型原样、结果标明来源方式', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/agent/webResearch.ts', 'utf8');
  assert.match(src, /extractReadableContent\(body, finalUrl, maxChars\)/, 'HTML 必须走正文抽取');
  assert.match(src, /contentType\.includes\('html'\)/, '只有 HTML 才抽取');
  assert.match(src, /正文抽取：/, '输出要说明是抽取还是回退（便于判断可信度）');
  assert.match(src, /Markdown（已去掉导航\/侧栏等噪声）/, '抽取成功要说明噪声已清');
});
