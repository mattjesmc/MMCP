// Probes for the route layer (ROUTE_LEDGER_DESIGN.md §9) — offline, deterministic, no bridge.
//
// What this suite is actually defending, in order of how badly it would hurt to lose it:
//
//  1. THE UNAUTHORED NEGATIVE. An unauthored route must never report `negative_is_proof: true`,
//     however cleanly its legs ran. This is the one rule that separates a route table from a
//     confident-wrong generator, and it is the thing a well-meaning refactor would "simplify" away
//     by treating the legs' verdicts as the whole story.
//  2. THE DISCLOSURE. Every routed answer says which question it actually answered. A payload that
//     silently substitutes logs for "tree" launders the interpretation into the next restatement.
//  3. THE COMPOSED NEGATIVE. One weak leg poisons the whole verdict. The failure mode being
//     guarded is the arithmetic PATTERN_SEARCH §B1 forbids: adding up N clean misses into one
//     universal claim.
//  4. THE LEDGER RECORDS BEFORE THE FALLTHROUGH. The unresolvable-`what` fallthrough rewrites a
//     concept miss into an ok:true memory answer, so a recorder placed after it sees nothing. This
//     ordering is the whole reason the ledger has any data at all.
//  5. NO FUZZY MATCHING. A near-miss stays a miss.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MCPTK_ROUTES ??= "learn";

const routes = await import("../routes.mjs");
const ledgerMod = await import("../route-ledger.mjs");
const exec = await import("../route-exec.mjs");

const { RouteTable, normalizeConcept, conceptForms, validateRoute, MAX_LEGS } = routes;
const { RouteLedger, classifyError, conceptFromError, isSilentMiss, summarize, errorShape, directionOf } = ledgerMod;

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcroutes-"));
});

// --- concept keys ---------------------------------------------------------------------------------

test("normalizeConcept strips the noise an agent adds and nothing else", () => {
  assert.equal(normalizeConcept("  Tree "), "tree");
  assert.equal(normalizeConcept("#minecraft:logs"), "logs");
  assert.equal(normalizeConcept("mymod:brass_gear"), "brass gear");
  assert.equal(normalizeConcept("oak_tree"), "oak tree");
  assert.equal(normalizeConcept("where is a tree?"), "where is a tree");
  assert.equal(normalizeConcept(null), "");
});

test("only the plural pair inflects — nothing stems, nothing fuzzy-matches", async () => {
  const t = await new RouteTable(root).load();
  assert.ok(t.lookup("tree"), "the seed concept");
  assert.ok(t.lookup("trees"), "its plural");
  assert.ok(t.lookup("TREES"), "case");
  assert.ok(t.lookup("#trees"), "a tag-shaped spelling");
  // The important half: a NEARBY word is a miss, and a miss is what the ledger wants. Answering
  // "treetop" with the tree route would be the tool answering a different question than it was asked.
  assert.equal(t.lookup("treetop"), null);
  assert.equal(t.lookup("tree farm"), null);
  assert.equal(t.lookup("wheat farm"), null, "a PLACE must never route — the memory fallthrough owns it");
});

// --- the table ------------------------------------------------------------------------------------

test("seed routes are authored, are not written to disk, and every leg is tag-shaped", async () => {
  const t = await new RouteTable(root).load();
  const all = t.all();
  assert.ok(all.length >= 12);
  for (const r of all) {
    assert.equal(r.provenance, "authored", `${r.concept} must be authored`);
    assert.deepEqual(validateRoute(r), [], `${r.concept} must validate`);
    for (const leg of r.legs) {
      assert.match(leg.what, /^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/, `${r.concept}: leg '${leg.what}' must be a namespaced id or tag`);
    }
  }
  await assert.rejects(readFile(join(root, "table.json"), "utf8"), /ENOENT/,
    "seeds live in code; loading must not materialise a file");
});

test("`ore` is the disjunction case: eight legs, at the cap, all distinct", async () => {
  const t = await new RouteTable(root).load();
  const ore = t.lookup("ore");
  assert.equal(ore.legs.length, 8, "vanilla has eight ore tags and no umbrella tag");
  assert.equal(ore.legs.length, MAX_LEGS, "and it is what sets the cap");
  assert.equal(new Set(ore.legs.map((l) => l.what)).size, 8);
});

