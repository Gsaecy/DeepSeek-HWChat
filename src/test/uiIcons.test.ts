import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * media/ui-icons.js 暴露的接口。
 *
 * 这个文件是 webview 用的普通脚本（不是模块），所以在 vm 里跑一遍再把全局取回来，
 * 和 codeBlockMeta.test.ts 用的是同一套办法。
 */
interface UiIcons {
  VIEW_BOX: string;
  PADDING: number;
  DEFAULT_STROKE: number;
  names: () => string[];
  has: (name: string) => boolean;
  markup: (name: string) => string;
}

function loadIcons(): UiIcons {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('media/ui-icons.js', 'utf8'), sandbox);
  const icons = sandbox.HWChatIcons as UiIcons | undefined;
  assert.ok(icons, 'media/ui-icons.js 必须挂载 HWChatIcons');
  return icons;
}

const icons = loadIcons();
const names = icons.names();

test('图标集：至少要覆盖状态徽标、行内操作和折叠箭头所需的名字', () => {
  for (const required of ['check', 'minus', 'bang', 'ellipsis', 'dot', 'ring', 'turn', 'square', 'close', 'arrowUpRight', 'restore', 'chevronRight']) {
    assert.ok(icons.has(required), `缺少图标 ${required}`);
  }
  assert.ok(names.length >= 12, `图标数量偏少：${names.length}`);
});

test('图标集：名字唯一且都是可直接用作 data-icon 的标识符', () => {
  assert.equal(new Set(names).size, names.length, '图标名不能重复');
  for (const name of names) assert.match(name, /^[a-z][a-zA-Z0-9]*$/, `图标名不合规：${name}`);
});

test('图标集：未知名字返回空字符串而不是抛错', () => {
  assert.equal(icons.markup('nope'), '');
  assert.equal(icons.markup(''), '');
});

test('图标集：每个图标都是独立完整的 SVG，且共用同一个 viewBox', () => {
  for (const name of names) {
    const svg = icons.markup(name);
    assert.ok(svg.startsWith('<svg '), `${name} 必须以 <svg 开头`);
    assert.ok(svg.endsWith('</svg>'), `${name} 必须以 </svg> 结尾`);
    assert.ok(svg.includes(`viewBox="${icons.VIEW_BOX}"`), `${name} 的 viewBox 必须是 ${icons.VIEW_BOX}`);
    assert.ok(svg.includes(`data-icon="${name}"`), `${name} 的 data-icon 必须与名字一致`);
    // 同一个字符串被解析两次必须完全一样（说明没有随机量或时间戳）。
    assert.equal(icons.markup(name), svg, `${name} 的生成必须可重复`);
  }
});

test('图标集：只用 currentColor，不硬编码任何颜色', () => {
  for (const name of names) {
    const svg = icons.markup(name);
    assert.ok(svg.includes('stroke="currentColor"'), `${name} 必须用 stroke="currentColor" 继承主题色`);
    // 十六进制、rgb()/hsl()、以及常见的颜色关键字都不允许出现：
    // 硬编码颜色会让图标在深色主题下变成看不见的一团。
    assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,8}\b/, `${name} 出现了十六进制颜色`);
    assert.doesNotMatch(svg, /\b(rgba?|hsla?)\(/, `${name} 出现了函数式颜色`);
    assert.doesNotMatch(svg, /\b(black|white|red|green|blue|gray|grey)\b/i, `${name} 出现了颜色关键字`);
  }
});

test('图标集：不引用外部资源、不含脚本', () => {
  for (const name of names) {
    const svg = icons.markup(name);
    assert.doesNotMatch(svg, /<script/i, `${name} 不能含脚本`);
    assert.doesNotMatch(svg, /<image|xlink:href|href=/i, `${name} 不能引用外部资源`);
    assert.doesNotMatch(svg, /\burl\(/i, `${name} 不能用 url()`);
  }
});

test('图标集：坐标不越出 16 格网格（防止从 24 格图标里直接抄路径）', () => {
  for (const name of names) {
    const svg = icons.markup(name);
    // 只看根标签之后的图形内容：xmlns 里的 2000（http://www.w3.org/2000/svg）不是坐标。
    // 描边宽度也剔掉，它和坐标无关。
    const body = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>')).replace(/stroke-width="[^"]*"/g, '');
    for (const number of body.match(/-?\d+(?:\.\d+)?/g) || []) {
      const value = Number(number);
      // 允许负数是给相对指令（l-4.3 / a…-1.2）用的，所以下界放到 -16；
      // 上界 16 才是真正的护栏：24 格图标里常见的 17~24 会在这里被抓出来。
      assert.ok(value >= -16 && value <= 16, `${name} 的坐标 ${value} 像是从 24 格网格抄来的`);
    }
  }
});

test('图标集：实心图形显式关掉描边，避免出现「实心块外面套一圈线」', () => {
  for (const name of names) {
    const svg = icons.markup(name);
    // 每个 fill="currentColor" 的元素都必须同时写 stroke="none"。
    const filled = svg.match(/fill="currentColor"/g) || [];
    const disabled = svg.match(/fill="currentColor" stroke="none"/g) || [];
    assert.equal(filled.length, disabled.length, `${name} 有实心元素没写 stroke="none"`);
  }
});

test('图标集：描边宽度下限按「最小渲染尺寸」定，不能出现发丝线', () => {
  // 最小的一档是 10px（`.todo-status .ui-icon svg`）。16 格网格上 2.0 的描边，
  // 渲染出来是 2/16×10 = 1.25px，这已经是能看清的下限；再细会被亚像素模糊吃掉。
  const MIN_STROKE = 2;
  for (const name of names) {
    const match = icons.markup(name).match(/stroke-width="([\d.]+)"/);
    assert.ok(match, `${name} 必须显式写出 stroke-width`);
    const width = Number(match[1]);
    assert.ok(width >= MIN_STROKE, `${name} 的描边 ${width} 在 10px 下会糊成一条淡线`);
    assert.ok(width <= 2.8, `${name} 的描边 ${width} 太粗，小图标会粘成一团`);
  }
});

test('图标集：折叠箭头与 CSS 遮罩用的是同一条路径（两处不许各画一套）', () => {
  const css = readFileSync('media/chat.css', 'utf8');
  // 两个箭头都要比对：折叠箭头（chevronRight，展开时旋转 90°）和下拉框箭头（chevronDown）。
  for (const [name, variable] of [['chevronRight', '--chevron-right'], ['chevronDown', '--chevron-down']] as const) {
    const path = icons.markup(name).match(/ d="([^"]+)"/);
    assert.ok(path, `${name} 必须有 path d`);
    // CSS 里的 data URI 用单引号包属性，所以按单引号形式找。
    assert.ok(css.includes(`d='${path[1]}'`), `chat.css 的 ${variable} 必须复用 ${name} 的路径`);
    assert.ok(css.includes(variable), `chat.css 必须定义 ${variable} 遮罩变量`);
  }
});

