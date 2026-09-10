// `get_tooltip` (RELEASE_1.md section K2, ArmorPieces' ask 5): the lines the game would render for
// a stack, as text. A tooltip was the one piece of UI a mod writes that nothing could read back -
// get_screen reports slots and click reaches them, but hovering is not an event a screen exposes.
//
// Claims, each its own case:
//   * `item` in full item syntax, components included: a custom name and an enchantment both come
//     back as lines, in vanilla's order (name first), and `advanced:true` adds the id line.
//   * A bad id is refused BY NAME, not answered with air.
//   * Exactly one of item/slot: neither and both are refused.
//   * `slot`: with a world open, the toolkit's own example screen has slots; the tooltip of a
//     non-empty one names its item, and an empty one answers empty:true.
//   * At the TITLE SCREEN every call is refused, naming the reason: vanilla's item components are
//     bound when a level's registries load, and before that ItemParser answers "Components not
//     bound yet" for any id (measured; the first version of this file expected a name-only stack
//     to work there and it did not).
//
// Needs a CLIENT (the lines are rendered by its tooltip pipeline). Skips on a dedicated server and
// when the bridge is down. Stages nothing, claims no site.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-tooltip";

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

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
const clientPresent = bridgeUp && (await raw("ping")).result?.clientPresent === true;
const inWorld = clientPresent && (await raw("get_world_info")).ok;
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE}\n`);
else if (!clientPresent) console.log("\n  [skip] get_tooltip needs a client; this is a dedicated server\n");

describe("get_tooltip at the title screen: refused, by reason", { skip: !clientPresent || inWorld }, () => {
  test("no level, no stack - the refusal names the door", async () => {
    assert.match(await refused("get_tooltip", { item: "minecraft:stone" }), /in a world.*open_world|create_world/);
  });
});

describe("get_tooltip: what a stack says", { skip: !inWorld }, () => {
  test("a named, enchanted stack from item syntax", async () => {
    const r = await call("get_tooltip", {
      item: 'minecraft:diamond_sword[custom_name="Probe Blade",enchantments={"minecraft:sharpness":3}]',
    });
    assert.equal(r.item, "minecraft:diamond_sword");
    assert.equal(r.count, 1);
    assert.ok(Array.isArray(r.lines) && r.lines.length >= 2, JSON.stringify(r));
    assert.equal(r.lines[0], "Probe Blade", "the name is the first line");
    assert.ok(r.lines.some((l) => /Sharpness III/.test(l)), `an enchantment line: ${JSON.stringify(r.lines)}`);
  });

  test("advanced adds the id line; count rides the stack", async () => {
    const r = await call("get_tooltip", { item: "minecraft:stone", count: 16, advanced: true });
    assert.equal(r.count, 16);
    assert.ok(r.lines.some((l) => l === "minecraft:stone"), `F3+H id line: ${JSON.stringify(r.lines)}`);
    const plain = await call("get_tooltip", { item: "minecraft:stone" });
    assert.ok(!plain.lines.some((l) => l === "minecraft:stone"), "no id line without advanced");
  });

  test("a bad id is refused by name; neither and both arguments are refused", async () => {
    assert.match(await refused("get_tooltip", { item: "minecraft:no_such_item_k2" }), /no_such_item_k2/);
    assert.match(await refused("get_tooltip", {}), /exactly one/);
    assert.match(await refused("get_tooltip", { item: "minecraft:stone", slot: 0 }), /exactly one/);
  });

  describe("slot: a container screen's own stacks", { skip: !inWorld }, () => {
    after(async () => { await raw("close_screen"); });

    test("a placeholder slot's tooltip names its item; an empty slot says so", async () => {
      await call("open_screen", { ui: "mcptoolkit:example" });
      let screen = null;
      for (let i = 0; i < 40 && !screen?.menu; i++) {
        await new Promise((r) => setTimeout(r, 100));
        screen = (await raw("get_screen")).result;
      }
      assert.ok(screen?.menu?.slots, `a container screen with slots: ${JSON.stringify(screen).slice(0, 200)}`);
      const filled = screen.menu.slots.find((s) => s.item && s.item !== "minecraft:air");
      assert.ok(filled, `a non-empty slot among ${JSON.stringify(screen.menu.slots).slice(0, 200)}`);
      const r = await call("get_tooltip", { slot: filled.index });
      assert.equal(r.slot, filled.index);
      assert.equal(r.item, filled.item, "the tooltip is of the stack in that slot");
      assert.ok(r.lines.length >= 1, JSON.stringify(r));
      // An index the report skipped (empty rows are not listed) answers empty, not an error.
      const listed = new Set(screen.menu.slots.map((s) => s.index));
      let empty = 0;
      while (listed.has(empty)) empty++;
      const e = await call("get_tooltip", { slot: empty });
      assert.equal(e.empty, true);
      assert.deepEqual(e.lines, []);
      assert.match(await refused("get_tooltip", { slot: 9999 }), /out of range/);
    });
  });
});
