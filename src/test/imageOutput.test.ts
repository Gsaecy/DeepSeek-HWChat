import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStorage } from '../core/storage';
import { ChatSettings } from '../core/types';
import {
  buildImagesEndpoint,
  DeepSeekClient,
  normalizeImageSize,
  pickGeneratedImage,
} from '../providers/deepseekClient';
import { resolveLocalImage, rewriteMarkdownImagePaths } from '../agent/markdownImages';

const settings: ChatSettings = {
  apiProfiles: [{ id: 'default', name: 'Test', baseUrl: 'https://example.invalid/v1', models: ['deepseek-chat'], requestHeaders: {}, imageModel: 'test-image' }],
  activeApiProfileId: 'default',
  baseUrl: 'https://example.invalid/v1',
  model: 'deepseek-chat',
  imageModel: 'test-image',
  temperature: 0,
  maxTokens: 0,
  systemPrompt: '',
  sendOnEnter: true,
  historyRetentionDays: 30,
  taskCacheRetentionHours: 24,
  cacheBudgetMB: 100,
  cleanupIntervalMinutes: 10,
  maxMessagesInContext: 20,
  requestHeaders: {},
  requestTimeoutSeconds: 30,
  proxy: '',
  defaultMode: 'agent',
  agentMaxSteps: 12,
  reasoningEffort: 'default',
  permissionPreset: 'review',
  internetReference: false,
  fileReadPolicy: 'allow',
  fileWritePolicy: 'ask',
  commandPolicy: 'ask',
  dangerousCommandPolicy: 'ask',
  sensitiveFilePolicy: 'deny',
  maxReadBytes: 512_000,
  maxToolOutputBytes: 200_000,
  maxCommandSeconds: 120,
  auditRetentionDays: 30,
  language: 'auto',
};

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function withFetch<T>(handler: (input: string, init: RequestInit | undefined, call: number) => Promise<Response>, run: (calls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let call = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    call += 1;
    calls.push(String(input));
    return handler(String(input), init, call);
  }) as typeof fetch;
  return run(calls).finally(() => { globalThis.fetch = original; });
}

test('builds the images endpoint from every realistic base URL shape', () => {
  assert.equal(buildImagesEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/images/generations');
  assert.equal(buildImagesEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1/images/generations');
  assert.equal(buildImagesEndpoint('https://api.example.com/v1/images/generations'), 'https://api.example.com/v1/images/generations');
  assert.equal(buildImagesEndpoint('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1/images/generations');
  assert.throws(() => buildImagesEndpoint('http://api.example.com/v1'), /HTTPS|https/i);
  assert.throws(() => buildImagesEndpoint('   '), /.+/);
});

test('drops image sizes the API does not accept instead of forwarding garbage', () => {
  assert.equal(normalizeImageSize('1024x1024'), '1024x1024');
  assert.equal(normalizeImageSize(' 1536X1024 '), '1536x1024');
  assert.equal(normalizeImageSize('huge'), undefined);
  assert.equal(normalizeImageSize(undefined), undefined);
});

test('picks images out of all three response shapes', () => {
  assert.deepEqual(pickGeneratedImage({ data: [{ b64_json: 'AAA' }] }), { dataBase64: 'AAA', mimeType: 'image/png' });
  assert.deepEqual(
    pickGeneratedImage({ data: [{ url: 'https://cdn.example.com/a.webp?x=1' }] }),
    { url: 'https://cdn.example.com/a.webp?x=1', mimeType: 'image/webp' },
  );
  assert.deepEqual(pickGeneratedImage({ images: [{ b64_json: 'BBB', mime_type: 'image/jpeg' }] }), { dataBase64: 'BBB', mimeType: 'image/jpeg' });
  assert.deepEqual(pickGeneratedImage({ image: 'CCC' }), { dataBase64: 'CCC', mimeType: 'image/png' });
  assert.equal(pickGeneratedImage({ data: [] }), undefined);
  assert.equal(pickGeneratedImage({ data: [{ revised_prompt: 'only text' }] }), undefined);
  assert.equal(pickGeneratedImage('nope'), undefined);
});

test('generateImage posts model/prompt/n and never sends response_format', async () => {
  const body = await withFetch(async (_input, init) => {
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-key');
    const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(parsed.model, 'test-image');
    assert.equal(parsed.prompt, '画一只在雨里的猫');
    assert.equal(parsed.n, 1);
    // gpt-image-1 不接受 response_format，带上就是 400。
    assert.equal('response_format' in parsed, false);
    // 非法尺寸不提，交给服务端默认值。
    assert.equal('size' in parsed, false);
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }), { status: 200 });
  }, async (calls) => {
    const client = new DeepSeekClient(async () => 'test-key');
    const image = await client.generateImage(settings, { prompt: '  画一只在雨里的猫  ', size: 'big' });
    assert.equal(image.dataBase64, PNG_BYTES.toString('base64'));
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.model, 'test-image');
    assert.deepEqual(calls, ['https://example.invalid/v1/images/generations']);
    return 'ok';
  });
  assert.equal(body, 'ok');
});

