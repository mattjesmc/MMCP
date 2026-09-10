#!/usr/bin/env node
// The session cost analyser (LOOP_KIT_DESIGN.md §5.5): what a headless unit session actually cost,
// and the one line that matters - which tool was called most, and whether it takes a list.
//
// ArmorPieces wrote this as a scratchpad script over `claude -p --output-format stream-json` logs,
// drew every conclusion in LOOP_KIT_DESIGN.md §1 from it, and lost it. This is that script made
// durable, and it reads BOTH formats a session leaves behind:
//
//   - stream-json from `claude -p --output-format stream-json --verbose` (what run-unit.ps1 writes)
//   - a Claude Code transcript from ~/.claude/projects/<slug>/<session>.jsonl
//
// Both carry one {type:"assistant", message:{usage, content}} per API call, and tool results with
// image blocks in the user turns; that is all the arithmetic needs.
//
//   node tools/loop/analyse.mjs <log.jsonl> [--json] [--rates in,out,cacheRead,cacheWrite]
//   node tools/loop/analyse.mjs --project C--Users-you-ArmorPieces [--top 5]
//
// THE ARITHMETIC. A session costs TURNS x THE CONTEXT EACH TURN CARRIES. `context` per turn is
// input + cache_read + cache_creation - everything the model read to answer - and almost all of it
// is cache reads of the same growing conversation. Output tokens are noise by comparison. So the
// lever is the turn count, and the turn count is set by whichever tool is called once per unit of
// work: that is the line at the bottom.
//
// PRICES. Per-model list rates, $/MTok, as of 2026-06 (claude-api skill, Current Models): cache
// reads at 0.1x input, cache writes at 1.25x input for the 5-minute cache and 2x for the 1-hour
// cache (a headless claude -p session writes the 1-hour one; the result line's `cache_creation`
// says how much of each). Override with --rates when they move.
//
// THE HARNESS FIGURE LEADS. A stream-json `result` line carries total_cost_usd and a `usage`
// object with the session's TRUE totals, and those are what the cost line quotes when present; the
// estimate from this file's own arithmetic follows it. The per-message `usage` on stream-json's
// assistant lines does NOT carry the output and thinking the model produced - ArmorPieces' falsifier
// (LOOP_KIT_DESIGN.md section 11, finding 8) summed 179 output tokens over 33 turns of a session
// whose result line said 53,325, and the estimate read $1.95 against the harness's $3.70. So: the
// result line's usage is the session's usage when it is there; without it, an output count
// implausible for the turn count is said out loud rather than priced as if it were true.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const RATES = [
  // [id prefix, input, output] - first match wins, so the longer prefixes come first.
  ["claude-fable", 10, 50], ["claude-mythos", 10, 50],
  ["claude-opus-5", 5, 25], ["claude-opus-4", 5, 25],
  ["claude-sonnet-5", 2, 10], ["claude-sonnet-4-6", 3, 15], ["claude-sonnet-4", 3, 15],
  ["claude-haiku-4", 1, 5], ["claude-haiku", 1, 5],
];
const HARNESS_TOOLS = new Set(["Bash", "PowerShell", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep",
  "ToolSearch", "Task", "Agent", "TaskStop", "TaskOutput", "AskUserQuestion", "WebFetch", "WebSearch",
  "NotebookEdit", "TodoWrite", "Skill"]);
const TOKENS_PER_PX = 750;
const API_MAX_EDGE = 1568;
const API_MAX_PIXELS = 1_150_000;

function ratesFor(model, override) {
  if (override) {
    const [i, o, r, w] = override.split(",").map(Number);
    return { input: i, output: o, cacheRead: r ?? i * 0.1, cacheWrite: w ?? i * 1.25, source: "--rates" };
  }
  const hit = RATES.find(([p]) => (model ?? "").startsWith(p));
  if (!hit) return null;
  return { input: hit[1], output: hit[2], cacheRead: hit[1] * 0.1, cacheWrite: hit[1] * 1.25, source: `${hit[0]}* list price` };
}

