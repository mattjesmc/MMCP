// Live probes for WHAT ATTENTION COSTS (W2_56123_FIXES.md §§5-9): the urgent lane that rendered
// "nearest threat is now ?" in every session since it was built, the 191 zero-argument polls that
// were 18% of session w2-56123, the drown net that reported ok:true without moving, and the two
// reflexes armed all run over an empty pantry.
//
// The first test here is the one worth keeping longest: it bans "?" from EVERY urgent summary
// rather than asserting one corrected string, so it generalizes to every event type added later —
// which is what would have caught the original bug at authoring time.
//
// Staged at a probe-owned coordinate (3.92M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_920_000, Z = 3_920_000, Y = 90;
const SESSION = "probe-attention";
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
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stageRoom() {
  await cmd(`fill ${X - 8} ${Y - 2} ${Z - 8} ${X + 8} ${Y} ${Z + 8} minecraft:stone`);
  await cmd(`fill ${X - 8} ${Y + 1} ${Z - 8} ${X + 8} ${Y + 6} ${Z + 8} minecraft:air`);
  await sleep(300);
  await call("bot_body", { action: "spawn", type: "player", pos: STAND });
  await call("bot_reactions", { action: "clear" });
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("attention: a readable urgent lane, and senses that ride the acts", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1200);
    await stageRoom();
  });

  test("NO urgent summary anywhere may read '?' — and the threat says what and where", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    // DRAIN TO THE HEAD FIRST. `get_events` advances a per-session cursor by exactly what it
    // returns, so one "drain" of 200 moves 200 events forward and leaves the rest of a
    // thousands-deep backlog in front of the reader — every later page is then old news with no
    // danger in it, which is how this assertion failed while the lane was working perfectly.
    // `more:false` is the only honest "you are now at the head".
    for (let i = 0; i < 80; i++) {
      if (!(await call("get_events", { limit: 200 })).more) break;
    }
    await cmd(`summon minecraft:zombie ${X + 6} ${Y + 1} ${Z} {PersistenceRequired:1b}`);
    await sleep(3000);

    // READ WITH A TINY PAGE. The urgent lane is a PREVIEW OF WHAT IS STILL QUEUED BEHIND THIS PAGE
    // (EventLog: it renders only when `more`) — that is the whole point of it, so danger cannot be
    // buried under a page of chatter. A read big enough to contain the danger has nothing to
    // preview, which is why draining to the head and then reading 100 showed no lane at all.
    const urgent = [];
    for (let i = 0; i < 15 && !urgent.some((u) => u.type === "nearest_threat_changed"); i++) {
      urgent.push(...((await call("get_events", { limit: 1 })).urgent ?? []));
    }
    assert.ok(urgent.length > 0, "a hostile six blocks away is previewed as urgent");
    // The general rule. `str()` renders a missing key as "?", so a "?" in a headline means the
    // summary is reading a key its emitter does not write — a class of bug, not one instance.
    for (const u of urgent) {
      assert.ok(!String(u.summary).includes("?"),
        `urgent summaries must never render a missing key: ${JSON.stringify(u)}`);
    }
    const threat = urgent.find((u) => u.type === "nearest_threat_changed");
    assert.ok(threat, `the threat lane fired: ${JSON.stringify(urgent.map((u) => u.type))}`);
    assert.match(threat.summary, /zombie/, `it names the species: ${threat.summary}`);
    assert.match(threat.summary, /blocks/, `and the range: ${threat.summary}`);
    assert.match(threat.summary, /ahead|behind|left|right/, `and which way to turn: ${threat.summary}`);
    // `@e[distance=..N]` is relative to the COMMAND SOURCE (the console at world spawn), not to the
    // probe site three million blocks away — so the obvious cleanup silently kills nothing.
    await cmd(`execute positioned ${X} ${Y + 1} ${Z} run kill @e[type=minecraft:zombie,distance=..64]`);
  });

  test("watch sightings RIDE an act instead of costing a poll", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    await cmd(`setblock ${X + 3} ${Y + 1} ${Z} minecraft:diamond_block`);
    await sleep(300);
    await call("bot_watch", {
      action: "add", watches: [{ id: "shiny", block: "minecraft:diamond_block" }],
    });
    // The ray that feeds a watch. (`bot_scan` is an mcp-server LOCAL tool — memory/scan.mjs — so it
    // exists only through the shim, never on the bridge these probes talk to.)
    await call("bot_look", { at: { x: X + 3, y: Y + 1, z: Z } });
    await call("raycast_fan", {
      drone: true, h_fov: 30, v_fov: 30, steps_h: 5, steps_v: 5, range: 24, load: false,
    });
    await sleep(600);

    // Any embodied act now carries the delta — this one is a look, which asks for nothing.
    const act = await call("bot_look", { at: { x: X + 3, y: Y + 1, z: Z } });
    assert.ok(act.watches, `a sighting arrives with whatever you were doing: ${JSON.stringify(act)}`);
    assert.match(String(act.watches.shiny), /^\+\d+$/, JSON.stringify(act.watches));

    // And it is a DELTA: nothing new seen, nothing reported.
    const quiet = await call("bot_look", { at: { x: X - 3, y: Y + 1, z: Z } });
    assert.equal(quiet.watches, undefined, "a quiet act stays quiet");
    await call("bot_watch", { action: "clear" });
  });

  test("'am I there yet' is answerable without spending a movement goal", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    await call("bot_target", { action: "move", target: { at: { x: X + 7, y: Y + 1, z: Z + 7 } } });
    await sleep(500);

    const st = await call("bot_status", {});
    assert.equal(typeof st.distance_to_goal, "number", `bot_status answers it: ${JSON.stringify(st)}`);
    assert.equal(typeof st.at_goal, "boolean");
    const act = await call("bot_look", { at: { x: X, y: Y + 1, z: Z } });
    assert.equal(typeof act.distance_to_goal, "number", `and so does any act: ${JSON.stringify(act)}`);
  });

  test("arming a reflex over an empty pantry SAYS the net is not there", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom(); // a fresh body carries nothing
    const armed = await call("bot_reactions", {
      action: "arm",
      reactions: [{ id: "eat", trigger: { kind: "health_below", hearts: 8 }, response: { op: "eat" } }],
    });
    assert.ok(armed.uncovered, `an armed-but-impossible reflex is disclosed: ${JSON.stringify(armed)}`);
    assert.match(String(armed.uncovered), /eat/);
    assert.match(armed.note ?? "", /NOT COVERED/);

    await call("bot_give", { item: "minecraft:bread", count: 4 });
    const rearmed = await call("bot_reactions", {
      action: "arm",
      reactions: [{ id: "eat", trigger: { kind: "health_below", hearts: 8 }, response: { op: "eat" } }],
    });
    assert.equal(rearmed.uncovered, undefined, "with bread in the pack the warning is gone");
  });

  test("food_low is armable as a standing order (the gentle tier, below starving)", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    await call("bot_give", { item: "minecraft:bread", count: 4 });
    const r = await call("bot_reactions", {
      action: "arm",
      reactions: [{ id: "graze", trigger: { kind: "hazard", cause: "food_low" }, response: { op: "eat" } }],
    });
    assert.ok(r.armed.includes("graze"), `food_low is a real trigger cause: ${JSON.stringify(r)}`);
    assert.equal(r.uncovered, undefined);
  });

  test("the drown net concedes in a SEALED pocket instead of reporting a rescue", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageRoom();
    // A 2-tall water pocket with solid stone above: swimming up cannot reach air, ever.
    const px = X + 5, pz = Z + 5;
    await cmd(`fill ${px - 1} ${Y + 1} ${pz - 1} ${px + 1} ${Y + 4} ${pz + 1} minecraft:stone`);
    await cmd(`fill ${px} ${Y + 1} ${pz} ${px} ${Y + 2} ${pz} minecraft:water`);
    await sleep(400);
    // Spawn DRY and teleport in: since §5 a body may not START with its head underwater, which is
    // the fix that stops a respawn handing it back into a flooded cave. A real body reaches a sealed
    // pocket by moving into it, so this is also the more faithful staging.
    const sealed = await call("bot_body", { action: "spawn", type: "player", pos: STAND });
    await sleep(1200);
    await cmd(`tp ${sealed.result?.name ?? sealed.name ?? "anon"} ${px} ${Y + 1} ${pz}`);
    await sleep(800);
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "drown", trigger: { kind: "air_below", ticks: 250 },
        response: { op: "surface", ticks: 100 }, priority: 90, cooldown: 10,
      }],
    });
    await call("get_events", { limit: 200 });
    await sleep(6000); // air drains from 300; the reflex fires once it is under the threshold

    const ev = await call("get_events", { type: "reaction_done", limit: 30 });
    const surfaces = ev.events.filter((e) => e.data?.id === "drown");
    assert.ok(surfaces.length > 0, `the drown reflex fired: ${JSON.stringify(ev.events.slice(-3))}`);
    // THE POINT: it must not report success from a pocket it cannot leave. A reflex that always
    // succeeds can never be suspended for failing, so the agent is never told its net is missing.
    for (const s of surfaces) {
      assert.equal(s.data.ok, false, `honest about the sealed pocket: ${JSON.stringify(s.data)}`);
      assert.match(String(s.data.reason), /no_surface_reachable|still_submerged/);
    }
    await call("bot_reactions", { action: "clear" });
  });
});
