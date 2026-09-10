// Legal-locate + ambient-retina probes — SURVIVAL_MODE_PLAN.md §5–6, MEMORY_REDESIGN.md §12.
// Offline, no server, no model spend. What is defended:
//   1. The provenance filter: X-ray observations never leak into the legal view, including by
//      SUPERSESSION (an X-ray read newer than the legal one must not update the legal answer).
//   2. The frontier: a legal miss reports seen-coverage and where seen space ends, never silence.
//   3. The refusals: entity categories, centerless searches, and pattern vocabulary the store
//      cannot serve fail loudly. (A block-node pattern is LEGAL since SURVIVAL_SENSES_DESIGN §3 —
//      it searches memory; memory/probes/legal-pattern.test.mjs is its suite.)
//   4. The ambient channel: an autofan capture lands as channel:"ambient" and therefore does NOT
//      move last-deliberate — it enriches the delta, it never counts as the agent having looked.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "mcobs-legal-"));
process.env.MCPTK_MEMORY_DIR = root;
process.env.MCPTK_EMBED_BACKEND ??= "none";
const { captureWorldRead, resetCaptureCache, storeFor } = await import("../capture.mjs");
const { legalLocate } = await import("../legal-locate.mjs");
const { ambientTick, AMBIENT_FAN_ARGS } = await import("../ambient.mjs");
const { LEGAL_OBSERVATION_TOOLS } = await import("../observations.mjs");

const DIM = "minecraft:overworld";
const WORLD_UUID = "legal-test-world";
const envelope = (tick = 1000) => ({ game_tick: tick, dimension: DIM, mechanism: "observe" });

/** Bridge stub: world identity + a body standing at (0, 65, 0). */
function fakeBridge({ spawned = true, fanResult = null } = {}) {
  return async (tool) => {
    if (tool === "get_world_info") {
      return { ok: true, result: { world_uuid: WORLD_UUID, name: "legal-test", game_tick: 9000 } };
    }
    if (tool === "bot_status") {
      return { ok: true, result: spawned ? { spawned: true, body: "walker", pos: { x: 0.5, y: 65, z: 0.5 } } : { spawned: false } };
    }
    if (tool === "raycast_fan") {
      return fanResult ?? { ok: false, error: "no drone spawned" };
    }
    return { ok: false, error: `unexpected bridge call ${tool}` };
  };
}

const bridge = fakeBridge();

// Seed the store: a legally-seen torch (raycast_fan), an X-ray-only chest (get_blocks_at), and a
// cell seen legally FIRST then superseded by an X-ray read.
test("seed: capture legal and illegal observations", async () => {
  resetCaptureCache();
  const fan = {
    ...envelope(1000),
    rays: [
      [0, 0, "b", "minecraft:torch", 6.1, 10, 65, 5],
      [-10, 0, "b", "minecraft:stone", 4.0, 8, 64, 3],
      [10, 0, "m"],
    ],
    hits: { block: 2, miss: 1 },
  };
  const c1 = await captureWorldRead("raycast_fan", {}, fan, bridge);
  assert.equal(c1.captured, true);

  const xray = {
    ...envelope(2000), detail: "state",
    palette: ["minecraft:chest"],
    blocks: [[-20, 64, -20, 0]],
  };
  const c2 = await captureWorldRead("get_blocks_at", {}, xray, bridge);
  assert.equal(c2.captured, true);

  // The supersession trap: the legally-seen stone at (8,64,3) is re-read by X-ray as diamond ore.
  const xray2 = {
    ...envelope(3000), detail: "state",
    palette: ["minecraft:diamond_ore"],
    blocks: [[8, 64, 3, 0]],
  };
  const c3 = await captureWorldRead("get_blocks_at", {}, xray2, bridge);
  assert.equal(c3.captured, true);
});

test("legalCells: X-ray cells are invisible; an X-ray supersession does not leak", async () => {
  const store = await storeFor(WORLD_UUID);
  const cells = await store.legalCells({ dim: DIM });
  const byKey = new Map(cells.map((c) => [c.pos.join(","), c]));
  assert.ok(byKey.has("10,65,5"), "the fan-seen torch is legal knowledge");
  assert.ok(!byKey.has("-20,64,-20"), "the X-ray-only chest must be invisible to the legal view");
  const stone = byKey.get("8,64,3");
  assert.equal(stone.val, "minecraft:stone", "the legal view answers with the LEGAL sighting, not the X-ray supersession");
  assert.equal(stone.superseded_illegally, true, "and says the view may be behind");
});