/** Width and height from a PNG's header, or from a JPEG's SOF marker; null when unknown. */
function imageSize(b64) {
  const buf = Buffer.from(b64.slice(0, 64_000), "base64");
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      const marker = buf[p + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
      }
      p += 2 + buf.readUInt16BE(p + 2);
    }
  }
  return null;
}

function apiTokens(w, h) {
  const edge = Math.max(w, h);
  if (edge > API_MAX_EDGE) { const s = API_MAX_EDGE / edge; w *= s; h *= s; }
  if (w * h > API_MAX_PIXELS) { const s = Math.sqrt(API_MAX_PIXELS / (w * h)); w *= s; h *= s; }
  return Math.round((w * h) / TOKENS_PER_PX);
}

/** Every image block in a content tree, whatever nesting the format used. */
function* images(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) yield* images(n); return; }
  if (node.type === "image") { yield node; return; }
  if (node.content) yield* images(node.content);
}

export function analyse(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const turns = [];
  const tools = new Map(); // name -> { calls, listCalls, lastTurn }
  const pictures = [];
  let model = null;
  let harnessCost = null;
  let harnessTurns = null;
  let harnessUsage = null;
  let firstTs = null, lastTs = null;
  // ONE API CALL = ONE TURN. Both formats write one `assistant` line PER CONTENT BLOCK (thinking,
  // tool_use, text), each carrying the same message id and the same usage object - the runner's
  // first live run (2026-09-06) counted 12 turns for 6 API calls and summed every usage twice.
  // Blocks that share an id merge into the turn already open; usage takes the largest value seen,
  // because a streaming log may report the final counts only on the last block.
  let lastId = null;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { firstTs ??= o.timestamp; lastTs = o.timestamp; }
    if (o.type === "system" && o.subtype === "init" && o.model) model = o.model;
    if (o.type === "result") {
      if (typeof o.total_cost_usd === "number") harnessCost = o.total_cost_usd;
      if (typeof o.num_turns === "number") harnessTurns = o.num_turns;
      const u = o.usage;
      if (u && typeof u === "object" && typeof u.output_tokens === "number") {
        harnessUsage = {
          input: u.input_tokens ?? 0, output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          thinking: u.output_tokens_details?.thinking_tokens ?? null,
        };
      }
    }
    const m = o.message;
    if (o.type === "assistant" && m) {
      if (m.model) model ??= m.model;
      const u = m.usage ?? {};
      const same = m.id && m.id === lastId && turns.length;
      const turn = same ? turns[turns.length - 1] : {
        index: turns.length, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: [],
      };
      turn.input = Math.max(turn.input, u.input_tokens ?? 0);
      turn.cacheRead = Math.max(turn.cacheRead, u.cache_read_input_tokens ?? 0);
      turn.cacheWrite = Math.max(turn.cacheWrite, u.cache_creation_input_tokens ?? 0);
      turn.output = Math.max(turn.output, u.output_tokens ?? 0);
      turn.context = turn.input + turn.cacheRead + turn.cacheWrite;
      lastId = m.id ?? null;
      for (const b of m.content ?? []) {
        if (b.type !== "tool_use") continue;
        const name = b.name ?? "?";
        const t = tools.get(name) ?? { calls: 0, listCalls: 0, lastTurn: -1 };
        t.calls++;
        if (b.input && typeof b.input === "object" && Object.values(b.input).some((v) => Array.isArray(v) && v.length > 1)) t.listCalls++;
        t.lastTurn = turn.index;
        tools.set(name, t);
        turn.calls.push(name);
      }
      if (!same) turns.push(turn);
    }
    if (o.type === "user" && m) {
      for (const img of images(m.content)) {
        const data = img.source?.data ?? img.data;
        const size = typeof data === "string" ? imageSize(data) : null;
        pictures.push({
          afterTurn: turns.length - 1,
          w: size?.w ?? null, h: size?.h ?? null,
          tokens: size ? apiTokens(size.w, size.h) : null,
          bytes: typeof data === "string" ? Math.round(data.length * 0.75) : null,
        });
      }
    }
  }
  // Every picture is re-sent on every later turn: its session cost is tokens x turns after it.
  for (const p of pictures) p.sessionTokens = p.tokens === null ? null : p.tokens * Math.max(0, turns.length - 1 - p.afterTurn);
  const sum = (k) => turns.reduce((s, t) => s + t[k], 0);
  const byCalls = [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls);
  // THE LINE is about the AUTHORING tool - the one called once per unit of work. The harness's own
  // file and shell tools are not candidates for a batch form, so an interactive transcript (Bash
  // 190x) still names the tool that matters.
  const top = byCalls.find(([n]) => !HARNESS_TOOLS.has(n)) ?? byCalls[0] ?? null;
  const lastEdit = top ? top[1].lastTurn : -1;
  // A turn produces at least a tool_use block: a per-message output sum under ~20 tokens a turn is
  // a log whose per-message usage omits output, not a session that said nothing.
  const outputImplausible = turns.length > 0 && sum("output") < turns.length * 20;
  return {
    file, model, turns: turns.length, harnessTurns,
    context: { total: sum("context"), mean: turns.length ? Math.round(sum("context") / turns.length) : 0,
      max: Math.max(0, ...turns.map((t) => t.context)) },
    cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), input: sum("input"), output: sum("output"),
    harnessUsage, outputImplausible,
    pictures: {
      count: pictures.length,
      tokens: pictures.reduce((s, p) => s + (p.tokens ?? 0), 0),
      sessionTokens: pictures.reduce((s, p) => s + (p.sessionTokens ?? 0), 0),
      afterLastTopCall: pictures.filter((p) => p.afterTurn >= lastEdit).length,
      list: pictures,
    },
    tools: byCalls.map(([name, t]) => ({ name, ...t })),
    top: top ? { name: top[0], calls: top[1].calls, takesList: top[1].listCalls > 0, listCalls: top[1].listCalls } : null,
    harnessCost,
    wallSeconds: firstTs && lastTs ? Math.round((Date.parse(lastTs) - Date.parse(firstTs)) / 1000) : null,
  };
}

