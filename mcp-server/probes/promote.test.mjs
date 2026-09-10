// Promotion — live pack → mod source (RELEASE_1.md §D9), live, on the datapack half.
//
// The feature is one argument on `clear_data` / `clear_assets`, and the reason it lives THERE is the
// thing this file mostly checks: promotion is a copy plus a clear, and the clear is the step
// LIVE_MODDING.md has always warned gets forgotten. So the interesting cases are the refusals —
// each one has to leave the pack exactly as it found it, because a promotion that has already
// deleted the override and then failed to write the copy is the only outcome worse than not
// promoting at all.
//
// Server half only. `clear_assets` shares every line of the mechanism (Promote.java) but runs in the
// CLIENT context, so it is compiled here and live-run when a client is attached — the same shape as
// §D1's owed client arm.
//
// No world geometry, no site, and every call passes reload:false: this file writes and deletes files
// inside the live datapack and never reloads the server, so it holds no global resource and is safe
// beside anything. It stays out of paths any other probe pushes into by using its own namespace.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const ok = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.error ?? JSON.stringify(r)}`);
  return r.result;
};

const NS = "mcptk_promote_probe";
const DIR = `data/${NS}/recipe`;
const ONE = `${DIR}/one.json`;
const TWO = `${DIR}/two.json`;
// These are the bytes a promotion moves, and nothing here cares what they mean — but they are also
// the only recipes in the corpus that were never asked whether they LOAD, and they did not. The
// 0.100.0 codec check answered `List is too short: 0` for both: an Ingredient in 26.2 is an item id
// or a #tag, not `{item: ...}`, and a DFU list codec drops the element it cannot decode rather than
// erroring on it, so the file reads perfectly and yields an empty ingredient list. Fixed rather than
// left, because a wrong example in a probe is a wrong example a reader copies.
const BODY_ONE = JSON.stringify({ type: "minecraft:crafting_shapeless", category: "misc", ingredients: ["minecraft:stone"], result: { id: "minecraft:stone_button", count: 1 } });
const BODY_TWO = JSON.stringify({ type: "minecraft:crafting_shapeless", category: "misc", ingredients: ["minecraft:dirt"], result: { id: "minecraft:coarse_dirt", count: 1 } });

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const push = (path, body) => call("push_data", { path, base64: b64(body), reload: false });
const listed = async () => (ok(await call("list_data"), "list_data").entries ?? [])
  .map((e) => e.path ?? e);

let tmp;      // a scratch root that stands in for a mod checkout
let modRoot;  // …/src/main/resources, with a fabric.mod.json so it is recognisable
let emptyDir; // exists, but looks like nothing

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server (gradlew runServer) first");
  tmp = mkdtempSync(join(tmpdir(), "mcptk-promote-"));
  modRoot = join(tmp, "src", "main", "resources");
  mkdirSync(modRoot, { recursive: true });
  writeFileSync(join(modRoot, "fabric.mod.json"), '{"schemaVersion":1,"id":"probe"}');
  emptyDir = join(tmp, "not-a-mod");
  mkdirSync(emptyDir, { recursive: true });
});

