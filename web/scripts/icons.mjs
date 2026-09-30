// Generates the PWA icons into src/icons with no dependencies (raw RGBA -> PNG via zlib).
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x1f, 0x2a, 0x24];
const BODY = [0x6f, 0xbf, 0x94];
const QUILL = [0xe8, 0xe6, 0xdf];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size, (y + 0.5) / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A porcupine-ish mark: a dome body with radiating quills, scaled into [pad, 1-pad]. */
function mark(u, v, pad) {
  const s = 1 - 2 * pad;
  const x = (u - pad) / s - 0.5;
  const y = (v - pad) / s - 0.62;
  const r = Math.hypot(x, y);
  const ang = Math.atan2(-y, x);
  if (y <= 0.02 && r < 0.3) return BODY;
  if (y <= 0 && ang > 0.15 && ang < Math.PI - 0.15 && r < 0.46) {
    const spoke = Math.abs(((ang / (Math.PI / 9)) % 1) - 0.5);
    if (spoke > 0.5 - 0.09 * (0.46 / Math.max(r, 0.05))) return QUILL;
  }
  if (y > 0.02 && y < 0.07 && Math.abs(x) < 0.34) return BODY;
  return null;
}

function icon(size, { pad, rounded }) {
  return png(size, (u, v) => {
    if (rounded) {
      const q = 0.18;
      const dx = Math.max(q - u, u - (1 - q), 0);
      const dy = Math.max(q - v, v - (1 - q), 0);
      if (Math.hypot(dx, dy) > q) return [0, 0, 0, 0];
    }
    const c = mark(u, v, pad) ?? BG;
    return [c[0], c[1], c[2], 255];
  });
}

const out = new URL("../src/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("icon-192.png", out), icon(192, { pad: 0.08, rounded: true }));
writeFileSync(new URL("icon-512.png", out), icon(512, { pad: 0.08, rounded: true }));
writeFileSync(new URL("maskable-512.png", out), icon(512, { pad: 0.2, rounded: false }));
writeFileSync(new URL("apple-touch-icon-180.png", out), icon(180, { pad: 0.1, rounded: false }));
