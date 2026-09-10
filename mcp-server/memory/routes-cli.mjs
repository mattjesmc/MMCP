#!/usr/bin/env node
// The route overview — what the toolkit could not answer, and what to do about it
// (ROUTE_LEDGER_DESIGN.md §7).
//
// Deliberately a CLI and not a tool. The static tool prefix is re-read every turn and measures
// 50-92% of the bill (TOKEN_PER_TOOL_FINDINGS Finding 1), so a surface whose audience is a human
// reviewing telemetry once a week must not cost every session a manifest entry. The escalation
// agent reaches it the same way a human does — by running it.
//
//   node memory/routes-cli.mjs                       the overview
//   node memory/routes-cli.mjs overview --since=2026-08-01 --top=15
//   node memory/routes-cli.mjs routes                the table, with provenance and leg health
//   node memory/routes-cli.mjs queue                 concepts awaiting a route
//   node memory/routes-cli.mjs backfill [dir]        replay archived bench transcripts into the ledger
//   node memory/routes-cli.mjs prompt <concept>      the authoring brief for an escalation agent
//   node memory/routes-cli.mjs escalate [--top=3] [--spawn]
//   node memory/routes-cli.mjs propose --json '{"concept":"…","legs":[{"what":"#minecraft:logs"}]}'
//   node memory/routes-cli.mjs trial <concept> --near=x,z [--radius=64]
//   node memory/routes-cli.mjs promote <concept> [--force] [--by=matthijs]
//   node memory/routes-cli.mjs reject <concept> [--why="…"]
//
// Flags shared with recent-cli.mjs: --url=, --dir=.

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// `--flag=value` and `--flag value` both work, but ONLY the flags that take a value may consume the
// next token. An open-ended rule would make `backfill --dry some/dir` swallow the directory into
// --dry and then scan the wrong tree, silently — the shape of bug this whole feature exists to
// surface, so it would be a poor one to ship in the tool that surfaces it.
const VALUE_FLAGS = new Set(["json", "file", "dir", "url", "since", "top", "near", "radius", "by", "why"]);
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(argv[i]);
  if (!m) { positional.push(argv[i]); continue; }
  if (m[2] !== undefined) { flags[m[1]] = m[2]; continue; }
  if (VALUE_FLAGS.has(m[1]) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
    flags[m[1]] = argv[++i];
  } else {
    flags[m[1]] = true;
  }
}
if (flags.url) process.env.MCPTK_URL = flags.url;
if (flags.dir) process.env.MCPTK_MEMORY_DIR = flags.dir;
// The CLI reads and writes the table by hand; it must never be limited by the ambient session mode
// (a shell inheriting MCPTK_ROUTES=off would otherwise silently show an empty active vocabulary).
process.env.MCPTK_ROUTES = "learn";

const { RouteLedger, summarize, classifyError, compactArgs, conceptOf, conceptFromError, directionOf, isSilentMiss } =
  await import("./route-ledger.mjs");
const { RouteTable, defaultRoutesRoot, normalizeConcept, validateRoute, MAX_LEGS } =
  await import("./routes.mjs");
const { runRoute } = await import("./route-exec.mjs");

const BASE = process.env.MCPTK_URL
  || process.env.VJ_MCP_URL?.replace(/\/cmd\/?$/, "")
  || "http://127.0.0.1:25599";

const bridge = async (tool, args) => {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args: args ?? {} }),
    signal: AbortSignal.timeout(30_000),
  });
  return res.json();
};

const ledger = new RouteLedger();
const table = await new RouteTable().load();

const cmd = positional[0] ?? "overview";
const TOP = Number.parseInt(flags.top ?? "12", 10);

// --- rendering helpers --------------------------------------------------------------------------

const bar = (n, max, width = 24) => "█".repeat(Math.max(1, Math.round((n / Math.max(1, max)) * width)));
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

function heading(s) {
  console.log(`\n${s}`);
  console.log("─".repeat(Math.min(78, s.length + 12)));
}

