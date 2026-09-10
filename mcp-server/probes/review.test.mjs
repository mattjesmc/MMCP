// The review layer (mcp-toolkit review/, toolkit 0.76.0) — what a HEADLESS run can pin without a
// human standing in the world:
//
//   1. THE RULE HOLDS AT THE DOOR — an ask with no `failure` is refused, by the record's own
//      constructor, with a message that says why. This is the layer's one non-negotiable rule
//      (both ancestors enforced it) and the only one a probe can prove without a person.
//   2. A POST IS READABLE BACK — review_post then review_status round-trips the ask, with its
//      setup commands and its state.
//   3. AN EXISTING ID EDITS, IT DOES NOT DUPLICATE — and a re-post keeps any verdict already
//      given, which is what makes Review.declare safe to run on every boot.
//   4. A CHECK CAN ANSWER AN ASK, AND FILES ITSELF AS `checked` — never as `ok`. "The world
//      satisfies this" and "a person looked and was happy" are different facts and the layer
//      exists to keep them apart. The failing direction is silent by design: a predicate that does
//      not hold cannot tell a broken feature from an unstaged world.
//   5. THE POLL CHANNEL EXISTS — GET /mmcp review serves the shape the client card parses.
//
// The walk itself (staging, the card, a verdict) needs a connected player and is the supervised
// smoke, not this. No site owned: every ask this file posts is removed again at the end.

import { test, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const MINE = "probe-review";

const SESSION = await fetch(`${BASE}/hello`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "review-probe" }),
  signal: AbortSignal.timeout(3000),
}).then((r) => r.json()).then((j) => j.session ?? null).catch(() => null);

async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SESSION ? { "X-MCPTK-Session": SESSION } : {}),
    },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

const ask = (id, extra = {}) => ({
  id,
  source: MINE,
  title: "probe ask " + id,
  look: "nothing — this ask exists only to be read back by a probe",
  failure: "it is missing from review_status, or its fields came back changed",
  ...extra,
});

// `/mmcp review check` DEFERS its sweep by one tick, and it must: a command run from inside a command is
// queued rather than executed, so a sweep that ran in the handler would read every check as "did not
// hold". Waiting is therefore part of the contract, not probe flakiness.
async function sweep() {
  const j = await call("run_command", { command: "mmcp review check" });
  await new Promise((r) => setTimeout(r, 300));
  return j;
}

async function rows() {
  const j = await call("review_status", { source: MINE, limit: 100 });
  assert.equal(j.ok, true, `review_status failed: ${JSON.stringify(j)}`);
  return j.result.asks;
}

test("an ask with no failure mode is refused, and says why", { skip: !bridgeUp }, async () => {
  const j = await call("review_post", {
    id: `${MINE}-nofail`,
    source: MINE,
    title: "does the fog look right?",
    look: "the fog",
  });
  assert.equal(j.ok, false, `expected refusal, got: ${JSON.stringify(j)}`);
  assert.match(j.error, /failure/i, `the refusal must name the missing field: ${j.error}`);
  assert.match(j.error, /cannot fail|wrong/i,
    `the refusal must say WHY the field is required: ${j.error}`);
});

test("a posted ask reads back with its staging commands", { skip: !bridgeUp }, async () => {
  const posted = await call("review_post", ask(`${MINE}-1`, {
    setup: ["time set noon", "weather clear"],
  }));
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(posted.result.updated, false, "a new id is not an update");
  assert.equal(posted.result.state, "open");

  const found = (await rows()).find((a) => a.id === `${MINE}-1`);
  assert.ok(found, "the posted ask is missing from review_status");
  assert.equal(found.state, "open");
  assert.equal(found.failure, ask(`${MINE}-1`).failure, "the failure mode must survive the trip");
  assert.deepEqual(found.setup, ["time set noon", "weather clear"]);
});

test("re-posting an existing id edits it instead of duplicating", { skip: !bridgeUp }, async () => {
  const again = await call("review_post", ask(`${MINE}-1`, {
    title: "probe ask, reworded",
    setup: ["time set midnight"],
  }));
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.result.updated, true, "an existing id must report itself as an update");

  const mine = (await rows()).filter((a) => a.id === `${MINE}-1`);
  assert.equal(mine.length, 1, `one id, one ask — got ${mine.length}`);
  assert.equal(mine[0].title, "probe ask, reworded");
  assert.deepEqual(mine[0].setup, ["time set midnight"], "the edit replaces the staging");
});

test("a check that holds closes the ask as `checked`, never as `ok`",
  { skip: !bridgeUp }, async () => {
    // `time query gametime` succeeds with the tick count as its result, so this check holds on any
    // running world — the probe is about the VERDICT the referee files, not about the predicate's
    // subject. (A position-based check would be at the mercy of what happens to be loaded: `execute
    // if loaded 0 64 0` answers "Test failed" on this very server.)
    const posted = await call("review_post", ask(`${MINE}-checked`, {
      check: "time query gametime",
    }));
    assert.equal(posted.ok, true, JSON.stringify(posted));
    assert.match(posted.result.note ?? "", /checked/,
      "posting an ask with a check must say what the check will do");

    const swept = await sweep();
    assert.equal(swept.ok, true, JSON.stringify(swept));

    const found = (await rows()).find((a) => a.id === `${MINE}-checked`);
    assert.ok(found, "the checked ask vanished from the queue");
    assert.equal(found.state, "checked",
      "a predicate answering an ask is NOT a human's ok — it has its own state");
    assert.equal(found.by, "referee", "a machine verdict must name the machine");
    assert.match(found.comment ?? "", /check passed/, "the verdict must name the check that closed it");
  });

test("a check that does not hold leaves the ask open, silently", { skip: !bridgeUp }, async () => {
  const posted = await call("review_post", ask(`${MINE}-unchecked`, {
    // Deliberately NOT a position: this file owns no site, and site-map.test.mjs is right to refuse
    // a coordinate another probe already claims even when the probe only names it in a predicate.
    // An entity type nothing on the dev world is spawns the same "did not hold" with no site at all.
    check: "execute if entity @e[type=minecraft:ender_dragon,limit=1]",
  }));
  assert.equal(posted.ok, true, JSON.stringify(posted));
  await sweep();

  const found = (await rows()).find((a) => a.id === `${MINE}-unchecked`);
  assert.equal(found.state, "open",
    "a failing predicate cannot tell a broken feature from an unstaged world, so it must not"
      + " file a verdict in either direction");
});

test("GET /mmcp review serves the card's shape", { skip: !bridgeUp }, async () => {
  const body = await fetch(`${BASE}/review`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.json());
  assert.ok(body && typeof body.asks === "object",
    `the client tailer parses {asks:{}} — got ${JSON.stringify(body)}`);
});

// Leave the queue as it was found: this probe's asks are noise in a real review walk. `drop` only
// takes OPEN asks, so the `checked` one is answered and stays — deliberately, and the probe says so
// rather than reaching for a verb that would let a verdict be deleted.
after(async () => {
  if (!bridgeUp) return;
  for (const id of [`${MINE}-1`, `${MINE}-unchecked`]) {
    await call("run_command", { command: `mmcp review drop ${id}` }).catch(() => {});
  }
});
