/**
 * 极简 QR 码编码器（byte 模式，纠错等级 M，版本 1–10）。
 *
 * 为什么要自己写：手机遥控的入口是一张二维码，而扩展没有运行时依赖，
 * 也不该为了画一张码去联网，或调用第三方图片接口（会有隐私问题）。
 *
 * 这套实现只在编码侧、位数固定（URL 一般 40–80 字节，落在版本 3–6）；
 * 算法结构照 QR 规范（ISO/IEC 18004）：数据码字 → RS 纠错 → 交织 → 落图 → 掩码择优。
 */

/** 纠错等级 M 的格式信息位（L=01, M=00, Q=11, H=10）。 */
const EC_FORMAT_BITS_M = 0b00;

/**
 * 每个版本的参数（纠错等级 M）。
 *
 * `data` 是数据码字总数，`ec` 是每块的纠错码字数，`group1/group2` 是两块的数据码字数。
 * 版本 1–7 只有一块，8 以后才出现「两块长度差 1」的情况。
 */
interface VersionSpec {
  data: number;
  ec: number;
  group1: number;
  group2: number;
  group1Blocks: number;
  group2Blocks: number;
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { data: 16, ec: 10, group1: 16, group2: 0, group1Blocks: 1, group2Blocks: 0 },
  2: { data: 28, ec: 16, group1: 28, group2: 0, group1Blocks: 1, group2Blocks: 0 },
  3: { data: 44, ec: 26, group1: 44, group2: 0, group1Blocks: 1, group2Blocks: 0 },
  4: { data: 64, ec: 18, group1: 32, group2: 0, group1Blocks: 2, group2Blocks: 0 },
  5: { data: 86, ec: 24, group1: 43, group2: 0, group1Blocks: 2, group2Blocks: 0 },
  6: { data: 108, ec: 16, group1: 27, group2: 0, group1Blocks: 4, group2Blocks: 0 },
  7: { data: 124, ec: 18, group1: 31, group2: 0, group1Blocks: 4, group2Blocks: 0 },
  8: { data: 154, ec: 22, group1: 38, group2: 39, group1Blocks: 2, group2Blocks: 2 },
  9: { data: 182, ec: 22, group1: 36, group2: 37, group1Blocks: 3, group2Blocks: 2 },
  10: { data: 216, ec: 26, group1: 43, group2: 44, group1Blocks: 4, group2Blocks: 1 },
};

/** 校准图案的中心坐标。版本 1 没有校准图案。 */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

export interface QrMatrix {
  /** 每边的模块数（不含静区）。 */
  size: number;
  version: number;
  mask: number;
  /** `dark[row][col]`，true = 黑。 */
  dark: boolean[][];
}

function pushBits(target: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) target.push((value >>> i) & 1);
}

function bitAt(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

/* ---------- Reed–Solomon（GF(256)，本原多项式 0x11D） ---------- */

function gfMultiply(x: number, y: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((y >>> i) & 1) * x;
  }
  return result & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i += 1) {
      result[i] = result[i]! ^ gfMultiply(divisor[i]!, factor);
    }
  }
  return result;
}

/* ---------- 数据码字 ---------- */

function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function pickVersion(byteLength: number, minVersion: number): number {
  for (let version = Math.max(1, minVersion); version <= 10; version += 1) {
    const capacity = VERSIONS[version]!.data * 8;
    const needed = 4 + charCountBits(version) + byteLength * 8;
    if (needed <= capacity) return version;
  }
  throw new Error(`内容过长，二维码放不下（${byteLength} 字节）`);
}

