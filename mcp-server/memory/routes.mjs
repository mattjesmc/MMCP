// The route table — `locate`'s concept vocabulary (ROUTE_LEDGER_DESIGN.md §3).
//
// A ROUTE maps a word an agent actually types ("tree", "wood", "ore") to a DISJUNCTION of locate
// predicates it can really run ("#minecraft:logs", "#minecraft:planks", the eight ore tags). It
// exists because `locate what:` resolves against the registries and nothing else: a concept that is
// not a structure/POI/entity/biome/block id dead-ends, and under the `standard` profile a question
// locate cannot route is a question the session cannot ask (LOCATE_ROUTES.md §intro).
//
// Three things make this a route table and not a synonym dictionary:
//
//  1. DISJUNCTION IS THE CAPABILITY. Pattern nodes take exactly one matcher — no `or`, no `not`
//     (LOCATE_ROUTES B2) — and PATTERN_SEARCH §B1 records that N separate scans cannot compose one
//     honest negative. A route EXECUTOR owns all its legs, so it can (route-exec.mjs). "wood" is not
//     expressible as one locate call at all; through a route it is one call with a composed negative.
//  2. PROVENANCE DECIDES WHETHER THE NEGATIVE IS PROVABLE. An `unauthored` route is a guess about
//     what the word means, so "no tree within 64" is unprovable no matter how completely the extent
//     was read — the extent was fine, the DEFINITION was invented. Same rule as a pattern inheriting
//     its result set's honesty (PATTERN_SEARCH §Sets), applied to vocabulary.
//  3. NO FUZZY MATCHING. Lookup is exact, over the concept plus declared aliases plus the
//     singular/plural pair. Answering a nearby question is precisely the confident-wrong class the
//     whole locate design fights; a near-miss must stay a miss and go to the ledger instead.
//
// Storage. Concept→predicate is GLOBAL (a tree is a tree in every save) and lives at the memory
// ROOT beside last_world.json, not in a per-world dir. Predicate→ids is per-world (a modpack has
// other logs), and rides `worlds/<uuid>.json` as a leg-resolution cache. Seed routes live in CODE
// (below) so upgrading the package upgrades them; the file holds only what sessions and humans add.

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Route legs per concept. Each leg is one bounded scan, so this is a real cost bound, not taste.
 *  Eight because vanilla has exactly eight ore tags and no umbrella `#minecraft:ores`
 *  (verified against vanilla-src BlockItemTags 26.2) — the motivating concept sets the cap. */
export const MAX_LEGS = 8;

/**
 * MCPTK_ROUTES — what this session does with the route layer.
 *   off     — nothing: no ledger, no routing. The pre-feature behaviour, byte for byte.
 *   record  — ledger only. Failures are recorded; no call is answered differently. This is the
 *             mode a first rollout should sit in, and the mode that produces the overview.
 *   frozen  — ledger + AUTHORED routes. No unauthored route fires, the escalation queue does not
 *             grow. The bench pin (testbench/agent.mjs): a bench whose vocabulary widens between
 *             runs is a non-stationary instrument, and `tools_hash` cannot see it because the
 *             manifest never changes.
 *   learn   — everything: unauthored routes fire (poisoning their own negatives) and unrouted
 *             concepts accumulate in the escalation queue.
 *
 * Read at CALL time, never captured at module load. ESM evaluates every static import before the
 * importing module's own body, so a constant here could not be overridden by a shim that wanted to
 * set its default in code (ablation/mcp-shim.mjs does exactly that, to keep unflagged bench arms
 * byte-identical to every prior run). It also lets a probe change modes between tests.
 */
const MODES = ["off", "record", "frozen", "learn"];

export function routesMode() {
  const m = (process.env.MCPTK_ROUTES ?? "learn").trim();
  if (!MODES.includes(m)) {
    throw new Error(`unknown MCPTK_ROUTES "${m}" (known: ${MODES.join(", ")})`);
  }
  return m;
}

