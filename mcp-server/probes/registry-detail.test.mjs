// Live probes for registry-entry detail (RELEASE_1.md §D2) — `query_registry` stops being a list of ids.
//
// The gap was narrow to state and wide to feel. `query_registry` could tell you that
// `minecraft:oak_stairs` is registered and nothing else: not what blockstate properties it has, not
// what tags it is in, not what is inside `#c:ores`, not what components an item carries, and — the
// one that actually costs a modder an afternoon — not whether the recipe they just pushed LOADED.
// `TagKey` appeared in this repo only as a search filter in LocateTools, and `RecipeManager` was
// untouched by any read tool at all.
//
// All of it rides INSIDE `query_registry` (finding 6: an entry is re-read every turn by every
// session, so a new manifest line is a per-turn tax). Three arguments and one pseudo-registry:
// `entry` reports on one id, `tag` filters a listing to a tag's members, `tags:true` lists the tag
// ids instead of the entries, and `registry:"recipe"` reaches the RecipeManager.
//
// TWO ASSERTIONS CARRY THE FILE, and both are pairs, because half of each is trivially satisfiable
// by a tool that answers nothing:
//
//   * `tag_exists` — a tag that FAILED TO LOAD and a tag that is EMPTY have the same member list.
//     So the probe asks for a tag that cannot exist and requires `tag_exists:false` beside the
//     empty array. Without that flag an empty `ids` reads as "your tag loaded and matched nothing",
//     which is the succeeds-falsely class with a typo as its vector.
//   * `exists` on a recipe — the probe pushes a GOOD recipe and a BROKEN one through the same
//     reload and requires exists:true / exists:false respectively. A reporter that always says
//     `exists:false` is as useless as one that always says true, and the broken half is the actual
//     question §D1 left half-answered: `reload_data` now NAMES the file that failed, and this says
//     what the game ended up holding.
//
// This file stages NOTHING in the world — it writes two recipe files into the live datapack and
// clears them by path. It therefore claims no probe site. It DOES perform server-wide datapack
// reloads, which the site map cannot see; see log-channel.test.mjs's header for that discipline.
// Its datapack paths are deliberately distinct from that file's so a concurrent `npm run test:live`
// cannot have them clear each other's.
//
// NOT COVERED, said plainly: the `*_omitted` branch for a codec dump over 20,000 characters. No
// vanilla entry in a default world reliably encodes that large, and inventing one would test the
// comparison rather than the case. The arithmetic is one length check; the risk it carries is that
// a truncated JSON would read as data and parse as nothing, which is why it reports a SIZE instead.
//
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-registry-detail";

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
  assert.equal(j.ok, false, `expected a refusal, got ${JSON.stringify(j.result)}`);
  return JSON.stringify(j.error);
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const GOOD_PATH = "data/minecraft/recipe/mcptk_regprobe_good.json";
const BROKEN_PATH = "data/minecraft/recipe/mcptk_regprobe_broken.json";
const GOOD_ID = "minecraft:mcptk_regprobe_good";
const BROKEN_ID = "minecraft:mcptk_regprobe_broken";
const PUSHED = [GOOD_PATH, BROKEN_PATH];

