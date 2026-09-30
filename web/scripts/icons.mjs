// Generates every icon from src/icons/source/porcupine-1024.png with no dependencies:
// zlib inflate, PNG unfilter, area-average downscale, zlib deflate.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const PLUM = [0x24, 0x12, 0x2a];
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG into { width, height, rgb } (3 bytes per pixel). */
function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colorType, , , interlace] = data.subarray(8);
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG: depth ${depth}, color type ${colorType}, interlace ${interlace}`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      if (predictor === undefined) throw new Error(`bad filter ${filter}`);
      out[i] = (line[i] + predictor) & 0xff;
    }
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let p = 0; p < width * height; p++) pixels.copy(rgb, p * 3, p * channels, p * channels + 3);
  return { width, height, rgb };
}

/** Area-average downscale of a square RGB image to size x size. */
function downscale(img, size) {
  const out = Buffer.alloc(size * size * 3);
  const scale = img.width / size;
  for (let y = 0; y < size; y++) {
    const y0 = y * scale;
    const y1 = y0 + scale;
    for (let x = 0; x < size; x++) {
      const x0 = x * scale;
      const x1 = x0 + scale;
      const sum = [0, 0, 0];
      let total = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const o = (sy * img.width + sx) * 3;
          sum[0] += img.rgb[o] * w;
          sum[1] += img.rgb[o + 1] * w;
          sum[2] += img.rgb[o + 2] * w;
          total += w;
        }
      }
      const o = (y * size + x) * 3;
      for (let k = 0; k < 3; k++) out[o + k] = Math.round(sum[k] / total);
    }
  }
  return { width: size, height: size, rgb: out };
}

/** Places img centered on a plum canvas of the given size. */
function onPlum(img, size) {
  const rgb = Buffer.alloc(size * size * 3);
  for (let p = 0; p < size * size; p++) rgb.set(PLUM, p * 3);
  const off = Math.floor((size - img.width) / 2);
  for (let y = 0; y < img.height; y++) {
    img.rgb.copy(rgb, ((y + off) * size + off) * 3, y * img.width * 3, (y + 1) * img.width * 3);
  }
  return { width: size, height: size, rgb };
}

function encode(img) {
  const stride = img.width * 3;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A single-image ICO wrapping a PNG (supported by every current browser). */
function ico(pngBuf, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = size;
  header[7] = size;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngBuf.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, pngBuf]);
}

const src = decode(readFileSync(new URL("../src/icons/source/porcupine-1024.png", import.meta.url)));
const icons = new URL("../src/icons/", import.meta.url);
const docs = new URL("../../docs/", import.meta.url);
mkdirSync(icons, { recursive: true });
mkdirSync(docs, { recursive: true });

const favicon = encode(downscale(src, 32));
writeFileSync(new URL("icon-192.png", icons), encode(downscale(src, 192)));
writeFileSync(new URL("icon-512.png", icons), encode(downscale(src, 512)));
writeFileSync(new URL("apple-touch-icon-180.png", icons), encode(downscale(src, 180)));
writeFileSync(new URL("favicon-32.png", icons), favicon);
writeFileSync(new URL("../favicon.ico", icons), ico(favicon, 32));
// Maskable: the full-bleed art at 70 percent keeps the porcupine inside the 80 percent safe circle.
writeFileSync(new URL("maskable-512.png", icons), encode(onPlum(downscale(src, 358), 512)));
writeFileSync(new URL("logo.png", docs), encode(downscale(src, 256)));
