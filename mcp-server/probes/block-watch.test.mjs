// Live probes for the WORLD half of the event stream (toolkit 0.43.0).
//
// The stream's vocabulary was entirely body-and-entity: what hurt you, what walked near you, what
// your commands did. The world itself produced two types (weather_changed, time_of_day), so a body
// could mine for an hour past a vein of diamond and never be told — the ore WAS perceived (the
// ambient retina's fan hits it, capture indexes it) but perception and notification never met.
//
// Three things under test, and the interesting assertions are the NEGATIVE ones:
//
//   1. `bot_watch` + `block_sighted` — a subscription, not a block-change firehose. It must fire on
//      what a ray HIT and stay silent about ore behind stone (that is the legality claim; a watch
//      that reported through walls would be an X-ray with a nicer name), report each position once,
//      and answer a #tag watch with WHICH block.
//   2. Agent-declared urgency — `urgent:true` on a watch entry puts its sightings in get_events'
//      danger preview; without it they must NOT jump the queue. Urgency is authored by the watcher,
//      never inferred from the block id.
//   3. `block_near` — the contact-range reflex trigger, the tick BEFORE `hazard {in_lava}` (whose
//      own remedy text admits that reading it is already late). It must fire from lava that is
//      merely adjacent, and its radius must clamp to the cap so it cannot become a scan.
//
// Plus `inventory_full`, the loss that used to ride inside a success event.
//
// These drive `raycast_fan` directly rather than `bot_scan`: the probes talk to the BRIDGE, and
// bot_scan is a shim-side tool. The sighting hook lives on the ray, so both reach it identically.
//
// Probe-owned site at 3.56M. Needs the dev server; skips when the bridge is down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-watch";
// Probe-owned site at 3.62M — moved off 3.56M, which reflexes-interrupt.test.mjs already owned
// (the battery runs probe files CONCURRENTLY; site-map.test.mjs enforces exclusivity).
const X = 3_620_000, Z = 3_620_000, Y = 200;