/** What each bucket means, printed with it — a count whose fix is not obvious is a count nobody acts on. */
const BUCKET_HELP = {
  vocabulary: "a word `locate` could not resolve → write a route",
  affordance: "well-formed but wrong → fix the error text or the schema wording",
  capability: "a legitimate question refused by design → LOCATE_ROUTES.md's open items, ranked by demand",
  referent: "pointed at something that isn't there (dead entity id, unknown set) → handle lifetime/staleness",
  silent_miss: "a valid search that found nothing and could not prove absence → the failure that never raises",
  environment: "bridge down / no body — not a design signal",
  crash: "an internal defect surfaced to the model as an error → fix the code",
  unclassified: "the classifier does not know this one → add a pattern to route-ledger.mjs",
};

// --- commands --------------------------------------------------------------------------------------

async function overview() {
  const rows = await ledger.read();
  if (!rows.length) {
    console.log(`No ledger yet at ${defaultRoutesRoot()}/ledger.jsonl.`);
    console.log("It fills as sessions run (MCPTK_ROUTES=record or higher), or immediately with:");
    console.log("  node memory/routes-cli.mjs backfill");
    return;
  }
  const s = summarize(rows, { since: flags.since ?? null });
  console.log(`# locate route overview — ${s.total} unanswered call(s) across ${s.sessions} session(s), ${s.worlds} world(s)`);
  if (s.span) console.log(`  ${s.span[0]?.slice(0, 19)} … ${s.span[1]?.slice(0, 19)}${flags.since ? `  (since ${flags.since})` : ""}`);

  heading("BY CLASS — each bucket wants a different fix");
  const max = Math.max(...s.classes.map((c) => c.count), 1);
  for (const c of s.classes) {
    console.log(`  ${pad(c.class, 13)} ${rpad(c.count, 5)}  ${pad(bar(c.count, max), 25)} ${BUCKET_HELP[c.class] ?? ""}`);
  }

  if (s.concepts.length) {
    heading("VOCABULARY DEMAND — words nothing could route, most-wanted first");
    console.log("  ↳ = what the session called NEXT, and it found something. This is ADJACENCY, not");
    console.log("    proof of intent: the ledger cannot see whether the model kept trying or moved on.");
    console.log("    [strong] = continuity evidence — took the registry remedy, re-asked the same box,");
    console.log("    or narrowed a bare word to an id. Weigh a strong 1× over a bare 5×; verify by trial.");
    for (const c of s.concepts.slice(0, TOP)) {
      const routed = table.lookup(c.concept);
      const mark = routed ? `  → routed (${routed.provenance})` : "";
      console.log(`  ${pad(`"${c.concept}"`, 22)} ${rpad(c.count, 4)}× in ${c.sessions} session(s)  [${c.classes.join(",")}]${mark}`);
      for (const f of c.followups.slice(0, 3)) {
        const why = [
          f.strong ? `${f.strong} strong` : null,
          f.remedy ? `${f.remedy} took the registry remedy` : null,
          f.same_extent ? `${f.same_extent} same extent` : null,
        ].filter(Boolean).join(", ");
        console.log(`      ↳ then ${pad(f.followup, 34)} ${f.count}× (${f.found} found)`
          + `${why ? `  [${why}]` : "  [bare adjacency — no continuity evidence]"}`);
      }
    }
  }

  if (s.routes.length) {
    heading("ROUTES THAT FIRED — demand this layer has already absorbed");
    for (const r of s.routes.slice(0, TOP)) {
      console.log(`  ${pad(`"${r.concept}"`, 18)} ${rpad(r.count, 4)}× ${pad(`(${r.provenance})`, 14)} `
        + `${r.found} referent(s), ${r.empty} empty  ← asked as ${r.asked.map((a) => `"${a}"`).join(", ")}`);
    }
  }

  heading("TOP REFUSALS BY SHAPE — the ranking LOCATE_ROUTES.md's 'Still open' list was missing");
  for (const e of s.errors.slice(0, TOP)) {
    console.log(`  ${rpad(e.count, 4)}× [${pad(e.class, 11)}] ${e.shape}`);
  }

  heading("BY TOOL");
  console.log(`  ${s.tools.slice(0, TOP).map((t) => `${t.tool} ${t.count}`).join("   ")}`);

  const q = await ledger.readQueue();
  const queued = Object.values(q.concepts ?? {}).filter((c) => c.status === "queued");
  if (queued.length) {
    console.log(`\n${queued.length} concept(s) queued for authoring — \`routes-cli.mjs queue\`, then \`escalate\`.`);
  }
}

