// Codec validation on push_data (RELEASE_1.md §E1), live.
//
// The claim under test is narrow and worth stating exactly: the running game holds the codec every
// datapack loader uses, so "would this file load?" is answerable on the BYTES, before the write,
// without a reload and without a restart. The three cases where that is not merely faster but is
// the ONLY answer available are the ones this file leans on:
//
//   1. worldgen — `reload_data` does not read it at all, so today a malformed biome is discovered by
//      restarting the world;
//   2. a batched push (`reload:false`) — there is no reload to report from;
//   3. a directory no loader scans — nothing is logged because nothing looked.
//
// It also checks the honesty rule the mechanism has to carry: `checked_by` names what answered, so
// a reply with no `valid` cannot be read as a pass.
//
// No world geometry and no site: every case works inside its own namespace in the live datapack, and
// all but one write nothing at all. The exception is deliberate and is the file's best case — the
// pre-flight answer is checked against the SAME file's reload, which means one server-wide reload.
// That is a global resource, the same one log-channel and registry-detail hold, which is why this
// file belongs in the sequential battery (chunk b) rather than in a concurrent run.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

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

const NS = "mcptk_validate_probe";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const SEP = String.fromCharCode(10);

/** Validate without writing — the door every case but the last two uses. */
const check = async (path, body) => {
  const r = ok(await call("push_data", { path, base64: b64(body), dry_run: true }), `dry push ${path}`);
  assert.ok(r.validation, `push_data must report validation: ${JSON.stringify(r)}`);
  return r;
};

const RECIPE_OK = JSON.stringify({
  type: "minecraft:crafting_shapeless",
  category: "misc",
  ingredients: ["minecraft:stone"],
  result: { id: "minecraft:stone_button", count: 1 },
});

let tmp;

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server (gradlew runServer) first");
  tmp = mkdtempSync(join(tmpdir(), "mcptk-validate-"));
});

