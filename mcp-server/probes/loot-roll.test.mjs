// roll_loot, live (RELEASE_1.md §E6).
//
// The claim under test: the running game owns the loot tables, so "what does this produce, and how
// often" is answerable without mining anything, killing anything, or opening a chest — and without
// the three blindnesses of the route that already existed. `run_command "/loot"` puts its results in
// an inventory rather than in the reply, rolls once where the question is a distribution, and answers
// ok:true for a command that failed.
//
// Three of these cases are arbiters rather than assertions against a constant I wrote:
//
//   1. THE PUSHED TABLE. A table authored in this probe, validated by the game's own codec (§E1),
//      reloaded, seen by query_registry (§D2) and then ROLLED. That is the whole authoring chain in
//      one file, and the roll is the only step that can tell the author their table works.
//   2. THE RANDOM SEQUENCE. The tool claims it never touches the level's own loot randomness. That
//      is checkable: /random reset seeds a named sequence, /random value consumes from it, and a
//      table declaring `random_sequence` would advance exactly that sequence if the tool had let
//      vanilla pick the RNG. Reset, sample, reset, ROLL, sample — the two samples must match.
//   3. VANILLA'S OWN FACTS. Stone drops cobblestone, and stone with Silk Touch drops stone; diamond
//      ore with Fortune III yields more than one diamond per roll. Those are the game's rules, not
//      this file's, and they exercise `tool` end to end through vanilla's item-with-components syntax.
//
// It needs a world (a loaded spawn chunk for the `at` case) but owns no site: nothing is built, and
// the only write is a datapack namespace cleaned up in after(). It reloads the server datapacks once,
// which is a global resource — so this belongs in the sequential battery beside data-validate and
// registry-detail, not in a concurrent run.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const ok = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.error ?? JSON.stringify(r)}`);
  return r.result;
};
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const NS = "mcptk_loot_probe";
const SEQ = `${NS}:sequence`;

/** The item aggregate for one id, or undefined. */
const item = (r, id) => (r.items ?? []).find((i) => i.id === id);

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server (gradlew runServer) first");
});

after(async () => {
  await call("clear_data", { path: `data/${NS}`, reload: true }).catch(() => {});
});

// ---------------------------------------------------------------- vanilla's own facts

test("a block's own table is found and rolled: stone drops cobblestone", async () => {
  const r = ok(await call("roll_loot", { block: "minecraft:stone" }), "roll stone");
  assert.equal(r.subject, "block");
  assert.equal(r.table, "minecraft:blocks/stone");
  assert.equal(r.exists, true);
  assert.equal(r.param_set, "minecraft:block");
  assert.equal(r.rolls, 1);
  const cobble = item(r, "minecraft:cobblestone");
  assert.ok(cobble, `expected cobblestone, got ${JSON.stringify(r.items)}`);
  assert.equal(cobble.total, 1);
});

test("`tool` reaches the table: Silk Touch turns that cobblestone into stone", async () => {
  const silk = "minecraft:diamond_pickaxe[minecraft:enchantments={'minecraft:silk_touch':1}]";
  const r = ok(await call("roll_loot", { block: "minecraft:stone", tool: silk }), "silk touch");
  assert.ok(item(r, "minecraft:stone"), `expected stone, got ${JSON.stringify(r.items)}`);
  assert.ok(!item(r, "minecraft:cobblestone"), "silk touch must not yield cobblestone");
  assert.ok((r.supplied ?? []).includes("minecraft:tool"), `tool must be a supplied param: ${r.supplied}`);
});

