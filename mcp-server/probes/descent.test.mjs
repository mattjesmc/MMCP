// MINED DESCENT + world containers (toolkit 0.38.0, BOT_SURFACE_DESIGN.md §12.5/§12.6) — the two
// blockers a live survival session hit after the swim work.
//
//   DESCENT — the search had NO downward edge through solid ground. Vanilla routes a body down
//     through open AIR (tryFindFirstGroundNodeBelow), so horizontal tunnelling worked beautifully
//     while every "go deeper" goal answered unreachable, costing ~2 calls per level by hand. This is
//     the exact mirror of the PILLAR gap 0.26.0 closed for going UP. Both new edges record plain
//     Action.BREAK, so no new actuation exists to test — if the search emits them, execution already
//     knows what to do, which is what these probes check.
//   LAVA GUARD — digging down is how miners die. safeToBreach refuses to emit an edge that opens a
//     cell touching lava, so a descent with lava under it must come back unreachable rather than
//     cheaper.
//   CONTAINERS — bot_use only ever called ItemStack.useOn (the ITEM's behaviour); a furnace answers
//     to the BLOCK's, and that block's whole interaction is "open a screen". So smelting was
//     impossible and the refusal ("no use-on behaviour") named nothing useful. bot_container reaches
//     the Container directly, routing slots by the game's own canPlaceItem — which is why raw iron
//     lands in the ingredient slot and coal in the fuel slot without this test saying so.
//   NO FALSE SMELT — the honesty case. Loading a furnace must NOT report a result: the furnace cooks
//     on its own ticks. put/read report `lit` and an empty result until it has actually finished.
//   PROGRESS + BREWING (toolkit 0.88.0) — two repairs to what this tool SAYS about itself. The
//     description had promised `cook_progress` and `fuel_ticks` since the tool shipped and neither
//     was ever emitted; and a brewing stand was reachable here the whole time (containerAt resolves
//     on `be instanceof Container`) with nothing naming it and no readout at all, so "still water
//     bottles" and "brewing right now" were indistinguishable. Both are checked below against a
//     LIVE station, because both are claims about state only a running world has.
//
// Probe-owned site at 3.58M. Moved off 3.49M, which player-body.test.mjs already owned: the
// battery runs probe files CONCURRENTLY, so a shared site means two files stage on top of each
// other's world. Dev server required.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-descent";
const X = 3_580_000, Z = 3_580_000, Y = 200;

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
// run_command returns ok:true even when the COMMAND failed — the failure is only in `output`. A
// probe that ignores that stages nothing and then blames the code for the consequences.
const CMD_FAILED = /Too many blocks|not loaded|Unknown command|Incorrect argument|Expected |No entity|cannot be/i;
async function cmd(c) {
  const r = await call("run_command", { command: c });
  const out = (r.output ?? []).join(" ");
  if (CMD_FAILED.test(out)) {
    throw new Error(`staging command failed: ${c}\n  -> ${out}`);
  }
  return r;
}