after(async () => {
  await call("clear_data", { path: `data/${NS}`, reload: false }).catch(() => {});
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("a good recipe validates, and the reply names the loader and the id", async () => {
  const r = await check(`data/${NS}/recipe/good.json`, RECIPE_OK);
  assert.equal(r.validation.valid, true, `should decode: ${r.validation.error}`);
  assert.equal(r.validation.kind, "recipe");
  assert.equal(r.validation.id, `${NS}:good`);
  assert.equal(r.validation.checked_by, "codec");
});

test("dry_run writes NOTHING — the point of a pre-flight check", async () => {
  const path = `data/${NS}/recipe/never_written.json`;
  const r = await check(path, RECIPE_OK);
  assert.equal(r.dry_run, true);
  assert.equal(r.written, undefined, "a dry run must not report a write");
  assert.equal(r.would_write, path, "it should say where it would have gone");
  const entries = (ok(await call("list_data"), "list_data").entries ?? []).map((e) => e.path ?? e);
  assert.ok(!entries.includes(path), `THE POINT: nothing may be on disk, got ${entries.join(",")}`);
});

test("malformed JSON is caught as JSON, not as a codec failure", async () => {
  const r = await check(`data/${NS}/recipe/broken.json`, '{"type":"minecraft:crafting_shapeless",}');
  assert.equal(r.validation.valid, false);
  assert.match(r.validation.error, /not valid JSON/i, r.validation.error);
});

// THE ARBITER CASE. Everything else here asserts against a constant I wrote; this one asserts the
// pre-flight answer against the GAME'S OWN, taken from the same file one step later. If the two ever
// disagree, the pre-flight check is lying and the whole feature is worse than nothing. (It is also
// the case that showed vanilla loses information here: a DFU list codec DROPS an element that fails
// to decode, so the error a caller gets is "List is too short: 0" and the word `wombat` appears in
// neither answer. Reporting the game's message verbatim is the right behaviour; inventing a better
// one would be inventing a message the log will never contain.)
test("an unresolvable item fails, and the error is VERBATIM what the reload logs", async () => {
  const path = `data/${NS}/recipe/unknown_item.json`;
  const body = JSON.stringify({
    type: "minecraft:crafting_shapeless",
    ingredients: ["minecraft:wombat"],
    result: { id: "minecraft:stone_button", count: 1 },
  });
  const dry = await check(path, body);
  assert.equal(dry.validation.valid, false, "an unresolvable item id must not pass");

  const live = ok(await call("push_data", { path, base64: b64(body), reload: true }), "real push");
  assert.equal(live.ok, false, "the reload must have logged something about it");
  const logged = (live.problems ?? []).map((p) => p.message).join(SEP);
  assert.match(logged, new RegExp(`${NS}:unknown_item`), `the log should name the file: ${logged}`);
  assert.ok(logged.includes(dry.validation.error),
    `THE POINT: the pre-flight error must be exactly the reload's.` +
    ` pre-flight=[${dry.validation.error}] logged=[${logged}]`);
});

test("a recipe with an unregistered TYPE fails on the serializer, not on the fields", async () => {
  const body = JSON.stringify({ type: "mcptk:no_such_serializer", ingredients: [] });
  const r = await check(`data/${NS}/recipe/unknown_type.json`, body);
  assert.equal(r.validation.valid, false);
  assert.match(r.validation.error, /no_such_serializer|Unknown registry key/i, r.validation.error);
});

test("a loot table validates, and a bad pool entry does not", async () => {
  const good = JSON.stringify({
    type: "minecraft:chest",
    pools: [{ rolls: 1, entries: [{ type: "minecraft:item", name: "minecraft:diamond" }] }],
  });
  const g = await check(`data/${NS}/loot_table/good.json`, good);
  assert.equal(g.validation.valid, true, `${g.validation.error}`);
  assert.equal(g.validation.kind, "loot_table");

  const bad = JSON.stringify({
    type: "minecraft:chest",
    pools: [{ rolls: 1, entries: [{ type: "minecraft:item", name: "minecraft:not_an_item" }] }],
  });
  const b = await check(`data/${NS}/loot_table/bad.json`, bad);
  assert.equal(b.validation.valid, false, "an unresolvable item in a pool must not pass");
});

test("WORLDGEN is checked — the kind a reload never reads at all", async () => {
  const feature = (block) => JSON.stringify({
    type: "minecraft:block_pile",
    config: { state_provider: { type: "minecraft:simple_state_provider", state: { Name: block } } },
  });
  const g = await check(`data/${NS}/worldgen/configured_feature/good.json`, feature("minecraft:hay_block"));
  assert.equal(g.validation.valid, true, `${g.validation.error}`);
  assert.equal(g.validation.kind, "worldgen/configured_feature");
  assert.equal(g.validation.id, `${NS}:good`);

  const b = await check(`data/${NS}/worldgen/configured_feature/bad.json`, feature("minecraft:not_a_block"));
  assert.equal(b.validation.valid, false,
    "THE POINT: this file is only read at world load, so nothing else in the toolkit can say this");
});

test("a tag decodes AND its members are resolved — the codec alone would pass a typo", async () => {
  const body = JSON.stringify({
    values: ["minecraft:stone", "minecraft:granite", "minecraft:wombat_ore",
             { id: "minecraft:also_missing", required: false }, "#minecraft:logs"],
  });
  const r = await check(`data/${NS}/tags/block/probe.json`, body);
  assert.equal(r.validation.valid, true, "the tag FILE is well formed, and that is the trap");
  assert.equal(r.validation.kind, "tags/block");
  assert.deepEqual(r.validation.unknown_ids, ["minecraft:wombat_ore"],
    "only the REQUIRED missing member counts: required:false is intent, and #tag may arrive later");
});

test("the plural tag directory — a real typo — is reported as scanned by nothing", async () => {
  const r = await check(`data/${NS}/tags/blocks/probe.json`, JSON.stringify({ values: [] }));
  assert.equal(r.validation.kind, null, "tags/blocks is not a directory the game reads");
  assert.equal(r.validation.checked_by, "none");
  assert.equal(r.validation.valid, undefined,
    "no `valid` field at all — an unchecked file must not read as a pass");
  assert.match(r.validation.note, /SINGULAR|tags\/block\b/, r.validation.note);
});

test("a directory no loader scans is named as such", async () => {
  const r = await check(`data/${NS}/wombat/x.json`, "{}");
  assert.equal(r.validation.kind, null);
  assert.equal(r.validation.checked_by, "none");
  assert.match(r.validation.note, /nothing reads it/, r.validation.note);
});

test("a function is compiled by the real dispatcher, and a bad line is named", async () => {
  const g = await check(`data/${NS}/function/good.mcfunction`,
    "# a comment\nsay hello\nsetblock ~ ~ ~ minecraft:stone\n");
  assert.equal(g.validation.valid, true, `${g.validation.error}`);
  assert.equal(g.validation.kind, "function");
  assert.equal(g.validation.checked_by, "command_dispatcher");

  const b = await check(`data/${NS}/function/bad.mcfunction`, "say ok\nsetblock ~ ~ ~ minecraft:wombat\n");
  assert.equal(b.validation.valid, false, "an unknown block in setblock must not compile");
  assert.match(b.validation.error, /line 2/i, b.validation.error);
});

test("a structure .nbt is read as NBT, and junk bytes are refused as such", async () => {
  // A minimal gzipped NBT compound: TAG_Compound, empty name, TAG_End. Enough to prove the branch
  // reads the bytes rather than trusting the extension; capture_structure's own probe covers the
  // census fields on a real template.
  const empty = zlib.gzipSync(Buffer.from([0x0a, 0x00, 0x00, 0x00])).toString("base64");
  const g = ok(await call("push_data", {
    path: `data/${NS}/structure/empty.nbt`, base64: empty, dry_run: true,
  }), "dry push nbt");
  assert.equal(g.validation.kind, "structure");
  assert.equal(g.validation.checked_by, "nbt");
  assert.equal(g.validation.valid, true, `${g.validation.error}`);

  const b = ok(await call("push_data", {
    path: `data/${NS}/structure/junk.nbt`, base64: b64("hello"), dry_run: true,
  }), "dry push junk");
  assert.equal(b.validation.valid, false, "five ASCII bytes are not a structure");
  assert.match(b.validation.error, /GZIP|NBT/i, b.validation.error);
});

test("an advancement validates", async () => {
  const body = JSON.stringify({
    criteria: { tick: { trigger: "minecraft:tick" } },
    rewards: { experience: 1 },
  });
  const r = await check(`data/${NS}/advancement/probe.json`, body);
  assert.equal(r.validation.valid, true, `${r.validation.error}`);
  assert.equal(r.validation.kind, "advancement");
});

test("a REAL push reports validation too, and still writes when the file is bad", async () => {
  const path = `data/${NS}/recipe/written_anyway.json`;
  const body = JSON.stringify({
    type: "minecraft:crafting_shapeless",
    ingredients: ["minecraft:wombat"],
    result: { id: "minecraft:stone_button", count: 1 },
  });
  const r = ok(await call("push_data", { path, base64: b64(body), reload: false }), "real push");
  assert.equal(r.validation.valid, false, "the push must report the problem");
  assert.ok(r.written, "and must still write: a batch pushes siblings in an order where one "
    + "cannot resolve the other yet, so a refusal would make that order illegal");
  const entries = (ok(await call("list_data"), "list_data").entries ?? []).map((e) => e.path ?? e);
  assert.ok(entries.includes(path), "the file should be in the pack");
});

test("a file that is written from a local path is checked the same way", async () => {
  const file = join(tmp, "from-disk.json");
  writeFileSync(file, RECIPE_OK);
  const r = ok(await call("push_data", {
    path: `data/${NS}/recipe/from_disk.json`, file, dry_run: true,
  }), "dry push from file");
  assert.equal(r.validation.valid, true, `${r.validation.error}`);
  assert.equal(r.validation.id, `${NS}:from_disk`);
});
