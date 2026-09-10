// locate / anchors probes — the relation-shaped read and its session ledger.
//
// What this suite is actually defending:
//   1. RELATIONS CHAIN. The second locate reports its find against the FIRST one's handle. That is
//      the whole point of the tool — the model never integrates observations into a map, because
//      the integration arrives done (ARCHITECTURE.md: sequential-observation map integration is the
//      second documented model failure mode, beside coordinate arithmetic).
//   2. NEGATIVES ARE TYPED. `search.negative_is_proof` is true for worldgen structure placement
//      (deterministic from the seed) and false for the POI index (which only knows generated
//      chunks). A miss that cannot prove absence must never be reported as if it could.
//   3. VOLATILE ANCHORS RE-RESOLVE. A mob that moved relates from where it is NOW; a mob that is
//      gone relates from its last known position and says `stale`. Storing a mobile thing's
//      position is the bug this guards against.
//   4. RELATION FAN-OUT IS BOUNDED. Observer + at most 2 anchors — relating every find to every
//      prior find is O(n²) text growth, which re-creates the context problem the design exists to
//      avoid.
//
// Fixture: a flat stone platform far from every other probe sandbox, forceloaded, with two
// NoAI/PersistenceRequired/Invulnerable mobs at known positions. Everything is reverted after.
//
// Run: npm run test:live (needs the dev server).

import { test, before, after } from "node:test";
import assert from "node:assert";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const cmd = (c) => call("run_command", { command: c });

const CX = 3_004_000;
const CZ = 3_004_000;
const Y = 300; // above natural terrain, below build limit
const PLAT_MIN = { x: CX - 32, z: CZ - 32 };
const PLAT_MAX = { x: CX + 32, z: CZ + 32 };
const LOAD_MIN = { x: CX - 80, z: CZ - 80 };
const LOAD_MAX = { x: CX + 80, z: CZ + 80 };
// Two mobs, 40 blocks apart on the x axis: the skeleton is due EAST of the zombie.
const ZOMBIE = { x: CX - 20, y: Y + 1, z: CZ };
const SKELETON = { x: CX + 20, y: Y + 1, z: CZ };
const NEAR = { x: CX, z: CZ };
const NBT = "{NoAI:1b,PersistenceRequired:1b,Invulnerable:1b}";
// Selector box for the fixture mobs. `y`/`dy` are NOT optional here: with dx/dz given and dy
// omitted, a selector box is a zero-height slab at the command source's y — which silently matches
// nothing when the fixture sits at y=301.
const BOX = `x=${LOAD_MIN.x},y=-64,z=${LOAD_MIN.z},dx=160,dy=448,dz=160`;
const undoIds = [];

/** Handle of the first find, or null. Handles are `name@x,y,z` — identity plus coordinates. */
const firstHandle = (r) => r.result?.found?.[0]?.handle ?? null;
/** The relation to a given handle inside a find, or undefined. */
const relTo = (find, to) => find.relations?.find((x) => x.to === to);

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server first");
  await cmd(`forceload add ${LOAD_MIN.x} ${LOAD_MIN.z} ${LOAD_MAX.x} ${LOAD_MAX.z}`);
  const t0 = Date.now();
  for (;;) {
    const r = await call("get_blocks_at", { blocks: [{ x: CX, y: Y, z: CZ }] });
    if (r.ok && r.result.coverage?.state === "complete") break;
    if (Date.now() - t0 > 120_000) throw new Error("fixture chunks not generated in 120s");
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  const plat = await call("place_shape", {
    shape: "box", block: "minecraft:stone", mode: "solid",
    p1: { x: PLAT_MIN.x, y: Y, z: PLAT_MIN.z },
    p2: { x: PLAT_MAX.x, y: Y, z: PLAT_MAX.z },
  });
  assert.equal(plat.ok, true, `platform: ${JSON.stringify(plat)}`);
  if (plat.result.undo_id) undoIds.push(plat.result.undo_id);
  // Idempotent fixture: an aborted earlier run leaves persistent mobs behind, and the counts below
  // are exact ("exactly the fixture zombie"), so clear before summoning.
  await cmd(`kill @e[type=minecraft:zombie,${BOX}]`).catch(() => {});
  await cmd(`kill @e[type=minecraft:skeleton,${BOX}]`).catch(() => {});
  await cmd(`summon minecraft:zombie ${ZOMBIE.x} ${ZOMBIE.y} ${ZOMBIE.z} ${NBT}`);
  await cmd(`summon minecraft:skeleton ${SKELETON.x} ${SKELETON.y} ${SKELETON.z} ${NBT}`);
  await call("anchors", { clear: true });
});

