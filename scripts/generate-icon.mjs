import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const size = 256;
const pixels = Buffer.alloc(size * size * 4);

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = (y * size + x) * 4;
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = a;
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    if (!insideRoundedRect(x, y, 4, 4, 251, 251, 54)) continue;
    const t = (x + y) / (size * 2);
    setPixel(x, y, Math.round(55 - 30 * t), Math.round(166 - 65 * t), Math.round(255 - 90 * t));
  }
}

function fillPolygon(points, color) {
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));
  for (let y = minY; y <= maxY; y += 1) {
    const intersections = [];
    for (let i = 0; i < points.length; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
        intersections.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i < intersections.length; i += 2) {
      for (let x = Math.ceil(intersections[i]); x <= Math.floor(intersections[i + 1]); x += 1) {
        setPixel(x, y, ...color);
      }
    }
  }
}

const white = [248, 252, 255, 245];
fillPolygon([[70, 58], [103, 58], [103, 150], [128, 125], [153, 150], [153, 58], [186, 58], [186, 199], [153, 199], [128, 174], [103, 199], [70, 199]], white);

for (let y = 175; y < 214; y += 1) {
  for (let x = 48; x < 208; x += 1) {
    const dx = x < 67 ? 67 - x : x > 189 ? x - 189 : 0;
    const dy = y < 194 ? 194 - y : y - 194;
    if (dx * dx + dy * dy < 18 * 18 && x > 48 && x < 208) {
      setPixel(x, y, 255, 255, 255, 70);
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

const scanlines = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y += 1) {
  scanlines[y * (size * 4 + 1)] = 0;
  pixels.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;

await mkdir('resources', { recursive: true });
await writeFile('resources/icon.png', Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
