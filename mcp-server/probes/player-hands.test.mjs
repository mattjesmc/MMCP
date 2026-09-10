// Live probes for PLAYER HANDS v2 + the goal-loop widening + bot_craft + the vantage goal +
// proprioception (toolkit 0.35.0 — BOT_SURFACE_DESIGN §13, SURVIVAL_MODE_PLAN §§4, 7).
//
// What §11.8b left as honest refusals, these prove as capabilities — and prove them the way the
// design argues for, not just that a call returned ok:
//
//   1. Hands on the seam: bot_place / bot_use / bot_mine / bot_select answer on a PLAYER body, and
//      the drops land in its REAL 36-slot inventory.
//   2. Dig timing is THE ENGINE'S, not our hardness×10 house rule: the same stone block digs
//      measurably FASTER with a pickaxe than bare-handed, on the player body only. That difference
//      is the whole reason Hands.digTicks exists (§13.1, "zero tuned constants").
//   3. bot_craft, both tiers: a 2x2 pocket recipe (logs → planks — the exact thing the first
//      survival session could not do) works with no table; a 3x3 recipe REFUSES
//      needs_crafting_table until a table is within reach, then succeeds. The gate is world truth,
//      never a simulated menu.
//   4. The goal loop on a player: bot_target move/destroy/place complete with a ledger.
//   5. The vantage goal: from a spot with no sightline to a marked cell, `vantage` walks to one that
//      HAS it and verdicts los_achieved; an enclosed target concedes rather than claiming success.
//   6. Proprioception: a walked path returns `traversed` rows with the real block ids of the cells
//      passed through, plus the embodied game_tick/dimension envelope that makes them capturable.
//
// Probe-owned site at 3.50M (past player-body's 3.49M). Needs the dev server; skips when it's down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-player-hands";
// Probe-owned site — 3.50M. Every probe file owns its own chunks: the 0.34.0 run of player-body on
// walker-caps' site flattened its staged courses and exposed a latent /fill cap bug.
const X = 3_500_000, Z = 3_500_000, Y = 200;

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
async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn/respawn the player body at the pen's centre and let it settle on the floor. */
async function freshBody(x = X, z = Z) {
  await call("bot_body", { action: "despawn" });
  await call("bot_body", { action: "spawn", type: "player", pos: { x, y: Y + 2, z } });
  await sleep(1500);
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("player hands v2, crafting, vantage, proprioception", { skip: !bridgeUp }, () => {
  test("stage: walled pen with a walk lane", async () => {
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    // Sized deliberately: 41x41x6 = 10,086 cells per fill, well under /fill's 32,768 cap. An
    // unsized fill fails SILENTLY (ok:true, error only in command output) — the 0.34.0 gotcha.
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 5} ${Z + 20} minecraft:air`);
    for (const [ax, az, bx, bz] of [
      [X - 20, Z - 20, X + 20, Z - 20], [X - 20, Z + 20, X + 20, Z + 20],
      [X - 20, Z - 20, X - 20, Z + 20], [X + 20, Z - 20, X + 20, Z + 20],
    ]) {
      await cmd(`fill ${ax} ${Y + 1} ${az} ${bx} ${Y + 3} ${bz} minecraft:stone`);
    }
    await cmd(`kill @e[type=minecraft:item,x=${X},y=${Y},z=${Z},distance=..48]`).catch(() => {});
  });

  // --- 1. hands on the seam ---------------------------------------------------------------------

  test("bot_place / bot_mine / bot_use answer on the player body, drops land in the real inventory", async () => {
    await freshBody();
    await call("bot_give", { item: "minecraft:oak_planks", count: 4 });
    await call("bot_select", { item: "minecraft:oak_planks" });
    const place = await callRaw("bot_place", { at: { x: X + 1, y: Y + 1, z: Z }, item: "minecraft:oak_planks" });
    assert.equal(place.ok, true, `player place: ${JSON.stringify(place.error)}`);
    assert.equal(place.result.ok, true, JSON.stringify(place.result));
    assert.equal(place.result.placed, "minecraft:oak_planks");

    // Mine it back: the drop must arrive in the player's own inventory, not the world.
    const before = (await call("bot_status", { inventory: true })).inventory.slots
      .filter((s) => s.item === "minecraft:oak_planks").reduce((n, s) => n + s.count, 0);
    const mine = await callRaw("bot_mine", { at: { x: X + 1, y: Y + 1, z: Z }, wait: true });
    assert.equal(mine.ok, true, `player mine: ${JSON.stringify(mine.error)}`);
    assert.equal(mine.result.mined, "minecraft:oak_planks", JSON.stringify(mine.result));
    assert.ok(mine.result.collected >= 1, `the drop was collected: ${JSON.stringify(mine.result.drops)}`);
    const after = (await call("bot_status", { inventory: true })).inventory.slots
      .filter((s) => s.item === "minecraft:oak_planks").reduce((n, s) => n + s.count, 0);
    assert.equal(after, before + 1, `plank count rose by the mined block (${before} -> ${after})`);

    // bot_use with a real player behind UseOnContext: a hoe tills dirt (a behaviour that wants a
    // player — the drone's null-player path is the one this replaces).
    await cmd(`setblock ${X + 2} ${Y} ${Z} minecraft:dirt`);
    await call("bot_give", { item: "minecraft:iron_hoe", count: 1 });
    await call("bot_select", { item: "minecraft:iron_hoe" });
    const use = await callRaw("bot_use", { at: { x: X + 2, y: Y, z: Z }, face: "up" });
    assert.equal(use.ok, true, `player use: ${JSON.stringify(use.error)}`);
    const tilled = await call("locate", { at: [{ x: X + 2, y: Y, z: Z }] });
    assert.match(JSON.stringify(tilled), /farmland/,
      `the hoe tilled dirt with a real player behind the use: ${JSON.stringify(use.result)}`);
    await cmd(`setblock ${X + 2} ${Y} ${Z} minecraft:stone`);
  });

  test("dig timing is the ENGINE'S: the same block costs different ticks per tool", async () => {
    // §13.1's claim, MEASURED. The signal is `eta_ticks`, reported at dig START: it is the number
    // Hands.digTicks computed, so a difference between two tools on one identical cell is the engine
    // formula showing through. The drone's hardness×10 rule is tool-blind and would print the same
    // eta twice — that is exactly what this distinguishes. (An earlier version of this test compared
    // DROPS with a "bare" hand it never actually emptied; the eta is the direct measurement.)
    const at = { x: X + 1, y: Y + 1, z: Z };
    await call("bot_give", { item: "minecraft:diamond_pickaxe", count: 1 });
    await call("bot_give", { item: "minecraft:wooden_shovel", count: 1 });

    /** Start a dig with `item` held, read its eta, then let it finish and restore the block. */
    async function etaFor(item) {
      await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:stone`);
      // accept_no_drops: naming a wrong-tier tool is REFUSED since 0.56.0; this test measures
      // engine timing, so it waives the drops to let the shovel dig run.
      const started = await callRaw("bot_mine", { at, item, accept_no_drops: true });
      assert.equal(started.ok, true, `dig with ${item}: ${JSON.stringify(started.error)}`);
      assert.equal(started.result.started, true, JSON.stringify(started.result));
      assert.equal(started.result.tool, item, `the named tool is what got wielded: ${JSON.stringify(started.result)}`);
      const eta = started.result.eta_ticks;
      assert.ok(Number.isInteger(eta) && eta > 0, `eta_ticks is a real estimate: ${eta}`);
      // Let it complete (or be superseded) so the slot is free for the next dig.
      await sleep(Math.min(12_000, eta * 50 + 1500));
      return { eta, drops: started.result.drops_expected };
    }

    const pick = await etaFor("minecraft:diamond_pickaxe");
    const shovel = await etaFor("minecraft:wooden_shovel");
    assert.ok(pick.eta < shovel.eta,
      `a diamond pickaxe digs stone faster than a wooden shovel — engine timing, not ours ` +
      `(pickaxe ${pick.eta} ticks vs shovel ${shovel.eta})`);
    // The other engine-truth signal, already in the start verdict: a wrong-tier tool is announced as
    // drop-less UP FRONT rather than silently collecting nothing.
    assert.equal(shovel.drops, false,
      `a wrong-tier dig warns drops_expected:false before starting (got ${shovel.drops})`);
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:air`);
  });

  // REGRESSION (live survival session, 2026-08-07): the body mined 16 iron ore with wood and bare
  // hands. Every dig WARNED (drops_expected:false, act_warning, "NOT harvested") and every warning
  // was ignored — the ore was destroyed for nothing, sixteen times. 0.56.0 turns the warning into
  // behavior: the player body switches to a correct pack tool by itself, and refuses the dig when
  // it carries none.
  test("tier gate v2: auto-switch to the pack's correct tool; refuse when there is none", async () => {
    await freshBody();
    await cmd(`kill @e[type=minecraft:item,x=${X},y=${Y},z=${Z},distance=..48]`).catch(() => {});
    const at = { x: X + 1, y: Y + 1, z: Z };

    // 1. No correct tool anywhere: the dig is REFUSED, not wasted.
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:iron_ore`);
    const refused = await call("bot_mine", { at });
    assert.equal(refused.started, false, JSON.stringify(refused));
    assert.equal(refused.reason, "wrong_tool", JSON.stringify(refused));
    assert.match(refused.note ?? "", /correct-tier/, "the refusal says why");

    // 2. NAMING a wrong tool is refused too, and the note points at the better one carried.
    await call("bot_give", { item: "minecraft:wooden_pickaxe", count: 1 });
    await call("bot_give", { item: "minecraft:stone_pickaxe", count: 1 });
    const named = await call("bot_mine", { at, item: "minecraft:wooden_pickaxe" });
    assert.equal(named.started, false, JSON.stringify(named));
    assert.equal(named.reason, "wrong_tool", JSON.stringify(named));
    assert.match(named.note ?? "", /stone_pickaxe/, "the refusal names the tool that works");

    // 3. Implicit tool with the right one in the pack: the hand switches BY ITSELF, the ore is real.
    await call("bot_select", { item: "minecraft:wooden_pickaxe" }); // hold the wrong one on purpose
    const swapped = await call("bot_mine", { at, wait: true });
    assert.equal(swapped.mined, "minecraft:iron_ore", JSON.stringify(swapped));
    assert.equal(swapped.tool, "minecraft:stone_pickaxe",
      `the dig swung the switched tool: ${JSON.stringify(swapped)}`);
    assert.ok(swapped.collected >= 1, `the ore was HARVESTED: ${JSON.stringify(swapped.drops)}`);
    const st = await call("bot_status", { inventory: true });
    const held = st.inventory.slots.find((s) => s.slot === st.inventory.selectedSlot);
    assert.equal(held.item, "minecraft:stone_pickaxe", "the switch is real, not a bookkeeping note");

    // 4. accept_no_drops is the deliberate escape: the dig starts, still predicting no drops.
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:diamond_ore`); // stone tier can't harvest it
    const waived = await call("bot_mine", { at, accept_no_drops: true });
    assert.equal(waived.started, true, JSON.stringify(waived));
    assert.equal(waived.drops_expected, false, JSON.stringify(waived));
    await call("bot_mine", { action: "cancel" });

    // 5. SPEED, not just tier (live 2026-08-07, round two): a whole mining descent was dug with a
    // wooden pickaxe while the stone pickaxe it had just crafted sat in slot 7 — tier-correct,
    // twice as slow, and invisible to a drops-only gate. The hand upgrades now: fastest pack tool
    // that still harvests. Silent switch (no note, no act_warning chatter), disclosed by `tool`.
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:stone`);
    await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
    await call("bot_select", { item: "minecraft:wooden_pickaxe" }); // hold the slowest correct tool
    const upgraded = await call("bot_mine", { at, wait: true });
    assert.equal(upgraded.mined, "minecraft:stone", JSON.stringify(upgraded));
    assert.equal(upgraded.tool, "minecraft:iron_pickaxe",
      `the dig upgraded to the fastest harvesting tool: ${JSON.stringify(upgraded)}`);
    assert.ok(upgraded.collected >= 1, `and still collected: ${JSON.stringify(upgraded.drops)}`);
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:air`);
  });

  // --- 3. bot_craft ------------------------------------------------------------------------------

  test("bot_craft 2x2: logs become planks with no table (the first survival session's failure)", async () => {
    await call("bot_give", { item: "minecraft:oak_log", count: 2 });
    const r = await callRaw("bot_craft", { item: "minecraft:oak_planks", count: 4 });
    assert.equal(r.ok, true, `bot_craft planks: ${JSON.stringify(r.error)}`);
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.crafted, "minecraft:oak_planks");
    assert.ok(r.result.produced >= 4, `4 planks from one log: ${JSON.stringify(r.result)}`);
    assert.ok(r.result.consumed.some((c) => c.item === "minecraft:oak_log"),
      `the log was really consumed: ${JSON.stringify(r.result.consumed)}`);
    const inv = (await call("bot_status", { inventory: true })).inventory;
    assert.ok(inv.slots.some((s) => s.item === "minecraft:oak_planks"),
      `planks are in the real inventory: ${JSON.stringify(inv.slots)}`);
  });

  test("bot_craft: a crafting table is itself 2x2-craftable, and unlocks the 3x3 tier", async () => {
    // A wooden pickaxe is 3x3 (planks over sticks). Refused without a table…
    await call("bot_give", { item: "minecraft:oak_planks", count: 16 });
    await call("bot_craft", { item: "minecraft:stick", count: 8 });
    await cmd(`fill ${X - 4} ${Y + 1} ${Z - 4} ${X + 4} ${Y + 1} ${Z + 4} minecraft:air`);
    const noTable = await callRaw("bot_craft", { item: "minecraft:wooden_pickaxe" });
    assert.equal(noTable.ok, true, `the call itself should answer, not throw: ${JSON.stringify(noTable.error)}`);
    assert.equal(noTable.result.ok, false, JSON.stringify(noTable.result));
    assert.equal(noTable.result.reason, "needs_crafting_table", JSON.stringify(noTable.result));
    assert.match(String(noTable.result.note), /place/i, "the refusal names the remedy");

    // …and the table is itself a 2x2 recipe the body can make and place, which is the whole point.
    const table = await callRaw("bot_craft", { item: "minecraft:crafting_table" });
    assert.equal(table.ok, true, `craft a table: ${JSON.stringify(table.error)}`);
    assert.equal(table.result.ok, true, JSON.stringify(table.result));
    const s = await call("bot_status", {});
    const tx = Math.floor(s.pos.x) + 1;
    const tz = Math.floor(s.pos.z);
    const placed = await callRaw("bot_place", { at: { x: tx, y: Y + 1, z: tz }, item: "minecraft:crafting_table" });
    assert.equal(placed.ok, true, `place the table: ${JSON.stringify(placed.error)}`);
    assert.equal(placed.result.ok, true, JSON.stringify(placed.result));

    // Now the 3x3 tier opens — same call, same inventory, one world fact changed.
    const withTable = await callRaw("bot_craft", { item: "minecraft:wooden_pickaxe" });
    assert.equal(withTable.ok, true, `craft at the table: ${JSON.stringify(withTable.error)}`);
    assert.equal(withTable.result.ok, true,
      `the 3x3 gate opens with a table in reach: ${JSON.stringify(withTable.result)}`);
    assert.equal(withTable.result.crafted, "minecraft:wooden_pickaxe");
    await cmd(`setblock ${tx} ${Y + 1} ${tz} minecraft:air`);
  });

  test("bot_craft refuses honestly: unknown item, no recipe, missing ingredients", async () => {
    const unknown = await callRaw("bot_craft", { item: "minecraft:not_a_real_item" });
    assert.equal(unknown.result?.reason ?? "threw", "unknown_item", JSON.stringify(unknown));
    const noRecipe = await callRaw("bot_craft", { item: "minecraft:bedrock" });
    assert.equal(noRecipe.result.ok, false);
    assert.match(String(noRecipe.result.reason), /no_recipe|ingredients_missing/, JSON.stringify(noRecipe.result));
    // Nothing to work with: a diamond block needs diamonds the body does not carry.
    const missing = await callRaw("bot_craft", { item: "minecraft:diamond_block" });
    assert.equal(missing.result.ok, false);
    assert.match(String(missing.result.reason), /ingredients_missing|needs_crafting_table/, JSON.stringify(missing.result));
  });


  // --- 3b. the stations whose grid is not a grid (toolkit 0.88.0) --------------------------------
  //
  // Smithing and stonecutting are recipes in the same recipe manager, but their menus have no block
  // entity behind them, so bot_container cannot reach them the way it reaches a furnace. They arrive
  // in bot_craft instead, under the same world gate the 3x3 tier uses — and these two tests are the
  // gate opening, which is the only part a live world can settle.

  test("bot_craft at a STONECUTTER: refused without one, cut with one in reach", async () => {
    await freshBody();
    await call("bot_give", { item: "minecraft:stone", count: 8 });
    await cmd(`fill ${X - 4} ${Y + 1} ${Z - 4} ${X + 4} ${Y + 1} ${Z + 4} minecraft:air`);
    // A stone slab is craftable in the 3x3 grid TOO, so with no station of any kind in reach the
    // grid's own refusal is what must come back — the station route may not preempt a better
    // diagnosis, which is the contract stationCraft is written to.
    const bare = await callRaw("bot_craft", { item: "minecraft:stone_slab", count: 2 });
    assert.equal(bare.ok, true, `the call answers rather than throwing: ${JSON.stringify(bare.error)}`);
    assert.equal(bare.result.ok, false, JSON.stringify(bare.result));
    assert.match(String(bare.result.reason), /needs_crafting_table|needs_stonecutter/,
      `no station in reach must name a station: ${JSON.stringify(bare.result)}`);

    const s0 = await call("bot_status", {});
    const cx = Math.floor(s0.pos.x) + 1;
    const cz = Math.floor(s0.pos.z);
    await cmd(`setblock ${cx} ${Y + 1} ${cz} minecraft:stonecutter`);
    const cut = await callRaw("bot_craft", { item: "minecraft:stone_slab", count: 2 });
    assert.equal(cut.ok, true, `cut at the stonecutter: ${JSON.stringify(cut.error)}`);
    assert.equal(cut.result.ok, true,
      `one world fact changed and the route opens: ${JSON.stringify(cut.result)}`);
    assert.equal(cut.result.station, "stonecutter", JSON.stringify(cut.result));
    assert.equal(cut.result.crafted, "minecraft:stone_slab");
    assert.ok(cut.result.consumed.some((c) => c.item === "minecraft:stone"),
      `real stone was consumed: ${JSON.stringify(cut.result.consumed)}`);
    // The yield is the reason this route is worth having: the stonecutter makes two slabs from one
    // block where the grid makes six from three, so `produced` must exceed `rounds`.
    assert.ok(cut.result.produced > cut.result.rounds,
      `the cutter's yield is better than one-for-one: ${JSON.stringify(cut.result)}`);
    await cmd(`setblock ${cx} ${Y + 1} ${cz} minecraft:air`);
  });

  test("bot_craft at a SMITHING TABLE: the netherite upgrade, which had no route at all", async () => {
    await freshBody();
    await cmd(`fill ${X - 4} ${Y + 1} ${Z - 4} ${X + 4} ${Y + 1} ${Z + 4} minecraft:air`);
    for (const item of ["minecraft:diamond_sword", "minecraft:netherite_ingot",
                        "minecraft:netherite_upgrade_smithing_template"]) {
      await call("bot_give", { item, count: 1 });
    }
    // Everything in hand, no table: the refusal must be the SPECIFIC one, because "you are missing
    // an ingredient" would send a caller looking for the wrong thing.
    const noTable = await callRaw("bot_craft", { item: "minecraft:netherite_sword" });
    assert.equal(noTable.ok, true, `the call answers: ${JSON.stringify(noTable.error)}`);
    assert.equal(noTable.result.ok, false, JSON.stringify(noTable.result));
    assert.equal(noTable.result.reason, "needs_smithing_table", JSON.stringify(noTable.result));
    assert.match(String(noTable.result.note), /place/i, "the refusal names the remedy");

    const s0 = await call("bot_status", {});
    const tx = Math.floor(s0.pos.x) + 1;
    const tz = Math.floor(s0.pos.z);
    await cmd(`setblock ${tx} ${Y + 1} ${tz} minecraft:smithing_table`);
    const up = await callRaw("bot_craft", { item: "minecraft:netherite_sword" });
    assert.equal(up.ok, true, `upgrade at the table: ${JSON.stringify(up.error)}`);
    assert.equal(up.result.ok, true, JSON.stringify(up.result));
    assert.equal(up.result.station, "smithing_table", JSON.stringify(up.result));
    assert.equal(up.result.crafted, "minecraft:netherite_sword");
    // SmithingMenu.onTake shrinks all THREE input slots by one; anything less is us inventing a
    // cheaper upgrade than the game's.
    const eaten = up.result.consumed.map((c) => c.item).sort();
    assert.deepEqual(eaten, ["minecraft:diamond_sword", "minecraft:netherite_ingot",
                             "minecraft:netherite_upgrade_smithing_template"].sort(),
      `template, base AND addition are all consumed: ${JSON.stringify(up.result.consumed)}`);
    const inv = (await call("bot_status", { inventory: true })).inventory;
    assert.ok(inv.slots.some((sl) => sl.item === "minecraft:netherite_sword"),
      `the sword is in the real inventory: ${JSON.stringify(inv.slots)}`);
    await cmd(`setblock ${tx} ${Y + 1} ${tz} minecraft:air`);
  });

  // --- 4. the goal loop on a player body ---------------------------------------------------------

  test("bot_target on the player body: move, destroy and place complete with a ledger", async () => {
    await freshBody();
    const move = await callRaw("bot_target", {
      action: "move", target: { at: { x: X + 6, y: Y + 1, z: Z + 6 } }, wait: true });
    assert.equal(move.ok, true, `player move goal: ${JSON.stringify(move.error)}`);
    assert.match(String(move.result.outcome), /achieved|already_there/, JSON.stringify(move.result));

    await cmd(`setblock ${X + 7} ${Y + 1} ${Z + 6} minecraft:stone`);
    await call("bot_give", { item: "minecraft:diamond_pickaxe", count: 1 });
    await call("bot_select", { item: "minecraft:diamond_pickaxe" });
    const destroy = await callRaw("bot_target", {
      action: "destroy", target: { at: { x: X + 7, y: Y + 1, z: Z + 6 } }, wait: true });
    assert.equal(destroy.ok, true, `player destroy goal: ${JSON.stringify(destroy.error)}`);
    assert.equal(destroy.result.outcome, "achieved", JSON.stringify(destroy.result));
    assert.ok(destroy.result.ledger?.mined?.length >= 1,
      `the ledger discloses the mined cell: ${JSON.stringify(destroy.result.ledger)}`);

    await call("bot_give", { item: "minecraft:cobblestone", count: 4 });
    const place = await callRaw("bot_target", {
      action: "place", target: { at: { x: X + 7, y: Y + 1, z: Z + 6 } },
      item: "minecraft:cobblestone", wait: true });
    assert.equal(place.ok, true, `player place goal: ${JSON.stringify(place.error)}`);
    assert.equal(place.result.outcome, "achieved", JSON.stringify(place.result));
    assert.ok(place.result.ledger?.placed?.length >= 1, JSON.stringify(place.result.ledger));
    await cmd(`setblock ${X + 7} ${Y + 1} ${Z + 6} minecraft:air`);
  });

  // --- 5. the vantage goal -----------------------------------------------------------------------

  test("vantage: walks to a spot with line of sight and verdicts los_achieved", async () => {
    // A wall between body and target, with open ground around it: the sightline is blocked from
    // here, available from the far side. `move` would arrive next to the wall and still see nothing;
    // `vantage` is the goal that says "stand where you can SEE it".
    const tx = X + 12, tz = Z;
    await cmd(`fill ${X + 6} ${Y + 1} ${Z - 6} ${X + 6} ${Y + 4} ${Z + 6} minecraft:stone`);
    await cmd(`setblock ${tx} ${Y + 1} ${tz} minecraft:gold_block`);
    await freshBody(X, Z);
    const r = await callRaw("bot_target", {
      action: "vantage", target: { at: { x: tx, y: Y + 1, z: tz } }, wait: true });
    assert.equal(r.ok, true, `vantage goal: ${JSON.stringify(r.error)}`);
    assert.equal(r.result.outcome, "los_achieved",
      `the body reached a spot that SEES the target: ${JSON.stringify(r.result)}`);
    // Verify independently: a raycast from the body's OWN eye must reach the gold block. `drone:true`
    // is load-bearing — an explicit `origin` at the same point has no source entity to exclude, so
    // the ray hits the body's own hitbox at distance 0 and reports hit:"entity" (which is what the
    // first run of this probe did, and it says nothing about the vantage).
    const s = await call("bot_status", {});
    const ray = await call("raycast", {
      drone: true,
      direction: { x: tx + 0.5 - s.eye.x, y: Y + 1.5 - s.eye.y, z: tz + 0.5 - s.eye.z },
      range: 64,
    });
    assert.equal(ray.hit, "block", `the sightline ends on a block: ${JSON.stringify(ray).slice(0, 300)}`);
    assert.equal(ray.block?.block, "minecraft:gold_block",
      `the verdict is live-verifiable, not a claim: ${JSON.stringify(ray).slice(0, 400)}`);
    await cmd(`fill ${X + 6} ${Y + 1} ${Z - 6} ${X + 6} ${Y + 4} ${Z + 6} minecraft:air`);
  });

  test("vantage: an enclosed target concedes instead of claiming success", async () => {
    // Sealed on all six faces: no standable cell in range can see it. The honest answer is a stop.
    const bx = X - 12, bz = Z - 12;
    await cmd(`fill ${bx - 1} ${Y + 1} ${bz - 1} ${bx + 1} ${Y + 3} ${bz + 1} minecraft:stone`);
    await cmd(`setblock ${bx} ${Y + 2} ${bz} minecraft:diamond_block`);
    await freshBody(X, Z);
    const r = await callRaw("bot_target", {
      action: "vantage", target: { at: { x: bx, y: Y + 2, z: bz } }, wait: true });
    assert.equal(r.ok, true, `the call answers: ${JSON.stringify(r.error)}`);
    assert.equal(r.result.outcome, "stopped", JSON.stringify(r.result));
    assert.match(String(r.result.reason), /no_vantage/, JSON.stringify(r.result));
    await cmd(`fill ${bx - 1} ${Y + 1} ${bz - 1} ${bx + 1} ${Y + 3} ${bz + 1} minecraft:air`);
  });

  // --- 6. proprioception -------------------------------------------------------------------------

  test("proprioception: a walked path returns traversed cells with real ids + the tick envelope", async () => {
    await freshBody(X - 6, Z - 6);
    const r = await callRaw("bot_goto", { to: { x: X + 6, y: Y + 1, z: Z + 6 }, wait: true });
    assert.equal(r.ok, true, `goto: ${JSON.stringify(r.error)}`);
    const v = r.result;
    // The envelope: without it Node capture refuses the payload by contract (§4).
    assert.ok(Number.isInteger(v.game_tick), `embodied verdicts carry game_tick: ${JSON.stringify(v).slice(0, 300)}`);
    assert.equal(typeof v.dimension, "string", `…and dimension: ${v.dimension}`);
    assert.ok(Array.isArray(v.traversed) && v.traversed.length >= 2,
      `the trail records the cells walked: ${JSON.stringify(v.traversed)?.slice(0, 300)}`);
    for (const row of v.traversed) {
      assert.equal(row.length, 6, `row shape [x,y,z,feet,head,ground]: ${JSON.stringify(row)}`);
      const [rx, ry, rz, feet, head, ground] = row;
      for (const n of [rx, ry, rz]) assert.ok(Number.isInteger(n), `integer coords: ${JSON.stringify(row)}`);
      for (const id of [feet, head, ground]) {
        assert.match(String(id), /^[a-z0-9_.-]+:[a-z0-9_./-]+$/, `real block id, not a guess: ${id}`);
      }
      // Read at traversal time, not assumed: a walked cell's feet/head are passable, its ground is
      // NOT air (the body stood on something). Assumed-air is the defect this shape exists to avoid.
      assert.notEqual(ground, "minecraft:air", `the body stood on something at ${rx},${ry},${rz}`);
    }
    // Drained: the same trail must not be served twice (it would double-count coverage).
    const again = await callRaw("bot_goto", { to: { x: X + 6, y: Y + 1, z: Z + 6 }, wait: true });
    const rows = again.result.traversed ?? [];
    assert.ok(rows.length <= 2, `an already-there goto walks (almost) nothing: ${JSON.stringify(rows)}`);
  });

  test("cleanup", async () => {
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`kill @e[type=minecraft:item,x=${X},y=${Y},z=${Z},distance=..48]`).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
  });
});