test('generateImage downloads url responses through the same transport', async () => {
  await withFetch(async (input, init) => {
    if (String(input).endsWith('/images/generations')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/x.png' }] }), { status: 200 });
    }
    assert.equal(String(input), 'https://cdn.example.com/x.png');
    assert.equal(init?.method, 'GET');
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
  }, async (calls) => {
    const client = new DeepSeekClient(async () => 'test-key');
    const image = await client.generateImage(settings, { prompt: 'poster', size: '1024x1024' });
    assert.equal(image.dataBase64, PNG_BYTES.toString('base64'));
    assert.equal(calls.length, 2);
  });
});

test('generateImage refuses a plaintext download URL', async () => {
  await withFetch(async (input) => {
    // 第一个请求是出图接口：回一个 http 的图片地址。
    if (String(input).endsWith('/images/generations')) {
      return new Response(JSON.stringify({ data: [{ url: 'http://cdn.example.com/x.png' }] }), { status: 200 });
    }
    throw new Error('明文地址不该被请求');
  }, async (calls) => {
    const client = new DeepSeekClient(async () => 'test-key');
    await assert.rejects(client.generateImage(settings, { prompt: 'poster' }), /HTTPS/i);
    assert.equal(calls.length, 1, '只应该发出出图请求，不能去取明文图片');
  });
});

test('generateImage retries transient statuses but not 401', async () => {
  await withFetch(async (_input, _init, call) => {
    if (call === 1) return new Response(JSON.stringify({ error: 'busy' }), { status: 503 });
    return new Response(JSON.stringify({ data: [{ b64_json: 'ZZZ' }] }), { status: 200 });
  }, async (calls) => {
    const client = new DeepSeekClient(async () => 'test-key');
    const image = await client.generateImage(settings, { prompt: 'retry me' });
    assert.equal(image.dataBase64, 'ZZZ');
    assert.equal(calls.length, 2);
  });

  await withFetch(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }), async (calls) => {
    const client = new DeepSeekClient(async () => 'test-key');
    await assert.rejects(client.generateImage(settings, { prompt: 'auth' }), /401/);
    assert.equal(calls.length, 1);
  });
});

test('generateImage explains a missing image model instead of calling the API', async () => {
  await withFetch(async () => {
    throw new Error('should not be called');
  }, async (calls) => {
    const client = new DeepSeekClient(async () => 'test-key');
    await assert.rejects(
      client.generateImage({ ...settings, imageModel: '' }, { prompt: 'x' }),
      /图片模型/,
    );
    await assert.rejects(client.generateImage(settings, { prompt: '   ' }), /提示词/);
    assert.equal(calls.length, 0);
  });
});

