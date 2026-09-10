// Shared server-truth readers for the build/redstone/objective slices. Thin wrappers over the
// testbench bridge (call get_blocks_at / get_entities); all SCORING math lives in the pure cores
// (build-score / redstone-score / progress-score) so these are the only server-touching lines and
// stay trivially correct. get_blocks_at caps at 256 positions per call (POINT_MAX), so captureRegion
// batches; the palette carries id[state] strings (verified: redstone_lamp[lit=true]).

import { call } from "./bridge.mjs";

const BATCH = 256;

/** Every integer cell in the inclusive box [min..max]. */
export function cellsInBox(min, max) {
  const cells = [];
  for (let x = min.x; x <= max.x; x++)
    for (let y = min.y; y <= max.y; y++)
      for (let z = min.z; z <= max.z; z++) cells.push({ x, y, z });
  return cells;
}

/**
 * Read a region into a block map keyed "x,y,z" → id[state] string. Batches get_blocks_at over all
 * cells (256/call). Unread cells (paletteIndex -1) are recorded as "minecraft:air" (treated as
 * unoccupied by build-score) with a separate `unread` count so a truncated read is visible, never
 * silently scored as empty.
 */
export async function captureRegion(min, max) {
  const cells = cellsInBox(min, max);
  const map = {};
  let unread = 0;
  for (let i = 0; i < cells.length; i += BATCH) {
    const chunk = cells.slice(i, i + BATCH);
    const res = await call("get_blocks_at", { blocks: chunk }).catch(() => null);
    const palette = res?.palette ?? [];
    for (const row of res?.blocks ?? []) {
      const [x, y, z, idx] = row;
      if (idx < 0) { unread++; map[`${x},${y},${z}`] = "minecraft:air"; continue; }
      map[`${x},${y},${z}`] = palette[idx];
    }
  }
  return { map, cells: cells.length, unread };
}

/** Read one block's id[state] string (or null if unread). */
export async function readBlock(pos) {
  const res = await call("get_blocks_at", { blocks: [pos] }).catch(() => null);
  const idx = res?.blocks?.[0]?.[3];
  return idx != null && idx >= 0 ? res.palette[idx] : null;
}

/** True if the block at pos is currently "lit"/"powered"/"on" (reads the blockstate prop). Returns
 *  null if the block couldn't be read — the caller scores a null observation as wrong (never as off). */
export async function readLit(pos) {
  const id = await readBlock(pos);
  if (id == null) return null;
  const m = /\[(.*)\]/.exec(id);
  if (!m) return false; // no props ⇒ not a lit state
  const props = Object.fromEntries(m[1].split(",").map((kv) => kv.split("=")));
  if ("lit" in props) return props.lit === "true";
  if ("powered" in props) return props.powered === "true";
  if ("power" in props) return Number(props.power) > 0;
  return false;
}
