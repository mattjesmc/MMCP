// Probe for launch_game's in-process guard (mcp-server/local/dev.mjs). Needs no game and no
// bridge; exits with the number of failing cases.
//
// Live test of launch_game's in-process guard. Runs on spare port 25698, and holds that port's
// cycle lock FIRST so every supervisor it spawns stops at rebuild.ps1 step 0 and never reaches
// Gradle - the test must not boot a Minecraft client.
//
// The holder is deliberately NOT named *rebuild.ps1*, so -Takeover's identity guard declines to
// kill it and the takeover run also stops before Gradle. That the guard DOES kill a real
// supervisor is covered by the PowerShell battery; what is under test here is that the JS layer
// refuses a second cycle, and that takeover:true reaches the script as -Takeover.
process.env.MCPTK_URL = "http://127.0.0.1:25698";

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`PASS  ${name}`); pass++; }
  else { console.log(`FAIL  ${name} -- ${detail}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const holderFile = join(tmpdir(), "holdlock-test.ps1");
writeFileSync(holderFile, [
  '$l = Join-Path $env:TEMP "mcptk-rebuild-25698.lock"',
  '$fs = [System.IO.File]::Open($l, "Create", "Write", "Read")',
  '$s = "pid=$PID project=toolkit target=client port=25698 started=" + (Get-Date).ToString("o")',
  '$b = [System.Text.Encoding]::UTF8.GetBytes($s)',
  '$fs.Write($b, 0, $b.Length); $fs.Flush()',
  'Start-Sleep -Seconds 90',
].join("\r\n"), "ascii");

const holder = spawn("powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", holderFile],
  { stdio: "ignore", windowsHide: true });
await sleep(2500);
check("holder took the port-25698 lock", holder.exitCode === null, `exitCode ${holder.exitCode}`);

const dev = await import("file:///" +
  join(REPO, "mcp-server", "local", "dev.mjs").replace(/\\/g, "/"));

const r1 = await dev.callLocalTool("launch_game", { target: "client", rebuild: false });
check("first launch_game is accepted", r1.ok === true, JSON.stringify(r1).slice(0, 200));
check("it targets the port MCPTK_URL names", r1.result?.port === 25698, `port ${r1.result?.port}`);

// No await in between: the guard must hold while our own supervisor is still alive.
const r2 = await dev.callLocalTool("launch_game", { target: "client", rebuild: false });
check("second launch_game is REFUSED", r2.ok === false, JSON.stringify(r2).slice(0, 200));
check("refusal names the in-flight pid", String(r2.error).includes(String(r1.result.pid)), r2.error);
check("refusal names that supervisor's log", String(r2.error).includes(r1.result.log), r2.error);
check("refusal offers takeover", /takeover/.test(String(r2.error)), r2.error);
check("refusal points at dev-procs.ps1", /dev-procs\.ps1/.test(String(r2.error)), r2.error);

const r3 = await dev.callLocalTool("launch_game", { target: "client", rebuild: false, takeover: true });
check("takeover:true is accepted", r3.ok === true, JSON.stringify(r3).slice(0, 200));
check("takeover is echoed back", r3.result?.takeover === true, JSON.stringify(r3.result));
check("takeover spawned a NEW supervisor", r3.result?.pid !== r1.result.pid, "same pid");

// r1's supervisor exits ~now. Its exit handler must not clear r3's slot - the pid compare.
await sleep(6000);
const r4 = await dev.callLocalTool("launch_game", { target: "client", rebuild: false });
check("r1's exit did not free r3's slot (pid compare)",
  r4.ok === false && String(r4.error).includes(String(r3.result.pid)),
  JSON.stringify(r4).slice(0, 200));

const log1 = readFileSync(r1.result.log, "utf8");
check("supervisor 1 exited 3 (another cycle owns the port)", log1.includes("EXIT=3"), log1.slice(-300));
check("supervisor 1 never reached Gradle", !/launching .* :runClient/.test(log1), log1.slice(-300));

await sleep(9000);
const log3 = readFileSync(r3.result.log, "utf8");
check("-Takeover reached the script",
  /lock is held but no rebuild\.ps1 answers/.test(log3), log3.slice(-400));
check("supervisor 3 also stopped before Gradle", !/launching .* :runClient/.test(log3), log3.slice(-300));

console.log(`\n${pass} passed, ${fail} failed`);
try { holder.kill(); } catch {}
for (const f of [join(tmpdir(), "mcptk-rebuild-25698.lock"), holderFile]) {
  try { rmSync(f, { force: true }); } catch {}
}
process.exit(fail);
