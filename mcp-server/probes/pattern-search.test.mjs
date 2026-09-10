// Pattern search probes — locate's third direction (PATTERN_SEARCH_DESIGN.md).
//
// What this suite is actually defending:
//   1. MATCHES ARE REAL AND DEDUPED. "Two golds adjacent" finds the one staged pair — once, not
//      once per node labeling — and never a decoy single. "Entity above a gold" finds the gold
//      with the zombie ON it, not the one with a zombie BESIDE it.
//   2. SETS RE-READ THE WORLD. `as` stores a result set; mining a member and reusing the set
//      drops it (`stale_dropped`), because a stored cell is never trusted from the record —
//      the ledger's don't-build clause (no world mirror) enforced at the seam it would rot at.
//   3. NEGATIVES COMPOSE HONESTLY. A miss over a fully-read extent is proof; an unread extent
//      yields a null matches_total and negative_is_proof:false with the cause named. Set
//      provenance (`search.scope`) travels with every chained search.
//   4. VALIDATION REFUSES THE DEGENERATE. Disconnected patterns (cross products), unknown node
//      ids, entity-anchored `as`, and mixed directions all fail loudly, never half-run.
//
// Fixture: a stone platform far from every other probe sandbox (3.36M), forceloaded, with a
// staged gold-block configuration + two NoAI zombies. Everything reverted after.
//
// Run: npm run test:live (needs the dev server).

import { test, before, after } from "node:test";
import assert from "node:assert";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
// Own session identity: probe files run CONCURRENTLY and the locate ledger (anchors AND result
// sets) is per-session — locate.test.mjs clears the anonymous ledger mid-run. The bridge adopts
// unknown ids on first sight, so a constant header suffices.
const SESSION = "probe-pattern-search";
async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const cmd = (c) => call("run_command", { command: c });

const CX = 3_360_000;
const CZ = 3_360_000;
const Y = 300;
const NEAR = { x: CX, z: CZ };
const PLAT = 32;
const LOAD = 80;
const GOLD = "minecraft:gold_block";
// The staged configuration. PAIR_A/PAIR_B are the only adjacent golds; MOB_GOLD is the only one
// with an entity standing on it; BESIDE_GOLD has its zombie on the platform NEXT to it (the
// decoy that catches "above" implemented as "near").
const PAIR_A = { x: CX - 10, y: Y + 1, z: CZ };
const PAIR_B = { x: CX - 9, y: Y + 1, z: CZ };
const SINGLE_1 = { x: CX + 8, y: Y + 1, z: CZ + 5 };
const SINGLE_2 = { x: CX, y: Y + 1, z: CZ - 12 };
const MOB_GOLD = { x: CX + 15, y: Y + 1, z: CZ + 10 };
const BESIDE_GOLD = { x: CX - 15, y: Y + 1, z: CZ + 10 };
const ALL_GOLDS = [PAIR_A, PAIR_B, SINGLE_1, SINGLE_2, MOB_GOLD, BESIDE_GOLD];
// Two DIFFERENT members of #minecraft:logs: a tag match must find both, and each referent must be
// named from the cell that matched rather than from the matcher (a tag has no single id).
const OAK = { x: CX + 20, y: Y + 1, z: CZ - 20 };
const BIRCH = { x: CX + 22, y: Y + 1, z: CZ - 20 };
// The ranking fixture: one emerald 2 blocks away horizontally at platform height, one directly
// below the centre but 31 blocks down. Which is "nearest" depends on whether the observer's y is
// real — that is exactly the rule under test, so the two must disagree.
const EM_NEAR = { x: CX + 2, y: Y + 1, z: CZ };
const EM_DEEP = { x: CX, y: Y - 30, z: CZ };
const EM = "minecraft:emerald_block";
// Bounds every scan of the extra fixtures to the platform slab: the default scan is full world
// height, and natural terrain far below would otherwise put real logs in the tag counts.
const SLAB = { min: Y - 40, max: Y + 10 };
const NBT = "{NoAI:1b,PersistenceRequired:1b,Invulnerable:1b}";
const BOX = `x=${CX - LOAD},y=-64,z=${CZ - LOAD},dx=${2 * LOAD},dy=448,dz=${2 * LOAD}`;
const undoIds = [];

