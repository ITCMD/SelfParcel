// Generate the PWA app icons (a minimal parcel mark) as real PNGs without an
// image library. A tiny hand-rolled PNG encoder is enough for a flat icon.
// Run with: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'public');

// ink blue background, paper box, accent tape
const BG = [36, 52, 140];
const BOX = [246, 244, 239];
const TAPE = [147, 164, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function pngFromPixels(size, pixelAt) {
  // Each row is a filter byte (0 = none) followed by RGB triples.
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y, size);
      const off = y * (stride + 1) + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function parcel(x, y, size) {
  const n = (v) => v / size;
  const nx = n(x);
  const ny = n(y);
  const inBox = nx > 0.2 && nx < 0.8 && ny > 0.2 && ny < 0.8;
  if (!inBox) return BG;
  // horizontal packing tape
  if (ny > 0.46 && ny < 0.54) return TAPE;
  // vertical flap seam on the top half
  if (nx > 0.48 && nx < 0.52 && ny < 0.46) return TAPE;
  return BOX;
}

for (const size of [192, 512]) {
  const png = pngFromPixels(size, parcel);
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`wrote icon-${size}.png (${png.length} bytes)`);
}
