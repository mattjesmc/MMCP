// The consumer's fast tier, written against a guarantee (RELEASE_1.md section K1): the manifest's
// `context` column and `ping.build`, live.
//
// ArmorPieces' tier 2 drives a DEDICATED SERVER and needed to be *written* against which tools
// answer there rather than discovered by trying. Three claims, each its own test:
//   * Every manifest entry carries `context` in {server, any, client} - the registry's own column.
//   * Headless, no entry is client-context: a dedicated server never registers those tools, so they
//     are absent, and calling one by name is an unknown tool rather than a refusal. On a client the
//     same test asserts the opposite (client-context entries exist), so the file is not a no-op
//     wherever it runs.
//   * docs/platform/HEADLESS.md, generated from a client capture, agrees with the live manifest:
//     every toolkit-owned tool here is in the table with the same context. A tool added without
//     regenerating the table fails HERE rather than drifting.
// And the fourth is the build: `ping.build` names this JVM's start, hashes every loaded mod, and
// lists the buildable ones with origins and mtimes - the toolkit itself among them, at the version
// build.gradle says, which is the check a suite makes before trusting an instance.
//
// Stages nothing, claims no site. Skips when the bridge is down. Run with `npm run test:live` or
// `tools/battery.ps1`; meaningful on a dev server AND on a client.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-headless-surface";
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLKIT = join(HERE, "..", "..", "mcp-toolkit");

async function raw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

const manifest = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (!manifest) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev game to run these probes\n`);
}

describe("headless surface: the context column and ping.build", { skip: !manifest }, () => {
  test("every manifest entry carries a context the dispatcher knows", () => {
    const bad = manifest.filter((t) => !["server", "any", "client"].includes(t.context));
    assert.deepEqual(bad.map((t) => `${t.name}:${t.context}`), [], "entries without a known context");
    assert.ok(manifest.some((t) => t.context === "server"), "server-context tools exist");
    assert.ok(manifest.some((t) => t.context === "any"), "any-context tools exist (ping at least)");
    assert.equal(manifest.find((t) => t.name === "ping")?.context, "any");
  });

  test("client-context entries are present exactly when a client is", async () => {
    const info = await raw("ping");
    assert.ok(info.ok, JSON.stringify(info));
    const clientTools = manifest.filter((t) => t.context === "client").map((t) => t.name);
    if (info.result.clientPresent) {
      assert.ok(clientTools.includes("get_screen"), `a client is attached: ${clientTools.length} client tools`);
    } else {
      assert.deepEqual(clientTools, [], "headless: no client-context entry may be served");
      // Absent, not refusing: the name is unknown to this bridge.
      const r = await raw("get_screen");
      assert.equal(r.ok, false, "get_screen must not answer headless");
    }
  });

  test("docs/platform/HEADLESS.md agrees with the live manifest", async () => {
    const { parseTable } = await import(`file://${join(TOOLKIT, "tools", "headless-doc.mjs").replace(/\\/g, "/")}`);
    const table = parseTable(readFileSync(join(TOOLKIT, "docs", "platform", "HEADLESS.md"), "utf8"));
    assert.ok(table.size > 50, `the table is populated (${table.size} rows)`);
    const drift = [];
    for (const t of manifest.filter((t) => !t.source)) {
      const doc = table.get(t.name);
      if (doc !== t.context) drift.push(`${t.name}: manifest ${t.context}, table ${doc ?? "absent"}`);
    }
    assert.deepEqual(drift, [], "regenerate with `node tools/headless-doc.mjs` from a client");
  });

  test("ping.build names this build", async () => {
    const info = await raw("ping");
    assert.ok(info.ok, JSON.stringify(info));
    const b = info.result.build;
    assert.ok(b && typeof b === "object", "ping.build present");
    assert.ok(!Number.isNaN(Date.parse(b.started_at)), `started_at parses: ${b.started_at}`);
    assert.ok(Date.parse(b.started_at) <= Date.now(), "the JVM started in the past");
    assert.match(b.mods_hash, /^[0-9a-f]{12}$/);
    assert.equal(typeof b.stale, "boolean");
    assert.ok(Array.isArray(b.mods) && b.mods.length > 0, "at least one buildable mod (the toolkit)");
    const toolkit = b.mods.find((m) => m.id === "mcptoolkit");
    assert.ok(toolkit, `mcptoolkit listed among ${b.mods.map((m) => m.id).join(", ")}`);
    const declared = /version\s*=\s*'([^']+)'/.exec(readFileSync(join(TOOLKIT, "build.gradle"), "utf8"))?.[1];
    assert.equal(toolkit.version, declared, "the loader's version for the toolkit is build.gradle's");
    for (const m of b.mods) {
      assert.ok(m.origins.length > 0, `${m.id} has an origin`);
      for (const o of m.origins) {
        assert.equal(typeof o.path, "string");
        assert.ok(!Number.isNaN(Date.parse(o.mtime)), `${m.id} origin mtime parses: ${o.mtime}`);
      }
    }
    // Not asserted, reported: a compile after launch makes this true and that is the tool working.
    if (b.stale) console.log(`  [note] ping.build.stale=true - an origin is newer than the JVM`);
  });
});
