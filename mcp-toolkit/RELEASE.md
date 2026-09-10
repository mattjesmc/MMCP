# Release 1 - the release document

**What this file is.** `RELEASE_1.md` is the work list: every item, its arbiter, its build record.
This file is the ledger a release is cut from, written 2026-09-06 from that list, the changelog in
`build.gradle`, the battery logs in `../mcp-server/sequential-*.log`, the review queue in
`../run/review/asks.json` and the "as built" sections of the design records. It answers three
questions and nothing else: what ships, what has been verified on the code that ships, and what is
still open. Where a claim rests on a log, the log is named. Where nothing was recorded, this file
says "unrecorded" rather than inferring a pass.

Cite by bare filename; the records live under `docs/<subject>/` and `docs/README.md` maps them.

---

## 1. What ships

| Artifact | Version | Where |
|---|---|---|
| Toolkit mod jar (Fabric and NeoForge, dev and production) | 0.145.0 | `build.gradle`; `CHANGELOG.md` section 0.145.0 |
| MCP server (the shim, extracted from the jar) | 0.73.0 | `../mcp-server/package.json` |
| Convention plugin `com.mattmc.mcmod` | 0.7.0 | `../gradle-conventions/build.gradle` |
| Blockbench plugins `mcptoolkit_bridge.js`, `mcptoolkit_entity.js`, `mcptoolkit_sync.js` | 0.9.0 / 0.3.0 / 0.4.0 | `blockbench/` is their site of record; **in the jar under `blockbench-dist/` since 0.141.0**, written out to `<gameDir>/mcptoolkit/blockbench/` and `<repo>/.mcptoolkit/blockbench/` (`TODO.md` 1.10). They were in NO jar through 0.140.0 |

**This table is read off the four files it names, and it is the first thing to re-read when a
version bumps** - it stood at 0.125.0 / 0.59.0 / 0.5.1 until 2026-09-08 while the tree was at
0.140.0 / 0.68.0 / 0.7.0, sixteen toolkit versions of drift in the one table that says what ships.

**Branch.** The shipping branch is `body/fake-player-and-vertical-edges`; `main` is at `a5a6f3e`
(bench 0.9.3) with nothing of its own, so the release is a fast-forward. `body/asset-roundtrip`
(one commit of 17 files, +3,394 lines, based at 0.95.0, `ASSET_ROUNDTRIP_DESIGN.md`) is NOT on the
shipping branch; see section 5.

**The supported surface** is the developer profiles, exactly as `RELEASE_1.md` section 0 scopes it:
`modding` (the default, a keep-list that declares its complement), `authoring`, `art`, `screens`,
`inspect` (read-only, checked per name against the mechanism stamp), `rocketeer_authoring`, and a
project's own `profile` block in `.mcptoolkit/loop.json`. A modder attaches an agent to a running
game and authors blocks, models, entities, data, structures, screens and worldgen against it, with
the log channel, codec validation, registry detail, loot rolls, perf census, class reflection, the
camera and studio, and the loop kit.

