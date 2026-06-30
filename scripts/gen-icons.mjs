// Generate the PWA app icons from the SAME artwork as the favicon, so the
// installed-app icon matches the favicon and the header logo (a cardboard
// parcel) instead of being a separate flat mark.
//
// selfparcel.ico holds one 256x256 32bpp image. We decode it, resample the box
// into a maskable-safe inset, composite it over the ink-blue brand plate (which
// also matches theme_color), and write opaque 192 & 512 PNGs with a tiny
// hand-rolled encoder (no image library needed).
//
// Run with: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'public');
const PLATE = [26, 39, 110]; // dark ink blue (matches --accent-press)
const INSET = 0.12; // padding each side -> ~76% content, inside the maskable safe zone

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
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function pngFromPixels(size, pixelAt) {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y);
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
  ihdr[9] = 2; // truecolor RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Decode the single 256x256 32bpp BGRA entry from an .ico into RGBA. The ICO
// stores the bitmap bottom-up with a doubled height (colour rows + AND mask).
function loadIcoRGBA(path) {
  const b = readFileSync(path);
  const off = b.readUInt32LE(6 + 12); // entry 0 image offset
  const w = b.readInt32LE(off + 4);
  const h = Math.abs(b.readInt32LE(off + 8)) / 2;
  const px = off + 40; // 32bpp DIB has no palette
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const p = px + (srcY * w + x) * 4;
      const o = (y * w + x) * 4;
      data[o] = b[p + 2]; // R
      data[o + 1] = b[p + 1]; // G
      data[o + 2] = b[p]; // B
      data[o + 3] = b[p + 3]; // A
    }
  }
  return { w, h, data };
}

// Bilinear sample of the RGBA source at floating coordinates.
function sampleBilinear(img, fx, fy) {
  const x0 = Math.max(0, Math.min(img.w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(img.h - 1, Math.floor(fy)));
  const x1 = Math.min(img.w - 1, x0 + 1);
  const y1 = Math.min(img.h - 1, y0 + 1);
  const dx = fx - x0;
  const dy = fy - y0;
  const at = (x, y, c) => img.data[(y * img.w + x) * 4 + c];
  const lerp = (a, b, t) => a + (b - a) * t;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = lerp(at(x0, y0, c), at(x1, y0, c), dx);
    const bot = lerp(at(x0, y1, c), at(x1, y1, c), dx);
    out[c] = lerp(top, bot, dy);
  }
  return out;
}

const box = loadIcoRGBA(join(OUT, 'selfparcel.ico'));

for (const size of [192, 512]) {
  const inset = Math.round(size * INSET);
  const span = size - inset * 2;
  const png = pngFromPixels(size, (x, y) => {
    const cx = x - inset;
    const cy = y - inset;
    if (cx < 0 || cy < 0 || cx >= span || cy >= span) return PLATE;
    const [r, g, b, a] = sampleBilinear(box, (cx / span) * box.w, (cy / span) * box.h);
    const al = a / 255;
    return [
      Math.round(r * al + PLATE[0] * (1 - al)),
      Math.round(g * al + PLATE[1] * (1 - al)),
      Math.round(b * al + PLATE[2] * (1 - al)),
    ];
  });
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`wrote icon-${size}.png (${png.length} bytes)`);
}