/** The usage the estimate is priced on: the result line's totals when the log has them. */
export function usageOf(a) {
  return a.harnessUsage ?? { input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite, cacheWrite1h: 0, thinking: null };
}

/** The cache-write charge: 5-minute writes at the 1.25x rate, 1-hour writes at 2x input. */
function cacheWriteCost(u, rates) {
  const oneHour = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
  return ((u.cacheWrite - oneHour) * rates.cacheWrite + oneHour * rates.input * 2) / 1e6;
}

export function cost(a, rates) {
  if (!rates) return null;
  const u = usageOf(a);
  return (u.input * rates.input + u.output * rates.output + u.cacheRead * rates.cacheRead) / 1e6 + cacheWriteCost(u, rates);
}

const fmt = (n) => (n === null || n === undefined ? "?" : n.toLocaleString("en-US"));

export function report(a, rates) {
  const usd = cost(a, rates);
  const L = [];
  L.push(`${path.basename(a.file)}  model ${a.model ?? "?"}${a.wallSeconds ? `  ${Math.round(a.wallSeconds / 60)} min` : ""}`);
  L.push(`  turns          ${a.turns}${a.harnessTurns !== null && a.harnessTurns !== a.turns ? ` (harness counted ${a.harnessTurns})` : ""}`);
  L.push(`  context/turn   mean ${fmt(a.context.mean)}  max ${fmt(a.context.max)}  total ${fmt(a.context.total)}`);
  const u = usageOf(a);
  L.push(`  cache read     ${fmt(u.cacheRead)}    cache write ${fmt(u.cacheWrite)}    uncached in ${fmt(u.input)}    output ${fmt(u.output)}`
    + `${u.thinking !== null ? ` (thinking ${fmt(u.thinking)})` : ""}`
    + `${a.harnessUsage ? `   [the result line's totals; per message the log summed ${fmt(a.output)} output]` : ""}`);
  if (!a.harnessUsage && a.outputImplausible) {
    L.push(`  !! output      ${fmt(a.output)} tokens over ${a.turns} turns is implausible: this log's per-message usage omits output and thinking, so the estimate below is LOW - quote the harness's figure`);
  }
  const estimate = usd === null ? null : (() => {
    const split = {
      read: (u.cacheRead * rates.cacheRead) / 1e6, write: cacheWriteCost(u, rates),
      input: (u.input * rates.input) / 1e6, output: (u.output * rates.output) / 1e6,
    };
    return `$${usd.toFixed(2)} (${rates.source}): cache read $${split.read.toFixed(2)}, cache write $${split.write.toFixed(2)}`
      + `${u.cacheWrite1h ? ` (${fmt(u.cacheWrite1h)} of it 1-hour, at 2x)` : ""}, input $${split.input.toFixed(2)}, output $${split.output.toFixed(2)}`;
  })();
  if (a.harnessCost !== null) {
    // The harness's number is the one a reader quotes; the estimate is the arithmetic beside it.
    L.push(`  cost           $${a.harnessCost.toFixed(2)} (the harness's total_cost_usd)`);
    L.push(`  estimate       ${estimate ?? `unknown model "${a.model}" - pass --rates in,out[,cacheRead,cacheWrite] ($/MTok)`}`);
  } else if (estimate !== null) {
    L.push(`  cost           ${estimate} - estimated; this log has no result line`);
  } else {
    L.push(`  cost           unknown model "${a.model}" - pass --rates in,out[,cacheRead,cacheWrite] ($/MTok)`);
  }
  const p = a.pictures;
  L.push(`  pictures       ${p.count}${p.count ? `, ~${fmt(p.tokens)} tok as sent, ~${fmt(p.sessionTokens)} tok re-sent over the turns after them` : ""}`
    + `${p.count && a.top ? `; ${p.afterLastTopCall} taken after the last ${a.top.name} call` : ""}`);
  for (const pic of p.list.slice(0, 12)) {
    L.push(`    after turn ${String(pic.afterTurn).padStart(3)}  ${pic.w ?? "?"}x${pic.h ?? "?"}  ~${fmt(pic.tokens)} tok  x${Math.max(0, a.turns - 1 - pic.afterTurn)} turns = ~${fmt(pic.sessionTokens)}`);
  }
  if (p.list.length > 12) L.push(`    ... ${p.list.length - 12} more`);
  L.push(`  calls per tool`);
  for (const t of a.tools.slice(0, 15)) {
    L.push(`    ${t.name.padEnd(36)} ${String(t.calls).padStart(4)}${t.listCalls ? `  (${t.listCalls} with a list)` : ""}`);
  }
  if (a.tools.length > 15) L.push(`    ... ${a.tools.length - 15} more tools`);
  if (a.top) {
    L.push(a.top.takesList
      ? `  THE LINE: ${a.top.name} was called ${a.top.calls}x and ${a.top.listCalls} of those carried a list - batching is in use; the next lever is pictures or the context each turn carries.`
      : `  THE LINE: ${a.top.name} was called ${a.top.calls}x and never with a list - a batch form of it would cut up to ~${Math.max(0, a.top.calls - 1)} turns, each re-sending ~${fmt(a.context.mean)} tokens.`);
  }
  return L.join("\n");
}

// --- CLI ------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("analyse.mjs")) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const json = argv.includes("--json");
  let files = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !["--json"].includes(argv[i - 1])));
  if (flag("project")) {
    const dir = path.join(os.homedir(), ".claude", "projects", flag("project"));
    const top = Number(flag("top") ?? 5);
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size).slice(0, top);
  }
  if (!files.length) {
    console.error("usage: analyse.mjs <log.jsonl>... [--json] [--rates in,out,cacheRead,cacheWrite] | --project <slug> [--top N]");
    process.exit(2);
  }
  const out = [];
  for (const f of files) {
    const a = analyse(f);
    const rates = ratesFor(a.model, flag("rates"));
    if (json) out.push({ ...a, cost_usd: cost(a, rates), harness_cost_usd: a.harnessCost, usage_source: a.harnessUsage ? "result line" : "per message", rates });
    else console.log(`${report(a, rates)}\n`);
  }
  if (json) console.log(JSON.stringify(out, null, 2));
}
