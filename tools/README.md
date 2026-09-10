# Workbench scripts

| Script | Use it when |
|---|---|
| `rebuild.ps1` | A structural Java change (new class, field, tool registration): closes the running dev game, rebuilds, relaunches, and waits for the bridge. `-Project` picks a build root (default the toolkit; otherwise the path of a sibling checkout). One cycle per port; a second one exits 3 unless `-Takeover`. The MCP tool `launch_game` wraps it. |
| `dev-procs.ps1` | Something is running that nobody started. Lists rebuild supervisors, Gradle daemons, dev JVMs and port locks; `-Reap`, `-Games`, `-StopDaemons` clean up, scoped to this checkout. |
| `battery.ps1` | Run the live probe battery (`../mcp-server/probes/`) sequentially, one file at a time, and summarise. This is the arbiter; `npm run test:live` runs the same files concurrently and is flaky by design. |
| `extract-vanilla-src.ps1` | Unpack Loom's decompile cache into `../vanilla-src/` so vanilla source can be grepped. Re-run after `genSources` on a new Minecraft version. |
| `prod-client.py` | Assemble a launcher-less PRODUCTION client command from an installed launcher version, to exercise the production arm without touching the real game. |
| `launch-supervise.mjs` | By-hand harness for `launch_game`: supervises a rebuild cycle from a process that outlives it. |
| `probes/` | Tests of the scripts themselves (the launch guard, the rebuild lock). |

Archived 2026-09-06 to `../../mcmodding-archive/tools/` (its README says how to restore each):
`obs/`, the OBS recording sidecar for watchable survival runs, and `transcript/analyse.mjs`, the
survival-session postmortem instrument. The in-game start/stop button for the sidecar
(`ObsSupervisor`) is presence-gated and reappears when `tools/obs/` is put back.

The loop kit's scripts (agent template, one-session-per-unit runner, cost analyser) are in
`../mcp-toolkit/tools/loop/`.
