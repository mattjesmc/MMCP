// Live probes for THE DIG LOCK and the hand that holds it (W2_56123_FIXES.md §§1-4). Session
// w2-56123 lost 8m20s to a single dig on a water source — hardness 100, no correct tool, 10 000
// ticks — during which every other dig in the world answered `busy` with no subject, and it lost
// another 7.5 minutes mining with a SWORD because bot_equip{mainhand} had silently overwritten the
// selected pickaxe. Neither was visible in its transcript: goal-driven digs read three fields off
// the startMine reply and dropped the rest, so `drops_expected` appears ZERO times in 6 MB.
//
// What is asserted here is exactly what could not be seen then: the refusal, the named holder, the
// cancel, the warning that survives the goal loop, and the 0.49.0 tier gate itself — a wrong-tier
// dig is precisely the case the OFFLINE battery has been passing on false premises.
//
// Staged at a probe-owned coordinate (3.88M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_880_000, Z = 3_880_000, Y = 100;
const SESSION = "probe-dig-lock";
const STAND = { x: X, y: Y + 1, z: Z };

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
/** Like call(), but returns the ERROR text instead of throwing — for refusals that are the point. */
async function callErr(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  const j = await res.json();
  return j.ok ? null : String(j.error);
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A flat stone floor with a 3-tall air room over it, and a fresh body standing in the middle. */
async function stageRoom() {
  await cmd(`fill ${X - 5} ${Y - 2} ${Z - 5} ${X + 5} ${Y} ${Z + 5} minecraft:stone`);
  await cmd(`fill ${X - 5} ${Y + 1} ${Z - 5} ${X + 5} ${Y + 5} ${Z + 5} minecraft:air`);
  await sleep(300);
  await call("bot_body", { action: "spawn", type: "player", pos: STAND });
  await call("bot_reactions", { action: "clear" });
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("dig lock: fluids refused, busy named, digs cancellable, warnings forwarded", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1200);
    await stageRoom();
  });

  test("a water source is REFUSED, not dug — and the hands stay free", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    const wet = { x: X + 2, y: Y, z: Z };
    await cmd(`setblock ${wet.x} ${wet.y} ${wet.z} minecraft:water`);
    await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
    await call("bot_select", { item: "minecraft:iron_pickaxe" });
    await sleep(300);

    const r = await call("bot_mine", { at: wet });
    assert.equal(r.started, false, `a fluid dig must not start: ${JSON.stringify(r)}`);
    assert.equal(r.reason, "fluid_target");
    assert.match(r.note, /bucket|bot_place/, "the refusal names a way out, not just a no");

    // The whole cost of the old behaviour was the LOCK, so prove there isn't one.
    const next = await call("bot_mine", { at: { x: X + 1, y: Y, z: Z }, wait: true });
    assert.ok(next.mined || next.action_id, `the next dig runs: ${JSON.stringify(next)}`);
  });

  test("`busy` names the holder, and bot_mine {action:'cancel'} frees the hands", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    await call("bot_give", { item: "minecraft:wooden_pickaxe", count: 1 });
    await call("bot_select", { item: "minecraft:wooden_pickaxe" });
    // Obsidian on a wooden pickaxe: real progress, ~5000 ticks of it. The slow-dig warning's case,
    // and a long-enough hold to test the lock without racing.
    const slow = { x: X + 3, y: Y, z: Z };
    await cmd(`setblock ${slow.x} ${slow.y} ${slow.z} minecraft:obsidian`);
    await sleep(300);

    // accept_no_drops: obsidian on wood is drop-gated with no correct tool carried, and since
    // 0.56.0 the player body REFUSES that dig unless the caller waives the drops — this test is
    // about the lock, so waive them.
    const started = await call("bot_mine", { at: slow, accept_no_drops: true });
    assert.equal(started.started, true, JSON.stringify(started));
    assert.ok(started.eta_ticks > 1200, `a multi-minute dig: ${started.eta_ticks} ticks`);
    assert.match(started.note ?? "", /seconds and blocks EVERY other dig/,
      "a dig this long announces itself up front");

    const busy = await call("bot_mine", { at: { x: X - 1, y: Y, z: Z } });
    assert.equal(busy.reason, "busy");
    assert.ok(busy.holder, `busy names its subject: ${JSON.stringify(busy)}`);
    assert.equal(busy.holder.block, "minecraft:obsidian");
    assert.deepEqual(busy.holder.at, { x: slow.x, y: slow.y, z: slow.z });
    assert.ok(busy.holder.eta_ticks > 0 && busy.holder.action_id, JSON.stringify(busy.holder));

    const cancelled = await call("bot_mine", { action: "cancel" });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(cancelled.cancelled, started.action_id);

    const freed = await call("bot_mine", { at: { x: X - 1, y: Y, z: Z }, wait: true });
    assert.ok(freed.mined, `the hands are free again: ${JSON.stringify(freed)}`);
    assert.equal((await call("bot_mine", { action: "cancel" })).reason, "no_dig",
      "cancelling nothing says so rather than claiming a cancel");
  });

  test("bot_equip REFUSES mainhand and names the remedy; armor still equips", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
    await call("bot_give", { item: "minecraft:iron_sword", count: 1 });
    await call("bot_give", { item: "minecraft:iron_chestplate", count: 1 });
    await call("bot_select", { item: "minecraft:iron_pickaxe" });

    const err = await callErr("bot_equip", { mainhand: "minecraft:iron_sword" });
    assert.ok(err, "setting the dig hand through the armor tool is refused");
    // The refusal must hand the caller a REMEDY, and since 0.71.0 that remedy is no longer
    // `bot_select`: the 0.70.0 survival trim hides that verb, and a refusal that names a tool the
    // active profile does not serve is a dead end (the lesson profiles.test.mjs now pins). What
    // replaced it works in every profile — the body arms itself for the act, and `item` on the act
    // overrides the choice. This assertion follows the remedy, not the wording of one era.
    assert.match(err, /arms itself/i, `the refusal must explain what owns the hand: ${err}`);
    assert.match(err, /`item`/, `...and name the override that works in any profile: ${err}`);

    // THE ACTUAL BUG: the pickaxe must still be in the hand afterwards.
    const st = await call("bot_status", { inventory: true });
    const held = st.inventory.slots.find((s) => s.slot === st.inventory.selectedSlot);
    assert.equal(held.item, "minecraft:iron_pickaxe", "the selected tool survived the equip attempt");

    const armor = await call("bot_equip", { chest: "minecraft:iron_chestplate" });
    assert.equal(armor.ok, true, `armor is still bot_equip's job: ${JSON.stringify(armor)}`);
    assert.equal(armor.equipped.chest, "minecraft:iron_chestplate", JSON.stringify(armor));
    // Read the VALUE from bot_status, not from the equip reply: equipment attribute modifiers
    // settle on the entity's next tick, so the reply's own `armor` is a tick stale (the same
    // workaround probes/reflexes-equip.test.mjs has always used).
    await sleep(300);
    assert.ok((await call("bot_status", {})).armor > 0, "the chestplate is really worn");
  });

  test("THE TIER GATE, live: a sword on stone is REFUSED — waived, it collects NOTHING and says so", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    await call("bot_give", { item: "minecraft:iron_sword", count: 1 });
    await call("bot_select", { item: "minecraft:iron_sword" });
    const at = { x: X + 1, y: Y, z: Z };
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:stone`);
    await sleep(300);

    // 0.56.0: the warning became a refusal — w1's session read drops_expected:false sixteen
    // times and mined on, so a wrong-tool dig with no correct tool carried no longer starts.
    const refused = await call("bot_mine", { at });
    assert.equal(refused.started, false, `refused, not warned: ${JSON.stringify(refused)}`);
    assert.equal(refused.reason, "wrong_tool", JSON.stringify(refused));
    assert.match(refused.note ?? "", /correct-tier/);

    // The waiver is the old contract, prediction and completion still agreeing.
    const start = await call("bot_mine", { at, accept_no_drops: true });
    assert.equal(start.started, true, JSON.stringify(start));
    assert.equal(start.drops_expected, false, `the prediction: ${JSON.stringify(start)}`);
    assert.match(start.note ?? "", /correct-tier/);

    // MATCH BY action_id, and WAIT FOR IT. Finding "the completion that mined stone" picked up
    // whichever stone dig an earlier test in this file had left in the log, so this assertion
    // passed or failed on event ordering — a probe that lies in both directions. And a sword on
    // stone is ~150 ticks (speed 1.0, hardness 1.5, wrong tool ⇒ /100), so a fixed 2s sleep read
    // the log before the dig it was about had finished.
    let mine = null;
    for (let i = 0; i < 20 && !mine; i++) {
      await sleep(700);
      const ev = await call("get_events", { type: "action_completed", limit: 20 });
      mine = ev.events.find((e) => e.data?.action_id === start.action_id);
    }
    assert.ok(mine, `this dig completed (${start.action_id}, eta ${start.eta_ticks} ticks)`);
    // START AND FINISH MUST AGREE. Before 0.49.0 the sword got the cobblestone anyway, which is
    // what taught the body that its own drops_expected warning was noise.
    assert.equal(mine.data.collected, 0, `a wrong-tier dig collects nothing: ${JSON.stringify(mine.data)}`);
    assert.equal(mine.data.drops_expected, false);
    assert.match(mine.data.note ?? "", /NOT harvested/);
  });

  test("a GOAL-driven wrong-tool destroy STOPS wrong_tool; waived, it forwards the warning", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    await call("bot_give", { item: "minecraft:iron_sword", count: 1 });
    await call("bot_select", { item: "minecraft:iron_sword" });
    const at = { x: X + 2, y: Y + 1, z: Z + 2 };
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:stone`);
    await sleep(300);
    await call("get_events", { limit: 100 }); // drain, so the assertion reads THIS goal's events

    // 0.56.0: a destroy is a HARVEST by default — the sword dig no longer runs, the goal stops
    // and names the tool problem instead of wasting the block.
    const stopped = await call("bot_target", { action: "destroy", target: { at }, wait: true });
    assert.equal(stopped.outcome, "stopped", JSON.stringify(stopped));
    assert.equal(stopped.reason, "wrong_tool", JSON.stringify(stopped));

    // Waived, the dig runs and the goal loop forwards what the hand-issued reply would have said.
    await call("bot_target", { action: "destroy", target: { at }, accept_no_drops: true, wait: true });
    const ev = await call("get_events", { type: "act_warning", limit: 10 });
    const warn = ev.events.at(-1);
    assert.ok(warn, "the goal loop announced what the hand-issued reply would have said");
    assert.equal(warn.data.drops_expected, false);
    assert.equal(warn.data.tool, "minecraft:iron_sword");
    assert.equal(warn.data.goal_driven, true);
  });
});
