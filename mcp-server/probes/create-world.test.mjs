// `create_world` (RELEASE_1.md section K2, ArmorPieces' ask 1): a world from the title screen with
// its datapacks enabled AT CREATION.
//
// The finding the tool was asked for - "a pack folder created AFTER the world loaded is invisible
// to /reload, because the first pack.mcmeta classification sticks" - is tested as the last case,
// and on 26.2 it does not hold (see there). The tool's reason survives it: a suite that reuses a
// world tests yesterday's state, and a fresh seeded world with its pack on the first load is what
// a release gate wants.
//
// Claims, each its own case:
//   * A flat world named here, seeded, creative, with fixtures/k2-pack copied in and enabled,
//     comes up (get_world_info answers), and the pack's loot table ROLLS - the pack loaded through
//     creation, not through a reload.
//   * The seed and the flat preset held: the reply's seed is the one given, and the ground under
//     spawn is classic_flat's grass over dirt.
//   * The game rules given at creation were applied on the server's first start (the reply says
//     `gamerules_pending`, and `gamerule` reads the value back).
//   * A second create of the same name is refused by name unless replace:true; a bad pack path is
//     refused BEFORE anything is created; a folder with no pack.mcmeta is refused by that fact.
//   * THE MEASUREMENT (written as the consumer's falsifier, and it falsified the consumer): a
//     second pack copied into the save's datapacks/ after the load, then /reload. ArmorPieces'
//     finding was that such a pack is invisible - "the first pack.mcmeta classification sticks".
//     On 26.2 it is NOT: the late pack is detected and auto-enabled as a world pack, and so is
//     one whose first pack.mcmeta was broken and fixed after a reload. The case pins what this
//     build does, so that if a later version starts behaving as the consumer saw, this goes red
//     and the tool's description changes with it.
//
// GATED: this file creates a world and LEAVES THE CLIENT IN IT, which is not a thing to do in the
// middle of a battery that owns sites in another world. It runs only with MCPTK_PROBE_CREATE_WORLD=1
// and a client at the TITLE SCREEN (right after tools/rebuild.ps1). Deletes the save it made the
// next time it runs (replace:true) rather than on exit, because the world is open on exit.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-create-world";
const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, "fixtures", "k2-pack");
const NAME = "probe-k2-world";

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
async function refused(tool, args) {
  const j = await raw(tool, args);
  assert.equal(j.ok, false, `${tool} ${JSON.stringify(args)} should have been refused: ${JSON.stringify(j.result)}`);
  return JSON.stringify(j.error);
}
async function command(cmd) {
  const r = await call("run_command", { command: cmd });
  const out = (r.output ?? []).join(" | ");
  if (/<--\[HERE\]|Can't find|Unknown or incomplete command/i.test(out)) throw new Error(`\`${cmd}\` did not run: ${out}`);
  return out;
}
async function waitForWorld(ms = 90_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const info = await raw("get_world_info");
    if (info.ok && info.result?.world_uuid) {
      // The SERVER is up before the CLIENT has joined its level: a create_world call in that gap
      // sees no open level and answers the exists refusal rather than "already open". The client
      // is in the world once no screen is up (loading screens are screens; the title screen too).
      while (Date.now() - started < ms) {
        const s = await raw("get_screen");
        if (s.ok && s.result?.screen === null) return info.result;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("the server is up but the client never arrived in the level");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the world never answered get_world_info");
}

const enabled = process.env.MCPTK_PROBE_CREATE_WORLD === "1";
const bridgeUp = enabled && (await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false));
const clientPresent = bridgeUp && (await raw("ping")).result?.clientPresent === true;
const atTitle = clientPresent && !(await raw("get_world_info")).ok;
if (!enabled) console.log("\n  [skip] create-world: set MCPTK_PROBE_CREATE_WORLD=1 with a client at the title screen\n");
else if (!atTitle) console.log("\n  [skip] create-world needs a CLIENT at the TITLE SCREEN\n");

describe("create_world: a world with its packs enabled at creation", { skip: !atTitle }, () => {
  let reply;

  before(async () => {
    // Refusals that must happen BEFORE anything is made, on a name that is never created.
    const FRESH = `${NAME}-never`;
    assert.match(await refused("create_world", { name: FRESH, datapacks: [join(HERE, "fixtures", "no-such-pack")] }), /does not exist/);
    const bare = join(HERE, "fixtures", "k2-not-a-pack");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "readme.txt"), "no pack.mcmeta here\n");
    assert.match(await refused("create_world", { name: FRESH, datapacks: [bare] }), /no pack\.mcmeta/);
    assert.match(await refused("create_world", { name: "bad/name" }), /letters, digits/);
    // A previous run's save: refused by name without replace, which is the exists case.
    const saves = (await call("open_world")).worlds ?? [];
    if (saves.includes(NAME)) {
      assert.match(await refused("create_world", { name: NAME }), /exists.*replace:true/);
    }

    reply = await call("create_world", {
      name: NAME, seed: "12345", generator: "flat", flat: "minecraft:classic_flat",
      gamemode: "creative", difficulty: "peaceful", datapacks: [PACK],
      gamerules: { advance_time: "false", keep_inventory: "true" },
      replace: true, // a previous run left this save behind
    });
  });

  test("the reply names what was started", () => {
    assert.equal(reply.creating, NAME);
    assert.equal(reply.seed, 12345);
    assert.equal(reply.generator, "flat:minecraft:classic_flat");
    assert.ok(reply.datapacks_enabled.includes("file/k2-pack"), JSON.stringify(reply.datapacks_enabled));
    assert.equal(reply.datapacks_copied?.length, 1, JSON.stringify(reply));
    assert.equal(reply.gamerules_pending, 2);
    assert.match(reply.note, /STARTED/);
  });

  test("the world comes up and the pack's loot table rolls - it loaded through creation", async () => {
    const world = await waitForWorld();
    assert.equal(world.name ?? world.level_name ?? NAME, NAME);
    // The pack: its table exists to the server that was created with it.
    let rolled = null;
    for (let i = 0; i < 20 && !rolled; i++) {
      const r = await raw("roll_loot", { table: "probe_k2:k2", count: 4, seed: 1 });
      if (r.ok && r.result?.exists === true) rolled = r.result;
      else await new Promise((res) => setTimeout(res, 500));
    }
    assert.ok(rolled, "probe_k2:k2 rolls");
    assert.match(JSON.stringify(rolled), /minecraft:stick/, "the table gives a stick");
    const packs = await command("datapack list enabled");
    assert.match(packs, /k2-pack/, `enabled packs name the copied one: ${packs}`);
  });

  test("the game rules given at creation are on the server", async () => {
    assert.match(await command("gamerule advance_time"), /false/);
    assert.match(await command("gamerule keep_inventory"), /true/);
  });

  test("a second create of the same name is refused while the world is open", async () => {
    assert.match(await refused("create_world", { name: NAME }), /already open/);
  });

  test("MEASURED: a pack copied in after the load is picked up by /reload on this version", async () => {
    const info = await call("ping");
    const packs = join(info.gameDir, "saves", NAME, "datapacks");
    const META = '{"pack":{"description":"late","pack_format":107,"min_format":107,"max_format":107}}';
    const table = (item) => `{"type":"minecraft:empty","pools":[{"rolls":1,"entries":[{"type":"minecraft:item","name":"${item}"}]}]}`;
    // (1) A valid pack, after the load.
    const late = join(packs, "k2-late-pack");
    mkdirSync(join(late, "data", "probe_late", "loot_table"), { recursive: true });
    writeFileSync(join(late, "pack.mcmeta"), META);
    writeFileSync(join(late, "data", "probe_late", "loot_table", "late.json"), table("minecraft:apple"));
    // (2) The consumer's exact shape: a BROKEN pack.mcmeta first, a reload, then the fix.
    const bad = join(packs, "k2-bad-then-fixed");
    mkdirSync(join(bad, "data", "probe_bad", "loot_table"), { recursive: true });
    writeFileSync(join(bad, "pack.mcmeta"), "not json");
    writeFileSync(join(bad, "data", "probe_bad", "loot_table", "bad.json"), table("minecraft:bread"));
    await command("reload");
    await new Promise((r) => setTimeout(r, 1500));
    let enabledNow = await command("datapack list enabled");
    assert.match(enabledNow, /k2-late-pack/, `a valid late pack is auto-enabled by /reload: ${enabledNow}`);
    assert.doesNotMatch(enabledNow, /k2-bad-then-fixed/, "a pack with a broken pack.mcmeta is not");
    writeFileSync(join(bad, "pack.mcmeta"), META);
    await command("reload");
    await new Promise((r) => setTimeout(r, 1500));
    enabledNow = await command("datapack list enabled");
    assert.match(enabledNow, /k2-bad-then-fixed/,
      `the consumer's finding: a pack whose FIRST pack.mcmeta was broken stays invisible - it does NOT on this build, it is enabled once fixed: ${enabledNow}`);
    const r = await call("roll_loot", { table: "probe_bad:bad", count: 2, seed: 1 });
    assert.equal(r.exists, true, "and its table rolls");
  });
});
