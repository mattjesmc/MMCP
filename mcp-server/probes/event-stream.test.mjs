// Live probes for the EVENT STREAM's survival properties (toolkit 0.42.0). The stream was already
// honest — cursors never skip, evictions are counted, a world boundary is announced. These probes
// cover the four ways it was still unusable for a body that can die:
//
//   1. `missed` counted OTHER people's evictions. A session filtering by type, or merely sharing the
//      process with a busy copilot, was told it had missed hundreds of events that were never its to
//      see — a false alarm in the one field whose whole job is honesty.
//   2. A paged read is oldest-first, so a body_endangered with a 15-second fuse could sit behind a
//      page of routine events for several polls. The page order is untouchable (a cursor that skips
//      is a cursor that lies), so danger now rides along as a non-consuming `urgent` preview.
//   3. Dropped items were evented. A player body auto-collects, so every mined block produced two
//      events of self-noise — which is exactly what buries the events in (2).
//   4. `audit` records — the server's ledger of world edits, with coordinates and block ids — were
//      broadcast to every session, including player-legal ones that perceived none of it.
//
// Plus the reflex half of the danger sense: `hazard {cause}` binds the vocabulary the events already
// used, so in_lava/starving/suffocating stop being advice a round-trip is too slow to take.
//
// Probe-owned site at 3.52M. Needs the dev server; skips when the bridge is down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-events";
const X = 3_520_000, Z = 3_520_000, Y = 200;