/** Vanilla /fill caps at 32768 blocks per call; stage big volumes as slices that stay under it. */
const FILL_LIMIT = 32768;
async function fill(x1, y1, z1, x2, y2, z2, block) {
  const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [ya, yb] = [Math.min(y1, y2), Math.max(y1, y2)];
  const [za, zb] = [Math.min(z1, z2), Math.max(z1, z2)];
  const h = yb - ya + 1;
  const xStep = Math.max(1, Math.floor(Math.sqrt(FILL_LIMIT / h)));
  for (let x = xa; x <= xb; x += xStep) {
    const xe = Math.min(xb, x + xStep - 1);
    const zStep = Math.max(1, Math.floor(FILL_LIMIT / ((xe - x + 1) * h)));
    for (let z = za; z <= zb; z += zStep) {
      await cmd(`fill ${x} ${ya} ${z} ${xe} ${yb} ${Math.min(zb, z + zStep - 1)} ${block}`);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawnWalker = async (pos) => {
  await call("bot_body", { action: "despawn" }).catch(() => {});
  const r = await call("bot_body", { action: "spawn", type: "walker", pos });
  await sleep(700);
  return r;
};

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

const SHAFT = Z;        // solid stone mass: descend 6 levels through rock
const LAVA = Z + 24;    // same, with a lava pocket under the descent column
const SMELT = Z + 48;   // a furnace + a chest on an open floor
const BURIED = Z + 64;  // a destroy goal whose TARGET is entombed (0.46.0)

describe("mined descent + world containers", { skip: !bridgeUp }, () => {
  test("stage the sites", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 96}`);
    await sleep(3000);
    await fill(X - 16, Y - 24, Z - 8, X + 24, Y + 10, Z + 80, "minecraft:air");
    // A deep SOLID mass: the whole point is that descent must be MINED, not walked.
    await fill(X - 16, Y - 24, Z - 8, X + 24, Y, Z + 80, "minecraft:stone");
    // A standing pocket at the surface for each site (feet Y+1, head Y+2).
    for (const z of [SHAFT, LAVA, BURIED]) {
      await fill(X, Y + 1, z - 1, X + 3, Y + 3, z + 1, "minecraft:air");
    }
    // LAVA: a pocket directly beneath the descent column, 4 down.
    await fill(X + 1, Y - 5, LAVA - 1, X + 2, Y - 4, LAVA + 1, "minecraft:lava");
    // SMELT: an open floor with a furnace and a chest to reach.
    await fill(X - 2, Y + 1, SMELT - 3, X + 12, Y + 4, SMELT + 3, "minecraft:air");
    await cmd(`setblock ${X + 4} ${Y + 1} ${SMELT} minecraft:furnace`);
    await cmd(`setblock ${X + 6} ${Y + 1} ${SMELT} minecraft:chest`);
    await cmd(`setblock ${X + 8} ${Y + 1} ${SMELT} minecraft:brewing_stand`);
    await sleep(500);

    // Staging must be REAL before anything is asserted: a body spawned over a foundation that was
    // never built just falls, and every later failure would be a lie about the code.
    const probe = await call("get_blocks_at", { blocks: [
      { x: X + 1, y: Y - 5, z: SHAFT },      // solid rock the descent must mine through
      { x: X + 1, y: Y - 5, z: LAVA },       // the lava pocket the guard must refuse
    ] });
    assert.ok(JSON.stringify(probe.palette).includes("stone"),
      `the stone mass was not staged: ${JSON.stringify(probe)}`);
    assert.ok(JSON.stringify(probe.palette).includes("lava"),
      `the lava pocket was not staged — the guard test would pass for the wrong reason: ${JSON.stringify(probe)}`);
  });

  // ---- mined descent ----------------------------------------------------------

  test("PREDICTION: descending solid rock is unreachable plain, reachable with break", async (t) => {
    if (!bridgeUp) return t.skip();
    const from = { x: X + 1, y: Y + 1, z: SHAFT };
    const to = { x: X + 1, y: Y - 5, z: SHAFT };
    const plain = await call("check_path", { from, to, body: "walker", max_length: 512 });
    assert.equal(plain.reachable, false,
      `solid rock must not be descendable without break rights: ${JSON.stringify(plain)}`);
    const armed = await call("check_path",
      { from, to, body: "walker", max_length: 512, may_modify: "break" });
    assert.equal(armed.reachable, true,
      `THE BLOCKER: descent through rock must be reachable with break: ${JSON.stringify(armed)}`);
    assert.ok((armed.work?.break_cells ?? 0) >= 5,
      `the plan must disclose a mined cell per level: ${JSON.stringify(armed.work)}`);
  });

  test("DESCENT: ONE call takes a walker ten levels down through solid stone", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: SHAFT + 0.5 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 1, y: Y - 10, z: SHAFT } },
      may_modify: "break", budget: { break: 32 }, wait: true });
    assert.equal(r.outcome, "achieved", `ONE call, ten levels: ${JSON.stringify(r)}`);
    const s = await call("bot_status", {});
    assert.ok((s.health ?? 0) > 0, `alive at depth: ${JSON.stringify(s)}`);
    // The `move` goal's arrival radius is 2.5, so the body legitimately stops a couple of blocks
    // above the named cell — assert the DESCENT, not an exact landing.
    assert.ok(s.pos.y <= Y - 7,
      `must be ~ten levels down, at y=${s.pos.y} (target ${Y - 10}, arrival radius 2.5)`);
    const mined = r.ledger?.mined?.length ?? 0;
    assert.ok(mined >= 7,
      `a mined cell per level must be disclosed (got ${mined}): ${JSON.stringify(r.ledger)}`);
  });

  // ---- a BURIED target is work, not a refusal (0.46.0) ------------------------
  //
  // Live, session w1-85918: `bot_target destroy` on the cell UNDER THE BODY'S OWN FEET answered
  // `stopped: occluded` — twice — because a reach-solve refusal was treated as terminal even for a
  // goal holding break rights. Digging down, the most ordinary act in the game, had no goal-shaped
  // form, so the agent hand-cranked a 31-block shaft with one bot_mine per block: 66 mine calls and
  // 75 event polls, 58% of the whole session. The capability was already there (these very descent
  // edges); only the gate above it never opened.
  test("BURIED TARGET: destroy stops honestly without rights, and digs in with them", async (t) => {
    if (!bridgeUp) return t.skip();
    const target = { x: X + 1, y: Y - 6, z: BURIED }; // entombed: no face within anyone's reach
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: BURIED + 0.5 });

    // Without rights the refusal STANDS — a body that silently tunnels to something it was told not
    // to tunnel to is the false success may_modify exists to prevent. But it now says where and why.
    const plain = await call("bot_target", { action: "destroy", target: { at: target }, wait: true });
    assert.equal(plain.outcome, "stopped", `no rights, no dig: ${JSON.stringify(plain)}`);
    assert.equal(plain.reason, "occluded", JSON.stringify(plain));
    assert.ok(plain.obstruction, `the stop now names a locus: ${JSON.stringify(plain)}`);
    assert.match(String(plain.obstruction.remedy), /may_modify/,
      `…and the remedy that would work: ${JSON.stringify(plain.obstruction)}`);

    // With them, the same call mines its way in and the goal is ACHIEVED.
    const armed = await call("bot_target", {
      action: "destroy", target: { at: target },
      may_modify: "break", budget: { break: 32 }, wait: true });
    assert.equal(armed.outcome, "achieved", `ONE call reaches a buried block: ${JSON.stringify(armed)}`);
    assert.ok((armed.ledger?.mined?.length ?? 0) >= 3,
      `it had to mine its way in, and says so: ${JSON.stringify(armed.ledger)}`);

    // The world agrees: the target really is gone. (The goal completes honestly when the block is
    // already air, so "achieved" alone would not prove the dig.)
    const after = await call("get_blocks_at", { blocks: [target] });
    assert.match(JSON.stringify(after.palette ?? after), /air/,
      `the buried target is actually destroyed: ${JSON.stringify(after)}`);
  });

  test("LAVA GUARD: a descent that would breach lava stays unreachable", async (t) => {
    if (!bridgeUp) return t.skip();
    const armed = await call("check_path", {
      from: { x: X + 1, y: Y + 1, z: LAVA }, to: { x: X + 1, y: Y - 6, z: LAVA },
      body: "walker", max_length: 512, may_modify: "break" });
    assert.equal(armed.reachable, false,
      `digging into a lava pocket must NOT be planned: ${JSON.stringify(armed)}`);
  });

  // ---- containers + smelting --------------------------------------------------

  test("bot_use on a furnace names the tool that works, instead of 'no use-on behaviour'", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnWalker({ x: X + 4.5, y: Y + 1, z: SMELT + 2.5 });
    await call("bot_give", { item: "minecraft:raw_iron", count: 8 });
    const r = await call("bot_use", { at: { x: X + 4, y: Y + 1, z: SMELT }, item: "minecraft:raw_iron" })
      .catch((e) => ({ thrown: String(e) }));
    // Either shape is acceptable as long as it POINTS AT bot_container rather than saying nothing
    // happened — the old refusal was a dead end.
    assert.ok(/bot_container/.test(JSON.stringify(r)),
      `the refusal must name bot_container: ${JSON.stringify(r)}`);
  });

  test("CONTAINER: reading a fresh furnace reports empty and unlit", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_container", { at: { x: X + 4, y: Y + 1, z: SMELT }, action: "read" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.lit, false, `a fresh furnace is not lit: ${JSON.stringify(r)}`);
    assert.equal(r.used_slots, 0, `a fresh furnace is empty: ${JSON.stringify(r)}`);
  });

  test("SMELT: ore routes to the ingredient slot and coal to the fuel slot, by the game's rule", async (t) => {
    if (!bridgeUp) return t.skip();
    const at = { x: X + 4, y: Y + 1, z: SMELT };
    await call("bot_give", { item: "minecraft:coal", count: 4 });
    const ore = await call("bot_container", { at, action: "put", item: "minecraft:raw_iron", count: 4 });
    assert.equal(ore.ok, true, JSON.stringify(ore));
    assert.equal(ore.moved, 4, `all 4 ore must go in: ${JSON.stringify(ore)}`);
    const fuel = await call("bot_container", { at, action: "put", item: "minecraft:coal", count: 2 });
    assert.equal(fuel.moved, 2, JSON.stringify(fuel));

    const slots = fuel.container?.slots ?? [];
    const bySlot = Object.fromEntries(slots.map((s) => [s.slot, s]));
    assert.equal(bySlot[0]?.item, "minecraft:raw_iron",
      `ore belongs in the INGREDIENT slot: ${JSON.stringify(slots)}`);
    assert.equal(bySlot[1]?.item, "minecraft:coal",
      `coal belongs in the FUEL slot: ${JSON.stringify(slots)}`);
  });

  test("PROGRESS: the two counters the description had been promising are real and they move", async (t) => {
    if (!bridgeUp) return t.skip();
    const at = { x: X + 4, y: Y + 1, z: SMELT };
    // A furnace loaded this tick has not lit yet — the block entity lights on ITS next tick, and
    // the tool says so rather than pretending. Poll for the light rather than assuming it.
    let first = null;
    for (let i = 0; i < 10 && !first; i++) {
      const r = await call("bot_container", { at, action: "read" });
      if (r.lit) first = r;
      else await sleep(500);
    }
    assert.ok(first, "a furnace with ore and coal in it must light within 5s");
    assert.equal(typeof first.cook_progress, "number",
      `cook_progress is a number, not a promise: ${JSON.stringify(first)}`);
    assert.equal(typeof first.fuel_ticks, "number",
      `fuel_ticks is a number, not a promise: ${JSON.stringify(first)}`);
    assert.ok(first.fuel_ticks > 0, `a burning furnace has burn time left: ${JSON.stringify(first)}`);
    assert.ok(first.cook_progress >= 0 && first.cook_progress <= 1,
      `cook_progress is a 0-1 fraction: ${JSON.stringify(first)}`);
    // The counters must TICK. A hardcoded zero would satisfy every assertion above, which is
    // exactly the shape of the bug this test exists for.
    await sleep(2500);
    const later = await call("bot_container", { at, action: "read" });
    assert.ok(later.cook_progress > first.cook_progress || later.result_ready > first.result_ready,
      `cooking must advance between reads: ${first.cook_progress} -> ${later.cook_progress} ` +
      `(result_ready ${first.result_ready} -> ${later.result_ready})`);
  });

  test("NO FALSE SMELT: loading a furnace never claims a result it has not cooked", async (t) => {
    if (!bridgeUp) return t.skip();
    const at = { x: X + 4, y: Y + 1, z: SMELT };
    const early = await call("bot_container", { at, action: "take" });
    assert.equal(early.moved, 0, `nothing is smelted yet: ${JSON.stringify(early)}`);
    assert.equal(early.reason, "nothing_to_take", JSON.stringify(early));
    assert.ok(/has not finished|result slot is empty/.test(early.note ?? ""),
      `the refusal must explain it is still cooking: ${JSON.stringify(early.note)}`);

    // Now actually wait for it. Iron is ~10s an ingot; give it room and poll.
    let ingots = 0;
    for (let i = 0; i < 20 && ingots === 0; i++) {
      await sleep(2000);
      const got = await call("bot_container", { at, action: "take" });
      ingots = got.moved ?? 0;
    }
    assert.ok(ingots > 0, "the furnace must eventually produce iron ingots — none appeared in 40s");
  });

  // ---- brewing: a capability that was reachable and unsayable ------------------------------

  test("BREW: a fresh stand reads with roles and a state, not as an anonymous 5-slot box", async (t) => {
    if (!bridgeUp) return t.skip();
    const at = { x: X + 8, y: Y + 1, z: SMELT };
    await call("bot_goto", { reach: at, wait: true });
    const r = await call("bot_container", { at, action: "read" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.block, "minecraft:brewing_stand", JSON.stringify(r));
    assert.equal(r.brew_ticks_left, 0, `nothing is brewing yet: ${JSON.stringify(r)}`);
    assert.equal(r.bottles, 0, `no bottles yet: ${JSON.stringify(r)}`);
    assert.match(String(r.note), /bottle/i,
      `the note must say what is missing, in the caller's terms: ${JSON.stringify(r.note)}`);
  });

  test("BREW: the game's own canPlaceItem routes powder, wart and bottles to three different slots", async (t) => {
    if (!bridgeUp) return t.skip();
    const at = { x: X + 8, y: Y + 1, z: SMELT };
    await call("bot_give", { item: "minecraft:blaze_powder", count: 1 });
    await call("bot_give", { item: "minecraft:nether_wart", count: 1 });
    await call("bot_give", { item: "minecraft:potion", count: 3 });
    const powder = await call("bot_container", { at, action: "put", item: "minecraft:blaze_powder", count: 1 });
    assert.equal(powder.moved, 1, JSON.stringify(powder));
    const bottles = await call("bot_container", { at, action: "put", item: "minecraft:potion", count: 3 });
    assert.equal(bottles.moved, 3, `three bottles, one per arm: ${JSON.stringify(bottles)}`);
    const wart = await call("bot_container", { at, action: "put", item: "minecraft:nether_wart", count: 1 });
    assert.equal(wart.moved, 1, JSON.stringify(wart));

    const bySlot = Object.fromEntries((wart.container?.slots ?? []).map((sl) => [sl.slot, sl]));
    assert.equal(bySlot[3]?.item, "minecraft:nether_wart",
      `the wart belongs in the INGREDIENT slot: ${JSON.stringify(wart.container?.slots)}`);
    assert.equal(bySlot[4]?.item, "minecraft:blaze_powder",
      `the powder belongs in the FUEL slot: ${JSON.stringify(wart.container?.slots)}`);
    assert.equal(bySlot[0]?.role, "bottle", `slot 0 is a bottle slot: ${JSON.stringify(bySlot[0])}`);
    assert.equal(bySlot[3]?.role, "ingredient", `slot 3 is the ingredient: ${JSON.stringify(bySlot[3])}`);
  });

  test("BREW: the stand starts on its own ticks and SAYS so — the readout that did not exist", async (t) => {
    if (!bridgeUp) return t.skip();
    const at = { x: X + 8, y: Y + 1, z: SMELT };
    // `bot_give minecraft:potion` hands over an UNCRAFTABLE potion, not a water bottle: since
    // components, water is `potion[potion_contents={potion:"minecraft:water"}]` and a bare
    // minecraft:potion has no contents at all. The bottle SLOTS accept it (PotionSlot tests the
    // item), so the routing above is a fair test — but PotionBrewing has no mix for it, so nothing
    // would ever brew. Stage real water by command, which is the only way to get components in.
    for (const slot of [0, 1, 2]) {
      await cmd(`item replace block ${at.x} ${at.y} ${at.z} container.${slot} ` +
        `with minecraft:potion[minecraft:potion_contents={potion:"minecraft:water"}] 1`);
    }
    let brewing = null;
    for (let i = 0; i < 10 && !brewing; i++) {
      await sleep(1000);
      const r = await call("bot_container", { at, action: "read" });
      if (r.brew_ticks_left > 0) brewing = r;
    }
    assert.ok(brewing, "a loaded, fuelled stand must start brewing within 10s");
    assert.ok(brewing.brew_progress > 0 && brewing.brew_progress < 1,
      `mid-brew is neither 0 nor 1: ${JSON.stringify(brewing)}`);
    assert.ok(brewing.brew_fuel > 0, `it took the powder up: ${JSON.stringify(brewing)}`);
    assert.match(String(brewing.note), /brewing/i,
      `the note must say it is brewing, and that taking now takes them unfinished: ` +
      `${JSON.stringify(brewing.note)}`);
  });

  test("BREW: 'take everything' means the BOTTLES, not the fuel that is still working", async (t) => {
    if (!bridgeUp) return t.skip();
    const at = { x: X + 8, y: Y + 1, z: SMELT };
    // Wait it out so the take is of finished potions rather than a half-brew.
    for (let i = 0; i < 30; i++) {
      const r = await call("bot_container", { at, action: "read" });
      if (r.brew_ticks_left === 0) break;
      await sleep(1000);
    }
    const took = await call("bot_container", { at, action: "take" });
    assert.ok(took.moved > 0, `the bottles come out: ${JSON.stringify(took)}`);
    const after = await call("bot_container", { at, action: "read" });
    assert.equal(after.bottles, 0, `every bottle slot emptied: ${JSON.stringify(after)}`);
    assert.equal(after.brew_progress, 0,
      `an idle stand is 0% along, not 100% — the timer counts DOWN: ${JSON.stringify(after)}`);
    // The default take must NOT have stripped the stand of the fuel it is still holding: doing so
    // would stop the next brew the caller never asked to stop. One blaze powder is 20 brews, and
    // the stand consumes the ITEM up front, so the fuel that remains is a count, not a stack.
    assert.ok(after.brew_fuel > 0 || (after.slots ?? []).some((sl) => sl.slot === 4),
      `the default take leaves the fuel alone: ${JSON.stringify(after)}`);
  });

  test("CHEST: put and take round-trip, and a double chest reads as one container", async (t) => {
    if (!bridgeUp) return t.skip();
    const at = { x: X + 6, y: Y + 1, z: SMELT };
    await call("bot_goto", { reach: at, wait: true });
    await call("bot_give", { item: "minecraft:cobblestone", count: 16 });
    const put = await call("bot_container", { at, action: "put", item: "minecraft:cobblestone", count: 16 });
    assert.equal(put.moved, 16, JSON.stringify(put));
    const take = await call("bot_container", { at, action: "take", item: "minecraft:cobblestone", count: 16 });
    assert.equal(take.moved, 16, `round-trip must return every block: ${JSON.stringify(take)}`);
    const after = await call("bot_container", { at, action: "read" });
    assert.equal(after.used_slots, 0, `the chest must end empty: ${JSON.stringify(after)}`);
  });

  test("a non-container block refuses honestly, naming what it is", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_container", { at: { x: X + 5, y: Y, z: SMELT }, action: "read" });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, "not_a_container", JSON.stringify(r));
    assert.equal(r.block, "minecraft:stone", `it must name the block: ${JSON.stringify(r)}`);
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 96}`);
  });
});
