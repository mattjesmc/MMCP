// A PNG codec in plain JavaScript, on Node's own zlib. No native module, on purpose.
//
// The shim ships inside the toolkit jar (mcp-server-dist) and must start from a fresh extract on a
// machine that has never run `npm install` for it; `sharp` is a native binary and a fresh extract has
// no place to put one. `@huggingface/transformers` happens to pull `sharp` into node_modules here,
// but a dependency that is present by accident is not a dependency. Everything the image budget
// (shrink.mjs) needs is a decode to RGBA and an encode from RGBA, and that is ~200 lines.
//
// Decodes: 8- and 16-bit greyscale, greyscale+alpha, RGB, RGBA, and palette (with tRNS), plus the
// sub-byte greyscale/palette depths. Interlaced (Adam7) images THROW; the caller passes those
// through untouched, which is the honest failure mode for a budget: an image the codec cannot read
// costs what it always cost, and the cost line says so.
//
// Encodes: RGBA 8-bit, non-interlaced, with the per-row adaptive filter every real encoder uses
// (the filter with the smallest sum of absolute residuals). A screenshot is mostly flat runs and
// gradients, and Sub/Up/Paeth halve its size against filter 0.

import { inflateSync, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC-32, table-driven, as PNG specifies (ISO 3309). ~30 lines is cheaper than a dependency.
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf, start = 0, end = buf.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Is this buffer a PNG at all? The budget only touches what it can read back. */
export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

/** Width and height from the header alone — the analyser prices pictures without decoding them. */
export function pngSize(buf) {
  if (!isPng(buf) || buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a PNG to `{ width, height, data }` where `data` is RGBA, 8 bits per channel, row-major —
 * the same shape a canvas `getImageData` returns, so the rest of the pipeline never sees the wire
 * format.
 */
export function decodePng(buf) {
  if (!isPng(buf)) throw new Error("not a PNG");
  let pos = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (!ihdr) throw new Error("PNG without IHDR");
  if (ihdr.interlace) throw new Error("interlaced PNG (Adam7) is not supported");
  const { width, height, depth, colorType } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`PNG colour type ${colorType} is not supported`);
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3); // bytes per pixel for the filter, min 1
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG data is truncated");

  // Unfilter in place, row by row.
  const rows = Buffer.alloc(stride * height);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: v += paeth(a, b, c); break;
        default: throw new Error(`PNG filter ${filter} on row ${y}`);
      }
      row[i] = v & 0xff;
    }
    prev = row;
  }

  // Expand to RGBA8.
  const out = Buffer.alloc(width * height * 4);
  const sample = (row, index) => { // the index-th sample of a row, scaled to 0..255
    if (depth === 8) return row[index];
    if (depth === 16) return row[index * 2]; // the high byte is the 8-bit value
    const perByte = 8 / depth;
    const byte = row[Math.floor(index / perByte)];
    const shift = 8 - depth * (1 + (index % perByte));
    const v = (byte >> shift) & ((1 << depth) - 1);
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      switch (colorType) {
        case 0: { // grey
          const g = sample(row, x);
          out[o] = out[o + 1] = out[o + 2] = g;
          out[o + 3] = trns && trns.length >= 2 && g === trns.readUInt16BE(0) ? 0 : 255;
          break;
        }
        case 2: { // rgb
          out[o] = sample(row, x * 3); out[o + 1] = sample(row, x * 3 + 1); out[o + 2] = sample(row, x * 3 + 2);
          out[o + 3] = 255;
          if (trns && trns.length >= 6 && out[o] === trns.readUInt16BE(0)
              && out[o + 1] === trns.readUInt16BE(2) && out[o + 2] === trns.readUInt16BE(4)) out[o + 3] = 0;
          break;
        }
        case 3: { // palette
          const i = sample(row, x);
          if (!palette) throw new Error("palette PNG without PLTE");
          out[o] = palette[i * 3]; out[o + 1] = palette[i * 3 + 1]; out[o + 2] = palette[i * 3 + 2];
          out[o + 3] = trns && i < trns.length ? trns[i] : 255;
          break;
        }
        case 4: { // grey + alpha
          const g = sample(row, x * 2);
          out[o] = out[o + 1] = out[o + 2] = g;
          out[o + 3] = sample(row, x * 2 + 1);
          break;
        }
        case 6: { // rgba
          out[o] = sample(row, x * 4); out[o + 1] = sample(row, x * 4 + 1);
          out[o + 2] = sample(row, x * 4 + 2); out[o + 3] = sample(row, x * 4 + 3);
          break;
        }
        default: throw new Error(`PNG colour type ${colorType}`);
      }
    }
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

/**
 * Encode RGBA8 `{ width, height, data }` as a PNG. Every row tries all five filters and keeps the one
 * with the least residual, which is what libpng does and is why the result compresses.
 */
export function encodePng({ width, height, data }, { level = 6 } = {}) {
  if (data.length !== width * height * 4) throw new Error("encodePng: data is not width*height*4");
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidates = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = candidates[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0;
        const b = prev ? prev[i] : 0;
        const cc = prev && i >= 4 ? prev[i - 4] : 0;
        let v;
        switch (f) {
          case 0: v = row[i]; break;
          case 1: v = row[i] - a; break;
          case 2: v = row[i] - b; break;
          case 3: v = row[i] - ((a + b) >> 1); break;
          default: v = row[i] - paeth(a, b, cc);
        }
        v &= 0xff;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break; // already worse than the best so far
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    candidates[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