after(async () => {
  await cmd(`kill @e[type=minecraft:zombie,${BOX}]`).catch(() => {});
  await cmd(`kill @e[type=minecraft:skeleton,${BOX}]`).catch(() => {});
  for (const id of undoIds.reverse()) await call("undo_edit", { undo_id: id }).catch(() => {});
  await cmd(`forceload remove ${LOAD_MIN.x} ${LOAD_MIN.z} ${LOAD_MAX.x} ${LOAD_MAX.z}`).catch(() => {});
});

test("locate: entity find carries a coordinate-bearing handle and a relation to the observer", async () => {
  await call("anchors", { clear: true });
  const r = await call("locate", { what: "minecraft:zombie", near: NEAR, radius: 48 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.found.length, 1, `expected exactly the fixture zombie: ${JSON.stringify(r.result.found)}`);
  const f = r.result.found[0];
  assert.match(f.handle, /^zombie@-?\d+,-?\d+,-?\d+$/, `handle must carry coordinates: ${f.handle}`);
  assert.equal(f.kind, "entity");
  assert.equal(f.id, "minecraft:zombie");
  const you = relTo(f, "you");
  assert.ok(you, `no relation to the observer: ${JSON.stringify(f.relations)}`);
  assert.equal(you.bearing, "W", `zombie is 20 blocks west of centre, got ${you.bearing}`);
  assert.ok(Math.abs(you.map_distance - 20) < 3,
    `map_distance ~20 expected (horizontal, not 3D against an assumed y), got ${you.map_distance}`);
  assert.equal(typeof you.dy, "number");
  // Entity search is the X-ray spatial read; structure/POI lookups are authoritative.
  assert.equal(r.result.perception_mode, "spatial");
});

test("locate: the SECOND find is reported relative to the FIRST — the core claim", async () => {
  await call("anchors", { clear: true });
  const first = await call("locate", { what: "minecraft:zombie", near: NEAR, radius: 48 });
  const zHandle = firstHandle(first);
  assert.ok(zHandle, "fixture zombie not located");

  const second = await call("locate", { what: "minecraft:skeleton", near: NEAR, radius: 48 });
  assert.equal(second.ok, true, JSON.stringify(second));
  const sk = second.result.found[0];
  assert.ok(sk, "fixture skeleton not located");
  const toZombie = relTo(sk, zHandle);
  assert.ok(toZombie, `skeleton not related to the zombie anchor: ${JSON.stringify(sk.relations)}`);
  assert.equal(toZombie.bearing, "E", `skeleton is due east of the zombie, got ${toZombie.bearing}`);
  assert.ok(Math.abs(toZombie.map_distance - 40) < 4,
    `~40 blocks apart expected, got ${toZombie.map_distance}`);
});

test("locate: `as` names the find, and the name becomes the anchor handle", async () => {
  await call("anchors", { clear: true });
  const r = await call("locate", { what: "minecraft:zombie", near: NEAR, radius: 48, as: "guard" });
  const h = firstHandle(r);
  assert.match(h, /^guard@-?\d+,-?\d+,-?\d+$/, `as: should rename the handle, got ${h}`);
  const led = await call("anchors", {});
  assert.ok(led.result.anchors.some((a) => a.handle === h), "named find did not land in the ledger");
});

test("locate: a volatile anchor relates from where the mob is NOW, not where it was found", async () => {
  await call("anchors", { clear: true });
  const first = await call("locate", { what: "minecraft:zombie", near: NEAR, radius: 48 });
  const zHandle = firstHandle(first);
  const before2 = await call("locate", { what: "minecraft:skeleton", near: NEAR, radius: 48 });
  const distBefore = relTo(before2.result.found[0], zHandle).map_distance;

  // Move the zombie 20 blocks further west; the handle still names it, the relation must follow.
  await cmd(`tp @e[type=minecraft:zombie,limit=1,${BOX}] ${ZOMBIE.x - 20} ${ZOMBIE.y} ${ZOMBIE.z}`);
  const after2 = await call("locate", { what: "minecraft:skeleton", near: NEAR, radius: 48 });
  const rel = relTo(after2.result.found[0], zHandle);
  assert.ok(rel, `anchor lost after the mob moved: ${JSON.stringify(after2.result.found[0].relations)}`);
  assert.ok(rel.map_distance > distBefore + 15,
    `relation should follow the live entity (${distBefore} -> ${rel.map_distance})`);
  assert.ok(!rel.stale, "a live entity must not be flagged stale");
  await cmd(`tp @e[type=minecraft:zombie,limit=1,${BOX}] ${ZOMBIE.x} ${ZOMBIE.y} ${ZOMBIE.z}`);
});

test("locate: a vanished anchor is flagged stale, not silently dropped or silently trusted", async () => {
  await call("anchors", { clear: true });
  const first = await call("locate", { what: "minecraft:zombie", near: NEAR, radius: 48 });
  const zHandle = firstHandle(first);
  await cmd(`kill @e[type=minecraft:zombie,${BOX}]`);
  const r = await call("locate", { what: "minecraft:skeleton", near: NEAR, radius: 48 });
  const rel = relTo(r.result.found[0], zHandle);
  assert.ok(rel, "the anchor should survive the entity's death, flagged");
  assert.equal(rel.stale, true, `expected stale:true, got ${JSON.stringify(rel)}`);
  assert.match(String(rel.note), /last known/i);
  await cmd(`summon minecraft:zombie ${ZOMBIE.x} ${ZOMBIE.y} ${ZOMBIE.z} ${NBT}`);
});

test("locate: relation fan-out stays bounded (observer + at most 2 anchors)", async () => {
  await call("anchors", { clear: true });
  for (const what of ["minecraft:zombie", "minecraft:skeleton", "hostile", "living"]) {
    const r = await call("locate", { what, near: NEAR, radius: 48 });
    assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);
    for (const f of r.result.found) {
      assert.ok(f.relations.length <= 3,
        `${what}: ${f.relations.length} relations — fan-out must stay bounded`);
    }
  }
});

