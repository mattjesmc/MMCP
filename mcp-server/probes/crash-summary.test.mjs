// Live probes for the crash fold (RELEASE_1.md section J3): `get_log {crash}` and `ping.last_crash`.
//
// The log ring lives in the JVM that dies, so the one line a modder most wants - why the game went
// down - is the one no in-process capture can hold. Vanilla writes it to <gameDir>/crash-reports/
// on the way out and the NEXT game reads it. This file plays the dead game: it drops a report a real
// client wrote (ArmorPieces, 2026-09-03, a NoClassDefFoundError out of a screen's init, one frame
// edited to name a toolkit class so attribution has a mod THIS game loads to resolve to) into the
// live game's crash-reports directory and asks the two tools about it.
//
// What is asserted, and why each half is a separate claim:
//   * `ping.last_crash` NAMES the report without being asked - the announcement half. Its `at` is
//     the report's own clock (2026-09-03), not the file's; the "newer than the previous boot" test
//     uses the file's, which is what lets a report copied in now be announced now.
//   * `get_log {crash:"latest"}` summarises it: title, exception, thread, capped frames and causes.
//   * ATTRIBUTION is the live half the unit test cannot reach: a frame in the toolkit resolves to
//     `mcptoolkit` through the loader's mod list, a vanilla frame to `minecraft`, and a frame of a mod
//     this game never loaded to `unresolved` - and `suspect` is the first that is somebody's mod.
//   * The selectors agree: "latest", "1" and the file name are the same report; a miss is ok:false.
//
// NOT COVERED, said plainly: the failed-boot path (a bad mixin, a missing dependency). That is
// rebuild.ps1's exit-1 tail, and breaking a boot inside the battery is not worth what it costs; it
// gets one recorded human run (RELEASE_1.md section J3, arbiter). Nor the stamp's "previous boot"
// bound across a restart, for the same reason - what IS pinned is that after cleanup the tool does
// not keep naming a report this file wrote.
//
// This file stages NOTHING in the world and claims no probe site. It writes two files into
// <gameDir>/crash-reports/ named `crash-<stamp>-probe.txt` and deletes them after.
//
// Live probe: needs the dev game up (`gradlew runServer` or a client). Skips itself when the bridge
// is down. Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-crash-summary";
const HERE = dirname(fileURLToPath(import.meta.url));

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

