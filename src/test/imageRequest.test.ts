import assert from 'node:assert/strict';
import test from 'node:test';
import { embedMentionedImages, rehostWebviewImageUrls, rewriteMarkdownImagePaths } from '../agent/markdownImages';
import { imageCapabilityPrompt, looksLikeImageRequest } from '../agent/imageRequest';
import { findRemoteImages, isWebviewResourceUrl } from '../agent/remoteImages';

test('looksLikeImageRequest：中文「要一张图」的常见说法都认', () => {
  for (const text of [
    '给我这个skill的原理图',
    '画一张在雨里的猫',
    '帮我生成一张海报',
    '来个配图',
    '出张图吧',
    '给我画个 Logo',
    '生成一张头像',
    '做一张示意图',
  ]) {
    assert.equal(looksLikeImageRequest(text), true, `应识别为要图：${text}`);
  }
});

test('looksLikeImageRequest：英文要图也认', () => {
  for (const text of [
    'draw me a cat in the rain',
    'generate an image of a poster',
    'create a logo for my app',
    'please illustrate this concept',
  ]) {
    assert.equal(looksLikeImageRequest(text), true, `应识别为要图：${text}`);
  }
});

test('looksLikeImageRequest：不要误判普通开发请求', () => {
  for (const text of [
    '修一下登录 bug',
    '把这段代码重构成函数',
    '解释一下这个架构',
    '更新 README',
    'how to draw a chart in css',
    '写一段画图的脚本',
    'generate a component for the settings page',
    '看看这个文件的图片路径配置',
    '帮我看看这个图片路径配置',
    '画一个表格',
    '',
  ]) {
    assert.equal(looksLikeImageRequest(text), false, `不该识别为要图：${text}`);
  }
});

test('imageCapabilityPrompt：配置了图片模型就给出可调用与内嵌两条指引', () => {
  const zh = imageCapabilityPrompt('gpt-image-1', 'zh');
  assert.match(zh, /gpt-image-1/);
  assert.match(zh, /generate_image/);
  assert.match(zh, /!\[说明\]\(相对路径\)/);
  assert.doesNotMatch(zh, /尚未配置/);

  const en = imageCapabilityPrompt('gpt-image-1', 'en');
  assert.match(en, /Image output is available/);
  assert.match(en, /!\[caption\]\(relative\/path\.ext\)/);
});

test('imageCapabilityPrompt：没配图片模型时明确禁止去装渲染器', () => {
  for (const empty of ['', '   ', undefined]) {
    const zh = imageCapabilityPrompt(empty, 'zh');
    assert.match(zh, /尚未配置/);
    assert.match(zh, /设置 → 连接 → 图片模型/);
    // 事故的直接教训：不要去 npx 装 mermaid-cli / puppeteer
    assert.match(zh, /mermaid-cli/);
    assert.match(zh, /不要为了满足这种请求去安装/);
    // 但仍然告诉它本地图片可以嵌进回复
    assert.match(zh, /!\[说明\]\(相对路径\)/);
  }
  const en = imageCapabilityPrompt('', 'en');
  assert.match(en, /Image output is NOT configured/);
  assert.match(en, /mermaid-cli/);
});