const cellEq = (p, c) => p.x === c.x && p.y === c.y && p.z === c.z;

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server first");
  await cmd(`forceload add ${CX - LOAD} ${CZ - LOAD} ${CX + LOAD} ${CZ + LOAD}`);
  const t0 = Date.now();
  for (;;) {
    const r = await call("get_blocks_at", { blocks: [{ x: CX, y: Y, z: CZ }] });
    if (r.ok && r.result.coverage?.state === "complete") break;
    if (Date.now() - t0 > 120_000) throw new Error("fixture chunks not generated in 120s");
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  const plat = await call("place_shape", {
    shape: "box", block: "minecraft:stone", mode: "solid",
    p1: { x: CX - PLAT, y: Y, z: CZ - PLAT },
    p2: { x: CX + PLAT, y: Y, z: CZ + PLAT },
  });
  assert.equal(plat.ok, true, `platform: ${JSON.stringify(plat)}`);
  if (plat.result.undo_id) undoIds.push(plat.result.undo_id);
  const golds = await call("set_blocks", {
    blocks: ALL_GOLDS.map((p) => ({ ...p, block: GOLD })),
  });
  assert.equal(golds.ok, true, `golds: ${JSON.stringify(golds)}`);
  if (golds.result.undo_id) undoIds.push(golds.result.undo_id);
  const extras = await call("set_blocks", {
    blocks: [
      { ...OAK, block: "minecraft:oak_log" },
      { ...BIRCH, block: "minecraft:birch_log" },
      { ...EM_NEAR, block: EM },
      { ...EM_DEEP, block: EM },
    ],
  });
  assert.equal(extras.ok, true, `extras: ${JSON.stringify(extras)}`);
  if (extras.result.undo_id) undoIds.push(extras.result.undo_id);
  await cmd(`kill @e[type=minecraft:zombie,${BOX}]`).catch(() => {});
  // One zombie ON the mob gold (feet cell = gold + 1), one on the platform BESIDE the other.
  await cmd(`summon minecraft:zombie ${MOB_GOLD.x + 0.5} ${Y + 2} ${MOB_GOLD.z + 0.5} ${NBT}`);
  await cmd(`summon minecraft:zombie ${BESIDE_GOLD.x + 1.5} ${Y + 1} ${BESIDE_GOLD.z + 0.5} ${NBT}`);
  await call("anchors", { clear: true });
});

after(async () => {
  await cmd(`kill @e[type=minecraft:zombie,${BOX}]`).catch(() => {});
  for (const id of undoIds.reverse()) await call("undo_edit", { undo_id: id }).catch(() => {});
  await cmd(`forceload remove ${CX - LOAD} ${CZ - LOAD} ${CX + LOAD} ${CZ + LOAD}`).catch(() => {});
});