// crash-YYYY-MM-DD_HH.MM.SS-<side>.txt is vanilla's shape; "probe" as the side marks ours.
function stampName(d, suffix) {
  const p = (n) => String(n).padStart(2, "0");
  return `crash-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}-probe-${suffix}.txt`;
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev game to run these probes\n`);
}

describe("crash summary: the previous game's death, read by the next one", { skip: !bridgeUp }, () => {
  let dir;
  let first;      // the toolkit-frame fixture, written first
  let second;     // the untouched real report, written second and therefore newer
  const written = [];

  before(async () => {
    if (!bridgeUp) return;
    const info = await call("ping");
    assert.equal(typeof info.gameDir, "string", "ping must report gameDir");
    dir = join(info.gameDir, "crash-reports");
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    first = join(dir, stampName(now, "toolkit"));
    copyFileSync(join(HERE, "fixtures", "crash-toolkit-frame.txt"), first);
    // Windows CopyFile PRESERVES the source's last-write time, so a copied fixture arrives dated
    // whenever the fixture was made - older than the previous boot, and therefore not announced.
    // A real report is written fresh by the dying game; stamp the copy so it looks like one.
    utimesSync(first, now, now);
    written.push(first);
  });

  after(() => {
    for (const f of written) {
      try { rmSync(f); } catch { /* already gone */ }
    }
  });

  test("ping.last_crash names the report without being asked", async () => {
    const info = await call("ping");
    assert.ok(info.last_crash, `ping carried no last_crash; crash-reports dir is ${dir}`);
    assert.equal(info.last_crash.path.replace(/\\/g, "/"), first.replace(/\\/g, "/"),
      "the newest report is the one this probe just wrote");
    assert.equal(info.last_crash.title, "Unexpected error");
    assert.equal(info.last_crash.at, "2026-09-03 23:47:35", "`at` is the report's own clock");
    assert.match(info.last_crash.read, /get_log \{crash/);
  });

  test("get_log {crash:\"latest\"} summarises it and attributes its frames", async () => {
    const r = await call("get_log", { crash: "latest" });
    assert.equal(r.mechanism, "observe");
    const rep = r.report;
    assert.ok(rep, "a `report` block");
    assert.equal(rep.title, "Unexpected error");
    assert.equal(rep.thread, "Render thread");
    assert.match(rep.exception, /^java\.lang\.NoClassDefFoundError: com\/mattjesmc/);
    assert.ok(Array.isArray(rep.frames) && rep.frames.length === 10, "head frames capped at ten");
    assert.equal(rep.frames_omitted, 9, "the edited head trace has 19 frames");

    // Attribution: the three answers the mechanism can give, each on the frame that earns it.
    const [foreign, toolkit, server, screen] = rep.frames;
    assert.match(foreign.at, /^com\.mattjesmc\.armorpieces/);
    assert.equal(foreign.mod, "unresolved", "a class this game never loaded is not guessed");
    assert.match(toolkit.at, /^com\.mattmc\.mcptoolkit\.BridgeServer/);
    assert.equal(toolkit.mod, "mcptoolkit", `the loader's mod list resolves the toolkit's own class: ${JSON.stringify(toolkit)}`);
    assert.match(server.at, /^net\.minecraft\.server\.MinecraftServer/);
    assert.equal(server.mod, "minecraft", "a class both sides load resolves to the game");
    // A client-only class is a real fork: a client loads it, a dev dedicated server STRIPS it
    // (Fabric's environment stripping), and the honest answer there is unresolved, not minecraft.
    assert.match(screen.at, /^net\.minecraft\.client\.gui\.screens\.Screen/);
    const info = await call("ping");
    if (info.clientPresent) assert.equal(screen.mod, "minecraft");
    else assert.ok(["minecraft", "unresolved"].includes(screen.mod), screen.mod);
    assert.equal(rep.suspect, "mcptoolkit", "the first frame that is somebody's mod");

    assert.equal(rep.attribution.mcptoolkit, 1);
    assert.ok(rep.attribution.minecraft >= 1, JSON.stringify(rep.attribution));
    assert.ok(rep.attribution.unresolved >= 1);
    assert.ok(rep.unresolved_means, "an unresolved frame is explained beside the table");

    assert.equal(rep.causes.length, 1);
    assert.match(rep.causes[0].exception, /^java\.lang\.ClassNotFoundException/);
    assert.equal(rep.causes[0].frames.length, 4);
    assert.equal(rep.causes[0].frames[0].mod, "java");

    assert.deepEqual(rep.loader_suspected_mods.length, 2, "the loader's own section rides along");
    assert.match(rep.loader_suspected_mods[0], /armorpieces/);

    assert.equal(typeof r.reports, "number");
    assert.ok(r.reports >= 1);
    assert.equal(r.newer, undefined, "the newest report has nothing newer");
  });

  test("\"latest\", \"1\" and the file name select the same report; a miss refuses", async () => {
    const name = first.split(/[\\/]/).pop();
    const byIndex = await call("get_log", { crash: "1" });
    const byName = await call("get_log", { crash: name });
    assert.equal(byIndex.report.path, byName.report.path);
    assert.equal(byName.report.path.replace(/\\/g, "/"), first.replace(/\\/g, "/"));

    const miss = await raw("get_log", { crash: "crash-1999-01-01_00.00.00-nope.txt" });
    assert.equal(miss.ok, false);
    assert.match(JSON.stringify(miss.error), /latest/, "the refusal says what `crash` accepts");
    const tooFar = await raw("get_log", { crash: "9999" });
    assert.equal(tooFar.ok, false);
  });

  test("a newer report takes over last_crash, and one with no mod frame has no suspect", async () => {
    // Written after the first, and its mtime pushed a few seconds past it so "newest" cannot be a
    // same-second tie decided by file name.
    second = join(dir, stampName(new Date(Date.now() + 5000), "plain"));
    copyFileSync(join(HERE, "fixtures", "crash-armorpieces-noclassdef.txt"), second);
    const t = new Date(Date.now() + 5000);
    utimesSync(second, t, t);
    written.push(second);

    const info = await call("ping");
    assert.equal(info.last_crash.path.replace(/\\/g, "/"), second.replace(/\\/g, "/"));

    const r = await call("get_log", { crash: "latest" });
    assert.equal(r.report.path.replace(/\\/g, "/"), second.replace(/\\/g, "/"));
    assert.equal(r.report.suspect, undefined,
      `every frame here is vanilla, the JDK, the loader or unresolved: ${JSON.stringify(r.report.attribution)}`);
    assert.ok(Array.isArray(r.older) && r.older.includes(first.split(/[\\/]/).pop()),
      "the report this probe wrote first is listed as older");
    const back = await call("get_log", { crash: "2" });
    assert.equal(back.report.path.replace(/\\/g, "/"), first.replace(/\\/g, "/"));
  });

  test("after cleanup nothing this probe wrote is still named", async () => {
    for (const f of written) rmSync(f);
    written.length = 0;
    const info = await call("ping");
    if (info.last_crash) {
      assert.ok(!/-probe-/.test(info.last_crash.path), `a deleted report is still named: ${info.last_crash.path}`);
    }
    const j = await raw("get_log", { crash: "latest" });
    if (j.ok) assert.ok(!/-probe-/.test(j.result.report.path));
    else assert.match(JSON.stringify(j.error), /no crash reports/);
    assert.ok(!existsSync(first) && (!second || !existsSync(second)));
  });
});
