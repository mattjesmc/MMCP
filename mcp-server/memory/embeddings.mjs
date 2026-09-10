// Embedding backend for the semantic recall channel (MEMORY_DESIGN.md phase B, build-order step 5).
// Pluggable with a local default: transformers.js + all-MiniLM-L6-v2 (self-contained after the first
// model download). When the backend is unavailable (package not installed, model not cached and no
// network), the semantic channel is simply absent — recall degrades to structured + lexical, never
// errors. Search never mixes models: the index is keyed by model slug; switching models rebuilds.

// MCPTK_EMBED_MODEL swaps the model (queue item 3: bge-small-class swap-then-decide). The index is
// keyed by slug, so a swap rebuilds rather than mixing vector spaces — see modelSlug().
const DEFAULT_MODEL = process.env.MCPTK_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";

// Cosine scales are MODEL-SPECIFIC, so a threshold calibrated for one model means nothing for
// another — queue item 3 measured bge-small clearing MiniLM's 0.30 on pure nonsense ("tax return
// filing deadline" at 0.432 against a Minecraft patrol log). A model therefore may not run the
// semantic channel until someone has calibrated it; the gate is the decoy arm of
// ablation/micro-embed.mjs, which fails any model that cannot say "no".
const CALIBRATED = {
  "Xenova/all-MiniLM-L6-v2": 0.3,
};
const KNOWN_BAD = {
  "Xenova/bge-small-en-v1.5":
    "queue item 3 (2026-07-20): admits 18/18 decoy queries; best accuracy at any threshold equals the always-reject baseline",
};

let pipelinePromise = null;
let unavailableReason = null;

/**
 * Match threshold for the active model, or null when it has none — in which case the semantic
 * channel stays off rather than guessing a cutoff. MCPTK_EMBED_THRESHOLD is the deliberate override
 * for calibrating a new model; it is meant to be used while running the decoy arm, not in anger.
 */
export function threshold() {
  const override = Number.parseFloat(process.env.MCPTK_EMBED_THRESHOLD ?? "");
  if (Number.isFinite(override)) return override;
  return CALIBRATED[DEFAULT_MODEL] ?? null;
}

async function getPipeline() {
  if (process.env.MCPTK_EMBED_BACKEND === "none") return null; // explicit opt-out (fast tests, minimal installs)
  if (unavailableReason) return null;
  // An uncalibrated or known-bad model is worse than no channel at all: it does not fail loudly,
  // it quietly returns everything. Refuse rather than pollute recall.
  if (threshold() === null) {
    unavailableReason = KNOWN_BAD[DEFAULT_MODEL]
      ? `${DEFAULT_MODEL} is known-bad — ${KNOWN_BAD[DEFAULT_MODEL]}. Set MCPTK_EMBED_THRESHOLD to override for calibration work.`
      : `${DEFAULT_MODEL} has no calibrated threshold. Validate it with the decoy arm of ablation/micro-embed.mjs, then add it to CALIBRATED (or set MCPTK_EMBED_THRESHOLD to calibrate).`;
    return null;
  }
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      // stdout guard: this process may be an MCP stdio server, where ONE stray byte on stdout
      // corrupts the JSON-RPC framing. transformers.js / onnxruntime can emit progress and
      // warnings during import + model load; reroute anything they write to stderr for the
      // duration. (env.verbosity below silences what the library lets us silence.)
      // The redirect must FILTER, not blanket: the MCP server keeps answering other requests
      // while the model loads (seconds warm, minutes on first download), and its JSON-RPC
      // response frames go through this same process.stdout.write — swallowing them hangs
      // whatever call completed during the load window. Frames are newline-delimited JSON
      // objects; library noise is not.
      const realWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => {
        const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (s.trimStart().startsWith("{")) {
          return realWrite(chunk, ...rest); // a JSON-RPC frame passing through mid-load
        }
        return process.stderr.write(chunk, ...rest);
      };
      try {
        const mod = await import("@huggingface/transformers");
        if (mod.env) mod.env.verbosity = "error";
        return await mod.pipeline("feature-extraction", DEFAULT_MODEL, {
          progress_callback: () => {}, // no progress spam on either stream
        });
      } finally {
        process.stdout.write = realWrite;
      }
    })().catch((e) => {
      unavailableReason = e.message;
      return null;
    });
  }
  return pipelinePromise;
}

/** Stable identifier for the active model — the embedding index is keyed by this. */
export function modelSlug() {
  return DEFAULT_MODEL.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}

/** True when the semantic channel can run (backend importable; model may still download lazily). */
export async function available() {
  return (await getPipeline()) !== null;
}

/** Why the backend is unavailable, or null. */
export function unavailable() {
  return unavailableReason;
}

/** Embed texts to unit-normalized vectors, or null when the backend is unavailable. */
export async function embed(texts) {
  const pipe = await getPipeline();
  if (!pipe) return null;
  try {
    const out = [];
    for (const text of texts) {
      const t = await pipe(text, { pooling: "mean", normalize: true });
      out.push(Array.from(t.data));
    }
    return out;
  } catch (e) {
    // Runtime inference failures latch exactly like load failures: the channel goes absent for
    // the rest of the process instead of throwing inside every recall that touches it.
    unavailableReason = `runtime inference failure: ${e.message}`;
    return null;
  }
}

/** Cosine similarity of unit-normalized vectors (= dot product). */
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