test('saveMessageImage keeps bytes on disk and only metadata in the message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-image-'));
  try {
    const storage = new ConversationStorage(root);
    await storage.initialize();
    const conversation = await storage.createConversation();
    const message = await storage.appendMessage(conversation.id, { role: 'assistant', content: '', status: 'streaming' });

    const first = await storage.saveMessageImage(conversation.id, message.id, {
      dataBase64: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
      label: '雨里的猫',
    });
    assert.ok(first.path, '生成的图片必须落成文件');
    assert.equal(first.kind, 'image');
    assert.equal(first.mimeType, 'image/png');
    assert.equal(first.bytes, PNG_BYTES.byteLength);
    assert.equal(first.dataBase64, undefined, '消息附件不能带 base64，否则会被瘦身删掉');
    assert.deepEqual(await readFile(first.path!), PNG_BYTES);
    assert.match(first.path!, /images[\\/][0-9a-f]{32}\.png$/);

    // 同一张图再存一次：文件不重复、附件不重复。
    const second = await storage.saveMessageImage(conversation.id, message.id, {
      dataBase64: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
      label: '雨里的猫',
    });
    assert.equal(second.path, first.path);
    const stored = await storage.getMessage(conversation.id, message.id);
    assert.equal(stored?.attachments?.length, 1);
    const files = await readdir(join(root, 'conversations', conversation.id, 'images'));
    assert.deepEqual(files, [first.path!.split(/[\\/]/).pop()]);

    // 存档 JSON 里确实没有 base64（瘦身不会把图删掉）。
    const raw = await readFile(join(root, 'conversations', conversation.id, 'messages', `${message.id}.json`), 'utf8');
    assert.equal(raw.includes(PNG_BYTES.toString('base64').slice(0, 40)), false);
    await storage.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveMessageImage rejects empty payloads instead of writing an empty file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hwchat-image-'));
  try {
    const storage = new ConversationStorage(root);
    await storage.initialize();
    const conversation = await storage.createConversation();
    const message = await storage.appendMessage(conversation.id, { role: 'assistant', content: '', status: 'streaming' });
    await assert.rejects(storage.saveMessageImage(conversation.id, message.id, { dataBase64: '   ' }), /图片/);
    assert.equal((await stat(join(root, 'conversations', conversation.id))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rewriteMarkdownImagePaths only rewrites local image references', () => {
  const map = (src: string) => (src === 'docs/chart.png' ? 'https://file+.vscode-resource.vscode-cdn.net/docs/chart.png' : undefined);
  assert.equal(
    rewriteMarkdownImagePaths('看图 ![图表](docs/chart.png) 结束', map),
    '看图 ![图表](https://file+.vscode-resource.vscode-cdn.net/docs/chart.png) 结束',
  );
  // 带标题、带尖括号的写法也要认。
  assert.equal(
    rewriteMarkdownImagePaths('![图表](docs/chart.png "说明")', map),
    '![图表](https://file+.vscode-resource.vscode-cdn.net/docs/chart.png)',
  );
  assert.equal(
    rewriteMarkdownImagePaths('![图表](<docs/chart.png>)', map),
    '![图表](https://file+.vscode-resource.vscode-cdn.net/docs/chart.png)',
  );
  // 带 scheme 的一律不动。
  assert.equal(rewriteMarkdownImagePaths('![x](https://example.com/a.png)', map), '![x](https://example.com/a.png)');
  assert.equal(rewriteMarkdownImagePaths('![x](data:image/png;base64,AAA)', map), '![x](data:image/png;base64,AAA)');
  // 映射不认的路径保持原样（例如不在工作区里的文件）。
  assert.equal(rewriteMarkdownImagePaths('![x](../outside.png)', map), '![x](../outside.png)');
  // 普通链接、没有图片的文本都不动。
  assert.equal(rewriteMarkdownImagePaths('[文档](docs/chart.png)', map), '[文档](docs/chart.png)');
  assert.equal(rewriteMarkdownImagePaths('没有图片', map), '没有图片');
  assert.equal(rewriteMarkdownImagePaths(undefined, map), undefined);
});

test('resolveLocalImage refuses paths outside the workspace', () => {
  const options = {
    roots: ['/work/app'],
    isAbsolute: (path: string) => path.startsWith('/'),
    resolvePath: (root: string, path: string) => `${root}/${path}`,
    insideWorkspace: (path: string) => path.startsWith('/work/app/'),
    exists: (path: string) => path === '/work/app/docs/chart.png' || path === '/work/secret.png',
  };
  assert.equal(resolveLocalImage('docs/chart.png', options), '/work/app/docs/chart.png');
  assert.equal(resolveLocalImage('/work/app/docs/chart.png', options), '/work/app/docs/chart.png');
  // 绝对路径在别的目录里：即使文件存在也不能渲染。
  assert.equal(resolveLocalImage('/work/secret.png', options), undefined);
  assert.equal(resolveLocalImage('../../secret.png', options), undefined);
  // 不是图片扩展名、带查询串、空路径都不碰。
  assert.equal(resolveLocalImage('docs/app.ts', options), undefined);
  assert.equal(resolveLocalImage('docs/chart.png?v=1', options), undefined);
  assert.equal(resolveLocalImage('  ', options), undefined);
  assert.equal(resolveLocalImage('docs/chart.png', { ...options, roots: [] }), undefined);
});