test('embedMentionedImages：回复只提到路径时补上真正的图片', () => {
  const reply = '原理图已画好：`tmp/diagram/architecture.svg`（编辑器已打开）。';
  const src = 'https://file+.vscode-resource.vscode-cdn.net/tmp/diagram/architecture.svg';
  const out = embedMentionedImages(reply, (path) => (path === 'tmp/diagram/architecture.svg' ? src : undefined));
  assert.ok(out);
  assert.match(out, /!\[architecture\.svg\]\(/);
  assert.ok(out.startsWith(reply.trimEnd()), '原文一个字都不改，只在末尾补图');
});

test('embedMentionedImages：已经嵌过的图不会重复追加（幂等）', () => {
  const src = 'https://file+.vscode-resource.vscode-cdn.net/tmp/a.png';
  const reply = '见图 `tmp/a.png`';
  const once = embedMentionedImages(reply, () => src);
  const twice = embedMentionedImages(once, () => src);
  assert.equal(twice, once);
  assert.equal((once?.match(/!\[/g) ?? []).length, 1);
});

test('embedMentionedImages：路径不存在、非图片、远程地址都不补', () => {
  const reply = '见 `docs/missing.png`、`src/app.ts`、`https://example.com/a.png`。';
  assert.equal(embedMentionedImages(reply, () => undefined), reply);
});

test('embedMentionedImages：最多补 limit 张，避免刷屏', () => {
  const reply = '图：`a.png` `b.png` `c.png` `d.png` `e.png`';
  const out = embedMentionedImages(reply, (path) => `https://file+.vscode-resource.vscode-cdn.net/${path}`, 3);
  assert.equal((out?.match(/!\[/g) ?? []).length, 3);
});

test('rehostWebviewImageUrls：模型抄来的 `%2B` 地址换成宿主生成的规范地址', () => {
  const copied = '![架构](https://file%2B.vscode-resource.vscode-cdn.net/Users/me/app/tmp/a.png)';
  const canonical = 'https://file+.vscode-resource.vscode-cdn.net/Users/me/app/tmp/a.png';
  const out = rehostWebviewImageUrls(copied, (path: string) => (path === '/Users/me/app/tmp/a.png' ? canonical : undefined));
  assert.equal(out, `![架构](${canonical})`);

  // `+` 形式同样会重新生成一遍（保证只有一个规范形状）
  const plus = '![x](https://file+.vscode-resource.vscode-cdn.net/Users/me/app/tmp/a.png)';
  assert.equal(rehostWebviewImageUrls(plus, (path: string) => (path === '/Users/me/app/tmp/a.png' ? canonical : undefined)), `![x](${canonical})`);

  // 工作区外 / 反解不出来的地址原样保留（交给渲染层白名单判断）
  assert.equal(rehostWebviewImageUrls(copied, () => undefined), copied);
  // 不是图片语法的普通链接不碰
  const link = '[架构](https://file%2B.vscode-resource.vscode-cdn.net/Users/me/app/tmp/a.png)';
  assert.equal(rehostWebviewImageUrls(link, () => canonical), link);
  // 不含 vscode-cdn 的正文直接返回（零成本）
  assert.equal(rehostWebviewImageUrls('没有图片', () => canonical), '没有图片');
});

test('rehostWebviewImageUrls：Windows 的 `/c:/…` 反解成 `c:/…`', () => {
  let seen = '';
  rehostWebviewImageUrls('![w](https://file%2B.vscode-resource.vscode-cdn.net/c:/Users/me/a.png)', (path: string) => {
    seen = path;
    return undefined;
  });
  assert.equal(seen, 'c:/Users/me/a.png');
});

test('rewriteMarkdownImagePaths：支持带空格的尖括号路径与 %20 编码', () => {
  const canonical = 'https://file%2B.vscode-resource.vscode-cdn.net/Users/me/AI%20projects/Personal%20Workstation%20OS/tmp/a.png';
  const resolve = (path: string) => (path.endsWith('tmp/a.png') ? canonical : undefined);

  // 模型在多根工作区里的真实写法（用户 2026-11-04 的回复原文）
  assert.equal(
    rewriteMarkdownImagePaths('![架构](<Personal Workstation OS/tmp/a.png>)', resolve),
    `![架构](${canonical})`,
  );
  // URL 编码的空格也要反解回来才找得到文件
  assert.equal(
    rewriteMarkdownImagePaths('![架构](Personal%20Workstation%20OS/tmp/a.png)', resolve),
    `![架构](${canonical})`,
  );
  // 普通的无空格写法仍然可以
  assert.equal(rewriteMarkdownImagePaths('![x](tmp/a.png)', resolve), `![x](${canonical})`);
  // 找不到文件就原样保留
  assert.equal(rewriteMarkdownImagePaths('![x](<other/x.png>)', resolve), '![x](<other/x.png>)');
});

test('isWebviewResourceUrl：面板自己的资源地址绝不能被当成远程图', () => {
  // 14:46 的真实故障：asWebviewUri 的输出被 findRemoteImages 当成远程图，
  // 于是界面显示「正在下载图片…」→「图片未能加载」，把一张本来就存在的图弄丢了。
  const own = 'https://file%2B.vscode-resource.vscode-cdn.net/Users/me/a.png';
  assert.equal(isWebviewResourceUrl(own), true);
  assert.equal(isWebviewResourceUrl('https://file+.vscode-resource.vscode-cdn.net/a.png'), true);
  assert.equal(isWebviewResourceUrl('https://abc.vscode-cdn.net/a.png'), true);
  assert.equal(isWebviewResourceUrl('https://cdn.example.com/a.png'), false);
  assert.deepEqual(findRemoteImages(`![x](${own})`), [], 'webview 地址不该被列为待下载');
});
