// The route executor — running a concept as a disjunction of real searches
// (ROUTE_LEDGER_DESIGN.md §4).
//
// This is the half that is a CAPABILITY and not a convenience. A pattern node takes exactly one
// matcher; there is no `or` and no `not` (LOCATE_ROUTES B2), and PATTERN_SEARCH §B1 records the
// consequence: "N separate scans cannot compose one honest negative". A model asking for wood can
// scan for logs, get a clean miss, scan for planks, get a clean miss — and own two true statements
// that it is not entitled to add together, because nothing tracked whether the two extents were the
// same box, whether either tripped a cap, or whether a leg failed to run at all.
//
// The executor owns every leg of one concept, so it can add them up: it holds the extent fixed
// (legs may vary ONLY `what` — routes.mjs enforces that), runs them against the same centre, and
// composes `negative_is_proof` as the conjunction of the legs' own verdicts. That is the same
// recursive composition a pattern already performs over its result sets (PATTERN_SEARCH §Honesty),
// one level up.
//
// Three honesty rules, and they are the whole design:
//
//  1. THE INTERPRETATION IS DISCLOSED. The caller asked for a tree and is being shown logs. If the
//     payload does not say so, the next restatement launders it — which is the 0.6.0 succeeds-falsely
//     class arriving through a new door. `search.route` states the concept, the legs, the provenance
//     and the route's own caveat, beside `search.promoted`, which already does this job for the
//     block-id promotion.
//  2. AN UNAUTHORED ROUTE CANNOT PROVE A NEGATIVE. Not because the scan was worse — it may have read
//     every chunk — but because the DEFINITION was guessed. "No tree within 64" is a claim about
//     what a tree is as much as about the box.
//  3. A ROUTE ONLY FIRES IN THE DEAD-END SLOT. If `what` resolved against any registry, no route
//     runs: routing over a working answer would be the tool answering a different question than the
//     one it was asked, silently, on the model's most common call.

import { getLedger } from "./route-ledger.mjs";
import { getRouteTable, routesMode, routesRouting } from "./routes.mjs";

/** Referents reported when the caller says nothing. Matches locate's own default. */
const DEFAULT_LIMIT = 3;

/** Distance from the search centre, for the merge ranking. 3D when the centre's y is real, which
 *  is exactly the rule locate itself applies (LOCATE_ROUTES C1 / 0.29.0): ranking in 3D off an
 *  ASSUMED sea-level y invents a vertical component and reorders the answer around it. */