async function call(tool, args = {}, { profile } = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MCPTK-Session": SESSION,
      ...(profile ? { "X-MCPTK-Profile": profile } : {}),
    },
    body: JSON.stringify({ tool, args }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
/** Same call, but returns the envelope so a REFUSAL can be asserted as one. */
async function attempt(tool, args = {}, { profile } = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MCPTK-Session": SESSION,
      ...(profile ? { "X-MCPTK-Profile": profile } : {}),
    },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowCursor = async () => (await call("get_events", { limit: 1 })).cursor;

// Read the session's unread backlog to its end, so nowCursor is genuinely NOW. A cursorless poll
// deliberately RESUMES from the last-read position — which means a test that leaves rows unread
// (a type-filtered read does not consume the rest) poisons the next test's "from here" cursor
// with its own leftovers: live-caught 2026-08-04, the urgent-preview test found the stale
// body_removed of its OWN setup despawn inside the page it asserted clean.
async function drainEvents() {
  for (let guard = 0; guard < 30; guard++) {
    const r = await call("get_events", { limit: 200 });
    if (!r.more) return;
  }
}

// Find one event of `type` after `cursor`, asking the SERVER to filter.
//
// An unfiltered page cannot be relied on to contain what a test is waiting for: a cursorless poll
// RESUMES from this session's last read position rather than tailing (deliberately — tailing would
// silently skip everything between), a page is capped at 200, and every `run_command` in this file
// is an audited privileged call. So a couple of hundred `audit` rows can sit between the cursor and
// the event under test, filling the page on their own. Filtering by type steps over all of that
// without draining the stream, which the tests after this one still need intact.
async function findEvent(type, cursor, pred = () => true) {
  let cur = cursor;
  for (let i = 0; i < 20; i++) {
    const r = await call("get_events", { cursor: cur, type, limit: 200 });
    for (const e of r.events || []) {
      if (pred(e)) return e;
    }
    if (!r.more) return null;
    cur = r.cursor ?? cur;
  }
  return null;
}

/** Fire `n` audited calls to push events into the ring (run_command is PRIVILEGED = audited). */
async function flood(n, batch = 25) {
  for (let done = 0; done < n; done += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, n - done) }, () => cmd("time query gametime")),
    );
  }
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("event stream: danger cannot be buried, and losses are counted honestly", { skip: !bridgeUp }, () => {
  test("stage: a flat stone platform", async () => {
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await cmd(`fill ${X - 16} ${Y - 1} ${Z - 16} ${X + 16} ${Y + 8} ${Z + 16} minecraft:air`);
    await cmd(`fill ${X - 16} ${Y - 1} ${Z - 16} ${X + 16} ${Y - 1} ${Z + 16} minecraft:stone`);
    await sleep(500);
  });

  test("dropped items are not evented; a living entity still is", async () => {
    await call("bot_body", { action: "despawn" });
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
    await sleep(1500);
    const cursor = await nowCursor();

    // An item at the body's feet — the shape a mined block takes, twice per block (drop + pickup).
    await cmd(`summon minecraft:item ${X + 2} ${Y} ${Z + 2} {Item:{id:"minecraft:stone",count:1}}`);
    // …and a living entity, so a silent stream cannot pass this test by being broken.
    await cmd(`summon minecraft:chicken ${X + 3} ${Y} ${Z + 3}`);
    await sleep(2000);

    const r = await call("get_events", { cursor, type: "entity_entered_radius", limit: 200 });
    const kinds = (r.events || []).map((e) => e.data?.entity?.type ?? "?");
    assert.ok(
      kinds.some((k) => k.includes("chicken")),
      `a living entity entering must still be evented (saw ${JSON.stringify(kinds)})`,
    );
    assert.ok(
      !kinds.some((k) => k.includes("item")),
      `dropped items must NOT be evented — that is the mining self-noise (saw ${JSON.stringify(kinds)})`,
    );
    // Anchored, not bare `distance`: run_command runs from the SERVER's source, whose position is
    // the world spawn — a bare distance selector searches there and silently kills nothing 3.5M
    // blocks away, leaving every staged entity to pile up for later runs.
    await cmd(`kill @e[type=minecraft:chicken,x=${X},y=${Y},z=${Z},distance=..40]`);
    await cmd(`kill @e[type=minecraft:item,x=${X},y=${Y},z=${Z},distance=..40]`);
  });

  test("urgent danger rides ahead of a page it would otherwise sit behind", async () => {
    await call("bot_body", { action: "despawn" });
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
    await sleep(1000);
    await drainEvents(); // the setup despawn's body_removed must not haunt the asserted page
    const cursor = await nowCursor();

    // 30 routine events FIRST, so the danger is genuinely behind them in id order …
    await flood(30);
    // … then the danger (despawning the body emits body_removed, an urgent type).
    await call("bot_body", { action: "despawn" });
    await sleep(500);

    // A page of 5 cannot reach it: 30 audits come first.
    const r = await call("get_events", { cursor, limit: 5 });
    assert.equal(r.returned, 5, "the page is the oldest 5 — ordering is not negotiable");
    assert.equal(r.more, true, "…and it says there is more");
    assert.ok(!(r.events || []).some((e) => e.type === "body_removed"),
      "the danger is genuinely NOT in this page — that is the whole scenario");
    assert.ok(Array.isArray(r.urgent) && r.urgent.length >= 1,
      `danger queued behind the page must be previewed (got ${JSON.stringify(r.urgent)})`);
    const preview = r.urgent.find((u) => u.type === "body_removed");
    assert.ok(preview, `the preview names the danger type (got ${JSON.stringify(r.urgent)})`);
    assert.ok(typeof preview.summary === "string" && preview.summary.length > 0,
      "…with a one-line headline, so it can be acted on without paging");

    // NON-CONSUMING: the preview must not move the cursor past the previewed events. Page through
    // and assert the body_removed is still delivered in order.
    let cur = r.cursor, seen = false, guard = 0;
    while (!seen && guard++ < 20) {
      const p = await call("get_events", { cursor: cur, limit: 20 });
      seen = (p.events || []).some((e) => e.type === "body_removed" && e.id === preview.id);
      cur = p.cursor;
      if (!p.more) break;
    }
    assert.ok(seen, "a previewed event is still delivered normally — the preview consumes nothing");
  });

  test("`missed` counts only what this caller would have been given", async () => {
    await call("bot_body", { action: "despawn" });
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
    await sleep(1000);
    const cursor = await nowCursor();
    // One urgent event of our own, then bury the ring (cap 1000) in audit records.
    await call("bot_body", { action: "despawn" });
    await sleep(300);
    await flood(1100);

    // Unfiltered: the loss is real and disclosed, and the danger among it is named.
    const all = await call("get_events", { cursor, limit: 1 });
    assert.ok(all.missed > 0, `evictions must still be disclosed (missed=${all.missed})`);
    assert.ok(all.missed_urgent >= 1,
      `…and danger among the lost is named separately (missed_urgent=${all.missed_urgent})`);

    // Filtered to a type that was never emitted in that span: nothing of MINE was lost.
    const mine = await call("get_events", { cursor, type: "weather_changed", limit: 1 });
    assert.equal(mine.missed, 0,
      `missed must be counted through the caller's own filter, not the raw ring gap (got ${mine.missed})`);
    assert.equal(mine.missed_urgent, undefined, "…and no danger claim when nothing of mine was lost");
  });

  test("a player-legal session is not served the server's audit ledger", async () => {
    const cursor = await nowCursor();
    await cmd(`setblock ${X + 5} ${Y} ${Z + 5} minecraft:gold_block`);
    await sleep(500);

    // The copilot (no declared profile) sees the audit trail — that is what it is for.
    const copilot = await call("get_events", { cursor, limit: 200 });
    assert.ok((copilot.events || []).some((e) => e.type === "audit"),
      "an unrestricted session still receives audit records");

    // A legal body does not: it perceived no block change, and the record carries the coordinates.
    const legal = await call("get_events", { cursor, limit: 200 }, { profile: "survival" });
    assert.ok(!(legal.events || []).some((e) => e.type === "audit"),
      "a player-legal session must not read world edits it never perceived");
    // Asking for them explicitly fails fast rather than long-polling a stream that will stay silent.
    const refused = await attempt("get_events", { cursor, type: "audit" }, { profile: "survival" });
    assert.equal(refused.ok, false, "type=audit under a legal profile is refused, not silently empty");
    assert.match(String(refused.error), /legal|perceive/i, `…and says why: ${refused.error}`);
  });
});

