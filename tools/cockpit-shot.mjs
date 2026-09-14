// Look at the cockpit without a human: open a tab of mmcpd's `/ui/` in headless Edge, driven over
// the DevTools protocol, and write a PNG. An agent that edits daemon/ui/ can then SEE what it did.
//
// Why CDP and not `msedge --headless --screenshot`: the plain flag stops the page at "load" (or at
// `--timeout`) and cuts the fetches the page is still making, so the cockpit shows a header and an
// empty body - measured 2026-09-14, three times, before this was written. Over CDP the page gets a
// real lifetime: navigate, wait, click the tab, capture. Console exceptions are printed as they
// happen, which is the other thing a screenshot cannot tell you.
//
// Usage: node tools/cockpit-shot.mjs <url> [tab] <out.png>
//   tab: projects | sessions | changes | blockbench (omit for the page as it opens)
// Needs Edge (Windows ships it); no dependency - Node 22's WebSocket talks CDP directly.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const url = args[0];
const out = args[args.length - 1];
const tab = args.length === 3 ? args[1] : null;
if (!url || !out || args.length < 2) {
  console.error("usage: node tools/cockpit-shot.mjs <url> [projects|sessions|changes|blockbench] <out.png>");
  process.exit(2);
}
const EDGES = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
const edgeExe = EDGES.find((p) => existsSync(p));
if (!edgeExe) { console.error("no msedge.exe found"); process.exit(2); }
const PORT = 9333 + Math.floor(Math.random() * 500);

const edge = spawn(edgeExe, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--window-size=1280,800",
  `--user-data-dir=${process.env.TEMP ?? "/tmp"}/edge-cockpit-shot`, "about:blank"], { stdio: "ignore" });
const bye = (code) => { try { edge.kill(); } catch { /* gone */ } process.exit(code); };
try {
  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) {
    await new Promise((r) => setTimeout(r, 250));
    targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => null);
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error("Edge did not open a page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let id = 0;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.addEventListener("message", (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pending.has(j.id)) { pending.get(j.id)(j.result); pending.delete(j.id); }
    if (j.method === "Runtime.exceptionThrown") console.log("EXCEPTION", j.params.exceptionDetails.exception?.description ?? j.params.exceptionDetails.text);
    if (j.method === "Runtime.consoleAPICalled" && (j.params.type === "error" || j.params.type === "warning")) console.log("CONSOLE", j.params.type, j.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, 5000));
  if (tab) await call("Runtime.evaluate", { expression: `document.querySelector('#tabs button[data-tab="${tab}"]')?.click()` });
  await new Promise((r) => setTimeout(r, 1500));
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`wrote ${out}`);
  ws.close();
  bye(0);
} catch (e) {
  console.error(e.message);
  bye(1);
}
