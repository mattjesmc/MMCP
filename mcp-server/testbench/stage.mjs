// Stage a bench arena (arena.mjs) into the dev world. Deterministic overwrite — restaging the same
// arena rebuilds it identically. Forceloads while working, releases after; ~1-2s of fill commands.
//
// Takes the arena SPEC rather than reading module-level constants, so each seed stages its own
// arena. Everything placed here is derived from that spec; nothing is hardcoded.

import { cmd, call } from "./bridge.mjs";

export async function stageArena(arena, { log = console.log } = {}) {
  const o = arena.origin;
  const S = arena.size;
  const max = { x: o.x + S - 1, z: o.z + S - 1 };
  const A = (dx, dz) => ({ x: o.x + dx, z: o.z + dz });
  log(`staging arena seed ${arena.seed} at (${o.x}, ${o.z})..(${max.x}, ${max.z})`);
  await cmd(`forceload add ${o.x - 16} ${o.z - 16} ${max.x + 16} ${max.z + 16}`);

  // Underlayment + floor + cleared air above (fill limit 32768: 140×140=19600 per layer). The
  // underlayment matters: the platform floats over natural terrain, and the carved fluids would
  // otherwise fall straight through their basins.
  await cmd(`fill ${o.x} ${o.y - 1} ${o.z} ${max.x} ${o.y - 1} ${max.z} minecraft:stone`);
  await cmd(`fill ${o.x} ${o.y} ${o.z} ${max.x} ${o.y} ${max.z} minecraft:stone`);
  for (let y = 1; y <= 8; y++) {
    await cmd(`fill ${o.x} ${o.y + y} ${o.z} ${max.x} ${o.y + y} ${max.z} minecraft:air`);
  }

  // Towers — seeded count, colours and positions.
  for (const t of arena.towers) {
    const p = A(t.x, t.z);
    await cmd(`fill ${p.x} ${o.y + 1} ${p.z} ${p.x} ${o.y + arena.towerHeight} ${p.z} ${t.block}`);
  }

  // Channel (carved one deep, stone rim left at both ends so nothing pours off the edge), then the
  // bridge over it. The channel's liquid is seeded; the pool always carries the OTHER one, so
  // "the lava pool" / "the water pool" names a unique feature either way.
  const ch = arena.channel;
  await cmd(`fill ${o.x + ch.xMin} ${o.y} ${o.z + ch.zMin} ${o.x + ch.xMax} ${o.y} ${o.z + ch.zMax} minecraft:${ch.liquid}`);
  await cmd(`fill ${o.x + arena.bridge.xMin} ${o.y} ${o.z + ch.zMin} ${o.x + arena.bridge.xMax} ${o.y} ${o.z + ch.zMax} minecraft:stone`);

  // Liquid pool.
  const pool = arena.pool;
  await cmd(`fill ${o.x + pool.xMin} ${o.y} ${o.z + pool.zMin} ${o.x + pool.xMax} ${o.y} ${o.z + pool.zMax} minecraft:${pool.liquid}`);

  // Glass house: hollow glass box, one-block door gap mid-south at floor+1.
  const h = arena.house;
  await cmd(`fill ${o.x + h.xMin} ${o.y + 1} ${o.z + h.zMin} ${o.x + h.xMax} ${o.y + h.height} ${o.z + h.zMax} minecraft:glass hollow`);
  const doorX = o.x + h.xMin + Math.floor(h.size / 2);
  await cmd(`fill ${doorX} ${o.y + 1} ${o.z + h.zMax} ${doorX} ${o.y + 2} ${o.z + h.zMax} minecraft:air`);

  // Sealed glass box — no opening; its interior is the unreachable target (a11).
  const s = arena.sealed;
  await cmd(`fill ${o.x + s.xMin} ${o.y + 1} ${o.z + s.zMin} ${o.x + s.xMax} ${o.y + s.height} ${o.z + s.zMax} minecraft:glass hollow`);

  // Walled pen with a seeded gate side. Four explicit walls, NOT `fill hollow` — hollow closes the
  // top and bottom faces too, which put a stone ceiling on the pen and a slab under the gate (found
  // by the bench's own live invariant check: the pathfinder refused the "reachable" pen).
  const p = arena.pen;
  const py = `${o.y + 1}`, pyTop = `${o.y + p.wallH}`;
  await cmd(`fill ${o.x + p.xMin} ${py} ${o.z + p.zMin} ${o.x + p.xMax} ${pyTop} ${o.z + p.zMin} minecraft:stone_bricks`);
  await cmd(`fill ${o.x + p.xMin} ${py} ${o.z + p.zMax} ${o.x + p.xMax} ${pyTop} ${o.z + p.zMax} minecraft:stone_bricks`);
  await cmd(`fill ${o.x + p.xMin} ${py} ${o.z + p.zMin} ${o.x + p.xMin} ${pyTop} ${o.z + p.zMax} minecraft:stone_bricks`);
  await cmd(`fill ${o.x + p.xMax} ${py} ${o.z + p.zMin} ${o.x + p.xMax} ${pyTop} ${o.z + p.zMax} minecraft:stone_bricks`);
  const midX = o.x + Math.floor((p.xMin + p.xMax) / 2);
  const midZ = o.z + Math.floor((p.zMin + p.zMax) / 2);
  const gate = {
    east: [o.x + p.xMax, midZ - 1, o.x + p.xMax, midZ + 1],
    west: [o.x + p.xMin, midZ - 1, o.x + p.xMin, midZ + 1],
    north: [midX - 1, o.z + p.zMin, midX + 1, o.z + p.zMin],
    south: [midX - 1, o.z + p.zMax, midX + 1, o.z + p.zMax],
  }[p.gate];
  await cmd(`fill ${gate[0]} ${o.y + 1} ${gate[1]} ${gate[2]} ${o.y + 2} ${gate[3]} minecraft:air`);

  // Point-query anomaly (a1) — seeded block, seeded position.
  await call("set_blocks", { blocks: [{ ...A(arena.anomaly.x, arena.anomaly.z), y: o.y, block: arena.anomaly.block }] });

  // Cat B pixel-art patch — seeded colours.
  const blocks = [];
  for (let row = 0; row < arena.patch.size; row++) {
    for (let col = 0; col < arena.patch.size; col++) {
      blocks.push({
        x: o.x + arena.patch.xMin + col, y: o.y, z: o.z + arena.patch.zMin + row,
        block: arena.patch.blockAt(col, row),
      });
    }
  }
  await call("set_blocks", { blocks });

  await cmd(`forceload remove ${o.x - 16} ${o.z - 16} ${max.x + 16} ${max.z + 16}`);
  log("arena staged");
}