async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
/** Same call, but returns the envelope so a REFUSAL can be asserted as one. */
async function attempt(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowCursor = async () => (await call("get_events", { limit: 1 })).cursor;

/** Fire `n` audited calls, so later events are genuinely QUEUED behind a page. */
async function flood(n) {
  for (let i = 0; i < n; i++) await cmd("time query gametime");
}

/** Aim the body's eye at a point, then sweep a cone around it — the sighting source under test. */
async function lookAndSweep(at) {
  await call("bot_look", { at });
  await call("raycast_fan", {
    drone: true, h_fov: 30, v_fov: 30, steps_h: 5, steps_v: 5, range: 24, load: false,
  });
}

/** Every block_sighted since `cursor`, for one watch id. */
async function sightings(cursor, watchId) {
  const r = await call("get_events", { cursor, type: "block_sighted", limit: 200 });
  return (r.events || []).filter((e) => e.data?.watch_id === watchId).map((e) => e.data);
}

/** A body at the site with a clean watchlist and no armed reflexes. */
async function freshBody() {
  await call("bot_body", { action: "despawn" });
  await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
  await call("bot_watch", { action: "clear" });
  await call("bot_reactions", { action: "clear" });
  await sleep(800);
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("bot_watch: the eyes get standing orders", { skip: !bridgeUp }, () => {
  test("stage: a flat platform with a stone wall 6 blocks east", async () => {
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await cmd(`fill ${X - 16} ${Y - 1} ${Z - 16} ${X + 16} ${Y + 8} ${Z + 16} minecraft:air`);
    await cmd(`fill ${X - 16} ${Y - 1} ${Z - 16} ${X + 16} ${Y - 1} ${Z + 16} minecraft:stone`);
    // The wall the body faces. Only its FRONT face is reachable by a ray.
    await cmd(`fill ${X + 6} ${Y} ${Z - 4} ${X + 6} ${Y + 3} ${Z + 4} minecraft:stone`);
    await cmd(`fill ${X + 7} ${Y} ${Z - 4} ${X + 7} ${Y + 3} ${Z + 4} minecraft:stone`);
    await sleep(600);
  });

  test("a watched block in a sightline is evented; the same block behind stone is NOT", async () => {
    await freshBody();
    // One diamond ore set INTO the wall's front face (visible), and one directly behind it
    // (occluded). Same block, same watch, same fan — only the sightline differs.
    await cmd(`setblock ${X + 6} ${Y + 1} ${Z} minecraft:diamond_ore replace`);
    await cmd(`setblock ${X + 7} ${Y + 1} ${Z} minecraft:diamond_ore replace`);
    await call("bot_watch", {
      action: "add",
      watches: [{ id: "diamond", block: "minecraft:diamond_ore" }],
    });
    const cursor = await nowCursor();

    await lookAndSweep({ x: X + 6.5, y: Y + 1.5, z: Z + 0.5 });
    await sleep(800);

    const seen = await sightings(cursor, "diamond");
    assert.ok(seen.length >= 1, `the visible ore must be sighted (got ${JSON.stringify(seen)})`);
    assert.ok(
      seen.some((s) => s.pos?.x === X + 6 && s.pos?.y === Y + 1 && s.pos?.z === Z),
      `the sighting carries the ore's own position (got ${JSON.stringify(seen.map((s) => s.pos))})`,
    );
    assert.ok(
      !seen.some((s) => s.pos?.x === X + 7),
      "ore BEHIND the wall must never be sighted — the ray stopped at the stone (got "
        + `${JSON.stringify(seen.map((s) => s.pos))})`,
    );
    assert.equal(seen[0].block, "minecraft:diamond_ore", "the concrete block is named");
    assert.equal(typeof seen[0].distance, "number", "…with how far away it is");
    assert.ok(seen[0].sighted_by, "…and what looked");
  });

  test("once:true reports a position once, however many times it is looked at", async () => {
    await freshBody();
    await cmd(`setblock ${X + 6} ${Y + 1} ${Z} minecraft:diamond_ore replace`);
    await call("bot_watch", {
      action: "add",
      watches: [{ id: "once", block: "minecraft:diamond_ore" }],
    });
    const cursor = await nowCursor();

    const aim = { x: X + 6.5, y: Y + 1.5, z: Z + 0.5 };
    await lookAndSweep(aim);
    await lookAndSweep(aim);
    await lookAndSweep(aim);
    await sleep(800);

    const atOre = (await sightings(cursor, "once"))
      .filter((s) => s.pos?.x === X + 6 && s.pos?.y === Y + 1 && s.pos?.z === Z);
    assert.equal(atOre.length, 1,
      `three looks at one ore is ONE sighting, not three (got ${atOre.length})`);
  });

  test("a #tag watch answers with which block matched", async () => {
    await freshBody();
    await cmd(`setblock ${X + 6} ${Y + 1} ${Z} minecraft:iron_ore replace`);
    await call("bot_watch", {
      action: "add",
      watches: [{ id: "ores", block: "#minecraft:iron_ores" }],
    });
    const cursor = await nowCursor();

    await lookAndSweep({ x: X + 6.5, y: Y + 1.5, z: Z + 0.5 });
    await sleep(800);

    const seen = await sightings(cursor, "ores");
    assert.ok(seen.length >= 1, `a tag watch fires on a member (got ${JSON.stringify(seen)})`);
    assert.equal(seen[0].block, "minecraft:iron_ore",
      "a tag watch must name the CONCRETE block — '#tag' is not an answer");
    assert.equal(seen[0].watching, "#minecraft:iron_ores", "…while echoing what was asked for");
  });

  test("urgency is the watcher's to declare: urgent:true previews, plain does not", async () => {
    await freshBody();
    await cmd(`setblock ${X + 6} ${Y + 1} ${Z} minecraft:diamond_ore replace`);
    await cmd(`setblock ${X + 6} ${Y + 2} ${Z} minecraft:gold_ore replace`);
    await call("bot_watch", {
      action: "add",
      watches: [
        { id: "danger", block: "minecraft:diamond_ore", urgent: true },
        { id: "plain", block: "minecraft:gold_ore" },
      ],
    });

    const cursor = await nowCursor();
    // Ten routine events FIRST, so both sightings are genuinely behind the page that follows.
    await flood(10);
    await lookAndSweep({ x: X + 6.5, y: Y + 2, z: Z + 0.5 });
    await sleep(800);

    const page = await call("get_events", { cursor, limit: 5 });
    assert.equal(page.more, true, "the scenario needs events queued behind the page");
    const sighted = (page.urgent || []).filter((u) => u.type === "block_sighted");
    assert.ok(
      sighted.length >= 1,
      `an urgent watch's sighting must ride the danger preview (got ${JSON.stringify(page.urgent)})`,
    );
    assert.ok(
      sighted.some((u) => (u.summary || "").includes("diamond_ore")),
      `…and its headline names the block (got ${JSON.stringify(sighted.map((u) => u.summary))})`,
    );
    // …and the plain one is NOT. This assertion is what keeps the preview worth reading.
    assert.ok(
      !sighted.some((u) => (u.summary || "").includes("gold_ore")),
      "a plain watch must NOT jump the queue — urgency is declared, not inferred (got "
        + `${JSON.stringify(sighted.map((u) => u.summary))})`,
    );

    // Both are still delivered normally: the preview consumes nothing.
    const all = await sightings(cursor, "plain");
    assert.ok(all.length >= 1, "the non-urgent sighting is still delivered in the ordinary page");
  });

  test("the watchlist is listable, replaceable by id, and capped", async () => {
    await freshBody();
    await call("bot_watch", {
      action: "add", watches: [{ id: "a", block: "minecraft:stone", within: 12 }],
    });
    await call("bot_watch", {
      action: "add", watches: [{ id: "a", block: "minecraft:dirt" }],
    });
    const listed = await call("bot_watch", { action: "list" });
    assert.equal(listed.watches.length, 1, "re-adding an id REPLACES it");
    assert.equal(listed.watches[0].block, "minecraft:dirt", "…with the new spec");

    const bad = await attempt("bot_watch", {
      action: "add", watches: [{ id: "nope", block: "minecraft:not_a_real_block" }],
    });
    assert.equal(bad.ok, false, "an unresolvable block must fail the ADD call…");

    const over = await attempt("bot_watch", {
      action: "add",
      watches: Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, block: "minecraft:stone" })),
    });
    assert.equal(over.ok, false, "…and the cap must refuse rather than silently evict");
    const after = await call("bot_watch", { action: "list" });
    assert.equal(after.watches.length, 1,
      "a refused add changes NOTHING — no half-armed watchlist");
  });
});

