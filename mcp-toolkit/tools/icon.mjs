// The project icon, generated. `node tools/icon.mjs` from mcp-toolkit/ rewrites
// src/main/resources/icon.png (512x512), which both loader manifests point at: fabric.mod.json
// "icon" and neoforge.mods.toml logoFile. The picture is a 32x32 pixel-art drawing scaled 16x with
// nearest-neighbour, so it reads the same in the Fabric mod list at 16px, the NeoForge mods screen,
// and a Modrinth/CurseForge card at 512.
//
// What it draws: a wrench in front of a grass block - the toolkit is a tool that reaches into the
// game. Everything is geometry on a 32-grid (no hand-typed pixel map), so a colour or a proportion
// is one constant. The encoder is the shim's own png.mjs: no image library, and the same codec the
// image budget already trusts.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "../../mcp-server/image/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src", "main", "resources", "icon.png");
const N = 32;
const SCALE = 16;

// Palette. Block colours are vanilla-ish (grass top, dirt) so the thing is recognisably Minecraft;
// the wrench is three steels and an outline dark enough to hold against both light and dark UIs.
const C = {
  grass: [0x7c, 0xbd, 0x4f], grassLight: [0x93, 0xcf, 0x62], grassDark: [0x69, 0xa9, 0x3f],
  fringe: [0x55, 0x8f, 0x33],
  dirtL: [0x80, 0x55, 0x2c], dirtLDark: [0x71, 0x4a, 0x26], dirtLLight: [0x8e, 0x60, 0x33],
  dirtR: [0x9c, 0x68, 0x37], dirtRDark: [0x8a, 0x5b, 0x2f], dirtRLight: [0xab, 0x74, 0x3f],
  blockLine: [0x2e, 0x22, 0x14],
  steel: [0xb9, 0xc2, 0xcc], steelLight: [0xe6, 0xeb, 0xef], steelDark: [0x6f, 0x7a, 0x86],
  outline: [0x1c, 0x21, 0x28],
};

// --- geometry -----------------------------------------------------------------------------------

// Isometric cube, 2:1 slopes. Sits up-left so the wrench can cross it from bottom-left to top-right.
const T = [14, 2.2], L = [3, 7.7], R = [25, 7.7], B = [14, 13.2], H = 10;
const topFace = [T, R, B, L];
const leftFace = [L, B, [B[0], B[1] + H], [L[0], L[1] + H]];
const rightFace = [B, R, [R[0], R[1] + H], [B[0], B[1] + H]];

// Wrench: a ring at the bottom-left, a straight handle, an open jaw at the top-right.
const RING = [6.8, 27.4], RING_R = 2.9, RING_HOLE = 1.2;
const HEAD = [25.6, 8.2], HEAD_R = 4.1;
const HANDLE_HALF = 1.2;
const JAW_HALF = 1.3, JAW_FROM = 0.3;

function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// Along/across the handle axis, from the ring centre. `across` > 0 is the lower-right side.
const axLen = dist(...RING, ...HEAD);
const dx = (HEAD[0] - RING[0]) / axLen, dy = (HEAD[1] - RING[1]) / axLen;
const nx = -dy, ny = dx; // rotate d by +90deg: points down-right for an up-right d
function axis(px, py) {
  const rx = px - RING[0], ry = py - RING[1];
  return { along: rx * dx + ry * dy, across: rx * nx + ry * ny };
}

function wrenchAt(px, py) {
  const { along, across } = axis(px, py);
  const toRing = dist(px, py, ...RING), toHead = dist(px, py, ...HEAD);
  if (toRing < RING_HOLE) return false;
  if (toRing < RING_R) return true;
  if (toHead < HEAD_R) {
    // The jaw: a slot along the axis, open past the head centre.
    const hAlong = along - axLen;
    if (hAlong > JAW_FROM && Math.abs(across) < JAW_HALF) return false;
    return true;
  }
  return along > 0 && along < axLen && Math.abs(across) < HANDLE_HALF;
}