/** Failures are written to the ledger. */
export const routesRecording = () => routesMode() !== "off";
/** A concept miss may be answered by running a route. */
export const routesRouting = () => ["frozen", "learn"].includes(routesMode());
/** Unauthored routes may fire, and the escalation queue may grow. */
export const routesLearning = () => routesMode() === "learn";

/** Same root as the memory store, resolved the same way — but read at CALL time, not module load,
 *  so a test can point MCPTK_MEMORY_DIR at a temp dir after import. */
export function defaultRoutesRoot() {
  const root = process.env.MCPTK_MEMORY_DIR
    || join(dirname(fileURLToPath(import.meta.url)), "..", "memory-data");
  return join(root, "routes");
}

// --- concept normalization -------------------------------------------------------------------

/**
 * The key a concept is looked up under. Deliberately conservative: case, surrounding whitespace,
 * internal whitespace runs, a leading `#`, a `minecraft:`/modid prefix and trailing punctuation are
 * all noise an agent adds without meaning anything by it. Underscores become spaces so
 * `oak_tree` and `oak tree` are one key. Nothing else is touched — no stemming, no edit distance.
 */
export function normalizeConcept(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/^#/, "")
    .replace(/^[a-z0-9_.-]+:/, "")
    .replace(/[?!.,;]+$/, "")
    .replace(/[_\s]+/g, " ")
    .trim();
}

/** The English plural pair, the ONE inflection allowed. Agents type "logs" and "log" interchangeably
 *  and Minecraft's own tags are plural (`#minecraft:logs`), so this is the language's convention
 *  showing up in the data, not a guess about meaning. */
export function conceptForms(raw) {
  const c = normalizeConcept(raw);
  const forms = new Set([c]);
  if (!c) return [];
  if (c.endsWith("ies")) forms.add(`${c.slice(0, -3)}y`);
  else if (c.endsWith("ves")) forms.add(`${c.slice(0, -3)}f`);
  else if (c.endsWith("es") && c.length > 3) forms.add(c.slice(0, -2));
  if (c.endsWith("s") && c.length > 2) forms.add(c.slice(0, -1));
  if (c.endsWith("y") && c.length > 2) forms.add(`${c.slice(0, -1)}ies`);
  if (c.endsWith("f") && c.length > 2) forms.add(`${c.slice(0, -1)}ves`);
  if (!c.endsWith("s")) forms.add(`${c}s`);
  forms.delete("");
  return [...forms];
}

// --- the authored seed table -----------------------------------------------------------------

/**
 * Seed routes: hand-authored, every tag verified against decompiled 26.2
 * (`vanilla-src/net/minecraft/tags/BlockItemTags.java`) rather than remembered — a seed route
 * naming a tag that does not exist is exactly the confident-wrong this layer is supposed to prevent,
 * and it would fail INSIDE an answer rather than at parse time.
 *
 * `needles` is the belief-store half: legal-locate (survival) cannot resolve a tag, because it has
 * no registry — it matches recorded block ids as substrings. So each route also states the substrings
 * its family's ids contain. One vocabulary, two consumers.
 *
 * The list is short on purpose. Every entry is a claim that this word means this predicate, and the
 * ledger — not intuition — is what should decide the next ten (ROUTE_LEDGER_DESIGN §7).
 */