test("a PLURAL or TAG query finds the singular block — the log the agent could not find", async () => {
  // The second watched run "failed to find logs". The store had them; the matcher did not. It
  // compared one needle, so `logs` missed `oak_log` outright ("oak_log".includes("logs") is false)
  // and so did the tag form `#minecraft:logs`, which has no registry to resolve against here. Both
  // came back as "not in anything you've seen" — a FALSE negative wearing an honest negative's
  // words, which is the one thing the legal profile must never do.
  resetCaptureCache();
  const logFan = {
    ...envelope(4000),
    rays: [
      [0, 0, "b", "minecraft:oak_log", 5.0, 12, 65, 4],
      [5, 0, "b", "minecraft:spruce_planks", 5.0, 13, 65, 4],
      [-5, 0, "b", "minecraft:oak_leaves", 5.0, 12, 66, 4],
    ],
    hits: { block: 3 },
  };
  assert.equal((await captureWorldRead("raycast_fan", {}, logFan, bridge)).captured, true);

  for (const q of ["logs", "#minecraft:logs", "log", "oak_log", "minecraft:oak_log"]) {
    const r = await legalLocate({ what: q }, bridge);
    assert.equal(r.ok, true, `query ${q}: ${r.error}`);
    assert.ok(r.result.found.some((f) => f.id === "minecraft:oak_log"),
      `query "${q}" must find the remembered oak_log: ${JSON.stringify(r.result.found)}`);
  }
  // The other plural families agents type unprompted.
  const planks = await legalLocate({ what: "planks" }, bridge);
  assert.ok(planks.result.found.some((f) => f.id === "minecraft:spruce_planks"), "planks → spruce_planks");
  const leaves = await legalLocate({ what: "leaves" }, bridge);
  assert.ok(leaves.result.found.some((f) => f.id === "minecraft:oak_leaves"), "leaves → oak_leaves");

  // And it must not have become a match-anything: a real miss is still a miss, with the frontier.
  const miss = await legalLocate({ what: "diamond_ore" }, bridge);
  assert.equal(miss.result.found.length, 0, "widening the needles must not invent matches");
  assert.equal(miss.result.negative_is_proof, false);
  assert.ok(miss.result.coverage, "a miss still carries the frontier");
});

test("needles span word breaks: a spaced query finds what the underscored one finds", async () => {
  // PERCEPTION_NAV_FIXES §4.3. Block ids separate words with underscores and NEVER with spaces, so
  // before the fix any multi-word query was structurally incapable of matching: the concept was used
  // as its own needle still space-separated, and `"oak_log".includes("oak log")` is false. The
  // eleven-session corpus holds the natural experiment — `oak_log` found 5/5, `oak log` 0/1,
  // `grass_block` 1/1, `grass block` 0/1. It is the space, not the plural, which is why the
  // de-pluralizer above could not save it.
  //
  // This rides the fan seeded by the plural test above (oak_log, spruce_planks, oak_leaves).
  for (const q of ["oak log", "oak logs", "oak_log", "minecraft:oak log"]) {
    const r = await legalLocate({ what: q }, bridge);
    assert.equal(r.ok, true, `query "${q}": ${r.error}`);
    assert.ok(r.result.found.some((f) => f.id === "minecraft:oak_log"),
      `query "${q}" must find the remembered oak_log: ${JSON.stringify(r.result.found)}`);
  }
  // The two other spaced forms the corpus caught missing.
  const leaves = await legalLocate({ what: "oak leaves" }, bridge);
  assert.ok(leaves.result.found.some((f) => f.id === "minecraft:oak_leaves"), "oak leaves → oak_leaves");
  const planks = await legalLocate({ what: "spruce planks" }, bridge);
  assert.ok(planks.result.found.some((f) => f.id === "minecraft:spruce_planks"), "spruce planks → spruce_planks");

  // Underscoring must not widen the needle into a match-anything: the words still have to be
  // adjacent and in order, exactly as the underscored query requires.
  const wrongOrder = await legalLocate({ what: "log oak" }, bridge);
  assert.equal(wrongOrder.result.found.length, 0, "an underscored needle is still a substring, not a bag of words");
  const notAdjacent = await legalLocate({ what: "oak stairs" }, bridge);
  assert.equal(notAdjacent.result.found.length, 0, "a spaced query for something unseen is still an honest miss");
  assert.equal(notAdjacent.result.negative_is_proof, false);
});

