// Plot staging for the world-edit / objective slices — forceload + floor + clear, via run_command.
// Deliberately DECOUPLED from tasks.mjs (which the concurrent tool-swap bench is actively editing):
// these slices live in their own far quadrant and stage themselves with plain commands, so nothing
// here depends on the churning ablation loader. forceload add/remove caps at 256 chunks/command, so
// boxes are stripped. Sky plots at y≈150 only need the chunks LOADED (forceload), then filled.

import { cmd } from "./bridge.mjs";

const CHUNK = 16;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Distinct origin for the build/objective slices — far from A/B (~3M ORIGIN), C (116k), P/E (2.99M). */
export const WEBASE = { x: 3200000, z: 3200000 };
export const FLOOR_Y = 150;

async function stripBox(minX, minZ, maxX, maxZ, verb) {
  // ≤256 chunks per forceload command → strip in bands of 16 chunks in z (16×16=256).
  for (let z = minZ; z <= maxZ; z += CHUNK * 16) {
    await cmd(`forceload ${verb} ${minX} ${z} ${maxX} ${Math.min(z + CHUNK * 16 - 1, maxZ)}`).catch(() => {});
  }
}
export async function forceloadBox(minX, minZ, maxX, maxZ) { await stripBox(minX, minZ, maxX, maxZ, "add"); await wait(200); }
export async function releaseBox(minX, minZ, maxX, maxZ) { await stripBox(minX, minZ, maxX, maxZ, "remove"); }

/**
 * Stage a clean plot: forceload, lay a solid floor at FLOOR_Y, clear `head` blocks of air above it,
 * and clear a few blocks below so nothing juts in. Returns the plot rect for release.
 */
export async function stagePlot(cx, cz, half, { floor = "minecraft:stone", head = 12 } = {}) {
  const minX = cx - half, maxX = cx + half, minZ = cz - half, maxZ = cz + half;
  await forceloadBox(minX, minZ, maxX, maxZ);
  await cmd("weather clear");
  await cmd(`fill ${minX} ${FLOOR_Y} ${minZ} ${maxX} ${FLOOR_Y} ${maxZ} ${floor}`);
  await cmd(`fill ${minX} ${FLOOR_Y + 1} ${minZ} ${maxX} ${FLOOR_Y + head} ${maxZ} minecraft:air`);
  return { minX, minZ, maxX, maxZ };
}

/** Fill a box with air (clear a build region between arms/rounds). */
export async function clearBox(min, max, block = "minecraft:air") {
  await cmd(`fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} ${block}`).catch(() => {});
}

export async function releasePlot(rect) { if (rect) await releaseBox(rect.minX, rect.minZ, rect.maxX, rect.maxZ); }
