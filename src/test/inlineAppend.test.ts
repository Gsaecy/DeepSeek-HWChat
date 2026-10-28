import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * 「新来的一小段能不能直接贴到段落末尾」。
 *
 * 现场故障：agent 继续输出时，已经输出的文字会跳 —— 鼠标停在那些字上尤其明显。
 * 根因是正在增长的那一段每 70ms 整段重排一次，段落里的文件标签跟着重造；
 * 重造出来的节点要重新进入 :hover、过渡动画从头跑。对「只是接着写普通文字」
 * 走原地追加就能完全避开这件事。
 *
 * 这个判定必须**保守**：宁可多走一次重排，也不能把本该成为标签/加粗/链接的文字
 * 当纯文字贴死。下面每条用例都对应一种「看起来普通、其实不普通」的边界。
 */

interface InlineAppend {
  canAppendPlainText: (appended: string, previousTail: string) => boolean;
}

function load(): InlineAppend {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/inline-append.js', 'utf8'), sandbox);
  const api = sandbox.HWChatInlineAppend as InlineAppend | undefined;
  assert.ok(api, 'media/inline-append.js 必须挂载 HWChatInlineAppend');
  return api;
}

test('普通文字可以原地追加', () => {
  const api = load();
  for (const [appended, tail] of [
    ['现在读这段实现。', '。'],
    [' 继续补充说明', '实现'],
    ['，然后跑测试', '。'],
    [' Done', '。'],
    ['、以及', '实现'],
    ['：', '说明'],
  ] as [string, string][]) {
    assert.equal(api.canAppendPlainText(appended, tail), true, `应可追加：${JSON.stringify(appended)}`);
  }
});

test('空内容不追加（没有变化就别动 DOM）', () => {
  const api = load();
  assert.equal(api.canAppendPlainText('', ''), false);
  assert.equal(api.canAppendPlainText(null as unknown as string, ''), false);
});

test('可能开启/闭合行内标记的字符一律重排', () => {
  const api = load();
  for (const appended of ['`', '**粗体', '*斜体', '~~删', '[文字](', '| 表格', '# 标题', '<', '\\', '_强调_']) {
    assert.equal(api.canAppendPlainText(appended, '之前'), false, `不能直接追加：${JSON.stringify(appended)}`);
  }
});

test('换行必须重排（空行会切开段落）', () => {
  const api = load();
  assert.equal(api.canAppendPlainText('\n第二段', '第一段'), false);
  assert.equal(api.canAppendPlainText('\r\n', '第一段'), false);
});

test('路径 / 链接的片段必须重排', () => {
  const api = load();
  // 整段就是一个路径
  assert.equal(api.canAppendPlainText('src/app/a.ts', '说明'), false, '带扩展名');
  // URL 片段
  assert.equal(api.canAppendPlainText('://example.com', 'https'), false, '冒号斜杠');
  assert.equal(api.canAppendPlainText('/docs', 'example.com'), false, '斜杠');
  // 跨帧拼出来的路径：上一帧停在 `app`、这一帧是 `.tsx`
  assert.equal(api.canAppendPlainText('.tsx', 'app'), false, '扩展名后半截');
  // 上一帧停在 `src/`、这一帧补文件名
  assert.equal(api.canAppendPlainText('app.ts', 'src/'), false);
  assert.equal(api.canAppendPlainText('WorkspaceSwitcher', 'src/app/'), false, '补文件名');
});

test('单纯的小数点不受影响（不能因为怕路径就禁掉数字）', () => {
  const api = load();
  // 中文句号后面接数字
  assert.equal(api.canAppendPlainText('12 项', '共'), true);
  // `3.5` 这种带点的数字会被判成「像扩展名」，走重排——只是慢一点，不会渲染错
  assert.equal(api.canAppendPlainText('5 倍', '3.'), false);
});
