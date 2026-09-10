// Memory-pattern probes — SURVIVAL_SENSES_DESIGN.md §3. Offline, no server, no model spend.
// What is defended:
//   1. Tri-state honesty: observed-match confirms, UNKNOWN dilutes and is LISTED as the
//      verification plan, observed-MISMATCH kills the candidate outright.
//   2. Ranking: most-confirmed first (a fully seen shape beats a half-seen one).
//   3. The floor: a 3+-node pattern needs ≥2 observed nodes — one stray match must not project a
//      mostly-imaginary shape.
//   4. The refusals: entity nodes, floating nodes, malformed relations, two extents in one call.
//   5. The envelope: mechanism memory_pattern, negative_is_proof always false, coverage present.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "mcobs-pattern-"));
process.env.MCPTK_MEMORY_DIR = root;
process.env.MCPTK_EMBED_BACKEND ??= "none";
const { captureWorldRead, resetCaptureCache } = await import("../capture.mjs");
const { legalLocate } = await import("../legal-locate.mjs");

const DIM = "minecraft:overworld";
const WORLD_UUID = "pattern-test-world";
const envelope = (tick = 1000) => ({ game_tick: tick, dimension: DIM, mechanism: "observe" });

/** Bridge stub: world identity + a body standing at (0, 65, 0). */
function fakeBridge() {
  return async (tool) => {
    if (tool === "get_world_info") {
      return { ok: true, result: { world_uuid: WORLD_UUID, name: "pattern-test", game_tick: 9000 } };
    }
    if (tool === "bot_status") {
      return { ok: true, result: { spawned: true, body: "walker", pos: { x: 0.5, y: 65, z: 0.5 } } };
    }
    return { ok: false, error: `unexpected bridge call ${tool}` };
  };
}
const bridge = fakeBridge();

const IRON = "minecraft:iron_ore";
const PAIR = { nodes: [{ id: "a", block: IRON }, { id: "b", block: IRON }], relations: [{ rel: "adjacent", of: ["a", "b"] }] };

// Three staged areas, scoped per test via near+radius so they never interfere:
//   (10,60,10)+(11,60,10)  — a fully SEEN adjacent iron pair
//   (20,60,20)             — a lone seen iron, neighbours never observed
//   (30,60,30)             — a seen iron whose every neighbour is OBSERVED stone (mismatch trap)
test("seed: capture the three areas through legal sightlines", async () => {
  resetCaptureCache();
  const ray = (id, x, y, z) => [0, 0, "b", id, 9.9, x, y, z];
  const fan = {
    ...envelope(1000),
    rays: [
      ray(IRON, 10, 60, 10), ray(IRON, 11, 60, 10),
      ray(IRON, 20, 60, 20),
      ray(IRON, 30, 60, 30),
      ray("minecraft:stone", 31, 60, 30), ray("minecraft:stone", 29, 60, 30),
      ray("minecraft:stone", 30, 61, 30), ray("minecraft:stone", 30, 59, 30),
      ray("minecraft:stone", 30, 60, 31), ray("minecraft:stone", 30, 60, 29),
    ],
    hits: { block: 10 },
  };
  assert.equal((await captureWorldRead("raycast_fan", {}, fan, bridge)).captured, true);
});

test("a fully seen pair is the top candidate: 2/2 matched, mirrors deduped, envelope honest", async () => {
  const r = await legalLocate({ pattern: PAIR, near: { x: 10, z: 10 }, radius: 8, limit: 8 }, bridge);
  assert.equal(r.ok, true, JSON.stringify(r));
  const res = r.result;
  assert.equal(res.mechanism, "memory_pattern");
  assert.equal(res.negative_is_proof, false, "a memory answer can never prove a negative");
  assert.ok(res.coverage, "the answer quantifies its own ignorance");

  const top = res.candidates[0];
  assert.equal(top.nodes_matched, 2, JSON.stringify(top));
  assert.equal(top.nodes_unknown, 0);
  const positions = top.observed.map((o) => o.pos.join(",")).sort();
  assert.deepEqual(positions, ["10,60,10", "11,60,10"], "the top candidate is the seen pair");
  assert.ok(top.observed.every((o) => o.seen_via === "raycast_fan"), "provenance rides every cell");

  // The symmetric pattern must not report the a↔b mirror as a second full match.
  const full = res.candidates.filter((c) => c.nodes_matched === 2);
  assert.equal(full.length, 1, `mirrored assignments are ONE candidate: ${JSON.stringify(full)}`);
  assert.match(res.render, /2\/2 nodes seen/);
});