describe("the danger sense is bindable: hazard triggers", { skip: !bridgeUp }, () => {
  // The drift test at the end asserts over the types THIS suite produced — anchored here, at the
  // suite's start, because sampling the tail window broke the moment reflex streak-coalescing
  // stopped padding the log with repeat rows (the types were still served, just consumed by the
  // suite's own earlier reads before the tail sample was taken).
  let suiteStart = null;

  test("arming validates the cause — a reflex that can never fire is worse than none", async () => {
    suiteStart = await nowCursor();
    await call("bot_reactions", { action: "clear" });
    const ok = await call("bot_reactions", {
      action: "arm",
      reactions: [{ id: "lava-out", trigger: { kind: "hazard", cause: "in_lava" }, response: { op: "surface" } }],
    });
    assert.ok(JSON.stringify(ok).includes("lava-out"), "a valid cause arms");

    const bad = await attempt("bot_reactions", {
      action: "arm",
      reactions: [{ id: "typo", trigger: { kind: "hazard", cause: "on_lava" }, response: { op: "surface" } }],
    });
    assert.equal(bad.ok, false, "a misspelled cause must be rejected at arm time");
    assert.match(String(bad.error), /in_lava/, `…and lists the vocabulary: ${bad.error}`);
  });

  test("a body in lava fires its hazard reflex on the tick, not on the round-trip", async () => {
    await cmd(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X - 3} ${Y - 1} ${Z - 3} minecraft:lava`);
    await sleep(1000);
    await call("bot_body", { action: "despawn" });
    await call("bot_reactions", { action: "clear" });
    await call("bot_reactions", {
      action: "arm",
      reactions: [{ id: "lava-out", trigger: { kind: "hazard", cause: "in_lava" }, response: { op: "surface" } }],
    });
    // Spawn on the PLATFORM and move into the pit, rather than asking to be created above lava.
    // The spawn guard refuses a cell with nothing survivable to land on — correctly: "put a body
    // here" and "put a body where it will immediately burn" are the same request to it, and this
    // test wants the second one. Getting into the lava is what the test is about; being placed
    // there is not, so it walks in through the door instead of arguing with the lock.
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
    const me = (await call("bot_status", {})).name;
    const cursor = await nowCursor();
    await cmd(`tp ${me} ${X - 4.5} ${Y - 1} ${Z - 4.5}`);
    await sleep(4000);

    const danger = await findEvent("body_endangered", cursor, (e) => e.data?.cause === "in_lava");
    assert.ok(danger, "lava must announce itself, as in_lava");
    assert.match(String(danger.data.remedy), /hazard/, "…and the remedy names the reflex that binds it");
    const fired = await findEvent("reaction_fired", cursor, (e) => e.data?.id === "lava-out");
    assert.ok(fired, "the armed hazard reflex must FIRE — that is the fix");

    await call("bot_body", { action: "despawn" });
    await call("bot_reactions", { action: "clear" });
    await cmd(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X - 3} ${Y - 1} ${Z - 3} minecraft:stone`);
  });

  // LAST on purpose. This asserts over the types the preceding probes actually produced, so it has
  // to run after them — placed second (its first home) it saw a log holding nothing but the staging
  // `audit` rows and passed while proving almost nothing. A drift test with an empty input set is
  // the same failure it exists to catch, one level up.
  test("every type the log actually served is named in the tool contract", async () => {
    // `type` is an exact-match filter, so a type the description does not name is a type no session
    // can subscribe to — that is how thirteen live types once went invisible.
    const manifest = await fetch(`${BASE}/tools`).then((r) => r.json());
    const tools = Array.isArray(manifest) ? manifest : (manifest.tools ?? []);
    const doc = JSON.stringify(tools.find((t) => t.name === "get_events") ?? {});
    assert.ok(doc.length > 100, "get_events must be in the manifest");

    // Page from the suite's start cursor so re-reads are included — a row a findEvent already
    // consumed was still SERVED, and this check is about served types, not unread ones.
    const seen = new Set();
    let cur = suiteStart;
    for (let guard = 0; guard < 30; guard++) {
      const page = await call("get_events", { cursor: cur, limit: 200 });
      for (const e of page.events || []) seen.add(e.type);
      cur = page.cursor;
      if (!page.more) break;
    }
    // Guard against a vacuous pass: this run drove a body through spawn, danger, reflexes and
    // despawn, so a near-empty type set means the log was reset under us, not that nothing drifted.
    assert.ok(seen.size >= 4,
      `too few distinct types (${[...seen].join(", ") || "none"}) for this check to mean anything —`
        + " did the game restart mid-suite?");
    for (const required of ["audit", "body_endangered", "reaction_fired"]) {
      assert.ok(seen.has(required), `expected this suite to have produced ${required} (saw ${[...seen].join(", ")})`);
    }
    const unnamed = [...seen].filter((t) => !doc.includes(t));
    assert.deepEqual(unnamed, [],
      `these types are served but named nowhere the model can read: ${unnamed.join(", ")}`);
  });
});
