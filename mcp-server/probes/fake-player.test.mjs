// The PLAYER body — step 2 of the body architecture (BOT_SURFACE_DESIGN.md §11.4), toolkit 0.27.0.
// A headless ServerPlayer (no client, no socket) driven by the same NavBody input frame the walker
// uses. What each rung proves:
//
//   EXISTENCE — the fake player logs in: it is in the player list, it is a real entity in the world,
//     and `get_entities category:player` sees it. The Carpet-style FakeConnection survives
//     PlayerList.placeNewPlayer with no channel behind it.
//   THE TICK PUMP — the decisive one. ServerPlayer.doTick() (which runs ALL of LivingEntity's
//     physics) is called from exactly one place in vanilla: the packet listener, which never ticks
//     for a connectionless player. Spawned in the air, an unpumped body would hang there forever;
//     this body must FALL and land. If this rung fails, nothing else about the body is real.
//   WALKING — the shared search + NavDriver move it across flat ground to a commanded cell.
//   SPRINT-JUMP — the §11.4 payoff: a gap crossed on AUTHENTIC engine physics. The player sink's
//     launch() ignores the driver's ballistic vector and just jumps (zero tuned constants), so
//     clearing the gap is evidence the vanilla arc did the work.
//   NO PERSISTENCE — despawn leaves no entity, no player-list entry, and no playerdata file
//     (PlayerList.remove insists on writing one; FakePlayers deletes the husk). Re-spawning the same
//     name lands at the NEW position with full health — a resurrected ghost would not.
//
// Driven through `/mmcp fakeplayer …` via run_command: the player body has no MCP tool surface yet
// and deliberately costs zero manifest tokens until it earns one (the Mob-typing slice is not done).
//
// Probe-owned site at 3.48M, clear of walker-vert (3.47M). Needs the dev server up; skips otherwise.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-fake-player";
const X = 3_480_000, Z = 3_480_000, Y = 200;
const NAME = "probe_fp";

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

