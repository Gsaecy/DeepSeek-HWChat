/*
 * 已发送消息里的图片附件：加载失败不能留破图。
 *
 * 用户原话（2026-11-07）：「粘贴的附件图片，显示不了」，贴的截图里已发送的用户消息
 * 里是一张写着 `image.png` 的破图框。
 *
 * 事实核对（真实存档 + 真实文件）：
 *  - 附件存档是对的：`path` 指向 `<对话>/images/<sha256>.png`，文件 **544437 字节的
 *    合法 PNG（1280×860）**；`thumbnailDataUrl` 也是一张合法的 160×108 JPEG。
 *  - 所以不是"图丢了"，而是 **webview 没能把那个地址取下来**：`asWebviewUri` 的地址
 *    在资源根变化、面板重建、session 变化之后都可能失效，而消息一旦渲染就一直用
 *    那个旧地址 —— 旧实现在这种情况下直接把 `<img>` 留在破图状态。
 *
 * 现在的规则：**先请宿主重新解析地址（能救回原图），再不行退回消息里现成的缩略图**，
 * 两级都失败才写日志。这条守护同时约束源码与真实 `media/chat.js` 的行为。
 *
 * 用法：node test/check-image-attachment.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
}

const CHAT_DIR = process.cwd();
const CHAT_JS = readFileSync('media/chat.js', 'utf8');
const PANEL = readFileSync('src/views/chatPanel.ts', 'utf8');

/* ── 1. 前端：两级兜底 ────────────────────────────────────────────── */
check(
  '图片附件带 id，兜底时能定位到具体附件',
  /figure\.dataset\.attachmentId = attachment\.id/.test(CHAT_JS),
  '没有 id 就无法请宿主重新解析，也无法把新地址换回这个节点',
);
check(
  '加载失败先请宿主重新解析地址（原图优先于缩略图）',
  /post\('resolveAttachmentSrc', \{ attachmentId: id \}\)/.test(CHAT_JS),
  '直接退缩略图等于永远放弃原图；地址过期本来是可以救回来的',
);
check(
  '重新解析失败后退回 thumbnailDataUrl',
  /image\.src = fallback;\s*\n\s*image\.classList\.add\('image-is-thumbnail'\)/.test(CHAT_JS),
  '两级都失败还留着破图框，用户看到的就是「图片显示不了」',
);
check(
  '只回退一次，不会来回抖动',
  /image\.dataset\.recovery = 'first'/.test(CHAT_JS)
    && /stage === 'thumb' \|\| stage === 'waiting-host'/.test(CHAT_JS)
    && /image\.dataset\.recovery = 'host-retried'/.test(CHAT_JS),
  '宿主回地址时把状态重置回 first 会导致「失败→问宿主→再失败→再问」的死循环',
);
check(
  '两级都失败才写日志，并带上真实地址',
  /post\('imageLoadFailed', \{ src: image\.getAttribute\('src'\) \|\| ''/.test(CHAT_JS)
    && /message\.src \|\| '\(空地址\)'/.test(PANEL),
  '没有真实地址，下次还是只能靠猜',
);
check(
  '宿主能把新地址送回界面',
  /case 'attachmentSrc': applyAttachmentSrc\(message\); break;/.test(CHAT_JS),
);

/* ── 2. 宿主：重新解析走存档里的真实路径 ──────────────────────────── */
check(
  '宿主收到 resolveAttachmentSrc 会重新生成地址',
  /private async resolveAttachmentSrc\(message: \{ attachmentId\?: string \}\): Promise<void>/.test(PANEL)
    && /const src = known\?\.kind === 'image' \? this\.imageSrcFor\(known\.path\) : undefined;/.test(PANEL),
  '手上还有 messageId → 附件 → 文件路径，不用猜',
);
check(
  '索引被淘汰时先从存档恢复（冷启动也能救）',
  /const known = await this\.resolveAttachment\(id\);/.test(PANEL)
    && /private async resolveAttachment\(id: string \| undefined\): Promise<MessageContext \| undefined>/.test(PANEL),
);
check(
  '解析失败也回一条空地址（界面据此退缩略图，而不是一直等）',
  /type: 'attachmentSrc', attachmentId: id, src: src \?\? ''/.test(PANEL),
);

/* ── 3. 缩略图必须在消息里（否则没有兜底可用）─────────────────────── */
check(
  '下发副本带 thumbnailDataUrl',
  /thumbnailDataUrl: context\.thumbnailDataUrl,/.test(PANEL),
  '缩略图是最后一道保险，不能因为改成文件存储就丢掉它',
);
check(
  '存档写入时保留缩略图',
  /stored\.push\(\{ \.\.\.saved, label: attachment\.label, thumbnailDataUrl: attachment\.thumbnailDataUrl \}\)/.test(PANEL),
  'persistAttachments 只留 path 的话，兜底就没有素材了',
);

/* ── 4. 真实 media/chat.js 的行为 ─────────────────────────────────── */
const PLAYWRIGHT_ROOTS = [
  join(CHAT_DIR, 'node_modules', 'playwright'),
  join(homedir(), 'AI projects', 'Safevault_windows', 'node_modules', 'playwright'),
];
const playwrightRoot = PLAYWRIGHT_ROOTS.find((candidate) => existsSync(join(candidate, 'package.json')));
const cacheRoot = join(homedir(), 'Library/Caches/ms-playwright');
const chromium = existsSync(cacheRoot)
  ? (readdirSync(cacheRoot).filter((name) => name.startsWith('chromium_headless_shell')).sort().pop() ?? null)
  : null;

if (!playwrightRoot || !chromium) {
  console.log(`SKIP 浏览器部分：${playwrightRoot ? '找不到 chromium' : '找不到 playwright'}`);
} else {
  const { chromium: launcher } = await import(join(playwrightRoot, 'index.mjs'));
  const executablePath = join(cacheRoot, chromium, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  if (!existsSync(executablePath)) {
    console.log('SKIP 浏览器部分：chromium 可执行文件不在预期路径');
  } else {
    const browser = await launcher.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
    await page.waitForSelector('#composer');

    // 一张真实的 1×1 PNG：既当"缩略图"，也当"宿主解析出来的新地址"。
    const THUMB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    /**
     * 跑一次场景：`reply` 是宿主对 `resolveAttachmentSrc` 的回答（空串表示解析失败）。
     * 返回界面的最终状态，用来分别验证「自愈成功」与「自愈失败退回缩略图」。
     */
    async function runScenario(reply) {
      await page.goto(`file://${join(CHAT_DIR, 'test', 'preview-chat.html')}`);
      await page.waitForSelector('#composer');
      return await page.evaluate(async ({ thumb, replySrc }) => {
        const now = Date.now();
        const conv = { id: 'c', title: 't', mode: 'agent', createdAt: now, updatedAt: now, messageCount: 2, preview: 'p', pinned: false, archived: false };
        const brokenSrc = 'https://127.0.0.1:9/never-there.png';
        const messages = [{
          id: 'u1', role: 'user', content: '侧边栏的不透明度再提高一些', createdAt: now, updatedAt: now,
          status: 'complete', executionStatus: 'done',
          attachments: [{
            id: 'img-db53cf101fa53b2b', label: 'image.png', kind: 'image', mimeType: 'image/png',
            path: '/tmp/hwchat-check/never-there.png', thumbnailDataUrl: thumb, webviewSrc: brokenSrc,
          }],
        }];
        window.postMessage({ type: 'state', state: {
          conversations: [conv], archivedConversations: [], conversation: conv, messages, hasMore: false,
          settings: { sendOnEnter: true, apiProfiles: [], activeApiProfileId: '', model: 'm', permissionPreset: 'askAll', agentMaxSteps: 0, reasoningEffort: 'default', internetReference: false },
          skills: [], selectedSkillIds: [], mode: 'agent', workspaceTrusted: true, agentAvailable: true,
          availableToolCount: 1, showArchived: false, todos: [], project: null,
          modelOptionsByProfile: {}, quickLaunchInstalled: true, fileRoots: {}, streaming: false,
        } }, '*');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 200; i += 1) {
          if (document.querySelector('.message-image-attachment img')) break;
          await new Promise((r) => requestAnimationFrame(r));
        }
        await wait(400);
        const image = document.querySelector('.message-image-attachment img');
        const asked = window.__hwchatMessages.filter((message) => message.type === 'resolveAttachmentSrc');
        // 模拟宿主回答：空串 = 解析失败。
        window.postMessage({ type: 'attachmentSrc', attachmentId: 'img-db53cf101fa53b2b', src: replySrc }, '*');
        await wait(500);
        return {
          rendered: Boolean(image),
          askedHost: asked.length > 0,
          askedId: asked[0]?.attachmentId,
          finalSrc: image ? image.getAttribute('src') : '',
          finalLoaded: image ? image.naturalWidth > 0 : false,
          thumbClass: image ? image.classList.contains('image-is-thumbnail') : false,
          failedReports: window.__hwchatMessages.filter((message) => message.type === 'imageLoadFailed').length,
        };
      }, { thumb: THUMB, replySrc: reply });
    }

    // 场景 A：宿主给的是一个能用的地址 —— 应当显示原图，而不是缩略图。
    const healed = await runScenario(THUMB);
    // 场景 B：宿主也解析不出来（空地址）—— 应当退回消息里的缩略图。
    const broken = await runScenario('');
    check('附件渲染成图片卡片（不是文件 chip）', healed.rendered);
    check('第一次加载失败就请宿主重新解析地址', healed.askedHost, JSON.stringify(healed));
    check('请求里带着附件 id', healed.askedId === 'img-db53cf101fa53b2b', String(healed.askedId));
    check('场景 A：宿主给出可用地址后显示原图（自愈成功）',
      healed.finalSrc === THUMB && healed.finalLoaded && !healed.thumbClass,
      `src=${healed.finalSrc.slice(0, 40)} loaded=${healed.finalLoaded} thumb=${healed.thumbClass}`);
    check('场景 B：宿主也解析不出来时退回缩略图',
      broken.finalSrc === THUMB && broken.finalLoaded,
      `src=${broken.finalSrc.slice(0, 40)} loaded=${broken.finalLoaded}`);
    check('场景 B：保留 is-thumbnail 标记（样式可区分）', broken.thumbClass === true);
    check('场景 B：上报一次失败（供日志定位）', broken.failedReports >= 1, String(broken.failedReports));
    check('渲染过程没有脚本错误', errors.length === 0, errors.join('; '));
    await browser.close();
  }
}

console.log(`\n${checks - failures}/${checks} 项通过`);
if (failures) {
  console.log('图片附件在失败时会留下破图 —— 这条路径还有缺口。');
  process.exitCode = 1;
} else {
  console.log('图片加载失败会自动重新解析，仍失败就退回缩略图，不留破图。');
}