async function showRoutes() {
  const all = table.all().sort((a, b) => (a.concept < b.concept ? -1 : 1));
  console.log(`# route table — ${all.length} route(s), fingerprint ${table.fingerprint()}`);
  console.log(`  ${defaultRoutesRoot()}/table.json (seeds live in memory/routes.mjs and are not written here)\n`);
  const worlds = {};
  for (const f of (await readdir(join(defaultRoutesRoot(), "worlds")).catch(() => []))) {
    if (f.endsWith(".json")) {
      worlds[f.slice(0, -5)] = JSON.parse(await readFile(join(defaultRoutesRoot(), "worlds", f), "utf8")).legs ?? {};
    }
  }
  for (const r of all) {
    const trials = (r.trials ?? []).length;
    console.log(`${pad(r.concept, 16)} ${pad(`[${r.provenance}]`, 14)} ${r.legs.map((l) => l.what).join(" ∨ ")}`);
    if (r.aliases.length) console.log(`  ${pad("", 14)} aka ${r.aliases.join(", ")}`);
    console.log(`  ${pad("", 14)} ${trials} trial(s)${r.authored_by ? `, by ${r.authored_by}` : ""}`
      + `${r.source === "seed" ? ", seed (in code)" : ""}`);
    if (r.note) console.log(`  ${pad("", 14)} note: ${r.note}`);
    // A route that has quietly lost half its legs to a modpack is weaker, not broken — and the
    // difference is invisible unless it is printed.
    for (const [w, legs] of Object.entries(worlds)) {
      const dead = r.legs.filter((l) => legs[l.what] && legs[l.what].ok === false);
      if (dead.length) console.log(`  ${pad("", 14)} ⚠ world ${w.slice(0, 8)}: ${dead.length}/${r.legs.length} leg(s) unresolvable here (${dead.map((l) => l.what).join(", ")})`);
    }
  }
}

async function showQueue() {
  const q = await ledger.readQueue();
  const items = Object.values(q.concepts ?? {}).sort((a, b) => b.count - a.count);
  if (!items.length) { console.log("escalation queue is empty."); return; }
  console.log(`# escalation queue — ${items.length} concept(s)\n`);
  for (const c of items) {
    console.log(`${pad(`"${c.concept}"`, 22)} ${rpad(c.count, 4)}×  ${pad(c.status, 10)} first ${c.first?.slice(0, 10)} last ${c.last?.slice(0, 10)}`);
    for (const e of (c.examples ?? []).slice(0, 2)) {
      console.log(`    e.g. ${JSON.stringify(e.args)}`);
    }
  }
}

/**
 * The authoring brief. Written out rather than embedded in a spawn call so a human can read exactly
 * what an escalation agent is being asked to do — and so the same text serves a human doing it by
 * hand. The instructions are mostly PROHIBITIONS, because the failure mode of this job is an
 * enthusiastic agent inventing a definition and a trial that agree with each other.
 */