test("legal search finds the fan-seen block with distance and bearing", async () => {
  const r = await legalLocate({ what: "torch" }, bridge);
  assert.equal(r.ok, true);
  assert.equal(r.result.legal_profile, true);
  assert.equal(r.result.center_from, "body");
  assert.equal(r.result.found.length, 1);
  const f = r.result.found[0];
  assert.deepEqual(f.pos, [10, 65, 5]);
  assert.equal(f.seen_via, "raycast_fan");
  assert.ok(f.dist >= 11 && f.dist <= 12, `distance ~11, got ${f.dist}`);
  assert.equal(r.result.negative_is_proof, false);
  assert.match(r.result.render, /remembered/i);
  // A HIT must still quantify ignorance: seen-fraction + unseen remainder, so "found 1" can never
  // read as "there is exactly 1" (Matthijs 2026-07-30).
  assert.ok(r.result.coverage.columns_total > r.result.coverage.columns_seen,
    "coverage must carry the denominator");
  assert.match(r.result.render, /you have seen \d+ of ~\d+ columns/);
  assert.match(r.result.render, /SEEN blocks only, not a world census/);
  assert.match(r.result.render, /more may exist in the unseen/);
});

test("the X-ray-only chest is NOT findable legally, and the miss carries the frontier", async () => {
  const r = await legalLocate({ what: "chest" }, bridge);
  assert.equal(r.ok, true);
  assert.equal(r.result.found.length, 0, "X-ray knowledge must not answer a legal search");
  assert.ok(r.result.coverage.columns_seen >= 2, "coverage counts legally seen columns");
  assert.ok(r.result.coverage.columns_total > 10_000, `r=64 disc holds ~12.8k columns, got ${r.result.coverage.columns_total}`);
  assert.ok(r.result.coverage.seen_fraction > 0 && r.result.coverage.seen_fraction < 0.01);
  assert.equal(r.result.coverage.sectors.length, 8);
  assert.ok(Array.isArray(r.result.coverage.least_explored) && r.result.coverage.least_explored.length === 3);
  assert.match(r.result.render, /least-explored/i);
  assert.match(r.result.render, /not proven absent/i);
});

test("legal identify: seen cells answer with age and tool; unseen is unknown, never air", async () => {
  const r = await legalLocate({ at: [{ x: 10, y: 65, z: 5 }, { x: 99, y: 64, z: 99 }] }, bridge);
  assert.equal(r.ok, true);
  const [seen, unseen] = r.result.positions;
  assert.equal(seen.observed, true);
  assert.equal(seen.val, "minecraft:torch");
  assert.equal(unseen.observed, false);
  assert.equal(r.result.unobserved, 1);
  assert.match(r.result.render, /never seen — unknown, not air/);
});

test("refusals: illegal pattern vocabulary, entity categories, centerless search", async () => {
  // A block-node pattern is legal now (it searches MEMORY — legal-pattern.test.mjs). What stays
  // refused here is the vocabulary the store cannot serve: entity nodes.
  const pat = await legalLocate({
    pattern: { nodes: [{ id: "a", block: "minecraft:chest" }, { id: "e", entity: "minecraft:zombie" }] },
  }, bridge);
  assert.equal(pat.ok, false);
  assert.match(pat.error, /sense_entities/);

  const ent = await legalLocate({ what: "hostile" }, bridge);
  assert.equal(ent.ok, false);
  assert.match(ent.error, /sense_entities/);

  const noCenter = await legalLocate({ what: "torch" }, fakeBridge({ spawned: false }));
  assert.equal(noCenter.ok, false);
  assert.match(noCenter.error, /no body/);
});

