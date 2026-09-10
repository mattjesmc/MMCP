// Live probes for act-verdict honesty (toolkit 0.6.0) — the "succeeds falsely" class fixes.
//
//   1. Hands: bot_mine/bot_attack refuse item_missing for a named item not carried; bot_mine echoes
//      `tool` and warns drops_expected:false on a wrong-tier dig; bot_place refuses
//      unsupported_position WITHOUT consuming the item; bot_use reports effect/block_changed.
//   1b. bot_give counts what LANDED, on both bodies (toolkit 0.88.0). `SimpleContainer.addItem`
//      claims an empty slot with the whole stack and clamps it afterwards, so an item whose max
//      stack is 1 lost everything past the first — `bot_give {potion, count:3}` on the drone
//      answered `added:3, overflow:0` with ONE potion in the bag, while the player body (whose
//      Inventory.add splits properly) got all three. Two bodies, two answers, one of them false.
//   2. World edits: place_shape counts outcomes not intent (build-height overflow → rejected, not
//      placed; re-run over identical blocks → unchanged); set_blocks region covers only confirmed
//      writes; undo_edit with no id is session-scoped (anonymous falls back to global latest).
//   3. Streams: get_events serves a world_closed boundary after a world unload (not probed here —
//      needs a world cycle; asserted structurally in the integrated-client session instead).
//
// Staged at a probe-owned coordinate (3.35M). Forceloaded during the run.
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_350_000, Z = 3_350_000, Y = 200; // this probe file's own site

