// Screen authoring, slice 7 (mcp-toolkit/SCREEN_AUTHORING_DESIGN.md section 23): THE AUTHORING
// WORLD, and the two doors into it.
//
// The problem this slice attacks is that a screen preview needs a world (vanilla's requirement -
// AbstractContainerScreen is built over an Inventory, an Inventory over a Player), and the only
// world the dev client had was the accumulated survival save: 13 seconds and 835 MB per cold cycle,
// a backdrop that changes with the time of day, and somebody else's probe sites forceloaded in it.
//
// What section 23 promised, each as a case that can go red:
//   * `ui_doc op:"open"` in a world opens the document THERE and says which world that was -
//     this door never disconnects an open world, which is the whole reason it is not `open_world`;
//   * it refuses a document that cannot be read, by name;
//   * the authoring world IS what it claims: flat void with one layer of stone, peaceful, and every
//     rule that could make two screenshots of one screen differ turned off;
//   * the clock is FROZEN - two readings a second apart are the same number, which is the property
//     the game rule exists for and the only one a still image cannot show;
//   * THE LAUNCHER'S PROMISE: the latch was armed with this document and opened it. Nobody in this
//     file opened it - `launch_game {ui:...}` did, through -Ui -> -PuiDoc -> -Dmcptoolkit.ui.open
//     and UiWorldClient's boot latch. Read off `get_screen`'s `ui_boot` rather than off the open
//     screen, and THAT IS THE WHOLE POINT: this case used to assert that an InterpretedScreen was
//     still up on arrival, which is the most PERISHABLE evidence in the game - anything that opens
//     another screen erases it. So it could only pass as the first thing run against a fresh
//     client, and it went red the first time these ui files were run as a set, six probe files
//     after the latch fired, against a game that had done nothing wrong. `ui_boot` is that same
//     evidence made durable: what the latch was armed with, what became of it, AND what was
//     actually on screen the moment its open returned - read back off the client there, so
//     "the document opened" is never satisfied by a call merely not throwing.
//
// WHAT THIS FILE CANNOT DO, said out loud: it cannot test the ENTERING half. There is no tool that
// leaves a world to the title screen, so the title-screen branch of both doors is exercised by
// RUNNING one - which is how this probe gets into the authoring world in the first place. The cases
// below assert the state the door promised rather than the act, and the act is the launch:
//
//     launch_game {target:"client", ui:"mcptoolkit:example"}      (or tools/rebuild.ps1 -Ui ...)
//     MCPTK_URL=http://127.0.0.1:<port> node --test mcp-server/probes/ui-world.test.mjs
//
// The first group runs in ANY world (it is about the door, not about where it leads). The second is
// skipped outside the authoring world, and inside it is strict: if you are here, you came through
// the door, so the door's promises hold.
//
// Live probe: skips itself when the bridge is down, headless, or worldless.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-ui-world";
const DOC = "mcptoolkit:example";
const LEVEL_NAME = "MCP UI authoring";

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
/**
 * One command, its feedback lines joined.
 *
 * <p>THE THROW IS THE POINT. `run_command` answers ok:true on a command that never parsed, and the
 * first version of the clock case below compared two identical BRIGADIER ERROR STRINGS and called
 * the clock frozen - a case that could not fail, found by its own falsifier ("time query daytime"
 * does not exist in 26.2; the clock is a timeline and the query is `time query time`). Any output
 * carrying brigadier's parse marker or a "can't find" is a failed call, never a reading.
 */