test("a leg may only carry `what` — anything that moves the extent is refused", () => {
  const errs = validateRoute({ concept: "x", legs: [{ what: "#a:b", radius: 128 }] });
  assert.ok(errs.some((e) => /may only carry `what`/.test(e)),
    "a leg with its own radius would make the composed negative a claim about two different boxes");
  assert.ok(validateRoute({ concept: "x", legs: [] }).length, "empty legs refused");
  assert.ok(validateRoute({ concept: "", legs: [{ what: "#a:b" }] }).length, "empty concept refused");
  assert.ok(validateRoute({ concept: "x", legs: [{ what: "#a:b" }, { what: "#a:b" }] })
    .some((e) => /duplicate leg/.test(e)), "a duplicated leg would be counted twice in matches_total");
  assert.ok(validateRoute({ concept: "x", legs: Array.from({ length: MAX_LEGS + 1 }, (_, i) => ({ what: `#a:b${i}` })) })
    .some((e) => /too many legs/.test(e)));
});

test("a proposal lands UNAUTHORED, and promotion without a trial is refused", async () => {
  const t = new RouteTable(root);
  await t.load();
  const r = await t.propose({ concept: "brass", legs: [{ what: "#mymod:brass_blocks" }] }, { by: "probe" });
  assert.equal(r.provenance, "unauthored");
  assert.equal(r.authored_by, "probe");

  await assert.rejects(t.promote("brass"), /has no trial/,
    "promotion is the act that lets a definition prove a negative — it must want evidence");

  await t.recordTrial("brass", { t: "now", found: 3, negative_is_proof: true, by: "probe" });
  const promoted = await t.promote("brass", { by: "matthijs" });
  assert.equal(promoted.provenance, "authored");
  assert.equal(promoted.authored_by, "matthijs");
  assert.ok(promoted.promoted, "the promotion is dated");

  // A second table over the same dir sees it: this is cross-session state, not process state.
  const t2 = await new RouteTable(root).load();
  assert.equal(t2.lookup("brass").provenance, "authored");
});

test("the FIRST write to a fresh memory root works — no directory exists yet", async () => {
  // Found by smoke-testing the CLI, not by the suite: every other probe runs against an mkdtemp
  // root that already exists, so the one path a real first install takes was the one path untested.
  // It failed with a bare ENOENT on `.lock`, which reads as a locking problem and is a first-run problem.
  const fresh = join(root, "never", "created");
  const t = new RouteTable(fresh);
  await t.load();
  const r = await t.propose({ concept: "brass", legs: [{ what: "#mymod:brass_blocks" }] });
  assert.equal(r.provenance, "unauthored");
  assert.ok((await new RouteTable(fresh).load()).lookup("brass"));
});

test("`frozen` withholds unauthored routes from `active`, and the fingerprint says so", async () => {
  const t = new RouteTable(root);
  await t.load();
  await t.propose({ concept: "brass", legs: [{ what: "#mymod:brass_blocks" }] });

  const prev = process.env.MCPTK_ROUTES;
  try {
    process.env.MCPTK_ROUTES = "learn";
    const learnHash = t.fingerprint();
    assert.ok(t.active().some((r) => r.concept === "brass"));
    assert.match(learnHash, /^learn:/);

    process.env.MCPTK_ROUTES = "frozen";
    assert.ok(!t.active().some((r) => r.concept === "brass"),
      "a bench arm must not inherit a vocabulary that grew while some other session was playing");
    assert.match(t.fingerprint(), /^frozen:/);
    assert.notEqual(t.fingerprint(), learnHash, "the mode is part of what a run's vocabulary IS");
  } finally {
    process.env.MCPTK_ROUTES = prev;
  }
});

test("needlesFor gives the belief store the substrings a tag cannot resolve into", async () => {
  const t = await new RouteTable(root).load();
  const { needles } = t.needlesFor("wood");
  assert.deepEqual(needles.sort(), ["log", "plank"]);
  assert.equal(t.needlesFor("nonesuch"), null, "an unrouted word falls back to legal-locate's own de-pluralizer");
  // The bug this fixes, concretely: `what:"logs"` against a store full of `oak_log`.
  const { needles: logNeedles } = t.needlesFor("logs");
  assert.ok(["minecraft:oak_log", "birch_log"].every((id) => logNeedles.some((n) => id.includes(n))));
});

// --- classification -------------------------------------------------------------------------------