function buildCodewords(bytes: number[], version: number): number[] {
  const spec = VERSIONS[version]!;
  const capacityBits = spec.data * 8;
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, charCountBits(version));
  for (const byte of bytes) pushBits(bits, byte, 8);

  // 结束符 + 补齐到整字节
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j]!;
    data.push(value);
  }
  // 交替填充 0xEC / 0x11
  for (let pad = 0xec; data.length < spec.data; pad ^= 0xec ^ 0x11) data.push(pad);

  // 分块 → 各自算纠错 → 交织
  const blocks: number[][] = [];
  const divisors: number[][] = [];
  const sizes: number[] = [];
  let offset = 0;
  const push = (count: number, size: number): void => {
    for (let i = 0; i < count; i += 1) {
      const block = data.slice(offset, offset + size);
      offset += size;
      blocks.push(block);
      sizes.push(size);
      divisors.push(rsDivisor(spec.ec));
    }
  };
  push(spec.group1Blocks, spec.group1);
  push(spec.group2Blocks, spec.group2);
  const ecBlocks = blocks.map((block, index) => rsRemainder(block, divisors[index]!));

  const result: number[] = [];
  const maxData = Math.max(...sizes);
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < spec.ec; i += 1) {
    for (const block of ecBlocks) result.push(block[i]!);
  }
  return result;
}

/* ---------- 落图 ---------- */

interface Canvas {
  size: number;
  dark: boolean[][];
  reserved: boolean[][];
}

function setModule(canvas: Canvas, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  canvas.dark[y]![x] = dark;
  canvas.reserved[y]![x] = true;
}