// Own session identity: probe files run CONCURRENTLY (node --test), and the drone slot is
// per-session — anonymous calls would share (and bot_spawn-replace) reach-goals' drone mid-test.
// The bridge adopts unknown ids on first sight (Sessions.touch), so a constant header suffices.
const SESSION = "probe-act-honesty";
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
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("act honesty: hands refuse/echo truthfully, edits count outcomes", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500); // forceload marks async
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 12} ${Z + 20} minecraft:air`);
    await cmd(`setblock ${X} ${Y + 1} ${Z} minecraft:diamond_ore`);
    await sleep(500);
    await call("bot_body", { action: "spawn",  pos: { x: X + 2, y: Y + 3, z: Z + 2 } });
  });

  test("bot_mine: named item not in inventory → item_missing, nothing dug", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_mine", { at: { x: X, y: Y + 1, z: Z }, item: "minecraft:netherite_pickaxe" });
    assert.equal(r.started, false, JSON.stringify(r));
    assert.equal(r.reason, "item_missing", JSON.stringify(r));
  });

  test("bot_mine: wrong-tier dig announces drops_expected:false and echoes the tool", async (t) => {
    if (!bridgeUp) return t.skip();
    // Bare hands on diamond ore: dig runs, but drops need iron+ — the start result must say so.
    const r = await call("bot_mine", { at: { x: X, y: Y + 1, z: Z } });
    assert.equal(r.started, true, JSON.stringify(r));
    assert.equal(r.drops_expected, false, JSON.stringify(r));
    assert.equal(r.tool, null, JSON.stringify(r)); // bare hands, disclosed
    await sleep(2500); // let the dig finish (diamond ore ≈ 30 ticks) before the next act
  });

  test("bot_give counts what LANDED, for an item that does not stack", async (t) => {
    if (!bridgeUp) return t.skip();
    // A potion's max stack is 1, so `count: 3` must occupy three slots or say it could not. This is
    // the shape the whole file is about: the reply agreeing with the world rather than with intent.
    const give = await call("bot_give", { item: "minecraft:potion", count: 3 });
    const inv = (await call("bot_status", { inventory: true })).inventory;
    const held = inv.slots.filter((sl) => sl.item === "minecraft:potion")
      .reduce((n, sl) => n + sl.count, 0);
    assert.equal(held, give.added,
      `every item bot_give says it added must be findable: added=${give.added} in-bag=${held} ` +
      `(${JSON.stringify(inv.slots.filter((sl) => sl.item === "minecraft:potion"))})`);
    assert.equal(held, 3, `three unstackable items need three slots: ${JSON.stringify(inv.slots)}`);
  });

  test("bot_place: unsupported position refused WITHOUT consuming the item", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_give", { item: "minecraft:torch", count: 1 });
    await call("bot_select", { item: "minecraft:torch" });
    // Mid-air next to the drone: a torch cannot survive on air.
    const r = await call("bot_place", { at: { x: X + 2, y: Y + 6, z: Z + 2 } });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, "unsupported_position", JSON.stringify(r));
    const inv = await call("bot_status", { inventory: true }).then((r) => r.inventory ?? r);
    const torch = inv.slots.find((s) => s.item === "minecraft:torch");
    assert.equal(torch?.count, 1, `torch was consumed on a refused place: ${JSON.stringify(inv)}`);
  });

  test("bot_use: no-op use reports effect:none and block_changed:false", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_give", { item: "minecraft:stick", count: 1 });
    const r = await call("bot_use", { at: { x: X + 2, y: Y, z: Z + 2 }, item: "minecraft:stick" });
    assert.equal(r.effect, "none", JSON.stringify(r));
    assert.equal(r.block_changed, false, JSON.stringify(r));
    assert.equal(r.consumed, 0, JSON.stringify(r));
  });

  test("bot_attack: named item not in inventory → item_missing", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`summon minecraft:zombie ${X + 3} ${Y + 1} ${Z + 3} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(300);
    await call("bot_goto", { to: { x: X + 3, y: Y + 3, z: Z + 3 }, wait: true });
    // WHAT THIS CASE RIDES ON, SAID OUT LOUD (V3_PLAN.md §2 F1). bot_attack now runs three gates —
    // reach, line of sight, facing — and a swing that needs a turn is no longer a refusal at all
    // but an async act ({started, action_id, eta_ticks}). This case still reads item_missing for
    // two reasons that were invisible here: DroneHands.botAttack validates a named `item` BEFORE
    // the LOS/facing gates ("a turn must never start toward a swing that can never be performed"),
    // and `nearest`:true still finds the zombie — nearestLiving is reach- AND LOS-filtered now, so
    // a target the drone cannot see is no target at all and the reply would say no_target instead.
    // Both preconditions are ASSERTED below rather than assumed, so a future re-ordering of the
    // gates fails here, in this case, naming itself.
    const me = await call("bot_status");
    const seen = (await call("get_entities", { origin: me.pos, radius: 8 })).entities ?? [];
    const z = seen.find((e) => e.type === "minecraft:zombie");
    assert.ok(z, `the staged zombie must be the nearest living thing: ${JSON.stringify(seen)}`);
    const d = Math.hypot(z.pos.x - me.pos.x, z.pos.y - me.pos.y, z.pos.z - me.pos.z);
    assert.ok(d <= 4, `the zombie must sit inside the drone's 4-block entity reach and in plain `
      + `sight (open air above it) — otherwise this case refuses out_of_reach/no_target and never `
      + `reaches the item check at all: distance ${d.toFixed(2)}`);

    const r = await call("bot_attack", { nearest: true, item: "minecraft:netherite_sword" });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, "item_missing", JSON.stringify(r));
    // ...and INSTANTLY: a weapon the body does not carry must never start a facing turn.
    assert.notEqual(r.started, true,
      `item_missing is a synchronous refusal, not a started act: ${JSON.stringify(r)}`);
    await cmd(`kill @e[type=minecraft:zombie,distance=..64,x=${X},y=${Y},z=${Z}]`).catch(() => {});
  });

  test("place_shape: build-height overflow is rejected, not placed; region only covers writes", async (t) => {
    if (!bridgeUp) return t.skip();
    // A 1x6x1 column poking through the world ceiling (y 319 in the overworld).
    const r = await call("place_shape", {
      shape: "box", block: "minecraft:stone",
      p1: { x: X + 10, y: 317, z: Z + 10 }, p2: { x: X + 10, y: 322, z: Z + 10 },
    });
    assert.equal(r.placed, 3, JSON.stringify(r)); // 317,318,319 place; 320..322 outside
    assert.equal(r.rejected, 3, JSON.stringify(r));
    assert.equal(r.region.max.y, 319, `region over-claims past build height: ${JSON.stringify(r.region)}`);
    // Idempotent re-run: identical cells count unchanged, and nothing is undoable.
    const again = await call("place_shape", {
      shape: "box", block: "minecraft:stone",
      p1: { x: X + 10, y: 317, z: Z + 10 }, p2: { x: X + 10, y: 322, z: Z + 10 },
    });
    assert.equal(again.placed, 0, JSON.stringify(again));
    assert.equal(again.unchanged, 3, JSON.stringify(again));
    assert.equal(again.undo_id, null, JSON.stringify(again));
    await call("undo_edit", { undo_id: r.undo_id });
  });

  test("set_blocks: rejected entries stay out of region and undo", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("set_blocks", { blocks: [
      { x: X + 12, y: Y + 1, z: Z + 12, block: "minecraft:gold_block" },
      { x: X + 12, y: 400, z: Z + 12, block: "minecraft:gold_block" }, // outside build height
    ] });
    assert.equal(r.placed, 1, JSON.stringify(r));
    assert.equal(r.failed, 1, JSON.stringify(r));
    assert.equal(r.region.max.y, Y + 1, `region includes the failed entry: ${JSON.stringify(r.region)}`);
    const undo = await call("undo_edit", { undo_id: r.undo_id });
    assert.equal(undo.restored, 1, JSON.stringify(undo));
  });

  test("undo_edit without id: defaults to THIS session's latest edit and names the session", async (t) => {
    if (!bridgeUp) return t.skip();
    const e = await call("set_blocks", { blocks: [
      { x: X + 14, y: Y + 1, z: Z + 14, block: "minecraft:iron_block" },
    ] });
    const undo = await call("undo_edit", {});
    assert.equal(undo.undo_id, e.undo_id, JSON.stringify(undo));
    assert.equal(undo.session, SESSION, JSON.stringify(undo));
  });

  test("destroy goal on an already-empty cell: already_clear, never a fake harvest", async (t) => {
    if (!bridgeUp) return t.skip();
    // The 2026-08-09 survival failure mode: an agent invented coordinates from scan tallies and
    // every destroy at an empty guessed cell completed "achieved" — indistinguishable from a
    // real harvest, so it kept guessing. The verdict must SAY nothing was mined.
    const air = await call("bot_target", {
      action: "destroy", target: { at: { x: X + 5, y: Y + 2, z: Z + 5 } }, wait: true,
    });
    assert.equal(air.outcome, "already_clear", JSON.stringify(air));
    assert.match(String(air.note ?? ""), /nothing was mined/,
      `the no-op is named, with the coordinate remedy: ${JSON.stringify(air)}`);
    assert.ok(!air.ledger?.mined?.length,
      `an empty cell yields no mined entries: ${JSON.stringify(air.ledger)}`);
    // Contrast: a REAL block still completes achieved with the mine in the ledger.
    const real = await call("bot_target", {
      action: "destroy", target: { at: { x: X + 5, y: Y, z: Z + 5 } },
      accept_no_drops: true, wait: true,
    });
    assert.equal(real.outcome, "achieved", JSON.stringify(real));
    assert.ok(real.ledger?.mined?.length === 1,
      `the real dig is in the ledger: ${JSON.stringify(real.ledger)}`);
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`).catch(() => {});
  });
});