test("the classifier separates the buckets that want different fixes", () => {
  const cases = {
    "`what` is not a valid id: wheat farm (expected e.g. …)": "vocabulary",
    "unknown target 'tree' — not a structure, point-of-interest type, entity type, biome or block in this world.": "vocabulary",
    "unknown entity type 'minecraft:chest'": "vocabulary",
    "box volume 644808 exceeds the cap of 32768 blocks — scan a smaller box": "capability",
    "`in` cannot scope a structure search": "capability",
    "`occupancy` filters the POI index only — this was a block search": "affordance",
    "unknown detail '\"summary\"' (summary|full)": "affordance",
    "blocks[0] needs x, y and z": "affordance",
    // From the first live row the ledger ever recorded (mem_task, 2026-08-02) — it arrived
    // `unclassified`, which is the fallthrough bucket doing its job.
    "op: expected set|update|clear, got undefined": "affordance",
    "give `to` (arrive at a point) OR `reach` (get in touching range of a block), not both": "affordance",
    "locate: give exactly one of `what` or `at`": "affordance",
    "pass event_ids and/or rule": "affordance",
    "no such living entity (id 5406) in the body's level": "referent",
    "no result set named 'golds'": "referent",
    "Cannot read properties of undefined (reading 'replace')": "crash",
    "Cannot reach the MCP toolkit bridge at http://127.0.0.1:25599": "environment",
    "no server running — load a world first": "environment",
  };
  for (const [error, expected] of Object.entries(cases)) {
    assert.equal(classifyError(error).class, expected, error);
  }
});

test("environment beats every other pattern — a dead server must not read as model confusion", () => {
  assert.equal(classifyError("no server running — load a world first").class, "environment");
  assert.equal(classifyError("").class, "unclassified");
  assert.equal(classifyError(undefined).class, "unclassified");
});

test("the concept is recovered from the ERROR, not only from the arguments", () => {
  // The archive's real case: a model asking for a BLOCK through the entity door. Keying demand off
  // `locate.what` alone would have missed all three sessions that did it.
  assert.equal(conceptFromError("unknown entity type 'minecraft:chest'"), "chest");
  assert.equal(conceptFromError("`what` is not a valid id: wheat farm (expected e.g. x)"), "wheat farm");
  assert.equal(conceptFromError("unknown target 'tree' — not a structure"), "tree");
  assert.equal(conceptFromError("radius must be positive"), null);
});

test("a silent miss is an unprovable empty — a PROVEN negative is a real answer, not a failure", () => {
  const proven = { search: { negative_is_proof: true, extent: "9 of 9" }, found: [], matches_total: 0 };
  const unproven = { search: { negative_is_proof: false, extent: "4 of 9" }, found: [], matches_total: 0 };
  const hit = { search: { negative_is_proof: false }, found: [{ pos: {} }], matches_total: 1 };
  assert.equal(isSilentMiss("locate", proven), false, "proving absence is what the honesty machinery is FOR");
  assert.equal(isSilentMiss("locate", unproven), true);
  assert.equal(isSilentMiss("locate", hit), false);
  assert.equal(isSilentMiss("get_entities", unproven), false, "only searches can miss silently");
});

test("the overview re-classifies on read, so improving the classifier fixes HISTORY too", () => {
  // Written by an older build that had no pattern for it. The stored row says `unclassified`; the
  // overview must not, or the bucket that motivated the fix is the one bucket the fix never reaches.
  const rows = [
    { t: "2026-08-02T13:06:29Z", id: "m1", kind: "miss", class: "unclassified", tool: "mem_task",
      error: "op: expected set|update|clear, got undefined", session: "s-a" },
    // No error text: nothing to re-derive, so the stored class is authoritative.
    { t: "2026-08-02T13:07:00Z", id: "m2", kind: "miss", class: "silent_miss", tool: "locate", session: "s-a" },
  ];
  const s = summarize(rows);
  const classes = Object.fromEntries(s.classes.map((c) => [c.class, c.count]));
  assert.equal(classes.affordance, 1, "re-read through today's classifier");
  assert.equal(classes.silent_miss, 1, "a row with no error keeps the class only the writer could know");
  assert.equal(classes.unclassified, undefined);
});

test("errorShape collapses the varying parts so the top-refusals table reports anything at all", () => {
  const a = errorShape("box volume 644808 exceeds the cap of 32768 blocks");
  const b = errorShape("box volume 154926 exceeds the cap of 32768 blocks");
  assert.equal(a, b, "23 refusals of one shape must not read as 23 unique strings");
  assert.equal(errorShape("no such living entity (id 5406)"), errorShape("no such living entity (id -1)"));
});

