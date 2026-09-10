#!/usr/bin/env node
// Ablation MCP shim: a stdio MCP server exposing EXACTLY the condition's toolset to the agent under
// test (Claude Agent SDK / Max-subscription runner — no raw API access). Same dispatch semantics as
// the in-process runner had: mem_* via memory/tools.mjs against the per-run MCPTK_MEMORY_DIR, world
// tools proxied to the bridge, condition B's mem_recent wrapped with the truncation banner.
//
// The shim also owns the tool half of the transcript (MCPTK_ABLATION_TRANSCRIPT): tool results
// must be recorded verbatim for metrics, and only this process sees them.
//
// Env contract (set by run.mjs):
//   MCPTK_ABLATION_CONDITION   a|b|c|d
//   MCPTK_MEMORY_DIR           per-run memory root
//   MCPTK_TAIL_BUDGET          condition b's visible-tail budget (tokens)
//   MCPTK_ABLATION_TRANSCRIPT  JSONL file to append {t,type:"tool",name,input,result,ms} rows

import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { CONDITIONS, AGENT_WORLD_TOOLS, assertWorldToolsLive, assertMemToolsLive, tailOnlyRecent } from "./conditions.mjs";
import { bridge, fetchManifest } from "./bridge.mjs";

// Compose the authored-memory and captured-observation registries explicitly. NOT `local/registry.mjs`
// — that aggregate also carries the dev tools (launch_game, hotswap…), which must never reach an
// agent under test. Both registries export the same triple.
import * as authored from "../memory/tools.mjs";
import { isUnresolvableWhat, locateFromMemory } from "../memory/tools.mjs";
import { processWorldRead, attachRemembered } from "../memory/annotate.mjs";
import { captureProprioception } from "../memory/capture.mjs";
import { legalLocate } from "../memory/legal-locate.mjs";
import { SCAN_TOOL, botScan } from "../memory/scan.mjs";
import { recordOutcome } from "../memory/route-ledger.mjs";
import { tryRoute } from "../memory/route-exec.mjs";

const REGISTRIES = [authored];
const localTools = () => REGISTRIES.flatMap((r) => r.localTools());
const isLocalTool = (name) => REGISTRIES.some((r) => r.isLocalTool(name));
const callLocalTool = (name, args, callBridge) =>
  REGISTRIES.find((r) => r.isLocalTool(name)).callLocalTool(name, args, callBridge);

// Capture is OPT-IN in the bench path (production defaults it on). An unflagged run must stay
// byte-identical to every prior run, so the arm has to ask for it explicitly.
const CAPTURE_ON = (process.env.MCPTK_OBS_CAPTURE ?? "off").trim() === "on";

// The route layer, same rule and for the same reason. Production defaults MCPTK_ROUTES to `learn`;
// a bench arm that inherited that would (a) answer concepts prior arms could not, changing what a
// row MEANS, and (b) do it invisibly, because routes never touch the manifest and therefore never
// move `tools_hash` — the exact drift `testbench/resume.mjs` treats as fatal, arriving through a
// door it cannot see.
//
// `record`, not `off`: no route ever fires, so what the agent sees is byte-identical to every prior
// run, but the ledger still fills — and a bench run is the richest source of unanswered-call data
// there is (the first backfill over this archive found 131 of them). Recording is invisible to the
// SUT by construction: it appends a line and returns the result untouched.
//
// Set before the modules read it: routes.mjs resolves the mode per call, not at import, precisely
// so this assignment lands.
process.env.MCPTK_ROUTES ??= "record";
const ROUTES_ARM = process.env.MCPTK_ROUTES;

const condition = CONDITIONS[process.env.MCPTK_ABLATION_CONDITION];
if (!condition) throw new Error(`MCPTK_ABLATION_CONDITION must be one of ${Object.keys(CONDITIONS).join("|")}, got ${process.env.MCPTK_ABLATION_CONDITION}`);
const tailBudget = parseInt(process.env.MCPTK_TAIL_BUDGET || "600", 10);
const transcriptPath = process.env.MCPTK_ABLATION_TRANSCRIPT || null;
const RESULT_CHAR_CAP = 24000;

const memToolSet = new Set(condition.memTools);
// The world-tool surface defaults to AGENT_WORLD_TOOLS (the copilot benches), but Category P
// (true-play) injects a player-legal surface via MCPTK_WORLD_TOOLS — sense_entities in, X-ray
// (get_entities/scene_summary/get_blocks/raycast) and run_command out — which is exactly the §9
// legal-tool-surface enforcement the profile still lacks. Comma-separated; empty/unset = default.
// Precedence: MCPTK_WORLD_TOOLS (Category P's player-legal surface) > the condition's own
// worldTools (cycle 2's g–j add `locate`) > AGENT_WORLD_TOOLS.
const worldToolSet = new Set(
  process.env.MCPTK_WORLD_TOOLS
    ? process.env.MCPTK_WORLD_TOOLS.split(",").filter(Boolean)
    : condition.worldTools ?? AGENT_WORLD_TOOLS,
);

function record(row) {
  if (transcriptPath) appendFileSync(transcriptPath, JSON.stringify(row) + "\n", "utf8");
}