test("pattern: two adjacent golds — the staged pair, once, and no decoy single", async () => {
  const r = await call("locate", {
    pattern: {
      nodes: [{ id: "a", block: GOLD }, { id: "b", block: GOLD }],
      relations: [{ rel: "adjacent", of: ["a", "b"] }],
    },
    near: NEAR,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.search.mechanism, "pattern_scan");
  assert.equal(r.result.matches_total, 1,
    `exactly the staged pair, deduped across labelings: ${JSON.stringify(r.result)}`);
  const cells = Object.values(r.result.found[0].bindings).map((b) => b.pos);
  assert.ok(cells.some((c) => cellEq(PAIR_A, c)) && cells.some((c) => cellEq(PAIR_B, c)),
    `bindings must be the staged pair: ${JSON.stringify(cells)}`);
  assert.equal(r.result.perception_mode, "spatial");
  assert.equal(typeof r.result.search.ms, "number", "cost is reported, never hidden");
});

test("pattern: entity ABOVE a gold means standing on it — the beside-zombie decoy must not match", async () => {
  const r = await call("locate", {
    pattern: {
      nodes: [{ id: "g", block: GOLD }, { id: "e", entity: "minecraft:zombie" }],
      relations: [{ rel: "above", of: ["e", "g"] }],
      anchor: "g",
    },
    near: NEAR,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.matches_total, 1, JSON.stringify(r.result));
  const f = r.result.found[0];
  assert.ok(cellEq(MOB_GOLD, f.pos), `must anchor the mob gold: ${JSON.stringify(f.pos)}`);
  assert.equal(f.bindings.e.type, "minecraft:zombie");
  assert.ok(cellEq({ x: MOB_GOLD.x, y: MOB_GOLD.y + 1, z: MOB_GOLD.z }, f.bindings.e.pos),
    "the entity's cell is directly above the gold");
});

test("pattern: one node, no relations = find this block; `as` stores the result set", async () => {
  const r = await call("locate", {
    pattern: { nodes: [{ id: "g", block: GOLD }] },
    near: NEAR,
    as: "golds",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.matches_total, ALL_GOLDS.length,
    `all staged golds, exactly: ${JSON.stringify(r.result)}`);
  assert.equal(r.result.search.negative_is_proof, true,
    `fully forceloaded extent must be a proof: ${JSON.stringify(r.result.search)}`);
  assert.equal(r.result.set.name, "golds");
  assert.equal(r.result.set.members, ALL_GOLDS.length);
  assert.equal(r.result.set.fully_read, true);
  assert.equal(r.result.set.truncated, false);
  // Referents are bounded by `limit`; the set holds every anchor cell regardless.
  assert.ok(r.result.found.length <= 8);
  assert.match(r.result.found[0].handle, /^golds@-?\d+,-?\d+,-?\d+$/,
    "`as` names the first find, like every other locate direction");
});

test("pattern: a #tag block node matches every member, and each referent is named from its cell", async () => {
  // The disjunctive question ("any log") had no door at all before 0.29.0: `what` refused bare
  // tags and the node matcher was parsed by the WRITE parser, which rejects them
  // (LOCATE_ROUTES.md B1).
  const r = await call("locate", {
    pattern: { nodes: [{ id: "l", block: "#minecraft:logs" }] },
    near: NEAR, y_range: SLAB, limit: 8,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.search.mechanism, "pattern_scan");
  assert.equal(r.result.matches_total, 2, `both staged logs: ${JSON.stringify(r.result.found)}`);
  const ids = r.result.found.map((f) => f.id).sort();
  assert.deepEqual(ids, ["minecraft:birch_log", "minecraft:oak_log"],
    "a tag has no single id — each referent must be named from the block actually there");
  assert.equal(r.result.search.negative_is_proof, true,
    `a fully-read tag scan is still a proof: ${JSON.stringify(r.result.search)}`);

  // Same door through `what`, which is how models actually reach for it.
  const promoted = await call("locate", {
    what: "#minecraft:logs", near: NEAR, y_range: SLAB, limit: 8,
  });
  assert.equal(promoted.ok, true, JSON.stringify(promoted));
  assert.equal(promoted.result.search.mechanism, "pattern_scan");
  assert.ok(promoted.result.search.promoted, "a block `what` must stay stamped as a scan");
  assert.equal(promoted.result.matches_total, 2);

  // A state qualifier still applies on top of the tag, same as an exact matcher.
  const axisY = await call("locate", {
    pattern: { nodes: [{ id: "l", block: "#minecraft:logs[axis=y]" }] },
    near: NEAR, y_range: SLAB, limit: 8,
  });
  assert.equal(axisY.ok, true, JSON.stringify(axisY));
  assert.equal(axisY.result.matches_total, 2, "both staged logs are placed axis=y");
});

test("pattern: matches are reported NEAREST FIRST, 3D only when the observer's y is real", async () => {
  // Enumeration order is the chunk sweep from the −x/−z corner, bottom-up. Reporting it raw
  // answered "where is the nearest X" with the corner-most, deepest X (LOCATE_ROUTES.md C1).
  const golds = await call("locate", {
    pattern: { nodes: [{ id: "g", block: GOLD }] },
    near: { x: SINGLE_2.x, z: SINGLE_2.z }, y_range: SLAB, limit: 3,
  });
  assert.equal(golds.ok, true, JSON.stringify(golds));
  const dist2 = (p, c) => (p.x - c.x) ** 2 + (p.z - c.z) ** 2;
  const expected = [...ALL_GOLDS]
    .sort((p, q) => dist2(p, SINGLE_2) - dist2(q, SINGLE_2))
    .slice(0, 3);
  assert.deepEqual(golds.result.found.map((f) => f.pos), expected.map((p) => ({ ...p })),
    `nearest first, then the limit cut: ${JSON.stringify(golds.result.found.map((f) => f.pos))}`);
  assert.match(String(golds.result.note), /NEAREST/,
    "the payload must say the reported few are the nearest, not the first found");

  // y assumed (no `y` in `near`): ranking is horizontal, so the block straight down wins.
  const flat = await call("locate", {
    what: EM, near: { x: CX, z: CZ }, y_range: SLAB, limit: 2,
  });
  assert.equal(flat.ok, true, JSON.stringify(flat));
  assert.equal(flat.result.matches_total, 2);
  assert.deepEqual(flat.result.found[0].pos, { ...EM_DEEP },
    "with an assumed y, ranking must stay horizontal — the deep block is 0 blocks away on the map");

  // y stated: ranking is 3D, so 31 blocks down loses to 2 blocks sideways.
  const solid = await call("locate", {
    what: EM, near: { x: CX, y: Y + 1, z: CZ }, y_range: SLAB, limit: 2,
  });
  assert.equal(solid.ok, true, JSON.stringify(solid));
  assert.deepEqual(solid.result.found[0].pos, { ...EM_NEAR },
    "with a real y, the vertical counts — 31 blocks down is not 'nearest'");
});

test("pattern: a set node refines WITHOUT restating the extent, and scope travels", async () => {
  const r = await call("locate", {
    pattern: {
      nodes: [{ id: "g", set: "golds" }, { id: "e", entity: "minecraft:zombie" }],
      relations: [{ rel: "above", of: ["e", "g"] }],
      anchor: "g",
    },
    // Deliberately no `near`: the scan extent derives from the set's members.
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.matches_total, 1, JSON.stringify(r.result));
  assert.ok(cellEq(MOB_GOLD, r.result.found[0].pos));
  const scope = r.result.search.scope;
  assert.ok(Array.isArray(scope) && scope[0].set === "golds",
    `set provenance must ride the search record: ${JSON.stringify(r.result.search)}`);
  assert.equal(typeof scope[0].created_tick, "number");
  assert.ok(scope[0].created_extent, "a chained negative must stay scoped to the set's origin");
});

test("pattern: sets re-read the world — a mined member drops as stale_dropped", async () => {
  const mined = await call("set_blocks", { blocks: [{ ...SINGLE_1, block: "minecraft:air" }] });
  assert.equal(mined.ok, true);
  try {
    const r = await call("locate", {
      pattern: { nodes: [{ id: "g", set: "golds" }] },
      near: NEAR,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.search.stale_dropped, 1,
      `the mined member must drop, counted: ${JSON.stringify(r.result.search)}`);
    assert.equal(r.result.matches_total, ALL_GOLDS.length - 1,
      "matching runs over the verified members only");
  } finally {
    const back = await call("set_blocks", { blocks: [{ ...SINGLE_1, block: GOLD }] });
    assert.equal(back.ok, true);
  }
});

test("pattern honesty: a miss over a fully-read extent is proof; an unread extent proves nothing", async () => {
  const miss = await call("locate", {
    pattern: {
      nodes: [{ id: "a", block: "minecraft:diamond_block" }, { id: "b", block: "minecraft:diamond_block" }],
      relations: [{ rel: "adjacent", of: ["a", "b"] }],
    },
    near: NEAR,
  });
  assert.equal(miss.ok, true, JSON.stringify(miss));
  assert.equal(miss.result.matches_total, 0);
  assert.equal(miss.result.search.negative_is_proof, true, JSON.stringify(miss.result.search));
  assert.match(String(miss.result.note), /real negative/i);

  const unread = await call("locate", {
    pattern: { nodes: [{ id: "g", block: GOLD }] },
    near: { x: 9_200_000, z: 9_200_000 },
    load: false,
  });
  assert.equal(unread.ok, true, JSON.stringify(unread));
  assert.equal(unread.result.matches_total, null,
    "an unread scan yields a NULL verdict, never a confident 0");
  assert.equal(unread.result.search.negative_is_proof, false);
  assert.match(String(unread.result.note), /NOTHING WAS READ/i);
  assert.match(String(unread.result.note), /not evidence of absence/i);
});

test("pattern validation: degenerate patterns fail loudly, never half-run", async () => {
  const disconnected = await call("locate", {
    pattern: { nodes: [{ id: "a", block: GOLD }, { id: "b", block: GOLD }] },
    near: NEAR,
  });
  assert.equal(disconnected.ok, false, "two unrelated nodes are a cross product");
  assert.match(String(disconnected.error), /disconnected/i);

  const unknownNode = await call("locate", {
    pattern: {
      nodes: [{ id: "a", block: GOLD }],
      relations: [{ rel: "adjacent", of: ["a", "ghost"] }],
    },
    near: NEAR,
  });
  assert.equal(unknownNode.ok, false);
  assert.match(String(unknownNode.error), /unknown node/i);

  const entityAs = await call("locate", {
    pattern: {
      nodes: [{ id: "e", entity: "minecraft:zombie" }, { id: "g", block: GOLD }],
      relations: [{ rel: "above", of: ["e", "g"] }],
      anchor: "e",
    },
    near: NEAR,
    as: "zombies",
  });
  assert.equal(entityAs.ok, false, "entity results are volatile anchors, never sets");
  assert.match(String(entityAs.error), /entity node/i);

  const both = await call("locate", { what: "minecraft:zombie", pattern: { nodes: [{ id: "g", block: GOLD }] }, near: NEAR });
  assert.equal(both.ok, false);
  assert.match(String(both.error), /exactly one/i);

  const unknownSet = await call("locate", {
    pattern: { nodes: [{ id: "g", set: "never_stored" }] },
    near: NEAR,
  });
  assert.equal(unknownSet.ok, false);
  assert.match(String(unknownSet.error), /no result set/i);

});

test("what: a block id PROMOTES to a one-node pattern scan (0.19.0 — the bench-observed miss, closed)", async () => {
  // The 75-turn bench session asked `what:"minecraft:gold_block"` and was refused; the right
  // instinct now just works, honestly stamped as the scan it is.
  const r = await call("locate", { what: GOLD, near: NEAR, radius: 32 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.search.mechanism, "pattern_scan",
    "a promoted block search must carry the scan's own honesty contract, not an index's");
  assert.equal(r.result.matches_total, ALL_GOLDS.length, JSON.stringify(r.result.search));
  assert.match(String(r.result.search.promoted), /pattern/i, "the promotion is disclosed");
  assert.equal(r.result.search.negative_is_proof, true);
  // A nonsense id still fails, and the error names every registry tried — including blocks.
  const bad = await call("locate", { what: "minecraft:definitely_not_a_thing", near: NEAR });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /block/i);
});

test("anchors show: a set reads OUT — paged, re-verified, and honest about completeness (C2)", async () => {
  // LOCATE_ROUTES.md C2: a scan storing 72 members reported 8 referents and printed only the member
  // COUNT, so "list every X" had no route even though the tool had already found every X. The
  // fixture is deliberately bigger than one page (72 > 64) and made of iron, so the gold/log/emerald
  // counts the other tests assert stay untouched.
  const IRON = "minecraft:iron_block";
  const IRON_MIN = { x: CX - 20, y: Y + 3, z: CZ + 16 };
  const IRON_MAX = { x: CX - 13, y: Y + 3, z: CZ + 24 };
  const IRON_N = 8 * 9;
  const slab = await call("place_shape", {
    shape: "box", block: IRON, mode: "solid",
    p1: IRON_MIN, p2: IRON_MAX,
  });
  assert.equal(slab.ok, true, `iron slab: ${JSON.stringify(slab)}`);
  if (slab.result.undo_id) undoIds.push(slab.result.undo_id);

  const scan = await call("locate", {
    pattern: { nodes: [{ id: "i", block: IRON }] },
    near: NEAR, y_range: SLAB, as: "irons",
  });
  assert.equal(scan.ok, true, JSON.stringify(scan));
  assert.equal(scan.result.matches_total, IRON_N, `all staged iron: ${JSON.stringify(scan.result.search)}`);
  assert.equal(scan.result.set.members, IRON_N);
  assert.ok(scan.result.found.length <= 8, "the referent cap is unchanged — this is a second door");

  const page1 = await call("anchors", { show: "irons" });
  assert.equal(page1.ok, true, JSON.stringify(page1));
  const m = page1.result.set_members;
  assert.ok(m, `show must return the members: ${JSON.stringify(page1.result)}`);
  assert.equal(m.set, "irons");
  assert.equal(m.matcher, IRON);
  assert.equal(m.stored, IRON_N, "the whole set is stored, not just what one page shows");
  assert.equal(m.from, 0);
  assert.equal(m.shown, 64, "one page is bounded — it bounds the re-read, not just the text");
  assert.equal(m.rows.length, 64);
  assert.deepEqual(m.columns.slice(0, 3), ["x", "y", "z"]);
  for (const row of m.rows) {
    assert.equal(row.length, m.columns.length, `row/column mismatch: ${JSON.stringify(row)}`);
    assert.ok(row[0] >= IRON_MIN.x && row[0] <= IRON_MAX.x, `member outside the fixture: ${row}`);
    assert.equal(row[1], IRON_MIN.y);
  }
  assert.equal(m.next_from, 64, "the reply must say how to continue");
  assert.equal(m.complete_enumeration, false,
    "one page of 72 is not every member — saying so is the whole point");
  assert.match(String(m.note), /0\.\.63 of 72/, `the page window must be stated: ${m.note}`);
  assert.match(String(m.note), /from:64/);

  const page2 = await call("anchors", { show: "irons", from: 64 });
  const m2 = page2.result.set_members;
  assert.equal(m2.from, 64);
  assert.equal(m2.shown, IRON_N - 64);
  assert.equal(m2.next_from, undefined, "the last page has nothing to continue to");
  assert.equal(m2.complete_enumeration, false, "a tail page is still not the whole set");
  // Together the two pages are every stored member, with no repeats and no gaps.
  const seen = new Set([...m.rows, ...m2.rows].map((r) => `${r[0]},${r[1]},${r[2]}`));
  assert.equal(seen.size, IRON_N, "paging must partition the members exactly");

  // Members are re-tested, never recited: mine one and it comes back as `dropped`, not as a member.
  const mined = { x: IRON_MIN.x, y: IRON_MIN.y, z: IRON_MIN.z };
  const air = await call("set_blocks", { blocks: [{ ...mined, block: "minecraft:air" }] });
  assert.equal(air.ok, true, JSON.stringify(air));
  if (air.result.undo_id) undoIds.push(air.result.undo_id);
  const after1 = (await call("anchors", { show: "irons" })).result.set_members;
  const after2 = (await call("anchors", { show: "irons", from: 64 })).result.set_members;
  assert.equal(after1.stored, IRON_N, "the record is immutable — the set still says what it found");
  assert.equal(after1.shown + after2.shown, IRON_N - 1,
    "the mined cell is not a member of the world any more");
  const droppedCells = [...(after1.dropped ?? []), ...(after2.dropped ?? [])];
  assert.deepEqual(droppedCells, [[mined.x, mined.y, mined.z]],
    "a changed cell comes back as `dropped`, not as a member and not silently");
  assert.equal((after1.stale_dropped ?? 0) + (after2.stale_dropped ?? 0), 1);
  assert.match(String(after1.note), /re-tested/i);

  // The complete case, on a set that fits one page: the claim "these are all of them" is supportable
  // and the payload says so — the enumeration counterpart of negative_is_proof.
  const DIA = [
    { x: CX + 25, y: Y + 1, z: CZ - 25 },
    { x: CX + 26, y: Y + 1, z: CZ - 25 },
    { x: CX + 27, y: Y + 1, z: CZ - 25 },
  ];
  const dia = await call("set_blocks", {
    blocks: DIA.map((p) => ({ ...p, block: "minecraft:diamond_block" })),
  });
  assert.equal(dia.ok, true, JSON.stringify(dia));
  if (dia.result.undo_id) undoIds.push(dia.result.undo_id);
  const dscan = await call("locate", {
    pattern: { nodes: [{ id: "d", block: "minecraft:diamond_block" }] },
    near: NEAR, y_range: SLAB, as: "dias",
  });
  assert.equal(dscan.result.matches_total, DIA.length, JSON.stringify(dscan.result.search));
  const all = (await call("anchors", { show: "dias" })).result.set_members;
  assert.equal(all.shown, DIA.length);
  assert.equal(all.complete_enumeration, true,
    `a whole, fully-read, untruncated, re-verified set IS a complete list: ${JSON.stringify(all)}`);
  assert.deepEqual(
    all.rows.map((r) => ({ x: r[0], y: r[1], z: r[2] })).sort((p, q) => p.x - q.x),
    DIA,
    "every member, read out as a position");
  assert.match(String(all.note), /matched THEN/,
    "complete for THAT search — a block placed since is not a member");

  // The ledger read signposts the door, because a `members` count alone hides the contents.
  const led = await call("anchors", {});
  assert.match(String(led.result.note), /anchors show:/,
    "the count in the sets listing must point at the way to read them");

  // Refusals: an unknown set names what is stored; a negative offset is not silently clamped.
  const missing = await call("anchors", { show: "not_a_set" });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /irons/, "the error must name the sets that do exist");
  const negative = await call("anchors", { show: "irons", from: -1 });
  assert.equal(negative.ok, false);
  assert.match(String(negative.error), /from/);

  await call("anchors", { drop: "irons" });
  await call("anchors", { drop: "dias" });
});

test("cell properties: light, sky and the spawn-proofing negative (B5)", async () => {
  // LOCATE_ROUTES.md B5 — the pattern language could say where blocks are relative to each other and
  // nothing at all about light, which is the whole spawn-proofing class. Fixture: a sealed 3x3x2
  // stone room, so its interior is genuinely dark (block light 0, no sky) and its geometry is exact.
  const RX = CX - 25;
  const RZ = CZ - 25;
  const ROOM = { x: RX, z: RZ };
  const FLOOR = Y + 1;          // the hollow box's own floor
  const FEET = Y + 2;           // the only spawnable interior layer (head room above it is free)
  const HEAD = Y + 3;           // free, but the cell above IS the roof
  const YR = { min: FEET, max: HEAD };
  const shell = await call("place_shape", {
    shape: "box", block: "minecraft:stone", mode: "hollow",
    p1: { x: RX - 2, y: FLOOR, z: RZ - 2 },
    p2: { x: RX + 2, y: Y + 4, z: RZ + 2 },
  });
  assert.equal(shell.ok, true, `room: ${JSON.stringify(shell)}`);
  if (shell.result.undo_id) undoIds.push(shell.result.undo_id);
  // 5x5 columns x 2 levels = the whole swept volume; interior is 3x3 per level.
  const CELLS = 5 * 5 * 2;

  const spawn = async () => call("locate", {
    pattern: { nodes: [{ id: "s", spawnable: true }] },
    near: ROOM, radius: 2, y_range: YR,
  });
  const dark = await spawn();
  assert.equal(dark.ok, true, JSON.stringify(dark));
  assert.equal(dark.result.matches_total, 9,
    `only the FEET layer can hold a mob (the head layer's ceiling is the roof): ${JSON.stringify(dark.result.search)}`);
  assert.ok(dark.result.found.every((f) => f.pos.y === FEET),
    `every candidate is the feet cell: ${JSON.stringify(dark.result.found.map((f) => f.pos))}`);
  assert.equal(dark.result.search.negative_is_proof, true,
    `a forceloaded, fully-read, uncapped sweep is a proof: ${JSON.stringify(dark.result.search)}`);
  assert.equal(dark.result.search.cells_swept, CELLS,
    "a property-only node states how many cells it actually visited");
  assert.equal(dark.result.search.spawn_block_light_limit, 0,
    "the threshold is read out of the dimension, not remembered by the model");
  assert.match(String(dark.result.search.spawnable_means), /candidate/i);
  assert.match(String(dark.result.search.spawnable_means), /NEGATIVE/);
  assert.equal(dark.result.search.light_unknown_chunks, undefined,
    "no false alarm about uncomputed lighting on a forceloaded fixture");

  // Light and sky as their own predicates, on a matcher-ed node.
  const air = (extra) => call("locate", {
    pattern: { nodes: [{ id: "a", block: "minecraft:air", ...extra }] },
    near: ROOM, radius: 2, y_range: YR, limit: 8,
  });
  const unlit = await call("locate", {
    pattern: { nodes: [{ id: "a", block: "minecraft:air", light: { max: 0 } }] },
    near: ROOM, radius: 2, y_range: YR, limit: 8, as: "darkcells",
  });
  assert.equal(unlit.ok, true, JSON.stringify(unlit));
  assert.equal(unlit.result.matches_total, 18, "3x3 interior over both levels is pitch dark");
  assert.equal(unlit.result.set.members, 18, "a property-filtered node still stores its cells");
  // `sees_sky` reads the chunk HEIGHTMAP, which a fresh place_shape updates on a later tick — the
  // same lateness the torch assertion below already retries for. Queried immediately, the roof does
  // not exist yet and every interior cell still reports open sky (expected 18, got 0). This test had
  // never run live until 2026-08-01, so the race sat unseen since the property shipped in 0.31.0;
  // the feature itself is correct, verified by hand against a settled fixture.
  let roofed = null;
  for (let i = 0; i < 20; i++) {
    roofed = await air({ sees_sky: false });
    if (roofed.ok && roofed.result.matches_total === 18) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(roofed.result.matches_total, 18, "the roof blocks the sky over every interior cell");
  const open = await air({ sees_sky: true });
  assert.equal(open.result.matches_total, 0, "nothing inside a roofed room sees the sky");
  assert.match(String(unlit.result.search.what), /light<=0/,
    `the cell filter must be visible in the search record: ${unlit.result.search.what}`);

  // THE SPAWN-PROOFING CLAIM: put a torch in and the candidates go away.
  const torch = await call("set_blocks", {
    blocks: [{ x: RX, y: FEET, z: RZ, block: "minecraft:torch" }],
  });
  assert.equal(torch.ok, true, JSON.stringify(torch));
  if (torch.result.undo_id) undoIds.push(torch.result.undo_id);
  let lit = null;
  for (let i = 0; i < 20; i++) {          // the light engine settles on a later tick
    lit = await spawn();
    if (lit.ok && lit.result.matches_total === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(lit.result.matches_total, 0,
    `a torch lights every cell of a 3x3 room: ${JSON.stringify(lit.result.search)}`);
  assert.equal(lit.result.search.negative_is_proof, true,
    "this is the negative the task needs — it must be a PROOF, not a shrug");
  const stillDark = await air({ light: { max: 0 } });
  assert.equal(stillDark.result.matches_total, 0, "no dark cell is left in the room");

  // A set built with a cell property re-verifies THE WHOLE membership rule, property included:
  // re-checking these as merely "air cells" would hand back positions someone has since lit.
  const led = await call("anchors", {});
  const stored = (led.result.sets ?? []).find((s) => s.name === "darkcells");
  assert.ok(stored, `set missing from the ledger: ${JSON.stringify(led.result.sets)}`);
  assert.match(String(stored.matcher), /light<=0/,
    `the stored membership rule must show the property: ${stored.matcher}`);
  const readout = (await call("anchors", { show: "darkcells" })).result.set_members;
  assert.equal(readout.stored, 18, "the record still says what the scan found");
  assert.equal(readout.shown, 0, "not one member is dark any more");
  assert.equal(readout.stale_dropped, 18,
    `every member must drop on the property, not silently pass a block-only re-test: ${JSON.stringify(readout)}`);
  await call("anchors", { drop: "darkcells" });

  // Refusals: an unbounded property-only sweep, and light levels off the 0-15 scale.
  const unbounded = await call("locate", {
    pattern: { nodes: [{ id: "s", spawnable: true }] }, near: ROOM, radius: 32,
  });
  assert.equal(unbounded.ok, false, "a full-height property-only sweep must be refused, not cut short");
  assert.match(String(unbounded.error), /y_range/);
  assert.match(String(unbounded.error), /cell/i);
  for (const [node, pattern] of [
    [{ id: "a", block: "minecraft:air", light: { min: 20 } }, /0-15/],
    [{ id: "a", block: "minecraft:air", light: {} }, /min.*max|max.*min/],
    [{ id: "a", block: "minecraft:air", light: 3 }, /object/],
    [{ id: "a" }, /cell properties/],
  ]) {
    const bad = await call("locate", {
      pattern: { nodes: [node] }, near: ROOM, radius: 2, y_range: YR,
    });
    assert.equal(bad.ok, false, `must be refused: ${JSON.stringify(node)}`);
    assert.match(String(bad.error), pattern, `error text for ${JSON.stringify(node)}: ${bad.error}`);
  }
});

test("locate in: a region scopes a pattern scan — 'in MY BASE', not 'within r blocks'", async () => {
  // The pair of golds sits at CX-10/-9; the other four are 8-25 blocks away. A region around the
  // pair must answer about the pair and nothing else.
  const named = await call("locate", {
    at: [{ x: PAIR_A.x - 1, y: Y, z: PAIR_A.z - 1, dx: 3, dy: 3, dz: 2 }], as: "vault",
  });
  assert.equal(named.ok, true, JSON.stringify(named));

  const inside = await call("locate", {
    pattern: { nodes: [{ id: "g", block: GOLD }] }, in: "vault", limit: 8,
  });
  assert.equal(inside.ok, true, JSON.stringify(inside));
  assert.equal(inside.result.matches_total, 2,
    `only the staged pair is inside the region: ${JSON.stringify(inside.result.found.map((f) => f.pos))}`);
  assert.equal(inside.result.search.negative_is_proof, true);
  assert.match(String(inside.result.search.extent), /vault/,
    "the scan's extent must name the region it was asked about");
  assert.ok(inside.result.search.scope_region);

  // A set's bounding box works as an extent too — the refinement chain closes.
  const all = await call("locate", {
    pattern: { nodes: [{ id: "g", block: GOLD }] }, near: NEAR, y_range: SLAB, as: "allgolds",
  });
  assert.equal(all.result.matches_total, ALL_GOLDS.length, JSON.stringify(all.result.search));
  const overSet = await call("locate", {
    pattern: { nodes: [{ id: "g", block: GOLD }] }, in: "allgolds", limit: 8,
  });
  assert.equal(overSet.result.matches_total, ALL_GOLDS.length,
    "the set's own bounding box must contain all of its members");
  assert.match(String(overSet.result.search.extent), /allgolds/);

  // The region IS the extent: a second extent argument is a contradiction, not a refinement.
  for (const extra of [{ radius: 16 }, { y_range: { min: Y, max: Y + 2 } }]) {
    const clash = await call("locate", {
      pattern: { nodes: [{ id: "g", block: GOLD }] }, in: "vault", ...extra,
    });
    assert.equal(clash.ok, false, `must refuse ${JSON.stringify(extra)} alongside in:`);
    assert.match(String(clash.error), /both set the extent/);
  }

  await call("anchors", { drop: "vault" });
  await call("anchors", { drop: "allgolds" });
});

test("anchors: sets are listed with provenance, and drop forgets them", async () => {
  const led = await call("anchors", {});
  assert.equal(led.ok, true, JSON.stringify(led));
  const s = (led.result.sets ?? []).find((x) => x.name === "golds");
  assert.ok(s, `set must appear in the ledger read: ${JSON.stringify(led.result.sets)}`);
  assert.equal(s.matcher, GOLD);
  assert.equal(typeof s.age_ticks, "number");
  assert.ok(s.extent, "a set without provenance cannot scope a later negative");

  const dropped = await call("anchors", { drop: "golds" });
  assert.equal(dropped.ok, true);
  const led2 = await call("anchors", {});
  assert.ok(!(led2.result.sets ?? []).some((x) => x.name === "golds"), "dropped set must be gone");

  // A pattern search's record sits in the search log like every other search.
  const patternSearches = led.result.searches.filter((x) => x.mechanism === "pattern_scan");
  assert.ok(patternSearches.length >= 1, "pattern searches must be recorded in the ledger");
  for (const ps of patternSearches) {
    assert.equal(typeof ps.negative_is_proof, "boolean");
    assert.ok(ps.extent, `pattern search without a stated extent: ${JSON.stringify(ps)}`);
  }
});
