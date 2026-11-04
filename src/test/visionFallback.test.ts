/**
 * 模型不接受图片输入时的自动降级。
 *
 * 现场（用户 2026-11-04，切到智谱模型后连发两次同样的请求都失败）：
 *
 *     请求失败：接口请求失败（400）：messages.content.type 参数非法，取值范围 ['text']
 *
 * 关键不是"这张图发不出去"，而是：**对话历史里只要有一条带图的提问，之后每一次请求
 * 都会带上那个 `image_url`** —— 于是一条纯文字的新消息也永远失败，用户看到的就是
 * "换个说法再发还是失败"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSettings } from '../core/types';
import {
  hasImageParts,
  isTextOnlyContentRejection,
  stripImageParts,
} from '../providers/visionFallback';
import { DeepSeekClient } from '../providers/deepseekClient';

const NOTE = '（当前模型不支持图片输入，图片内容已省略）';

test('识别智谱这类「content 只允许 text」的拒绝（用户实际看到的那句）', () => {
  const real = "messages.content.type 参数非法，取值范围 ['text']";
  assert.equal(isTextOnlyContentRejection(real, true), true);
  assert.equal(isTextOnlyContentRejection('content.type is invalid', true), true);
  assert.equal(isTextOnlyContentRejection('image_url is not supported by this model', true), true);
  assert.equal(isTextOnlyContentRejection('该模型不支持图片输入', true), true);
});

test('没有图片时不认这类拒绝（否则会掩盖真正的参数错误）', () => {
  const real = "messages.content.type 参数非法，取值范围 ['text']";
  assert.equal(isTextOnlyContentRejection(real, false), false, '没带图就别往图片上赖');
  assert.equal(isTextOnlyContentRejection('fetch failed', true), false);
  assert.equal(isTextOnlyContentRejection('', true), false);
});

test('stripImageParts：去掉图片、保留文字、说明写进正文、只留一段时降级成字符串', () => {
  const messages = [
    { role: 'user', content: '这张图里是什么？\n\n<attached_image name="a.png" mime="image/png" />' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '现在纯文字的一条' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    },
    { role: 'assistant', content: '前面那条回答' },
  ];
  assert.equal(hasImageParts(messages), true);
  const { messages: stripped, dropped } = stripImageParts(messages, NOTE);
  assert.equal(dropped, 1);
  assert.equal(hasImageParts(stripped), false);
  // 只剩一段文本 → 降级成字符串（有些接口连 [{type:'text'}] 都不收）
  assert.equal(typeof stripped[1]!.content, 'string');
  assert.match(String(stripped[1]!.content), /现在纯文字的一条/);
  assert.match(String(stripped[1]!.content), /图片内容已省略/, '必须说明图被省略了，否则模型会编造画面');
  // 没有图片的消息一个字都不动
  assert.deepEqual(stripped[0], messages[0]);
  assert.deepEqual(stripped[2], messages[2]);
});

test('stripImageParts：没有图片时原样返回', () => {
  const messages = [{ role: 'user', content: '纯文字' }];
  assert.deepEqual(stripImageParts(messages, NOTE), { messages: [...messages], dropped: 0 });
  assert.equal(hasImageParts(messages), false);
});

/* ── 与真实客户端联调：模拟智谱的两次响应 ─────────────────────────────── */

const settings: ChatSettings = {
  apiProfiles: [{ id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash'], requestHeaders: {} }],
  activeApiProfileId: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
  temperature: 0, maxTokens: 0, systemPrompt: '', sendOnEnter: true, historyRetentionDays: 30,
  taskCacheRetentionHours: 24, cacheBudgetMB: 100, cleanupIntervalMinutes: 10, maxMessagesInContext: 20,
  requestHeaders: {}, requestTimeoutSeconds: 30, proxy: '', defaultMode: 'agent', agentMaxSteps: 24,
  reasoningEffort: 'default', permissionPreset: 'askAll', internetReference: false,
  fileReadPolicy: 'allow', fileWritePolicy: 'ask', commandPolicy: 'ask',
  dangerousCommandPolicy: 'deny', sensitiveFilePolicy: 'deny',
  maxReadBytes: 512_000, maxToolOutputBytes: 200_000, maxCommandSeconds: 120, auditRetentionDays: 30, language: 'zh',
};

/** 历史里有一条带图的旧提问 —— 这就是「纯文字新消息也永远失败」的成因。 */
const historyWithImage = [
  { role: 'user' as const, content: [
    { type: 'text' as const, text: '看看这张截图' },
    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAA' } },
  ] },
  { role: 'assistant' as const, content: '好的' },
  { role: 'user' as const, content: '继续优化网站，做好给我预览' },
];

function sseOk(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}},"finish_reason":"stop"}]}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('第一次被拒 → 自动去掉图片重发 → 记住这个模型 → 之后不再附带图片', async () => {
  const bodies: Array<{ messages: Array<{ content: unknown }> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> };
    bodies.push(body);
    // 只要带 image_url 就回智谱那条原始错误
    if (JSON.stringify(body.messages).includes('image_url')) {
      return new Response(JSON.stringify({
        error: { message: "messages.content.type 参数非法，取值范围 ['text']", type: 'invalid_request_error' },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return sseOk('收到，开始优化');
  }) as typeof fetch;

  const events: Array<{ model: string; dropped: number; reason: string }> = [];
  const client = new DeepSeekClient(async () => 'k');
  client.onVisionFallback = (event) => events.push(event);

  try {
    const result = await client.streamChat(settings, historyWithImage, { onDelta: () => undefined });
    assert.equal(result.content, '收到，开始优化', '必须靠重发把这一轮救回来，而不是直接失败');
    assert.equal(bodies.length, 2, '一次被拒 + 一次成功');
    assert.ok(JSON.stringify(bodies[0]!.messages).includes('image_url'), '第一次确实带了图（复现故障）');
    assert.equal(JSON.stringify(bodies[1]!.messages).includes('image_url'), false, '第二次不许再带图');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.reason, 'rejected');
    assert.equal(events[0]!.dropped, 1);
    assert.equal(client.isTextOnlyModel(settings), true, '要学会这个模型不吃图');

    // 第三次（新的纯文字消息）：**一开始**就不带图，只发一次请求
    bodies.length = 0;
    const second = await client.streamChat(settings, historyWithImage, { onDelta: () => undefined });
    assert.equal(second.content, '收到，开始优化');
    assert.equal(bodies.length, 1, '已知不支持就不要再撞一次 400');
    assert.equal(JSON.stringify(bodies[0]!.messages).includes('image_url'), false);
    assert.equal(events.length, 2, '再来一次仍然要通知（界面自己去重）');
    assert.equal(events[1]!.reason, 'known');
  } finally {
    globalThis.fetch = original;
  }
});

test('换了支持视觉的模型立刻恢复（记忆按「配置档 + 模型」分开）', async () => {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return sseOk('ok');
  }) as typeof fetch;
  const client = new DeepSeekClient(async () => 'k');
  client.onVisionFallback = () => undefined;
  // 先在 glm-4-flash 上学会不吃图
  (client as unknown as { textOnlyModels: Set<string> }).textOnlyModels.add('zhipu\u0000glm-4-flash');
  try {
    await client.streamChat({ ...settings, model: 'glm-4.5v' }, historyWithImage, { onDelta: () => undefined });
    assert.equal(bodies[0]!.includes('image_url'), true, '换了视觉模型就该重新带上图片');
  } finally {
    globalThis.fetch = original;
  }
});