test("directionOf splits the locate arities — `at` failures and `what` failures are unrelated", () => {
  assert.equal(directionOf("locate", { what: "tree" }), "what");
  assert.equal(directionOf("locate", { at: [{ x: 1, y: 2, z: 3 }] }), "at");
  assert.equal(directionOf("locate", { pattern: { nodes: [] } }), "pattern");
  assert.equal(directionOf("get_entities", { type: "zombie" }), null);
});

// --- the ledger -----------------------------------------------------------------------------------

test("the ledger is append-only, cross-session, and survives a torn line", async () => {
  const l = new RouteLedger(root);
  await l.append({ kind: "miss", class: "vocabulary", concept: "tree", session: "s-a" });
  await l.append({ kind: "miss", class: "vocabulary", concept: "tree", session: "s-b" });
  // A second process over the same dir — the real topology (one shim per Claude session).
  const l2 = new RouteLedger(root);
  await l2.append({ kind: "miss", class: "capability", session: "s-c" });
  const rows = await l2.read();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.t && r.v === 1), "every row is dated and versioned");

  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(root, "ledger.jsonl"), "{not json\n", "utf8");
  assert.equal((await l2.read()).length, 3, "a torn tail is skipped, never thrown on");
});

test("a followup is only recorded when the later call actually found something", async () => {
  const l = new RouteLedger(root);
  const miss = await l.append({ id: "m1", kind: "miss", class: "vocabulary", concept: "tree", tool: "locate", args: {} });
  l.notePending(miss);

  l.noteCall("locate");
  assert.deepEqual(l.noteSuccess("locate", { what: "#minecraft:leaves" }, { found: [] }), [],
    "an empty success answered nothing, so it continued nothing");
  l.noteCall("locate");
  const rows = l.noteSuccess("locate", { what: "#minecraft:logs" }, { found: [{}, {}, {}] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].of, "m1");
  assert.equal(rows[0].concept, "tree");
  assert.equal(rows[0].found, 3);
  assert.equal(rows[0].followed_with.what, "#minecraft:logs");
});

test("a candidate does NOT close the window — an incidental hit must not hide the real one", async () => {
  // The bug this replaced: the first qualifying success claimed the miss and dropped it, so one
  // unrelated adjacent call ate the slot and the actual continuation two calls later vanished.
  const l = new RouteLedger(root);
  l.notePending({ id: "m1", concept: "tree", tool: "locate", args: {} });
  l.noteCall("locate");
  const first = l.noteSuccess("locate", { what: "minecraft:stone" }, { found: [{}] });
  l.noteCall("locate");
  const second = l.noteSuccess("locate", { what: "#minecraft:logs" }, { found: [{}, {}] });
  assert.equal(first.length, 1);
  assert.equal(second.length, 1, "the window stays open; the reviewer sorts the candidates out");
  assert.equal(second[0].followed_with.what, "#minecraft:logs");
});

test("a followup too many calls later is not a followup", async () => {
  const l = new RouteLedger(root);
  l.notePending({ id: "m1", concept: "tree", tool: "locate", args: {} });
  for (let i = 0; i < 5; i++) l.noteCall("bot_status");
  assert.deepEqual(l.noteSuccess("locate", { what: "#minecraft:logs" }, { found: [{}] }), [],
    "five calls later is a different thought");
});

test("continuity is EVIDENCE, not a gate — the weakest case is still recorded, and says so", async () => {
  const l = new RouteLedger(root);
  l.notePending({ id: "m1", concept: "tree", tool: "locate", args: {} });
  l.noteCall("locate");
  const [row] = l.noteSuccess("locate", { what: "minecraft:stone" }, { found: [{}] });
  assert.ok(row, "nothing is discarded for scoring low — this layer is built for recall");
  assert.equal(row.continuity.remedy_taken, false);
  assert.equal(row.continuity.same_extent, null, "neither call stated an extent, so agreement proves nothing");
  // A bare word becoming a namespaced id scores, because that IS the shape of a repair — but on its
  // own it is exactly as consistent with the model simply moving on to a different, better-formed
  // question. One weak feature must not reach `strong`; that is what the threshold is for.
  assert.equal(row.continuity.more_specific, true);
  assert.equal(row.continuity.score, 1);
  assert.equal(row.continuity.strong, false);
});