function rankOf(referent, center, yIsReal) {
  const p = referent?.pos;
  if (!p || !center) {
    // Fall back to the bearing block the mod already computed against the observer.
    const rel = (referent?.relations ?? []).find((r) => r.to === "you");
    return rel?.map_distance ?? Number.POSITIVE_INFINITY;
  }
  const dx = p.x - center.x;
  const dz = p.z - center.z;
  const dy = yIsReal && Number.isFinite(center.y) ? p.y - center.y : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function keyOf(referent) {
  const p = referent?.pos;
  return p ? `${p.x},${p.y},${p.z}` : (referent?.handle ?? JSON.stringify(referent));
}

/**
 * Run a route.
 *
 * @param route     from RouteTable.lookup
 * @param callerArgs the ORIGINAL locate arguments — the caller's extent is authoritative and is
 *                   passed through untouched; only `what` is replaced, per leg.
 * @param callBridge (tool, args) => {ok, result|error}
 * @returns {ok:true, result} — always a success envelope when at least one leg ran; null when the
 *          route could not be run at all, so the caller falls through to the behaviour that existed
 *          before this module (the memory concept search).
 */
export async function runRoute(route, callerArgs, callBridge, ctx = {}) {
  const t0 = Date.now();
  const base = { ...(callerArgs ?? {}) };
  delete base.what;
  // `as` names ONE result set from ONE anchor node. There is no union-of-sets in the mod, so a
  // multi-leg route cannot honour it — and quietly storing the last leg's set under the caller's
  // name would hand back a set that is a fraction of what was asked for, which then poisons every
  // refinement chained onto it. Dropped, loudly, and only when it cannot be kept.
  let asDropped = null;
  if (base.as && route.legs.length > 1) {
    asDropped = base.as;
    delete base.as;
  }
  const limit = Number.isInteger(base.limit) ? base.limit : DEFAULT_LIMIT;

  const legs = await Promise.all(route.legs.map(async (leg) => {
    const t = Date.now();
    try {
      const r = await callBridge("locate", { ...base, what: leg.what, limit });
      return { what: leg.what, ok: !!r?.ok, result: r?.result ?? null, error: r?.error ?? null, ms: Date.now() - t };
    } catch (e) {
      return { what: leg.what, ok: false, result: null, error: e.message, ms: Date.now() - t };
    }
  }));

  const ran = legs.filter((l) => l.ok && l.result);
  const failed = legs.filter((l) => !l.ok);

  // Every leg failed: this route cannot answer here. Say nothing and let the caller fall through —
  // an executor that manufactured an empty result would report "no trees" from a search that never
  // happened, which is the worst answer available.
  if (!ran.length) {
    await noteLegFailures(route, failed, ctx);
    return null;
  }
  await noteLegFailures(route, failed, ctx);

  const first = ran[0].result;
  const center = first.center ?? null;
  // The mod tells us whether the centre's y is a measurement or a sea-level fill, in `source`.
  const yIsReal = typeof first.source === "string" && !/assumed/i.test(first.source);

  const merged = new Map();
  let matchesTotal = 0;
  let anyTotalUnknown = false;
  for (const leg of ran) {
    const r = leg.result;
    for (const f of (r.found ?? [])) {
      const k = keyOf(f);
      if (!merged.has(k)) merged.set(k, { ...f, matched_leg: leg.what });
    }
    if (typeof r.matches_total === "number") matchesTotal += r.matches_total;
    else anyTotalUnknown = true;
  }

  const ranked = [...merged.values()]
    .sort((a, b) => rankOf(a, center, yIsReal) - rankOf(b, center, yIsReal))
    .slice(0, limit);

  // The composed negative. Every clause is a different way the answer can be less than it looks,
  // and each one names itself so a remembered miss keeps its cause (ARCHITECTURE §locate: negatives
  // are what lie when restated later).
  const causes = [];
  if (failed.length) causes.push(`${failed.length} of ${legs.length} legs did not run (${failed.map((l) => l.what).join(", ")})`);
  const legProofs = ran.map((l) => l.result?.search?.negative_is_proof === true);
  if (legProofs.some((p) => !p)) {
    const weak = ran.filter((l) => l.result?.search?.negative_is_proof !== true);
    causes.push(`${weak.length} leg(s) could not prove their own negative (${weak.map((l) => l.what).join(", ")})`);
  }
  if (route.provenance !== "authored") {
    causes.push(`the route for "${route.concept}" is UNAUTHORED — its legs are a guess at what the `
      + `word means, so absence of the legs is not absence of the concept`);
  }
  const negativeIsProof = causes.length === 0;

  const legSummaries = ran.map((l) => ({
    what: l.what,
    found: (l.result.found ?? []).length,
    matches_total: l.result.matches_total ?? null,
    negative_is_proof: l.result.search?.negative_is_proof ?? null,
    extent: l.result.search?.extent ?? null,
    ms: l.ms,
  }));
  for (const l of failed) legSummaries.push({ what: l.what, error: l.error, ms: l.ms });

  const notes = [];
  if (route.note) notes.push(route.note);
  if (asDropped) {
    notes.push(`\`as:"${asDropped}"\` was NOT stored: this route has ${route.legs.length} legs and a `
      + `result set holds one anchor node's cells, so the set would have been a fraction of the `
      + `answer. Re-run one leg by name (\`what:"${route.legs[0].what}"\`) to store a set.`);
  }
  if (ran.length > 1 && matchesTotal) {
    notes.push("matches_total is the SUM over legs; a block belonging to two of this route's "
      + "families would be counted twice there (the reported referents are de-duplicated by cell).");
  }
  if (causes.length) notes.push(`negative_is_proof is false: ${causes.join("; ")}.`);

  const result = {
    perception_mode: first.perception_mode,
    game_tick: first.game_tick,
    dimension: first.dimension,
    source: first.source,
    center,
    what: route.concept,
    found: ranked,
    matches_total: anyTotalUnknown ? null : matchesTotal,
    mechanism: "observe",
    search: {
      mechanism: "route",
      what: `route[${route.concept}] → ${route.legs.map((l) => l.what).join(" ∨ ")}`,
      // The caller's extent, reported once: every leg ran against it, which is what makes the
      // conjunction below legitimate.
      extent: first.search?.extent ?? null,
      radius: first.search?.radius ?? null,
      vertical_extent: first.search?.vertical_extent ?? null,
      center,
      tick: first.search?.tick ?? null,
      ms: Date.now() - t0,
      found: ranked.length,
      negative_is_proof: negativeIsProof,
      // The disclosure. Read this beside `search.promoted`: same job, one level up — the tool is
      // telling the caller which question it actually answered.
      route: {
        concept: route.concept,
        asked: String(callerArgs?.what ?? route.concept),
        legs: route.legs.map((l) => l.what),
        provenance: route.provenance,
        authored_by: route.authored_by,
        trials: (route.trials ?? []).length,
        mode: routesMode(),
        caveat: route.provenance === "authored"
          ? "an authored route: a human accepted this definition, and a clean miss over a fully-read extent IS absence of the concept"
          : "an UNAUTHORED route: the definition was proposed, not accepted — treat a miss as 'these legs found nothing', never as 'there is none'",
      },
      legs: legSummaries,
      note: notes.length ? notes.join(" ") : null,
    },
  };

  await recordTrial(route, result, ctx).catch(() => {});
  return { ok: true, result };
}

/**
 * A leg that names a tag this world does not have is not a bug in the route — it is a modpack, a
 * datapack, or a version. Cached per world so the check costs one call ever, and surfaced in the
 * CLI so a route that has quietly lost half its legs is visible rather than merely weaker.
 */
async function noteLegFailures(route, failed, ctx) {
  if (!failed.length || !ctx.world) return;
  try {
    const table = await getRouteTable();
    for (const l of failed) {
      const unresolved = /^unknown (tag|target|structure|biome|entity)/i.test(String(l.error ?? ""));
      await table.noteWorldLeg(ctx.world, l.what, !unresolved, l.error ?? null);
    }
  } catch { /* the cache is an optimisation; losing it costs one repeated call */ }
}

/** A trial is what separates a proposal from a route: it ran, here, and this is what it found.
 *  Recorded for stored routes (seeds are authored in code and carry their evidence in the ledger). */
async function recordTrial(route, result, ctx) {
  if (route.source === "seed") return;
  const table = await getRouteTable();
  await table.recordTrial(route.concept, {
    t: new Date().toISOString(),
    world: ctx.world ?? null,
    dimension: result.dimension ?? null,
    center: result.center ?? null,
    found: result.found.length,
    matches_total: result.matches_total,
    negative_is_proof: result.search.negative_is_proof,
    by: "use",
  });
}

/**
 * The entry point index.mjs calls, in the slot the unresolvable-`what` fallthrough already owns.
 *
 * Ordering matters and is deliberate: ROUTE first, MEMORY second. A route answers "where is a
 * tree" with a live search of the world; the memory fallthrough answers "where is the wheat farm"
 * from what has been written down. The first is a class of block, the second is a place — and a
 * place has no route, which is why the fallthrough must stay exactly where it is.
 *
 * @returns {ok:true, result} | null (null = the caller proceeds as before)
 */
export async function tryRoute(callerArgs, callBridge, ctx = {}) {
  if (!routesRouting()) return null;
  const what = callerArgs?.what;
  if (typeof what !== "string" || !what.trim()) return null;
  try {
    const table = await getRouteTable();
    const route = table.lookup(what);
    if (!route) return null;
    // `frozen` withholds unauthored routes: a bench arm must not inherit a vocabulary that grew
    // while some other session was playing.
    if (route.provenance !== "authored" && routesMode() !== "learn") return null;
    const out = await runRoute(route, callerArgs, callBridge, ctx);
    if (out) {
      await getLedger().append({
        kind: "routed", concept: route.concept, asked: what,
        provenance: route.provenance, legs: route.legs.map((l) => l.what),
        found: out.result.found.length, negative_is_proof: out.result.search.negative_is_proof,
        session: ctx.session, world: ctx.world,
      }).catch(() => {});
    }
    return out;
  } catch (e) {
    process.stderr.write(`[routes] route execution failed (${e.message}) — falling through\n`);
    return null;
  }
}