function authoringPrompt(concept, evidence = []) {
  return `You are authoring a locate ROUTE for the concept "${concept}" in the MCP Toolkit.

WHAT A ROUTE IS
A route maps a word an agent typed to a disjunction of predicates \`locate\` can really run. It is
stored UNAUTHORED — it may be used, but it can never prove a negative until a human promotes it.
Read mcp-toolkit/docs/memory/ROUTE_LEDGER_DESIGN.md §3-§6 before proposing anything.

THE EVIDENCE (why this concept is queued)
${evidence.length ? evidence.map((e) => `  - ${e.t?.slice(0, 19)} ${JSON.stringify(e.args)} → ${e.error}`).join("\n") : "  (none recorded)"}

YOUR JOB, IN ORDER
1. Find out what this world actually has. Use \`query_registry\` to look for block TAGS whose members
   are the family in question. Do not recall tag names from training — this world may be modded, and
   a route naming a tag that does not exist fails inside an answer instead of at parse time.
2. Decide the legs. At most ${MAX_LEGS}. A leg is a \`what\` string and NOTHING else: it may not set
   near/radius/y_range, because every leg must run against one extent or the composed negative is a
   claim about several different boxes wearing one sentence.
3. TEST IT, in a place where you already know the answer. Stage the blocks if you must
   (\`set_blocks\`), or go somewhere the family obviously exists. Then run each leg and check that it
   finds what you staged AND that it does not match things it should not.
4. Write down what the route DOES NOT mean. Every seed route carries a note like "a tree is its
   LOGS: leaves alone are not a tree". That sentence is the most valuable part of the record,
   because it is what a later reader needs in order to disagree with you.
5. Propose it:
   node memory/routes-cli.mjs propose --json '{"concept":"${concept}","aliases":[],"legs":[{"what":"#minecraft:…"}],"needles":["…"],"note":"…"}'
   then record your test:
   node memory/routes-cli.mjs trial ${concept} --near=X,Z --radius=64

REFUSE, AND SAY SO, IF:
  - the word names a PLACE ("the wheat farm", "my base") rather than a class of block — those are
    memory questions and the memory fallthrough already answers them correctly. A route would
    convert a good answer into a bad one.
  - the word is ambiguous in a way the legs cannot capture ("stuff", "resources", "danger").
  - you cannot test it. An untested route is a proposal, and this queue does not want proposals.
Say which of these applied and stop; an empty answer is a fine outcome here.`;
}

async function prompt() {
  const concept = normalizeConcept(positional[1]);
  if (!concept) throw new Error("usage: routes-cli.mjs prompt <concept>");
  const q = await ledger.readQueue();
  console.log(authoringPrompt(concept, q.concepts?.[concept]?.examples ?? []));
}

/**
 * Escalation. NEVER inline in a tool call: `locate` is a fast deterministic read, and blocking it on
 * an LLM round-trip would change its cost class invisibly to the caller. The miss returned
 * immediately and honestly; this runs afterwards, out of band, and the NEXT attempt hits the route.
 *
 * It PRINTS the prompt. There used to be a `--spawn` that handed each one to a headless companion
 * via `companion_spawn`; the toolkit archived its launcher in 0.143.0, so nothing in the game starts
 * an agent any more and the flag would name a tool no manifest carries. Paste the prompt into a
 * session of your own — the trial against the live world is still the requirement it always was.
 */
async function escalate() {
  const rows = await ledger.read();
  const s = summarize(rows);
  const q = await ledger.readQueue();
  const wanted = s.concepts
    .filter((c) => c.classes.includes("vocabulary"))
    .filter((c) => !table.lookup(c.concept))
    .filter((c) => (q.concepts?.[c.concept]?.status ?? "queued") === "queued")
    .slice(0, Number.parseInt(flags.top ?? "3", 10));
  if (!wanted.length) { console.log("nothing to escalate: every recorded concept is routed, rejected, or already proposed."); return; }

  for (const c of wanted) {
    console.log(`\n=== ${c.concept} (${c.count}× in ${c.sessions} session(s)) ===`);
    const evidence = (q.concepts?.[c.concept]?.examples ?? []);
    console.log(authoringPrompt(c.concept, evidence));
  }
}

