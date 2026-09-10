// Live probe for the SWIM RIGHT — PERCEPTION_NAV_FIXES.md §2.1, batch 3.
//
// Session 983c8359, 17:38:36: `bot_goto{to:(-95,68,-10), swim:false}` answered reachable:true,
// partial:false, nodes:29. Twelve seconds later the body was at y=61.8, inWater:true, sees_sky:false
// in a flooded cave. Nothing warned it — it found out by polling bot_status, and the escape goto came
// back `stalled`. A profile right the body does not honour is worse than not having the right.
//
// The plan's hypothesis was that a may_modify repair leg re-solved with a DIFFERENT profile — the
// shape of the 2026-08-02 build-profile wedge. Reading the code first: every goal leg calls
// `goal.profile.writeArgs(args)`, and `writeArgs` does emit `swim`, with a comment at NavProfile:240
// describing a previous fix for exactly that class of bug. So this probe exists to find out which is
// true — whether the right is honoured now, and if not, WHERE it is dropped: at the solve, or by the
// body physically entering water while following a path that was legitimately solved around it.
//
// Staged at a probe-owned coordinate (3.98M). Own session. `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_980_000, Z = 3_980_000, Y = 200;
const SESSION = "probe-swim-rights";

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

/** /fill that fails loudly: run_command answers ok:true for commands the game rejected, and /fill
 *  refuses boxes over 32768 blocks — a silent no-op stages nothing and blames the code under test. */
async function fill(spec) {
  const r = await cmd(`fill ${spec}`);
  const out = (r.output ?? []).join(" ");
  if (!out || /Too many blocks|not loaded|Invalid|Expected|Unknown|Incorrect/i.test(out)) {
    throw new Error(`staging fill did NOT run: "fill ${spec}" -> ${out || "(no output)"}`);
  }
  return r;
}

let bridgeUp = true;
try {
  await call("ping");
} catch {
  bridgeUp = false;
}

// A causeway with a water channel cut across it: the ONLY straight route to the far side crosses
// water, and there is a dry way round only if the solver is willing to walk the long way.
const FAR = { x: X, y: Y, z: Z - 30 };