test('chat.css：箭头遮罩的 data URI 能解码成合法 SVG（编码错了箭头会静默消失）', () => {
  const css = readFileSync('media/chat.css', 'utf8');
  for (const variable of ['--chevron-right', '--chevron-down']) {
    const match = css.match(new RegExp(`${variable}:\\s*url\\("data:image\\/svg\\+xml,([^"]+)"\\)`));
    assert.ok(match, `必须能取出 ${variable} 的 data URI`);
    const encoded = match[1];
    assert.ok(encoded, `${variable} 的 data URI 不能为空`);
    // '#' 在 data URI 里会被当成片段标识，必须写成 %23，否则后面的内容全被截掉。
    assert.ok(!encoded.includes('#'), `${variable} 的 data URI 里出现了未转义的 #，后面的内容会被当成锚点丢掉`);
    const decoded = decodeURIComponent(encoded);
    assert.ok(decoded.startsWith('<svg '), `${variable} 解码后不是 SVG：${decoded.slice(0, 40)}`);
    assert.ok(decoded.endsWith('</svg>'), `${variable} 解码后的 SVG 没有闭合`);
    assert.ok(decoded.includes('<path'), `${variable} 解码后的 SVG 没有图形`);
    // 遮罩只取 alpha，所以颜色必须是可解析的；写死黑色是刻意的。
    assert.ok(decoded.includes("stroke='%23000'") || decoded.includes("stroke='#000'"), `${variable} 的遮罩描边必须是黑色（只用 alpha）`);
  }
});

test('chat.css：折叠箭头不再用 ▸ / ▾ 字符', () => {
  const css = readFileSync('media/chat.css', 'utf8');
  // 用正则而不是字符串包含：引号、空格写法一变，字符串断言就会漏过。
  assert.doesNotMatch(css, /content:\s*["'][▸▾]/, '还有 content 声明在用 ▸ / ▾ 字符');
  assert.doesNotMatch(css, /["'][▸▾]\s*["']/, '还有直接把 ▸ / ▾ 当内容用的地方');
});

test('chat.js：状态符号函数已换成图标，且保留脚本缺失时的文字退路', () => {
  const script = readFileSync('media/chat.js', 'utf8');
  assert.ok(!script.includes('function statusSymbol'), 'statusSymbol 应已替换为图标');
  assert.ok(!script.includes('function taskStatusSymbol'), 'taskStatusSymbol 应已替换为图标');
  assert.ok(script.includes('function statusIconName'), '缺少 statusIconName');
  assert.ok(script.includes('function taskStatusIconName'), '缺少 taskStatusIconName');
  assert.ok(script.includes('HWChatIcons'), 'chat.js 必须读取 HWChatIcons');
  assert.ok(script.includes('GLYPH_FALLBACK'), '必须有文字退路，图标脚本加载失败时不能空白');
});

test('chatPanel.ts：ui-icons.js 必须在 chat.js 之前注入', () => {
  const html = readFileSync('src/views/chatPanel.ts', 'utf8');
  assert.ok(html.includes("mediaUri(webview, this.extensionUri, 'ui-icons.js')"), 'chatPanel.ts 必须注入 ui-icons.js');
  // 源码里的声明顺序说明不了什么（chat.js 的变量先声明），真正决定加载顺序的是 <script> 标签，
  // 而 chat.js 启动时就要读 HWChatIcons，所以标签必须排在它前面。
  const iconTag = html.indexOf('src="${iconScript}"');
  const chatTag = html.indexOf('src="${script}"');
  assert.ok(iconTag > -1, 'HTML 里必须有 iconScript 的 script 标签');
  assert.ok(chatTag > -1, 'HTML 里必须有 chat.js 的 script 标签');
  assert.ok(iconTag < chatTag, 'iconScript 的 <script> 必须排在 chat.js 之前');
});
