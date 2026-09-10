// Live probes for the log/error channel (RELEASE_1.md §D1) — the toolkit's last succeeds-falsely hole.
//
// The bug this closes is not subtle once stated. Vanilla's data loaders are FORGIVING: a recipe or
// loot table that fails its codec is logged at ERROR by SimpleJsonResourceReloadListener and then
// stepped over, and the reload future completes normally. So `push_data` wrote the bytes,
// `reload_data` answered `reloaded: true`, and the file had loaded nothing — a modder's only
// evidence was in logs/latest.log, which no tool read.
//
// The fix is deliberately NOT a validator. The game already validated the file, in the only place
// that can; what was missing was reading what it said. So the arbiter here is the pair:
//
//   * a MALFORMED recipe must come back with `ok:false` and a `problems` line NAMING IT, and
//   * a WELL-FORMED one must come back with no problem naming it,
//
// which is one test for the whole claim — a reporter that always says "problems" is as useless as
// one that never does. The second half is asserted by id, not by `ok`: the reload window is a real
// window of a real running game and an unrelated warning can land in it, which is exactly why every
// reported line carries its logger and message rather than being reduced to a boolean.
//
// The rest is the read surface: get_log's filters and cursor, and the `error` events the same
// capture emits so a session watching the stream hears about a broken pack without polling.
//
// This file stages NOTHING in the world — it writes into the live datapack and cleans up after
// itself. It therefore claims no probe site.
//
// BUT IT OWNS SOMETHING THE SITE MAP CANNOT SEE, and that is worth saying out loud: it performs
// SERVER-WIDE datapack reloads (~8 of them), and a reload is not site-scoped the way a staged
// chamber is. `site-map.test.mjs` keeps concurrent probe files from colliding by giving each one
// its own coordinates; there is no equivalent register for "this file briefly stops the world to
// re-read its packs". `tools/battery.ps1` — the arbiter — runs one file at a time, so the battery
// is unaffected; `npm run test:live` runs every file CONCURRENTLY, and that is where this matters.
// Observed once (2026-08-26) in a five-file concurrent run: event-stream's chicken case failed and
// did not reproduce in three further runs of the same set, so it is recorded as a flake with a
// plausible mechanism rather than a proven conflict. It also emits `error` events into the
// broadcast stream that every other probe polls — deduped and capped, but present.
//
// NOT COVERED, said plainly rather than left to be assumed: the `gap` reply. Reaching it needs the
// ring to roll past a held cursor — 1000 WARN-or-worse lines, or 3000 of any level — and a dev
// server writes a few hundred in a whole session, so there is no honest way to provoke it here. The
// arithmetic is one comparison against the ring's oldest seq; the risk it carries is that a cursor
// older than the buffer would otherwise be served a short page that reads like a quiet log.
//
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-log-channel";