const GOOD_RECIPE = JSON.stringify({
  type: "minecraft:crafting_shapeless",
  category: "misc",
  ingredients: ["minecraft:stick"],
  result: { id: "minecraft:oak_button", count: 3 },
});
// Valid JSON, invalid RECIPE — no `result`. Vanilla logs it and steps over it, which is why
// "did it load" has to be asked of the game rather than of the file.
const BROKEN_RECIPE = JSON.stringify({
  type: "minecraft:crafting_shapeless",
  ingredients: ["minecraft:stick"],
});

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("query_registry: one entry, its tags, and what the game made of it",
  { skip: !bridgeUp }, () => {
  before(async () => {
    if (!bridgeUp) return;
    // The bridge binds at MOD INIT, before the world exists — `/tools` answering is not the same
    // question as "can this file run". Every test here goes through `serverOrThrow`.
    for (let i = 0; i < 60; i++) {
      const j = await raw("query_registry", {});
      if (j.ok) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("bridge is up but no world loaded after 60s — start the dev server fully");
  });

  after(async () => {
    if (!bridgeUp) return;
    // Clear BY PATH, never wholesale: this pack is shared with whatever else the session pushed.
    for (const p of PUSHED) {
      await raw("clear_data", { path: p, reload: false });
    }
    await raw("reload_data", {});
  });

  // ---------------------------------------------------------------- the listing still works

  test("the listing this tool already was is unchanged", async () => {
    const r = await call("query_registry", { registry: "block", contains: "stairs", limit: 500 });
    assert.equal(r.registry, "minecraft:block");
    assert.ok(r.ids.includes("minecraft:oak_stairs"), "oak_stairs must be in the block registry");
    assert.equal(r.returned, r.ids.length);
    assert.equal(r.truncated, r.returned < r.total);
  });

  test("an unknown REGISTRY still throws — that is a typo in the question", async () => {
    const err = await refused("query_registry", { registry: "blockk" });
    assert.match(err, /no such registry/, err);
  });

  // ---------------------------------------------------------------- entry: blocks

  test("a block entry carries its properties and a default state in set_blocks syntax", async () => {
    const r = await call("query_registry", { registry: "block", entry: "minecraft:oak_stairs" });
    assert.equal(r.exists, true);
    assert.equal(r.id, "minecraft:oak_stairs");
    assert.ok(r.properties, `no properties: ${JSON.stringify(r)}`);
    assert.deepEqual([...r.properties.facing].sort(), ["east", "north", "south", "west"]);
    assert.deepEqual([...r.properties.half].sort(), ["bottom", "top"]);
    // The point of the syntax: what comes back is what set_blocks takes.
    assert.match(r.default_state, /^minecraft:oak_stairs\[.*facing=north.*\]$/, r.default_state);
    assert.equal(r.item, "minecraft:oak_stairs", "a block's item form is the id you actually give");
    assert.ok(r.tags.includes("minecraft:stairs"), `tags: ${JSON.stringify(r.tags)}`);
    assert.ok(r.tags.includes("minecraft:mineable/axe"), `tags: ${JSON.stringify(r.tags)}`);
  });

  test("a block with no properties says so with an empty map, not a missing field", async () => {
    const r = await call("query_registry", { registry: "block", entry: "minecraft:stone" });
    assert.deepEqual(r.properties, {}, "stone has no blockstate properties");
    assert.equal(r.default_state, "minecraft:stone", "no properties means no bracket");
  });

  test("a bare id gets the vanilla namespace, the way `registry` already does", async () => {
    const r = await call("query_registry", { registry: "block", entry: "stone" });
    assert.equal(r.id, "minecraft:stone");
    assert.equal(r.exists, true);
  });

  // ---------------------------------------------------------------- entry: items and entities

  test("an item entry carries its stack size and its DEFAULT COMPONENTS", async () => {
    const r = await call("query_registry", { registry: "item", entry: "minecraft:diamond_sword" });
    assert.equal(r.exists, true);
    assert.equal(r.max_stack_size, 1);
    assert.ok(r.components, `no components: ${JSON.stringify(r)}`);
    // Components are the modern answer to "what does this item DO" and were unreadable before.
    assert.ok("minecraft:max_damage" in r.components,
      `expected a max_damage component: ${JSON.stringify(Object.keys(r.components))}`);
    assert.ok(r.tags.includes("minecraft:swords"), `tags: ${JSON.stringify(r.tags)}`);
  });

  test("a block item names the block it places", async () => {
    const r = await call("query_registry", { registry: "item", entry: "minecraft:oak_stairs" });
    assert.equal(r.block, "minecraft:oak_stairs");
  });

  test("an entity type carries the size and category a spawn rule needs", async () => {
    const r = await call("query_registry", { registry: "entity_type", entry: "minecraft:creeper" });
    assert.equal(r.exists, true);
    assert.equal(r.category, "monster");
    assert.equal(r.summonable, true);
    assert.ok(r.width > 0 && r.height > 0, `${r.width}x${r.height}`);
  });

  test("an UNREGISTERED entry answers exists:false — it does not throw", async () => {
    // "Is my thing registered" is the question, not a malformed call. A throw here would make the
    // most common use of the argument look like a broken tool.
    const r = await call("query_registry", { registry: "block", entry: "mcptk:no_such_block" });
    assert.equal(r.exists, false);
    assert.equal(r.id, "mcptk:no_such_block");
    assert.equal(r.tags, undefined, "there are no tags on a thing that does not exist");
  });

  // ---------------------------------------------------------------- entry: the game's own codec

  test("a datapack entry comes back as the game DECODED it, not as the file said", async () => {
    const r = await call("query_registry", { registry: "worldgen/biome", entry: "minecraft:plains" });
    assert.equal(r.exists, true);
    assert.ok(r.json, `no json: ${JSON.stringify(r).slice(0, 400)}`);
    // Rendered by RegistryDataLoader's own element codec — the one that loaded the file — so there
    // is no second reading of a biome in this repo to drift from the one the game used.
    assert.equal(typeof r.json.temperature, "number");
    assert.equal(typeof r.json.has_precipitation, "boolean");
    assert.ok(r.json.effects, "a biome's effects block is the half a worldgen modder edits");
  });

  test("a registry with neither a typed view nor a codec still answers something", async () => {
    const r = await call("query_registry", { registry: "mob_effect", entry: "minecraft:speed" });
    assert.equal(r.exists, true);
    assert.ok(Array.isArray(r.tags));
    assert.match(r.class, /MobEffect/, `expected the implementing class, got ${r.class}`);
  });

  // ---------------------------------------------------------------- tags

  test("`tag` lists what is IN a tag — the #c:ores question", async () => {
    const r = await call("query_registry", { registry: "item", tag: "minecraft:planks", limit: 500 });
    assert.equal(r.tag_exists, true);
    assert.equal(r.tag, "minecraft:planks");
    assert.ok(r.ids.includes("minecraft:oak_planks"), `ids: ${JSON.stringify(r.ids)}`);
    assert.equal(r.total, r.ids.length, "the planks tag is smaller than the limit");
  });

  test("a leading # is accepted, because that is how a tag is written everywhere else", async () => {
    const hashed = await call("query_registry", { registry: "item", tag: "#minecraft:planks", limit: 500 });
    const bare = await call("query_registry", { registry: "item", tag: "minecraft:planks", limit: 500 });
    assert.deepEqual(hashed.ids, bare.ids);
  });

  test("a tag that does NOT exist says so — an empty list alone would be a lie", async () => {
    // The pair that makes the previous test mean anything. Registry.get(TagKey) is empty both for a
    // tag that loaded and matched nothing AND for a tag whose file never loaded; only the flag
    // separates them, and it is the second case a modder is nearly always in.
    const r = await call("query_registry", { registry: "item", tag: "mcptk:no_such_tag_at_all" });
    assert.equal(r.tag_exists, false);
    assert.equal(r.total, 0);
    assert.deepEqual(r.ids, []);
  });

  test("`tag` composes with the filters it sits beside", async () => {
    const r = await call("query_registry",
      { registry: "item", tag: "minecraft:planks", contains: "oak", limit: 500 });
    assert.equal(r.tag_exists, true);
    assert.ok(r.ids.length > 0);
    assert.ok(r.ids.every((i) => i.includes("oak")), `ids: ${JSON.stringify(r.ids)}`);
  });

  test("`tags:true` lists the tag ids themselves, under their own key", async () => {
    const r = await call("query_registry", { registry: "block", tags: true, contains: "mineable", limit: 500 });
    assert.ok(Array.isArray(r.tags), `expected a tags array: ${JSON.stringify(r).slice(0, 300)}`);
    assert.equal(r.ids, undefined, "tag ids are not entry ids and must not share the key");
    assert.ok(r.tags.includes("minecraft:mineable/pickaxe"), `tags: ${JSON.stringify(r.tags)}`);
    assert.ok(r.tags.every((t) => t.includes("mineable")), "the filters apply to a tag listing too");
  });

  // ---------------------------------------------------------------- recipes: did it load

  test("`registry:\"recipe\"` reaches the RecipeManager, which is not in registryAccess", async () => {
    const r = await call("query_registry", { registry: "recipe", contains: "oak_planks", limit: 50 });
    assert.ok(r.total > 0, "a vanilla world has oak plank recipes");
    assert.ok(r.ids.some((i) => i.startsWith("minecraft:")), `ids: ${JSON.stringify(r.ids)}`);
  });

  test("a recipe entry carries its type and the recipe the game is HOLDING", async () => {
    const listing = await call("query_registry", { registry: "recipe", contains: "oak_planks", limit: 5 });
    const id = listing.ids[0];
    const r = await call("query_registry", { registry: "recipe", entry: id });
    assert.equal(r.exists, true);
    assert.ok(r.json, `no json: ${JSON.stringify(r).slice(0, 400)}`);
    // FOUND HERE, on this file's first live run, and it is the sort of thing that costs an hour.
    // The `type:` field of a recipe FILE is the SERIALIZER (`Recipe.CODEC` dispatches on
    // RECIPE_SERIALIZER), while `Recipe.getType()` is the RECIPE_TYPE — which station crafts it.
    // For a shapeless crafting recipe those are `minecraft:crafting_shapeless` and
    // `minecraft:crafting`. The first draft called the second one `type` and would have handed the
    // caller back a word their own file uses for the other thing.
    assert.equal(r.recipe_type, "minecraft:crafting",
      `recipe_type is the STATION, not the serializer: ${r.recipe_type}`);
    assert.match(r.json.type, /^minecraft:crafting_/,
      `json.type is the serializer, as written in the file: ${r.json.type}`);
    assert.notEqual(r.recipe_type, r.json.type, "these are two registries and must not be conflated");
  });

  test("A PUSHED RECIPE THAT LOADED IS FOUND, and one that did not is not — the pair", async () => {
    // §D1 made `reload_data` name the file that failed. This is the other half: what the game
    // ended up holding. Both files go through the SAME reload, so a reporter that always answers
    // one way fails here.
    const push = await call("push_data", { path: GOOD_PATH, base64: b64(GOOD_RECIPE), reload: false });
    assert.equal(push.written, GOOD_PATH, `push_data reported ${JSON.stringify(push)}`);
    await call("push_data", { path: BROKEN_PATH, base64: b64(BROKEN_RECIPE) });

    const good = await call("query_registry", { registry: "recipe", entry: GOOD_ID });
    assert.equal(good.exists, true, "a well-formed pushed recipe must be in the RecipeManager");
    assert.equal(good.json.result.id, "minecraft:oak_button");
    assert.equal(good.json.result.count, 3, "the count round-trips through the game's own codec");

    const broken = await call("query_registry", { registry: "recipe", entry: BROKEN_ID });
    assert.equal(broken.exists, false,
      "a recipe that failed its codec is NOT loaded, however cheerfully the reload completed");
  });

  test("a cleared recipe stops existing — the promotion/cleanup half", async () => {
    await call("clear_data", { path: GOOD_PATH });
    const r = await call("query_registry", { registry: "recipe", entry: GOOD_ID });
    assert.equal(r.exists, false, "clear_data + reload must actually unload it");
  });

  // ---------------------------------------------------------------- structure templates

  test("a structure template entry reports its size", async () => {
    const listing = await call("query_registry",
      { registry: "structure_template", contains: "village/plains", limit: 5 });
    if (listing.total === 0) return; // a world with no vanilla templates loaded is not a defect here
    const r = await call("query_registry", { registry: "structure_template", entry: listing.ids[0] });
    assert.equal(r.exists, true);
    assert.ok(r.size && r.size.x > 0 && r.size.z > 0, `size: ${JSON.stringify(r.size)}`);
  });

  test("a template that is not there answers exists:false", async () => {
    const r = await call("query_registry",
      { registry: "structure_template", entry: "mcptk:no/such/template" });
    assert.equal(r.exists, false);
  });

  // ---------------------------------------------------------------- arguments that cannot apply

  test("a filter alongside `entry` is REFUSED, not dropped", async () => {
    // Silently ignoring it would answer a different question than the one asked and read back as
    // agreement — the same class ArgCheck exists for, one level down.
    const err = await refused("query_registry",
      { registry: "block", entry: "minecraft:stone", contains: "stair" });
    assert.match(err, /does not apply with `entry`/, err);
  });

  test("`tag` alongside `tags:true` is refused — they are opposite questions", async () => {
    const err = await refused("query_registry",
      { registry: "block", tags: true, tag: "minecraft:planks" });
    assert.match(err, /does not apply with `tags:true`/, err);
  });

  test("a tag argument on a pseudo-registry is refused by name", async () => {
    const err = await refused("query_registry", { registry: "recipe", tag: "minecraft:planks" });
    assert.match(err, /not a tagged registry/, err);
  });

  test("the registry listing names both pseudo-registries", async () => {
    const r = await call("query_registry", {});
    assert.ok(r.registries.includes("structure_template"));
    assert.ok(r.registries.includes("recipe"),
      "a pseudo-registry nothing lists is a pseudo-registry nobody finds");
  });
});