describe("swim rights (0.53.0): swim:false must keep the body out of water", { skip: !bridgeUp }, () => {
  test("stage a channel the route must cross", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 40} ${Z - 40} ${X + 40} ${Z + 40}`);
    await sleep(3000);
    for (let y = Y - 6; y <= Y + 6; y += 7) {
      await fill(`${X - 20} ${y} ${Z - 40} ${X + 20} ${Math.min(y + 6, Y + 6)} ${Z + 8} minecraft:air`);
    }
    // A wide stone plain, then a channel of water 10 blocks out, 5 wide and 3 deep.
    await fill(`${X - 20} ${Y - 1} ${Z - 40} ${X + 20} ${Y - 1} ${Z + 4} minecraft:stone`);
    await fill(`${X - 20} ${Y - 4} ${Z - 14} ${X + 20} ${Y - 2} ${Z - 10} minecraft:stone`);
    // GLOWSTONE FLOOR, not stone: in a cold biome an unlit pool FREEZES, and this probe would then
    // quietly assert that the body walks around a sheet of ice — passing green while measuring the
    // wrong thing. Caught by a human watching the arena freeze over mid-demo, 2026-08-06.
    await fill(`${X - 20} ${Y - 2} ${Z - 14} ${X + 20} ${Y - 2} ${Z - 10} minecraft:glowstone`);
    await fill(`${X - 20} ${Y - 1} ${Z - 14} ${X + 20} ${Y - 1} ${Z - 10} minecraft:water`);

    // …and check it, rather than trusting it. Staging that cannot fail loudly is staging you cannot
    // trust — this file has now been fooled by an oversized /fill and by ice.
    const pool = await call("get_blocks_at", {
      blocks: [-4, -2, 0, 2, 4].map((dx) => ({ x: X + dx, y: Y - 1, z: Z - 12 })),
    });
    const palette = JSON.stringify(pool.palette ?? []);
    assert.ok(/water/.test(palette), `the channel must be WATER at test time, got ${palette}`);
    assert.ok(!/ice/.test(palette), `the channel froze — this test would measure walking on ice: ${palette}`);

    await call("run_command", {
      command: `execute positioned ${X} ${Y} ${Z} run kill @e[type=!player,distance=..60]`,
    });
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y, z: Z } });
    await sleep(3500);
  });

  test("the SOLVE refuses to route through water when swim:false", async (t) => {
    if (!bridgeUp) return t.skip();
    const dry = await call("check_path", { to: FAR, swim: false });
    const wet = await call("check_path", { to: FAR, swim: true });

    assert.equal(wet.reachable, true,
      `with swim:true the channel is crossable, so the scene is staged right: ${JSON.stringify(wet).slice(0, 300)}`);
    assert.equal(dry.reachable, false,
      "with swim:false the only route crosses water, so the solve must REFUSE rather than plan through it: "
      + JSON.stringify(dry).slice(0, 300));
    // And it must say WHY in the water's own vocabulary (§2), not as a bridgeable gap.
    const obstruction = JSON.stringify(dry.obstruction ?? dry);
    assert.ok(/fluid|water/i.test(obstruction),
      `the refusal must name the water; a lake and a ravine must stop being the same answer. Got: ${obstruction.slice(0, 300)}`);
  });

  test("the BODY stays dry: a swim:false move never reports inWater", async (t) => {
    if (!bridgeUp) return t.skip();
    const started = await call("bot_goto", { to: FAR, swim: false });
    // Whatever the verdict, the claim under test is about the body, not the answer: poll it across
    // the whole flight. This is the half a solve-only test cannot cover — 983c8359's solve also
    // answered reachable:true and the body still ended up in the water.
    let wet = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const st = await call("bot_status");
      if (st.inWater || st.in_water) {
        wet = { i, pos: st.pos };
        break;
      }
      if (!st.busy && i > 3) break;
    }
    assert.equal(wet, null,
      `the body entered water under swim:false at ${JSON.stringify(wet?.pos)} — a right the body does `
      + `not honour is worse than not having it. Start said: ${JSON.stringify(started).slice(0, 200)}`);
  });

  test("a goal's stop reason must match the block it names", async (t) => {
    if (!bridgeUp) return t.skip();
    // What this DOES cover: §2's fluid vocabulary on a real goal failure. Before it, water could only
    // surface as `no_floor` with "a gap: re-run with may_modify place|both to bridge it" — a lake and
    // a ravine were the same answer, and the remedy told the body to bridge something it could have
    // swum or walked around.
    //
    // What it does NOT cover, stated so nobody mistakes it: the §3 obstructionAt fix. That defect
    // lives on GoalRunner's dig/step failure sites (fluid_ahead at :636, stuck, no_progress), and
    // every attempt to drive a goal into them now short-circuits to `unreachable` FIRST — because the
    // §2.1 water refusal stops the solve before a dig through water is ever planned. `unreachable`
    // reports through NavSolver.obstruction with the body's own position, which is a correct frontier.
    // An earlier version of this test used check_path and proved nothing at all (PredicateTools:710
    // also uses the frontier form correctly). §3 remains fixed-by-inspection only.
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X, y: Y, z: Z - 30 } },
      may_modify: "break", swim: false, wait: true,
    });
    const o = r.obstruction;
    assert.ok(o && o.kind,
      `a goal stopped by the channel must carry a locus: ${JSON.stringify(r).slice(0, 400)}`);
    const block = String(o.block ?? "");

    // The load-bearing pair: water must be named as a fluid, and must NOT arrive as a bridgeable gap.
    assert.ok(!(o.kind === "no_floor" && /water|lava/.test(block)),
      `a fluid reported as a plain gap is the §2 defect: ${JSON.stringify(o)}`);
    if (/water|lava/.test(block)) {
      assert.ok(String(o.kind).startsWith("fluid"),
        `the locus names "${block}" but kind is "${o.kind}": ${JSON.stringify(o)}`);
      assert.ok(o.fluid === "water" || o.fluid === "lava",
        `a fluid obstruction must say WHICH fluid: ${JSON.stringify(o)}`);
      assert.ok(/swim|route around|bridge over/.test(String(o.remedy ?? "")),
        `the remedy must be a water remedy, not a gap remedy: ${JSON.stringify(o)}`);
    }
    // And the general invariant, for whatever kind this run produced.
    if (String(o.kind).startsWith("fluid")) {
      assert.ok(/water|lava/.test(block),
        `kind "${o.kind}" names "${block}" — reason and block disagree: ${JSON.stringify(o)}`);
    }
  }, { timeout: 120_000 });

  test("teardown: leave the site as it was found", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    for (let y = Y - 6; y <= Y + 6; y += 7) {
      await fill(`${X - 20} ${y} ${Z - 40} ${X + 20} ${Math.min(y + 6, Y + 6)} ${Z + 8} minecraft:air`);
    }
    await cmd(`forceload remove ${X - 40} ${Z - 40} ${X + 40} ${Z + 40}`);
  });
});
