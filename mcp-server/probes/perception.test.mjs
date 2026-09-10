// Live probes for the player-legal perception belief store (sense_entities).
//
//   1. Vision vs hearing: an entity in the FOV cone with line of sight is `seen` (fresh, velocity,
//      bearing ahead); one behind the body (out of FOV) is `heard` (no velocity), and the summary
//      counts hostiles + names the nearest — all server-computed (the model does no coordinate math).
//   2. Freeze: a seen entity moved out of perception goes `stale` — its last-known position is
//      frozen (reports where it WAS, not where it now is), age growing until it decays.
//
// Staged at a probe-owned coordinate (3.7M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_700_000, Z = 3_700_000, Y = 200;
const SESSION = "probe-perception";
const ORIGIN = { x: X, y: Y + 2, z: Z };

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

// Read this session's unread backlog to its end. A cursorless get_events RESUMES from the last
// read position, so a "baseline" cursor taken without draining sits BEHIND earlier tests' rows —
// their zombies then read as leaks in the next test's window (live-caught 2026-08-04).
async function drainEvents() {
  for (let guard = 0; guard < 30; guard++) {
    const r = await call("get_events", { limit: 200 });
    if (!r.more) return;
  }
}
const killZombies = () => cmd(`kill @e[type=minecraft:zombie,x=${X - 30},y=${Y - 4},z=${Z - 30},dx=60,dy=60,dz=60]`).catch(() => {});

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("perception belief store: sense_entities", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 40} ${Z - 40} ${X + 40} ${Z + 40}`);
    await sleep(1500);
    await cmd(`fill ${X - 30} ${Y} ${Z - 30} ${X + 30} ${Y} ${Z + 30} minecraft:stone`);
    await cmd(`fill ${X - 30} ${Y + 1} ${Z - 30} ${X + 30} ${Y + 40} ${Z + 30} minecraft:air`);
    await sleep(400);
  });

  test("vision gates by FOV+LOS; behind is heard; summary is server-computed", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await killZombies();
    await call("bot_look", { at: { x: X + 10, y: Y + 2, z: Z } }); // face +X
    await sleep(200);
    await cmd(`summon minecraft:zombie ${X + 3} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`); // in front (nearer)
    await cmd(`summon minecraft:zombie ${X - 5} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`); // behind (farther)
    await sleep(700); // let a couple of tracking passes run

    const r = await call("sense_entities");
    assert.ok(r.note && /not authoritative/i.test(r.note), `must flag non-authoritative: ${r.note}`);
    const front = (r.perceived || []).find((e) => e.hostile && e.bearing === "ahead");
    const behind = (r.perceived || []).find((e) => e.hostile && e.bearing === "behind");
    assert.ok(front, `the front zombie should be perceived ahead: ${JSON.stringify(r.perceived)}`);
    assert.equal(front.channel, "seen", `front (FOV+LOS) is seen: ${JSON.stringify(front)}`);
    assert.equal(front.fresh, true, JSON.stringify(front));
    assert.ok(front.velocity, "a seen entity carries velocity");
    assert.ok(front.distance >= 2 && front.distance <= 6, `distance is server-computed: ${front.distance}`);

    assert.ok(behind, `the behind zombie should be perceived (out of FOV → heard): ${JSON.stringify(r.perceived)}`);
    assert.equal(behind.channel, "heard", `behind (no LOS to eyes / out of FOV) is heard: ${JSON.stringify(behind)}`);
    assert.ok(!behind.fresh, "a heard entity is not fresh (no live velocity)");

    assert.equal(r.summary.hostiles, 2, `summary counts hostiles: ${JSON.stringify(r.summary)}`);
    assert.ok(r.summary.nearest_threat, "summary names the nearest threat");
    assert.equal(r.summary.nearest_threat.id, front.id, "nearest threat is the closer (front) one");
    await killZombies();
  });

  test("freeze: a seen entity moved out of perception goes stale at its last-known position", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await killZombies();
    await call("bot_look", { at: { x: X + 10, y: Y + 2, z: Z } });
    await cmd(`summon minecraft:zombie ${X + 4} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b,Tags:["seenz"]}`);
    await sleep(700);
    let r = await call("sense_entities");
    let z = (r.perceived || []).find((e) => e.hostile);
    assert.ok(z && z.channel === "seen", `zombie should first be seen: ${JSON.stringify(z)}`);
    const seenX = z.pos.x;

    // Move it far up, out of vision (>32) and hearing (>16) — perception should now freeze the belief.
    await cmd(`tp @e[tag=seenz,limit=1] ${X + 4} ${Y + 38} ${Z}`);
    await sleep(1000); // tracking passes run; the belief is no longer refreshed

    r = await call("sense_entities");
    // The REMEMBERED tier (0.47 senses, first live-run 2026-08-04): the body is LOOKING at the
    // cell the zombie vanished from, so keeping a stale "perceived" row there would be a belief
    // the eye has already refuted. The honest shape is: gone from `perceived`, moved to
    // `remembered` with fate `lost`, frozen at the last-known position. (A belief OUTSIDE the
    // vision cone would freeze in place instead — that path is not what this staging exercises.)
    const still = (r.perceived || []).find((e) => e.hostile);
    assert.ok(!still,
      `a refuted in-cone belief must not linger as perceived: ${JSON.stringify(r.perceived)}`);
    const rem = (r.remembered || []).find((e) => String(e.type).includes("zombie"));
    assert.ok(rem, `…it moves to the remembered tier: ${JSON.stringify(r.remembered)}`);
    // "gone" = refuted by LOOKING at the empty cell (this staging); "lost" = drifted out of
    // tracking unwatched. Either is an honest fate here — banned is a fresh perceived row.
    assert.match(String(rem.fate), /^(gone|lost)$/, JSON.stringify(rem));
    assert.ok(Math.abs(rem.pos.x - seenX) < 1.5 && rem.pos.y < Y + 10,
      `remembered at last-known position (~${seenX}, low y), not the new y=${Y + 38}: ${JSON.stringify(rem.pos)}`);
    await killZombies();
  });

  test("witnessed death: a kill the body SAW moves to remembered as fate:died, never a stale hostile", async (t) => {
    // SURVIVAL_SENSES_DESIGN.md §2.2. Before this, a watched kill froze into a `stale` hostile that
    // haunted the store for 10s — a lie about the one event the body actually witnessed (vanilla
    // keeps the corpse ~20 ticks of death animation, which is what makes the death perceivable).
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", pos: ORIGIN });
    await killZombies();
    await call("bot_look", { at: { x: X + 10, y: Y + 2, z: Z } });
    await cmd(`summon minecraft:zombie ${X + 4} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b,Tags:["diez"]}`);
    await sleep(700);
    let r = await call("sense_entities");
    assert.ok((r.perceived || []).some((e) => e.hostile && e.channel === "seen"), "zombie seen first");

    await cmd(`kill @e[tag=diez,limit=1]`); // dies in full view
    await sleep(700);
    r = await call("sense_entities");
    assert.ok(!(r.perceived || []).some((e) => e.hostile),
      `a watched kill must not linger as a stale hostile: ${JSON.stringify(r.perceived)}`);
    const dead = (r.remembered || []).find((m) => m.hostile);
    assert.ok(dead, `the kill must be remembered: ${JSON.stringify(r.remembered)}`);
    assert.equal(dead.fate, "died", `the body watched it die: ${JSON.stringify(dead)}`);
    assert.equal(r.summary.hostiles, 0, "a memory must not count as a threat");
  });

  test("refutation: looking at a vacated last-known spot clears the belief as fate:gone", async (t) => {
    // §2.2, the entity analog of implied-air VANISH: looking where a belief lives and not
    // perceiving the entity IS an observation. The body keeps facing the spot; the zombie is
    // teleported away; the belief must clear on sight, not age out over 10 seconds.
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", pos: ORIGIN });
    await killZombies();
    await call("bot_look", { at: { x: X + 10, y: Y + 2, z: Z } });
    await cmd(`summon minecraft:zombie ${X + 4} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b,Tags:["gonez"]}`);
    await sleep(700);
    let r = await call("sense_entities");
    assert.ok((r.perceived || []).some((e) => e.hostile && e.channel === "seen"), "zombie seen first");

    await cmd(`tp @e[tag=gonez,limit=1] ${X - 25} ${Y + 2} ${Z}`); // far behind: out of FOV and hearing, inside the cleanup box
    await sleep(700); // well under DECAY_TICKS — only refutation can clear it this fast
    r = await call("sense_entities");
    assert.ok(!(r.perceived || []).some((e) => e.hostile),
      `the vacated spot is in full view — the belief must be refuted: ${JSON.stringify(r.perceived)}`);
    const gone = (r.remembered || []).find((m) => m.hostile);
    assert.ok(gone && gone.fate === "gone",
      `refuted-by-observation is remembered as fate:gone: ${JSON.stringify(r.remembered)}`);
    await killZombies();
  });

  test("remembered tier: an unwatched percept ages out as fate:lost instead of vanishing", async (t) => {
    // §2.1. The zombie is HEARD (behind the body), then teleported away while the body never looks:
    // nothing refutes the belief (heard positions are quantized — refuting a guess would
    // manufacture certainty), so it ages out of the percept tier and must land in `remembered`.
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", pos: ORIGIN });
    await killZombies();
    await call("bot_look", { at: { x: X + 10, y: Y + 2, z: Z } }); // face +X the whole test
    await cmd(`summon minecraft:zombie ${X - 5} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b,Tags:["lostz"]}`);
    await sleep(700);
    let r = await call("sense_entities");
    assert.ok((r.perceived || []).some((e) => e.hostile && e.channel === "heard"), "zombie heard behind");

    await cmd(`tp @e[tag=lostz,limit=1] ${X - 5} ${Y + 38} ${Z}`); // out of hearing, still behind
    await sleep(11_500); // DECAY_TICKS (200) + slack: the belief must age out, not be refuted
    r = await call("sense_entities");
    assert.ok(!(r.perceived || []).some((e) => e.hostile),
      `the percept must have decayed: ${JSON.stringify(r.perceived)}`);
    const lost = (r.remembered || []).find((m) => m.hostile);
    assert.ok(lost && lost.fate === "lost",
      `an unwatched decay is remembered as fate:lost: ${JSON.stringify(r.remembered)}`);
    assert.ok(lost.last_seen_ticks_ago > 200, `age is since the last percept: ${JSON.stringify(lost)}`);
    await killZombies();
  });

  test("perceived mode gates the event door: no entity_entered_radius through a wall", async (t) => {
    // §2.3 — the X-ray leak, probed from both sides. The observer's radius diff (24 blocks, no
    // FOV, no LOS) announced entities behind walls; in perceived mode it must consume the belief
    // store instead. Zombie at 20 blocks: inside the authoritative enter radius, outside hearing
    // (16), line of sight blocked by a staged wall — so perceived mode must stay silent and
    // authoritative mode must event it.
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", pos: ORIGIN });
    await killZombies();
    await call("bot_look", { at: { x: X + 10, y: Y + 2, z: Z } }); // face the wall — FOV is not the gate here, LOS is
    await cmd(`fill ${X + 10} ${Y + 1} ${Z - 5} ${X + 10} ${Y + 8} ${Z + 5} minecraft:stone`);
    await call("bot_profile", { perception: "perceived" });
    await sleep(400);
    await drainEvents(); // earlier tests' enter-events must not read as this test's leaks
    const base = await call("get_events", { limit: 1 }); // baseline cursor: only what happens next counts

    await cmd(`summon minecraft:zombie ${X + 20} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b,Tags:["wallz"]}`);
    await sleep(1500);
    let ev = await call("get_events", { cursor: base.cursor, limit: 200 });
    const leaked = (ev.events || []).filter((e) =>
      e.type === "entity_entered_radius" && JSON.stringify(e.data || {}).includes("zombie"));
    assert.equal(leaked.length, 0,
      `perceived mode must not event an entity the body cannot perceive: ${JSON.stringify(leaked)}`);

    await call("bot_profile", { perception: "authoritative" });
    await sleep(1500);
    ev = await call("get_events", { cursor: ev.cursor, limit: 200 });
    const seen = (ev.events || []).filter((e) =>
      e.type === "entity_entered_radius" && JSON.stringify(e.data || {}).includes("zombie"));
    assert.ok(seen.length > 0,
      "authoritative mode is the X-ray copilot sensor — the same zombie must event");
    await call("bot_profile", { perception: "perceived" }).catch(() => {}); // leave nothing armed oddly
    await killZombies();
    await cmd(`fill ${X + 10} ${Y + 1} ${Z - 5} ${X + 10} ${Y + 8} ${Z + 5} minecraft:air`);
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await killZombies();
    await cmd(`forceload remove ${X - 40} ${Z - 40} ${X + 40} ${Z + 40}`).catch(() => {});
  });
});