test("taking the registry remedy in the gap is the strongest signal there is", async () => {
  // The mod's own error says "use query_registry to find the right id". A model that takes that
  // advice and then succeeds is narrating its own repair.
  const l = new RouteLedger(root);
  l.notePending({ id: "m1", concept: "tree", tool: "locate", args: { what: "tree", near: { x: 0, z: 0 }, radius: 32 } });
  l.noteCall("query_registry");
  l.noteCall("locate");
  const [row] = l.noteSuccess("locate", { what: "#minecraft:logs", near: { x: 0, z: 0 }, radius: 32 }, { found: [{}, {}] });
  const c = row.continuity;
  assert.equal(c.remedy_taken, true);
  assert.deepEqual(c.remedy_tools, ["query_registry"]);
  assert.equal(c.same_extent, true, "a continuation looks in the same place");
  assert.equal(c.more_specific, true, "a bare word became a namespaced tag — the shape of a repair");
  assert.equal(c.lexical, false, "and 'tree'/'logs' share no words at all, which is why lexical can never be required");
  assert.ok(c.strong);
  assert.deepEqual(c.between, ["query_registry"], "the gap is recorded, not just scored");
});

test("a moved extent reads as abandonment, not continuation", async () => {
  const l = new RouteLedger(root);
  l.notePending({ id: "m1", concept: "tree", tool: "locate", args: { what: "tree", near: { x: 0, z: 0 }, radius: 32 } });
  l.noteCall("locate");
  const [row] = l.noteSuccess("locate", { what: "minecraft:chest", near: { x: 900, z: 900 }, radius: 32 }, { found: [{}] });
  assert.equal(row.continuity.same_extent, false, "the model went somewhere else and asked something else");
  assert.equal(row.continuity.strong, false);
});

test("the escalation queue counts demand, and a rejection stops it counting", async () => {
  const l = new RouteLedger(root);
  await l.enqueue("tree", { args: { what: "tree" } });
  await l.enqueue("tree", { args: { what: "trees" } });
  let q = await l.readQueue();
  assert.equal(q.concepts.tree.count, 2);
  assert.equal(q.concepts.tree.examples.length, 2);

  await l.setQueueStatus("tree", "rejected", "it is a place, not a block family");
  await l.enqueue("tree", { args: {} });
  q = await l.readQueue();
  assert.equal(q.concepts.tree.count, 2, "a human said no; it must stop reading as demand");
});

test("summarize keeps routed calls OUT of the miss count and pairs repairs to their concept", () => {
  const rows = [
    { t: "2026-08-01T00:00:00Z", id: "m1", kind: "miss", class: "vocabulary", concept: "tree", tool: "locate", session: "s-a", error: "unknown target 'tree' — x" },
    { t: "2026-08-01T00:00:01Z", id: "m2", kind: "miss", class: "vocabulary", concept: "tree", tool: "locate", session: "s-b", error: "unknown target 'tree' — x" },
    { t: "2026-08-01T00:00:02Z", kind: "sequel", of: "m1", concept: "tree", followed_with: { what: "#minecraft:logs" }, found: 3, continuity: { strong: true, remedy_taken: true, same_extent: true } },
    // A row in the PRE-0.17.0 field name, to prove an existing ledger still parses.
    { t: "2026-08-01T00:00:02Z", kind: "sequel", of: "m2", concept: "tree", repaired_with: { what: "minecraft:stone" }, found: 1 },
    { t: "2026-08-01T00:00:03Z", kind: "routed", concept: "wood", asked: "wood", provenance: "authored", legs: ["#minecraft:logs"], found: 2 },
  ];
  const s = summarize(rows);
  assert.equal(s.total, 2, "the routed call is an ANSWER, not a miss — the bucket must shrink as routes land");
  assert.equal(s.classes[0].class, "vocabulary");
  assert.equal(s.routed, 1);
  assert.equal(s.sequels, 2);
  assert.equal(s.sessions, 2);
  const tree = s.concepts.find((c) => c.concept === "tree");
  assert.equal(tree.count, 2);
  assert.equal(tree.followups.length, 2);
  // Strong-first, NOT frequency-first: both fired once, and only one carries continuity evidence.
  // Ordering by count alone is what would let a habitual fallback outrank a real repair.
  assert.equal(tree.followups[0].followup, "#minecraft:logs");
  assert.equal(tree.followups[0].strong, 1);
  assert.equal(tree.followups[0].remedy, 1);
  assert.equal(tree.followups[0].found, 3);
  assert.equal(tree.followups[1].followup, "minecraft:stone", "the legacy-field row still parses");
  assert.equal(tree.followups[1].strong, 0);
  assert.equal(s.routes[0].concept, "wood");
});