async function raw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
async function call(tool, args = {}) {
  const j = await raw(tool, args);
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// The probe's own corner of the live datapack. Namespace `minecraft` on purpose: the point is a
// file the running game actually scans, and an unknown namespace is the documented no-op.
const BROKEN = "data/minecraft/recipe/mcptk_probe_broken.json";
const GOOD = "data/minecraft/recipe/mcptk_probe_good.json";
const SECOND_BROKEN = "data/minecraft/recipe/mcptk_probe_broken_two.json";
const FROM_FILE = "data/minecraft/recipe/mcptk_probe_from_file.json";
const PUSHED = [BROKEN, SECOND_BROKEN, GOOD, FROM_FILE];

// Valid JSON, invalid RECIPE — no `result`. This is the sneaky half of the class: a syntax error at
// least looks broken in an editor, while a codec failure is a file that reads perfectly and loads
// into nothing. It takes vanilla's `ifError` branch, which logs and carries on.
const BROKEN_JSON = JSON.stringify({
  type: "minecraft:crafting_shapeless",
  ingredients: ["minecraft:stick"],
});
const goodRecipe = (count) => JSON.stringify({
  type: "minecraft:crafting_shapeless",
  category: "misc",
  ingredients: ["minecraft:stick"],
  result: { id: "minecraft:oak_button", count },
});

const TMP = join(tmpdir(), "mcptk-probe-log-channel.json");

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("log channel: a reload reports what the game logged and skipped",
  { skip: !bridgeUp }, () => {
  before(async () => {
    if (!bridgeUp) return;
    // The bridge binds at MOD INIT, before the world exists — `/tools` answering is not the same
    // question as "can this file run". Every test here goes through `serverOrThrow`, so a run
    // started in that window fails nine tests for a reason that is not a defect (seen once, by
    // launching the probe five seconds after the port opened). battery.ps1 waits for a world; a
    // hand-run does not, so wait here rather than blame the feature.
    for (let i = 0; i < 60; i++) {
      const j = await raw("list_data", {});
      if (j.ok) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("bridge is up but no world loaded after 60s — start the dev server fully");
  });

  after(async () => {
    if (!bridgeUp) return;
    // Clear BY PATH, never wholesale: this pack is shared with whatever else the session has
    // pushed, and clear_data with no path empties all of it.
    for (const p of PUSHED) {
      await raw("clear_data", { path: p, reload: false });
    }
    await raw("reload_data", {});
    try { rmSync(TMP); } catch { /* the test that writes it may not have run */ }
  });

  test("get_log is capturing, and says why when it is not", async () => {
    const r = await call("get_log", {});
    assert.equal(typeof r.capturing, "boolean");
    assert.equal(r.capturing, true,
      `log capture did not attach: ${r.why ?? "(no reason given — LogCapture.status() is empty)"}`);
    assert.ok(Array.isArray(r.entries), "entries must be an array");
    assert.equal(typeof r.cursor, "number", "a page must carry a cursor to poll from");
    assert.equal(r.ring, "problems", "the default level (warn) reads the problems ring");
  });

  test("a WELL-FORMED recipe reloads with no problem naming it", async () => {
    const r = await call("push_data", { path: GOOD, base64: b64(goodRecipe(1)) });
    assert.equal(r.reloaded, true);
    const named = (r.problems ?? []).filter((p) => p.message.includes("mcptk_probe_good"));
    assert.deepEqual(named, [],
      `a valid recipe was reported as a problem: ${JSON.stringify(named)}`);
  });

  test("the toolkit's OWN live datapack does not warn on every reload", async () => {
    // Found by this very feature on its first live run, which is the argument for it in one line.
    // `pack.mcmeta` declared only `pack_format`, and PackFormat requires min_format/max_format
    // above format 81 for server data — so every reload the toolkit has ever done logged "Error
    // reading pack metadata, attempting fallback type" and fell back to a codec that reports the
    // pack as Integer.MAX_VALUE. It kept working, which is why it survived. Left in place it would
    // also have made `ok:false` permanent and therefore meaningless.
    const r = await call("reload_data", {});
    const meta = (r.problems ?? []).filter((p) => /pack metadata|min_format|max_format/i.test(p.message)
      || /min_format|max_format/i.test(p.thrown ?? ""));
    assert.deepEqual(meta, [],
      `the toolkit's own pack.mcmeta is still malformed: ${JSON.stringify(meta)}`);
  });

  test("a MALFORMED recipe reloads `ok:false` with a problem naming it — the whole point", async () => {
    const r = await call("push_data", { path: BROKEN, base64: b64(BROKEN_JSON) });
    // The lie this replaces: `reloaded` was true and nothing else was said. It is still true —
    // the reload DID run — which is exactly why it was never the field to read.
    assert.equal(r.reloaded, true, "the reload itself still succeeds; that was always the trap");
    assert.equal(r.ok, false, "a reload that logged an ERROR must not report ok");
    assert.ok(Array.isArray(r.problems) && r.problems.length > 0,
      `expected problem lines, got ${JSON.stringify(r)}`);
    const named = r.problems.filter((p) => p.message.includes("mcptk_probe_broken"));
    assert.ok(named.length > 0,
      `the problems must NAME the file that failed; got ${JSON.stringify(r.problems)}`);
    const line = named[0];
    assert.equal(line.level, "ERROR", "a file that did not load is an ERROR, not a warning");
    for (const k of ["seq", "at", "level", "logger", "thread", "message"]) {
      assert.ok(k in line, `problem line is missing "${k}": ${JSON.stringify(line)}`);
    }
  });

  test("get_log finds the same failure by `contains`, and `logger` narrows it", async () => {
    const r = await call("get_log", { contains: "mcptk_probe_broken", limit: 20 });
    assert.ok(r.entries.length > 0, "the failure must be findable in the log after the fact");
    assert.ok(r.entries.every((e) => e.message.toLowerCase().includes("mcptk_probe_broken")
      || (e.thrown ?? "").toLowerCase().includes("mcptk_probe_broken")),
      "`contains` must actually filter");
    const logger = r.entries[0].logger;
    const narrowed = await call("get_log", { contains: "mcptk_probe_broken", logger });
    assert.ok(narrowed.entries.length > 0, "narrowing by the line's own logger must still find it");
    const nonsense = await call("get_log", { contains: "mcptk_probe_broken", logger: "no-such-logger" });
    assert.equal(nonsense.entries.length, 0, "a logger filter that matches nothing must return nothing");
  });

  test("`since` is strictly-after: the same page never arrives twice", async () => {
    const first = await call("get_log", { level: "all", limit: 5 });
    const again = await call("get_log", { level: "all", since: first.cursor, limit: 50 });
    for (const e of again.entries) {
      assert.ok(e.seq > first.cursor, `seq ${e.seq} is not strictly after cursor ${first.cursor}`);
    }
    // And the cursor advances only over lines actually served.
    if (again.entries.length > 0) {
      assert.equal(again.cursor, again.entries.at(-1).seq);
    } else {
      assert.equal(again.cursor, first.cursor);
    }
  });

  test("`level` selects the ring, and a stricter level never returns a milder line", async () => {
    const info = await call("get_log", { level: "info", limit: 50 });
    assert.equal(info.ring, "all", "info reads the all-levels ring");
    const errors = await call("get_log", { level: "error", limit: 50 });
    assert.ok(errors.entries.every((e) => e.level === "ERROR" || e.level === "FATAL"),
      `level:"error" returned a milder line: ${JSON.stringify(errors.entries.map((e) => e.level))}`);
    const bad = await raw("get_log", { level: "chatty" });
    assert.equal(bad.ok, false, "an unknown level must be refused, not silently defaulted");
  });

  test("the same ERROR arrives as an `error` event", async () => {
    // A DIFFERENT broken file, not a second push of the same one: the announcer dedupes by
    // logger+message for ten seconds, and the message names the file — so re-pushing BROKEN here
    // would test the rate limiter and read as a missing feature. (The dedupe has its own test.)
    const before = await call("get_events", { limit: 1 });
    await call("push_data", { path: SECOND_BROKEN, base64: b64(BROKEN_JSON) });
    const evs = await call("get_events", { cursor: before.cursor, type: "error", limit: 50 });
    assert.ok(evs.events.length > 0, "an ERROR during a reload must reach the event stream");
    const mine = evs.events.find((e) => (e.data?.message ?? "").includes("mcptk_probe_broken_two"));
    assert.ok(mine, `no error event named the broken file: ${JSON.stringify(evs.events)}`);
    assert.equal(mine.data.level, "ERROR");
    assert.equal(typeof mine.data.seq, "number",
      "the event must carry the log seq, so get_log {since: seq-1} reads the full line");
    const full = await call("get_log", { since: mine.data.seq - 1, level: "error", limit: 5 });
    assert.equal(full.entries[0].seq, mine.data.seq,
      "the seq on the event must address the very line it was made from");
  });

  test("a repeated ERROR is deduped, not flooded — and the stream says how many it stood for", async () => {
    // One malformed model can log per chunk render; a failed pack reload logs per entry. An error
    // channel that floods the event log destroys the log it was added to, so the repeat collapses
    // and the NEXT emit of that key carries the tally. Re-pushing the same file inside the dedupe
    // window is exactly the storm shape.
    const before = await call("get_events", { limit: 1 });
    for (let i = 0; i < 4; i++) {
      await call("push_data", { path: SECOND_BROKEN, base64: b64(BROKEN_JSON) });
    }
    const evs = await call("get_events", { cursor: before.cursor, type: "error", limit: 50 });
    const mine = evs.events.filter((e) => (e.data?.message ?? "").includes("mcptk_probe_broken_two"));
    assert.ok(mine.length < 4,
      `four identical reload failures produced ${mine.length} events — the dedupe is not holding`);
    // The lines themselves are NOT deduped: get_log keeps every one, which is what makes the
    // collapsed event honest rather than lossy.
    const lines = await call("get_log", { contains: "mcptk_probe_broken_two", limit: 50 });
    assert.ok(lines.entries.length >= 4,
      `get_log must keep every repeat (got ${lines.entries.length}); only the EVENT is deduped`);
  });

  test("a player-legal session gets no `error` events — a body does not read stderr", async () => {
    // The stream half of the rule whose manifest half profiles.test.mjs holds (get_log is DEV_ONLY).
    // Both are documented in ARCHITECTURE.md beside `audit`, so both need an arbiter: a claim about
    // what a survival session CANNOT see is worth exactly as much as the check behind it.
    const legal = async (args) => {
      const res = await fetch(`${BASE}/cmd`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCPTK-Session": `${SESSION}-legal`,
          "X-MCPTK-Profile": "survival",
        },
        body: JSON.stringify({ tool: "get_events", args }),
      });
      return res.json();
    };
    const asked = await legal({ type: "error", limit: 10 });
    assert.equal(asked.ok, false, "asking for type:error under survival must fail fast, not starve");
    assert.match(JSON.stringify(asked.error), /not delivered|perceive/i,
      `the refusal must say why, got ${JSON.stringify(asked.error)}`);
    // And the silent half: an unfiltered poll simply does not carry them.
    const all = await legal({ limit: 200 });
    assert.equal(all.ok, true, `an unfiltered legal poll must still work: ${JSON.stringify(all.error)}`);
    const leaked = all.result.events.filter((e) => e.type === "error" || e.type === "audit");
    assert.deepEqual(leaked, [], `server-ledger events reached a player-legal session: ${JSON.stringify(leaked)}`);
  });

  test("`error` is in the documented vocabulary — a type nobody can name is a type nobody can filter", async () => {
    const tools = await fetch(`${BASE}/tools`).then((r) => r.json());
    const getEvents = tools.find((t) => t.name === "get_events");
    assert.ok(/\berror\b/.test(getEvents.description),
      "get_events' rendered vocabulary must document the `error` type");
  });

  test("push_data accepts `file`, and writes the same bytes base64 would have", async () => {
    const body = goodRecipe(3);
    writeFileSync(TMP, body, "utf8");
    const r = await call("push_data", { path: FROM_FILE, file: TMP, reload: false });
    assert.equal(r.bytes, Buffer.byteLength(body, "utf8"),
      "the pushed byte count must be the file's own");
    const listed = await call("list_data", {});
    const entry = listed.entries.find((f) => f.path === FROM_FILE);
    assert.ok(entry, `${FROM_FILE} is not in the live datapack: ${JSON.stringify(listed)}`);
    assert.equal(entry.bytes, Buffer.byteLength(body, "utf8"));
  });

  test("push_data with neither `base64` nor `file` is refused, not silently empty", async () => {
    const j = await raw("push_data", { path: FROM_FILE, reload: false });
    assert.equal(j.ok, false, "a push with no bytes must be an error");
    assert.match(JSON.stringify(j.error), /base64|file/,
      "the refusal must name the two ways to supply bytes");
  });

  test("a missing `file` names the path rather than writing nothing", async () => {
    const j = await raw("push_data", {
      path: FROM_FILE, file: join(tmpdir(), "mcptk-probe-does-not-exist.json"), reload: false,
    });
    assert.equal(j.ok, false);
    assert.match(JSON.stringify(j.error), /no such file/);
  });
});