async function command(cmd) {
  const r = await call("run_command", { command: cmd });
  const out = (r.output ?? []).join(" | ");
  if (/<--\[HERE\]|Can't find|Unknown or incomplete command/i.test(out)) {
    throw new Error(`\`${cmd}\` did not run: ${out}`);
  }
  return out;
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
let clientPresent = false;
let world = null;
// Read BEFORE any case runs. `ui_boot` is durable and would survive this file's own first group,
// but reading it here keeps the observation an ARRIVAL observation - nothing below can be reading
// its own work - and it is the only place the two are known to describe one client.
let screenOnArrival = null;
let bootOnArrival = null;
if (bridgeUp) {
  clientPresent = (await raw("ping", {})).result?.clientPresent === true;
  if (clientPresent) {
    const info = await raw("get_world_info", {});
    world = info.ok ? info.result : null;
    if (world) {
      screenOnArrival = (await raw("get_screen", {})).result ?? null;
      // The same reply's durable half. Read here rather than in the case, so that the two halves
      // are one observation of one client and cannot disagree about which arrival they describe.
      bootOnArrival = screenOnArrival?.ui_boot ?? null;
    }
  }
}
const live = bridgeUp && clientPresent && world !== null;
const authoring = live && world.name === LEVEL_NAME;

if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} - start the dev game to run these probes\n`);
} else if (!clientPresent) {
  console.log("\n  [skip] bridge is up but headless - the authoring world is a CLIENT's world\n");
} else if (!live) {
  console.log("\n  [skip] the client is not in a world\n");
} else if (!authoring) {
  console.log(`\n  [skip] the authoring-world cases: this client is in "${world.name}", not "${LEVEL_NAME}".`
    + `\n         Run launch_game {target:"client", ui:"${DOC}"} and point MCPTK_URL at that game.\n`);
}

describe("slice 7: ui_doc op:\"open\" from inside a world", { skip: !live }, () => {
  let opened;

  before(async () => {
    opened = await call("ui_doc", { op: "open", ui: DOC });
  });
  after(async () => {
    await raw("close_screen", {});
  });

  test("the document opens where the client already is", () => {
    assert.equal(opened.opened, "InterpretedScreen");
    assert.equal(opened.document, DOC);
    assert.equal(opened.entered, false, "no world was entered - one was already open");
    assert.equal(opened.world, world.name, "the reply names the world it used");
  });

  test("it did not move the client to another world", async () => {
    const now = await call("get_world_info", {});
    assert.equal(now.name, world.name);
    assert.equal(now.world_uuid, world.world_uuid, "same save, before and after");
  });

  test("a document that cannot be read is refused by name, not by a world load", async () => {
    const err = await refused("ui_doc", { op: "open", ui: "mcptoolkit:no-such-screen" });
    assert.match(err, /no-such-screen/, "the refusal names the document");
  });

  test("open is a listed op, and an unknown one still says what the ops are", async () => {
    const err = await refused("ui_doc", { op: "opne", ui: DOC });
    assert.match(err, /\bopen\b/, "the op list in the refusal includes open");
  });
});

describe("slice 7: the authoring world is what it claims", { skip: !authoring }, () => {
  test("THE LAUNCHER'S PROMISE: the boot latch was armed with the document, and opened it", () => {
    assert.ok(bootOnArrival,
      "get_screen reported no ui_boot: this client was started without -Dmcptoolkit.ui.open, so it"
      + " reached the authoring world by some other route than the launcher's promise."
      + ` Relaunch with launch_game {target:"client", ui:"${DOC}"} to assert it.`);
    assert.equal(bootOnArrival.requested, DOC, "the latch was armed with a different document");
    assert.equal(bootOnArrival.edit, false, "a read-only preview was asked for, not the editor");
    assert.equal(bootOnArrival.outcome, "opened",
      `the latch did not open it: ${bootOnArrival.outcome}${bootOnArrival.why ? ` - ${bootOnArrival.why}` : ""}`);
  });

  test("...and what it opened was ON SCREEN: the interpreted document, detached", () => {
    assert.equal(bootOnArrival?.screen, "InterpretedScreen",
      "the latch's open returned, but the screen it left up was"
      + ` ${bootOnArrival?.screen ?? "nothing"} - which is ui_boot's own record catching the`
      + " difference between opening a document and a call not throwing.");
    assert.equal(bootOnArrival.document, DOC);
    assert.equal(bootOnArrival.detached, true);
  });

  test("void with one layer of stone: nothing to prepare, nothing to load", async () => {
    const r = await call("get_blocks_at", {
      blocks: [
        { x: 0, y: 0, z: 0, expect: "minecraft:smooth_stone" },
        { x: 0, y: 1, z: 0, expect: "minecraft:air" },
        { x: 0, y: -1, z: 0, expect: "minecraft:air" },
      ],
    });
    assert.equal(r.check?.all_matched, true, JSON.stringify(r));
  });

  test("the backdrop cannot change: no daylight cycle, no weather", async () => {
    assert.match(await command("gamerule advance_time"), /false/);
    assert.match(await command("gamerule advance_weather"), /false/);
  });

  test("nothing walks into the shot: every spawn rule is off, and it is peaceful", async () => {
    for (const rule of ["spawn_mobs", "spawn_monsters", "spawn_patrols", "spawn_phantoms",
      "spawn_wandering_traders", "spawn_wardens"]) {
      assert.match(await command(`gamerule ${rule}`), /false/, rule);
    }
    assert.match(await command("difficulty"), /[Pp]eaceful/);
  });

  test("a player left standing here for an hour is safe", async () => {
    assert.match(await command("gamerule fall_damage"), /false/);
    assert.match(await command("gamerule keep_inventory"), /true/);
  });

  test("the clock is frozen, not merely set", async () => {
    // No screen is open here (the group above closed its preview) and a container screen does not
    // pause the game anyway - AbstractContainerScreen.isPauseScreen() is false in 26.2 - so a
    // standing clock is the game rule's doing and nothing else's.
    const first = await command("time query time");
    assert.match(first, /\d+ tick/, "a reading, not a refusal");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await command("time query time"), first, "30 ticks should have passed and did not");
  });
});