// The case a modder actually has: is my drop rate right? One roll cannot answer it and vanilla's
// /loot cannot aggregate. Fortune III on diamond ore is vanilla's own ore_drops formula, so the
// expected value is the game's fact and not this file's — the assertion only needs to be loose
// enough to be about the mechanism (a bonus applied) rather than about the exact distribution.
test("`count` aggregates a distribution, and Fortune III moves it", async () => {
  const plain = ok(await call("roll_loot",
    { block: "minecraft:diamond_ore", count: 400, seed: 1 }), "plain");
  assert.equal(plain.rolls, 400);
  const plainDiamond = item(plain, "minecraft:diamond");
  assert.ok(plainDiamond, `expected diamonds, got ${JSON.stringify(plain.items)}`);
  assert.equal(plainDiamond.avg, 1, "an unenchanted pick yields exactly one per roll");
  assert.equal(plainDiamond.share, 1, "every roll should produce one");

  const fortune =
    "minecraft:diamond_pickaxe[minecraft:enchantments={'minecraft:fortune':3}]";
  const lucky = ok(await call("roll_loot",
    { block: "minecraft:diamond_ore", count: 400, seed: 1, tool: fortune }), "fortune");
  const luckyDiamond = item(lucky, "minecraft:diamond");
  assert.ok(luckyDiamond.avg > 1.4,
    `Fortune III should average well over one diamond, got ${luckyDiamond.avg}`);
  assert.ok(luckyDiamond.max > 1, `and should sometimes roll more than one, got max ${luckyDiamond.max}`);
});

test("the same seed is the same run — a distribution you can quote is one you can re-derive", async () => {
  const args = { block: "minecraft:diamond_ore", count: 50, seed: 4242 };
  const a = ok(await call("roll_loot", args), "first");
  const b = ok(await call("roll_loot", args), "second");
  assert.deepEqual(a.items, b.items, "same seed, same aggregate");
  assert.equal(a.seed, 4242, "the seed is echoed so a run can be repeated");
});

// ---------------------------------------------------------------- the honesty rules

test("an unknown table is exists:false and rolls NOTHING — not an empty table", async () => {
  const r = ok(await call("roll_loot", { table: `${NS}:no_such_table` }), "unknown");
  assert.equal(r.exists, false);
  assert.equal(r.items, undefined, "THE POINT: a miss must not report a roll it never made");
  assert.equal(r.rolls, undefined);
  assert.match(r.hint ?? "", /query_registry/, "it should point at the tool that lists what loaded");
});

// The refusal is the diagnostic. An entity table asked with only a table id cannot be rolled at all —
// vanilla's own ContextMap refuses it — and the useful answer names the parameters and the argument
// that supplies each, rather than an empty roll the caller would read as "my table is broken".
test("a table asked in the wrong context is refused BY NAME, not rolled empty", async () => {
  const r = await call("roll_loot", { table: "minecraft:entities/zombie" });
  assert.equal(r.ok, false, `should refuse: ${JSON.stringify(r.result)}`);
  assert.match(r.error, /this_entity/, r.error);
  assert.match(r.error, /give `entity`/, `it must name the argument that fixes it: ${r.error}`);
});

test("...and the argument it names is the one that works", async () => {
  const r = ok(await call("roll_loot", { entity: "minecraft:zombie", count: 30, seed: 7 }), "zombie");
  assert.equal(r.subject, "entity");
  assert.equal(r.table, "minecraft:entities/zombie");
  assert.equal(r.param_set, "minecraft:entity");
  for (const p of ["minecraft:this_entity", "minecraft:origin", "minecraft:damage_source"]) {
    assert.ok((r.supplied ?? []).includes(p), `${p} must be supplied: ${r.supplied}`);
  }
  assert.ok(item(r, "minecraft:rotten_flesh"), `zombies drop flesh: ${JSON.stringify(r.items)}`);
});

test("naming two subjects is refused rather than one of them silently winning", async () => {
  const r = await call("roll_loot", { table: "minecraft:blocks/stone", block: "minecraft:dirt" });
  assert.equal(r.ok, false);
  assert.match(r.error, /ONE subject/i, r.error);
});

