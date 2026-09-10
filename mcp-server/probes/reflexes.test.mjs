// Live probes for the reflex loadout (PLAYER_CONTROL_DESIGN.md §2–§3, slice 1) — the interrupt loop.
//
//   1. bot_reactions arm/list/clear + validation: unknown trigger kind / response op are refused
//      (fail-fast, not silently armed).
//   2. The loop: an armed health_below→attack reaction fires server-side against a nearby mob —
//      reaction_fired then reaction_done{hit:true} in the event log — and engages its cooldown.
//   3. Interrupt: while a bot_goto flight is in progress, a firing reaction reports preempted:"goto"
//      (the base intent it suspended), and the flight resumes underneath it.
//   4. clear disarms: no further reaction_fired events once the loadout is cleared.
//
// Staged at a probe-owned coordinate (3.4M). Forceloaded during the run; own session so concurrent
// probe files don't share this drone.
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_400_000, Z = 3_400_000, Y = 200; // this probe file's own site
const SESSION = "probe-reflexes"; // per-session drone slot; the bridge adopts unknown ids on sight

async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
async function call(tool, args = {}) {
  const j = await callRaw(tool, args);
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The newest event id right now — poll strictly after this so we only see events we caused.
const nowCursor = async () => (await call("get_events", { limit: 1 })).cursor;

// Read the stream to its end. `nowCursor` RESUMES from this session's last read position rather
// than jumping to the tail (deliberately — a cursorless poll that tailed would silently skip
// everything in between), so a test that leaves unread events makes the NEXT test's "now" a point
// in the past, and that test then reads this one's backlog as if it were live. A test that fires a
// reaction repeatedly owes the next one a drained log.
async function drainEvents() {
  for (let i = 0; i < 50; i++) {
    const r = await call("get_events", { limit: 200 });
    if (!(r.events || []).length && !r.more) return;
  }
}

// Poll for an event of `type` matching `pred`, appearing strictly after `cursor`, within `timeoutMs`.
async function waitEvent(type, cursor, timeoutMs, pred = () => true) {
  const deadline = Date.now() + timeoutMs;
  let cur = cursor;
  while (Date.now() < deadline) {
    const r = await call("get_events", { cursor: cur, type, wait_ms: 1500 });
    for (const e of r.events || []) {
      if (e.type === type && pred(e)) return e;
    }
    cur = r.cursor ?? cur;
  }
  return null;
}

const PANIC = {
  id: "panic",
  trigger: { kind: "health_below", hearts: 1000 }, // 1000 hearts → always true; fires every cooldown
  response: { op: "attack", nearest: true },
  priority: 5,
  cooldown_ticks: 20,
};

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("reflexes: arm/validate, the fire loop, preempt-a-goto, clear", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500); // forceload marks async
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 12} ${Z + 20} minecraft:air`);
    await sleep(400);
    // The teardown kills leftover SHEEP but not what they dropped, so wool and mutton pile up at
    // this site run after run (12 were sitting here on 2026-08-06). With them cleared the attack
    // test went from 2-of-6 passing to 3-of-4; leaving them makes the reflex's target selection
    // race against a crowded entity index. Staging clears it so a run that dies before teardown
    // cannot poison the next one. Not cmd(): an empty selector answers "No entity was found".
    await call("run_command", {
      command: `execute positioned ${X} ${Y + 1} ${Z} run kill @e[type=item,distance=..30]`,
    });
    await call("bot_reactions", { action: "clear" }); // reset any loadout from a prior run
    await call("bot_body", { action: "spawn",  pos: { x: X, y: Y + 2, z: Z } });
  });

  test("arm + list reflects the loadout", async (t) => {
    if (!bridgeUp) return t.skip();
    const armed = await call("bot_reactions", { action: "arm", reactions: [PANIC] });
    assert.equal(armed.count, 1, JSON.stringify(armed));
    assert.deepEqual(armed.armed, ["panic"], JSON.stringify(armed));

    const list = await call("bot_reactions", { action: "list" });
    assert.equal(list.count, 1, JSON.stringify(list));
    const rx = list.reactions[0];
    assert.equal(rx.id, "panic");
    assert.equal(rx.trigger, "health_below");
    assert.equal(rx.response, "attack");
    assert.equal(rx.priority, 5);
    assert.equal(rx.cooldown_ticks, 20);
  });

  test("validation: unknown trigger kind / response op are refused, not armed", async (t) => {
    if (!bridgeUp) return t.skip();
    const badTrigger = await callRaw("bot_reactions", {
      action: "arm",
      reactions: [{ id: "x", trigger: { kind: "bogus" }, response: { op: "attack", nearest: true } }],
    });
    assert.equal(badTrigger.ok, false, JSON.stringify(badTrigger));
    assert.match(String(badTrigger.error), /unknown trigger kind/i, JSON.stringify(badTrigger));

    const badOp = await callRaw("bot_reactions", {
      action: "arm",
      reactions: [{ id: "y", trigger: { kind: "health_below", hearts: 5 }, response: { op: "teleport" } }],
    });
    assert.equal(badOp.ok, false, JSON.stringify(badOp));
    assert.match(String(badOp.error), /unknown response op/i, JSON.stringify(badOp));

    // The bad specs left the existing loadout untouched.
    const list = await call("bot_reactions", { action: "list" });
    assert.equal(list.count, 1, JSON.stringify(list));
  });

  test("the loop: reaction fires and attacks a nearby mob, then cools down", async (t) => {
    if (!bridgeUp) return t.skip();
    // A living target within the drone's ~4-block reach.
    await cmd(`summon minecraft:sheep ${X + 1} ${Y + 2} ${Z} {NoAI:1b}`);
    await sleep(600); // let it settle onto the floor and into the entity index

    const c0 = await nowCursor();
    const fired = await waitEvent("reaction_fired", c0, 8000, (e) => e.data.id === "panic");
    assert.ok(fired, "expected a reaction_fired{panic} event");
    assert.equal(fired.data.response_op, "attack", JSON.stringify(fired.data));
    // attack is an OVERLAY op (w2 postmortem §2): it never suspends the base, so the row carries
    // no `preempted` field at all — the old contract stamped "idle" here.
    assert.equal(fired.data.preempted, undefined, JSON.stringify(fired.data));

    const done = await waitEvent("reaction_done", fired.id - 1, 6000, (e) => e.data.id === "panic");
    assert.ok(done, "expected a reaction_done{panic} event");
    assert.equal(done.data.hit, true, `attack should have landed: ${JSON.stringify(done.data)}`);

    // Cooldown engaged right after firing.
    const list = await call("bot_reactions", { action: "list" });
    assert.ok(list.reactions[0].cooldown_remaining > 0,
      `cooldown should be counting down: ${JSON.stringify(list.reactions[0])}`);
  });

  test("interrupt: only a LEG op preempts a flight — an overlay attack leaves it alone", async (t) => {
    if (!bridgeUp) return t.skip();
    // The leg-op half of the w2 postmortem §2 contract: backstep suspends the base (stamped
    // preempted:'goto'); the overlay attack in the test above never does. A leg reaction with an
    // explicit tiny cooldown so it re-fires during the flight without starving it forever.
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "legpanic",
        trigger: { kind: "health_below", hearts: 1000 },
        response: { op: "backstep", ticks: 2, speed: 0.2 },
        cooldown_ticks: 30,
      }],
    });
    const c0 = await nowCursor();
    // A multi-second flight across the platform; the leg reaction preempts it mid-air.
    await call("bot_goto", { to: { x: X + 15, y: Y + 2, z: Z } });
    const fired = await waitEvent("reaction_fired", c0, 8000,
      (e) => e.data.id === "legpanic" && e.data.preempted === "goto");
    assert.ok(fired, "expected a reaction_fired{legpanic, preempted:goto} during the flight");
    await call("bot_reactions", { action: "disarm", id: "legpanic" });
  });

  // ---- a reflex that cannot run stops running (0.46.0) ------------------------
  //
  // Live, session w1-85918: the charter's `heal` (health_below 8 → eat) was armed with an EMPTY
  // inventory. It fired every tick through both deaths — 20 honest reports a second — and the
  // body_damaged rows that mattered were buried inside 11KB event pages the agent had to page
  // through while dying. Honesty that repeats itself into noise stops being honesty.
  test("a reflex failing the same way 3x suspends itself, urgently and once", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" });
    const c0 = await nowCursor();
    // eat with nothing edible: fails in the tick it fires, and the trigger stays true.
    await call("bot_reactions", { action: "arm", reactions: [{
      id: "hopeless_eat",
      trigger: { kind: "health_below", hearts: 1000 }, // always true
      response: { op: "eat" },
    }] });

    const suspended = await waitEvent("reaction_suspended", c0, 10000,
      (e) => e.data.id === "hopeless_eat");
    assert.ok(suspended, "an impossible reflex must suspend itself rather than retry forever");
    assert.equal(suspended.data.reason, "no_food",
      `suspension is for STANDING conditions the body owns: ${JSON.stringify(suspended.data)}`);
    assert.ok(suspended.data.reason, `it names WHY: ${JSON.stringify(suspended.data)}`);
    assert.ok(suspended.data.rearms_in_ticks > 0,
      `…and when it will try again: ${JSON.stringify(suspended.data)}`);

    // It is still armed — and `list` must say the protection is not currently covering the body,
    // or its presence in the array reads as coverage.
    const list = await call("bot_reactions", { action: "list" });
    const rx = list.reactions.find((x) => x.id === "hopeless_eat");
    assert.ok(rx, JSON.stringify(list));
    assert.equal(rx.suspended, true, `list discloses the suspension: ${JSON.stringify(rx)}`);

    // And it has actually STOPPED: no further fires while suspended.
    const c1 = await nowCursor();
    const stray = await waitEvent("reaction_fired", c1, 3000, (e) => e.data.id === "hopeless_eat");
    assert.equal(stray, null,
      `a suspended reaction must not keep firing: ${JSON.stringify(stray?.data)}`);
    await call("bot_reactions", { action: "clear" });
    await drainEvents();
  });

  // The mirror of the test above, and the more important of the two. Found by the first live run:
  // `panic` (attack → nearest) failed `no_target` three times while nothing was in range and
  // suspended itself for 30 seconds — which is exactly the window a fight happens in. Suspension is
  // for conditions the BODY owns and cannot resolve on its own; a target that is momentarily out of
  // range is a fact about a world that changes every tick. Wrongly suspending a defence costs a
  // body; wrongly keeping one costs some noise.
  test("a transient failure does NOT suspend — only standing conditions do", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" });
    const c0 = await nowCursor();
    // Always-true trigger, nothing to attack: fires and fails `no_target` over and over.
    await call("bot_reactions", { action: "arm", reactions: [{
      id: "swing_at_air",
      trigger: { kind: "health_below", hearts: 1000 },
      response: { op: "attack", nearest: true },
      // Spaced deliberately. Uncapped, this fires 20x a second and buries the rest of the file's
      // events under a few hundred rows — `nowCursor` resumes from the session's last read position
      // rather than the tail, so the NEXT test then reads this test's backlog and sees "stray"
      // fires after its own clear. A second apart still proves the point (well over the 3-failure
      // threshold inside the wait window) without drowning the log.
      cooldown_ticks: 20,
    }] });
    const failed = await waitEvent("reaction_done", c0, 8000,
      (e) => e.data.id === "swing_at_air" && e.data.reason === "no_target");
    assert.ok(failed, "the reaction should be firing and failing on an empty world");

    const suspended = await waitEvent("reaction_suspended", c0, 5000,
      (e) => e.data.id === "swing_at_air");
    assert.equal(suspended, null,
      `a world-caused failure must leave the defence armed: ${JSON.stringify(suspended?.data)}`);
    const list = await call("bot_reactions", { action: "list" });
    assert.ok(!list.reactions.find((x) => x.id === "swing_at_air")?.suspended,
      `still covering the body: ${JSON.stringify(list.reactions)}`);
    await call("bot_reactions", { action: "clear" });
    await drainEvents();
  });

  test("preset:survival arms the standard loadout, including something that fights", async (t) => {
    if (!bridgeUp) return t.skip();
    // The charter used to carry these eight as literal JSON to be retyped per spawn. A small model
    // at low effort dropped `fight` from all three of its arms in one live session, and — because
    // engage mode:"defend" delegates ALL fighting to this layer — died twice without swinging back.
    await call("bot_reactions", { action: "clear" });
    const armed = await call("bot_reactions", { action: "arm", preset: "survival" });
    assert.equal(armed.count, 9, `the standard loadout is nine: ${JSON.stringify(armed)}`);
    // `guard` joined at toolkit 0.74.0 — a shield raised on projectile_incoming, ranked ABOVE
    // `dodge` on the same trigger because blocking beats sidestepping when there is anything to
    // block with. It costs the shieldless body nothing: the arbiter skips a shield reaction on a
    // body that carries none, so `dodge` keeps the tick exactly as before.
    for (const id of ["drown", "lava", "lava_near", "unstick", "eat", "heal", "guard", "dodge",
                      "fight"]) {
      assert.ok(armed.armed.includes(id), `preset must arm ${id}: ${JSON.stringify(armed.armed)}`);
    }
    assert.ok(!armed.no_combat_response,
      `the preset answers attackers, so no warning: ${JSON.stringify(armed)}`);

    // An explicit reaction in the SAME call overrides a preset member by id rather than duplicating.
    const tuned = await call("bot_reactions", {
      action: "arm", preset: "survival",
      reactions: [{ id: "fight", trigger: { kind: "threats_nearby", within: 3 }, response: { op: "flee" } }],
    });
    assert.equal(tuned.count, 9, `override replaces, never appends: ${JSON.stringify(tuned)}`);
    const list = await call("bot_reactions", { action: "list" });
    assert.equal(list.reactions.find((x) => x.id === "fight").response, "flee",
      `the caller's own entry wins: ${JSON.stringify(list.reactions)}`);

    // A loadout with nothing that fights is CALLED OUT — the silence is what killed w1-85918.
    await call("bot_reactions", { action: "clear" });
    const bare = await call("bot_reactions", { action: "arm", reactions: [
      { id: "drown", trigger: { kind: "air_below", ticks: 150 }, response: { op: "surface" } },
    ] });
    assert.equal(bare.no_combat_response, true,
      `a loadout that cannot fight must say so: ${JSON.stringify(bare)}`);
    assert.match(String(bare.note), /preset|fight/i, JSON.stringify(bare));

    // Leave the loadout as this test found it: the next test asserts that `clear` DISARMS something,
    // and a test that quietly empties the slot would make it pass or fail for its own reasons.
    await call("bot_reactions", { action: "clear" });
    await drainEvents();
    await call("bot_reactions", { action: "arm", reactions: [PANIC] });
  });

  test("clear disarms: no further reactions fire", async (t) => {
    if (!bridgeUp) return t.skip();
    const cleared = await call("bot_reactions", { action: "clear" });
    assert.ok(cleared.cleared >= 1, JSON.stringify(cleared));
    const list = await call("bot_reactions", { action: "list" });
    assert.equal(list.count, 0, JSON.stringify(list));

    const c0 = await nowCursor();
    const stray = await waitEvent("reaction_fired", c0, 2500);
    assert.equal(stray, null, `no reaction should fire after clear: ${JSON.stringify(stray?.data)}`);
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`kill @e[type=minecraft:sheep,x=${X - 4},y=${Y},z=${Z - 4},dx=8,dy=6,dz=8]`).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`).catch(() => {});
  });
});