async function propose() {
  const json = flags.json ?? (flags.file ? await readFile(flags.file, "utf8") : null);
  if (!json) throw new Error("usage: propose --json '{…}'  |  propose --file route.json");
  const route = JSON.parse(json);
  const errs = validateRoute(route);
  if (errs.length) { console.error(`invalid route:\n  ${errs.join("\n  ")}`); process.exitCode = 1; return; }
  const stored = await table.propose(route, { by: flags.by ?? "escalation-agent", source: "cli" });
  await ledger.setQueueStatus(route.concept, "proposed").catch(() => {});
  console.log(`proposed (UNAUTHORED — it will run, and it will refuse to prove a negative):`);
  console.log(JSON.stringify(stored, null, 2));
  console.log(`\nNext: trial it, then \`promote ${stored.concept}\`.`);
}

/** Run a route against the live world and record what happened. This is the evidence promotion asks
 *  for, and it is produced by the route ACTUALLY RUNNING, never by an assertion that it would. */
async function trial() {
  const concept = normalizeConcept(positional[1]);
  const route = table.lookup(concept);
  if (!route) throw new Error(`no route for '${concept}'`);
  const near = flags.near ? Object.fromEntries(["x", "z"].map((k, i) => [k, Number(String(flags.near).split(",")[i])])) : null;
  const args = { ...(near ? { near } : {}), radius: Number.parseInt(flags.radius ?? "64", 10) };
  const world = await bridge("get_world_info", {}).then((r) => r.result?.world_uuid).catch(() => null);
  const out = await runRoute(route, args, bridge, { world });
  if (!out) { console.error("every leg failed — nothing to record. Is the game running?"); process.exitCode = 1; return; }
  console.log(JSON.stringify(out.result.search, null, 2));
  console.log(`\nfound ${out.result.found.length} referent(s); matches_total ${out.result.matches_total}`);
  const rec = await table.recordTrial(concept, {
    t: new Date().toISOString(), world, dimension: out.result.dimension, center: out.result.center,
    found: out.result.found.length, matches_total: out.result.matches_total,
    negative_is_proof: out.result.search.negative_is_proof, by: flags.by ?? "cli-trial",
  });
  console.log(rec ? `trial recorded (${rec.trials.length} total)` : "seed route — trial not stored on the route (seeds are authored in code)");
}

async function promote() {
  const concept = positional[1];
  const r = await table.promote(concept, { by: flags.by ?? "human", force: !!flags.force });
  console.log(`'${r.concept}' is now AUTHORED — a clean miss over a fully-read extent is now absence of the concept.`);
  console.log(`  legs: ${r.legs.map((l) => l.what).join(" ∨ ")}`);
  if (flags.force) console.log("  (promoted with --force: no trial backs this.)");
}

async function reject() {
  const concept = positional[1];
  await table.reject(concept, flags.why ?? null).catch((e) => { throw e; });
  await ledger.setQueueStatus(concept, "rejected", flags.why ?? null).catch(() => {});
  console.log(`'${normalizeConcept(concept)}' removed, and marked rejected in the queue so it stops counting as demand.`);
}

/**
 * Backfill from archived bench transcripts. Two sources, because they see different failures:
 *
 *   transcript-*.jsonl — the ablation harness's own per-call log ({name, input, result, ms}). This
 *                        is the bridge-level view, the same one the live ledger records.
 *   sdk-*.jsonl        — the SDK message stream, which is the ONLY place a client-side
 *                        InputValidationError appears: the MCP client rejects those against the
 *                        schema and the shim never sees the call at all. A ledger built only from
 *                        the shim is structurally blind to them (4 in the archive).
 */