describe("block_near: the tick before you are already in the lava", { skip: !bridgeUp }, () => {
  test("fires from lava that is merely adjacent, and drives a response", async () => {
    await freshBody();
    // Lava two blocks east at foot height: NOT touching the body, so `hazard {in_lava}` is silent.
    await cmd(`setblock ${X + 2} ${Y} ${Z} minecraft:lava replace`);
    await sleep(400);

    const before = await call("bot_status", {});
    assert.ok(
      !(before.dangers || []).includes("in_lava"),
      "the body must NOT already be in lava — that is the whole point of this trigger",
    );

    const cursor = await nowCursor();
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "lava-guard",
        trigger: { kind: "block_near", block: "minecraft:lava", within: 3 },
        response: { op: "backstep", ticks: 10 },
        cooldown_ticks: 40,
      }],
    });
    await sleep(2000);

    const r = await call("get_events", { cursor, type: "reaction_fired", limit: 50 });
    assert.ok(
      (r.events || []).some((e) => e.data?.id === "lava-guard"),
      "adjacent lava must fire the reflex (got "
        + `${JSON.stringify((r.events || []).map((e) => e.data?.id))})`,
    );
    await call("bot_reactions", { action: "clear" });
    await cmd(`setblock ${X + 2} ${Y} ${Z} minecraft:air replace`);
  });

  test("an unresolvable block, and a missing one, are refused at ARM time", async () => {
    await freshBody();
    const noBlock = await attempt("bot_reactions", {
      action: "arm",
      reactions: [{ id: "x", trigger: { kind: "block_near" }, response: { op: "backstep" } }],
    });
    assert.equal(noBlock.ok, false, "block_near without `block` can never fire — refuse it");

    const badBlock = await attempt("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "x",
        trigger: { kind: "block_near", block: "minecraft:not_a_real_block" },
        response: { op: "backstep" },
      }],
    });
    assert.equal(badBlock.ok, false,
      "a misspelled block arms a reflex that silently never fires — worse than no reflex");

    const armed = await call("bot_reactions", { action: "list" });
    assert.equal(armed.count, 0, "…and neither refusal leaves anything armed");
  });

  test("the radius clamps to the cap, so the contact sense cannot become a prospecting scan", async () => {
    await freshBody();
    // Diamond 8 blocks away — inside the requested radius, outside the cap of 5.
    await cmd(`setblock ${X + 8} ${Y} ${Z} minecraft:diamond_ore replace`);
    await sleep(400);
    const cursor = await nowCursor();
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "prospector",
        trigger: { kind: "block_near", block: "minecraft:diamond_ore", within: 32 },
        response: { op: "backstep", ticks: 5 },
      }],
    });
    await sleep(1500);

    const r = await call("get_events", { cursor, type: "reaction_fired", limit: 50 });
    assert.ok(
      !(r.events || []).some((e) => e.data?.id === "prospector"),
      "within:32 must clamp to the cap (5) — block_near is a contact sense, and ore 8 blocks "
        + "through solid stone is a scan no body can do",
    );
    await call("bot_reactions", { action: "clear" });
    await cmd(`setblock ${X + 8} ${Y} ${Z} minecraft:air replace`);
  });
});

