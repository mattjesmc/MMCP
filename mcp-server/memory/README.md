# Agent memory (phase A/B) — mcp-server side

Design authority: `../../mcp-toolkit/docs/memory/MEMORY_DESIGN.md` (rev 2). This module is its implementation:

- `schema.mjs` — frozen record shapes + validators (SCHEMA_VERSION 1). Changing a shape means bumping
  the version with a migration story, not editing a test.
- `store.mjs` — the store (steps 3–5 built): append-only JSONL under `memory-data/<world_uuid>/`,
  derived index rebuilt at `open()`, deterministic block-header derivation, eligibility + coherence
  validation, per-subject verification, hybrid `recall` (structured + lexical over all records,
  semantic over frontier blocks; exact-first ranking, results carry `channel`/`score`).
- `embeddings.mjs` — local semantic backend (transformers.js, all-MiniLM-L6-v2; first use downloads
  the model). Per-model index in `index/<model-slug>/`, lazily backfilled. `MCPTK_EMBED_BACKEND=none`
  disables; an unavailable backend degrades recall to lexical-only, never errors.
- `tools.mjs` — the `mem_*` MCP tools, merged into the proxied manifest by `index.mjs`. Bridge is used
  only for tick/world-identity stamps; when the game is down, writes degrade to wall-clock (`tick:
  null`) with an explicit `offline` warning, and reads keep working. A world tick behind memory's
  horizon triggers a `rollback_warning`. Also home of the pending surface: each `mem_*` call lazily
  pulls new events through `classifyEvent` (hardcoded rules — action outcomes, failed authority
  calls, world edits, drone death; no importance classifier), candidates nag as a `[pending]` line in
  `mem_recent` until described (`mem_note` with `refs.events` → ack relation) or `mem_dismiss`ed.
  Single-writer assumption: one MCP server process per memory dir — `pending.json`/`meta.json` are
  last-writer-wins.
- `probes/` — executable specs (`npm test`): schema freeze + probes 1 (compaction invariant),
  2 (exact recall), 3 (cross-world isolation + rollback), 4 (demoted-detail — the
  reachable≠retrievable regression test), 5 (partial verification), 6 (contradiction), plus the
  pending-surface and semantic-channel suites. All green: 18/18 (probes run with the embedding
  backend off; `semantic.test.mjs` opts in and skips if unavailable). Any failure is a real
  regression. Probe 7 (gameplay ablation) is build-order step 7, not yet built.

Memory location: `mcp-server/memory-data/` (override with `MCPTK_MEMORY_DIR`).