async function backfill() {
  const root = positional[1] ?? join(process.cwd(), "testbench-results");
  const dry = !!flags.dry;
  let files = 0;
  let recorded = 0;
  const byClass = new Map();

  // Backfilling twice would double every count in the overview, and the archive is immutable — so
  // re-running is a REPLACE, not an append. Live rows are kept: they are the thing being measured.
  if (!dry) {
    const existing = await ledger.read();
    const kept = existing.filter((r) => !String(r.source ?? "").startsWith("backfill"));
    if (kept.length !== existing.length) {
      await ledger.rewrite(kept);
      console.log(`(replaced ${existing.length - kept.length} earlier backfill row(s); ${kept.length} live row(s) kept)`);
    }
  }

  /** The bench "session": run dir / seed / arm. Without it the demand table's "in N sessions"
   *  column — which is how a real pattern is told from one confused run — reads 0 for the archive. */
  function sessionOf(p) {
    const parts = p.split(/[\\/]/);
    const seed = parts.findIndex((x) => /^seed\d+$/.test(x));
    const arm = parts[parts.length - 1].replace(/^(transcript|sdk)-/, "").replace(/\.jsonl$/, "");
    return seed > 0 ? `bench:${parts[seed - 1]}/${parts[seed]}/${arm}` : `bench:${arm}`;
  }

  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/^transcript-.*\.jsonl$/.test(e.name)) { files++; await fromTranscript(p); }
      else if (/^sdk-.*\.jsonl$/.test(e.name)) { files++; await fromSdk(p); }
    }
  }

  async function emit(row) {
    const cls = row.class;
    byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    recorded++;
    if (!dry) await ledger.append(row);
  }

  async function fromTranscript(path) {
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== "tool" || !j.name) continue;
      const r = j.result ?? {};
      if (r.ok === false || r.error) {
        await emit({
          t: j.t, kind: "miss", class: classifyError(r.error).class, tool: j.name,
          direction: directionOf(j.name, j.input),
          concept: conceptOf(j.name, j.input) ?? conceptFromError(r.error),
          args: compactArgs(j.input), error: String(r.error ?? "").slice(0, 400),
          source: "backfill", origin: path, session: sessionOf(path), ms: j.ms ?? null,
        });
      } else if (isSilentMiss(j.name, r.result)) {
        await emit({
          t: j.t, kind: "miss", class: "silent_miss", tool: j.name,
          direction: directionOf(j.name, j.input), concept: conceptOf(j.name, j.input),
          args: compactArgs(j.input), negative_is_proof: false,
          extent: r.result?.search?.extent ?? null, source: "backfill", origin: path,
          session: sessionOf(path),
        });
      }
    }
  }

  async function fromSdk(path) {
    const names = new Map();
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const blocks = j?.message?.content ?? j?.content ?? [];
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b.type === "tool_use") names.set(b.id, { name: b.name, input: b.input });
        if (b.type === "tool_result" && b.is_error) {
          const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join(" ") : String(b.content ?? "");
          // Only the calls the shim CANNOT see. Everything else is already in the transcript, and
          // recording it twice would double every count in the overview.
          if (!/InputValidationError|No such tool available/i.test(text)) continue;
          const call = names.get(b.tool_use_id) ?? {};
          const name = String(call.name ?? "?").replace(/^mcp__[a-z_]+__/, "");
          await emit({
            t: j.timestamp ?? null, kind: "miss", class: classifyError(text).class, tool: name,
            direction: directionOf(name, call.input),
            concept: conceptOf(name, call.input) ?? conceptFromError(text),
            args: compactArgs(call.input), error: text.slice(0, 400),
            source: "backfill-client", origin: path, session: sessionOf(path),
          });
        }
      }
    }
  }

  await stat(root).catch(() => { throw new Error(`no such directory: ${root}`); });
  await walk(root);
  console.log(`${dry ? "[dry run] " : ""}${files} file(s) scanned, ${recorded} record(s)${dry ? " would be" : ""} appended`);
  for (const [k, v] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(k, 13)} ${v}`);
  }
  if (!dry) console.log(`\nledger: ${defaultRoutesRoot()}/ledger.jsonl — now run \`routes-cli.mjs overview\``);
}

// --- dispatch ---------------------------------------------------------------------------------------

const COMMANDS = { overview, routes: showRoutes, queue: showQueue, backfill, prompt, escalate, propose, trial, promote, reject };

try {
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`unknown command '${cmd}'. Known: ${Object.keys(COMMANDS).join(", ")}`);
    process.exit(2);
  }
  await fn();
} catch (e) {
  console.error(`${cmd}: ${e.message}`);
  process.exit(1);
}