function drawFinder(canvas: Canvas, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setModule(canvas, cx + dx, cy + dy, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(canvas: Canvas, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setModule(canvas, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(canvas: Canvas, version: number): void {
  const { size } = canvas;
  // 定时图案
  for (let i = 0; i < size; i += 1) {
    setModule(canvas, 6, i, i % 2 === 0);
    setModule(canvas, i, 6, i % 2 === 0);
  }
  // 三个定位图案
  drawFinder(canvas, 3, 3);
  drawFinder(canvas, size - 4, 3);
  drawFinder(canvas, 3, size - 4);
  // 校准图案
  const centers = ALIGNMENT[version] ?? [];
  for (const cx of centers) {
    for (const cy of centers) {
      // 与定位图案重叠的位置不放
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      drawAlignment(canvas, cx, cy);
    }
  }
  // 预留格式信息区（先占位，稍后写真正的位）。
  // **必须跳过定时图案所在的 (8,6) 与 (6,8)**：那两格属于定时图案，
  // 第一版这里无条件置白，把定时图案截断了，扫码器就找不到网格。
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) setModule(canvas, 8, i, false);
    if (i !== 6) setModule(canvas, i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    setModule(canvas, size - 1 - i, 8, false);
    setModule(canvas, 8, size - 1 - i, false);
  }
  // 版本信息（版本 7 起）
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setModule(canvas, a, b, bitAt(bits, i));
      setModule(canvas, b, a, bitAt(bits, i));
    }
  }
}

function drawFormat(canvas: Canvas, mask: number): void {
  const { size } = canvas;
  const data = (EC_FORMAT_BITS_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;

  for (let i = 0; i <= 5; i += 1) setModule(canvas, 8, i, bitAt(bits, i));
  setModule(canvas, 8, 7, bitAt(bits, 6));
  setModule(canvas, 8, 8, bitAt(bits, 7));
  setModule(canvas, 7, 8, bitAt(bits, 8));
  for (let i = 9; i < 15; i += 1) setModule(canvas, 14 - i, 8, bitAt(bits, i));

  for (let i = 0; i < 8; i += 1) setModule(canvas, size - 1 - i, 8, bitAt(bits, i));
  for (let i = 8; i < 15; i += 1) setModule(canvas, 8, size - 15 + i, bitAt(bits, i));
  setModule(canvas, 8, size - 8, true);
}

function placeData(canvas: Canvas, codewords: number[]): void {
  const { size } = canvas;
  let index = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!canvas.reserved[y]![x] && index < total) {
          canvas.dark[y]![x] = bitAt(codewords[index >>> 3]!, 7 - (index & 7));
          index += 1;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(canvas: Canvas, mask: number): void {
  const { size } = canvas;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (canvas.reserved[y]![x]) continue;
      if (maskBit(mask, x, y)) canvas.dark[y]![x] = !canvas.dark[y]![x];
    }
  }
}

/** 规范里的四条罚分：连续同色、2×2 同色、疑似定位图案、黑白占比失衡。 */
function penalty(canvas: Canvas, size: number): number {
  let score = 0;
  const line = (read: (i: number, j: number) => boolean, length: number, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      let run = 1;
      for (let j = 1; j < length; j += 1) {
        if (read(i, j) === read(i, j - 1)) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  line((i, j) => canvas.dark[i]![j]!, size, size);
  line((i, j) => canvas.dark[j]![i]!, size, size);

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = canvas.dark[y]![x]!;
      if (value === canvas.dark[y]![x + 1] && value === canvas.dark[y + 1]![x] && value === canvas.dark[y + 1]![x + 1]) {
        score += 3;
      }
    }
  }

  // 疑似定位图案：1011101 且左或右有 4 个连续白
  const sequence = [true, false, true, true, true, false, true];
  const scanLine = (get: (index: number) => boolean): void => {
    for (let i = 0; i + 7 <= size; i += 1) {
      let ok = true;
      for (let k = 0; k < 7; k += 1) {
        if (get(i + k) !== sequence[k]) { ok = false; break; }
      }
      if (!ok) continue;
      let before = true;
      for (let k = 1; k <= 4 && i - k >= 0; k += 1) if (get(i - k)) before = false;
      let after = true;
      for (let k = 0; k < 4 && i + 7 + k < size; k += 1) if (get(i + 7 + k)) after = false;
      if (before || after) score += 40;
    }
  };
  for (let y = 0; y < size; y += 1) scanLine((index) => canvas.dark[y]![index]!);
  for (let x = 0; x < size; x += 1) scanLine((index) => canvas.dark[index]![x]!);

  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (canvas.dark[y]![x]) dark += 1;
  const total = size * size;
  const percent = Math.floor((dark * 100) / total);
  score += (Math.abs(percent - 50) * 2) * 5;
  return score;
}

/**
 * 把文本编码成二维码矩阵。
 *
 * `minVersion` 用于保证不同长度的内容在界面上大小接近（可选）。
 */
export function encodeQr(text: string, options: { minVersion?: number; mask?: number } = {}): QrMatrix {
  const bytes = [...Buffer.from(text, 'utf8')];
  const version = pickVersion(bytes.length, options.minVersion ?? 1);
  const codewords = buildCodewords(bytes, version);
  const size = version * 4 + 17;
  const canvas: Canvas = {
    size,
    dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
  drawFunctionPatterns(canvas, version);
  placeData(canvas, codewords);

  if (options.mask !== undefined) {
    applyMask(canvas, options.mask);
    drawFormat(canvas, options.mask);
    return { size, version, mask: options.mask, dark: canvas.dark };
  }

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestDark = canvas.dark;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(canvas, mask);
    drawFormat(canvas, mask);
    const score = penalty(canvas, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestDark = canvas.dark.map((row) => [...row]);
    }
    applyMask(canvas, mask);
  }
  return { size, version, mask: bestMask, dark: bestDark };
}

/** 渲染成内联 SVG（静区 4 个模块，和规范一致，扫码器才认得出边界）。 */
export function qrSvg(text: string, options: { module?: number; quiet?: number; color?: string } = {}): string {
  const matrix = encodeQr(text);
  const module = options.module ?? 6;
  const quiet = options.quiet ?? 4;
  const dimension = (matrix.size + quiet * 2) * module;
  const color = options.color ?? '#111827';
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (!matrix.dark[y]![x]) continue;
      parts.push(`M${(x + quiet) * module} ${(y + quiet) * module}h${module}v${module}h-${module}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">`
    + `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>`
    + `<path d="${parts.join('')}" fill="${color}"/></svg>`;
}