test("a half-seen shape: unknown cells dilute, are listed as the dig-here plan, and rank below full", async () => {
  const r = await legalLocate({ pattern: PAIR, near: { x: 20, z: 20 }, radius: 8, limit: 8 }, bridge);
  assert.equal(r.ok, true, JSON.stringify(r));
  const top = r.result.candidates[0];
  assert.equal(top.nodes_matched, 1, JSON.stringify(top));
  assert.equal(top.nodes_unknown, 1);
  assert.equal(top.unknown_cells.length, 1);
  const [ux, uy, uz] = top.unknown_cells[0].pos;
  const manhattan = Math.abs(ux - 20) + Math.abs(uy - 60) + Math.abs(uz - 20);
  assert.equal(manhattan, 1, `the unknown cell is the implied neighbour: ${JSON.stringify(top.unknown_cells)}`);
  assert.match(r.result.render, /UNKNOWN: '(a|b)' would be/, "the render names the cell to go verify");
  assert.match(r.result.render, /go look or dig there/);
});

test("an observed mismatch KILLS the candidate — a contradicted shape is not a half-seen one", async () => {
  // Every neighbour of the (30,60,30) iron is OBSERVED stone: no adjacent-iron placement survives.
  // Without the kill rule this would report six 1/2 candidates identical to the half-seen case —
  // erasing the difference between "not yet looked" and "looked, and it isn't there".
  const r = await legalLocate({ pattern: PAIR, near: { x: 30, z: 30 }, radius: 8, limit: 8 }, bridge);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.candidates.length, 0, JSON.stringify(r.result.candidates));
  assert.match(r.result.render, /no candidate placement survives/);
  assert.equal(r.result.negative_is_proof, false, "even a contradiction is not world-proof — memory may be stale");
});

test("the floor: a 3-node pattern with one observed match projects nothing", async () => {
  const r = await legalLocate({
    pattern: {
      nodes: [{ id: "a", block: IRON }, { id: "b", block: "minecraft:chest" }, { id: "c", block: "minecraft:furnace" }],
      relations: [{ rel: "adjacent", of: ["a", "b"] }, { rel: "adjacent", of: ["b", "c"] }],
    },
    near: { x: 20, z: 20 }, radius: 8,
  }, bridge);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.candidates.length, 0,
    `one stray match must not carry a mostly-imaginary shape: ${JSON.stringify(r.result.candidates)}`);
  assert.match(r.result.render, /no candidate placement survives|no node of this pattern/);
});

test("refusals: entity nodes, floating nodes, bad relations, double directions", async () => {
  const entity = await legalLocate({
    pattern: { nodes: [{ id: "a", block: IRON }, { id: "e", entity: "minecraft:zombie" }] },
  }, bridge);
  assert.equal(entity.ok, false);
  assert.match(entity.error, /sense_entities/, "entity nodes point at the entity belief store");

  const floating = await legalLocate({
    pattern: { nodes: [{ id: "a", block: IRON }, { id: "b", block: IRON }] }, // no relations
  }, bridge);
  assert.equal(floating.ok, false);
  assert.match(floating.error, /no relation connecting/, "a floating node has no place to be looked for");

  const badR = await legalLocate({
    pattern: { ...PAIR, relations: [{ rel: "within", of: ["a", "b"], r: 99 }] },
  }, bridge);
  assert.equal(badR.ok, false);
  assert.match(badR.error, /1\.\.16/);

  const badRel = await legalLocate({
    pattern: { ...PAIR, relations: [{ rel: "touching", of: ["a", "b"] }] },
  }, bridge);
  assert.equal(badRel.ok, false);
  assert.match(badRel.error, /adjacent\|above\|below\|offset\|within/);

  const both = await legalLocate({ pattern: PAIR, what: "iron_ore" }, bridge);
  assert.equal(both.ok, false);
  assert.match(both.error, /exactly ONE/);
});