async function dispatch(name, input) {
  if (isLocalTool(name)) {
    if (!memToolSet.has(name)) return { ok: false, error: `tool ${name} not available` };
    const r = await callLocalTool(name, input, bridge);
    if (name === "mem_recent" && condition.tailOnly && r.ok) {
      return { ok: true, result: tailOnlyRecent(r.result, tailBudget) };
    }
    return r;
  }
  // The legal arm's shim-local pieces (MEMORY_REDESIGN §12.5): bot_scan is Node orchestration
  // (memory/scan.mjs — the same verb production's survival profile serves), and `locate` swaps its
  // knowledge source to the provenance-filtered store (§12.1) instead of the bridge's X-ray search.
  if (condition.legal && name === SCAN_TOOL.name) {
    return botScan(input, bridge);
  }
  if (condition.legal && name === "locate") {
    return legalLocate(input, bridge);
  }
  if (!worldToolSet.has(name)) return { ok: false, error: `tool ${name} not available` };
  const startedAt = Date.now();
  let r = await bridge(name, input);
  // The route ledger (ROUTE_LEDGER_DESIGN §2), mirroring production exactly — including the
  // ORDERING, which is the load-bearing part: recorded before the fallthroughs below, because the
  // unresolvable-`what` fallthrough rewrites a concept miss into an ok:true memory answer and would
  // otherwise erase the one signal the route layer is built from. Inert when MCPTK_ROUTES=off (the
  // default here), so an unflagged arm writes nothing.
  await recordOutcome({
    tool: name, args: input, ok: r.ok, error: r.error, result: r.result,
    session: process.env.MCPTK_SESSION ?? null, profile: `ablation:${condition.key}`,
    ms: Date.now() - startedAt,
  });
  // Same concept fallthrough as production (MEMORY_REDESIGN §3): an unresolvable `what` is answered
  // from memory rather than dead-ending. Only that error class; everything else stays an error.
  // Route first, memory second — see index.mjs for why that order is the right way round.
  if (!r.ok && name === "locate" && isUnresolvableWhat(r.error)) {
    const routed = await tryRoute(input, bridge, { session: process.env.MCPTK_SESSION ?? null });
    r = routed ?? await locateFromMemory(input?.what, bridge).catch(() => r);
  }
  // Capture is a passive side effect of READING (OBSERVATION_MEMORY_DESIGN §7 step 2): it records
  // what the tool returned. ANNOTATE (MEMORY_REDESIGN §2.2) is the half that does change what the
  // agent sees — a labelled `remembered` appendix — and it is governed by its own env flag, so
  // arms g/h (and i/j) can differ in the appendix alone while capturing the identical corpus.
  // Never throws, never blocks the result.
  if (CAPTURE_ON && r.ok) {
    const ann = await processWorldRead(name, input, r.result, bridge).catch(() => null);
    attachRemembered(r.result, ann);
    // Proprioception (SURVIVAL_MODE_PLAN §4): nav verdicts carry the body's traversal trail —
    // capture it under the reserved legal provenance name, from waited verdicts and polled events.
    if (r.result && typeof r.result === "object") {
      if (Array.isArray(r.result.traversed)) {
        await captureProprioception(r.result, bridge);
      } else if (name === "get_events" && Array.isArray(r.result.events)) {
        for (const ev of r.result.events) {
          if (ev?.data && Array.isArray(ev.data.traversed)) await captureProprioception(ev.data, bridge);
        }
      }
    }
  }
  // The ascii re-encode existed because raw `get_blocks` was a needle-in-haystack column dump. Its
  // successor `get_surface` already RETURNS an abstracted representation (palette + heights +
  // anomalies), so re-wrapping buys nothing and costs a failure mode: asciiSurfaceView only fills
  // `view` for detail:"full" and yields "(no columns returned)" on the default summary — i.e. a
  // silent blanking, not a throw, so a try/catch would not catch it. Serve perception straight.
  return r;
}

const server = new Server({ name: "ablation", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const manifest = await fetchManifest();
  // B4: fail loudly if this arm names a tool the live surface doesn't have. Without this, a rename
  // downstream just deletes the tool from the arm and the run still "succeeds" at a lower score.
  assertWorldToolsLive(manifest.map((t) => t.name), [...worldToolSet]);
  // The same guard on the memory half — the .filter() below narrows SILENTLY otherwise.
  assertMemToolsLive(condition, localTools().map((t) => t.name));
  return {
    tools: [
      ...localTools().filter((t) => memToolSet.has(t.name)),
      // The legal arm's deliberate look-around is shim-local (memory/scan.mjs), so it rides beside
      // the manifest rather than being filtered from it — the bridge never carries a Node tool.
      ...(condition.legal ? [SCAN_TOOL] : []),
      ...manifest.filter((t) => worldToolSet.has(t.name)),
    ].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: input } = req.params;
  const t0 = Date.now();
  let env;
  try {
    env = await dispatch(name, input ?? {});
  } catch (e) {
    env = { ok: false, error: e.message };
  }
  record({ t: new Date().toISOString(), type: "tool", name, input: input ?? {}, result: env, ms: Date.now() - t0 });
  let body = JSON.stringify(env.ok ? env.result : { error: env.error });
  if (body.length > RESULT_CHAR_CAP) body = body.slice(0, RESULT_CHAR_CAP) + `…[truncated ${body.length - RESULT_CHAR_CAP} chars]`;
  return { content: [{ type: "text", text: body }], isError: !env.ok };
});

// An arm where routes can FIRE is a different SUT from every historical row, so it announces
// itself. `off`/`record` are silent: neither changes a single byte the agent sees.
if (!["off", "record"].includes(ROUTES_ARM)) {
  process.stderr.write(`[ablation] route layer: ${ROUTES_ARM} — this arm's vocabulary is NOT the historical one\n`);
}

await server.connect(new StdioServerTransport());
