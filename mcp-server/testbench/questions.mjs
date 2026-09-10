// Category A question set — spatial cognition over the walk transcript.
//
// The questions and their truths are now DERIVED from the seeded arena (arena.mjs) rather than
// written out as literals. What stays here is the part that cannot be computed offline: the LIVE
// verification that the world actually matches the answer key before any of it is billed to a model.
// A bench whose answer key is wrong measures nothing, and staging can fail quietly (a fill that
// clipped a wall, an anomaly that never got placed), so every seed re-checks its own key:
//
//   - a10/a11 reachability against the real pathfinder (the pen must be reachable, the sealed box
//     must not) — these are the only two truths the generator asserts by construction and cannot
//     prove, since they depend on the staged geometry rather than the spec,
//   - the anomaly block is really in the world at the coordinates a1 asks about.

import { call } from "./bridge.mjs";

/**
 * @param {object} arena  from makeArena(seed)
 * @returns the arena's questions, after live verification of the staged world
 */
export async function generateCatA(arena, { log = console.log } = {}) {
  const o = arena.origin;
  const A = (dx, dz, dy = 0) => ({ x: o.x + dx, y: o.y + dy, z: o.z + dz });

  // Stand on the north lip beside the bridge — the vantage both reachability questions name.
  const from = A(arena.bridge.xMin + 1, arena.channel.zMin - 2, 1);
  const pen = arena.pen;
  const penCentre = A(Math.floor((pen.xMin + pen.xMax) / 2), Math.floor((pen.zMin + pen.zMax) / 2), 1);
  // y+2: the sealed box is a full hollow shell, so its own glass bottom face occupies y+1 — the
  // target must be the air above it, or "unreachable" would be trivially true of a solid block.
  const s = arena.sealed;
  const sealedCentre = A(s.xMin + Math.floor(s.size / 2), s.zMin + Math.floor(s.size / 2), 2);

  const penPath = await call("check_path", { from, to: penCentre });
  const sealedPath = await call("check_path", { from, to: sealedCentre });
  if (penPath.reachable !== true) {
    throw new Error(`bench invariant (seed ${arena.seed}): pen must be reachable through its ${pen.gate} gate, got ${JSON.stringify(penPath)}`);
  }
  if (sealedPath.reachable !== false) {
    throw new Error(`bench invariant (seed ${arena.seed}): sealed box must be unreachable, got ${JSON.stringify(sealedPath)}`);
  }

  // Staging sanity: the answer key's anomaly block must actually be in the world.
  const got = await call("get_blocks_at", { blocks: [A(arena.anomaly.x, arena.anomaly.z, 0)] });
  const id = got.palette[got.blocks[0][3]];
  if (id !== arena.anomaly.block) {
    throw new Error(`bench invariant (seed ${arena.seed}): anomaly marker missing — expected ${arena.anomaly.block}, world has ${id}`);
  }
  log(`  live truths verified (seed ${arena.seed}): pen reachable via ${pen.gate}, sealed box not, ${arena.anomaly.block} present`);

  return arena.questions;
}
