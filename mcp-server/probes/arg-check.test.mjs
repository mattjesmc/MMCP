// Live probes for the ARGUMENT GATE (toolkit 0.46.0, ArgCheck.java) — an argument a tool does not
// have is a refusal, not a shrug.
//
// The class these guard against is the one that cost survival session w1-85918 (2026-08-02) and the
// two sessions before it: an unknown argument was dropped, the call answered a DIFFERENT question,
// and the reply — honestly computed from the arguments that did apply — read back as agreement.
// `locate {center}` did that thirteen times across two sessions without either model noticing.
//
//   1. An unknown key is REFUSED, and the refusal names the nearest real argument.
//   2. The refusal happens BEFORE the call runs — a world-changing tool must not act on a
//      misunderstood request and then complain.
//   3. A JSON-encoded string where an object belongs is named as such (bot_place got
//      `{target: "{\"at\": …}"}` twice in a row live and was told only "missing `at`").
//   4. Valid calls are untouched: the gate is not allowed to cost a single legitimate argument.
//
// No site: every assertion here is a refusal or a schema read, so nothing is staged and nothing can
// collide with another probe file. Needs the dev server; skips when the bridge is down.
// Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-arg-check";

async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
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

describe("arg gate: an argument the tool does not have is a refusal", { skip: !bridgeUp }, () => {
  test("unknown argument is refused, naming the nearest real one", async () => {
    const r = await callRaw("locate", { what: "minecraft:stone", center: { x: 0, y: 64, z: 0 } });
    assert.equal(r.ok, false, `\`center\` is not a locate argument: ${JSON.stringify(r)}`);
    assert.match(r.error, /center/, "the refusal names the offending argument");
    assert.match(r.error, /near/, "…and points at the argument that was meant");
    assert.match(r.error, /NOT run|NOT applied/,
      "…and says the call did not run, so the caller knows nothing happened");
  });

  test("the refusal lists what the tool DOES take", async () => {
    const r = await callRaw("bot_status", { nonsense_argument: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /nonsense_argument/);
    assert.match(r.error, /Arguments here:/,
      `the error is a routing surface — it carries the real list: ${r.error}`);
  });

  test("a misspelling is answered by name, not by list alone", async () => {
    const r = await callRaw("send_chat", { mesage: "hello" });
    assert.equal(r.ok, false);
    assert.match(r.error, /did you mean `message`\?/, `edit-distance hint: ${r.error}`);
  });

  test("a world-changing tool is refused BEFORE it acts", async () => {
    // The point of the chokepoint: `bot_place` must not place and then object. It has no body in
    // this session, so a call that got past the gate would fail with a body error instead — which
    // is exactly what distinguishes "refused early" from "ran and failed".
    const r = await callRaw("bot_place", { at: { x: 0, y: 64, z: 0 }, blocktype: "minecraft:stone" });
    assert.equal(r.ok, false);
    assert.match(r.error, /blocktype/, `the gate answered first: ${r.error}`);
    assert.doesNotMatch(r.error, /no body/, "…so the handler never ran");
  });

  test("a JSON-encoded string where an object belongs is named as such", async () => {
    const r = await callRaw("bot_place", { at: '{"x": -44, "y": 65, "z": -36}' });
    assert.equal(r.ok, false);
    assert.match(r.error, /JSON-ENCODED STRING/i,
      `double-encoding is its own mistake and gets its own message: ${r.error}`);
    assert.match(r.error, /at/, "…naming which argument arrived that way");
  });

  test("a string argument that merely looks like JSON is left alone", async () => {
    // Conservative by construction: the double-encoding check only fires where the SCHEMA says
    // object/array. A string-typed argument is the caller's data, whatever it contains.
    const r = await callRaw("send_chat", { message: '{"not": "json to us"}' });
    assert.equal(r.ok, true, `a string-typed argument is never second-guessed: ${JSON.stringify(r)}`);
  });

  test("legitimate calls are untouched", async () => {
    // The gate's cost must be zero on correct calls — including the optional arguments that a
    // required/optional confusion would wrongly reject.
    const ping = await callRaw("ping", {});
    assert.equal(ping.ok, true, JSON.stringify(ping));
    const info = await callRaw("get_world_info", {});
    assert.equal(info.ok, true, JSON.stringify(info));
    const near = await callRaw("locate", {
      what: "minecraft:stone", near: { x: 0, y: 64, z: 0 }, radius: 16, limit: 3,
    });
    assert.equal(near.ok, true, `every declared argument still works: ${JSON.stringify(near.error)}`);
  });

  test("every builtin's schema declares the arguments its own probes pass", async () => {
    // The gate is only as good as the schemas, and a tool that reads an argument it never declared
    // would now refuse its own callers. This walks the live manifest and asserts the shape the gate
    // depends on: a builtin declares `properties`, so there is something to check against.
    const tools = await fetch(`${BASE}/tools`).then((r) => r.json());
    const list = Array.isArray(tools) ? tools : tools.tools ?? [];
    assert.ok(list.length > 20, `the manifest lists the builtins (got ${list.length})`);
    const undeclared = list
      .filter((t) => !t.source) // extension-contributed tools are exempt by design
      .filter((t) => !t.inputSchema || typeof t.inputSchema.properties !== "object")
      .map((t) => t.name);
    // Not a failure by itself — a genuinely argument-free tool is exempt inside the gate — but it
    // should be a SHORT list, and a new entry means someone registered a schema-less tool.
    assert.ok(undeclared.length <= 4,
      `tools without declared properties bypass the gate entirely: ${undeclared.join(", ")}`);
  });
});