describe("inventory_full: the loss inside a success", { skip: !bridgeUp }, () => {
  test("mining into a full pack events the spill, not just a quiet collected:0", async () => {
    await freshBody();
    // 36 slots x 64 = a completely full player inventory, so nothing can be picked up.
    await call("bot_give", { item: "minecraft:cobblestone", count: 2304 });
    // Dirt, so the dig drops something bare-handed — the event under test is the SPILL, not the ore.
    await cmd(`setblock ${X + 1} ${Y} ${Z} minecraft:dirt replace`);
    await sleep(500);
    const cursor = await nowCursor();

    await call("bot_mine", { at: { x: X + 1, y: Y, z: Z }, wait: true });
    await sleep(800);

    const r = await call("get_events", { cursor, type: "inventory_full", limit: 50 });
    assert.ok(
      (r.events || []).length >= 1,
      "a spill must be its own event, not a collected:0 buried in a success (got "
        + `${JSON.stringify(r.events)})`,
    );
    const d = r.events[0].data;
    assert.ok(Array.isArray(d.spilled) && d.spilled.length >= 1, "…naming what fell on the ground");
    assert.ok(d.at && typeof d.at.x === "number", "…and where it fell, so it can be walked back to");

    // The same fact stays on the action's own verdict — the event is an ADDITION, not a move.
    const done = await call("get_events", { cursor, type: "action_completed", limit: 50 });
    const mine = (done.events || []).find((e) => e.data?.action === "bot_mine");
    assert.ok(mine, "the dig still reports its own completion");
    assert.equal(mine.data.collected, 0, "…and still says it collected nothing");
    await cmd(`kill @e[type=minecraft:item,x=${X},y=${Y},z=${Z},distance=..20]`);
  });
});
