// Thin bridge client for the bench (same envelope as probes; no MCP shim — staging and ground
// truth talk to the game directly).

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";

// R-b purpose stamp (V3_PLAN §3): the bench is a measuring instrument, not a training-data
// driver, and the wm recorder on the dev server records everything. An untagged session is
// adhoc (out of corpus) — but a bench run inside a server lifetime some OTHER driver already
// tagged (taskgen, survival) would ride into the corpus under that tag with no conflict fired,
// because only taggers conflict. So every bench process stamps `bench` once, before its first
// bridge call: standalone runs are excluded by name, and a bench-during-collection run trips
// the purpose-conflict guard, which refuses the whole session. Best-effort like battery.ps1 —
// the bench must keep working against a server whose jar predates the `bench` vocabulary;
// untagged merely costs nothing the default (adhoc = out) doesn't already provide.
let tagOnce;
async function tagBenchSession() {
  try {
    const res = await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "wm_session_tag", args: { purpose: "bench" } }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json();
    if (!j.ok) {
      console.error(`[bench] WARN wm_session_tag refused ${JSON.stringify(j.error)} — session stays untagged (adhoc = out of corpus)`);
    } else if (j.result.purpose_conflict) {
      console.error(`[bench] wm session PURPOSE CONFLICT — this server lifetime already ran another driver; the whole session is out of corpus (give the bench its own server lifetime)`);
    } else {
      console.error(`[bench] wm session tagged purpose=bench (excluded from corpus-v3)`);
    }
  } catch (e) {
    console.error(`[bench] WARN wm_session_tag unavailable (${e.message}) — no recorder or pre-R-block jar; session stays untagged (adhoc = out of corpus)`);
  }
}

export async function call(tool, args = {}) {
  await (tagOnce ??= tagBenchSession());
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}

export const cmd = (c) => call("run_command", { command: c });

export async function bridgeUp() {
  return fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
}
