import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
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

export function createBalanceChart(points) {
  if (!points.length) points = [{ balance: 0 }];
  const width = 900;
  const height = 420;
  const pixels = Buffer.alloc(width * height * 4);
  const setPixel = (x, y, color, alpha = 255) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    const mix = alpha / 255;
    pixels[offset] = Math.round(color[0] * mix + pixels[offset] * (1 - mix));
    pixels[offset + 1] = Math.round(color[1] * mix + pixels[offset + 1] * (1 - mix));
    pixels[offset + 2] = Math.round(color[2] * mix + pixels[offset + 2] * (1 - mix));
    pixels[offset + 3] = 255;
  };
  const fill = (color) => {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255;
    }
  };
  const line = (x0, y0, x1, y1, color, thickness = 1, alpha = 255) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++) {
      const x = x0 + (x1 - x0) * i / steps;
      const y = y0 + (y1 - y0) * i / steps;
      for (let dx = -thickness; dx <= thickness; dx++) {
        for (let dy = -thickness; dy <= thickness; dy++) setPixel(x + dx, y + dy, color, alpha);
      }
    }
  };

  fill([11, 18, 32]);
  const left = 46, right = width - 32, top = 30, bottom = height - 42;
  for (let i = 0; i <= 4; i++) {
    const y = top + (bottom - top) * i / 4;
    line(left, y, right, y, [71, 85, 105], 0, 110);
  }
  for (let i = 0; i <= 6; i++) {
    const x = left + (right - left) * i / 6;
    line(x, top, x, bottom, [71, 85, 105], 0, 70);
  }

  const values = points.map((point) => Number(point.balance));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const padding = Math.max((maxValue - minValue) * 0.12, maxValue * 0.02, 1);
  const low = minValue - padding;
  const high = maxValue + padding;
  const coords = points.map((point, index) => ({
    x: points.length === 1 ? (left + right) / 2 : left + (right - left) * index / (points.length - 1),
    y: bottom - (Number(point.balance) - low) / (high - low) * (bottom - top),
  }));
  const rising = values.at(-1) >= values[0];
  const stroke = rising ? [52, 211, 153] : [248, 113, 113];

  for (let index = 1; index < coords.length; index++) {
    const a = coords[index - 1], b = coords[index];
    const startX = Math.round(a.x), endX = Math.round(b.x);
    for (let x = startX; x <= endX; x++) {
      const ratio = endX === startX ? 0 : (x - startX) / (endX - startX);
      const y = a.y + (b.y - a.y) * ratio;
      for (let fillY = Math.round(y); fillY <= bottom; fillY++) setPixel(x, fillY, stroke, 28);
    }
    line(a.x, a.y, b.x, b.y, stroke, 2);
  }
  for (const point of coords) {
    for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) {
      if (dx * dx + dy * dy <= 16) setPixel(point.x + dx, point.y + dy, stroke);
    }
  }

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