**Shipped and labelled experimental, in the software**: `play`, `survey`, `survival`
(`PROFILE_META`, the start-up stderr line, `ping`'s `profile` block). Their owed live runs are out of
scope (`RELEASE_1.md` section H). The world-model subsystem ships compiled in, off by default,
served to no dev profile, its research half a separate repository (section F9).

**Accepted limits, which the docs must state plainly rather than imply otherwise.** Windows-only
(section 5, item F4 is the one obligation that carries). The bridge is `127.0.0.1` with no
permission system: any local process can drive the game. The bench arms `full`, `standard`,
`entity` stay frozen and `entity` still carries the six research tools (section F9's residual).

---

## 2. The verification ledger

The arbiter for the release is `../tools/battery.ps1` run whole, sequentially, on a **client** -
because `ui-input` and `render-camera` skip themselves headless, a server run leaves the whole
client surface unexercised (`RELEASE_1.md` section F2). Read the table as "the code that ships was
last seen green HERE, and THIS much has changed since".

~~**The column was recomputed 2026-09-08 and again 2026-09-10, and it says something the stale
version hid.** The last whole battery was at 0.132.0 / 0.63.0; the tree is at 0.143.0 / 0.71.0.
**Eleven toolkit versions and eight shim versions have no whole run behind them**~~ **PAID
2026-09-10 (section 2.8).** The gap was real and it is closed: twelve toolkit versions and nine shim
versions - 0.133.0's own Blockbench plugin replacing the third-party upstream, 0.135.0-0.140.0's
session isolation and per-window ports, 0.141.0's packaging, 0.142.0's window ownership, 0.143.0's
launcher removal (about 5,900 lines and three tools), 0.144.0's dock - are answered at the tagged
version by the run in 2.8.

**Section 2.7's "one run settles both rows" was too generous, and the first draft of 2.8 repeated
it - so BOTH ARMS WERE RUN** (2.8 fabric-api, 2.9 loader-only). A fabric-api run does not speak for
the loader-only arm: 2.7's own argument is that the two take DIFFERENT DOORS into the registries,
0.80.0 is the precedent for one arm breaking silently while the other stayed green, and loader-only
is the arm the toolkit's central claim rests on. The second run cost a relaunch and half an hour.
**The two arms agree file for file** (2.9), which is the strongest form this row has ever taken.

| What | Last green | On | Toolkit / shim then | Versions since |
|---|---|---|---|---|
| **The whole battery, 108 files, THE LOADER-ONLY ARM** | **2026-09-10, 903 pass / 0 fail, one part, no restarts** (`sequential-0.73.0-part1.log`, `-part2.log`; section 2.9) | dev client, `New World`, port 25599, no fabric-api (5 mods); window minimized, host NOT quiet | 0.145.0 / 0.73.0 | 0 / 0 |
| **The whole battery, 108 files, THE FABRIC-API ARM** | **2026-09-10, 901 pass / 8 fail in two files; both files are probes outliving their subject, both green after the fix** (`battery-0.72.0-fabricapi/sequential-0.72.0-part{1,2,3}.log`, moved into that directory so the loader-only arm's resume could start clean; section 2.8) | dev client, `New World`, port 25599, **`-Pfabricapi=true`** - the arm no battery had ever been on; window minimized throughout, host NOT quiet | 0.144.0 / 0.72.0 | 1 / 1 |
| **The whole battery, 107 files (K's, at 0.132.0)** | **2026-09-06/07, 866 pass / 25 fail in eight files, all eight green on isolated reruns** (`sequential-0.63.0.log` + `-part2.log`; `-rerun.log` 104/1, `-rerun2.log` 14/0; section 2.6) | dev client, `New World`, port 25599, the ONLY game on the machine; the window minimized by a hand mid-run | 0.132.0 / 0.63.0 | 11 / 8 |
| **The whole battery, 102 files (the dash's)** | **2026-09-06, 868 pass / 4 fail in four files** (`sequential-0.60.0-part1.log` files up to `player-body`, `-part2.log` from `player-hands`; section 2.5) | dev client, `New World`, port 25695, a SECOND game on the machine | 0.128.0 / 0.60.0 | 15 / 11 |
| **The whole battery, 101 files** | **2026-09-06, 845 pass / 24 fail in six files, all six diagnosed to the host (`sequential-0.58.0.log`) - section 2.2** | dev client, `New World` (established, 835 MB) | 0.124.0 / 0.58.0 | 19 / 13 |
| The title-screen client-envelope arm (five callable client tools, `game_tick` and `dimension` explicit null) | 2026-09-06, 5/5 (`sequential-0.58.0-title.log`) | dev client at `TitleScreen` | 0.124.0 / 0.58.0 | 19 / 13 |
| The whole battery, 86 files | 2026-08-28, 740 pass / 5 fail, all five diagnosed, two fixed (`sequential-0.50.0.log`, `-recheck`) | dev client, established world | 0.109.0 / 0.50.0 | 34 / 21 |
| A whole-battery attempt, 90 files | 2026-08-31, **174 pass / 181 fail** - collapsed after `combat-kit`; every later file 0/N (`sequential-0.53.0.log`, `-full`) | dev client | 0.113.0 / 0.53.0 | - |
| `conformance` (the manifest ratchet, chunk a) | 2026-08-31, 49/0 (`sequential-0.53.0-recheck.log`) | dev client | 0.113.0 | 30 |
| Chunk b (the dev surface, 45 files) | 2026-09-03, **405 pass / 5 fail in three files** (`sequential-0.53.0-b.log`) - section 2.2 | dev client | 0.119.0 / 0.53.0 | 24 / 18 |
| The seven `ui-*` files | 2026-09-04, 74/0 in the authoring world (`sequential-0.55.0.log`) | dev client, `mcptk-ui` | 0.120.0 / 0.55.0 | 23 / 16 |
| The parts library | 2026-09-04 live run, `UI_PARTS_LIBRARY_DESIGN.md` section 7.9 | dev client | 0.121.0 | 22 |
| The loop kit | 2026-09-06 by hand against the dev client and Blockbench 5.1.6 (`LOOP_KIT_DESIGN.md` sections 10 and 11); its four probes are offline, in chunk b since 0.125.0, and ran green inside the 101-file battery | dev client + Blockbench | 0.122.0-0.124.0 / 0.56.0-0.58.0 | 19 / 13 |
| Chunks a, c, d (play, perception, experimental) | 2026-08-28, inside the 86-file run | dev client | 0.109.0 | 34 |

### 2.5 The dash's whole battery (0.128.0, 2026-09-06)

**102 files, 868 pass / 4 fail**, run in two halves for a reason worth its sentence: the first
half ran on the toolkit's default port 25599 and collapsed at `player-hands` when ANOTHER Claude
session on this machine ran `rebuild.ps1 -Target server` on that same port - its first act is to
quit whatever holds the port, and it did, twice (the log shows a graceful "Stopping!" at 19:52:05
and a fresh JVM 26 seconds later; no crash report, and `ping.last_crash` correctly named only the
morning's). Section B0's trap, on the battery itself. The 55 files before `player-hands` stand;
the second half (47 files from `player-hands`, plus `site-map`) ran on a client of its own on port
25695 - same save, same `run/` directory, shared with the other session's game for the rest of
the run. The four reds:

- `check-path-r1` case 3: the recorder-off premise, red on every whole run since 0.124.0 (2.2).
- `attack-goal` case 2 and `perf` case 4: red once, **green on the isolated rerun**
  (`sequential-0.60.0-rerun.log`, 5/0 and 10/0). Intermittent under a host running two games.
- `ranged-pressure`: red on all three runs, and a DIFFERENT case each time - `flee` walked 0.0 in
  the battery, `attack` "walked 0.0 of 15.8 blocks" on both reruns (`-rerun.log`, `-rerun2.log`).
  The theme across it and the two intermittents is a body that does not walk; the dash's runtime
  diff (`git diff --stat 761cefd..HEAD -- mcp-toolkit/src/main`) touches CrashReports, the
  platform seam, the MC-free scaffold package, LogTools and BuiltinTools, and no body, combat or
  navigation class. ~~**Undiagnosed, and owed a rerun on a quiet host** (one game): the mechanism
  this run cannot separate from is two clients on one machine and one `run/`.~~ **Rerun on a quiet
  host 2026-09-07 (2.6): red again inside the battery (walked 3.3 of 15.5), green alone twice.
  The host was never its mechanism; still undiagnosed, and the case now reports the world's state.**

The new probe (`crash-summary`) passed in the first half. `conformance` passed, so 0.126.0's two
manifest changes are ratcheted.

### 2.6 The step-7 battery (0.132.0, 2026-09-06 evening into 2026-09-07)

**107 files, 866 pass / 25 fail in eight files; all eight green on isolated reruns the same
night.** Run on the dev client in `New World` on port 25599 with NO other game on the machine
(`dev-procs.ps1` checked before the launch), which is the quiet-host condition 2.5 asked for. The
jar was 0.132.0: the 0.131.0 tree plus `click {hover:true}` (2.3, the tooltip half), and the
`create-world` probe had run 5/5 by hand at the title screen first (it is gated, and leaves the
client in the world it makes). The logs are a SET, for a reason recorded here so nobody reads it
as a flaky battery: three launches in a row were killed part-way through - never by a probe,
never by the game - and the run finished under `tools/battery-resume.ps1` (new), which reads the
version's logs, takes every scored line as a verdict, and runs `-Only` over the rest into the next
`-partN.log`. What killed the first two, to the second: a log MONITOR (`tail -f` on the log the
battery appends to after every file) - the append fails under `$ErrorActionPreference = 'Stop'`
and the script stops with nothing on stderr. Fifty-eight orphaned `tail` processes from earlier
sessions' monitors were found sitting on this machine and killed. The third kill (node itself,
mid-file, `entity-preview` 0/0; 11/11 by hand a minute later) has no such neighbour and is
undiagnosed. Neither `Start-Process` from a foreground tool call nor a WMI `Win32_Process.Create`
alone was enough; the resume loop under `cmd.exe` was. The 25 reds:

- **21 are one minimized window.** `render-camera` 0/16, `render-studio` 2, `studio-entity` 2,
  all "the window is minimized - Minecraft gates rendering on that"; and `ui-conform`'s new
  TOOLTIP-static case, 0 pixels changed under the pointer. The window had been restored after the
  relaunch (ui-conform ran 9/9 on it at 20:50) and was iconic by 00:30, with a display change
  logged at 21:15; a hand did it. Restored with `ShowWindowAsync`, all 21 green on the rerun
  (`-rerun.log`). One finding inside this: with the window iconic, `screenshot` returns the STALE
  framebuffer, so ui-conform's PIXELS and TOOLTIP-hook cases passed by comparing one frame with
  itself - the static-tooltip case was the only one that could notice. `render` refuses when
  iconic; `screenshot` does not. **Owed**: the same refusal (or an `iconic` flag) on `screenshot`
  - RETRACTED at 0.134.0: measured with the window iconic, `screenshot` MOVED when a screen opened
  and `render` came out at a new heading; the frame keeps rendering at 10 fps, only the present is
  skipped, and the refusal itself was the 21 reds. The tooltip case was the one real red: the
  pointer is lost on a 0x0 window (`ScreenSpaceMixin` fixes it; CHANGELOG.md 0.134.0). Was:
  and the pixel probes reading it.
- **`attack-goal` case 2**: the hunt was achieved with hits, and "the zombie is dead" took the
  first zombie of the type within 32 blocks - a second one, full health, 17.8 blocks SW on the
  platform. The probe now finds the STAGED zombie by where it was summoned and by id afterwards
  (2.5's "intermittent under two games" was this, on a quiet host). 5/5 on the rerun.
- **`conformance` case 2**: the classification ratchet, catching K2 - `create_world` and
  `get_tooltip` shipped at 0.130.0 with no spec entry. Declared in the never-called client tier
  with their reasons. 49/0 on the rerun.
- **`perf` case 4**: `hot_chunks` ranks by entities + tickers together (`PerfTools.hotChunks`,
  documented there); the probe's "weakest listed chunk" compared tickers alone and read a chunk of
  entities as a cut. The probe now measures the sum. 10/0 on `-rerun2.log`.
- **`ranged-pressure` case 2**: `attack` walked 3.3 of 15.5 blocks toward a stand-off skeleton;
  4/4 alone ten minutes later and again after that. 2.5's theory - two games on one machine - is
  falsified: this host was quiet. No body, combat or navigation class has changed since the last
  green battery (`git diff --stat 761cefd..HEAD -- mcp-toolkit/src/main`). Whatever differs is in
  the world at that moment; the case now prints the walk, the live gap, the day timeline
  (`time query day`, 26.2's form), the skeleton's position and health and the body's position on
  every run, so the next red explains itself. **Undiagnosed, not the host.**
- `create-world` 0/0 in the battery is the gate, not a verdict (5/5 by hand); `entity-preview`
  0/0 in part 1 is the third kill (11/11 by hand, 11/11 in part 2).

Also in this run: the battery's WARN named five probes in no chunk (`context-column`,
`create-world`, `headless-surface`, `studio-entity`, `tooltip`), now declared in chunk b. The
K-step files ran green inside the whole run: `context-column` 4, `crash-summary` 5,
`headless-surface`, `tooltip`, `studio-entity` (5/5 on the rerun once the window was back).

### 2.7 The arm every battery has been on, and the one it has not (2026-09-08)

**Every whole battery in the table above ran WITHOUT fabric-api.** The toolkit is loader-only by
construction - `fabric.mod.json` `depends` names `fabricloader`, `minecraft` and `java` and nothing
else, and `build.gradle` keeps fabric-api off the compile classpath and out of the default runtime,
where it enters only under `-Pfabricapi=true` as `localRuntime`. `tools/rebuild.ps1`, which launches
the game every battery runs against, had no way to pass that flag until 0.144.0 - so the 107 files
have only ever been answered by the no-fabric-api arm. It takes `-FabricApi` now, and the flag rides
the LAUNCH and not the build (fabric-api is `localRuntime`, so the jar is byte-identical on both
arms); the launch prints which arm it is either way, because a battery log gets read months later by
someone who needs to know which world answered it.

What the other arm has today is boot-depth, not battery-depth: `CROSS_LOADER_DESIGN.md`'s four-cell
Fabric matrix (server and client, with and without fabric-api) is `ping` plus the resource-manager
line, its six-cell matrix adds NeoForge, and section 17's three production servers include one
Fabric + fabric-api + villagejobs cell that reached boot, extract, `npm install`, `ping` and a clean
stop. Beside that, every consumer repository (menagerie, rocketeer, villagejobs, ArmorPieces) runs
with fabric-api daily - real coverage, measured by nobody.

**Why it is not a formality.** The two arms take different doors into the registries:
fabric-registry-sync delays the freeze past mod init, so with fabric-api the toolkit registers its
bodies one way and without it through the `bootStrap()` freeze, visible in the log as the two `No
data fixer registered for mcptoolkit:drone` lines that appear only on the loader-only arm
(`CROSS_LOADER_DESIGN.md` section 16). 0.80.0 is the precedent and the reason this is written down:
the toolkit ran without fabric-api and had silently stopped running WITH it.

~~**Owed before the tag:** one whole sequential battery on a client started with
`-Pfabricapi=true`~~ **RUN 2026-09-10 at 0.144.0 / 0.72.0: 108 files, 901 pass / 8 fail in two
files, and neither failure is a defect in shipping code** (section 2.8). **AND THE LOADER-ONLY ARM
WAS RUN BESIDE IT: 108 files, 903 pass / 0 fail (section 2.9), and the two arms agree file for
file.** The arms were verified rather than assumed, by the tell this section names, reading opposite
ways: 51 mods and those two `No data fixer registered for mcptoolkit:drone` lines ABSENT on one, 5
mods and both lines PRESENT on the other. `tools/rebuild.ps1` grew `-FabricApi` to make the pair
possible at all - it had no way to pass the flag, which is the whole reason this arm had never been
measured. **Nothing on this section is owed any more.**

~~**And it is one job, not two** (2026-09-08). The ledger's drift column above says nine toolkit
versions have landed since the last whole run, so a battery is owed on that count alone. Run this
one at the CURRENT version and the same log answers both questions - the untested arm and the
untested versions~~ **It was TWO jobs, and both were done on 2026-09-10** (2.8, 2.9). The argument
for waiting until the tree was otherwise closed was right and the rest was not: one log at the
current version answers the drift, but only for the arm it ran on, and the arm question is a
COMPARISON - it needs both sides or it is not asking anything. The second run cost a relaunch and
half an hour on the same jar, which is the real reason this was never two jobs' worth of work.
The live-arm dependency in the other direction held up: 0.141.0's extracts (`TODO.md` 1.10) had
never run, and both client boots exercised `ServerExtract` on the way to the bridge.

### 2.8 The fabric-api battery (0.144.0, 2026-09-10)

**108 files, 901 pass / 8 fail in two files. Both failing files are probes that outlived their
subject; neither is a defect in a tool a modder calls, and both are green after the fix.** Logs:
`battery-0.72.0-fabricapi/sequential-0.72.0-part{1,2,3}.log`. **This is ONE OF TWO ARMS** - the
loader-only run at this version is section 2.9. Run on
the dev client in `New World` on port 25599, at the version being tagged, on a client started
`-Pfabricapi=true` - the arm section 2.7 says no whole battery had ever been on.

**The arm was proved, not assumed.** Before the run: the client reported `Loading 51 mods`, and the
two `No data fixer registered for mcptoolkit:drone` lines that 2.7 says appear ONLY on the
loader-only arm were ABSENT. That is this section's own falsifier, used the way it was written to be
used. `tools/rebuild.ps1` gained `-FabricApi` to make the run possible: it had never been able to
pass the flag, which is the honest reason the arm had gone eleven versions unmeasured - not
reluctance, no route. The flag rides the LAUNCH and not the build, because fabric-api is
`localRuntime` and the jar is byte-identical on both arms; so this log answers the RUNTIME, and the
artifact it answers for is the same artifact the loader-only runs answered for.

**The two reds, both probes outliving their subject:**

- **`agent-client` 6/7.** Seven cases asserted the OUTBOUND half - `ping.agent`, the no-client state
  as a supported STATE, "no adapter code path was taken", the two bundled adapters' capabilities,
  and three kit cases - and 0.143.0 archived the launcher they describe. There is no `agent` seam in
  `ping` to report any more, so the question no longer has two sides. The seven were removed at
  0.144.0 and the six that remain are the INBOUND path that stayed: hello, external session
  identity, the orientation pointer, and every dev tool answering with no client configured at all.
  **6/0.** The file's premise survives the cut purer than before - the toolkit is not an accessory
  of one of them precisely because the only path left is the one an external agent dials.
- **`review` 5/1**, and this one is worth the paragraph. `a check that holds closes the ask as
  `checked`, never as `ok`` failed with `'ok' !== 'checked'`. **Nothing in the review layer is
  broken.** `run/review/asks.json` held `probe-review-checked` in state `ok`, `answered_by:
  Player902` - a human had answered the probe's own synthetic ask, the one whose `look` reads
  "nothing - this ask exists only to be read back by a probe". From that moment the probe could
  never pass again, because two CORRECT rules combine into a one-way door: `sweepChecks` refuses to
  re-evaluate a human verdict (`ok`, `no` and `note` are records of what a person said and nothing
  may overwrite one), and a re-post preserves any verdict already given. Clearing that one row
  returned **6/0**, with the referee filing `checked`/`by: referee`/`check passed: /time query
  gametime` exactly as designed. **The defect is upstream of both rules: a probe-owned ask can reach
  a human's walk at all.** The probe's cleanup comment shows the author accepted that its `checked`
  ask persists (`drop` only takes OPEN asks) but did not foresee it ever being OPEN in front of a
  person - which it must have been, since `walkable` only offers open asks. Two ways to close the
  class: let `drop` remove any ask by id so a probe leaves no trace, or exclude `probe-*` sources
  from `walkable` so a synthetic ask is never offered to a person. The second fixes the class.

**Three long-standing reds came back green, and the honest reading is "not reproduced here", not
"fixed by this arm".**

- `ranged-pressure` **4/0** - red in EVERY previous whole battery and red again on the deliberately
  quiet host of 2.6, which is what retired the host as its mechanism. It passed here. The confound
  is that this run changed two things at once (the arm, and twelve versions), so this is one datum,
  not a diagnosis.
- `check-path-r1` **3/0** - case 3's recorder-off premise had been red on every whole run since
  0.124.0 (2.2).
- `render-camera` **17/0**, `render-studio` **7/0**, `studio-entity` **5/0**, `ui-conform` **10/0** -
  the 21 minimized-window reds of 2.6. This client was launched MINIMIZED, as `rebuild.ps1` always
  does, and rendering held throughout: 0.134.0's `ScreenSpaceMixin` fix, confirmed under a whole
  battery for the first time.

**`create-world` 0/0 twice** is the gate self-skipping, not a verdict, and it is what let the resume
loop write its DONE marker: a file answering 0/0 twice is treated as scored by design.

**On the host, recorded because 2.5 and 2.6 both had to argue about it.** This run was NOT on a
quiet host - about 577 MB free of 15.7 GB, six Blockbench windows, and other sessions' shims
resident. It cost the run nothing: `perf` 10/0, `attack-goal` 5/0, `ranged-pressure` 4/0. The
prediction that a busy host would muddy the result was made before the run and was wrong.

**Two harness facts learned the hard way, both mine.** The battery was restarted once at file three
because a progress check was grepping the log the run appends to - 2.6 names `tail -f` as the
mechanism, but the mechanism is ANY concurrent reader: the append fails under
`$ErrorActionPreference = 'Stop'` and the script stops with nothing on stderr. `battery-resume.ps1`
absorbed it exactly as designed and nothing was re-run. And `tools/battery.ps1`'s standing WARN was
acted on rather than read for the fourth time: `paint-code` had named no probe file since the loop
kit's rename while `loop-examples` sat in no chunk, so chunk b was carrying a dead name AND skipping
a live file. Both fixed at 0.144.0.

### 2.9 The loader-only battery (0.145.0, 2026-09-10) - and what the two arms say together

**108 files, 903 pass / 0 fail. One part, no restarts, nothing diagnosed.** Same client, same save
(`New World`, `world_uuid` and `seed_hash` identical to 2.8's run), same port, same minimized window,
same busy host - and no `-Pfabricapi`.

**The arm was proved by the same tell, reading the opposite way.** 2.8's client loaded 51 mods with
the two `No data fixer registered for mcptoolkit:drone` lines ABSENT; this one loaded **5 mods** with
those two lines **PRESENT** and zero fabric-api references in the log. That is 2.7's falsifier
answering both ways round, which is what makes the pair a comparison rather than two runs.

**THE TWO ARMS AGREE FILE FOR FILE.** Compared verdict by verdict, 105 of 108 files have an
IDENTICAL pass count on both arms, and all three differences are accounted for without appeal to the
arm:

| File | fabric-api | loader-only | Why |
|---|---|---|---|
| `agent-client` | 6/7 | 6/0 | the seven archived-launcher cases removed at 0.144.0 (2.8) |
| `blockbench-surface` | 15/0 | 16/0 | 0.145.0 added a test |
| `review` | 5/1 | 6/0 | the poisoned queue row cleared (2.8) |

**This is the claim 0.80.0 made nobody able to assert.** That regression was the toolkit running
loader-only and having silently stopped running WITH fabric-api, invisible here and surfacing in a
downstream mod. The pair above is the first evidence in this repository that the whole tool surface
behaves the SAME on both arms rather than merely working on each.

**On the two runs being one version apart** (0.144.0 / 0.72.0 and 0.145.0 / 0.73.0). Another session
landed 0.145.0 while 2.8's battery was running. The delta is `BLOCKBENCH_ISOLATION_DESIGN.md` 11.13 -
window allocation moving off the tool-list watcher, and the two-dock port arbitration - which is shim
and plugin surface and does not touch the registry door the arms differ at. Its one visible
consequence in the comparison is `blockbench-surface`'s extra case, named in the table above. The
runs are treated as compatible for the arm question on that basis; they would NOT be compatible for a
question about window ownership, and this paragraph exists so the distinction is not inherited by
somebody reading the totals.

**One divergence worth a line, not yet a finding.** The loader-only client parked on
`BackupConfirmScreen` ("Worlds using Experimental Settings are not supported") opening the same save
that the fabric-api client opened straight through. The save is experimental because it carries
`mcptoolkit:workshop` and `mcptoolkit:studio`, and custom dimension registration is exactly where 2.7
says the arms take different doors - so this may be a real consequence of that difference, or it may
be incidental to what the previous session left in `level.dat`. It cost one `click`. Reproduce it
before calling it anything.

### 2.1 What that table says

**The whole battery ran at 0.124.0 on 2026-09-06**: 101 files, 845 pass / 24 fail, on a dev client
in the established save `New World`, window restored, recorder off. The 24 reds sit in six files and
every one of them is the host talking - section 2.2 names the mechanism for each, and 0.125.0 is
the probe- and harness-side answer. Nothing in the 24 is a defect in a tool a modder calls. The
manifest ratchet (`conformance`) went 49/0 on the same run, so 0.118.0's and 0.122.0's manifest
changes are ratcheted. The rerun of those six files at 0.125.0 is section 2.4.

### 2.2 The reds, diagnosed

Six files on the 0.124.0 run. Each mechanism below was read from the code and the log, and each
has a probe or harness change in 0.125.0; none has a code change in a shipped tool except `ping`.

- **`check-path-r1` 2/1 and `obs-gap-synthetic` 4/2 - the recorder is off.** `run/config/
  mcptoolkit.properties` has carried `wm.record=false` since 2026-09-03 (set during the authoring-
  world work). The gait and gaze fans that widen a body's knowledge (`WmGait`) and the note that
  marks an entity sighted (`WmObsGap.note`) both run inside the recorder's tick, so with it off a
  body knows only the three cells it stands in and no fan ever marks a sighting. Both files pinned
  a premise nobody could read. `ping` now carries `wm: {recording, note}`; `obs-gap-synthetic`
  reads it and skips its three sighting cases by name when the recorder is off. `check-path-r1`
  case 3 (walked terrain answers true) stayed red at 0.125.0 with the body landed straight ahead,
  and that one was a shipped-mechanism defect the fans had papered over: `WmSeen.addBody` sampled
  one point per tick, so a walker crossing an x and a z boundary inside one tick fed neither cell
  it passed through, and the knowledge-masked solve stopped at x+2 of a walked corridor. It now
  marches the segment from last tick's position; the probe asks about the route the body walked
  (spawn to landed cell) rather than the strip's centre line.
- **`perf` 8/2 - the established world.** The save carries 1,344 leftover tickers from months of
  staging, so the probe's three hoppers never rank in a top-50 hot-chunk list, and a chest read saw
  the total drift by one between two reads 400 ms apart. The probe now asserts the place-half in the
  form the tool claims (the chunk is listed, or every listed chunk outranks it and the reply says the
  list was cut) and reports a drop between control and read as drift rather than failing on it.
- **`render-camera` 0/16 and `render-studio` 5/2 - the window was minimized.** Every red case
  carried the same refusal: "the window is minimized - Minecraft gates rendering on that". A client
  launched by `rebuild.ps1` starts minimized (the Gradle window is started `-WindowStyle Minimized`
  and LWJGL's first window inherits it). This is also the likeliest reading of the 0.119.0 chunk-b
  reds this section used to attribute to the studio dimension: same two files, same launcher. The
  window was restored by hand mid-run (the eight `ui-*` pixel files that came after went 82/0), and
  `rebuild.ps1` now restores it itself once the bridge answers. **But the 0.119.0 case was not only
  the window** - the second whole run (2.4) had it red with the window up, and by hand it showed two
  mechanisms in the code: `studio` answered when the client's LEVEL had the blocks, before the
  renderer had compiled them (an immediate render photographed an empty white studio with
  `settled:true`; 1.5 s later the subject was there), and the studio's background follows the
  overworld's WEATHER (rain and thunder darken the sky colour the fog blends in: 240,245,255 for
  #FFFFFF during a storm). Fixed in 0.125.0: the wait also requires each witness's section to be
  compiled and visible from the stand; `render` zeroes the client's rain and thunder for a studio
  frame. The probe keeps a failing frame now, so the next red has a picture.
- **`visible-acts` 7/1 - one preempted ceremony.** Case 6 saw a 452 ms bench craft against a
  15-tick (750 ms) ceremony; the only path that shortens one is a reflex or fight claiming the body
  mid-ceremony, which is by design. 8/8 on the rerun; not seen again.
- **`human-task` went 5/5** on this client - the 0.119.0 reds (2/3) were a CAPTURED human, which is
  the recorder ON with a client connected. The probe now reads that premise the same way and pins
  whichever arm the host is in.

### 2.4 The rerun at 0.125.0

`sequential-0.59.0-rerun.log` (13 files: the six reds, `human-task`, `preview-worldgen`,
`conformance`, the four loop-kit probes), same client rebuilt at 0.125.0, same save, window up:
**132 pass / 1 fail**, the one being `check-path-r1` case 3; then `-rerun2` (probe fixed, still
red: the feed's hole above) and `-rerun3` after the `WmSeen` fix was hotswapped in: **3/3**. So
every file that was red on the whole run is green on the code that ships, and the one code change
among the fixes is the seen-set feed, covered by that case and by `-rerun4`: nine files that walk
bodies or read session knowledge (`descent`, `hazards`, `known-movement`, `nav-wedge`,
`player-hands`, `retina`, `spatial-sense`, `walker`, `wm-rblock`), **68/0**. The offline suite
(`npm test`) is 189/0.

**The second whole run, at 0.125.0** (`sequential-0.59.0.log`, same client, same save, window up):
**861 pass / 5 fail in five files.** `check-path-r1` (the landed cell a step past the strip's end:
probe clamped, 3/3), `combat-kit` case 12 and `descent` case 12 (a shield-timing race and a brew
slot, both 22/0 and 17/0 on the rerun and not seen again; my own concurrent single-file rerun
ran beside the battery around then), and two that were the code: `render-studio` case 2 (the
studio wait and the weather, 2.2) and `agent-client` case 5 (the probe's bridge caller unwrapped
the envelope, so the memory render read the on-disk world cache - which held the authoring
world's uuid - instead of the game; mirrored on the shim's caller, 13/0). After the two client
classes were hotswapped: `render-studio` 7/7 on four runs of five, the fifth an honest "no chunk
here yet" refusal inside a back-to-back loop. The two client classes changed AFTER the second
whole run; their own files and the pixel files were rerun on the rebuilt jar
(`sequential-0.59.0-rerun7.log`: `agent-client`, `canvas-edit`, `render-camera`, `render-studio`,
`ui-attach`, `ui-conform`, **66/0**), which is the rerun owed rather than a third whole run.

### 2.3 Live runs a shipped feature still owes

Each is named in the record that built the feature; none is a probe that exists and is red.

- ~~**The client envelope's title-screen arm**~~ **RAN 2026-09-06**: the five callable client-tier
  tools called on `TitleScreen`, held to `conformance`'s own `checkClientEnvelope` rules, all five
  carrying `game_tick: null` and `dimension: null` (`sequential-0.58.0-title.log`). The `conformance`
  file itself cannot run there - its `before()` forceloads a sandbox - so the arm is a script beside
  it; folding it into the file as a title-screen mode is a small follow-up.
- ~~**The production client extract**~~ (`TODO.md` section 3.2, `CROSS_LOADER_DESIGN.md` "Where
  this leaves the matrix"). **RUN 2026-09-10 at 0.145.0, GREEN, AND IT NEEDED NO CLICK.** It was
  written down as "one human click" on 2026-08-23, when `ServerExtract` had three call sites and a
  client reached only two of them - the Launch Workbench button and `CompanionSessions.spawnWith`
  - both of which go on to start a real `claude` session, so the arm could not be driven from the
  bridge without spawning an agent on the owner's account. **That stopped being true at 0.124.0**
  (2026-09-06, `e6085b6`), which gave the CLIENT its own extract at init
  (`McpToolkitClient.java:71`) for exactly the reason the note was blocking on: the documented
  inbound path named a directory nothing created. So BOOTING a production client has been the
  whole test for twenty-one toolkit versions, and nobody revisited the note - `TODO.md` 3.2 and
  `CROSS_LOADER_DESIGN.md` section 17 still said "one human click" today. **A third instance of
  this document's own table-rot finding, and the worst kind: not a stale table but a stale
  BLOCKER, a task held open by a sentence the code had already answered.** (0.143.0 is easy to
  mistake for the moment it changed, because that is when the comment above the call stopped
  naming a launcher; the call itself is 0.124.0's.)

  What ran: the 0.85.0 jar in `../run/prod-client/mods/` (83 releases stale) replaced with
  0.145.0, `../run/prod-client/mcptoolkit/` deleted so the extract had to happen from nothing,
  and a launcher-less client assembled by `tools/prod-client.py` and started on port 25600.
  Green on every cell: `extracted MCP server 0.145.0` and `extracted 3 Blockbench plugin(s)
  0.145.0`, `.extracted-version` 0.145.0, `npm install` clean (94 packages, 0 vulnerabilities),
  and `ping` through the bridge answering `env: production`, `loader: fabric`,
  `clientPresent: true`, `stale: false`. Then the loop was closed the way a consumer closes it
  rather than the way a probe would: the EXTRACTED shim was started over stdio against that game
  and handshook - 52 tools on the `modding` profile, `ping` through it reporting the same
  production game. **This is also the first time 0.141.0's Blockbench bundling has reached a
  production jar** (`TODO.md` 1.10 was only ever seen in dev). `quit_game` exited clean with no
  `crash-reports/` directory, as it did at 0.85.0.

  **It cost two documentation defects, both in the guide the release's audience reads** - see F7
  in section 5 for the first (`ADAPTER.md` still sent the reader to the archived MMCP screen).
  The second is small and unfixed: the shim advertises `serverInfo.version` **0.1.0** at
  `initialize` (`../mcp-server/index.mjs:1339`), so a modder's host displays 0.1.0 for what this
  document's section 1 calls 0.73.0.
- ~~**ArmorPieces' extract refreshed to 0.124.0**~~ (`LOOP_KIT_DESIGN.md` section 11.5). **Was
  already done** when this bullet was written: `ArmorPieces/run/mcptoolkit/mcp-server/.extracted-version`
  read 0.124.0 on 2026-09-06 midday. **Refreshed to 0.132.0 the same evening**: their `build.gradle`
  pin moved from 0.124.0 to 0.132.0 (with a comment saying what K brought), and the shim was
  extracted from the published 0.132.0 jar into their run directory by hand with the stamp
  rewritten - the dist `package.json` is byte-identical, so no `npm install` was owed. Their next
  dev boot re-extracts anyway (dev always does); the hand extract is for the `.mcp.json` shim
  until then. Not yet done: a compile of their tree against the new pin (their side is
  uncommitted, and a Gradle daemon on the host during the battery is the kind of load 2.5 blames).
- **The same-brief A/B** (`LOOPS.md` Owed, `LOOP_KIT_DESIGN.md` 11.5). The measured falsifier
  compared a kit run against a published figure for a different part. Model spend; a judgement call
  whether it gates the release (this file's recommendation: it does not, and `LOOPS.md` says what
  was actually compared).
- ~~**The dynamic-tooltip half of the parts library**~~ (`UI_PARTS_LIBRARY_DESIGN.md` 7.10): proved only
  until a screen with a region tooltip is compared interpreted against generated. **BUILT 0.132.0,
  2026-09-06**: the missing piece was the pointer, not the screen - no tool could move the pointer
  vanilla renders from, so no probe could have a tooltip in frame. `click {hover:true}` moves it;
  `ui-conform` gained the two cases (static `launch` tooltip identical on both renderers and
  present on both; hook `ok` drawing nothing beside the button on both). Live result: see 2.6.
- ~~**`create-world` by hand after each rebuild**~~ (gated: it leaves the client in the world it
  made): **5/5 at 0.132.0, 2026-09-06**, at the title screen right after `rebuild.ps1`, before the
  battery's world was opened.
- ~~**`preview-worldgen`'s minimum-sample guard**~~ **DONE 0.125.0**: case 5 stops before the
  distribution assertions with fewer than four compared columns and says so; 9/9 on the established
  world, the virgin-server arm unrun.
- ~~**The profile re-price**~~ **DONE 2026-09-06**: `probes/fixtures/manifest-2026-09-06.json`, a
  96-tool capture from the client in a world, priced every profile (site of record: the comment in
  `index.mjs`; `modding` ~26.8k tok/turn, `authoring` ~13.7k, `full` ~47.5k) and is what
  `authoring-saving` and `loop-profile` now drive. `open_world`'s own bill is still the estimate in
  `RENDER_SEAM_DESIGN.md` 12.6.
- ~~**The loop kit's four probes are in no battery chunk**~~ **DONE**: chunk b, and green in the run.

---

## 3. What needs a human at the screen

**As of 2026-09-10 evening the queue holds FIVE asks and NONE of them is open** (`review_status`:
`open: 0`) - seven went to `asks-archived-0.143.0.json` with the launcher, and the sitting
answered the rest. The one `no` in the table below is `scan-overhead-voice`, and it is a closed
rejection, not an outstanding one: the reviewer's `no` asked for the ask to be DRIVEN, it was, it
found a real bug, the bug is fixed, and the fix is what `scan-overhead-lush-cave` then confirmed
`ok`. Read the table below as the history that produced those verdicts, and this paragraph as the
state:

| Ask | State | What it says now |
|---|---|---|
| `review-card` | **ok** | The card itself was finally seen, and it reads. F6 is closed: the door to the queue is open |
| `review-walk` | **ok** | `/mmcp review next` flows |
| `probe-review-checked` | **checked**, by `referee` | The probe's own ask - and it was in state `ok`, answered by a person, which permanently falsified `review.test.mjs` until the row was cleared on 2026-09-10 (2.8). A probe-owned ask should never have reached a human's walk |
| `scan-overhead-voice` | **no**, and answered | Walked by driving it (2026-09-10). Two arms right, one wrong; cause found and fixed - `CHANGELOG.md` 0.143.0 |
| `scan-overhead-lush-cave` | **ok**, 2026-09-10 evening | Answered by Player398 at tick 82077, and the staging line corroborates the premise the ask rests on without taking anyone's word for it: `minecraft:lush_caves, time 6000 (midday), light 0, at 303 38 -184`. The queue is now empty. It had to be RE-WORDED first: its `look` said "run bot_scan", which is the same thing that got `scan-overhead-voice` rejected - **an ask whose LOOK instruction requires a tool call is an ask no human can walk, and that is now twice.** Re-posted carrying the agent's measurement inside it, so the person judges a reading against what they can see |

`launch/failed-boot` was in the table below and never existed in any `asks.json` on this machine -
it was written into this document and never posted. **The row is dropped (0.144.0), not posted.** It
was never a walk that was owed, it was a card that was never made; and the one read it would have
bought - does the exit-1 tail name the crash report and the reason - is the read the `crash-summary`
probe already covers green, reached through a deliberately broken mixin instead of a fixture.
`RELEASE_1.md` J3 had already kept it out of the battery by design.

The table below is the sitting as it was planned, kept because its verdicts are why the screen is
gone.

| Ask | From | Question |
|---|---|---|
| `review-card` | 0.77.0 | Does the review card read as a question you can answer? |
| `review-walk` | 0.77.0 | Does a walk of several asks flow: next, look, answer, next? |
| `mmcp/options-entry` | 0.112.0 | Does the MMCP entry sit in the Options screen without covering anything? |
| `mmcp/bridge-first` | 0.112.0 | Does the MMCP screen say which game this is and whether anything can reach it? |
| `mmcp/servers-screen` | 0.112.0 | Can a modder register their own repo from MMCP > MCP servers and have it work? |
| `agent/no-client` | 0.104.0 | With no agent client configured, does the launcher's absence read as a SETTING? |
| `agent/launch/workbench` | 0.104.0 | Does clicking Launch Workbench open a session that WORKS? |
| `agent/launch/companion` | 0.104.0 | Does clicking Launch Companion open a session that WORKS? |
| `agent/launch/survival` | 0.104.0 | Does clicking Launch Survival Player open a session that WORKS? (experimental profile; low priority) |
| `scan-overhead-voice` | survival | Out of scope for release 1 (section H) - **but walked anyway on 2026-09-10, and it was not free**: see the state table above and `CHANGELOG.md` 0.143.0. The classifier is shipped code on every profile that has a body, so its being out of scope did not make it harmless. |

**THE SITTING WAS STARTED 2026-09-09 AT 0.142.0, STOPPED ON ITS FIRST SCREEN, AND THE SCREEN WAS
THEN ARCHIVED (0.143.0, 2026-09-10).** Seven of the eleven asks below no longer have a subject: the
MMCP screen, the Options entry and the whole agent launcher are in `mcmodding-archive`, and the four
`mmcp/*` + `agent/*` asks went with them into `../run/review/asks-archived-0.143.0.json`. ~~**What is
left of this sitting is four things**: `review-card`, `review-walk`, the `launch/failed-boot` tail,
and the production-client click~~ **Two of those four were done on 2026-09-10** - `review-card` and
`review-walk` both came back `ok`, which closes F6 - **and the walk turned up a fifth thing that was
not on any list**: the reviewer's `no` on `scan-overhead-voice` said "I am not an agent cannot call
tools. You do it.", so it was driven instead of looked at, and it was a real defect (state table
above). **Nothing is left of the sitting.** `scan-overhead-lush-cave` came back `ok` on the evening of
2026-09-10 and the two chat-routing hand checks ran green the same evening (3.1). Every item in
this section is now answered, dropped for having no subject, or archived with the launcher. **The production-client click is gone, and not by being
clicked**: the client has had its own extract at init since 0.124.0, so booting a production client
IS the arm, and it ran green at 0.145.0 (section 2.3). The click had been unnecessary for
twenty-one versions; only the note saying otherwise survived. That is the second row in this document to close by
losing its subject rather than by a person answering it, after `launch/failed-boot`.

**And one of the two chat checks has lost its subject too.** Check 1.1 - open a terminal, close
it before it connects, confirm chat still reaches the session that IS connected - was guarding a
phantom that held the responder slot. Nothing can hold it now: `Sessions.mint` has exactly one
caller left (`BridgeServer` at `/hello`, which IS the connection), so there is no window between
minting and connecting for a terminal to be closed in, and `Sessions.abort` has no callers at
all. What is still worth running from 1.1 is its positive half, which no probe covers: a player
types in chat and the connected session receives the `chat` event. **A consequence found on the
way, worth stating because a javadoc claims otherwise:** every session is now `Kind.EXTERNAL`,
and `maybeAutoBind` returns early for EXTERNAL - so the "single-session fast path" it documents
can no longer fire, and chat is unrouted (all sessions hear) until someone types
`/mmcp session responder`. For one session that is the same behaviour by a different route; for
two it is not. Check 1.2 - rebind the responder while a session sits in a 60-second `get_events`
poll and confirm the wake lands within a beat - keeps its subject exactly
(`Sessions.setChatResponder` -> `EventLog.wakePollers`). The `launch/failed-boot` tail is NOT on that list any more; its
row was dropped at 0.144.0 for the reason given above. The table below is kept as written, because
the verdicts in it are why the screen is gone.

Three asks came back **no** (recorded in `../run/review/asks.json` with the reviewer's own words): `mmcp/options-entry`
(the button sits off screen, the window has to be maximized to click it, and it does not move logically
with GUI scale), `mmcp/servers-screen` (Register refused, and it asks for a path typed to a mod
directory), `agent/no-client` (the launcher's absence does not read as a setting - the remains of the
launch-session menu are still around it, and the session list draws its descriptions in the wrong
places). `mmcp/bridge-first` was never reached and stays open. **The verdict was not "these are three
bugs" but "this screen is the wrong screen":** the owner's statement of its single purpose is *let a
user start an MCP server on a port with a chosen profile and tool list, so an AI program can be
pointed at that port*. Everything else on it - kits, model/effort, chat routing, bypass, subtitles,
OBS - is the launcher this screen inherited. So B1 and the four `agent/*` asks are not a sitting away
from done; the screen is owed a redesign, and until it exists the rest of the sitting is blocked on it.

**Added 2026-09-07 (0.133.0):** the Blockbench bridge plugin's live arm. Load
`blockbench/mcptoolkit_bridge.js` (File > Plugins > Load Plugin from File), Tools > MCP Toolkit
Bridge > Start, "Always allow" the `process` permission, then from an `art` session: `ping`,
`project op:list`, `project op:new`, `place_cube`, `paint_faces`, `capture_screenshot views:[...]`,
`risky_eval` of `mcptoolkitEntity({action:'status'})`. The plugin never opens the permission
dialog by itself (it freezes the renderer for every session), so this click is the one step the
harness and the probes cannot make; `BLOCKBENCH_BRIDGE_DESIGN.md` section 11 lists what the click
proves. **RUN 2026-09-07 (plugin 0.1.1):** the click had been made; 56 steps through two fresh
`art` shims found seven live-only faults (undo entries without their created things, keyframes on
an unselected animation, captures aimed at cube coordinates instead of the displayed scene, the
eval's completion value, `undone` over-reporting, duplicate naming, a string session) - all fixed
and re-run green; CHANGELOG 0.133.0 has the list. Still owed: ArmorPieces' extracted shim moving
to 0.64.0 and its `blockbench` peer registration leaving `.mcp.json`.

**Added 2026-09-08 (0.141.0), and it is not a new sitting:** the B2 collapse renamed every command
a human types, so the four `mmcp/*` and `agent/*` asks above are now also the pass on `/mmcp` itself
— open the tab-completion at the root and check the tree reads as one thing rather than six, and that
the review card's own footer (`/mmcp review ok | no | note | skip`) matches what the dispatcher
accepts. Nothing extra to schedule; it is the same sitting, with one more thing to look at.

~~Beside the queue, from `TODO.md` section 2.8 and never probed: the two chat-routing hand
checks.~~ **RUN 2026-09-10, both green - see 3.1.**

### 3.1 The chat-routing checks (2026-09-10, 0.145.0 / 0.73.0)

Written in `TODO.md` 2.8 on 2026-08-23 as two hand checks because "a probe could fake the first
but not the second - the wake is the thing being tested". Both were answered on a dev client in
`probe-0143`, and the person's part was one line typed in chat.

**1.1 lost the failure it was guarding, and kept its positive half.** The check was: open a
terminal, close it before it connects, confirm chat still reaches the session that IS connected -
i.e. that a phantom cannot sit on the responder slot. Nothing can now: `Sessions.mint` has exactly
one caller left (`BridgeServer` at `/hello`, which IS the connection), so there is no window
between minting and connecting to close a terminal in, and `Sessions.abort` has no callers at all.
What was still worth running is the half no probe covers, and it ran: the player typed one line
and it arrived at the bound responder as `chat` event 14, sender and text intact.

**1.2 kept its subject exactly, and the measurement is sharp.** Session A - a freshly spawned
shim, NOT the responder - parked on `get_events {cursor: 13, wait_ms: 60000}` with the player's
chat (event 14) already in the log and excluded from it. The responder was then rebound to A. **A
returned 216 ms after the rebind was sent, carrying event 14, 13.4 seconds into a 60-second
window** - so the return was the wake (`Sessions.setChatResponder` -> `EventLog.wakePollers` ->
`EventTools`'s exclusions re-derived), not the timeout. Without the nudge A would have slept the
remaining ~46.5 s holding a chat event that was already its.

**And 1.1's worry does still exist, by another route, for about three minutes.** When the parked
session's process exited, it kept the responder binding: `Sessions.live()` grants a never-seen
grace and `chatResponder()` only self-clears once the entry is no longer live, so chat was routed
to a dead process until that lapsed. Bounded and by design, not the permanent phantom 1.1 feared -
but a player typing in that window is talking to nobody, and no line anywhere says so. Cleared by
hand here with `/mmcp session responder none`.

**Two things this run found that no probe would have.** First, a chat-ONLY poll from a
non-responder does not park at all - it fails fast with the routing verdict (`EventTools`'s
documented anti-starvation path), so the parked arm needs a multi-type filter (`chat,totem_used`);
worth knowing before someone reads a fast refusal as a broken poll. Second, **that refusal told
the reader to rebind "in the MMCP menu"** - a screen archived at 0.143.0. Fixed, with the same
sentence in five javadocs and one comment (`EventTools`, `EventLog`, `Sessions`, `ChatTools`,
`Registrations`); it is the second instance in one evening of an archived surface surviving in
text the audience reads, after `ADAPTER.md` (F7). **This is a source change after the batteries of
2.8/2.9**: strings only, no logic, and it is the owner's call whether the tag carries it and one
version of drift, or ships the stale sentence.

One sitting covers all of it: open the review card, walk the queue, click the four MMCP and agent
surfaces, do the title-screen `conformance` run and the production-client click from section 2.3
while the client is up.

---

## 4. Built or descoped: the items `RELEASE_1.md` says ship and that do not exist

Sections D and E are headed "all of these ship in the developer release". These are the ones with
no code behind them. Each needs one of two answers before the release: build it, or move it to
section H with a sentence in the docs saying it is absent. The recommendation column is this
file's; the decision is the owner's.

| Item | State | Recommendation |
|---|---|---|
| **A** - the agent-client adapter seam, the kits, the in-game launcher | **ARCHIVED 0.143.0** after the sitting'''s three `no`s (section 3). The audience this release is for drops a jar in `mods/` and runs their own agent program; a launcher inside the game served a workflow they do not have, and the screen built on it was the one surface a person tried and could not use. `McpServersFile`, `Registrations`, `ServerSpec` and `/mmcp server` stayed - the inbound path is the whole story now | - |
| **B1** - the MMCP entry in the Options screen | **ARCHIVED 0.143.0**, with A. There is no in-game menu; `/mmcp` is the surface | - |
| ~~**B2** - collapse `/claude`, `/mcptk`, `/review` into `/mmcp`~~ | **BUILT 0.141.0, 2026-09-08.** One root from `CommandRoot`, five registration sites, no aliases; arbiter `probes/mmcp-commands.test.mjs` in chunk b. A3's vocabulary rode along (`[Claude]` -> `[MMCP]`, the `MCP_TOOL_TIMEOUT` gloss, the stale "Claude menu" prose); the `"claude stop"` chat trigger is kept beside `"mmcp stop"` on purpose, being a kill switch rather than a name. `RELEASE_1.md` B2 has the Brigadier merge finding that decided where the permission sits | - |
| **D4** phases 2-3 - `regen_region`, a fresh world at a seed | Designed (`WORLDGEN_ITERATION_DESIGN.md` 2.2, 2.3), not built | Descope. Phase 1 answers "did my push land"; phase 2 is destructive and four traps deep. |
| **D6** - list rows named by `get_screen` / `click` | Not started; the enumeration question (index space vs `rows`) is unanswered | Descope, and say so where `get_screen` reports `unenumerated_listeners`. |
| **E1** - datagen from the running game | Codec half done (0.100.0); the Gradle half untouched | Descope. It is a Gradle invocation, and `generateUi` already shows the shape a consumer wires themselves. |
| **E2** - a gametest seam | Nothing | Descope. The record itself says it is a seam for a mod's own tests, not a framework. |
| **E3** - sound and particles | Nothing (`playSound` appears nowhere) | The cheapest of the five to build; a `run_command` route exists today. Descope unless a consumer asks. |
| **E4** - multiplayer / second client | Nothing | Descope; the don't-build list already fences it. |
| **E5** - a stack in the world, its components | Partly served by `roll_loot`'s `components`; the in-world read does not exist | Descope; `bot_container` is the route with hands. |
| **E6** - advancement progress | Nothing; the loot half is done | Descope. |

**Written 2026-09-06 on the recommendation column**: `LIVE_MODDING.md` now carries a "Not in
release 1" table under its decision table - one row per item, the route today, and why it is
absent. If the owner decides to BUILD one of them instead, delete its row; the table is the descope
and nothing else records it. B2 is not in that table: it is a rename, not an absence, and it is
still the owner's call.

---

## 5. Hygiene still open

- ~~**F4 - honest refusal off Windows.**~~ **DONE 0.125.0**: `Platform.isWindows()` is the one
  definition; `ServerExtract` returns a sentence naming the extracted directory and the `npm install
  --omit=dev` to run by hand, `ObsSupervisor` the `node record-supervisor.mjs` line, and
  `ClaudeCodeClient` uses the shared check. Unexercised off Windows, by construction.
- **F7 - the consumer install path.** The README exists (2026-09-06). `/mmcp server register <dir>` is the
  registration path - the MMCP screen it used to name was archived at 0.143.0 and the ask that
  covered it went with it. **Found by the production-client run of 2026-09-10** (2.3):
  `docs/guides/ADAPTER.md`, the one guide this release's audience follows, was still sending the
  reader to **Options -> MMCP -> MCP servers** two paragraphs after its own header says that half
  is archived. That paragraph is deleted; the `/mmcp server register` one below it already said
  the same thing correctly. `rocketeer/.mcp.json` still pins
  `MCPTK_PROFILE: full` to work around a hole 0.107.0 closed; `menagerie/.mcp.json` names no profile,
  which is now correct. **Dropped 2026-09-06** (uncommitted in the rocketeer repository): rocketeer
  sessions now get the default `modding` (54 tools, ~26.8k tok/turn) instead of `full` (106,
  ~47.5k), and `rocketeer_authoring` is one `tool_surface` call away.
- **F8 - the release number and packaging.** Undecided. Today the toolkit reaches a consumer by
  mavenLocal coordinate (`EXTENDING.md` Quickstart, `build.gradle` `publishing`) and the shim by
  extraction from the jar. Nothing is published anywhere reachable from outside this machine.
  Deciding whether release 1 is "clone the workbench and `publishToMavenLocal`" or a downloadable jar
  changes the README's first section and nothing else in the code. **Decided 2026-09-06 (the
  dash's step 0):** a static Maven on GitHub carrying the toolkit jar and the convention plugin
  marker, plus a GitHub Release of the jar; built in the dash's step 3 (`RELEASE_1.md` J4):
  `publishAllPublicationsToStaticRepository -Pmaven_repo=<dir>` in both build files, the README's
  first section, `template-mod/`, `gradlew toolkitInit`. ~~NOT DONE, and a human's: creating the
  `maven` branch and the GitHub Release, and pushing them~~ **DONE 2026-09-10 evening.** The
  `maven` branch is an orphan in `mattjesmc/MMCP` carrying `com.mattmc.mcptoolkit:mcp-toolkit`
  0.145.0 (jar, sources, pom, module) and `com.mattmc.gradle:gradle-conventions` 0.7.0 with its
  plugin marker, written by the two publish commands and never by hand; the GitHub Release is
  `v0.145.0` with both jars attached. **One trap, found and fixed before the push, worth the
  sentence: a Maven repository is CONTENT-ADDRESSED** - every `.pom`, `.module` and
  `maven-metadata.xml` has checksums beside it that Gradle verifies byte for byte, Gradle wrote
  them with CRLF on Windows, and git's autocrlf normalised the blobs to LF on `add`. The stored
  `.sha1` then did not match the stored file: a resolution failure that reads like a corrupt
  repository. The branch carries `* -text` in `.gitattributes` and all eleven artifacts were
  verified against their sidecars FROM THE COMMITTED BLOBS before pushing. **The README still
  says mavenLocal, and correctly**: `raw.githubusercontent.com` serves a private repository only
  to an authenticated request, so the URL starts working when the repository is made public -
  which is the owner's call and the one thing here nobody but the owner should make.
- **`body/asset-roundtrip`.** One commit not on the shipping branch (17 files, +3,394 lines; the
  "100 commits" this file said before was the branch's whole history), based at 0.95.0, 30 toolkit
  versions behind, listed in `docs/README.md` and the README's task table as "built, not merged".
  Either rebase and re-run its probes (its own record says all 359 of the game's models survive the
  trip), or take the row out of both maps so the release does not advertise a branch. **Decided
  2026-09-06 (the dash's step 0): descope.** Thirty versions is not a rebase, it is a rewrite; the
  row left the README's task table and `docs/README.md` now says descoped (dash step 3), and J1's
  emitter is written so the branch's `extras` could call it if it is ever revived.
- **`main`** is 132 commits behind and is NOT where the release lands. **Decided 2026-09-06:** the
  release lands as a FRESH SNAPSHOT in a new repository, `https://github.com/mattjesmc/MMCP`
  (private at the time of writing, one placeholder commit), because this workbench's history
  carries everything the same-day cleanup archived (Village Jobs, the survival postmortems, the
  OBS rig; `docs/archive/README.md` "Left the repository") and a fast-forward would publish it. The
  workbench stays the development checkout; MMCP is what the README's install path points at.
- **The docs' second half (`RELEASE_1.md` section G).** Structure landed 2026-09-06. Done the same
  day: the shim's default `instructions` paragraph (mcp-server 0.59.0; a project's `loop.json` still
  overrides it) and `docs/guides/SESSION_CHARTER.md`, the modder's counterpart of `CLAUDE.md.tpl`
  and `SURVIVAL_CHARTER.md`, whose first block is that paragraph's site of record; and the changelog
  left `build.gradle` for `CHANGELOG.md` (73 versions, sorted newest first, prose verbatim; the two
  entries that had been written under `0.99.0` sit together under it). Not done: the README's first
  section from the F8 answer.

---

## 6. The order to close it in

Steps 1, 2, 5 and the descope half of 4 are done (2026-09-06); what is left needs a human or the
owner.

1. ~~One sequential battery on a client at 0.124.0~~ **DONE** (2.1), reds diagnosed and rerun green
   at 0.125.0 (2.2, 2.4). ~~The next whole run is owed at 0.125.0~~ **DONE** (2.4, 861/5, the five
   closed), and the six files the two late client changes touch rerun on the rebuilt jar, 66/0
   (2.4). ~~One battery IS still owed before the tag, and it is not a rerun: the same run on a
   client started `-Pfabricapi=true`, the arm no whole battery has ever been on (2.7)~~ **RUN
   2026-09-10, BOTH ARMS: fabric-api at 0.144.0 / 0.72.0, 108 files, 901/8, both failing files
   probes outliving their subject and both green after the fix (2.8); loader-only at 0.145.0 /
   0.73.0, 108 files, 903/0 (2.9).** The two arms agree file for file. That answered the never-tested
   arm, the arm the loader-only claim rests on, and twelve toolkit / nine shim versions of drift.
   **Nothing on this line is owed any more.**
2. ~~Diagnose the three reds~~ **DONE**: all three were the host (2.2).
3. **The human sitting** (section 3), with the production-client run from 2.3 folded in. The
   title-screen arm no longer needs the sitting. **Mostly done 2026-09-09/10**: the sitting stopped
   on the MMCP screen (which is now archived), then the rest of the queue was walked - `review-card`
   and `review-walk` `ok`, `scan-overhead-voice` answered by driving it and one shipped-classifier
   bug fixed out of it. ~~Three items remain~~ ~~**TWO remain**~~ ~~**ONE remains**~~ **DONE
   2026-09-10 evening**: `scan-overhead-lush-cave` came back `ok` and the two chat-routing hand
   checks ran green (3.1). The review queue has no open ask. **This step is closed.** `launch/failed-boot` was a fourth until 0.144.0, when its row was dropped
   rather than posted (section 3); **the production-client click was the third until the same
   day, when it turned out 0.124.0 had made it a boot rather than a click and the boot ran
   green** (section 2.3). Of the two chat checks, 1.1 has also lost the failure it guarded and
   keeps only its positive half (section 3).
4. **The decisions**: ~~B2 (`/mmcp`)~~ **taken and built 0.141.0**, F8 (packaging, and with it the
   README's first section), the `body/asset-roundtrip` branch, rocketeer's `MCPTK_PROFILE: full`
   pin. None needs a game.
5. ~~F4's three guards~~ **DONE**.
6. ~~The changelog leaving `build.gradle`~~ **DONE** (`CHANGELOG.md`); the README's first section
   from the F8 answer remains.
7. **Land the snapshot in MMCP, tag.** ~~Not a fast-forward (section 5, `main`): an orphan commit
   of the working tree at the release version, pushed to `mattjesmc/MMCP` `main`, tagged there;
   the `maven` branch and the GitHub Release (F8) are created in that repository.~~ **DONE
   2026-09-10 evening: `cf2e0be` on `mattjesmc/MMCP` `main`, tagged `v0.145.0`, GitHub Release
   `MMCP release 1 - MCP Toolkit 0.145.0` with both jars.** 757 files, 11.9 MB, the tracked tree
   exported with `git archive` so nothing untracked could ride along. **Not an orphan commit in
   the end, and the reason is worth keeping**: "orphan" in this line meant "carries none of the
   workbench's history", and MMCP `main` held two commits of its own - a placeholder README.
   Committing ON TOP of those carries no workbench history either, and needs no force-push to
   destroy a history that was already there. The snapshot's root README is the workbench's with
   an MMCP front page above it: what this is, the release's verification in three lines, that it
   is a snapshot and has no commit log to read, the two accepted limits, and the Mojang
   disclaimer. Checked before the commit: the three stubs are stubs, zero machine paths, zero
   credential-shaped strings, `LICENSE` present. Before the snapshot:
   the release docs leave (`RELEASE_1.md`, `TODO.md`, `docs/archive/TODO_SHIPPED.md` go to the
   archive repository; this file becomes the record) and the machine-specific paths are
   neutralised. The workbench and its history stay here, unpublished.

   **DONE 2026-09-10 evening, and both halves of that sentence were wrong about their own size.**

   The docs left, but they could not simply be deleted: **`RELEASE_1.md` is cited by 86 tracked
   files and `TODO.md` by 39** - 25 Java sources, 5 tests, some 20 probes, `build.gradle` and the
   shim among them, all citing section numbers as provenance. Deleting them outright would have
   published a snapshot in which 125 citations name a document that is not there, which is the
   exact defect sections 3.1 and F7 spent the day removing. So each path keeps a **stub** naming
   where the document went and what replaces it here, and every citation still resolves.

   The paths were the opposite surprise. This step said EIGHT tracked files carried a machine
   path and named them - the template's five client registrations, a probe's rocketeer path, a
   `rebuild.ps1` example, the root `settings.gradle` comment. **Not one of those still had one.**
   What the tree actually held was seven mentions, every one of them narrative prose in a design
   record ("written from the ArmorPieces record at ..."), plus one usage example in
   `tools/loop/analyse.mjs`. **No functional path anywhere**: nothing a consumer runs would have
   broken, and the risk this line was guarding had already been paid off by `toolkitInit`
   rewriting registrations. All eight are neutralised (`<workbench>`, `<home>`, `C--Users-you-`).
   A fifth instance of this document describing a tree it had stopped matching.

**Added 2026-09-06, after the ledger above: the dash.** `RELEASE_1.md` section J adds four upgrades
before the tag - a source-tree scaffold, `checkAssets`, a crash fold on `get_log`, and the install
path (F8 recommended as a static Maven plus a template repository and `toolkitInit`). Its cost against
this section is stated there: one more whole battery and one more human sitting, and the whole
section prices at ~120 manifest tokens. Step 4 above absorbs the F8 decision; the dash's own order
sits between steps 4 and 7.

**Added 2026-09-06, later: the consumer's gate.** `RELEASE_1.md` section K folds ArmorPieces' six
asks (`TODO.md` 4.5) into the same dash as steps 4-6 (0.129.0-0.131.0): `ping.build` and a
`context` column, `get_tooltip` and `create_world`, a living subject in the studio with a frozen
tick. The battery and the sitting move to step 7; section K5 has the cut order. **K1-K3 BUILT
2026-09-06** (0.129.0-0.131.0): what is left before the tag is step 7 itself.