test("search honesty: a structure miss IS proof; a POI miss is NOT", async () => {
  // End cities do not generate in the overworld, so this is a deterministic miss.
  const s = await call("locate", { what: "minecraft:end_city", near: NEAR, radius: 64 });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.result.found.length, 0);
  assert.equal(s.result.perception_mode, "authoritative");
  assert.equal(s.result.search.mechanism, "structure_placement");
  assert.equal(s.result.search.negative_is_proof, true,
    "worldgen placement is deterministic from the seed — a miss within radius is a real negative");
  assert.equal(typeof s.result.search.ms, "number", "every search records its measured cost");
  assert.match(String(s.result.note), /real negative/i);

  // A structure find resolves a COLUMN. Vanilla hands back y=0, which is not a height — reporting
  // it as one would be exactly the confident-falsehood class the 0.6.0 purge existed for.
  const hit = await call("locate", { what: "structure:#minecraft:village", near: { x: 0, z: 0 }, radius: 3200 });
  assert.equal(hit.ok, true, JSON.stringify(hit));
  if (hit.result.found.length) {
    const f = hit.result.found[0];
    assert.match(f.handle, /@-?\d+,~,-?\d+$/, `unknown height must read as ~, got ${f.handle}`);
    assert.equal(f.pos.y, null, "structure pos.y must be null, never 0");
    assert.ok(f.relations.every((rel) => rel.dy === undefined),
      `dy is meaningless against an unknown height: ${JSON.stringify(f.relations)}`);
    assert.ok(f.relations.some((rel) => typeof rel.map_distance === "number"),
      "a horizontal relation is still available without a height");
  }

  // No beds anywhere near the fixture, and the POI index only knows generated chunks.
  const p = await call("locate", { what: "minecraft:home", near: NEAR, radius: 64 });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.result.search.mechanism, "poi_index");
  assert.equal(p.result.search.negative_is_proof, false,
    "the POI index cannot distinguish 'nothing there' from 'never generated'");
  assert.match(String(p.result.note), /not evidence of absence/i);
});