// --- the executor ---------------------------------------------------------------------------------

/** A bridge that answers each leg from a table. Records what it was asked, so the probes can assert
 *  that the caller's extent travelled to every leg unchanged. */
function fakeBridge(perLeg) {
  const calls = [];
  const call = async (tool, args) => {
    calls.push({ tool, args });
    const spec = perLeg[args.what];
    if (!spec) return { ok: false, error: `unknown tag '#${args.what}' — not a block tag in this world` };
    return {
      ok: true,
      result: {
        perception_mode: "spatial", game_tick: 100, dimension: "minecraft:overworld",
        source: spec.source ?? "body", center: { x: 0, y: 64, z: 0 },
        found: (spec.found ?? []).map((p) => ({ handle: `h@${p.join(",")}`, kind: "block", id: spec.id, pos: { x: p[0], y: p[1], z: p[2] } })),
        matches_total: spec.total ?? (spec.found ?? []).length,
        search: { extent: "9 of 9 chunks readable", negative_is_proof: spec.proof ?? true, radius: args.radius ?? 32, tick: 100 },
      },
    };
  };
  return { call, calls };
}

test("a multi-leg route merges, ranks nearest-first, and dedupes by cell", async () => {
  const t = await new RouteTable(root).load();
  const b = fakeBridge({
    "#minecraft:logs": { id: "minecraft:oak_log", found: [[30, 64, 0], [5, 64, 0]] },
    "#minecraft:planks": { id: "minecraft:oak_planks", found: [[10, 64, 0]] },
  });
  const out = await exec.runRoute(t.lookup("wood"), { near: { x: 0, z: 0 }, radius: 40, limit: 3 }, b.call, {});
  assert.ok(out.ok);
  assert.deepEqual(out.result.found.map((f) => f.pos.x), [5, 10, 30], "nearest first, across legs");
  assert.equal(out.result.matches_total, 3);
  assert.equal(b.calls.length, 2);
  for (const c of b.calls) {
    assert.equal(c.args.radius, 40, "the caller's extent goes to every leg unchanged");
    assert.deepEqual(c.args.near, { x: 0, z: 0 });
  }
});

test("an AUTHORED route with every leg clean CAN prove a negative", async () => {
  const t = await new RouteTable(root).load();
  const b = fakeBridge({
    "#minecraft:logs": { id: "l", found: [], proof: true },
    "#minecraft:planks": { id: "p", found: [], proof: true },
  });
  const out = await exec.runRoute(t.lookup("wood"), { near: { x: 0, z: 0 } }, b.call, {});
  assert.equal(out.result.search.negative_is_proof, true,
    "a human accepted this definition and every leg read its whole extent — that IS absence");
  assert.equal(out.result.found.length, 0);
});

