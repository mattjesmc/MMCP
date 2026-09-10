import { test } from "node:test";
import assert from "node:assert/strict";
import { resumeDrift, completedCells, parseRows, RESUME_GUARDED } from "./resume.mjs";

const base = {
  bench_version: "0.9.5", model: "haiku", adapter: "mcp-shim",
  tools_hash: "abc123", questions_hash: "def456",
  rungs: [1, 2, 3], arms: { with: { hidden: [] } }, seeds: 2, reps: 2,
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test("identical manifests resume cleanly", () => {
  assert.deepEqual(resumeDrift(base, clone(base), ["rungs", "arms", "seeds", "reps"]), []);
});

test("every guarded field is fatal on its own", () => {
  for (const k of RESUME_GUARDED) {
    const cur = clone(base);
    cur[k] = "MOVED";
    const drift = resumeDrift(base, cur);
    assert.equal(drift.length, 1, `${k} should be fatal`);
    assert.match(drift[0], new RegExp(`^${k}: `));
  }
});

test("tools_hash drift is caught — the e_repair_bridge_gap pooling hazard", () => {
  // Same bench_version, different toolkit build: the exact case that made a fixed rung read 60%.
  const cur = { ...clone(base), tools_hash: "e394fbf455c3" };
  const drift = resumeDrift(base, cur);
  assert.equal(drift.length, 1);
  assert.match(drift[0], /tools_hash/);
});

test("per-runner selectors are guarded only when asked for", () => {
  const cur = { ...clone(base), rungs: [1, 2] };
  assert.deepEqual(resumeDrift(base, cur), [], "not guarded unless requested");
  assert.equal(resumeDrift(base, cur, ["rungs"]).length, 1);
});

test("arms compare by name set, not spec body", () => {
  const cur = clone(base);
  cur.arms = { with: { hidden: ["a_new_tool"] } }; // same arm, different body
  assert.deepEqual(resumeDrift(base, cur, ["arms"]), [], "spec body churn must not block resume");
  cur.arms = { with: {}, without: {} };            // a genuinely different question
  assert.equal(resumeDrift(base, cur, ["arms"]).length, 1);
});

test("completed cells exclude error rows so crashed cells are retried", () => {
  const rows = [
    { id: "t1", arm: "with", rep: 1 },
    { id: "t2", arm: "with", rep: 1, error: "boom" },
    { id: "t3", arm: "with", rep: 1, correct: false }, // a WRONG answer is still a result
  ];
  const done = completedCells(rows, (r) => `${r.id}|${r.arm}|${r.rep}`);
  assert.ok(done.has("t1|with|1"));
  assert.ok(!done.has("t2|with|1"), "error row must be retried");
  assert.ok(done.has("t3|with|1"), "a wrong answer is a result, not a hole");
});

test("a torn trailing line from a kill does not abort the resume", () => {
  const text = '{"id":"t1","arm":"with","rep":1}\n{"id":"t2","arm":"wit';
  const rows = parseRows(text);
  assert.equal(rows.length, 1);
  assert.equal(completedCells(rows, (r) => r.id).size, 1);
});

test("missing fields on either side are drift, not a crash", () => {
  assert.ok(resumeDrift({}, base).length > 0);
  assert.ok(resumeDrift(base, {}).length > 0);
  assert.doesNotThrow(() => resumeDrift(null, null));
});
