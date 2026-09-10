// Deterministic stage construction via privileged run_command (harness-side only — the agent never
// builds). Floating platforms at y=200 keep worldgen out of the experiment entirely. Every setup is
// idempotent: it force-loads its rectangle, clears its own footprints, and rebuilds — so re-running
// setup restores a variant's stage exactly (this is what makes Track 2 forks and paired variants safe).

import { cmd } from "../bridge.mjs";

export const Y = 200;

/**
 * Chunk-ticket the working rectangle so "memory failure" is never drone/chunk unload.
 *
 * Vanilla caps ONE `forceload add` at 256 chunks and reports the overflow in the command's OUTPUT —
 * `run_command` still returns ok, so an over-large rectangle used to no-op in silence. That is
 * exactly what it did to interrogation-multi (368 chunks): every run ranged an unticketed area, the
 * drone despawned on its first bot_goto, and the agent burned its turn budget polling a dead drone.
 * So: issue the rectangle in ≤256-chunk strips, then VERIFY rather than trust.
 */
export async function forceload(x1, z1, x2, z2) {
  const bx1 = Math.min(x1, x2), bz1 = Math.min(z1, z2);
  const bx2 = Math.max(x1, x2), bz2 = Math.max(z1, z2);
  const cx1 = Math.floor(bx1 / 16), cx2 = Math.floor(bx2 / 16);
  const cz1 = Math.floor(bz1 / 16), cz2 = Math.floor(bz2 / 16);

  const wide = cx2 - cx1 + 1;
  if (wide > 256) throw new Error(`forceload: ${wide} chunks wide exceeds the per-command limit even as one strip`);
  const rows = Math.max(1, Math.floor(256 / wide)); // chunk-rows per command

  for (let cz = cz1; cz <= cz2; cz += rows) {
    const czEnd = Math.min(cz2, cz + rows - 1);
    await cmd(`forceload add ${cx1 * 16} ${cz * 16} ${cx2 * 16 + 15} ${czEnd * 16 + 15}`);
  }

  const q = await cmd("forceload query");
  const txt = (q.output ?? []).join(" ");
  if (/No force loaded chunks/i.test(txt)) {
    throw new Error(`forceload verify FAILED for (${bx1},${bz1})-(${bx2},${bz2}) — staging would run unticketed: ${txt}`);
  }
}

export async function unforceload(x1, z1, x2, z2) {
  await cmd(`forceload remove ${Math.min(x1, x2)} ${Math.min(z1, z2)} ${Math.max(x1, x2)} ${Math.max(z1, z2)}`);
}

export async function lockConditions() {
  await cmd("time set day");
  await cmd("weather clear");
}

/** Clear a footprint (small volumes only — stay under the fill limit). */
export async function clear(x1, y1, z1, x2, y2, z2) {
  await cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} minecraft:air`);
}

/** Square platform centered on (x,z) at Y, half-width h; clears the air above it. */
export async function platform(x, z, h = 2, block = "minecraft:stone") {
  await clear(x - h, Y, z - h, x + h, Y + 6, z + h);
  await cmd(`fill ${x - h} ${Y} ${z - h} ${x + h} ${Y} ${z + h} ${block}`);
}

/** Chest at (x, Y+1, z) stocked via `item replace` (avoids version-specific NBT syntax). */
export async function chest(x, z, item, count) {
  await cmd(`setblock ${x} ${Y + 1} ${z} minecraft:chest`);
  if (item) await cmd(`item replace block ${x} ${Y + 1} ${z} container.0 with ${item} ${count}`);
}

/** A flat cluster of n blocks on the platform at (x,z) — countable from a surface map. */
export async function cluster(x, z, block, n) {
  const offsets = [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [-1, -1], [1, -1], [-1, 1]];
  for (let i = 0; i < n && i < offsets.length; i++) {
    await cmd(`setblock ${x + offsets[i][0]} ${Y + 1} ${z + offsets[i][1]} ${block}`);
  }
}

/** A 1x1 tower of `h` blocks on the platform at (x,z) — height readable as topY - Y. */
export async function tower(x, z, block, h) {
  await cmd(`fill ${x} ${Y + 1} ${z} ${x} ${Y + h} ${z} ${block}`);
}

/** A 2-wide plank walkway from (x1,z) to (x2,z) at Y (a "bridge" between platforms). */
export async function walkway(x1, x2, z, block = "minecraft:oak_planks") {
  await cmd(`fill ${Math.min(x1, x2)} ${Y} ${z} ${Math.max(x1, x2)} ${Y} ${z + 1} ${block}`);
}
