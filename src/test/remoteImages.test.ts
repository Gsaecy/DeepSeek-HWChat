import assert from 'node:assert/strict';
import test from 'node:test';
import { findRemoteImages, hostOf, replaceRemoteImages, resolveRemoteImages } from '../agent/remoteImages';
import { imageProfileFor } from '../core/settings';
import { ApiProfile } from '../core/types';

test('findRemoteImages：只认 https，按 URL 去重，最多 4 张', () => {
  const content = [
    '![a](https://cdn.example.com/a.png)',
    '![b](https://cdn.example.com/a.png)',
    '![c](https://cdn.example.com/b.png "标题")',
    '![d](http://insecure.example.com/d.png)',
    '![e](../local/e.png)',
    '![f](https://cdn.example.com/f.png)',
    '![g](https://cdn.example.com/g.png)',
    '![h](https://cdn.example.com/h.png)',
  ].join('\n');
  const found = findRemoteImages(content);
  assert.deepEqual(found.map((item) => item.url), [
    'https://cdn.example.com/a.png',
    'https://cdn.example.com/b.png',
    'https://cdn.example.com/f.png',
    'https://cdn.example.com/g.png',
  ]);
  assert.equal(found[0]?.alt, 'a');
});

test('findRemoteImages：没有远程图时不产生任何工作', () => {
  for (const content of ['没有图片', '', undefined, '![x](../a.png)', '![x](data:image/png;base64,AAA)']) {
    assert.deepEqual(findRemoteImages(content), [], `不该识别：${content}`);
  }
});

test('replaceRemoteImages：三种状态各自翻译成可读内容', () => {
  const content = '前 ![图](https://cdn.example.com/a.png) 后';
  assert.equal(
    replaceRemoteImages(content, () => '![图](https://file+.vscode-resource.vscode-cdn.net/x.png)'),
    '前 ![图](https://file+.vscode-resource.vscode-cdn.net/x.png) 后',
  );
  assert.equal(replaceRemoteImages(content, () => '正在下载图片…（cdn.example.com）'), '前 正在下载图片…（cdn.example.com） 后');
  // 返回 undefined = 保持原样（本地图、data 图不走这里）
  assert.equal(replaceRemoteImages(content, () => undefined), content);
  // 非 https 不参与改写
  const insecure = '![x](http://insecure.example.com/a.png)';
  assert.equal(replaceRemoteImages(insecure, () => 'X'), insecure);
});

test('hostOf：取主机名，解析失败时原样返回', () => {
  assert.equal(hostOf('https://cdn.example.com/a.png'), 'cdn.example.com');
  assert.equal(hostOf('not a url'), 'not a url');
});

function profile(id: string, imageModel?: string): ApiProfile {
  return { id, name: id, baseUrl: 'https://example.invalid/v1', models: ['m'], requestHeaders: {}, imageModel };
}

test('imageProfileFor：优先当前档，否则找任意一个配了图片模型的档位', () => {
  const chat = profile('chat');
  const media = profile('media', 'gpt-image-1');
  const settings = { apiProfiles: [chat, media], activeApiProfileId: 'chat' };
  assert.equal(imageProfileFor(settings)?.id, 'media', '聊天档没配也要能找到出图档');
  assert.equal(imageProfileFor(settings, 'chat')?.id, 'media');
  assert.equal(imageProfileFor(settings, 'media')?.id, 'media');

  // 当前档自己就能出图 → 用它
  const both = { apiProfiles: [profile('chat', 'img-a'), media], activeApiProfileId: 'chat' };
  assert.equal(imageProfileFor(both)?.id, 'chat');

  // 谁都没有 → undefined（工具不下发，并有明确提示）
  assert.equal(imageProfileFor({ apiProfiles: [chat], activeApiProfileId: 'chat' }), undefined);
  // 空白字符串不算配置
  assert.equal(imageProfileFor({ apiProfiles: [profile('x', '   ')], activeApiProfileId: 'x' }), undefined);
});

const text = {
  downloading: (host: string) => `正在下载图片…（${host}）`,
  failed: (host: string) => `图片未能加载（${host}）`,
};
const asUri = (path: string) => `https://file+.vscode-resource.vscode-cdn.net${path}`;

test('resolveRemoteImages：已下载 → 换成 webview 地址显示真图', () => {
  const out = resolveRemoteImages('前 ![架构](https://cdn.example.com/a.png) 后', {
    attachments: [{ sourceUrl: 'https://cdn.example.com/a.png', path: '/srv/images/a.png' }],
    state: () => 'ready',
    toWebviewUri: asUri,
    text,
  });
  assert.equal(out, `前 ![架构](${asUri('/srv/images/a.png')}) 后`);
});

test('resolveRemoteImages：下载中 / 失败都给可读说明，绝不漏出远程地址', () => {
  const content = '![x](https://cdn.example.com/a.png)';
  const downloading = resolveRemoteImages(content, { attachments: [], state: () => 'loading', toWebviewUri: asUri, text });
  assert.equal(downloading, '正在下载图片…（cdn.example.com）');
  const failed = resolveRemoteImages(content, { attachments: [], state: () => 'failed', toWebviewUri: asUri, text });
  assert.equal(failed, '图片未能加载（cdn.example.com）');
  // 还没开始下载（state 为空）也要给说明，不能把裸 URL 丢给 CSP 去拦
  const pending = resolveRemoteImages(content, { attachments: [], state: () => undefined, toWebviewUri: asUri, text });
  assert.equal(pending, '正在下载图片…（cdn.example.com）');
  for (const out of [downloading, failed, pending]) assert.doesNotMatch(out ?? '', /https:\/\//);
});

test('resolveRemoteImages：附件在但文件取不到地址时退回失败说明', () => {
  const out = resolveRemoteImages('![x](https://cdn.example.com/a.png)', {
    attachments: [{ sourceUrl: 'https://cdn.example.com/a.png', path: '/gone/a.png' }],
    state: () => 'ready',
    toWebviewUri: () => undefined,
    text,
  });
  assert.equal(out, '图片未能加载（cdn.example.com）');
});

test('resolveRemoteImages：本地图与 data 图不受影响', () => {
  const content = '![l](../local/a.png) ![d](data:image/png;base64,AAA)';
  assert.equal(resolveRemoteImages(content, { attachments: [], state: () => 'failed', toWebviewUri: asUri, text }), content);
});