/** Java's UUID.nameUUIDFromBytes("OfflinePlayer:<name>") — an MD5 (v3) UUID. */
function offlineUuid(name) {
  const h = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The body's position from the status line, or null when it does not exist. */
async function status(name = NAME) {
  const r = await cmd(`mmcp fakeplayer status ${name}`);
  const text = JSON.stringify(r);
  const m = text.match(/'.*?' at (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) onGround=(\w+) sprinting=(\w+) navDone=(\w+) health=([\d.]+)/);
  if (!m) return null;
  return {
    x: +m[1], y: +m[2], z: +m[3],
    onGround: m[4] === "true",
    sprinting: m[5] === "true",
    navDone: m[6] === "true",
    health: +m[7],
    raw: text,
  };
}

/** Poll until `done(status)` or the deadline; returns the last status seen. */
async function until(done, ms = 12_000, step = 500) {
  const deadline = Date.now() + ms;
  let last = null;
  for (;;) {
    last = await status();
    if (last && done(last)) return last;
    if (Date.now() > deadline) return last;
    await sleep(step);
  }
}

const despawn = () => cmd(`mmcp fakeplayer despawn ${NAME}`).catch(() => null);

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

// Course layout along +x at z = Z, walk level Y+1:
//   X..X+11    flat run          (walking)
//   X+12..X+14 a 3-wide gap      (sprint-jump; trench is 5 deep so a fall is unmistakable)
//   X+15..X+22 landing apron
const GAP_FROM = X + 12, GAP_TO = X + 14;
const LAND = X + 17;

describe("the player body: existence, physics, movement, no persistence", { skip: !bridgeUp }, () => {
  test("stage the course", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 48} ${Z + 32}`);
    await sleep(1500);
    // Blank slate + a SOLID foundation (top at Y, walk level Y+1) — never a floating slab.
    await cmd(`fill ${X - 16} ${Y - 6} ${Z - 16} ${X + 40} ${Y + 12} ${Z + 16} minecraft:air`);
    await cmd(`fill ${X - 16} ${Y - 6} ${Z - 16} ${X + 40} ${Y} ${Z + 16} minecraft:stone`);
    // A 2-thick shell either side keeps the body on the centreline (1-thick walls are pierceable).
    await cmd(`fill ${X - 2} ${Y + 1} ${Z - 3} ${X + 30} ${Y + 4} ${Z - 2} minecraft:stone`);
    await cmd(`fill ${X - 2} ${Y + 1} ${Z + 2} ${X + 30} ${Y + 4} ${Z + 3} minecraft:stone`);
    // The gap: a 5-deep trench across the run.
    await cmd(`fill ${GAP_FROM} ${Y - 5} ${Z - 1} ${GAP_TO} ${Y} ${Z + 1} minecraft:air`);
    await sleep(400);
    await despawn();
  });

  test("existence: a headless player logs in and is a real entity", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`mmcp fakeplayer spawn ${NAME} ${X + 0.5} ${Y + 1} ${Z + 0.5}`);
    await sleep(600);

    const st = await status();
    assert.ok(st, "the body reports a status line");

    const list = JSON.stringify(await cmd("list"));
    assert.match(list, new RegExp(NAME), `the fake player is in the player list: ${list}`);

    const near = await call("get_entities", {
      origin: { x: X, y: Y + 1, z: Z }, radius: 16, category: "player",
    });
    const found = (near.entities || []).some((e) => JSON.stringify(e).includes(NAME));
    assert.ok(found, `get_entities sees the body as a player: ${JSON.stringify(near.entities)}`);
  });

  test("the tick pump: an unpumped body would hang in the air — this one falls", async (t) => {
    if (!bridgeUp) return t.skip();
    await despawn();
    // Spawn 6 blocks above the floor. doTick() is what runs LivingEntity's physics; without the
    // pump in FakePlayerEntity.tick() this body never falls a single block.
    const dropFrom = Y + 7;
    await cmd(`mmcp fakeplayer spawn ${NAME} ${X + 0.5} ${dropFrom} ${Z + 0.5}`);
    await sleep(300);
    const start = await status();
    assert.ok(start, "spawned");

    const landed = await until((s) => s.onGround, 8000);
    assert.ok(landed.onGround, `the body fell and landed (still at y=${landed.y}, started ${start.y})`);
    assert.ok(landed.y < dropFrom - 3, `it actually descended: ${landed.y} < ${dropFrom - 3}`);
    assert.ok(Math.abs(landed.y - (Y + 1)) < 0.6, `it came to rest on the floor: y=${landed.y}`);
  });

  test("walking: the shared search + driver move it to a commanded cell", async (t) => {
    if (!bridgeUp) return t.skip();
    const target = { x: X + 10, z: Z };
    const started = await cmd(`mmcp fakeplayer goto ${NAME} ${target.x} ${Y + 1} ${target.z}`);
    assert.doesNotMatch(JSON.stringify(started), /NO PATH/, "a path exists across flat ground");

    const arrived = await until(
      (s) => Math.abs(s.x - (target.x + 0.5)) < 1.5 && s.navDone, 15_000);
    assert.ok(Math.abs(arrived.x - (target.x + 0.5)) < 1.5,
      `walked to x≈${target.x}: ${arrived.raw}`);
    assert.ok(arrived.health >= 20, `unharmed on the way: ${arrived.health}`);
  });

  test("sprint-jump: a 3-gap crossed on the engine's own arc (zero tuned constants)", async (t) => {
    if (!bridgeUp) return t.skip();
    const before = await status();
    assert.ok(before.x < GAP_FROM, `starts on the near side: x=${before.x}`);

    const started = await cmd(`mmcp fakeplayer goto ${NAME} ${LAND} ${Y + 1} ${Z}`);
    assert.doesNotMatch(JSON.stringify(started), /NO PATH/,
      "the search plans a jump edge across the gap");

    const after = await until((s) => s.x > GAP_TO + 0.5 && s.onGround, 20_000);
    assert.ok(after.x > GAP_TO + 0.5,
      `crossed to the far side (x=${after.x}, gap ends ${GAP_TO}): ${after.raw}`);
    assert.ok(after.y > Y - 1,
      `it JUMPED the gap rather than falling into it (y=${after.y}, trench floor ${Y - 5})`);
  });

  test("no persistence: despawn leaves no entity, no list entry, no playerdata", async (t) => {
    if (!bridgeUp) return t.skip();
    const gone = await cmd(`mmcp fakeplayer despawn ${NAME}`);
    assert.match(JSON.stringify(gone), /despawned/, "despawn reports the removal");
    await sleep(400);

    const list = JSON.stringify(await cmd("list"));
    assert.doesNotMatch(list, new RegExp(NAME), `no longer in the player list: ${list}`);

    const near = await call("get_entities", {
      origin: { x: X, y: Y + 1, z: Z }, radius: 32, category: "player",
    });
    const stillThere = (near.entities || []).some((e) => JSON.stringify(e).includes(NAME));
    assert.equal(stillThere, false, "the entity is gone from the world");

    // Re-spawn the same name: a body restored from leftover playerdata would arrive somewhere else
    // (or damaged). Landing exactly where commanded, at full health, is the observable proof that
    // nothing was reloaded.
    await cmd(`mmcp fakeplayer spawn ${NAME} ${X + 3.5} ${Y + 1} ${Z + 0.5}`);
    await sleep(600);
    const fresh = await status();
    assert.ok(Math.abs(fresh.x - (X + 3.5)) < 1.0,
      `re-spawn lands where commanded, not at a remembered spot: ${fresh.raw}`);
    assert.ok(fresh.health >= 20, `re-spawn is a fresh body: health=${fresh.health}`);

    console.log(`      (offline uuid for ${NAME}: ${offlineUuid(NAME)})`);
  });

  test("teardown", async (t) => {
    if (!bridgeUp) return t.skip();
    await despawn();
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 48} ${Z + 32}`);
  });
});