export const SEED_ROUTES = [
  {
    concept: "tree",
    aliases: ["trees", "wood block", "timber"],
    legs: [{ what: "#minecraft:logs" }],
    needles: ["log"],
    note: "a tree is its LOGS: leaves alone are not a tree, and a leaf hit would send a body to a "
      + "canopy it cannot reach. Standing vs felled is not distinguished.",
  },
  {
    concept: "wood",
    aliases: ["woods", "lumber"],
    legs: [{ what: "#minecraft:logs" }, { what: "#minecraft:planks" }],
    needles: ["log", "plank"],
    note: "logs OR planks — the word covers the raw and the crafted form, and which one the caller "
      + "meant is not knowable from the word. Two legs, one composed negative.",
  },
  {
    concept: "log",
    aliases: ["logs"],
    legs: [{ what: "#minecraft:logs" }],
    needles: ["log"],
    note: "the tag exists; this route only spares the caller the `#minecraft:` spelling.",
  },
  {
    concept: "leaves",
    aliases: ["leaf", "foliage"],
    legs: [{ what: "#minecraft:leaves" }],
    needles: ["leaves"],
  },
  {
    concept: "ore",
    aliases: ["ores"],
    // Vanilla has no umbrella ore tag — eight family tags and nothing above them. This is the
    // concept that sets MAX_LEGS, and the clearest case for the whole disjunction mechanism: eight
    // separate `locate` calls could each report a clean miss and still not add up to "no ore here".
    legs: [
      { what: "#minecraft:coal_ores" }, { what: "#minecraft:iron_ores" },
      { what: "#minecraft:copper_ores" }, { what: "#minecraft:gold_ores" },
      { what: "#minecraft:redstone_ores" }, { what: "#minecraft:lapis_ores" },
      { what: "#minecraft:emerald_ores" }, { what: "#minecraft:diamond_ores" },
    ],
    needles: ["_ore", "ancient_debris"],
    note: "the eight vanilla ore families. Ancient debris is a needle for the remembered half but "
      + "has no ore tag, so an authoritative scan will not report it — ask for it by id.",
  },
  {
    concept: "plank",
    aliases: ["planks", "planking"],
    legs: [{ what: "#minecraft:planks" }],
    needles: ["plank"],
  },
  {
    concept: "bed",
    aliases: ["beds"],
    legs: [{ what: "#minecraft:beds" }],
    needles: ["bed"],
    note: "the BLOCK. For 'is a bed free for another villager' the POI route answers instead: "
      + "locate what:poi:minecraft:home occupancy:free.",
  },
  {
    concept: "door",
    aliases: ["doors", "doorway"],
    legs: [{ what: "#minecraft:doors" }],
    needles: ["door"],
  },
  {
    concept: "crop",
    aliases: ["crops", "farm crop"],
    legs: [{ what: "#minecraft:crops" }],
    needles: ["wheat", "carrot", "potato", "beetroot", "torchflower", "pitcher"],
    note: "the planted crop BLOCKS. 'a farm' is a place, not a block family — that is a memory "
      + "question and falls through to the remembered store, correctly.",
  },
  {
    concept: "flower",
    aliases: ["flowers"],
    legs: [{ what: "#minecraft:flowers" }],
    needles: ["flower", "tulip", "orchid", "allium", "daisy", "rose", "lilac", "peony"],
  },
  {
    concept: "sapling",
    aliases: ["saplings"],
    legs: [{ what: "#minecraft:saplings" }],
    needles: ["sapling"],
  },
  {
    concept: "wool",
    aliases: ["wools"],
    legs: [{ what: "#minecraft:wool" }],
    needles: ["wool"],
  },
];

// --- validation ------------------------------------------------------------------------------

/** A leg is a locate argument fragment. Only `what` is allowed to vary per leg: a leg that could
 *  move the centre or the radius would make the composed negative a claim about several different
 *  extents wearing one sentence. */
export function validateRoute(route) {
  const errs = [];
  const concept = normalizeConcept(route?.concept);
  if (!concept) errs.push("concept is empty");
  if (!Array.isArray(route?.legs) || route.legs.length === 0) errs.push("legs must be a non-empty array");
  else if (route.legs.length > MAX_LEGS) errs.push(`too many legs (${route.legs.length} > ${MAX_LEGS})`);
  else {
    route.legs.forEach((leg, i) => {
      if (!leg || typeof leg !== "object") { errs.push(`legs[${i}] must be an object`); return; }
      const keys = Object.keys(leg);
      if (!leg.what || typeof leg.what !== "string") errs.push(`legs[${i}] needs a string \`what\``);
      const extra = keys.filter((k) => k !== "what");
      if (extra.length) errs.push(`legs[${i}] may only carry \`what\` (got ${extra.join(", ")}) — a leg that changed the extent would make the composed negative a claim about several boxes`);
    });
    const seen = new Set();
    for (const leg of route.legs) {
      if (leg?.what && seen.has(leg.what)) errs.push(`duplicate leg \`${leg.what}\` — it would be scanned and counted twice`);
      seen.add(leg?.what);
    }
  }
  if (route?.provenance && !["authored", "unauthored"].includes(route.provenance)) {
    errs.push(`provenance must be authored|unauthored (got ${route.provenance})`);
  }
  if (route?.aliases && !Array.isArray(route.aliases)) errs.push("aliases must be an array");
  if (route?.needles && !Array.isArray(route.needles)) errs.push("needles must be an array");
  return errs;
}