// A fixed, cheap hash - texture noise that is the same every run.
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// --- raster -------------------------------------------------------------------------------------

const cube = new Uint8Array(N * N);   // 0 none, 1 top, 2 left, 3 right
const wrench = new Uint8Array(N * N);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const px = x + 0.5, py = y + 0.5, i = y * N + x;
  if (inPoly(px, py, topFace)) cube[i] = 1;
  else if (inPoly(px, py, leftFace)) cube[i] = 2;
  else if (inPoly(px, py, rightFace)) cube[i] = 3;
  wrench[i] = wrenchAt(px, py) ? 1 : 0;
}

function dilate(mask) {
  const out = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let hit = 0;
    for (let oy = -1; oy <= 1 && !hit; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = x + ox, yy = y + oy;
      if (xx >= 0 && yy >= 0 && xx < N && yy < N && mask[yy * N + xx]) { hit = 1; break; }
    }
    out[y * N + x] = hit;
  }
  return out;
}
const cubeEdge = dilate(cube);
const wrenchEdge = dilate(wrench);

const small = new Uint8Array(N * N * 4);
function put(i, rgb) { small[i * 4] = rgb[0]; small[i * 4 + 1] = rgb[1]; small[i * 4 + 2] = rgb[2]; small[i * 4 + 3] = 255; }
function pick(x, y, base, light, dark) {
  const r = hash(x, y);
  return r < 0.16 ? light : r > 0.84 ? dark : base;
}

for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const i = y * N + x;
  const px = x + 0.5, py = y + 0.5;

  // Block, then its outline.
  if (cube[i] === 1) put(i, pick(x, y, C.grass, C.grassLight, C.grassDark));
  else if (cube[i] === 2 || cube[i] === 3) {
    // Grass fringe hanging over the top of each side face, jagged like the vanilla side texture.
    const faceTop = cube[i] === 2 ? L[1] + (px - L[0]) * 0.5 : B[1] - (px - B[0]) * 0.5;
    const depth = py - faceTop;
    const fringeRows = (x % 3 === 1) ? 2.0 : 1.0;
    if (depth < fringeRows) put(i, C.fringe);
    else if (cube[i] === 2) put(i, pick(x, y, C.dirtL, C.dirtLLight, C.dirtLDark));
    else put(i, pick(x, y, C.dirtR, C.dirtRLight, C.dirtRDark));
  } else if (cubeEdge[i]) put(i, C.blockLine);

  // Wrench on top of everything, with its own outline.
  if (wrench[i]) {
    const { across } = axis(px, py);
    const onHead = dist(px, py, ...HEAD) < HEAD_R;
    const onRing = dist(px, py, ...RING) < RING_R;
    let shade = C.steel;
    if (onHead || onRing) {
      const c = onHead ? HEAD : RING;
      const rel = (px - c[0]) * nx + (py - c[1]) * ny; // across, relative to the circle's centre
      const rad = onHead ? HEAD_R : RING_R;
      shade = rel < -rad * 0.35 ? C.steelLight : rel > rad * 0.45 ? C.steelDark : C.steel;
    } else {
      shade = across < -0.6 ? C.steelLight : across > 0.6 ? C.steelDark : C.steel;
    }
    put(i, shade);
  } else if (wrenchEdge[i]) put(i, C.outline);
}

// Nearest-neighbour upscale.
const W = N * SCALE;
const big = new Uint8Array(W * W * 4);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const s = ((y / SCALE) | 0) * N + ((x / SCALE) | 0);
  big.set(small.subarray(s * 4, s * 4 + 4), (y * W + x) * 4);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, encodePng({ width: W, height: W, data: Buffer.from(big) }, { level: 9 }));
const previewPath = process.argv[2];
if (previewPath) writeFileSync(previewPath, encodePng({ width: N, height: N, data: Buffer.from(small) }));
console.log(`wrote ${OUT} (${W}x${W}, from a ${N}x${N} drawing)`);
