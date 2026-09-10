// The living subject and the pinned tick (RELEASE_1.md section K3, ArmorPieces' asks 3 and 4).
//
// Everything ArmorPieces draws is an entity render layer over equipment. `stage_entity` wears an
// authored geometry file and `studio` stood blocks; nothing put a REAL entity type on the white
// floor wearing stacks in item syntax for `render` to photograph. And a golden diff against a
// moving animation phase is a flaky test, which is worse than no test.
//
// Claims, each its own case:
//   * `studio {equipment:{...}}` stages an armor stand in enchanted diamond, says which entity and
//     that the tick is FROZEN, and answers only once this client has the entity (the same arrival
//     rule the block subject has; the reply's box is a 3x3x3 around it).
//   * Two renders of it, 700 ms apart, are PIXEL-IDENTICAL - and the subject is in them (a
//     non-background pixel count, so an empty studio photographed twice cannot pass).
//   * `leave` discards the entity and unfreezes; `tick query` agrees.
//   * THE FALSIFIER: the same stand with `freeze:false`, two renders 700 ms apart, are NOT
//     identical - the enchantment glint rides the game time (GlobalSettingsUniform: gameTime %
//     24000 + partial tick), so with the tick running it moves. A freeze that could not be told
//     from no freeze would be untestable; this is the case that tells them apart. If the glint
//     ever stops moving on its own, this goes red and the freeze's arbiter is gone with it.
//   * Refusals by name: an entity type that does not exist; `equipment` on a type that wears
//     nothing; `pose` on something that is not an armor stand.
//
// Needs a CLIENT in a world whose studio dimension exists (it arrives on a world's second start).
// Moves the player to the studio and brings it back (leave) in every case, including failure.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { decodePng } from "../image/png.mjs";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-studio-entity";
const STUDIO = "mcptoolkit:studio";

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
  return (r.output ?? []).join(" | ");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const written = [];
async function shot(lookAt) {
  const r = await call("render", { look_at: lookAt, width: 192, height: 192 });
  written.push(r.path);
  return readFileSync(r.path);
}
/** Non-background pixels (anything not near the studio's white) and the raw bytes for equality. */
function subjectPixels(buf) {
  const png = decodePng(buf);
  const ch = png.data.length / (png.width * png.height);
  let n = 0;
  for (let i = 0; i < png.data.length; i += ch) {
    if (Math.max(255 - png.data[i], 255 - png.data[i + 1], 255 - png.data[i + 2]) > 40) n++;
  }
  return n;
}

const EQUIPMENT = {
  head: 'minecraft:diamond_helmet[enchantments={"minecraft:protection":4}]',
  chest: 'minecraft:diamond_chestplate[enchantments={"minecraft:protection":4}]',
  legs: "minecraft:diamond_leggings",
  feet: "minecraft:diamond_boots",
  mainhand: 'minecraft:diamond_sword[enchantments={"minecraft:sharpness":5}]',
};

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
const clientPresent = bridgeUp && (await raw("ping")).result?.clientPresent === true;
const inWorld = clientPresent && (await raw("get_world_info")).ok;
const canvas = inWorld && (await raw("get_blocks_at", { blocks: [{ x: 0, y: 64, z: 0 }], dimension: STUDIO })).ok;
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE}\n`);
else if (!clientPresent) console.log("\n  [skip] the studio moves a CLIENT; this is a dedicated server\n");
else if (!inWorld) console.log("\n  [skip] the client is not in a world\n");
else if (!canvas) console.log("\n  [skip] no studio dimension in this world - it arrives on the world's next start\n");

describe("studio: a living subject, and a pinned tick", { skip: !canvas }, () => {
  let staged;

  after(async () => {
    await raw("studio", { leave: true });
    for (const p of written) { try { unlinkSync(p); } catch { /* already gone */ } }
  });

  test("an armor stand in enchanted diamond, frozen, visible to this client", async () => {
    staged = await call("studio", { equipment: EQUIPMENT });
    assert.equal(staged.from, "entity minecraft:armor_stand");
    assert.match(staged.entity, /^[0-9a-f-]{36}$/, "the entity's uuid");
    assert.equal(staged.frozen, true);
    const size = { x: staged.look_at.max.x - staged.look_at.min.x + 1, y: staged.look_at.max.y - staged.look_at.min.y + 1, z: staged.look_at.max.z - staged.look_at.min.z + 1 };
    assert.deepEqual(size, { x: 3, y: 3, z: 3 }, "a 3x3x3 box around a stand");
    assert.match(await command("tick query"), /frozen/i, "the server says frozen");
  });

  test("two renders 700 ms apart are pixel-identical, and the subject is in them", async () => {
    const a = await shot(staged.look_at);
    await sleep(700);
    const b = await shot(staged.look_at);
    const n = subjectPixels(a);
    assert.ok(n > 300, `the stand is in the frame (${n} non-white pixels)`);
    assert.ok(a.equals(b), "identical bytes: nothing moved between the two frames");
  });

  test("leave discards the entity and unfreezes", async () => {
    const r = await call("studio", { leave: true });
    assert.equal(r.cleared, true);
    assert.equal(r.entity_discarded, true);
    assert.equal(r.unfrozen, true);
    assert.doesNotMatch(await command("tick query"), /frozen/i, "the tick runs again");
  });

  test("FALSIFIER: unfrozen, the glint moves - two renders differ", async () => {
    const s = await call("studio", { equipment: EQUIPMENT, freeze: false });
    assert.equal(s.frozen, false);
    assert.doesNotMatch(await command("tick query"), /frozen/i);
    const a = await shot(s.look_at);
    await sleep(700);
    const b = await shot(s.look_at);
    assert.ok(subjectPixels(a) > 300, "the stand is in the frame");
    assert.equal(a.equals(b), false, "the two frames differ: the freeze is what made the pair above identical");
    await call("studio", { leave: true });
  });

  test("refusals by name", async () => {
    assert.match(await refused("studio", { entity: "minecraft:no_such_mob_k3" }), /no entity type minecraft:no_such_mob_k3/);
    assert.match(await refused("studio", { entity: "minecraft:item_frame", equipment: { head: "minecraft:stone" } }), /wears nothing/);
    assert.match(await refused("studio", { entity: "minecraft:pig", pose: { head: [0, 0, 0] } }), /armor stand/);
    assert.match(await refused("studio", { equipment: { hat: "minecraft:stone" } }), /slots are/);
    assert.match(await refused("studio", { equipment: { head: "minecraft:no_such_item_k3" } }), /no_such_item_k3/);
    await raw("studio", { leave: true });
  });
});