function normalizeRoute(route, provenance) {
  return {
    concept: normalizeConcept(route.concept),
    aliases: (route.aliases ?? []).map(normalizeConcept).filter(Boolean),
    legs: route.legs.map((l) => ({ what: l.what })),
    needles: route.needles ?? [],
    note: route.note ?? null,
    provenance: route.provenance ?? provenance,
    authored_by: route.authored_by ?? null,
    created: route.created ?? new Date().toISOString(),
    promoted: route.promoted ?? null,
    // A trial is the agent's evidence that the route finds the thing where the thing is known to
    // be. It is what separates a proposal from a route (ROUTE_LEDGER_DESIGN §6).
    trials: route.trials ?? [],
    source: route.source ?? null,
    hits: route.hits ?? 0,
    last_used: route.last_used ?? null,
  };
}

// --- the table -------------------------------------------------------------------------------

/**
 * Cross-process discipline, deliberately lighter than MemoryStore's. Mutations are rare (a human
 * promoting a route, an escalation agent proposing one) and always rewrite one small JSON file, so
 * a mkdir-based advisory lock with a short fuse is enough. Reads never lock: a torn read is
 * impossible because writes are tmp+rename, and a slightly stale table costs one un-routed call.
 */
const LOCK_WAIT_MS = 2000;
const LOCK_SPIN_MS = 25;
const STALE_LOCK_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

export class RouteTable {
  constructor(root = defaultRoutesRoot()) {
    this.dir = root;
    this.file = join(root, "table.json");
    this.lockDir = join(root, ".lock");
    /** concept key → route. Seeds first, then the file (the file wins, so a human can override a seed). */
    this.byKey = new Map();
    this.loaded = false;
    this.fileRoutes = [];
  }