test("ambient tick: fires only within the activity window, captures on the ambient channel", async () => {
  const fanResult = {
    ok: true,
    result: {
      ...envelope(4000),
      rays: [[0, 0, "b", "minecraft:oak_log", 3.0, 2, 65, 8]],
      hits: { block: 1 },
    },
  };
  const b = fakeBridge({ fanResult });
  // Field renamed with the fix that widened the window from bot_* calls to ANY call: gating on the
  // embodied verbs blinded the retina for perception-only sessions (see memory/probes/ambient.test.mjs).
  const state = { lastActiveAt: 0, busy: false, loggedNoBody: false };

  const idle = await ambientTick(state, b, /* now */ 10_000_000);
  assert.equal(idle.fired, false, "an idle session must not fan");
  assert.equal(idle.reason, "idle");

  state.lastActiveAt = 10_000_000;
  const fired = await ambientTick(state, b, 10_000_500);
  assert.equal(fired.fired, true);
  assert.equal(fired.capture.captured, true);

  // The ambient sighting is legal knowledge (the body's own eye)…
  const store = await storeFor(WORLD_UUID);
  const cells = await store.legalCells({ dim: DIM });
  const log = cells.find((c) => c.pos.join(",") === "2,65,8");
  assert.ok(log, "ambient fan hits enter the legal view");
  assert.equal(log.val, "minecraft:oak_log");

  // …but it must NOT count as the agent having looked: no last-deliberate → first sight, and the
  // unseen-changes ledger stays empty (nothing the agent was told about has changed).
  const delta = await store.deltaView({ dim: DIM, cells: [[2, 65, 8, "minecraft:birch_log"]] });
  assert.equal(delta.length, 1);
  assert.equal(delta[0].was, null, "an ambient-only cell has no deliberate prior — first sight, not a change");
});

test("ambient failure path: a missing body logs once and never throws", async () => {
  const b = fakeBridge(); // fanResult null → {ok:false, error:"no drone spawned"}
  const state = { lastEmbodiedAt: 5_000, busy: false, loggedNoBody: false };
  const r1 = await ambientTick(state, b, 6_000);
  assert.equal(r1.fired, false);
  assert.equal(state.loggedNoBody, true);
  const r2 = await ambientTick(state, b, 7_000);
  assert.equal(r2.fired, false, "stays paused, no throw, no double-log");
});

test("the legal tool list is what the plan pre-registered", () => {
  // "act" joined 2026-08-04 (W2_POSTMORTEM_FIXES.md §6): the body's own verified mines/places are
  // knowledge the hands earned — the most player-legal provenance there is. Everything else in
  // the list is unchanged from the original pre-registration.
  assert.deepEqual([...LEGAL_OBSERVATION_TOOLS].sort(), ["act", "proprioception", "raycast", "raycast_fan"]);
  assert.equal(AMBIENT_FAN_ARGS.load, false, "the retina must not load chunks");
  assert.ok(AMBIENT_FAN_ARGS.h_fov <= 180, "forward cone, not a 360 X-ray sweep");
});

test("an argument locate does not have is REFUSED, not ignored", async () => {
  // The bug this defends against, in full: two live survival sessions (2026-08-02) passed `center`
  // on thirteen locate calls. It is not an argument, so every search silently ran from the BODY —
  // and the reply's own honest `center` field read back exactly like a confirmation of what had
  // been asked. Neither model ever noticed. It only stayed harmless because both happened to be
  // passing their own position; a remote question would have been answered about somewhere else.
  const b = fakeBridge();
  const r = await legalLocate({ what: "minecraft:oak_log", center: { x: 100, z: 100 }, radius: 32 }, b);
  assert.equal(r.ok, false, "silently answering a different question is the failure mode, not the fallback");
  assert.match(r.error, /no argument `center`/);
  assert.match(r.error, /did you mean `near`\?/, "the correction belongs at the moment of the mistake");
  assert.match(r.error, /NOT applied/);

  // The real name still works — the refusal must not have cost the capability.
  const ok = await legalLocate({ what: "minecraft:oak_log", near: { x: 0, z: 0 }, radius: 32 }, b);
  assert.equal(ok.ok, true);
  assert.equal(ok.result.center_from, "near");

  // And a plain call is untouched.
  const plain = await legalLocate({ what: "minecraft:oak_log", radius: 32 }, b);
  assert.equal(plain.ok, true);
  assert.equal(plain.result.center_from, "body");
});