test("ONE weak leg poisons the whole verdict, and the cause names the leg", async () => {
  const t = await new RouteTable(root).load();
  const b = fakeBridge({
    "#minecraft:logs": { id: "l", found: [], proof: true },
    "#minecraft:planks": { id: "p", found: [], proof: false },
  });
  const out = await exec.runRoute(t.lookup("wood"), {}, b.call, {});
  assert.equal(out.result.search.negative_is_proof, false,
    "this is the arithmetic PATTERN_SEARCH §B1 forbids: N clean misses do not add up when one is not clean");
  assert.match(out.result.search.note, /#minecraft:planks/);
});

test("a leg that could not run poisons the verdict rather than shrinking the question", async () => {
  const t = await new RouteTable(root).load();
  const b = fakeBridge({ "#minecraft:logs": { id: "l", found: [], proof: true } }); // planks tag absent
  const out = await exec.runRoute(t.lookup("wood"), {}, b.call, {});
  assert.equal(out.result.search.negative_is_proof, false);
  assert.match(out.result.search.note, /1 of 2 legs did not run/);
  assert.ok(out.result.search.legs.some((l) => l.error), "the failed leg is reported, not dropped");
});

test("EVERY leg failing returns null — an empty result would report a search that never happened", async () => {
  const t = await new RouteTable(root).load();
  const b = fakeBridge({});
  assert.equal(await exec.runRoute(t.lookup("wood"), {}, b.call, {}), null);
});

test("an UNAUTHORED route can never prove a negative, however clean its legs", async () => {
  const t = new RouteTable(root);
  await t.load();
  await t.propose({ concept: "brass", legs: [{ what: "#mymod:brass_blocks" }] });
  const b = fakeBridge({ "#mymod:brass_blocks": { id: "b", found: [], proof: true } });
  const out = await exec.runRoute(t.lookup("brass"), {}, b.call, {});
  assert.equal(out.result.search.negative_is_proof, false,
    "the extent was fine; the DEFINITION was guessed, and that is a different kind of not-knowing");
  assert.match(out.result.search.note, /UNAUTHORED/);
  assert.match(out.result.search.route.caveat, /never as 'there is none'/);
});

test("the interpretation is always disclosed — the caller asked for a tree and got logs", async () => {
  const t = await new RouteTable(root).load();
  const b = fakeBridge({ "#minecraft:logs": { id: "minecraft:oak_log", found: [[3, 64, 0]] } });
  const out = await exec.runRoute(t.lookup("tree"), { what: "trees" }, b.call, {});
  const r = out.result.search.route;
  assert.equal(r.concept, "tree");
  assert.equal(r.asked, "trees");
  assert.deepEqual(r.legs, ["#minecraft:logs"]);
  assert.equal(r.provenance, "authored");
  assert.equal(out.result.search.mechanism, "route");
  assert.match(out.result.search.what, /route\[tree\] → #minecraft:logs/);
  assert.match(out.result.search.note, /a tree is its LOGS/, "the route's caveat rides its answers");
});

test("`as` is dropped on a multi-leg route, loudly, with the way to get a set back", async () => {
  const t = await new RouteTable(root).load();
  const b = fakeBridge({
    "#minecraft:logs": { id: "l", found: [[1, 64, 0]] },
    "#minecraft:planks": { id: "p", found: [] },
  });
  const out = await exec.runRoute(t.lookup("wood"), { as: "myset" }, b.call, {});
  assert.ok(b.calls.every((c) => c.args.as === undefined),
    "a set holds ONE anchor node's cells; storing the last leg's would be a fraction of the answer");
  assert.match(out.result.search.note, /was NOT stored/);
  assert.match(out.result.search.note, /#minecraft:logs/, "and it says how to get a real set");
});

test("`as` SURVIVES on a single-leg route — nothing is lost, so nothing is taken", async () => {
  const t = await new RouteTable(root).load();
  const b = fakeBridge({ "#minecraft:logs": { id: "l", found: [[1, 64, 0]] } });
  await exec.runRoute(t.lookup("tree"), { as: "myset" }, b.call, {});
  assert.equal(b.calls[0].args.as, "myset");
});

test("tryRoute fires only on a routed word, and only when the mode allows it", async () => {
  process.env.MCPTK_MEMORY_DIR = root;
  const b = fakeBridge({ "#minecraft:logs": { id: "l", found: [[1, 64, 0]] } });
  const prev = process.env.MCPTK_ROUTES;
  try {
    process.env.MCPTK_ROUTES = "off";
    assert.equal(await exec.tryRoute({ what: "tree" }, b.call, {}), null, "off means off");
    process.env.MCPTK_ROUTES = "record";
    assert.equal(await exec.tryRoute({ what: "tree" }, b.call, {}), null, "record observes, never answers");
    process.env.MCPTK_ROUTES = "learn";
    assert.equal(await exec.tryRoute({ what: "wheat farm" }, b.call, {}), null,
      "an unrouted word must fall through to the memory search, which is the right answer for a PLACE");
    const out = await exec.tryRoute({ what: "tree" }, b.call, {});
    assert.ok(out?.ok);
    assert.equal(out.result.search.route.concept, "tree");
  } finally {
    process.env.MCPTK_ROUTES = prev;
    delete process.env.MCPTK_MEMORY_DIR;
  }
});

// --- the recorder ---------------------------------------------------------------------------------

test("recordOutcome writes the miss, and writes NOTHING for an ordinary success", async () => {
  process.env.MCPTK_MEMORY_DIR = root;
  ledgerMod._resetLedger();
  try {
    await ledgerMod.recordOutcome({
      tool: "locate", args: { what: "tree", radius: 32 }, ok: false,
      error: "unknown target 'tree' — not a structure, point-of-interest type, entity type, biome or block in this world.",
      session: "s-a", world: "w1", profile: "standard", ms: 4,
    });
    await ledgerMod.recordOutcome({
      tool: "locate", args: { what: "minecraft:chest" }, ok: true,
      result: { found: [{ pos: { x: 1, y: 2, z: 3 } }], search: { negative_is_proof: true } },
      session: "s-a", world: "w1",
    });
    const rows = await new RouteLedger(join(root, "routes")).read();
    const misses = rows.filter((r) => r.kind === "miss");
    assert.equal(misses.length, 1, "the ledger is about what did NOT work; a full call log is the transcript's job");
    assert.equal(misses[0].class, "vocabulary");
    assert.equal(misses[0].concept, "tree");
    assert.equal(misses[0].direction, "what");
    assert.equal(misses[0].world, "w1");
    assert.equal(misses[0].args.radius, 32);
  } finally {
    delete process.env.MCPTK_MEMORY_DIR;
    ledgerMod._resetLedger();
  }
});

test("MCPTK_ROUTES=off records nothing at all — the pre-feature behaviour, byte for byte", async () => {
  process.env.MCPTK_MEMORY_DIR = root;
  const prev = process.env.MCPTK_ROUTES;
  ledgerMod._resetLedger();
  try {
    process.env.MCPTK_ROUTES = "off";
    const r = await ledgerMod.recordOutcome({ tool: "locate", args: { what: "tree" }, ok: false, error: "unknown target 'tree' — x" });
    assert.equal(r, null);
    assert.deepEqual(await new RouteLedger(join(root, "routes")).read(), []);
  } finally {
    process.env.MCPTK_ROUTES = prev;
    delete process.env.MCPTK_MEMORY_DIR;
    ledgerMod._resetLedger();
  }
});

test("the recorder never throws, whatever it is handed", async () => {
  // A telemetry layer that can break a tool call is worse than no telemetry layer, so the contract
  // is "does not reject" — not "returns null". Three shapes that would each throw somewhere in the
  // happy path: null args, no context at all, and a root that cannot be created.
  process.env.MCPTK_MEMORY_DIR = root;
  ledgerMod._resetLedger();
  try {
    await assert.doesNotReject(ledgerMod.recordOutcome({ tool: "locate", args: null, ok: false, error: null }));
    await assert.doesNotReject(ledgerMod.recordOutcome());
    assert.equal(await ledgerMod.recordOutcome({}), null, "a row that names no tool suggests no fix — not recorded");
  } finally {
    delete process.env.MCPTK_MEMORY_DIR;
    ledgerMod._resetLedger();
  }

  process.env.MCPTK_MEMORY_DIR = join(root, "ledger.jsonl-is-a-file", "x");
  ledgerMod._resetLedger();
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "ledger.jsonl-is-a-file"), "not a directory", "utf8");
    await assert.doesNotReject(ledgerMod.recordOutcome({
      tool: "locate", args: { what: "tree" }, ok: false, error: "unknown target 'tree' — x",
    }), "an unwritable root degrades to no telemetry, never to a broken tool call");
  } finally {
    delete process.env.MCPTK_MEMORY_DIR;
    ledgerMod._resetLedger();
  }
});

test("a vocabulary miss enqueues demand under `learn`, and does not under `frozen`", async () => {
  process.env.MCPTK_MEMORY_DIR = root;
  const prev = process.env.MCPTK_ROUTES;
  ledgerMod._resetLedger();
  const err = "`what` is not a valid id: wheat farm (expected e.g. minecraft:village_plains)";
  try {
    process.env.MCPTK_ROUTES = "frozen";
    await ledgerMod.recordOutcome({ tool: "locate", args: { what: "wheat farm" }, ok: false, error: err });
    assert.deepEqual((await new RouteLedger(join(root, "routes")).readQueue()).concepts, {},
      "a bench run must not widen the vocabulary a later run inherits");

    process.env.MCPTK_ROUTES = "learn";
    await ledgerMod.recordOutcome({ tool: "locate", args: { what: "wheat farm" }, ok: false, error: err });
    const q = await new RouteLedger(join(root, "routes")).readQueue();
    assert.equal(q.concepts["wheat farm"].count, 1);
  } finally {
    process.env.MCPTK_ROUTES = prev;
    delete process.env.MCPTK_MEMORY_DIR;
    ledgerMod._resetLedger();
  }
});