// The `at` form reads a real block, so it needs a real loaded chunk — and REFUSES rather than
// inventing one, which is the first half of this case. The second half forceloads the chunk and
// gets an answer, so the refusal is proved to be about residency and not about the argument.
test("`at` alone rolls the block that is actually there, and refuses when it cannot read it", async () => {
  const at = { x: 0, y: 64, z: 0 };
  const cold = await call("roll_loot", { at: { x: 6_100_000, y: 64, z: 6_100_000 } });
  assert.equal(cold.ok, false, "an unloaded chunk must refuse, never answer from nothing");
  assert.match(cold.error, /not loaded/, cold.error);

  ok(await call("run_command", { command: "forceload add 0 0" }), "forceload");
  try {
    const r = ok(await call("roll_loot", { at }), "at 0,64,0");
    assert.equal(r.subject, "block_at");
    assert.match(r.note ?? "", /rolled the block actually at/, r.note);
    assert.ok(r.origin, "the origin it used must be reported, never left implicit");
  } finally {
    await call("run_command", { command: "forceload remove 0 0" });
  }
});

// ---------------------------------------------------------------- the authoring chain

test("push → validate → reload → query_registry → ROLL, on a table this probe wrote", async () => {
  const body = JSON.stringify({
    type: "minecraft:chest",
    random_sequence: SEQ,
    pools: [
      { rolls: 1, entries: [{ type: "minecraft:item", name: "minecraft:diamond" }] },
      {
        rolls: 1,
        entries: [{
          type: "minecraft:item",
          name: "minecraft:emerald",
          functions: [{ function: "minecraft:set_count", count: 4 }],
        }],
        conditions: [{ condition: "minecraft:random_chance", chance: 0.5 }],
      },
    ],
  });
  const path = `data/${NS}/loot_table/probe.json`;
  const pushed = ok(await call("push_data", { path, base64: b64(body), reload: true }), "push");
  assert.equal(pushed.validation?.valid, true, `§E1 should accept it: ${pushed.validation?.error}`);

  const loaded = ok(await call("query_registry",
    { registry: "loot_table", entry: `${NS}:probe` }), "query_registry");
  assert.equal(loaded.exists, true, "§D2 must be able to see a loot table at all");
  assert.ok(loaded.json, "and render it with the game's own codec");

  const r = ok(await call("roll_loot",
    { table: `${NS}:probe`, count: 200, seed: 11 }), "roll the pushed table");
  assert.equal(r.exists, true);
  assert.equal(r.param_set, "minecraft:chest");
  const diamond = item(r, "minecraft:diamond");
  assert.equal(diamond.share, 1, "the unconditional pool fires every roll");
  const emerald = item(r, "minecraft:emerald");
  assert.ok(emerald.share > 0.35 && emerald.share < 0.65,
    `a 50% pool over 200 rolls should land near half, got ${emerald.share}`);
  assert.equal(emerald.min, 4, "set_count 4 means every emerald roll is four");
  assert.equal(emerald.max, 4);
});

// THE NON-MUTATION ARBITER. The tool declares Mechanism.OBSERVE, and the natural implementation
// would break that claim without anyone noticing: LootContext.Builder.create falls back to
// server.getRandomSequence(<the table's random_sequence>), which CREATES and ADVANCES persistent
// saved data. The table pushed above declares that sequence by name, so this is testable: seed the
// sequence, take a sample, seed it identically, roll the table 200 times, take the sample again.
// A tool that let vanilla pick the RNG fails this; one that passes its own cannot.
test("rolling does not consume the level's own loot randomness", async () => {
  const sample = async () => {
    ok(await call("run_command", { command: `random reset ${SEQ} 99 false false` }), "reset");
    const r = ok(await call("run_command", { command: `random value 1..1000000 ${SEQ}` }), "value");
    const line = (r.output ?? []).join(" ");
    assert.match(line, /\d/, `expected a rolled number: ${line}`);
    return line;
  };
  const before = await sample();
  ok(await call("roll_loot", { table: `${NS}:probe`, count: 200 }), "roll between the samples");
  const after = await sample();
  assert.equal(after, before,
    "THE POINT: a read that advances the world's saved RNG is not a read");
});