test("search honesty: an entity search states its chunk extent (staged, 0.21.0)", async () => {
  const r = await call("locate", { what: "hostile", near: NEAR, radius: 48 });
  assert.equal(r.result.search.mechanism, "entity_sections");
  assert.match(String(r.result.search.extent), /chunks in radius entity-searched/);
  // Staged like get_entities: the fixture radius is fully searchable, so the negative is proof.
  assert.equal(r.result.search.negative_is_proof, true,
    `expected a fully entity-searched radius: ${r.result.search.extent}`);
});

test("anchors: the ledger records searches, and pin/drop/clear behave", async () => {
  await call("anchors", { clear: true });
  await call("locate", { what: "minecraft:zombie", near: NEAR, radius: 48, as: "base" });
  await call("locate", { what: "minecraft:skeleton", near: NEAR, radius: 48 });

  let led = await call("anchors", {});
  assert.equal(led.ok, true, JSON.stringify(led));
  assert.ok(led.result.searches.length >= 2, "searches must be recorded, not just finds");
  for (const s of led.result.searches) {
    assert.equal(typeof s.negative_is_proof, "boolean", `search without a typed negative: ${JSON.stringify(s)}`);
    assert.ok(s.extent, `search without a stated extent: ${JSON.stringify(s)}`);
  }
  const baseHandle = led.result.anchors.find((a) => a.handle.startsWith("base@"))?.handle;
  assert.ok(baseHandle, "named anchor missing from the ledger");

  const pinned = await call("anchors", { pin: baseHandle });
  assert.equal(pinned.ok, true, JSON.stringify(pinned));
  await call("anchors", { clear: true });
  led = await call("anchors", {});
  assert.ok(led.result.anchors.some((a) => a.handle === baseHandle && a.pinned),
    "clear must keep pinned anchors");
  assert.equal(led.result.anchors.length, 1, "clear must drop every unpinned anchor");

  await call("anchors", { drop: baseHandle });
  led = await call("anchors", {});
  assert.equal(led.result.anchors.length, 0, "drop must remove a pinned anchor too");
});

test("locate: an unresolvable target names every index it tried", async () => {
  const r = await call("locate", { what: "minecraft:definitely_not_a_real_thing", near: NEAR });
  assert.equal(r.ok, false, "an unknown target must fail, never resolve to the wrong index");
  assert.match(String(r.error), /structure/i);
  assert.match(String(r.error), /point-of-interest|poi/i);
  assert.match(String(r.error), /entity/i);

  // A bare tag used to be refused as "ambiguous" on the false premise that per-registry tag
  // probing is expensive (it is a map lookup) — which cost the whole disjunctive question class.
  // It now resolves in the same precedence order bare ids do, and `search.mechanism` says which
  // index answered, so a wrong resolution is visible rather than silent (LOCATE_ROUTES.md B1).
  const tag = await call("locate", { what: "#minecraft:village", near: NEAR, radius: 64 });
  assert.equal(tag.ok, true, `a bare tag must resolve, not be refused: ${JSON.stringify(tag)}`);
  assert.equal(tag.result.search.mechanism, "structure_placement",
    "the answering index must be visible in the payload");

  const unknownTag = await call("locate", { what: "#mcptk:not_a_real_tag_anywhere", near: NEAR });
  assert.equal(unknownTag.ok, false, "an unknown tag must fail, never resolve to the wrong index");
  for (const idx of [/structure/i, /point-of-interest|poi/i, /entity/i, /biome/i, /block/i]) {
    assert.match(String(unknownTag.error), idx, "the error must name every index tried");
  }
});