  async #lock() {
    // The lock dir's PARENT has to exist first. Missing this meant the very first write to a fresh
    // memory root — the `propose` that creates the table — failed with a bare ENOENT on `.lock`,
    // which reads as a locking problem and is actually a first-run problem.
    await mkdir(this.dir, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(this.lockDir);
        return;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const age = await stat(this.lockDir).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
        if (age > STALE_LOCK_MS) { await rm(this.lockDir, { recursive: true, force: true }); continue; }
        if (Date.now() > deadline) throw new Error("route table is locked by another process");
        await sleep(LOCK_SPIN_MS);
      }
    }
  }

  async #unlock() {
    await rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
  }

  /** Rebuild the lookup map from seeds + file routes. Public so the sync fingerprint path can share
   *  one definition of precedence instead of re-deriving it. */
  reindex() {
    this.byKey = new Map();
    const add = (route) => {
      for (const key of [route.concept, ...route.aliases]) {
        if (key) this.byKey.set(key, route);
      }
    };
    for (const seed of SEED_ROUTES) add(normalizeRoute({ ...seed, source: "seed" }, "authored"));
    for (const r of this.fileRoutes) add(normalizeRoute(r, r.provenance ?? "unauthored"));
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      this.fileRoutes = Array.isArray(raw?.routes) ? raw.routes : [];
    } catch (e) {
      if (e.code !== "ENOENT") {
        // A corrupt table must not silently become an empty one: routing off is fine, routing off
        // while claiming to be on is not. Seeds still serve, and the reason is loud.
        process.stderr.write(`[routes] table.json unreadable (${e.message}) — seeds only\n`);
      }
      this.fileRoutes = [];
    }
    this.reindex();
    this.loaded = true;
    return this;
  }

  /**
   * Exact lookup over concept, aliases and the plural pair. Returns null for anything else — the
   * miss is the product here as much as the hit, because it is what the ledger records and what the
   * escalation queue is built from.
   */
  lookup(raw) {
    if (!this.loaded) throw new Error("RouteTable.lookup before load()");
    for (const form of conceptForms(raw)) {
      const hit = this.byKey.get(form);
      if (hit) return hit;
    }
    return null;
  }

  /** Every distinct route, seeds included. */
  all() {
    return [...new Set(this.byKey.values())];
  }

  /** The routes this session is allowed to FIRE, given the mode. `frozen` withholds unauthored ones. */
  active() {
    return this.all().filter((r) => routesMode() === "learn" || r.provenance === "authored");
  }

  /**
   * The belief-store half: substrings that recorded block ids of this family contain. Falls back to
   * the concept itself so an unrouted word still behaves exactly as it did before this module
   * existed (legal-locate.mjs owns that fallback's generic de-pluralizer).
   */
  needlesFor(raw) {
    const route = this.lookup(raw);
    if (!route) return null;
    const needles = route.needles?.length ? [...route.needles] : [route.concept];
    return { route, needles: needles.map((n) => String(n).toLowerCase()) };
  }

  async #save() {
    await mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(this.file, {
      version: 1,
      updated: new Date().toISOString(),
      routes: this.fileRoutes,
    });
    this.reindex();
  }

  /** Store a candidate route. Always lands `unauthored` — promotion is a separate, human act. */
  async propose(route, { by = "escalation-agent", source = null } = {}) {
    const errs = validateRoute(route);
    if (errs.length) throw new Error(`invalid route: ${errs.join("; ")}`);
    const concept = normalizeConcept(route.concept);
    await this.#lock();
    try {
      await this.load();
      this.fileRoutes = this.fileRoutes.filter((r) => normalizeConcept(r.concept) !== concept);
      this.fileRoutes.push(normalizeRoute(
        { ...route, provenance: "unauthored", authored_by: by, source, promoted: null }, "unauthored",
      ));
      await this.#save();
    } finally {
      await this.#unlock();
    }
    return this.lookup(concept);
  }

  /**
   * Promote a candidate to authored — the act that lets its negatives become provable. Refused
   * without a trial: "someone thought this was right" is exactly the provenance an authored route
   * must not have, and the trial is the only machine-checkable part of the review.
   */
  async promote(concept, { by = "human", force = false } = {}) {
    const key = normalizeConcept(concept);
    await this.#lock();
    try {
      await this.load();
      const idx = this.fileRoutes.findIndex((r) => normalizeConcept(r.concept) === key);
      if (idx < 0) throw new Error(`no proposed route for '${key}' (seed routes are authored already)`);
      const r = this.fileRoutes[idx];
      if (!force && !(r.trials?.length)) {
        throw new Error(`route '${key}' has no trial — it has never been run against a world where `
          + `the answer was known, so promoting it would make an untested guess able to prove a `
          + `negative. Run it and record the trial, or promote --force and own that.`);
      }
      this.fileRoutes[idx] = { ...r, provenance: "authored", authored_by: by, promoted: new Date().toISOString() };
      await this.#save();
    } finally {
      await this.#unlock();
    }
    return this.lookup(key);
  }

  async reject(concept, why = null) {
    const key = normalizeConcept(concept);
    await this.#lock();
    try {
      await this.load();
      const before = this.fileRoutes.length;
      this.fileRoutes = this.fileRoutes.filter((r) => normalizeConcept(r.concept) !== key);
      if (this.fileRoutes.length === before) throw new Error(`no stored route for '${key}'`);
      await this.#save();
      if (why) process.stderr.write(`[routes] rejected '${key}': ${why}\n`);
    } finally {
      await this.#unlock();
    }
  }

  /** Record that a route was run: where, when, what it found. This IS the trial evidence. */
  async recordTrial(concept, trial) {
    const key = normalizeConcept(concept);
    await this.#lock();
    try {
      await this.load();
      const idx = this.fileRoutes.findIndex((r) => normalizeConcept(r.concept) === key);
      if (idx < 0) return null; // a seed route's trials live in the ledger, not in a file we own
      const r = this.fileRoutes[idx];
      this.fileRoutes[idx] = { ...r, trials: [...(r.trials ?? []), trial].slice(-8) };
      await this.#save();
      return this.lookup(key);
    } finally {
      await this.#unlock();
    }
  }

  /**
   * Per-world leg resolution. Concept→predicate is global; predicate→ids is not, and a modpack (or
   * a datapack that removes a tag) can leave a leg naming nothing. Cached per world uuid so the
   * check costs one bridge call the first time and nothing after.
   */
  async worldLegs(worldUuid) {
    if (!worldUuid) return {};
    try {
      return JSON.parse(await readFile(join(this.dir, "worlds", `${worldUuid}.json`), "utf8")).legs ?? {};
    } catch {
      return {};
    }
  }

  async noteWorldLeg(worldUuid, what, ok, detail = null) {
    if (!worldUuid) return;
    await this.#lock();
    try {
      const dir = join(this.dir, "worlds");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${worldUuid}.json`);
      let doc = { world: worldUuid, legs: {} };
      try { doc = JSON.parse(await readFile(path, "utf8")); } catch { /* first write */ }
      doc.legs ??= {};
      doc.legs[what] = { ok, detail, checked: new Date().toISOString() };
      await writeJsonAtomic(path, doc);
    } finally {
      await this.#unlock();
    }
  }

  /**
   * What the ACTIVE vocabulary is, as one short string. The bench needs this: routes change what a
   * session can answer while leaving the manifest — and therefore `tools_hash` — untouched, so
   * pooling rows from two runs whose tables differ silently mixes two instruments
   * (testbench/resume.mjs's drift guard is the mechanism; `routes_hash` is the field).
   */
  fingerprint() {
    const active = this.active()
      .map((r) => [r.concept, r.provenance, r.legs.map((l) => l.what).join("|")])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const sha = createHash("sha256").update(JSON.stringify(active)).digest("hex").slice(0, 12);
    return `${routesMode()}:${active.length}:${sha}`;
  }
}

// --- process singleton -------------------------------------------------------------------------

let singleton = null;

/** The shim's table. Loaded once; a failure degrades to "no routes", never to a thrown tool call. */
export async function getRouteTable() {
  if (!singleton) {
    singleton = new RouteTable();
    await singleton.load().catch((e) => {
      process.stderr.write(`[routes] table unavailable (${e.message}) — routing disabled this session\n`);
      singleton.loaded = true;
      singleton.fileRoutes = [];
    });
  }
  return singleton;
}

/** Sync fingerprint for manifest stamping (bench runners). Reads the file synchronously and never
 *  throws: a missing table is a real, reportable state ("seeds only"), not an error. */
export function routesFingerprintSync() {
  try {
    const t = new RouteTable();
    try {
      t.fileRoutes = JSON.parse(readFileSync(t.file, "utf8")).routes ?? [];
    } catch { t.fileRoutes = []; }
    t.loaded = true;
    t.byKey = new Map();
    const add = (route) => { for (const k of [route.concept, ...route.aliases]) if (k) t.byKey.set(k, route); };
    for (const seed of SEED_ROUTES) add(normalizeRoute({ ...seed, source: "seed" }, "authored"));
    for (const r of t.fileRoutes) add(normalizeRoute(r, r.provenance ?? "unauthored"));
    return t.fingerprint();
  } catch {
    return `${routesMode()}:unknown`;
  }
}

/** Async fingerprint — the form ESM callers should use. */
export async function routesFingerprint() {
  const t = await getRouteTable();
  return t.fingerprint();
}

/** Directory listing helper for the CLI (kept here so the on-disk layout has one owner). */
export async function routeFiles(root = defaultRoutesRoot()) {
  const out = { root, table: join(root, "table.json"), ledger: join(root, "ledger.jsonl"), queue: join(root, "queue.json"), worlds: [] };
  try {
    out.worlds = (await readdir(join(root, "worlds"))).filter((f) => f.endsWith(".json"));
  } catch { /* none yet */ }
  return out;
}
