# Archive — superseded design docs

Historical records kept because other docs and code comments cite them for rationale. Nothing in
here describes the current system; each file's banner names what replaced it.

- `COMPANION_DESIGN.md` — step-8 companion draft (shim/SDK harness + authorization rails).
  Superseded by `../platform/COMPANION_REDESIGN.md` (implemented 2026-07-21).
- `TODO_SHIPPED.md` — the shipped sections of `../../../TODO.md`, split out 2026-08-23 when the file
  reached 1153 lines of which ~90% was done work. A record, not a plan: nothing in it is owed, and
  anything that still was moved to `../../../TODO.md` instead. Kept because several sections are the
  written rationale for decisions the code still depends on, and the postmortems are the evidence
  behind rules the project still follows.
- `TOKEN_EFFICIENCY_PLAN.md` — completed 2026-07-20 token-efficiency pass. §§1–5, 7 remain live
  (documented in `../../ARCHITECTURE.md`); §6's wake-per-request companion was reversed by
  `../platform/COMPANION_REDESIGN.md`.

Current authorities: `../../ARCHITECTURE.md` (system), `../platform/COMPANION_REDESIGN.md` (sessions &
companion mode), `../memory/MEMORY_DESIGN.md` (memory), `../../LIVE_MODDING.md` (operating guide),
`../bench/ABLATION_DESIGN.md` + `../bench/ABLATION_RESULTS.md` (completed experiment record).

## Left the repository (2026-09-06)

The workbench is published as the MCP Toolkit's repository, so records that are neither a manual
nor rationale the shipped code still leans on moved to the archive repository beside this checkout,
`../../../../mcmodding-archive/` (its own git, never pushed; its README carries the origin, the
reason and the restore step for every entry). They keep their names, so a citation by bare filename
still resolves through this list; nothing in the tree was rewritten to point at the archive.

| Record | Was at | Why it left |
|---|---|---|
| `HANDOFF_S4.md` | `docs/platform/` | a session handoff, cited by nothing |
| `AGENT_CLIENT_ADAPTER_HANDOFF.md` | `docs/platform/` | a session handoff, cited by nothing; the design is `platform/AGENT_CLIENT_ADAPTER_DESIGN.md` |
| `UI_KIT_DESIGN.md` | `docs/screens/` | superseded by `screens/SCREEN_AUTHORING_DESIGN.md`, which carries its surviving measurements |
| `ASSET_ROUNDTRIP_DESIGN.md` | `docs/models/` | descoped from release 1 (`RELEASE.md` section 5); the branch `body/asset-roundtrip` is its code |
| `MEMORY_REDESIGN_PLAN.md`, `MEMORY_REDESIGN_STATUS.md` | `docs/memory/` | the plan and status of a design that is built; `memory/MEMORY_REDESIGN.md` is the record |
| `OBSERVATION_MEMORY_STATUS.md` | `docs/memory/` | status of a built design; `memory/OBSERVATION_MEMORY_DESIGN.md` is the record |
| `PERCEPTION_NAV_FIXES.md`, `W1_42257_FINDINGS.md`, `W1_42257_FIXES.md`, `W2_56123_POSTMORTEM.md`, `W2_56123_FIXES.md`, `W2_POSTMORTEM_FIXES.md` | `docs/play/` | live-session postmortems of the experimental survival profile; Java and probe comments still cite them by name for the rule each fix established |
| `obs-tools.removed-2026-07-29.txt` | `mcp-server/memory/` | a deleted file preserved verbatim for `MEMORY_REDESIGN_STATUS.md`, which left with it |
| `soak.mjs`, `soak-report.mjs` | `mcp-server/companion/` | the step-8 companion soak prototype; its design is `COMPANION_DESIGN.md` above |

Also archived the same day, from `tools/`: the OBS recording sidecar (`obs/`) and the survival
transcript analyser (`transcript/analyse.mjs`); `tools/README.md` says how the sidecar comes back.