after(async () => {
  await call("clear_data", { path: `data/${NS}`, reload: false }).catch(() => {});
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("a destination that does not exist is refused, and NOTHING is cleared", async () => {
  ok(await push(ONE, BODY_ONE), "push one");
  assert.ok((await listed()).includes(ONE), "the push should be in the pack");

  const r = await call("clear_data", { path: ONE, promote: join(tmp, "nowhere"), reload: false });
  assert.equal(r.ok, false, "a promotion with nowhere to go must be refused");
  assert.match(r.error, /no such directory/, `the refusal should name the problem: ${r.error}`);
  assert.ok((await listed()).includes(ONE),
    "THE POINT: a refused promotion must leave the override in place, not delete it anyway");
});

test("a directory that exists but is not a resources root is refused by what it is missing", async () => {
  const r = await call("clear_data", { path: ONE, promote: emptyDir, reload: false });
  assert.equal(r.ok, false, "an unrecognisable root must be refused");
  assert.match(r.error, /does not look like a mod resources root/, `unhelpful refusal: ${r.error}`);
  assert.match(r.error, /fabric\.mod\.json/, "the refusal should say what it looked for");
  assert.ok((await listed()).includes(ONE), "still nothing cleared");
  assert.ok(!existsSync(join(emptyDir, "data")), "and nothing was created to hold the promotion");
});

test("promote without path is refused: one mod's source tree is not every namespace's home", async () => {
  const r = await call("clear_data", { promote: modRoot, reload: false });
  assert.equal(r.ok, false, "promoting the whole pack must be refused");
  assert.match(r.error, /needs `path`/, `the refusal should name the fix: ${r.error}`);
  assert.ok((await listed()).includes(ONE), "still nothing cleared");
});

test("a promotion copies the bytes out and clears the override in the same call", async () => {
  const r = ok(await call("clear_data", { path: ONE, promote: modRoot, reload: false }), "promote one");
  assert.equal(r.count, 1, `expected one file cleared, got ${JSON.stringify(r.deleted)}`);
  assert.equal(r.promoted.length, 1, "one file promoted");
  const p = r.promoted[0];
  assert.equal(p.path, ONE, "the pack-relative path is preserved");
  assert.equal(p.overwrote, false, "a first promotion overwrites nothing");
  assert.equal(p.unchanged, undefined, "…and is not 'unchanged'");

  const landed = join(modRoot, ...ONE.split("/"));
  assert.ok(existsSync(landed), `the file is not at ${landed} (reported ${p.to})`);
  assert.equal(readFileSync(landed, "utf8"), BODY_ONE, "the promoted bytes must be the pushed bytes");
  assert.equal(p.to, landed, "`to` must be where the file actually is");

  assert.ok(!(await listed()).includes(ONE), "the override is gone from the pack");
  assert.match(r.note, /next build/,
    "the reply has to say the promoted file reaches the game on the next BUILD, not now");
});

test("promoting the same bytes twice says so, rather than looking like fresh work", async () => {
  ok(await push(ONE, BODY_ONE), "re-push one");
  const r = ok(await call("clear_data", { path: ONE, promote: modRoot, reload: false }), "re-promote");
  const p = r.promoted[0];
  assert.equal(p.overwrote, true, "the source tree already had this path");
  assert.equal(p.unchanged, true,
    "and the bytes were identical — which is the difference between 'just promoted' and 'promoted an hour ago'");
});

test("a directory promotes as a unit, and the emptied directories go with it", async () => {
  ok(await push(ONE, BODY_ONE), "push one");
  ok(await push(TWO, BODY_TWO), "push two");
  const r = ok(await call("clear_data", { path: `data/${NS}`, promote: modRoot, reload: false }), "promote ns");
  assert.equal(r.promoted.length, 2, `expected both files, got ${JSON.stringify(r.promoted)}`);
  assert.equal(r.count, 2, "both cleared");
  assert.equal(readFileSync(join(modRoot, ...TWO.split("/")), "utf8"), BODY_TWO);
  const after2 = await listed();
  assert.ok(!after2.some((p) => p.startsWith(`data/${NS}/`)),
    `the namespace should be gone from the pack: ${JSON.stringify(after2)}`);
});

test("a path that names nothing is refused as nothing, not promoted as everything", async () => {
  const r = await call("clear_data", { path: `${DIR}/nope.json`, promote: modRoot, reload: false });
  assert.equal(r.ok, false, "a missing entry must be refused");
  assert.match(r.error, /no such entry/, `unhelpful refusal: ${r.error}`);
});

test("clear still clears without a promotion", async () => {
  ok(await push(ONE, BODY_ONE), "push one");
  const r = ok(await call("clear_data", { path: ONE, reload: false }), "plain clear");
  assert.equal(r.count, 1, "the old one-file behaviour is unchanged");
  assert.equal(r.promoted, undefined, "no promotion, no promoted block");
  assert.equal(r.note, undefined, "…and no note about a build");
});