test("biome route: the sampler answers where a terrain TYPE is, and types its own negative", async () => {
  // The route that did not exist before 0.29.0 (LOCATE_ROUTES.md A1): no other tool in the toolkit
  // can answer "where is the nearest desert" — get_region_summary only reports the biome mix of a
  // capped grid it can already see.
  const r = await call("locate", { what: "minecraft:plains", near: NEAR, radius: 512 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.search.mechanism, "biome_climate_sampler");
  assert.equal(r.result.perception_mode, "authoritative",
    "the climate sampler is seed state, not a chunk read");
  assert.equal(typeof r.result.search.ms, "number", "every search records its measured cost");
  // Possible-here biome: a miss is a RESOLUTION limit (32/64 sampling), not an unread one, and
  // the payload must not let that be restated as a proof.
  assert.equal(r.result.search.negative_is_proof, false,
    `sampling can step over a small patch: ${JSON.stringify(r.result.search)}`);
  assert.match(String(r.result.search.note), /RESOLUTION/);
  if (r.result.found.length) {
    const f = r.result.found[0];
    assert.equal(f.kind, "biome");
    assert.match(f.handle, /^plains@-?\d+,-?\d+,-?\d+$/, `handle: ${f.handle}`);
    assert.ok(f.relations.some((x) => typeof x.map_distance === "number"),
      "a biome find is related like every other find");
    assert.match(String(f.detail), /not a surface height/i,
      "the sample cell must not read as a ground position");
  }

  // The one biome negative that IS a proof: this dimension's generator cannot make it at all, so
  // no radius will ever find it. Categorically different from "did not sample it here".
  const impossible = await call("locate", { what: "minecraft:nether_wastes", near: NEAR, radius: 256 });
  assert.equal(impossible.ok, true, JSON.stringify(impossible));
  assert.equal(impossible.result.found.length, 0);
  assert.equal(impossible.result.search.negative_is_proof, true,
    `a biome the overworld cannot generate is a real negative: ${JSON.stringify(impossible.result.search)}`);
  assert.match(String(impossible.result.search.note), /DEFINITIVE/);
  assert.match(String(impossible.result.note), /real negative/i);

  const tagged = await call("locate", { what: "biome:#minecraft:is_forest", near: NEAR, radius: 512 });
  assert.equal(tagged.ok, true, JSON.stringify(tagged));
  assert.equal(tagged.result.search.mechanism, "biome_climate_sampler");
});

test("POI occupancy: claim state rides every hit, and the filter narrows without lying (A2)", async () => {
  // LOCATE_ROUTES.md A2 — the village-capacity survey ("is there a free bed", "which job sites are
  // unclaimed") had no route: findPoi hardcoded Occupancy.ANY. Fixture is a job site rather than a
  // bed on purpose: the POI-negative probe above asserts that NO `minecraft:home` exists near the
  // platform, and that claim has to keep holding.
  const SITE = { x: CX + 6, y: Y + 1, z: CZ + 6 };      // composter -> minecraft:farmer, 1 ticket
  const ROD = { x: CX - 6, y: Y + 1, z: CZ + 6 };       // lodestone -> 0 tickets, unclaimable
  const placed = await call("set_blocks", {
    blocks: [{ ...SITE, block: "minecraft:composter" }, { ...ROD, block: "minecraft:lodestone" }],
  });
  assert.equal(placed.ok, true, `poi fixture: ${JSON.stringify(placed)}`);
  if (placed.result.undo_id) undoIds.push(placed.result.undo_id);
  // POI add/remove is deferred to a server task (ServerLevel.updatePOIOnBlockStateChange), so the
  // index is not updated on the setBlock tick — poll rather than race it.
  let any = null;
  for (let i = 0; i < 40; i++) {
    any = await call("locate", { what: "minecraft:farmer", near: NEAR, radius: 32 });
    if (any.ok && any.result.found.length) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(any.result.found.length, 1, `staged job site not indexed: ${JSON.stringify(any.result)}`);
  assert.equal(any.result.search.occupancy, "any", "the unfiltered question must say it was unfiltered");
  assert.match(String(any.result.found[0].detail), /tickets 1 of 1 free \(unclaimed\)/,
    `claim state is the actual capacity answer: ${JSON.stringify(any.result.found[0])}`);

  const free = await call("locate", { what: "minecraft:farmer", near: NEAR, radius: 32, occupancy: "free" });
  assert.equal(free.ok, true, JSON.stringify(free));
  assert.equal(free.result.found.length, 1, "an unclaimed site has a ticket available");
  assert.equal(free.result.search.occupancy, "free");
  assert.match(String(free.result.search.extent), /free sites only/,
    "the filter must travel with the extent, or a remembered negative loses its scope");

  const claimed = await call("locate", { what: "minecraft:farmer", near: NEAR, radius: 32, occupancy: "claimed" });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(claimed.result.found.length, 0, "nothing has claimed the staged site");
  assert.match(String(claimed.result.search.note), /FILTERED/,
    "a filtered miss must not read as 'no job site here'");

  // The trap: 0-ticket POI types match NEITHER filter. Silently returning nothing for both would
  // be a confident falsehood about a lodestone that is right there.
  const rodAny = await call("locate", { what: "minecraft:lodestone", near: NEAR, radius: 32 });
  assert.equal(rodAny.result.found.length, 1, `staged lodestone not indexed: ${JSON.stringify(rodAny.result)}`);
  assert.match(String(rodAny.result.found[0].detail), /not claimable/i,
    "'0 of 0 free' would read as full and 'unclaimed' as available — neither is true");
  const rodFree = await call("locate", { what: "minecraft:lodestone", near: NEAR, radius: 32, occupancy: "free" });
  assert.equal(rodFree.result.found.length, 0, "an unclaimable type has no free ticket either");
  assert.match(String(rodFree.result.search.note), /unclaimable/i,
    "the payload must name the trap it just walked into");

  // Refusals: an unknown value, and the argument used where no index can honour it (A3's sin was
  // accepting `limit` at the schema and dropping it on the floor).
  const bogus = await call("locate", { what: "minecraft:farmer", near: NEAR, occupancy: "sometimes" });
  assert.equal(bogus.ok, false);
  assert.match(String(bogus.error), /any\|free\|claimed/);
  for (const args of [
    { what: "minecraft:stone", near: NEAR, radius: 8, occupancy: "free" },
    { what: "minecraft:zombie", near: NEAR, radius: 8, occupancy: "free" },
    { at: [{ x: CX, y: Y, z: CZ }], occupancy: "free" },
    { pattern: { nodes: [{ id: "s", block: "minecraft:stone" }] }, near: NEAR, occupancy: "free" },
  ]) {
    const refused = await call("locate", args);
    assert.equal(refused.ok, false, `occupancy must be refused, not ignored: ${JSON.stringify(args)}`);
    assert.match(String(refused.error), /POI index only/);
  }
});

// --- the DOWN direction (`at`): positions -> identity -------------------------------------------
// Same relation as `what`, solved for the other variable. These guard the three things that make it
// a real replacement for get_blocks_at rather than a second-rate copy: vanilla `expect` semantics,
// the referent/reading split, and that it needs NO observer (a headless bench has no player).

test("locate at: a single position becomes a referent with a coordinate-bearing handle", async () => {
  await call("anchors", { clear: true });
  const r = await call("locate", { at: [{ x: CX, y: Y, z: CZ }], as: "pad" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.direction, "identify");
  assert.equal(r.result.perception_mode, "authoritative");
  assert.match(r.result.found.handle, /^pad@-?\d+,-?\d+,-?\d+$/);
  assert.equal(r.result.found.kind, "block");
  assert.equal(r.result.found.id, "minecraft:stone");
  assert.equal(r.result.coverage.state, "complete");
  // The palette round-trips into set_blocks syntax, and affordances ride along.
  assert.ok(r.result.palette.length >= 1);
  assert.equal(typeof r.result.affordances[0], "string");
});

test("locate at: no observer is required — 'what is here' does not depend on where you are", async () => {
  const r = await call("locate", { at: [{ x: CX, y: Y, z: CZ }] });
  assert.equal(r.ok, true, `at must work headless with no player/drone: ${JSON.stringify(r)}`);
  // Environment-honest, not environment-coupled (the probe-coupling lesson): headless there is
  // no observer and the source must SAY so; with a human client in the world (how this battery
  // runs when the dev client is up) that player IS a legitimate default observer and the source
  // names them. Both are the truth of their environment; what is banned is faking either way.
  const source = String(r.result.source);
  const headless = /no observer/i.test(source);
  assert.ok(headless || /player/i.test(source),
    `source must name the observer or its absence: ${source}`);
  if (headless) {
    assert.ok(!r.result.found.relations.some((x) => x.to === "you"),
      "with no observer there is no `you` to relate to — it must be omitted, not faked");
  }
});

test("locate at: batch + expect verifies N placements in one call, and names what was there", async () => {
  const r = await call("locate", {
    at: [
      { x: CX, y: Y, z: CZ, expect: "minecraft:stone" },
      { x: CX, y: Y + 1, z: CZ, expect: "minecraft:stone" },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.check.expected, 2);
  assert.equal(r.result.check.all_matched, false, "the block above the platform is air");
  assert.equal(r.result.mismatches[0].actual, "minecraft:air");
  // A batch is a reading, not N landmarks — it must not flood the ledger.
  assert.equal(r.result.found, undefined);
  assert.match(String(r.result.note), /no referents created/i);
});

test("locate at: an unreadable position yields no referent and no guess", async () => {
  const r = await call("locate", { at: [{ x: 9_100_000, y: 80, z: 9_100_000 }], load: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.blocks[0][3], -1, "-1 means not read, never a palette guess");
  assert.equal(r.result.found, undefined, "nothing was observed, so nothing becomes a referent");
  assert.notEqual(r.result.coverage.state, "complete");
});

test("locate at + extent: a LINE enumerates as runs, a BOX is described (D3)", async () => {
  // The region arity of "what is at this position". TOOL_BILL §6c r11 is the motivating trace: with
  // describe_box hidden the agent reached for `locate at` on a volume question and sampled points.
  // A column: air below the platform, one stone layer, air above — three runs, not 5 rows.
  // Read a column OFF the `pad` anchor's own cell, deliberately. An extent relates from its CENTRE,
  // and a relation to an anchor standing exactly on that centre is correctly self-skipped ("the
  // anchor IS this find") — so a column centred on `pad` can only be related through `you`, and the
  // claim under test then silently depends on a player being logged in. It passed on a client and
  // failed on the first headless run for exactly that reason; offsetting makes the claim mean what
  // it says. The runs are identical anywhere on the platform (air / one stone layer / air).
  const col = await call("locate", { at: [{ x: CX + 3, y: Y - 2, z: CZ, dy: 4 }] });
  assert.equal(col.ok, true, JSON.stringify(col));
  assert.equal(col.result.direction, "identify (line)");
  assert.equal(col.result.axis, "y");
  assert.equal(col.result.cells, 5);
  assert.deepEqual(col.result.runs, [[Y - 2, Y - 1, "minecraft:air"],
    [Y, Y, "minecraft:stone"], [Y + 1, Y + 2, "minecraft:air"]],
    `run-length runs along the axis: ${JSON.stringify(col.result.runs)}`);
  const toPad = col.result.relations.find((x) => String(x.to).startsWith("pad@"));
  assert.ok(toPad && typeof toPad.map_distance === "number",
    `an extent read is related to your anchors like every other find: ${JSON.stringify(col.result.relations)}`);
  assert.equal(toPad.map_distance, 3, "related from the extent's centre, horizontally");

  // Two axes or more: a DESCRIPTION, never a dumped grid (the measured extraction hazard).
  const box = await call("locate", { at: [{ x: CX, y: Y, z: CZ, dx: 4, dy: 2, dz: 4 }], as: "pad" });
  assert.equal(box.ok, true, JSON.stringify(box));
  assert.equal(box.result.direction, "describe (region)");
  assert.equal(box.result.volume, 5 * 3 * 5);
  assert.equal(box.result.region.volume, 5 * 3 * 5);
  const stone = box.result.materials.find((m) => m.block === "minecraft:stone");
  assert.ok(stone, `materials must carry the census: ${JSON.stringify(box.result.materials)}`);
  assert.equal(stone.count, 25, "one platform layer inside a 5x3x5 box");
  assert.equal(box.result.air, 50, "the other two layers");
  assert.equal(box.result.blocks, undefined, "a region is described, not dumped as rows");
  assert.equal(box.result.layers, undefined, "the layers view is deliberately not offered here");
  assert.equal(box.result.coverage.state, "complete");

  // `as` on an extent names a REGION — the extent referent the ledger lacked (D2).
  assert.equal(box.result.named, "pad");
  const led = await call("anchors", {});
  const region = (led.result.regions ?? []).find((g) => g.name === "pad");
  assert.ok(region, `region must land in the ledger: ${JSON.stringify(led.result.regions)}`);
  assert.equal(region.volume, 75);

  // `in` alone describes it again, from the name.
  const again = await call("locate", { in: "pad" });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.result.direction, "describe (region)");
  assert.equal(again.result.materials.find((m) => m.block === "minecraft:stone").count, 25);
  assert.match(String(again.result.region.from), /region 'pad'/);

  // Refusals: an extent cannot be mixed with positions or with per-cell tests, and a line is capped.
  const mixed = await call("locate", { at: [{ x: CX, y: Y, z: CZ, dy: 3 }, { x: CX, y: Y, z: CZ }] });
  assert.equal(mixed.ok, false);
  assert.match(String(mixed.error), /only entry/);
  const tested = await call("locate", { at: [{ x: CX, y: Y, z: CZ, dy: 3, expect: "minecraft:stone" }] });
  assert.equal(tested.ok, false);
  assert.match(String(tested.error), /ONE cell/);
  const tooLong = await call("locate", { at: [{ x: CX, y: -60, z: CZ, dy: 500 }] });
  assert.equal(tooLong.ok, false);
  assert.match(String(tooLong.error), /exceeds the cap/);
});

test("locate in: a named region scopes a search, and says so (D2)", async () => {
  // A 9x9 column of world around the fixture zombie, and another around the skeleton.
  const near = await call("locate", {
    at: [{ x: ZOMBIE.x - 4, y: Y, z: ZOMBIE.z - 4, dx: 8, dy: 4, dz: 8 }], as: "zombie_room",
  });
  assert.equal(near.ok, true, JSON.stringify(near));
  const far = await call("locate", {
    at: [{ x: SKELETON.x - 4, y: Y, z: SKELETON.z - 4, dx: 8, dy: 4, dz: 8 }], as: "skeleton_room",
  });
  assert.equal(far.ok, true, JSON.stringify(far));

  const inZombie = await call("locate", { what: "minecraft:zombie", in: "zombie_room" });
  assert.equal(inZombie.ok, true, JSON.stringify(inZombie));
  assert.equal(inZombie.result.found.length, 1, "the fixture zombie is inside that region");
  assert.match(String(inZombie.result.search.extent), /zombie_room/,
    "the negative must be stated about the REGION, not about a radius");
  assert.ok(inZombie.result.search.scope_region, "the box travels with the search record");

  const elsewhere = await call("locate", { what: "minecraft:zombie", in: "skeleton_room" });
  assert.equal(elsewhere.ok, true, JSON.stringify(elsewhere));
  assert.equal(elsewhere.result.found.length, 0,
    "the zombie is 40 blocks away — outside this region, so not an answer to this question");
  assert.equal(elsewhere.result.search.negative_is_proof, true,
    `a fully entity-searched region is a real negative: ${JSON.stringify(elsewhere.result.search)}`);

  // The nearest-only indexes cannot be box-filtered without manufacturing a negative.
  for (const what of ["structure:#minecraft:village", "minecraft:plains"]) {
    const refused = await call("locate", { what, in: "zombie_room" });
    assert.equal(refused.ok, false, `must refuse to scope ${what}`);
    assert.match(String(refused.error), /NEAREST/);
  }
  const unknown = await call("locate", { in: "no_such_region" });
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.error), /zombie_room/, "the error must name the regions that exist");

  await call("anchors", { drop: "zombie_room" });
  await call("anchors", { drop: "skeleton_room" });
});

test("locate: the two directions share one ledger — an `at` find relates to a `what` find", async () => {
  await call("anchors", { clear: true });
  const found = await call("locate", { what: "minecraft:skeleton", near: NEAR, radius: 48 });
  const skHandle = firstHandle(found);
  assert.ok(skHandle, "fixture skeleton not located");
  const here = await call("locate", { at: [{ x: CX, y: Y, z: CZ }] });
  const rel = here.result.found.relations.find((x) => x.to === skHandle);
  assert.ok(rel, `identify must relate to a search anchor: ${JSON.stringify(here.result.found.relations)}`);
  assert.equal(typeof rel.map_distance, "number");
});

test("locate: exactly one direction per call", async () => {
  // Three directions since the pattern rung (PATTERN_SEARCH_DESIGN.md): what | at | pattern.
  const both = await call("locate", { what: "minecraft:zombie", at: [{ x: CX, y: Y, z: CZ }] });
  assert.equal(both.ok, false);
  assert.match(String(both.error), /exactly one/i);
  const neither = await call("locate", { near: NEAR });
  assert.equal(neither.ok, false);
  assert.match(String(neither.error), /exactly one/i);
});
