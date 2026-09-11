# MCP Toolkit changelog

One entry per toolkit version, newest first. This was the comment block above `version =` in
`build.gradle` until 2026-09-06 (RELEASE_1.md section G); it moved here verbatim, sorted by version,
and nothing else about an entry changed - the prose is as it was written on the day, including its
citations by bare filename (`docs/README.md` maps them). A new version gets a new `##` section at the
top; the mcp-server (shim) version it ships with is named inside the entry when it changed.

## 0.146.0

**THE GAME SPEAKS MCP NOW, ON A DOOR OF ITS OWN.** `POST http://127.0.0.1:<bridge port>/mcp` is an
MCP server hosted in this jar: no Node, no `npm install`, no extracted copy of anything, no process
for a client to spawn and hold. Point any client that speaks MCP over HTTP at that URL and it is
talking to the running game. `docs/platform/IN_JAR_MCP_DESIGN.md`.

**The Node shim and the private `/tools` + `/cmd` API are untouched and remain the supported path.**
They have to be: an MCP client spawns its servers when the CLIENT starts, which is routinely when
Minecraft is not running, and only a process that outlives the game can be there to be spawned and
serve its local tools honestly while the game is down. The new door cannot do that and never will —
if the game is not running, there is nothing to connect to. What it buys instead is that **nothing
has to be installed for it**, that **there is no second copy to go stale** (the 2026-08-10 finding
was a deployed 0.63.0 shim against a 0.69.0 game, leaking six dev tools into a restricted profile for
weeks — on this door the tools ARE the running registry), and one thing the old door could not do at
all.

**That one thing: a port that carries a surface.** `ARCHITECTURE.md` has said since 0.107.0 that it
could not — "the port serves the whole manifest over a private API, and the profile belongs to the
shim process a session starts" — and named the price of fixing it: an MCP server in the JVM, the
slicing moved into Java, and the shim-only layers left behind. That is exactly what this is, clause
by clause. **The URL is the surface**: `/mcp` serves the configured default, `/mcp/observe` serves
the reads. Three built-ins and only one of them is a list — `full` is the registry, `observe` is
COMPUTED from the `Mechanism` stamp every tool already carries (so a read that ships tomorrow is in
it and nothing has to be maintained), and `modding` is an allow-list seeded from the shim's
`MODDING_KEEP` and independent from that date on. A project declares its own in
`config/mcptoolkit-surfaces.json`, where a declared surface INTERSECTS its base's keep-list rather
than replacing it: "base modding, keep these four" must never be a way to get a tool modding does not
serve.

**What does not come through the new door**, and it is a limitation rather than an oversight: the
`mem_*` memory layer, `bot_scan`, `launch_game`, `tool_surface`, the Blockbench upstream, the image
budget, the loop-file gate, the route ledger. Those are per-session policy and a second upstream —
the business of a process a session starts, not of the game. A model is told which door it is on, in
the `instructions` it meets at initialize.

**`BridgeServer.execute` was extracted first, and the endpoint built second.** Both doors enter
dispatch at the same chokepoint, so argument checking, the intent record, the loop hop and its
timeout, the mechanism stamp, the embodied and client envelopes, **the audit record** and the
oversize tripwire are one implementation and not two. A world edit that arrives unaudited because it
came through the newer door is precisely what a second implementation would have produced, silently.

Decisions that are worth the line, each of them the honest answer rather than the cautious one:
`tools.listChanged` is declared **false** (the registry is filled during mod init and nothing adds a
tool to a running game — the shim declares it true because the shim's list really does change), so
`GET /mcp` answers 405 rather than opening a stream that would never carry anything. A failed tool
call is a **result** with `isError:true`, never a JSON-RPC error: the refusal is the answer and the
model is the one that has to read it. A cancellation is accepted and ignored, because a handler on a
game loop stopped half-way is how a world edit lands in pieces. A POST with no session id that is not
`initialize` is served and handed one — out of order by the spec, and exactly what a person with
`curl` does. An `Origin` that is not loopback is refused outright, which is the spec's DNS-rebinding
rule and what stops a page the human has open from driving their game.

`mcp.enabled=true` and `mcp.surface=full` in `config/mcptoolkit.properties` (a file written before
this version has neither key and inherits both). `/mmcp mcp` in game prints the URL, the surfaces
with LIVE tool counts — the only check a keep-list gets — and the `claude mcp add` line.

77 new unit tests, `McpTransportTest` among them driving a real socket through initialize →
notification (202) → list → call → DELETE → 404, and **two clients at once** — two transport ids, two
surfaces, two toolkit sessions, and a DELETE that takes exactly its own. `McpConn`'s 30-minute idle
reap is asked against a stated clock rather than left to a wall clock nobody will wait out;
`Surfaces.install` writes its documented default and that file is then read back through this
parser, which is the only way the shipped text can be wrong and somebody find out before their
second boot; `BridgeConfig` has a test at last (`Platform.install` is the seam the class's own note
said it lacked), covering what a pre-0.146.0 file inherits and whether the commented default states
what `load()` reads back; and `/mmcp mcp`'s text moved out of Minecraft into `McpReport`, so the
per-surface count — the only check a keep-list ever gets — is asserted against a registry rather than
read off a screen once. **And RUN LIVE** against `gradlew runServer`
(`IN_JAR_MCP_DESIGN.md` section 9): 73 tools at `/mcp`, 31 at `/mcp/observe`, `ping` answering out of
the real instance, `ArgCheck` refusing a bad call through the new door with the same message `/cmd`
gives, and an `audit` event carrying the toolkit session the door minted — the two claims above that
are worth more than an assertion. The server was stopped through the door it was being tested on.
The live run also changed the code once: a sessionless POST no longer mints a toolkit session (five
probing `curl`s had left five live "clients" in `/mmcp mcp`), because an anonymous caller should stay
anonymous rather than leave an entry the reapers believe in. What is still owed is a real client's
handshake rather than `curl` shaped like one.

**And the door is now WATCHED.** All 110 probe files in the suite drive `/cmd`, so a regression in
`/mcp` would have reached a release with a green battery — there was nothing for it to land on.
`probes/in-jar-mcp.test.mjs` (14 tests, green, declared into `battery.ps1` chunk b on the day it was
written) runs the handshake, the three surfaces, the shared chokepoint and the transport rules live
and without the shim. `observe` is checked against `GET /tools` in both directions, which is the
check a computed surface can have and a keep-list cannot. The old door was re-checked after its
dispatch path was split — `arg-check`, `event-stream`, `attach-identity`, `headless-surface`,
`context-column` (28/28) and `conformance` (44 pass, 6 client-skipped) — and `Sessions.touch` was
moved back ahead of body parsing in `handleCmd`, so a malformed `/cmd` body still refreshes liveness
exactly as it did before.

**And the full battery was re-run on it** (`RELEASE.md` §2.10): **109 files, 916 pass / 1 fail**, one
part, 29 minutes, same save and same loader-only arm as the 0.145.0 release battery, with
`in-jar-mcp` green at 14/0 inside it. **107 of the 108 files shared with that run scored identically**
— the first evidence that this version changed nothing it did not mean to. The one red,
`render-camera`'s "the player is put back where they were standing", was 17/0 alone afterwards; its
restore assertion passed and nothing here touches rendering, so §2.10 records it as undiagnosed
rather than explained.

## 0.145.0

**A WINDOW IS TAKEN WHEN THERE IS WORK, NOT WHEN A SESSION WAKES UP** (shim 0.73.0, plugin 0.9.0).
`BLOCKBENCH_ISOLATION_DESIGN.md` section 11.13. 0.144.0 built the dock to manage a mess of windows;
this is the line that was MAKING the mess, and it had been there since long before any of it.

Reported the same day, after a restart: *"I just started blockbench and 4 session windows instantly
opened"* and *"closing the windows still reopens them, still no control."* One cause for both.
`fetchBlockbenchTools` runs on the tool-list WATCHER - every session, on a poll cadence, whether or
not anybody ever touches Blockbench - and it called `resolveWindow`, which claims or CREATES. So
every live session demanded a window the moment it noticed Blockbench was running, and a window a
person closed made that session's `/tools` fail, drop its `windowState`, and ask for a replacement on
the very next poll. **The windows were never leaking. They were being demanded, by sessions that had
no work for them, and a person could not close one at all.**

**A manifest is a property of the plugin, not of a window** - every window serves the same `/tools` -
so reading it needs no ownership. `peekBase` takes whatever answers and claims nothing; a window is
allocated at the first CALL, which is the first moment a session has asked Blockbench to do anything.
Presence moved with it, and had to: it registers a session IN A WINDOW, so a session with none has
nothing to register, and a socket opened at discovery would have landed in whichever window happened
to hold the first port of the range. An idle session now owns nothing, asks for nothing, and appears
nowhere - and a window a person closes stays closed, because nothing is waiting to re-demand it.

One behaviour changed on purpose: a session that cannot have a window now still SEES the Blockbench
tools and is refused at the call instead of being shown an empty surface. The refusal is the same one
it always was; only its timing moved, to where the ownership decision itself now lives.

**And the dock could be two.** Live: two windows both answering `role: "dock"`, each having written
its own port into the shared settings every other window reads, so a window was told a different
address depending on which one answered and the roster split in two. **The lowest port wins** - the
one fact both windows can see, neither can argue with, and nothing has to be exchanged to agree on,
which is the same reason the port is a window's name. The higher stands down into an ordinary window,
drops its roster and panel, and goes looking for the winner; `openDock` refuses up front rather than
letting the scan clean up after it.

274 offline-green in the plugin suite (6 new) and 16 in `blockbench-surface` (1 new). Both new
regressions were falsified against the old code: the idle-session probe goes red under eager
allocation, and the two-dock probe leaves two docks each listing the other.

**THE LOADER-ONLY WHOLE BATTERY RAN AT THIS VERSION: 108 files, 903 pass / 0 fail, one part, no
restarts** (`RELEASE.md` 2.9). It is the second of a PAIR - 0.144.0 carries the fabric-api arm (2.8)
- and the pair is the point. The arms were each proved by 2.7's own tell reading opposite ways: 51
mods with the two `No data fixer registered for mcptoolkit:drone` lines ABSENT on the fabric-api
client, 5 mods with both lines PRESENT here. **Compared verdict by verdict, 105 of 108 files have an
identical pass count on both arms**, and the three that differ are the seven archived-launcher cases
removed from `agent-client`, this version's new `blockbench-surface` case, and a `review` row that a
person had poisoned - none of them the arm. That is the claim 0.80.0 made nobody able to assert: not
that the toolkit works on each arm, but that it behaves the SAME on both. The two runs are one
version apart because this version landed mid-battery; the delta is section 11.13's window
allocation, which is shim and plugin surface and never touches the registry door the arms differ at.


## 0.144.0

THE MCP DOCK: THE PLACE THAT OUTRANKS A WINDOW (shim 0.72.0, plugin 0.8.0).
`BLOCKBENCH_ISOLATION_DESIGN.md` section 11. 0.142.0 gave a Blockbench window an owner and then left
every window to govern itself out of its own memory. A live scan on 2026-09-10 said what that costs:
**six windows serving, every one of them empty, and not one with a death condition that could fire.**
Three were never agent-born, and `armEmptyCheck()` returns on its first line for those, so their
sweep had never started - a window that is not agent-born had no death condition at all, ever. Three
were held by sessions that had not gone away. All six sat maximised at the same coordinates under the
same title, which is what "some windows are hidden from Windows entirely" turned out to mean.

The last-window guard was the obvious suspect and is innocent: the fear was that a renderer's
`fetch` to another window would be refused by CORS, and it is not - tested live, an Electron
`file://` origin is let through. The guard runs correctly on the rare occasions it runs at all.

Five findings, all one shape - **a window deciding something about itself, alone, from state that
does not survive.** `agentBorn` was one in-memory boolean set from a 120-second `localStorage`
handoff and never correctable. An empty window could not be commanded at all, because every tool
including `risky_eval` resolves a project first. **Nothing anywhere had a close route**: `POST
/window` created and nothing destroyed. The last-window check was check-then-act with no arbiter, so
three windows idling into the same sweep could all close and quit the app. And `GET /hello`
registered a session, so one window was found holding eleven records left by shims that had only
scanned past it.

**So the window stays the unit of ownership and stops being the unit of government.** The dock is one
dedicated window that owns the roster, hands windows out, arbitrates every close, is never claimed
and never closes itself - which turns "never the last window" into an invariant rather than a race.
It ASSIGNS each window its role and can REASSIGN it, which is what lets a window stuck as somebody's
own be recycled. It keeps two pictures on purpose, the port scan (what is SERVING) and a pushed
heartbeat (what is ALIVE), because every broken state is a disagreement between them: `silent` is
serving but not reporting, `ghost` is reporting and then gone, `orphan` is an agent window standing
empty. Allocation reuses before it creates and answers with the PORT, which deletes 0.7.0's race
where the asker could not know which port its window would win and had to go and scan for it.

The shape is forced by a ceiling worth recording: **Blockbench's plugin sandbox allows no `electron`
and no `@electron/remote`** (`js/native_apis.ts`, `getModule`), so there is no `BrowserWindow`
list to read, nothing to focus from outside and nothing to destroy. Every cross-window act is
therefore a request the target window serves for itself - `POST /close`, `/focus`, `/role` - and a
window whose bridge is stopped can be named and dated by the dock but only closed by a person. Said
plainly rather than discovered later. (Blockbench's own `all_wins` is no help either: `main.js:171`
nulls `win` before `indexOf(win)`, so `splice(-1, 1)` drops the wrong entry.)

Four fixes found alongside it and shipped with it: `GET /hello` no longer creates a session record; a
bridge window carries its PORT in its title, so a stack of them is tellable apart from the taskbar;
the crash-recovery guard's `quitting` flag stops latching true after a close the person cancelled,
which had been quietly turning a later full clear into a partial one; and `POST /role` gives a
non-agent window a recycle path.

With no dock open every one of these paths falls back to exactly what 0.7.0 did, and a shim that has
never heard of a dock reads one as a person's window and leaves it alone. 268 offline-green in the
plugin suite (35 new), 15 in `blockbench-surface` (2 new), and RUN LIVE against the six-window
Blockbench that opened the section (11.12): a dock opened from the menu path, listed all eight
windows with their roles and last calls, closed a 0.8.0 window, refused itself, and refused a 0.7.0
window for the honest reason that its plugin has no close route. The live run also found a bug no
stub could: the pre-claim on a window opened FOR a session had never worked across windows, because
the session record lives in the window that was ASKED and not in the one that is born, so every such
window had been answering "unclaimed" to the next scan since 0.7.0.

**Three release-document repairs rode along, none of them code.** (a) The dist's own
`package.json` still described itself as "extracted from the mod jar by the in-game Claude
bootstrap" - a bootstrap 0.143.0 archived - and that string SHIPS to whoever installs the server, so
it now says what actually happens: extracted into the game directory when the mod starts. (b)
`launch/failed-boot` is dropped from `RELEASE.md`'s sitting rather than posted. It had been carried
as an owed human walk since 0.126.0 and had never existed in any `asks.json` on this machine - a
card that was never made, not a walk that was owed - and the read it would have bought (does the
exit-1 tail name the crash report and the reason) is the read `crash-summary` already covers green,
reached through a deliberately broken mixin instead of a fixture. `RELEASE_1.md` J3 had already kept
it out of the battery by design. (c) `tools/rebuild.ps1` gains `-FabricApi`, which is the only thing
that stood between this tree and the one battery still owed before the tag: the script that launches
the game every battery has ever run against could not pass `-Pfabricapi=true`, so the compatibility
arm was unreachable from the loop that runs the battery. It rides the launch, not the build.

**AND THE BATTERY RAN: 108 files, 901 pass / 8 fail, on the fabric-api arm, at this version**
(`RELEASE.md` 2.8). The arm was proved before the run by the tell 2.7 wrote down for the purpose -
51 mods loaded and the two `No data fixer registered for mcptoolkit:drone` lines ABSENT. Both
failing files are probes that outlived their subject and neither is a defect in shipping code.
`agent-client` 6/7: seven cases asserted the outbound launcher 0.143.0 archived, so they were
removed and the six inbound cases that remain - hello, external session identity, the orientation
pointer, every dev tool answering with no client configured - went 6/0. `review` 5/1 is the more
interesting one: **the layer was correct and the QUEUE was poisoned.** A person had answered
`probe-review-checked`, the probe's own synthetic ask, with `ok`; `sweepChecks` then refuses to
re-evaluate it (human verdicts are records of what a person said) and a re-post preserves it, so two
correct rules made a one-way door and the probe could never pass again. Clearing the row returned
6/0 with the referee filing `checked`. The class is still open: a probe-owned ask should never reach
a human's walk at all. Three long-standing reds came back green - `ranged-pressure` (red in every
previous whole battery, including on a deliberately quiet host), `check-path-r1` case 3 (red on
every whole run since 0.124.0), and the 21 minimized-window reds of 2.6, which confirms 0.134.0's
`ScreenSpaceMixin` under a whole battery for the first time. Two of those changed alongside twelve
versions and an arm, so they are data, not diagnoses. `tools/battery.ps1`'s standing chunk WARN was
also acted on: `paint-code` had named no probe file since the loop kit's rename while `loop-examples`
sat in no chunk, so chunk b carried a dead name and skipped a live file at the same time.

## 0.143.0

THE LAUNCHER LEAVES, AND THE MENU WITH IT (shim 0.71.0). The first human walk of the release queue
(`RELEASE.md` section 3) stopped on its first screen. The MMCP screen's button sat off screen unless
the window was maximized, did not move sensibly with GUI scale, drew its session lines in the wrong
places, and answered "connect my agent to this game" by asking the person to type the absolute path
of a mod directory. Three asks came back `no`. **The finding was not three bugs but the wrong
screen**, and the owner named what the surface was for: let a user point their own agent program at
this game. Everything else on it - kits, model and effort pickers, chat routing, a bypass toggle,
subtitles, an OBS button, a list of Claude processes found by scanning the machine - was the launcher
the screen had accumulated, for a workflow the release's audience does not have. A modder drops a jar
in `mods/`, runs their agent program themselves, and needs exactly one thing from the game: a
registration that dials the right port.

**So the outbound half is archived**, in `mcmodding-archive` at its workbench paths: the three
screens and the Options entry, the kit machinery (`Kit`, `Kits`, `KitMaterializer`, `BuiltinKits`,
`KitFile`, `FileRole`, `HookSpec`, `WritePolicy`, `Continuity`, `LaunchMode`, `MaterializedKit`), the
client adapters (`AgentClient`, `AgentClients`, `SpecAgentClient`, `Capability`, `Detection`,
`AgentLauncher`, `AgentConfig`), the whole `claude/` package (`ClaudeCodeClient`,
`ClaudeSessionRegistry`, `ClaudeSubtitles`, `TranscriptTailer`, `LaunchPrefs`), `AgentReview`,
`CompanionSessions`, `ObsSupervisor`, `LaunchCommands`, and the kit payload in
`resources/mcptoolkit/bootstrap/`. About 5,900 lines. What stayed is the inbound half and nothing
else: `McpServersFile`, `Registrations`, `ServerSpec` and `/mmcp server register|remove <dir>`.

**Three tools left the manifest** - `companion_spawn`, `companion_stop`, `session_send` - because all
three only meant something with a launcher behind them. `session_list` survived and moved to
`SessionTools`, rewritten over `Sessions.live()`: the honest form of the question the archived menu
answered badly, since it listed OS processes whose working directory matched the game folder rather
than sessions that had actually handshaken with this bridge. The shim's `modding` keep-list and
`survival` hide-list follow; `conformance`'s spec table drops three entries under its own
every-spec-has-a-tool ratchet.

**Two things are deliberately gone rather than replaced.** The `"mmcp stop"` / `"claude stop"` chat
kill switch: it killed processes THIS GAME HAD STARTED, and the game starts none, so a word typed in
chat could not stop somebody else's process and should not pretend to. And `ping`'s whole `agent`
block, which reported which client this game could launch sessions in. `routes-cli.mjs --spawn` went
the same way, and `docs/guides/ADAPTER.md` - "Writing an agent-client adapter" - is now the inbound
guide it always kept in its section 0.

**One defect fixed in passing, from 0.141.0's bundling**, and it is the kind worth naming: in check
mode `toolkitInit` reported the Blockbench plugins as WOULD_WRITE without asking whether anything
could write them. A jar built before 0.141.0 (or a dev classes directory) carries no
`blockbench-dist/`, so the real run then failed to extract, recorded nothing, and the next check
reported WOULD_WRITE again - a `--check` that no run could ever turn green. The new `UNAVAILABLE`
fate says "there is nothing to write this from", and does not count as a disagreement.

**What this costs.** `RELEASE_1` section A - the agent-client adapter seam, the kits, the launcher -
is out of the release; the four `mmcp/*` and `agent/*` asks in the review queue are retired with it,
and the three `agent/launch/*` asks describe a surface that no longer exists. The survival profile
keeps its tools and loses the harness that used to start it; that harness is in the archive with the
rest.

**And one perception bug, found by walking a review card instead of arguing with it.**
`scan-overhead-voice` had sat in the queue since 0.86.0 saying in its own words that "a tally is not
a world" and that nobody had read the new sentences in place. Walked at last on 2026-09-10, two of
its three arms were right - a forest floor at -41.5,94,73.5 read ON THE SURFACE, a body submerged at
-682,51,457 read UNDERWATER, and a deep sculk cavern at 271,-9,-193 still got the cave voice. The
third failed exactly where the card said the expensive failure was. In a LUSH CAVE at 303,38,-184 -
sky light 0, fifty-three blocks of stone and andesite overhead - `bot_scan` answered "ON THE SURFACE,
NOT UNDERGROUND ... the roof overhead is cover ... to get underground you must dig DOWN". The cause
was that `SURFACE_ONLY` listed `short_grass`, `tall_grass` and `moss_carpet` while its own comment
promised blocks that CANNOT be underground: lush caves grow all three, so the veto that exists to
stop a forest being called a cave was calling a cave a forest. The three leave the list; the offline
probe gains the measured tally that failed and the measured forest floor that must keep its line, and
the first fails against the old list, which is what makes it a test. The live half was then run
through a freshly spawned shim, because the session's own had `scan.mjs` loaded before the edit: the
same spot now answers `overhead:solid` and "underground, at OPEN SPACE: sightlines run ~38 blocks N",
and the forest floor keeps its line. `scan-overhead-lush-cave` stays open for a person's eyes, which
the review layer deliberately does not treat as the same fact as an agent's read.

## 0.142.0

WHOSE WINDOW IT IS, AND HOW ONE ENDS (shim 0.69.0, bridge plugin 0.7.0). Step 2 of
`BLOCKBENCH_ISOLATION_DESIGN.md` went in front of a person for the first time and worked in every way
a harness could see - windows appeared, two sessions landed in two windows, nothing was corrupted -
while failing in three ways no stub was ever going to show. Section 10 of that record is the design
and the reasoning; `BLOCKBENCH_BRIDGE_DESIGN.md` section 16 is the as-built. Their common shape is
worth naming first: **each one is the difference between a window that exists and a window that is
SOMEBODY'S.** Step 2 built ownership of a window by a session and never asked who a window belonged
to before a session got there, or who it belonged to afterwards.

**Nothing ever closed a window.** `POST /window` had no counterpart anywhere - no route, no menu
item, no sweep. A claim died with its presence socket, correctly, and the window stayed open, empty,
forever; an afternoon of sessions left a row of identical empty windows at ~220 MB each, with a
sixteen-port span to fill, for a person to close by hand. An agent-born window now closes itself when
it has no live claim, no open projects, and a grace period has passed in which a shim whose presence
dropped can rejoin. The clock hangs on the CLAIM, not the tab: `project op:close` emptying a window
ARMS it rather than deciding it, because a session that closes one piece and opens the next has not
finished. Requiring zero projects is what keeps this compatible with the rule that expiry releases
but never destroys - a window with nothing open has no work to destroy. **Never the last window**,
because closing that quits Blockbench and an agent finishing its work is not a request to shut the
app; a renderer can only count windows by asking the range over http the way a shim does, and a
window whose bridge is stopped answers nothing, so the mistake this can make is always "stay open".
**And never through `closeBlockbenchWindow`**, which is module-scoped after esbuild and unreachable
anyway - going around it with `allow_closing` plus `window.close()` turns out to be the safer half of
the bargain, since the function we cannot call is the one that wipes EVERY window's crash-recovery
backups. An automatic close cannot destroy another window's entry even where the 0.4.0 guard is
absent. The port is given back first, so a shim scanning in the same second finds a shut door rather
than a dying one.

**A window was takeable unless a person remembered to protect it.** `takeable` was *not reserved and
not claimed*, so the window somebody was working in was the first thing a scanning shim took unless
they had used `Reserve this window` first - a flag you find out about by losing your tab, and it made
the ordinary case (a person with Blockbench open, an agent starting up) the dangerous one. **The
default is inverted: a window is the person's unless the plugin was ASKED to open it for an agent.**
`POST /window` leaves the asker's id in its own storage key and the next window to WIN A PORT
consumes it - consumed and not read, so two asks make two agent windows and a window opened by hand
stays the person's - and only an agent-born window is claimable. Nobody protects anything. The entry
also PRE-CLAIMS that window for whoever asked, which closes a real race: the port a new window will
win is not knowable to the asker, so it has to go and scan, and another session's scan could take the
window the first one had just paid two seconds for. `reserved` survives on `/hello` as a DERIVED
field so a shim from before the flip goes on leaving a person's window alone, and the shim reads
`agent` where it is offered and falls back to `reserved` where it is not - both sides again, or
neither.

**An abandoned window looked taken for two minutes.** `claimHolder()` asked `alive(s)` - *connected,
or seen within `hold_ms`* - the same predicate as a project binding, so a session that died between
claiming a window and its next tool-list poll (that poll is what opens presence) left a ghost claim
standing, and the next session opened another window rather than reusing it. The fix is a distinction
that should have been there from the start: **the hold timer protects unsaved work in a BINDING; a
window claim protects nothing, so it dies with the socket.** The only grace left is the seconds a
fresh claim needs before presence can have arrived, which is also exactly what a pre-claim needs.

**And a window that says whose it is.** Until now the only place that fact existed was `/hello`, from
outside the app. The TITLE carries the holding session in front of whatever Blockbench last wrote, so
a taskbar full of windows is readable without focusing them - a `MutationObserver` on the `<title>`
node, because `setProjectTitle` is module-scoped like everything else interesting here, and the old
prefix comes off by being REMEMBERED rather than by matching a shape, so a project called
`[wip] dragon` keeps its own brackets. A PANEL says the rest: the kind of window, the holder, the
port and window id, the bound project and tab count, the countdown while it is emptying, and the last
twelve calls with their cost.

**Donation is inverted with the default and is the only way a person's window is ever claimed**:
`Let agents use this window`, stored by port for the reason the reservation was (one settings store,
read at boot and written back whole, so a stored flag would hand over every window at once). It is
honest about its cost - an agent there still steals the active tab whenever it reads its own model.
**Co-authoring is not this and is deliberately not built**: working BESIDE a person is `connect`, a
route that INHERITS an open window and therefore needs what a fresh one never does - an account of
the projects already open in it and a way to move between them. `TODO.md` 4.6 carries it. Not needed
for release 1, which is LM-first.

Harness 233 checks (28 new), shim probe 13 tests (2 new, including a plugin from before the flip
still being read the old way). What no stub reaches is unchanged and is still the live arm, plus one
thing 0.7.0 adds to it: `window.close()` actually removing a window, which the harness can only count
as a call.

## 0.141.0

ONE COMMAND ROOT, AND THE BLOCKBENCH PLUGINS SHIP IN THE JAR (shim 0.68.0 and all three plugins
unchanged). `RELEASE_1.md` section B2 and `TODO.md` 1.10 - two release blockers that both needed
nothing but a keyboard, taken in the window before the tag.

### B2 - `/claude`, `/mcptk` and `/review` become `/mmcp`

Three roots existed for no reason beyond the order they were built in, registered from five files.
They are one tree now - `server`, `client`, `session`, `chat`, `body`, `fakeplayer`, the workshop's
`edit`/`frame`/`save`/`cancel`/`canvas`, and `review` - with `CommandRoot` as the single site of
record for the name. **No aliases**, and that is the whole argument rather than an omission: the
case for doing this at all is that it is free exactly once, before the first person outside this
machine has typed one of them, and an alias spends that while keeping three names alive in every doc
and every habit it was meant to retire.

**What building it found, and it decided the shape.** Brigadier's `CommandNode.addChild` merges
same-named literals by absorbing the new node's CHILDREN and its command, and KEEPING the existing
node's `requires` predicate. Three roots could not be bitten by that - every `/mcptk` registration
happened to pass the same predicate and `/claude` was a separate root - but one root registered from
five files is decided by class-loading order, silently, on the question of whether a plain player
can see the tree. So the root is unguarded and byte-identical from every caller
(`CommandRoot.root()`) and the gamemaster gate moved DOWN onto each subtree
(`CommandRoot.gated(name)`). That is the better answer on its own merits too: `/mmcp chat status` is
a fair question for anyone on a server, and `/mmcp server register` is not.

**A3's vocabulary rode along, which is the entire reason this moment was called cheap.** `/claude`
was its largest item and is gone by construction. With it: the `[Claude]` chat prefix is `[MMCP]`
(under an agent-client adapter the client may be Cursor or Gemini, and a session announcing itself
as Claude is simply a false statement), the muted-file message, `EventTools`' `MCP_TOOL_TIMEOUT`
gloss - which named a Claude Code setting inside a description EVERY client reads, and now names it
as one host's spelling of a thing every host has - and the "Claude menu" prose that B1 had already
made wrong. `ClaudeCommands` is `LaunchCommands`, and `/claude survival` did not survive: it was a
shortcut for a kit `launch` already takes by name, and a shortcut whose only merit was a shorter
root does not outlive the root getting shorter.

**One thing deliberately kept.** The `"claude stop"` chat trigger still fires, beside `"mmcp stop"`.
It is not a command root but a substring a person types in a panic, and the thing you type in a
panic is the thing you remember; a kill switch that misses because the word changed is the worst
failure that switch has. Both spellings, forever, and the reason is written where it lives.

**The arbiter B2 named.** `probes/mmcp-commands.test.mjs`, chunk b: every subtree answers AND
answers as itself (a fragment only that subtree produces, because six trees merging into one root
can answer with the wrong one), and the three old roots are UNKNOWN. The second claim is the one
that could rot - Brigadier keeps whatever is registered, so a half-done rename leaves both alive and
looks fine from the inside while the docs and the review card quietly disagree about which is real.
A fourth case guards the third from passing for the wrong reason: an incomplete but REAL subtree
(`/mmcp server register`, no directory) must not read as unregistered, or case 2 would keep passing
over a root that had been deleted outright. `run_command` answers ok:true for a command that merely
parsed and for one that did not, so every assertion reads the OUTPUT TEXT.

### 1.10 - the Blockbench plugins ship in the jar

THE BLOCKBENCH PLUGINS SHIP IN THE JAR, AND TWO BUNDLES GOT THE CHECK NEITHER HAD.

**The hole.** The built jar carried `mcp-server-dist/` and nothing else of ours. `processResources`
copies `../mcp-server` under that prefix and there was no `from(file('blockbench'))` anywhere, so
`mcptoolkit_bridge.js`, `mcptoolkit_sync.js` and `mcptoolkit_entity.js` existed only in this working
tree - through six versions of the bridge plugin, unnoticed, because on THIS machine every install
instruction names `mcp-toolkit/blockbench/...` and that is a real path. It is a real path for nobody
else. A consumer who resolves the jar from a Maven coordinate has no workbench checkout, so the door
to the entire Blockbench half - the shim's own upstream since 0.133.0 - was a file they could not
reach. Found while publishing 0.140.0 to mavenLocal, and it is a RELEASE defect rather than a
present-tense one: nothing here is broken today and the live arm is unaffected.

**Bundling is four lines; getting them out was the decision.** Three routes were open (extract beside
the shim, a menu action that writes one out, or leave them a repository artifact and say so in the
install steps) and the first is taken, for the reason that also answers the objection to it. The
objection was that a plugin extracted per world save is three copies of a file whose version must
match the shim's. The answer is that they are written INSIDE the shim extract's own `fresh` branch,
under the shim's `.extracted-version` stamp and no second stamp of their own: if the shim under a
game directory is version N, the plugins beside it are version N, and there is nothing for them to
drift against. That is the whole argument, and it is why "beside the shim" is not merely a convenient
directory. `ServerExtract` writes `<gameDir>/mcptoolkit/blockbench/` on every dev boot and on every
production version change; `ToolkitInit` writes `<repo>/.mcptoolkit/blockbench/` once, write-if-absent
exactly like the shim it sits beside, because a file already there may be one a modder edited and
that task's contract is that it never rewrites yours. A refresh is the dev boot's job, which is the
only place a refresh can be safe.

**Neither failure is allowed to take the other down.** A jar with no `blockbench-dist` is a build
defect, not a modder's problem, and a modder who never opens Blockbench must not lose every launch
to it: `ServerExtract` logs what is missing and carries on, and `ToolkitInit` turns it into a note
("a jar built before 0.141.0") rather than failing a run that otherwise succeeded. The loud arbiter
is a test, where it belongs.

**The check that would have caught it, and the one beside it that has been owed twice.**
`BundledResourcesTest` reads the PROCESSED resources - the classpath, which is what `jar` zips - so
it answers about the artifact rather than about the build script's text. Two claims, each shaped to
how its bundle actually goes wrong. The plugins are an EQUALITY against `blockbench/*.js`, so a
fourth plugin the glob somehow misses is a red and so is a stale copy left after one is deleted; the
copy rule is a GLOB rather than a whitelist for the same reason, and `*.test.mjs` does not match it,
so the harnesses stay out of a jar that would otherwise offer one as a loadable plugin. The shim is
a REACHABILITY closure instead - every module `index.mjs` imports, transitively, resolves inside the
dist - because an equality would be wrong there: that whitelist excludes the probes and the ablation
harnesses on purpose. What must hold is that a fresh extract can be IMPORTED, and that is precisely
what the whitelist has broken twice (`ablation/view.mjs`, then `upstream/blockbench.mjs`, absent for
versions, each killing every fresh extract at import time rather than at use time). The include
whitelist's own comment has recorded that trap for two versions without anything enforcing it.

**Docs.** `LIVE_MODDING.md`'s Blockbench link now says where the files are on each side of the
release and which copy to trust; `blockbench/README.md` says this directory is their site of record
and not the only place a consumer finds them; the README's `toolkitInit` paragraph names the new
directory. **Deliberately not fixed, again:** the dist `package.json`'s `"version": "0.13.0"`
(`TODO.md` 1.10) - `ServerExtract` compares that file's BYTES to decide whether npm must run, so
changing the string costs every consumer an npm install for a label.

## 0.140.0

TWO OLDER PLUGINS TOLD WHICH GAME, AND A GENERIC LOOP EXAMPLE (plugin 0.6.0 / sync 0.4.0 /
entity 0.3.0 / shim 0.68.0). `TODO.md` 1.8 and 1.9, both written and both closed on 2026-09-08.

**1.9 - the hardcoded port, and the project a name reached without a check.** `mcptoolkit_sync.js`
and `mcptoolkit_entity.js` are not tools of the bridge; they are globals (`mcptoolkitPush`,
`mcptoolkitEntity`) that `risky_eval` happens to see, and nothing was rewritten when the bridge
replaced the third-party plugin. Each carried a bare `http://127.0.0.1:25599/cmd`, and since
per-project bridge ports (RELEASE_1.md B0) that port NAMES the toolkit's own dev game: from a
consumer repo's Blockbench, `File > Push to Game` and the entity plugin's four `stage_entity` calls
went to 25599 whatever game the session was driving - refused when nothing was there, and accepted
silently when the toolkit's own game was up. Neither settings store had a port key, so there was no
correcting it either. And both resolved a project by NAME and then switched the active tab, which is
the one route the session binding cannot protect: the bridge's own resolution refuses with `held_by`
BEFORE it selects, so the binding was not merely inapplicable through these two, it was bypassable.

One fix, both gaps, the shape `PROJECT` already decided. The shim is the only component that knows
both ends, so it says: the game URL rides its session block (the `POST /claim` carries it, and so
does every `/cmd` - a superset of the plan in 1.9, chosen because a claim that 404s, is refused, or
never happens must still deliver the URL); the bridge plugin keeps it on the session record beside
the project binding; `risky_eval` injects `GAME` beside `PROJECT` in all three of its shapes. Both
older plugins now take an explicit `bridge` and a project OBJECT, so
`mcptoolkitPush({project: PROJECT, bridge: GAME})` cannot resolve wrongly in either dimension.
**The hardcoded port does not survive as a fallback** - a plugin handed no bridge REFUSES, by the
same argument `mcptoolkit_sync.js` already made for `sourceRoot`: a wrong-but-plausible default is
how a file lands somewhere nobody is looking, and a wrong PORT is worse than a wrong path because
somebody else's running game accepts it without a word. A NAME is refused too, pointing at
`PROJECT`; selecting is not what was wrong (the bridge selects too, `ensureSelected`) - reaching a
project without an ownership check was. The escape hatch that never existed exists now: a **Game
bridge** field in both plugins' UI, remembered per project, and `bridges: {}` in both settings
stores. `LIVE_MODDING.md`'s two port passages moved with the code, as they said they would.

**1.9's testing, and what it does not reach.** `mcptoolkit_sync.js` HAD NO HARNESS - which is most
of why this survived: a hardcoded URL looks right in a diff and is only wrong from a repository
whose game is elsewhere. `blockbench/mcptoolkit_sync.test.mjs` is new (33 checks): the transport is
recorded, so which URL was dialled and which project's pixels were collected are asserted from
evidence rather than from the code's own claim, including a stub whose `select()` deliberately
leaves the globals stale so that reading `Texture.all` instead of the object is a red. The bridge
harness gained seven checks for `GAME` in all three eval shapes, the session record, and null for a
session nobody told; `blockbench-surface.test.mjs` asserts the shim puts it on the wire. Every one
was falsified by breaking what it guards. What the stubs do NOT reach is unchanged and stated in
each harness's header: Blockbench's own `select()`, `Texture.canvas`, `Format.codec.compile`, and
whether a second window even HAS these two plugins loaded - that is `TODO.md` 3.4 step 6, and it is
not runnable without a live Blockbench.

**1.8 - the shipped loop example named thirteen tools that no longer exist.** The plugin's surface
was migrated at 0.133.0 and `tools/loop/examples/armorpieces.loop.json` was not. Its `profile.keep`
carried thirteen names of the third-party plugin (`activate_texture`, `paint_with_brush`,
`draw_shape_tool`, ...) plus notes teaching them; `index.mjs:1466` warns about names the manifest
lacks, so the ghosts were LOUD, while the ten tools that replaced them - `texture`, `element`,
`paint_faces`, `paint_ascii`, `inspect`, `create_texture`, `apply_texture`, `export_model`,
`animation`, and `project`, the entire session-binding surface - were simply never served, because a
keep-list that MISSES a present tool is silent (`index.mjs:1490` carries that lesson already). It
also re-added `trigger_action`, which `art` excludes on purpose, since `profile.keep` is absolute
rather than a filter over its base. And its `run` pointed at a `tools/check_active.py` that existed
in nobody's tree, so the checks a modder copied did not run either.

Replaced rather than migrated: ArmorPieces is a separate project and MMCP ships its own generic
examples. `tools/loop/examples/block-model.loop.json` authors one Minecraft block model - geometry
and texture in Blockbench, exported into the mod's resources, pushed into the running game - and
ships its checker, `check-block-model.mjs`, beside it. Two things in it are worth reading before
copying: the check fires after `export_model` rather than after every edit, because a `run` check
sees the FILESYSTEM and the filesystem only learns about the model when it is exported; and the
gate is on `push_asset` rather than on `export_model`, because gating the tool that feeds a check
deadlocks it. `docs/guides/LOOPS.md`, `LOOP_KIT_DESIGN.md` section 5.6 and its section 9 step 6 name
the new file.

**And the check that would have caught it.** `probes/loop-examples.test.mjs`: every shipped example
loads, every script its `run` names ships beside it, its keep-list IS the served set against both
pinned manifests (an equality, so a ghost name and a forgotten real one both fail), its gates name
tools this shim serves, and the checker it ships is executed against a good model, a broken one, an
unexported one and a missing assets root. The end-to-end test is the file as shipped: an exported
model with an element past Minecraft's y=32 refuses `push_asset`, is forced past with a reason, and
stops refusing when the model is fixed and re-exported. `blockbench-surface.test.mjs` pins
`BLOCKBENCH_KEEP` and reaches nothing under `tools/loop/examples/`, which is exactly how the old
file rotted through the migration unnoticed.

**Two loose ends of the bridge's own record, closed in the same pass.** The first was
`BLOCKBENCH_BRIDGE_DESIGN.md` section 9's oldest open bullet: a `tools/call` arriving before this
session had ever BUILT a manifest named a tool the shim had not yet heard of, so it fell past the
Blockbench branch, went to the GAME bridge, and came back "unknown tool" - a sentence about the
wrong process. It had been recorded and not fixed because listing on an unknown name reads as a
guess at the caller; what makes it not a guess is the narrower trigger. The lazy list fires only
while the session has NO Blockbench manifest at all, the one state in which an unknown name has no
list to be a typo against, and the watcher closes that window within `WATCH_DOWN_MS` of start - so
this is a race, not a regime, and after it nothing fires again. One fetch in flight, never oftener
than the watcher's own cadence, and a shut Blockbench costs a refused connection. Claim 6 of
`blockbench-surface.test.mjs` is the falsifier, and it was run red: with the lazy list disabled the
call lands on the stub GAME bridge instead.

The second is in a consumer, and it is the one that matters for the live arm.
`measure_sessions.py` (ArmorPieces) read session ids out of reply text, and a `held_by` refusal
names the HOLDER - the fix reads a session's OWN stamp (`ping`'s `blockbench` block, the shared-id
note) apart from what it quotes about another, and prefers it. Re-run over the 69-transcript corpus,
**every id it had ever collected turned out to be another session's**: four rows carried one, all
four were holder-quoted, and no session in any era stamped its own. The A/B's numbers stand (no era
moved), but its identity column was never evidence - which is why `TODO.md` 3.4 step 2 now asks
every session of the contended re-run to call `ping` once, so that the column finally is.

**Published to mavenLocal, which is where 3.4's other prerequisite turned out to be.** mavenLocal
held nothing newer than 0.136.0: 0.137.0, 0.138.0 and 0.139.0 were committed here and never
published, so no consumer could resolve them whatever its `build.gradle` said, and a consumer arm of
the live A/B run before this would have measured the 0.136.0 shim under a 0.139.0 label. Checking
the 0.140.0 jar afterwards found the second thing: it contains `mcp-server-dist/` and nothing else
of ours, so the three Blockbench plugins ship only in this working tree while `RELEASE.md` section 1
said "in the jar". The table now says what is true and `TODO.md` 1.10 owns the gap - it costs the
live arm nothing (every install path here is a real file) and costs a release everything (the door
to the Blockbench half is a file a jar consumer cannot reach).

## 0.139.0

A WINDOW EACH (plugin 0.5.0, shim 0.67.0). Step 2 of `BLOCKBENCH_ISOLATION_DESIGN.md`, decided on
2026-09-08 by the A/B that ran both arms: two sessions started together produced two pieces in 16.4
minutes where the same two in sequence took 14.8. Concurrency bought NEGATIVE wall clock, and not
because anything broke - `risky_eval` was 0 in both concurrent runs, nothing was corrupted, no session
wrote into another's piece. It was serialisation. The second session was refused ten times, retried
three times, and first held a piece of its own three and a quarter minutes AFTER the first had
finished. Step 1 plus the binding fix had turned a damaging failure into a total one.

**The mechanism, in one sentence.** A session has no binding until it has a piece, so the call that
would give it one has nothing to name and resolves against the active tab - which, in one window,
belongs to whoever is currently working. There is no way to share one window safely (section 4 of that
record: one project is live at a time, and an agent reading its own model must be able to read), so
the window becomes the unit of ownership.

**The port is the window's name.** Each window's plugin now listens on the first FREE port at or above
the base (25801, sixteen wide) instead of on one stored port - which is also a bug fixed: a second
window used to load a second copy of the plugin, fail its listen with EADDRINUSE into a field nobody
reads, and serve nothing. `GET /hello` carries the window block a scanning shim needs: `window` (a
name that changes when the plugin restarts), `port`, `base_port`, `span`, `reserved`, `claimed_by`.

**Two routes, both refusing the way `/cmd` does** (200 with `ok:false`, the holder named, a hint with
the way out). `POST /claim` gives a window to one session at a time, releases it the moment that
session's presence socket closes, and answers a rejoin as a rejoin; `POST /window` opens another
window. That second one exists because a shim CANNOT make a window: relaunching the exe with the same
`--userData` forwards to the running instance and exits 0 (measured, section 8), so creation belongs
to the plugin and a shim with nowhere to go has to ask.

**Tools > MCP Toolkit Bridge > Reserve this window** is how the person at the keyboard keeps one. A
reserved window is never claimed, never asked to host, and never taken as the sharing fallback - the
shim would rather serve no Blockbench surface, and say so on stderr, than work in the window somebody
said was theirs. The flag is deliberately NOT persisted: settings are one store every window reads at
boot and writes back whole, so a stored flag would reserve them all.

**The shim's half.** It scans the same range, asks each window /hello, and REJOINS the one already
carrying its session id, else CLAIMS the first that is neither reserved nor held, else ASKS one for
another and claims the port that appears, else SHARES an unreserved window and says so. Everything
after the first step is a fallback that ends in the old behaviour, because a shim that cannot get a
window of its own must still work. `MCPTK_BLOCKBENCH` gained a third form: `host:from-to` is a range
to discover over, a bare URL still PINS one window exactly (which is what a person means by writing
one down, and what every probe does), and `off` still disables the upstream. While the presence
connection is open the window cannot have changed under us, so the reconcile - one /hello, and a
re-claim or a rescan - costs nothing in the normal case.

**`held_by` is untouched, on purpose.** Through the whole contended pair it did its job. The goal of a
window each is to stop NEEDING the refusal, not to weaken it, so the per-project guard and the
active-tab refusal from 0.138.0 both stand exactly as they were.

Harness 192 checks (was 160), and the shim's probe 8 tests (was 4): a taken base port makes the window
walk, two shims in one range take a window each and each one's calls land in its own, a shim that
finds every window taken asks for another and claims what appears, a reserved window is never taken,
and a window that can be neither had nor multiplied is shared with a sentence on stderr. Three
falsifiers were run and all three bite. What no harness reaches is the second REALM - that a new
window really does load a second copy of the plugin and win the next port - which is the live arm,
`TODO.md` 3.4.

One harness defect fixed while it was being written: a probe that registered its cleanup after the
assertion that could fail HUNG the runner on the live child and the listening stub instead of
reporting a failure. Cleanup is now registered as each thing is made.

**NINE DEFECTS, FOUND BY READING IT RATHER THAN BY RUNNING IT.** Step 2 was reviewed before its live
arm on the reasoning that four sessions and two 200k-token transcripts are an expensive way to find
what a read finds for nothing. What it found, and what was done:

- **The consumer's half was still pinned to 25801** - and that is the process which authors the
  piece. ArmorPieces' proxy computed the right session id and then called a fixed port, so a second
  session's shim would take a window of its own while its proxy went on calling into the FIRST
  session's window and being refused there: the A/B's own failure, reproduced by the fix for it, and
  the contended re-run would have measured the pin. Its `tools/mcp/server.mjs` now runs the same
  ladder (rejoin, claim, share), `.mcp.json` no longer pins a URL, and `check_kit.mjs` arbitrates in
  the window the pair claimed rather than on the base port. Verified against stub windows: the shim
  and the proxy of one session land in ONE window, and a window another session holds takes no call
  from either.
- **Two discoveries could run at once** (shim). Asking for a window takes up to twelve seconds and the
  tool-list watcher is only sequential with ITSELF, so a `tools/call` arriving mid-ask would scan
  again and post a second `POST /window` - a stray empty Blockbench nobody claimed. One in-flight
  promise now, which every caller waits on.
- **A stop during the port walk left a door open** (plugin). The listen is asynchronous, so `stop()`
  had nothing to cancel and the pending callback landed afterwards and set `server`: a window serving
  on a port the person at the keyboard had just given up. A generation counter cancels a walk in
  flight, and a cancelled walk reports no error rather than "every port is taken" out of a bridge
  that never started.
- **Any JSON on the range passed for Blockbench** (shim). A single configured URL never asked
  strangers; a sixteen-port scan does, and the sharing fallback would have quietly sent every call of
  a session to one. `GET /hello` must now answer `app: "blockbench"`. The range is written into the
  port ledger too (`gradle-conventions/src/main/groovy/com.mattmc.mcmod.gradle`), which stopped at
  2569x and knew nothing of it.
- **The presence socket could end up in a different window from the claim** (shim), leaving a session
  known to its own window only by the two-minute `seen` timer - the exact thing presence exists to
  prevent. A window change now drops the socket and the next poll reopens it where it belongs.
- **An unopened Blockbench cost sixteen refused connections every three seconds** (shim), because the
  watcher's down-cadence now drives a scan rather than one connect. An empty scan is not repeated for
  fifteen seconds.
- **A reservation did not survive a Blockbench restart** (plugin), so the human's window was the first
  one an agent claimed until they remembered to re-reserve it. What is stored is the PORT, the one
  shape a single shared settings store can carry: a stored `reserved: true` would reserve every
  window at once.
- **Nothing told a session which window it got** (shim). `ping` now carries `blockbench: {port,
  window, held, session}` and the "blockbench up" line names the window. That is the fact the live
  arm has to watch, and until now it could only be read from inside one window at a time.
- **The ninth was a fix that had to be DELETED.** A lowest-port tiebreak was built here first, for two
  processes of one session claiming two windows. Removing it turned nothing red - both compute one
  id, both walk the range in port order, and the plugin answers the second one's claim with a REJOIN
  - so it was insurance against a race that cannot happen, at the price of a second full scan on
  every claim. The invariant is written down where the machinery stood.

Harness 205 checks (was 192) and the shim's probe 10 tests (was 8). Every new check was falsified,
and two of them were REWRITTEN when the first falsifier showed they never reached the code they were
named for - a check that cannot go red is not a check.

## 0.138.0

TWO THINGS A SECOND WINDOW BREAKS (plugin 0.4.0; the shim is unchanged at 0.66.0). Both were found
by the 2026-09-08 measurements rather than by use, both are small, and both are worth having before
step 2 rather than inside it - because each one bites exactly when a second session appears, which
is the situation step 2 is for.

**The active-tab fallback handed out another session's piece.** A session with no binding has nothing
to resolve, so it falls back to the active tab - which in a shared window belongs to whoever is
working. In the contended arm of the A/B a refused session asked about *its own* project and was
answered with 23 cubes and the bones of somebody else's. Reads are unrefused by design and that stays
true for a project the caller NAMES (`BLOCKBENCH_ISOLATION_DESIGN.md` section 4: an agent reading its
own model must be able to read it, which is also why a shared window can never be made safe). It was
never true of the fallback, which is a guess about what the caller meant, and the guess must not be
"whatever a stranger has open". `resolveProject` now refuses at that one point, with the same
`held_by` block a held edit already returns and a hint carrying all three ways out: make your own,
list the tabs, or name theirs on purpose. Everything else about the fallback is unchanged - an
unheld active tab still resolves, still carries the unbound note, still says it once.

**Closing any window wiped every window's crash recovery, and now it does not.** Blockbench's close
path clears the whole shared backup store while checking only its own projects for unsaved work.
Measured on alternating trials: three unpatched closes out of three destroyed a canary belonging to
another window - which also corrects the design record's earlier guess, read out of the code, that
the wipe was fire-and-forget and would often lose its race with teardown. It does not. The guard is
ten lines and lives at `onload`: wrap `window.onbeforeunload` for a reliable "we are quitting" flag,
and replace `AutoBackup.removeAllBackups` with one that removes only `ModelProject.all`'s uuids while
that flag is set. Off the quit path the original still runs, because the start screen's Discard
button is a legitimate caller of a real full clear. `onunload` puts both back.

Why those two hooks and no others, all verified in the running renderer before anything was written:
`window.AutoBackup` IS the object every internal caller holds and `closeBlockbenchWindow` looks the
method up at call time, so replacing the method reaches them all; `closeBlockbenchWindow` itself is
module-scoped after esbuild and cannot be patched; and `before_closing` fires thirteen lines AFTER
the wipe, which makes the obvious hook the useless one. `onbeforeunload` is the sole origin of every
path into the close.

The harness is 160 checks. Reverting either fix turns it red - the fallback one on three checks, the
guard on one - and the guard's checks pin both halves of it: quitting drops only this window's uuids,
and a call outside the quit path still clears everything.

## 0.137.0

THREE REPLIES MADE TRUE (plugin 0.3.0; the shim is unchanged at 0.66.0). Every one of them is a case
where the Blockbench plugin said it had done something it had not, which is the worst failure a
bridge tool has: an agent that cannot trust the reply reaches for `risky_eval`, and 0.135.0's
measurement already established that the eval count is what a loss of trust looks like in the
numbers.

**`project op:new {bind:false}` - a throwaway must not take the binding.** Found by the concurrency
A/B's solo arm (`BLOCKBENCH_ISOLATION_DESIGN.md` section 7, TODO.md 1.9), in the consumer, but the
mechanism is ours: `op:new` bound the session unconditionally, which is right for a piece and wrong
for a scratch. ArmorPieces' proxy makes its `armorpieces_scratch` from an error path, and its
`dropScratch` closes that scratch only when it is not the active tab - so a session came out BOUND
to a project it meant to discard, and every later unqualified call resolved there by binding, which
outlives the scratch stopping being the active tab and which their own "am I bound?" guard could not
see (it asks the proxy, and the proxy thought it was unbound). Measured on three solo runs:
`no piece is open` 22/28/30 times, `risky_eval` 23 against a clean baseline of 0.0, $6.16 for a
piece that costs $2.19. One argument closes it. `bind:false` creates and makes active without
binding, and the reply says which project the session kept instead - or, when it had none, that the
fallback now resolves to the throwaway on the active tab, which is the honest answer rather than a
silent one. This makes the trap unavailable rather than merely avoidable: `project op:close` already
cleared bindings, so a consumer that closed through the tool was always safe, and the point is that
one that does not still cannot lose its identity to a scratch.

**`element op:select` with several names selected one of them.** The loop called `n.select()`, whose
no-event path in Blockbench is `unselectAllElements([this])` before it marks itself (and
`Group.select()` clears every group's flag as well), so each iteration undid the last and only the
final name survived - while the reply returned `selected: [every name asked for]`. It now clears
once and then calls the app's own add-to-the-selection path for each node (`multiSelect` for a
group, `markAsSelected` for an element), which is what Blockbench's own multi-select does after the
clear, and finishes with `updateSelection()`.

**`texture op:remove` made two undo entries while claiming one.** `Texture.remove(no_update)` opens
an `Undo.initEdit`/`finishEdit('Remove texture')` pair of its own unless told not to, so the bare
call nested a second entry inside ours and one removal cost two undos - exactly the shape the
animation path gets right with `a.remove(false)`. Now `t.remove(true)`. What `no_update` also skips
is the refresh, and that is covered: `Canvas.updateAll()` passes no `element_aspects`, so every
element's faces and UVs are rebuilt whole, and the one thing it does not reach - the UV panel's own
hard reference to the texture just removed - is cleared explicitly.

**Both of the last two were invisible because the harness stubs were kinder than Blockbench.** The
stub's `Node.select()` pushed onto the selection without clearing, and its `Texture.remove()` did no
undo bookkeeping at all, so the two bugs passed 143 green checks for a version. They were found by
reading the vendored app source, not by running the tests, and the fix is in both places: the stubs
now reproduce the real behaviour (`select()` clears the others; `remove(no_update)` opens its own
entry unless told not to), which makes each old implementation fail, and six checks pin the new one.
`mcptoolkit_bridge.test.mjs` is 153 checks, and the pinned manifest fixture is re-written for the
`project` schema's new argument. The rule this is the second instance of: a stub that is easier
than the thing it stands for does not test the thing it stands for.

## 0.136.0

IDENTITY COMES FROM THE PARENT PROCESS (shim 0.66.0). Step 1 of
`BLOCKBENCH_ISOLATION_DESIGN.md` section 7, and all of what a keyboard can fix about the
concurrency loss 0.135.0's entry blamed on an inherited variable. That diagnosis was half right and
is now recorded properly: re-measured on 2026-09-07, Claude Code mints a FRESH
`CLAUDE_CODE_SESSION_ID` for a headless child, so nothing is inherited any more. What actually kept
every session one session was the fix - ArmorPieces' `.mcp.json` read
`${ARMORPIECES_SESSION:-armorpieces}` and nothing in that repository ever set the variable, so every
session fell back to the same literal string. Three concurrent sessions were live on this machine
while the record was being written, and the plugin saw one.

Why that is worse than a shared binding, and the reason it is a version rather than a footnote:
`holderOf(project, except)` skips the calling session, so two processes carrying one id are the SAME
session object and `held_by` can never fire between them. A session id is not a label; it is the key
every guard in the plugin is written against, and it rested on a string a human had to remember to
set.

The fallback is now the PARENT process id. Every MCP server of one Claude session is a direct child
of that session's `claude.exe` - verified in the live process table, four ArmorPieces sessions each
parenting both its toolkit shim and its Blockbench proxy - so the parent id is shared by a session's
servers, distinct across sessions, and immune to environment inheritance. It needs no launcher
discipline and no configuration: ArmorPieces' `.mcp.json` now sets no session id at all, in either
block. An explicit `MCPTK_SESSION` still wins, for deliberate sharing.

One thing the design record's step 1 said, that this deliberately does NOT do: keep a per-server
prefix. `shim-${ppid}` beside `armorpieces-${ppid}` is still two identities for one session, which
is the same bug in a nicer costume - and deleting `MCPTK_SESSION` while the two fallbacks disagreed
would have turned the shim's `place_cube` and the proxy's `armorpieces_save` against each other, the
first time anything relied on the fallback at all. Both sides say `mcptk-<parent pid>`; the `client`
field is what distinguishes a session's servers, which is what it was already for.

`blockbench-surface` now asserts the exact number rather than the shape. The probe IS the shim's
parent, so `mcptk-${process.pid}` is checkable from inside the test, and a fallback that went back to
the process's own id fails there instead of passing a regex. 4/4.

Nothing in the plugin changed, and this one is SHIPPED rather than staged: 0.136.0 is published to
mavenLocal, ArmorPieces' `build.gradle` names it instead of 0.135.0, and that repository's
`run/mcptoolkit/mcp-server` was re-extracted from the published jar - 31 files, `.extracted-version`
0.136.0 - so the shim it runs is a release and not the in-place patch the fix was first tried as.
`ServerExtract.ensureFresh` re-extracts unconditionally in dev, which is what keeps it that way.

What this unblocks and does not itself answer: the two-piece A/B. Concurrency cost 14.3 min / $5.15
a piece against 5.2 / $2.19 alone with every session sharing one identity, and nothing yet says what
it costs with identities distinct - which is the number that decides whether step 2 of the design
record (per-window ports) is a fix or an optimisation. The brief is `docs/measurements/
CONCURRENCY_AB.md` in ArmorPieces, written with the fix so the run can be handed straight to that
repository; `measure_sessions.py` there gained an era D and reads the session ids out of the replies,
so a batch that turns out to have shared an id after all reports `SHARED` instead of being averaged
into the answer.

## 0.135.0

A BINDING LIVES EXACTLY AS LONG AS ITS CONNECTION (shim 0.65.0, plugin 0.2.0). ArmorPieces measured
the two Blockbench plugins like for like on 2026-09-07 (`docs/measurements/blockbench-plugins.md`
in that repository; BLOCKBENCH_BRIDGE_DESIGN.md section 12 carries the table): the toolkit's own
plugin costs 57% less per piece and finishes 42% faster when a session has Blockbench to itself,
and their parallel batch erased the whole gain, because its `.mcp.json` derived `MCPTK_SESSION`
from a variable every `claude -p` child inherits - four children were ONE session to the plugin
with ONE binding, every unqualified call landed in another child's piece, nothing said so, and the
exited child's binding then sat "seen 15s ago" and refused the human's own cleanup call. Three of
their six asks built: (1) `risky_eval` binds `PROJECT`, the resolved project, into the code's scope
in all three shapes, so a plugin API is handed the project it must write (`api.save(PROJECT)`)
instead of reading Blockbench's global - a wrong resolution can no longer write silently; (2)
`GET /presence`: the shim holds one never-ending response per process (node:http, unref'd, opened
after a `/tools` poll whenever none is open, so a Blockbench restart reconnects on the next poll),
the plugin ties the session to that socket, and the binding AND the record are released the instant
the socket closes - the two-minute hold timer now serves only a client that never opens one (curl by
hand); `held_by` says `connected` in place of a timestamp, `project op:list` carries `connected` and
`connections`; (3) one id arriving on two sockets stamps `session {id, connections, note}` on EVERY
reply while it holds, naming the one thing a caller can do (name `project` on every call), and the
shim writes the same sentence to stderr off the presence first line. Smaller, from the same
transcripts: `inspect` (zero calls in either era, ask 4) now says when it beats the edit reply;
`capture_screenshot`'s `views` is the recommended look (ask 6). NOT built: phase-narrowed
keep-lists (ask 5) - TODO.md 1.7 has the design and the arithmetic that says measure first.
Plugin harness 143 checks (was 125), the fixture re-pinned; `blockbench-surface` gained the shim's
half (the connection opens under the session id and dies with the process). The plugin in the
running Blockbench is still 0.1.1 until it is reloaded.

## 0.134.0

A MINIMIZED WINDOW RENDERS. The 2026-09-07 battery (RELEASE.md 2.6) put 21 of its 25 reds on one
minimized window, every one of them `render`'s own refusal - "Minecraft gates rendering on that".
It does not. RENDER_SEAM_DESIGN.md trap 7 read `Minecraft.java:1243` as gating the frame; it gates
only the ACQUIRE of the window surface (and the present), the frame itself keeps coming at the
iconified 10 fps, and `render`'s out-of-band pass never touches the surface at all. Measured with
the window iconic: `render` at a new heading came out at the new heading, `screenshot` moved when
a screen opened. The refusal is deleted; the reply carries `window_minimized:true` when it was,
so a transcript can explain a human's missing window. The one red in that battery that was REAL
was ui-conform's TOOLTIP-static, 0 px under the pointer: an iconified window is 0x0 to GLFW,
`Window.onResize` stores that, and `MouseHandler.getScaledXPos` divides by it, so every screen
renders with its pointer at infinity. `ScreenSpaceMixin` falls back to the framebuffer size
(which the window keeps) in exactly the zero case, and `click {hover}`'s inverse uses the same
numbers (`ScreenSpace`). Nothing restores, activates or re-minimizes the window: the tools never
needed it. Probes: `probes/fixtures/game-window.mjs` (user32 through PowerShell, Windows only),
a minimized case in render-camera and a TOOLTIP-minimized case in ui-conform, each minimizing the
real window once and putting it back in a finally. Shim unchanged (0.64.0).

## 0.133.0

THE TOOLKIT'S OWN BLOCKBENCH PLUGIN (shim 0.64.0; BLOCKBENCH_BRIDGE_DESIGN.md is the record).
`blockbench/mcptoolkit_bridge.js` 0.1.0 replaces the third-party "Blockbench MCP" plugin as the
shim's Blockbench upstream. The record had said why for weeks without saying it in one place: that
plugin could not be extended (ArmorPieces' 1050-line proxy, the shim's painters composing
`risky_eval` strings), its 94 tools were a transport for the one the pipeline used, its eval refused
`//` and wedged on a rejected Promise, every tool acted on whichever tab was active (the 2026-08-14
lock directory, "one session per part, sequential"), and its first file write popped a modal that
read as a dead server. The new plugin hosts plain HTTP on 127.0.0.1:25801 in the GAME BRIDGE's own
shape (GET /hello, GET /tools with `mechanism` on every entry, POST /cmd {tool, args, session} ->
{ok, result, mechanism}), so `upstream/blockbench.mjs` lost its MCP handshake, session ids, SSE
parsing and hand-kept read-only list. What it adds that no plugin had: every call is QUEUED, every
call may name its `project`, a session that makes or opens a project is BOUND to it and a call
without `project` goes there (an unbound session acts on the active tab and is told so once), and an
edit on a project another live session holds is refused with `held_by` and the two ways out. 26
tools, designed as the `art` slice: `project` (list/info/new/open/save/close/select/set), `element`,
`inspect` (bounds, face rects, envelope, AABB overlaps, UV collisions), `texture` (ASCII read, the
ops-JSON rects, resize, recolor, flip, load, write), `capture_screenshot` with `fit` and a `views`
CONTACT SHEET, `create_texture` with a size that applies, the two painters native, `risky_eval`
without the comment filter and with rejections as error replies, `animation` (experimental). Every
schema is `additionalProperties:false` and an undeclared argument is refused by name; every edit is
one undo entry and answers with its readback. A picture carries `_image.frame`, so the shim's
content-crop list no longer names Blockbench tools; a mixed tool stamps each reply and `finishReply`
prefers the reply's stamp. `local/paint.mjs` and `probes/paint-code.test.mjs` are gone (the plugin's
harness carries the painter arithmetic); `loop.mjs` no longer refuses an `eval` with a comment.
Arbiters: `blockbench/mcptoolkit_bridge.test.mjs` (116 checks over a Blockbench-shaped stub world,
real PNGs, the real http module; it also pins `probes/fixtures/blockbench-bridge-2026-09-07.json`
and refuses when the pin drifts), `probes/blockbench-surface.test.mjs` rewritten (scope, identity on
every call, `max` stripped, frame flag, reply-stamped mechanism into the loop hook, restart on the
same port), `loop-hook`/`loop-profile`/`image-budget` over the bridge-shaped stub. OWED: the live
arm - a human must load the plugin and grant `process` once (Tools > MCP Toolkit Bridge > Start);
the plugin never opens that dialog by itself because it freezes the renderer for every session.
Migration for a loop file keep-list is in the design's section 5; ArmorPieces' example loop file
is left as the record of its day.

THE LIVE ARM, run the same day (plugin 0.1.1; BLOCKBENCH_BRIDGE_DESIGN.md section 10, the last
row). Two fresh art-profile shims and a third that never listed, against the running Blockbench:
56 steps, and the harness had been green on seven things that were wrong in the app. Undoing a
`place_cube` DETACHED its cubes to root instead of removing them, and a duplicate survived its own
undo: Blockbench snapshots the aspect arrays at `finishEdit`, so a created thing must be pushed
into them (`undoEdit` now hands the aspects to the edit; `create_texture`, `animation` create /
remove / keyframes likewise, the last three had no entry at all). `animation op:keyframes` crashed
on a null: Blockbench's `createKeyframe` ends with `Animation.selected.setLength()` whatever
animation the keyframe went into, so the target is selected first. A north capture of a two-cube
block model showed ONE cube: Blockbench displays a `java_block` scene moved by (-8, 0, -8) and an
entity's cubes where their bones put them, so a camera aimed at cube coordinates looked at the
model's edge; `fit` now frames the meshes' world bounds, the orthographic zoom comes from the
camera's own frustum (it was 2.3x too tight), a locked preset's zoom is applied (Blockbench skips
it), and the camera reply carries `scene_offset`. A multi-statement `risky_eval` without
`return` answered null (the old eval's contract was the completion value; it is again, through an
indirect eval, with an async function for a body that has `return` or `await`). `undo` on an
empty stack claimed `undone:1` (it reports what moved, and `asked`). `element op:duplicate`
ignored `name` and Blockbench's own renaming bumps a trailing digit into a collision ("c1" ->
"c2"); `name` is honoured and a shared name is a `note`. A plain-string `session` on POST /cmd
read as anonymous. Also: a transparent `create_texture` says its faces are invisible until
painted, a missing group names `add_group`. A call to a Blockbench name before the client's first
`tools/list` is forwarded to the GAME bridge ("unknown tool"); every real client lists first, so
it is recorded, not fixed. The bridge reloaded itself from disk twice through its own `risky_eval`
with no dialog (the persisted `process` grant), which is also the proof that autostart works.

## 0.132.0

THE POINTER (RELEASE.md 2.3, the last owed live run with a build in it; shim 0.63.0). The parts
library's dynamic-tooltip half had been "proved only until a screen with a region tooltip is
compared" (UI_PARTS_LIBRARY_DESIGN.md 7.10) since 0.121.0, and the reason was never the screen:
both renderers draw a tooltip from the render call's mouse coordinates (`Paint.tooltips`), those
come from `MouseHandler.xpos`/`ypos`, and only the GLFW cursor callback writes them - a programmatic
`click` carries its own coordinates in the `MouseButtonEvent` and leaves the pointer wherever the
human left it, so no probe could ever have had a tooltip in frame. `click {hover:true}` is the
fourth mode beside press, drag and scroll: the pointer vanilla holds is moved to the target (a
mixin accessor on the two fields, the GUI-to-framebuffer scale inverted from `getScaledXPos`, then
`mouseMoved`) and nothing is pressed, so every frame after renders with it there until the next
real mouse movement; the reply's `over` names what the pointer actually sits on and `blocked_by`
is reported rather than refused (a hover over a covered widget is a real question). It takes no
`button`, wheel or destination, and says so. Arbiter: two new cases in ui-conform.test.mjs, each
measured against the un-hovered frame FIRST so that two frames that both forgot the pointer cannot
pass - over `launch` (static text; inactive, so nothing but the tooltip can change) something
appears beside the button on BOTH renderers and the two frames are pixel-identical; over `ok` (the
hook the sample's stub answers with nothing) whatever changes stays inside the button's own
rectangle on the interpreter and the frames are identical again. Tested live on the dev client in
`New World`: ui-conform 9/9 on its own before the battery. Also in this version: the step-7
battery's WARN named five probes in no chunk (`context-column`, `create-world`, `headless-surface`,
`studio-entity`, `tooltip`), now declared in chunk b of `tools/battery.ps1`. THE STEP-7 BATTERY
(RELEASE.md 2.6): 107 files, 866/25 in eight files on the only game on the machine, all eight green
on isolated reruns - 21 of the 25 a window somebody minimized mid-run (`render` refuses when iconic,
`screenshot` returns the stale frame and does not - owed), and one probe premise each in
attack-goal (any zombie, not the staged one - now by id), conformance (the ratchet catching K2's
two unspecced tools - now declared), perf (`hot_chunks` ranks entities + tickers, the probe read
tickers alone - now the sum); ranged-pressure red in the battery and green alone on a QUIET host,
so 2.5's two-games theory is dead and the case now prints the world's state. Three launches were
killed part-way (two by a log monitor's `tail -f` on the file the battery appends to; one unknown)
and the run finished under `tools/battery-resume.ps1`, new: it scores a version's logs and runs
`-Only` over what is left into the next `-partN.log`, so a killed battery costs minutes, not hours.
ArmorPieces' extract and pin moved to 0.132.0 the same night.

## 0.131.0

THE CONSUMER'S GATE, STEP THREE (RELEASE_1.md section K3 - dash step 6). A LIVING SUBJECT in the
studio, and a tick that holds still. `studio {entity, equipment, yaw, nbt, arms, pose, freeze}` is
the third subject kind beside `id` and `look_at`: a real entity type spawned on the studio's
invisible floor through /summon's own path (`loadEntityRecursive` over the given NBT), no AI, no
gravity, invulnerable, silent, never despawned, facing the camera's stand, wearing stacks given in
full item syntax through `ItemSyntax` (`armor_stand` with arms by default when only `equipment` is
given; `pose` is an armor stand's six rotations). The arrival rule is the block subject's plus one
clause: the reply comes back only once THIS client has the entity in its level. `CanvasStage`
keeps the entity by owner, sweeps it on `leave` and on the next stage, and lays the floor under an
empty box (`stageEmpty`). `freeze` (default true with an entity) sets the server's tick frozen -
vanilla's /tick freeze, mirrored by the client - AFTER the arrival (a tick frozen first is a
subject that never arrives), per owner, the last session out unfreezing. WHAT THE MEASUREMENT
FOUND (K3's rule: the millis half is built only if two renders half a second apart differ): with
the tick frozen a stand in PLAIN diamond photographed pixel-identical five times over three
seconds, and a stand in ENCHANTED diamond differed by ~500 pixels on the glint alone, back-to-back
or three seconds apart alike - the enchantment glint is on the WALL CLOCK (vanilla's
`TextureTransform`: `Util.getMillis() * glintSpeed * 8`), read at render time from the render
state `render` already fills. So `render` sets that state's glint speed to zero while the level's
tick is frozen: the glint still draws, at phase zero, the same on every run and machine; with the
tick running it is left alone, which is what keeps frozen and unfrozen tellable apart. NOT built,
recorded in K4: a `player` body as the subject (the survival fake player is a command, not a
tool surface, and the consumer's layer renders on every humanoid, armor stand included); item
syntax in `bot_give`/`bot_equip`; `click {slot}`. Arbiters: studio-entity.test.mjs - the stand
in enchanted diamond frozen and visible (3x3x3 box, `tick query` frozen), two renders 700 ms
apart pixel-identical with the subject in frame, `leave` discarding and unfreezing, the
FALSIFIER (`freeze:false`, the same pair NOT identical - the glint moves, so a freeze that could
not be told from none is caught), and five refusals by name. Tested live on a dev client in the
flat probe world (its second start, so the studio dimension exists): studio-entity 5/5 after the
clamp (before it, case 2 was the ~500-pixel glint diff that named the clock). Regression on the
same client after all three K steps: render-studio (the block subjects through the new dispatch),
tooltip, headless-surface (HEADLESS.md regenerated: 98 tools, 22 client), context-column,
crash-summary all green; loot-roll 15/17 with the two reds WORLD-COUPLED, not the toolkit's (a
zombie cannot be created in a PEACEFUL world, and `at` alone reads a survival-world site a flat
world does not have) - both to rerun on the standard world in the step-7 battery. JUnit whole:
108/108.

## 0.130.0

THE CONSUMER'S GATE, STEP TWO (RELEASE_1.md section K2 - dash step 5; shim 0.62.0). Two client
tools over calls the toolkit already made. `get_tooltip {item | slot, advanced}`: the lines
`ItemStack.getTooltipLines` renders for a stack given in full item syntax (vanilla's ItemParser,
hoisted into `ItemSyntax` from `roll_loot`'s `tool` so the studio can use it next) or in a slot of
the open container screen, as plain strings, with this client's player and level - the one UI
line a mod writes that nothing could read back. `create_world {name, seed, generator, flat,
gamemode, difficulty, cheats, structures, datapacks, gamerules, replace}`: a world from the title
screen through the same `createFreshLevel` the authoring world uses, flat presets by registry id,
packs copied into the save and named in its `WorldDataConfiguration` before the first load, game
rules applied through `gamerule` on SERVER_STARTED because 26.2's `LevelSettings` carries none.
Dev-only and client-only in the shim, beside `open_world`; `get_tooltip` rides `modding` and
`screens`. WHAT THE BUILD FOUND: the consumer's finding that a pack folder created after the world
loaded is invisible to `/reload` DID NOT REPRODUCE - a valid late pack is auto-enabled as a world
pack, and so is one whose first `pack.mcmeta` was broken and later fixed (the consumer's exact
shape). The tool keeps its reason (a fresh, seeded world with its pack on the first load, every
run) and lost that claim everywhere it was written; the probe's last case pins this build's
behaviour. Also: 26.2 game rule ids are snake_case; a `minecraft:generic` loot table demands a
parameter set `roll_loot` cannot supply, so the fixture is `minecraft:empty`. Arbiters:
tooltip.test.mjs 4/4 in a world (name, enchantment, F3+H id, refusals by name, a placeholder slot
and an empty one) and its title-screen arm; create-world.test.mjs 5/5 GATED
(`MCPTK_PROBE_CREATE_WORLD=1`, client at the title screen - it leaves the client in the world it
made): three refusals before anything is created, the reply, the world up with its pack's table
rolling, the rules read back, the refusal while open, and the measured late-pack case. Tested live on a
dev client, three cycles: tooltip 1/1 at the title screen (the refusal - the first build tried to
parse there and vanilla answered "Components not bound yet" for ANY id, so the tool refuses with
the door named), create-world 5/5 from the title screen (one race found and fixed in the probe:
the integrated server answers get_world_info before the client has joined its level, and a call
in that gap sees no open level; the probe now waits for get_screen to report no screen), then
tooltip 4/4 inside the world it made.

## 0.129.0

THE CONSUMER'S GATE, STEP ONE (RELEASE_1.md section K1 - dash step 4; shim 0.61.0). ArmorPieces'
release suite needed two guarantees before its dedicated-server tier could be WRITTEN rather than
discovered: which tools answer with no client, and which BUILD a bridge is answering for. Both
were facts the toolkit already had and did not say. (1) `GET /tools` carries `context`
("server" | "any" | "client") per entry - every ToolDef's ExecutionContext, lower-cased - and
`docs/platform/HEADLESS.md` is that column as a document, GENERATED by `tools/headless-doc.mjs`
from a client capture (a dedicated server never registers the client tools, so its manifest is
honestly a subset). The shim consumes the column and does not forward it: zero manifest cost.
`CLIENT_SURFACE` stays a hand list - the profiles are built from it at module load, before a
manifest exists - and the column is its FALSIFIER: a client-context tool the list does not name,
or a listed name the bridge says answers headless, is said once on stderr. (2) `ping.build`
{started_at, mods_hash, mods:[{id, version, origins:[{path, mtime}]}], stale}: the JVM's start,
a twelve-hex hash over every loaded `id@version` (fabric-api's sixty modules ride here, not in the
list), and ONLY the buildable mods listed - directory origins (a Fabric dev mod's origin is
`build/resources/main`; its `build/classes/java/main` sibling, which the loader never names, is
added because the classes are what a rebuild changes) and jars sitting in `mods/`. `stale:true`
means an origin is newer than the JVM: the code on disk is not the code running, which is the
exact shape of the failure that cost ArmorPieces a session (a second runClient could not bind the
port, and every call kept answering from the old JVM). The seam's `LoadedMod` gained `version`
on both loaders. Tier 2's datapack question needed no tool and is written into LIVE_MODDING.md:
the pack goes into `world/datapacks/` before the first boot plus `initial-enabled-packs`.
Arbiters: BuildIdentityTest 3/3 (listed vs hashed origins, the classes sibling, stale from a
file two levels down), context-column.test.mjs 4/4 offline on a stub bridge (consistent column
silent and not forwarded; unlisted client tool said; misfiled hand name said; no column silent).
Tested live, both processes: a dev CLIENT at the title screen (headless-surface.test.mjs 4/4,
HEADLESS.md generated from its 96-tool manifest - 66 server, 10 any, 20 client - and the capture
pinned as probes/fixtures/manifest-2026-09-06-context.json, whose 20 client names are exactly
CLIENT_SURFACE's 20), then a dev DEDICATED SERVER (76 tools, 66 server + 10 any, zero client;
headless-surface 4/4, context-column 4/4, crash-summary 5/5). The first live ping found the
plan's one omission: `java` is a loaded mod on both loaders with the JDK DIRECTORY as its origin,
so it walked five thousand JDK files and listed itself as buildable; the pseudo-mods (`java`,
`minecraft`) now ride the hash only. NOT done, said plainly: the three measured fixture manifests
were NOT re-captured (their byte counts pin token measurements in authoring-saving and
loop-profile; the new capture is a fourth file), and the hand list did not "go away" - the
profiles are built from it at module load, before any manifest, so the column is its falsifier
rather than its source.

## 0.128.0

THE INSTALL PATH (RELEASE_1.md section J4 - the dash's step 3; convention plugin 0.7.0). Ten
steps across three repositories become JDK, Node, template, runClient. `gradlew toolkitInit
[-Pclients=claude,cursor,gemini,vscode,codex|all] [-Ptoolkit.check]` adopts a repository for
agent sessions from the jar, with no game and no workbench checkout: the MCP registration in
every client shape from ONE number (`mcmod.port`; a registration naming another port is
corrected and the correction reported - section B0's trap, closed at the file), `AGENTS.md`
(the session charter, copied into the jar from docs/guides/SESSION_CHARTER.md at build so it
cannot drift; CLAUDE.md gets `@AGENTS.md`), `.mcptoolkit/loop.json` with checkAssets as the
gate, `.claude/settings.json` with the tool allowlist, and the MCP server itself extracted from
the jar into `.mcptoolkit/mcp-server` when no registration already names one (ServerExtract's
job, for a repository). `mcpServers` JSON goes through McpServersFile, so every other server in
a file is written back as found; VS Code's `servers` key and Codex's TOML are the two other
shapes. Every file is written once; the human's files are named as still theirs rather than
rewritten. F8 (RELEASE.md section 5): a static Maven - `publishAllPublicationsToStaticRepository
-Pmaven_repo=<checkout of a maven branch>` in both build files, the README's first section
rewritten around it; the branch and the GitHub Release are a human's to create and push, and the
README says mavenLocal until then. `template-mod/` at the workbench root is the new-mod path: a
minimal 26.2 Fabric mod on plugin 0.7.0 with one block written by `scaffold`, adopted by
`toolkitInit -Pclients=all`, compiled (RegisterExampleBlock.class against Loom + fabric-api) and
`checkAssets` clean (9 files, 7 references, 0/0/0 against the merged jar). Arbiters:
ToolkitInitTest (adopt a scratch directory holding a Blockbench server and OUR server on the
wrong port: corrected, Blockbench untouched, every other shape written from the same number,
second run unchanged, check mode writes nothing), and the template itself as the from-zero run.
Found on the way, the third Gradle collision of the dash: `project.hasProperty('check')` is true
because `check` is a TASK, so the dry-run flag is `-Ptoolkit.check`; every property the plugin
reads is now namespaced (`scaffold.name`, `toolkit.check`) or one Gradle has no answer for
(`kind`, `id`, `clients`). NOT built, said plainly: the in-game half of the `modding` kit (a
launch from the game INTO a repository) - the launcher has no workspace argument and needs B2's
command interface; `toolkitInit` is the one materialization that exists. The asset-roundtrip row
left the README's task table (RELEASE.md section 5's descope).

## 0.127.0

THE SCAFFOLD AND THE CHECKER (RELEASE_1.md sections J1, J2, J5 - the dash's step 2; convention
plugin 0.6.0, whose default mcptoolkit_version moves from 0.85.0 to this release). Two Gradle
tasks, neither a tool, both running from this jar in a separate JVM with no Minecraft on the
classpath, exactly as generateUi does. `gradlew scaffold -Pkind=block|item -Pid=<id>
[-Pbehaviour] [-Pscaffold.name=..]` writes a block or item into the mod's own source tree in the sibling
mods' idiom (every 26.2 signature read from vanilla-src and rocketeer's ModBlocks, not from
memory): Register<Id> in <root>.registry, an <Id>Block class only when asked, the blockstate,
both models, the item definition, a placeholder texture hashed from the id, the lang key, the
loot table, the mineable/pickaxe tag entry. It RUNS ONCE AND NEVER REGENERATES - a present file
is left as it is, a second run on the same id is refused, and the two files it merges into keep
every byte they had (textual insertion before the closing brace or bracket, the file's own
indentation and line ending). The creative-tab line is a Javadoc comment, not code: the tab hook
is the loader's and the file must compile on either. Its output is a file list, what is still
yours, and the next four calls verbatim. `gradlew checkAssets` (under `check`) walks the same
edges get_log finds after the game has skipped a file - blockstate -> model -> parent -> texture,
item definition -> model, loot/recipe/tag -> id, block -> lang key and loot table - and splits
DANGLING (fails), UNUSED (warns; block and item textures and models only, because entity, GUI
and particle textures are code-referenced) and UNCHECKED (counted, never silently passed:
minecraft: without the Loom jar, any other namespace, and a tag member of a code registry). The
plugin hands it the Loom jar when it finds one - the merged jar for a plain mod, the common +
clientOnly pair for a split-source-set mod (`--vanilla` repeats) - so minecraft: parents and
textures are real checks. Arbiters: ScaffoldTest compiles the emitted Java with javac against this project's
own Loom compile classpath (a real "compiles against 26.2" with no game), pins the JSON to
rocketeer's own files, and runs the scaffold's output through the checker (0 dangling, 0 unused,
0 unchecked with the jar); CheckAssetsTest plants one of each defect and asserts them BY NAME,
then the repaired tree clean. The four-sibling run the section asked for, recorded: rocketeer
1,373 files / 579 references, 0 dangling, 3 warnings (relic_portal, corridor_tenant,
creature_light have no loot table - deliberate, their own comments say so), 2 unchecked
(entity_type and point_of_interest_type tag members); menagerie 41/59, 0, 1 warning; nijntje
18/8, 0, 1 unchecked; Watercraft 21/33, 0, 0. The first run of that battery found a checker bug,
which is what the falsifier clause is for: tag members of any registry but block and item were
judged against nothing and reported dangling (16 in rocketeer); now a member resolves against its
data category (enchantment, worldgen/biome, villager_trade) and a member of a code registry is
counted. The loop kit: `unit.start` in loop.json (tools/loop/unit-start.mjs, run by run-unit.ps1
before the session, `${unit}` substituted, stdout prepended to the brief, a non-zero exit a
warning because the commonest one is the scaffold refusing a re-attempted unit), and checkAssets
as a `checks[].run` gate; loop-hook.test.mjs 10/10. NOT shipped, on purpose: a block loop file -
LOOPS.md Owed says why (a loop file per rung ships only once measured). TESTED LIVE: the recorded
run into nijntje (plugin pin moved to 0.6.0 for the run, then put back; nijntje is not a git
repository, so the tree was restored by hand): `gradlew scaffold -Pkind=block -Pid=carrot_crate
-Pscaffold.name="Carrot Crate"` wrote eight files and merged the lang key; `gradlew checkAssets`
25 files / 15 references, 0 dangling, 1 unchecked (an entity_type tag member), minecraft:
resolved against nijntje's split common + clientOnly Loom jars; `gradlew compileJava` produced
RegisterCarrotCrate.class against Loom + fabric-api; a second `scaffold` on the same id was
refused with the "already scaffolded" sentence. That run found three things the unit tests
could not: the plugin looked only for a MERGED Loom jar, and a split-source-set mod has a pair
(fixed: `--vanilla` repeats); and the display-name flag collided with Gradle TWICE - `-Pname`
reads back as the project's name and `-PdisplayName` as "root project 'nijntje'", because
Project answers both itself - so the key is the namespaced `-Pscaffold.name`.

## 0.126.0

THE CRASH FOLD (RELEASE_1.md section J3, the dash's first step; mcp-server 0.60.0): the
previous game's death, read by the next one. The log ring lives in the JVM that dies, so
the one line a modder most wants was the one no tool could hand back. `get_log {crash:
"latest" | n | file}` reads `<gameDir>/crash-reports/`: title, exception, thread, the head
trace's top ten frames and each cause's first four, and every frame ATTRIBUTED to the mod
whose jar loaded its class - the class resolves without initialising to its code-source
location, the location to a mod through a new seam method `LoaderPlatform.loadedMods()`
(mod id + the paths it was loaded from; Fabric's ModOrigin plus the root paths'
filesystem, NeoForge's IModFile path), so the answer is the same on both loaders with no
parsing of either one's prose. A loader's own "Suspected Mods" section rides along as a
secondary field when present. A frame no loaded jar provides says `unresolved` rather than
guessing, and the reply says what that means, because a report written by another
project's game in a shared run/ and the very class a NoClassDefFoundError is about both
look exactly like that. `suspect` is the first frame that is somebody's mod - not the
game, the JDK, the loader, or unresolved. `ping.last_crash {at, path, title, read}` names
a report newer than the previous boot, which is knowable only because every boot now
writes a stamp beside mcptoolkit.properties; with no stamp on record the newest report is
named with a note, and the agent judges its age. The failed-boot path - the higher-value
one, since a bad mixin dies before any tool exists - is rebuild.ps1's: on exit 1 its log
now ends with the header of any crash report written since the launch and the tail of
that run dir's logs/latest.log, and launch_game's note says so. Manifest cost: one
property and two clauses on `get_log`, one clause on `ping` - about 700 characters of
description, ~170 tokens by the chars/4 rule, above section J's ~120 estimate. Arbiters: CrashReportsTest
(the parse half, on a report ArmorPieces' client really wrote, no loader present) and
probes/crash-summary.test.mjs (the live half: the toolkit's own frame resolves to
`mcptoolkit`, vanilla's to `minecraft`, ArmorPieces' to `unresolved`, and cleanup leaves
nothing named). The failed-boot tail gets one recorded human run, not a battery case.

## 0.125.0

THE RELEASE BATTERY (RELEASE.md, 2026-09-06): the first whole sequential run on a client
since 0.109.0 - 101 files, 845 pass / 24 fail (sequential-0.58.0.log), the 24 in six
files and every one of them the HOST talking rather than the code: (a) the world-model
recorder has been off in run/config since 2026-09-03, and the gait fans that widen a
body's knowledge and the note that marks a sighting both run inside its tick, so
check-path-r1 case 3 and obs-gap-synthetic cases 3/5 pinned a premise nobody could read;
(b) the established save carries 1,344 leftover tickers, so perf's three hoppers never
rank in a top-50 hot-chunk list and a chest read drifted by one; (c) a client launched
by rebuild.ps1 starts MINIMIZED (the Gradle window's SW_SHOWMINIMIZED rides into LWJGL),
and `render` honestly refuses a minimized window - render-camera 0/16 and two
render-studio cases, which is the 0.119.0 chunk-b red RELEASE.md 2.2 had guessed at the
studio dimension for; (d) visible-acts case 6 saw a 452ms bench craft against a 15-tick
ceremony, the preemption path's signature, once. The title-screen client-envelope arm
(RELEASE_1.md F5) ran green the same day (sequential-0.58.0-title.log). Changes:
`ping` gains a `wm` block ({recording, note}) so a probe or a session can READ the
recorder premise; obs-gap-synthetic and human-task read their premise and pin whichever
arm the host is in (human-task's 0.119.0 reds were a captured human, i.e. the recorder
ON with a client); perf asserts the place-half in the form the tool claims (listed, or
outranked in a list the reply says it cut); preview-worldgen's compare case needs four
columns before it pronounces on a distribution (the virgin-server red F2 recorded);
rebuild.ps1 restores the game window once the bridge answers. F4: Platform.isWindows()
is the one definition, and ServerExtract (npm install) and ObsSupervisor refuse off
Windows in a sentence that says what to run by hand. Docs: LIVE_MODDING.md gains a
"Not in release 1" table for the D/E items with no code behind them; a modder's
SESSION_CHARTER.md under docs/guides, whose first paragraph the shim now serves as its
default `instructions` (mcp-server 0.59.0); profiles re-priced on a 96-tool capture
(manifest-2026-09-06.json: modding ~26.8k tok/turn, authoring ~13.7k, full ~47.5k).
And one shipped-mechanism fix the rerun forced: with the recorder off, check-path-r1
case 3 stayed red at 0.125.0 with the body landed straight ahead - WmSeen.addBody
sampled ONE point per tick, so a walker crossing an x and a z boundary inside one tick
fed neither cell it passed through and the knowledge-masked solve stopped at x+2 of a
walked corridor. It now marches the segment from last tick's position at quarter-block
steps (teleports excluded); hotswapped and 3/3. Rerun at 0.125.0 of the six red files
plus the changed probes: 13 files, 135 pass / 0 fail (sequential-0.59.0-rerun*.log).

THE SECOND WHOLE RUN, at 0.125.0 (sequential-0.59.0.log): 101 files, 861 pass / 5 fail in
five files, and this time two of the five were the code. (1) `studio` answered as soon as the
CLIENT'S LEVEL held the subject's blocks, which is not the renderer having compiled them: a
render fired that instant photographed an empty white studio while reporting settled:true -
the section was not dirty yet, so the compile queue was honestly empty; 1.5 s later the same
camera saw the subject. The wait now also asks vanilla's isSectionCompiledAndVisible of every
witness from the stand the player faces the subject from. (2) The studio's background is the
overworld's WEATHER: a non-overworld level mirrors the overworld's rain and thunder, and the
atmospheric fog darkens the sky colour it blends in (applyWeatherDarken), so a storm turned the
declared #FFFFFF into 240,245,255 three runs running. `render` zeroes the client's rain and
thunder for a studio frame and puts them back. Both were the same case that was red at 0.119.0
and blamed on the studio dimension; the probe now KEEPS a failing frame and names its colours.
(3) agent-client's memory-render case had a bridge caller that unwrapped the envelope, so the
memory layer fell through to its on-disk world cache on every call and the case passed for as
long as that cache held a uuid - it held the authoring world's. The caller mirrors the shim now.
(4) check-path-r1's landed cell is clamped to the strip (a `within:1.5` walk stops a step past
the end over no floor). The other two reds (combat-kit's shield race, descent's brew slot)
were 22/0 and 17/0 on the rerun and are not seen again. After the two client classes were
hotswapped: render-studio 7/7 four runs of five (the fifth an honest chunk refusal in a
back-to-back loop), agent-client 13/0.

Added after the entry was cut (same day, no tool changed): the project ICON. Neither manifest
named one, so every mod list showed the placeholder. `tools/icon.mjs` generates
`src/main/resources/icon.png` (a 32x32 drawing - a wrench in front of a grass block - scaled 16x
to 512) with the shim's own PNG codec, and `fabric.mod.json` `icon` / `neoforge.mods.toml`
`logoFile` both name it at the jar root (RELEASE_1.md F8).

## 0.124.0

THE LOOP KIT, FALSIFIED (LOOP_KIT_DESIGN.md section 11): section 9 item 7, run by
ArmorPieces on their next new part (beast_head, claude-opus-5) through the loop file plus
their nine tools. 33 turns against the proxy's 42, saved first try without force, both
repository checks clean: the kit passes - and the example loop file it shipped would have
failed it (44 tools ~10.4k tok/turn, three of thirteen notes, a gate on a tool the shim
does not serve). Nine findings; the toolkit's five, each now a probe or a doc line:
(3) The shim's own painters never fired the shim's own check. A local tool was stamped
    `local`, so after:{mechanism:["blockbench_edit"]} - the documented shape - skipped
    paint_faces/paint_ascii; 0.123.0's live test had named both in after.tools and never
    saw it. A local tool now carries the mechanism of the upstream it edits, `local` is
    refused at load, and loop-hook.test.mjs fires the check after both with nothing named.
(4) A gate naming a tool this session does not serve gated nothing, silently. stderr once
    the manifest is known, the keep-list typo warning's shape; both warnings now say
    "Blockbench is not up" only when Blockbench is configured at all.
(7) run-unit.ps1's after-the-fact check cannot pass for a checker addressed at the open
    editor: a good session closes its tab last. MCPTK_UNIT (the brief's stem) is in the
    session's and the last check's environment; a run check falls back to it.
(8) analyse.mjs read about half the true cost: stream-json's per-message usage carries
    no output/thinking (179 tokens over 33 turns; the result line says 53,325). The
    harness's total_cost_usd leads, the estimate is priced on the result line's totals
    with 1-hour cache writes at 2x (matches the harness to the cent on the run's log),
    and an implausible per-message output count is flagged.
(9) MCPTK_SHOT_MAX default 512 -> 384, the edge every section 1 figure was measured at
    (~182 tok a Blockbench look instead of ~324, re-sent every turn after).
Documented, not code: (5) `stateful` is per shim - a checker with two callers owns its
history (their check_active.py does); (6) the check's `text` IS the reply-enrichment
seam. Theirs, mirrored into the example: (1) the keep-list trimmed to the 29 names the
loop calls (39 tools ~8.6k tok/turn, under the proxy's own 46/~10.4k); (2) all thirteen
notes. Owed: a same-brief A/B; `look` on their painter; their extract refreshed to 0.124.0.

## 0.123.0

THE LOOP KIT, TESTED LIVE (LOOP_KIT_DESIGN.md section 10): section 9's list against the
dev client and Blockbench 5.1.6. Items 1-6 and 8 pass; 7 (the measured falsifier) is owed
with its protocol stated. Six defects, all found by the live runs and none by the 24 green
probes, each now a probe:
(a) Blockbench's risky_eval REFUSES code containing "//", "/*" or "console." - two comment
    lines inside the painters' template killed the first paint_faces. Comments moved out;
    paint-code.test.mjs asserts the shipped string passes the filter; loop.mjs refuses an
    `eval` check with a comment at load and serialises __previous with "/" escaped.
(b) texture.edit(cb, {no_undo, use_cache}) is the brush-STROKE branch: material refreshed,
    texture.source not, so the viewport showed the paint and get_texture (getDataURL =
    source) answered the pre-paint sheet. use_cache dropped; Painter.edit then runs
    updateChangesAfterEdit. One `undo` named paint_faces restores the canvas - verified.
(c) The budget cropped a 16x16 get_texture sheet to 12x12. A texture is an ADDRESS SPACE:
    its (x,y) is what the next paint call names. index.mjs CONTENT_CROP names the frames
    that may be cropped (screenshot, render, screenshot_annotated, the Blockbench
    captures, the painters' look); everything else is resized at most, never cropped.
(d) A JSON last line that is not the contract rode replies as a report: the outdated
    entity plugin's {ok:false, error} envelope, with `problems` undefined, which a gate
    would have read as nothing standing. loop.mjs: no `text`/`problems` = could not run.
(e) run-unit.ps1: a headless session grants NO tool by itself - every MCP call in the first
    run was refused "haven't granted it yet" while the agent file listed each one. The
    agent's tools: line is now passed as --allowedTools; a refusal is named on the
    console; the pause rule's bare 5\d\d (which matched a message id) is named error
    types only.
(f) stream-json (and a Claude Code transcript) writes one `assistant` line PER CONTENT
    BLOCK, same message id and usage on each: runner and analyser counted 12 turns for 6
    API calls and summed usage twice. Both count message ids now; the analyser's earlier
    figures over ArmorPieces' transcripts were inflated by this.
Proven live: the per-edit entity hook ends every place_cube/modify_cube/paint reply with
the verify block and puts `! regrown` on the reply that grew a painted cube; the gate
refuses and force passes with the reason echoed; ArmorPieces launches in `project (dev)`
with 43 kept names, the notes on the descriptions and priced by tool_surface; the runner
took a brief on stdin, tailed the log, analysed it and ran the project's check after.
ArmorPieces gained tools/check_active.py (the missing wrapper the example loop file
named), .mcptoolkit/loop.json, and part-author-kit.md; its shim extract was refreshed.

## 0.122.0

THE LOOP KIT (LOOP_KIT_DESIGN.md sections 5.1-5.6; how-to in docs/guides/LOOPS.md), from
the ArmorPieces record: the toolkit's one real user authored 91 parts and 14 skins through a
1050-line proxy OF ITS OWN in front of Blockbench, because the toolkit had no place to plug
in what it optimised. Sorted into what was armor and what was any authoring loop; this is
the second kind, six pieces, and the first three cost ZERO manifest entries.
5.1 THE IMAGE BUDGET (mcp-server/image/): a pure-JS PNG codec on zlib (no native module -
the dist must start from a fresh extract), crop to content (alpha bbox, else the box that
differs from the corner colour) THEN resize to a longest edge (MCPTK_SHOT_MAX, default 512,
0 = whole), a cost line on every picture using the API's own downscale rule, applied to
every `_image` reply and to every Blockbench upstream picture. `screenshot` grows `max`
and `crop` ([x,y,w,h] GUI px, {widget}/{id} from get_screen layout, scaled by the GUI
scale); both stripped before the bridge, which would refuse them. A 4K dev frame goes from
~1533 tok to ~211 and the figure fills the picture. Measured against a synthesised frame in
probes/image-budget.test.mjs (3/3).
5.2 THE PROJECT LOOP FILE (mcp-server/loop/loop.mjs): `.mcptoolkit/loop.json` (or
MCPTK_LOOP) declares checks that run after a call selected by the MECHANISM the manifest
already stamps - so "read-only never triggers" is derived, not hand-kept; Blockbench's
unstamped upstream is stamped from the adapter's read-only list as `blockbench_edit`. A
check is a command whose LAST stdout line is {text, problems, notes, full}, or an `eval`
run inside Blockbench; `stateful` hands the previous report back (--previous <file>, or
__previous); `gate` names tools refused while problems stand unless force:"<why>", the
shim adds `force` to their schemas and strips it for tools that never declared it. A check
that cannot run is LOUD on the reply. A malformed file refuses to start the shim. 4/4 in
probes/loop-hook.test.mjs.
5.3 THE PROJECT PROFILE: `profile: {base, keep, notes, instructions}` in the same file; a
workspace that declares one launches in `project` (MCPTK_PROFILE still wins), `base`
decides which upstreams exist, `keep` is a keep-list with the typo warning the built-in
slices do not need, `notes` are appended verbatim to descriptions and PRICED by
tool_surface, `instructions` is the server's. 4/4 in probes/loop-profile.test.mjs.
5.4 GENERIC VERIFY + PAINTERS: mcptoolkit_entity.js `verify` gains per-face coverage
(unpainted = finding, partial = note), stray paint outside every face, and REGROWN - a face
that was complete and grew on a resize, which is a diff against the previous report and
the one ArmorPieces' helmet shell slipped past a wholly-empty test; `check` returns the
loop contract. Two batch painters as LOCAL tools composing one risky_eval each,
`paint_faces` and `paint_ascii` (space leaves alone, `.` clears, `shade_only` PINS the
silhouette), served under `art` and under a project profile that keeps them. Harness
green (entity 6d'/6d''; probes/paint-code.test.mjs 4/4); Blockbench's own texture.edit /
Undo surface unverified until a live run.
5.5 tools/loop/: agent-template.md (part-author.md with the armor taken out), run-unit.ps1
(one headless claude -p per unit, stream-json log, pause on API trouble, the analyser and
the project's checks after), analyse.mjs (turns, context/turn, cache reads, pictures and
what they cost re-sent, calls per tool, THE LINE - the durable form of the scratch script
they lost; reads stream-json AND Claude Code transcripts).
5.6 the pin, as a documented pattern (LOOPS.md), and ARCHITECTURE.md's new rule: PRICE A
TOOL BY ITS ARITY - the manifest entry and the per-unit turn count are two taxes traded
against each other. tools/loop/examples/armorpieces.loop.json is their proxy re-expressed;
the measured falsifier (one of their briefs at the same model) is OWED.
Found on the way: upstream/blockbench.mjs was never in the mcp-server-dist whitelist, so
every fresh extract since 0.108.0 would have died at import time. Fixed with the three new
directories.

## 0.121.0

THE PARTS LIBRARY (UI_PARTS_LIBRARY_DESIGN.md steps A-F; as built in its section 7),
written from ArmorPieces' advanced smithing table - the hardest hand-built GUI in any of
these repos, finished and shipped, and written without knowledge of this format. Its
finding: almost nothing that screen does is a MISSING PRIMITIVE. Four things are, and the
real gap is "N of these" and "this cluster again, configured differently" - which are the
same gap wearing two hats.
TIER A, four property additions, no new channels: `tooltip` on every box/leaf (text,
{"translate"}, or {"hook"} -> a generated tooltip_<id>() beside drawRegion_*);
`visible`/`enabled` predicates over bindings, compiled into a List<Runnable> run from
containerTick AND once at the end of init() (a screen opened on a hidden button would
otherwise show it for one frame); a slot's `icon`, which is Slot.getNoItemIcon() and
therefore generates into the MENU, because vanilla draws it and neither renderer does;
and an `icon` that names ONE source - a GUI-atlas sprite, or a `texture` window with
u/v/src_w/src_h/sheet_w/sheet_h/color, which is crop-scale-tint in ONE vanilla blit and
deletes the pushMatrix()/scale(0.5f) block four screens carry. `face: "none"` +
`sprite_hovered` is the bare arrow: no vanilla face, hover sprite, half alpha inactive.
TIER B, `entity`: vanilla's GuiGraphicsExtractor.entity is one call and the twenty lines
around it are identical in the inventory, the smithing table and every mob preview.
Subjects: player (calling vanilla's OWN public extractEntityInInventoryFollowsMouse),
armor_stand wearing the stacks in named slots, or an entity type created client-side once
and never added to a level. Draggable turns it.
ACTION ARITY: {"name":"select","args":[{"name":"index","size":3}]} declares a BLOCK of
ids. The emitter writes pressSelect(int) WITH the bounds check on the client and the
decode plus the same check in clickMenuButton - so the stride exists ONCE, from one
declaration. ArmorPieces has that arithmetic written twice, in two files, with nothing
checking that they agree; a stride typo there is a click landing on the wrong fitting,
silently, on the server.
THE MACROS, and the decision the design did NOT make. §5.2 rule 1 says a part "expands at
parse time" and nothing downstream sees one. Built that way, THE FIRST DRAG IN THE EDITOR
WOULD UNPICK EVERY PART PERMANENTLY: every mutation is write-out-and-re-parse (slice 4),
so whatever UiWriter emits is what the file becomes. So `part` and `repeat` are nodes that
keep BOTH halves - the instance (all UiWriter writes) and the expansion beside it (what
every renderer walks). Two views of the tree fall out and they are the API: walkAll =
what RENDERS, walk = what can be EDITED, and every mutation inside an expansion is refused
by name pointing at the part file. Also NOT as designed: §5.1 passes x/y as PARAMETERS;
as built they are the instance's ORIGIN, so a part instance is one draggable object
because it has a position like everything else.
THE FALSIFIER §6 ASKED FOR BY NAME, and the two defects it found before anything ran
live: a part containing itself was a StackOverflowError (the cycle guard was a field
nothing pushed to), and a `repeat` inside a `part` namespaced its children TWICE
(p.r.0.p.row) because the outer pass descended into the inner macro's scope. Neither was
visible to any other check in the project.
THE SHEET (§3.6, the strongest available argument, found in the wild): ArmorPieces
generates its GUI background from the layout constants with a Python script whose header
says those numbers live in three files and moving a slot means moving a number in all of
them. A screen-level "sheet" now emits the PNG from the document's own frame, panels,
wells and slot seats - with its own 60-line java.util.zip encoder rather than
javax.imageio, because a generated file a build compares byte for byte must be
deterministic.
THE SEED LIBRARY: seven of §5.4's nine, in assets/mcptoolkit/ui/parts/. The palette's
default part is titled_well, NOT player_inventory - the inventory is the highest-value
entry and the wrong default, because it places all 36 player slots and would refuse on
the very common screen that already has an inventory. selector_column is the one that
proves the mechanism: a part whose fragment contains a repeat, which is why $i is a
RESERVED name an outer pass walks past.
PartLibrary because three hosts must find a part and none can use another's mechanism:
the dev game (the resource manager - every loaded mod's parts, which is what makes a
shared library shared), the Gradle task (its classpath IS the toolkit jar, so the seed
library resolves with NO wiring), and the unit battery (a map).
NO NEW MANIFEST ENTRY. ui_doc's read/lint gained `parts` (each instance with the hash of
the part FILE) and `part_drift` (that hash read back off the generated Java - §5.3's
answer to "vendoring means a part bug ships N times and there is nothing to grep").
Unit: 90 cases (UiPartsTest 12 new, UiSheetTest 4, UiDocumentTest +5). LIVE: 74/74 over
seven ui probe files, sequential, against `rebuild.ps1 -Ui mcptoolkit:example`. The named
risk did not fire - `entity` goes through vanilla's picture-in-picture path and the two
renderers are pixel-identical over an armour stand wearing fixed stacks.
THE ONE RED, and it was not in any of this: ui-world's "THE LAUNCHER'S PROMISE" asserted
that the boot latch's document was THE OPEN SCREEN ON ARRIVAL - true, and its evidence
erased by the six probe files that ran first, each opening screens. A probe that only
ever ran one way, coupled to it. So the latch now keeps a LIFETIME RECORD (what it was
armed with, its outcome, and - read off Minecraft.gui.screen() the moment its open
returned - what was actually up), reported as `ui_boot` at the TOP LEVEL of get_screen so
it survives "no screen open". Recording the screen rather than the call returning is the
load-bearing half: without it the record attests an intent. No mcp-server version bump.

## 0.120.0

THE AUTHORING WORLD (SCREEN_AUTHORING_DESIGN.md section 23), from the user's question:
"everytime the toolkit launched a client to edit the ui - would a command to open
minecraft directly into an empty dimension with the selected screen not help".
MEASURED FIRST: a preview needs a world (vanilla's rule - AbstractContainerScreen is built
over an Inventory, an Inventory over a Player), and the only world on offer was the
accumulated dev save: 13s of "Preparing spawn area", 1044 persistent chunks, 835 MB, plus
two tool calls, per cold cycle. It does NOT touch the gradle build, which is the bigger
half - say so rather than sell the seconds.
A SAVE, NOT A DIMENSION. The toolkit already ships two empty dimensions (canvas/), and
they are the wrong tool: a dimension lives inside a save, so entering it still pays that
save's load and still ticks its overworld. The cost is at the LAUNCH, so the answer is a
different save - mcptk-ui, a VANILLA superflat (the_void biome, one layer of smooth stone,
floor at y=0), creative, peaceful, and 12 game rules that turn off everything which could
make two screenshots of one screen differ. Vanilla and not mcptoolkit:workshop for the
loader-only reason Canvas already records: a mod's data/ is not a datapack here, so a
toolkit dimension type reaches a world through THAT WORLD's datapack, which cannot exist
before the world does. The rules are re-applied every start (LevelSettings carries none in
26.2), which is Canvas.install's bookkeeping argument again.
TWO DOORS, ONE PATH: `ui_doc op:"open"` (title screen -> create-if-absent, load, open the
document when the player arrives; IN a world it previews THERE and names the world, never
disconnecting anyone) and `launch_game {ui:...}` -> rebuild.ps1 -Ui -> -PuiDoc ->
-Dmcptoolkit.ui.open, one command from a stopped game to a screen on screen. NOT
--quickPlaySingleplayer: it can only open a save that already exists, so the first run
would need the creation path anyway and there would be two roads to one world.
NO NEW MANIFEST ENTRY: an op on ui_doc riding the existing ui/ui_file/edit keys, plus two
properties on the dev-only launch_game.
THREE DEFECTS THE LIVE RUNS FOUND, none of which a unit test could:
  1. The warm door reported "the world load has STARTED" for a load that never happened -
     called while the client was still starting up, the load was discarded by the rest of
     startup. It now REFUSES when not ready (overlay gone, no level, title screen up)
     rather than queueing: a door that reports an act it did not perform is the worst of
     the three options.
  2. Opening the world a SECOND time parked on BackupConfirmScreen - and the cause is the
     long-standing "open_world parks on BackupConfirmScreen" trap, finally named: ANY
     non-vanilla dimension makes a save's level-stem registry EXPERIMENTAL
     (WorldDimensions.checkStability -> isVanillaLike), and canvas/ writes two of them into
     every world the toolkit starts. Canvas now skips - and REMOVES - its files in the
     authoring world, so that world heals on its next load; the latch also clicks
     "skip and join" while a load it started is in flight, because a door that promised a
     world must not leave a modal sitting on it.
  3. That click fired every tick while the dialog lingered: two loads against one
     LevelStorageAccess, and the client died on "Lock is no longer valid" starting the
     integrated server. One confirm per load.
THE PROBE'S HONEST LIMIT: no tool leaves a world for the title screen, so the ENTERING
half is verified by running a door (which is how the probe gets into the world at all).
Its first case asserts THE LAUNCHER'S PROMISE - the document was already open when the
probe arrived - and goes red when the screen is closed, which is its falsifier.
AND A PROBE CASE THAT COULD NOT FAIL, caught by its own falsifier: "the clock is frozen"
compared two readings of `time query daytime`, which DOES NOT EXIST in 26.2 (the clock is
a timeline; the query is `time query time`) - and run_command answers ok:true on a command
that never parsed, so it was comparing two identical brigadier error strings. The helper
now throws on a parse marker, and the case goes red when advance_time is turned back on.
Also: wm.record and wm.policy turned OFF in the dev config at the user's direction - an
hour of nudging a button 3px was writing an hour of rows into the world-model corpus.
Probe: probes/ui-world.test.mjs, 10 cases, chunk b. ui-doc 8, ui-tool 19, ui-edit 11,
ui-emit 6, ui-input 15, ui-attach 12, ui-conform 7, tool-surface 3, profiles 22 all re-run
green IN THE NEW WORLD - including the pixel battery, which makes it a probe host too.
mcp-server 0.55.0 (launch_game gained `ui`/`ui_edit`).

## 0.119.0

SCREEN AUTHORING, SLICE 6 (SCREEN_AUTHORING_DESIGN.md sections 6.1 and 7.1; status in
section 22): THE ATTACHED PREVIEW, and REGENERATE-ON-SAVE.
ATTACHED = the interpreter swapped in front of a real screen, wrapping the SAME LIVE MENU
INSTANCE (ui/interp/UiAttach). Real slots with the running game's stacks, the bindings the
server actually synced, and a button press that rides vanilla's button channel to that
menu's container id - the branch InterpretedScreen has carried since slice 1 and which had
never once run. The swap is safe for the reason section 6.1 verified in source:
AbstractContainerScreen.removed forwards to menu.removed, whose body is guarded by
`player instanceof ServerPlayer`, so on the client it is a no-op, and the close packet is
sent only from onClose(). detach puts the ORIGINAL SCREEN INSTANCE back - the same object
over the same menu is the cheapest proof nothing was disturbed.
OPEN DECISION 8, ANSWERED: a generated <Screen>MenuBase implements no toolkit interface,
so UiBindings.bind reads either shape - the interface, or the duck-typed
`int bindingValue(String)` - exactly as UiDeclared.of reads a generated widget. It reports
WHICH answered, because "every gauge is zero" and "nothing answered" look identical on
screen. UiTools' own copy of that reflection is gone: one adapter, two readers.
THE HONEST LIMIT: Slot.x/Slot.y are FINAL in 26.2, so an attached preview can move every
label, button, gauge and layout node and CANNOT move a slot. SlotPlan.compare measures how
far the live menu has drifted from the document; the screen draws the count, get_screen and
the attach reply name each slot with both positions.
REGENERATE-ON-SAVE: the editor's Ctrl+S now runs the emitter IN PROCESS (section 7.1's
first caller, which is mandatory - gradlew cannot run while this game holds the jar). The
generated Java is checked in beside the document, so a drag that did not regenerate would
leave the repo holding two versions of one screen and checkUi failing the next build. A
`gen` toggle turns it off and says what goes stale; a project that never opted in is said
once and quietly; the save is never undone by a generate that failed.
The human's seam is a KEY: ctrl+U attaches and detaches from any container screen, over a
new consuming hook (ClientHooks.SCREEN_KEY_PRESSED, HookEvent.fireHandled, Screen.keyPressed
HEAD) - a container screen calls super.keyPressed FIRST, so the chord is seen before
vanilla's inventory-key close. Not ctrl+E: KeyMapping.matches ignores modifiers.
Tool surface: ui_doc gained ops `attach` and `detach` - NO new manifest entry and no new
schema key (both ride `ui`/`ui_file`/`edit`), ~40 tokens of description. get_screen reports
`attached` on an attached preview and `menu.container_id` on every container screen, which
is what makes "the same menu instance" checkable across the swap.
FALSIFIERS, BOTH RUN: disabling the SHAPE arm of UiBindings.bind turned 2 of 10 unit cases
red, both naming it; making attach wrap a SYNTHETIC menu instead of the live one - a swap
that looks right and keeps nothing - turned 8 of 12 live cases red, the four survivors
being exactly the ones that never touch a live menu.
THE FIRST RUN'S TWO REDS WERE THE PROBE'S: `last_action` on an interpreted screen is what
the CLIENT fired, set before the packet leaves, and the helper accepted it as the server's
answer. Fixed in two places rather than one - the probe waits on `server_action` only, and
get_screen now reports `server_action` on a GENERATED screen too, so one field means the
same thing on both renderers. The case also presses twice, because the server's record is
a static that outlives a run and only a TRANSITION proves anything.
AND TWO A SCREENSHOT FOUND, BOTH SLICE 4'S OWN LESSON: adding `gen` pushed the status
line's key hints off the edge (`ctrl+s sa..`), so the hints moved to the second (idle)
line and snap/undo/redo moved onto their own buttons as BADGES - state that has a widget
belongs on it; then `undo` at 38px rendered `und.. 0`, because a badge takes its width out
of the label's room. 44px.
Unit: UiAttachModelTest, 10 cases (suite 57 -> 67). Probe: probes/ui-attach.test.mjs,
12 cases, chunk b; ui-doc 8, ui-edit 11, ui-emit 6, ui-conform 7, ui-input 15, ui-tool 19,
profiles 22, tool-surface 3, tool-list-changed 1 all re-run green. No mcp-server bump.

## 0.118.0

SCREEN AUTHORING, SLICE 5 (SCREEN_AUTHORING_DESIGN.md section 10; status in section 21):
`ui_doc` - THE FOURTH EDITOR. One tool, ops on an `op` field (the `studio` precedent: a
manifest entry floors at ~589 tok/turn and the SCHEMA is the bigger half, so verb-per-tool
would have cost more than the surface saves): read / lint / add / set / move / remove /
generate / preview.
IT IMPLEMENTS ALMOST NOTHING, and that is the slice. Every mutation is UiEdit's - the same
engine the editor's drag runs through, so an edit here is checked by the parser that will
check the file on load, refused in the parser's own sentence at the parser's own path, and
written back canonical. Where the file goes is UiSaveTarget's, the same two destinations
Ctrl+S writes (MOVED ui/edit -> ui and de-client-ified for this: one rule, one
implementation, two writers). What the emitter's arguments are is the new
ui/emit/UiProject's.
THREE DECISIONS.
(1) NO SESSION, SO EVERY MUTATION WRITES THE FILE AT ONCE and git is the undo. That is
what makes the four editors composable - the file is the shared state - and it is why the
one conflict is handled BY NAME: while the in-game editor is open it OWNS the document
(it stops re-reading the file), so a write underneath it would die on the next Ctrl+S. A
mutation is refused while an editor holds the SAME RESOLVED FILE with unsaved edits, and
only then; a clean editor has nothing to lose.
(2) LINT IS WHAT PARSES FINE AND IS STILL WRONG (ui/doc/UiLint, no Minecraft). The parser
refuses the INVALID; this reports the legal-but-broken - a button off the panel, two
clickables on the same pixels, a container whose slots nothing places (a shift-click can
put an item where nothing draws it), a declared action no button fires. Nothing here
re-implements a parser rule. ITS BLIND SPOT IS DECLARED: a layout node's children are
arranged at init() time and a plain label's WIDTH is the font's, so both are counted into
`unchecked` with the reason and the answer - check_layout on a live preview, which is
section 10's other half. UiLintTest enumerates Code.values(): a code with no document that
produces it fails BY NAME, the same discipline as the palette and the battery.
(3) THE EMITTER'S ARGUMENTS ARE DERIVED, NOT TYPED. A document at
src/main/resources/assets/<mod>/ui/<screen>.ui.json already states the mod, the docs dir
and the project; the fifth, the root package, is read from the SAME gradle.properties key
the convention plugin reads (mcmod.ui.package) - so an in-session generate and a build's
generateUi cannot put the code in different places, because one place says. This repo
therefore declares that key too and build.gradle's generateUi now reads it.
`check`:true is checkUi's staleness guarantee without a build.
ui_doc registers COMMON on ExecutionContext.ANY - files and the model need no world and no
client - and holds a seam UiTools fills for its one client-side op. Profiles: kept in
`screens` AND in the `modding` DEFAULT (mcp-server 0.54.0), where it is the only screen
tool and `preview` is the only door left to a preview.
MEASURED, and it is the argument for the shape: the entry costs ~904 tok/turn (desc ~508,
schema ~396) on a 96-tool / ~47.4k manifest, against ~4.7k for eight entries at the
measured floor - the op dispatch saves ~3.8k on EVERY TURN.
All 19 probe cases passed on the first run, which slice 4 recorded as a warning rather
than a result - and it was one: every mutation in the battery addressed the document by
`ui_file`, which has NO PACK COPY, so the two-destination write (slice 4's own trap) had
never once run through this tool. The case added for it edits the example BY RESOURCE ID,
asserts the build/ mirror agrees, reopens the preview and reads the moved widget back off
get_screen, then restores both files byte for byte. Falsifiers, both run: disabling the
unreachable-slots check turned 2 of 8 UiLintTest cases red BY NAME; making unsavedHold
always answer "nothing held" turned EXACTLY 1 of 19 probe cases red, the conflict one.
Unit: UiLintTest (8) + UiProjectTest (5), suite 44 -> 57. Probe: probes/ui-tool.test.mjs,
19 cases, chunk b. Also: LIVE_MODDING.md's UI section no longer states the refusal
section 1 replaces.

## 0.117.0

SCREEN AUTHORING, SLICE 4 (SCREEN_AUTHORING_DESIGN.md section 9; status in section 20):
THE IN-GAME EDITOR. Handles, snap, a palette, a property inspector, undo/redo and save,
as a MODE OF THE INTERPRETER rather than a screen of its own - which is what keeps its
fidelity free and stops the project growing a third renderer for section 12 to hold in
agreement. Four decisions worth the words:
(1) EVERY MUTATION IS A JSON EDIT FOLLOWED BY A FULL RE-PARSE (ui/doc/UiEdit, no
Minecraft, so slice 5's `ui_doc` inherits it): the parser is the arbiter of every drag,
every inspector keystroke and every palette insert, there is no second property table
(UiParser.propertyKeys IS the inspector's), a refusal is the parser's own sentence at the
parser's own path, and the result is canonical - so a save is a minimal diff. Paths are
the parser's paths (elements[3].children[1]), so a refusal points at what is selected.
(2) THE PALETTE IS Kind.values(), and an entry that cannot insert a VALID document is an
entry that lies - so an insert DECLARES what it references (a button its action, a bar a
binding with a max, a slot free container indices, a fresh container when nothing has
room), and UiEditTest.everyRegisteredKindInsertsCleanly enumerates the registry with no
game running. Placement rules are NOT re-implemented: a spacer inserted at the top level
is refused by the parse, which is the sentence the human needed anyway.
(3) SAVE HAS TWO DESTINATIONS (ui/edit/UiSaveTarget), because there are two ways to lose
the work: save into build/resources/main and the next Gradle build overwrites it while
saying "saved"; save only into src/main/resources and the RUNNING game re-reads the stale
pack copy on the next init() - section 1's objection, one level below where it was
answered. So the source tree is the truth, the loaded pack is mirrored, both are reported,
and a target that resolves only to a build output is REFUSED rather than written.
(4) THE EDITOR'S FURNITURE IS UNDECLARED (ui/edit/UiChrome): real AbstractWidgets, so
click/set_text/get_screen drive the editor itself (section 9's claim, and how the probe
exists at all), but no UiDeclared - so slice 3's declared-widget comparison cannot see the
editor, and a probe case asserts the declared tree is IDENTICAL with the editor on.
Also: the interpreter stops re-reading the file while the editor is on (the editor owns
the document, or a window resize would discard unsaved work); WidgetBuilder now records a
rectangle per element PATH, which is the only way an unnamed element or a spacer can be
hit-tested; a region and a layout node get an editor-only overlay (open decision 7) and an
explicit offset gets a marker, because an override must read as one; Ctrl+G toggles the
editor and it is checked FIRST because KeyMapping.matches ignores modifiers, so any chord
containing the inventory key closes a container screen. TWO defects no probe over a widget
tree could see, both found by looking: a SCREENSHOT showed four truncated labels and every
value box scrolled to the TAIL of its text (EditBox.setValue leaves the cursor at the
end); and `git status` showed that a save rewrote every LINE ENDING (UiWriter emits LF, a
checkout with core.autocrlf=true leaves CRLF), so the file read as modified while git diff
printed nothing - a save now writes the endings the file already uses, and the probe
compares bytes. open_screen gained `edit`,
get_screen reports `editor`; no new manifest entry. Probe: probes/ui-edit.test.mjs,
chunk b. Unit: UiEditTest, 15 cases. No mcp-server version bump.

## 0.116.0

SCREEN AUTHORING, SLICE 3 (SCREEN_AUTHORING_DESIGN.md section 12; status in section 19):
THE CONFORMANCE BATTERY - assert INTERPRETED == GENERATED, written as checks. Three things
slice 2 owed: (1) PIXELS - a screenshot of each renderer, cropped to the panel, compared
pixel for pixel off the framebuffer (probe-side PNG decode; the one animated element, a
`scrolling` label, is masked by a rule enumerated from the DOCUMENT); (2) the ENUMERATION
as a check - open_screen on a ui document now returns `kinds` {registered (every Kind and
its family, off the running JVM), used (the document's)}, and the probe loops the registry,
one comparison per family, so a kind without an element or a family without a comparison
fails BY NAME; (3) the FALSIFIER - open_screen {generated:true, falsify:"geometry"|"paint"}
corrupts the compiled screen as it opens (UiFalsifier, a SCREEN_AFTER_INIT listener:
the first declared button 1px right, or its alpha halved), get_screen reports `falsified`,
and the battery asserts the comparison goes RED - geometry at both levels, paint at level
2 ALONE with level 1 provably blind, which is the case for having a level 2 at all. The
emitter-level falsifier (corrupt UiEmitter, regenerate, rebuild, red) is a rebuild cycle,
run by hand and recorded in section 19; its unit half is UiEmitterTest's "a one-pixel
change in the document reaches the Layout file and nothing else". Probe:
probes/ui-conform.test.mjs, chunk b. No mcp-server version bump.

## 0.115.0

SCREEN AUTHORING, SLICE 2 (SCREEN_AUTHORING_DESIGN.md sections 7, 8, 11; status in
section 18): THE EMITTER. ui/emit compiles a .ui.json into plain vanilla-API Java the mod
ships with NO runtime dependency - a machine-owned <Screen>MenuBase (slots from the shared
SlotPlan, ContainerData over abstract suppliers with the 16-bit `wide` split, clickMenuButton
dispatch to abstract on<Action> hooks, vanilla's quickMoveStack) + <Screen>Layout (every
element as a widget, layouts arranged as the interpreter arranges them, drawRegion_* hooks),
human stubs written ONCE (<Screen>Menu, <Screen>Screen), and one vendored <Mod>Ui per mod
whose paint and widget bodies a unit test pins to the interpreter's own sources. The emitter
IMPORTS NO MINECRAFT (the pin now covers ui/emit): UiGenerate is its Gradle-task caller, and
the toolkit's own sample (ui/sample, the shipped example compiled) was generated by running it
under plain javac with Gson alone. The Gradle side: `generateUi` here and in the
com.mattmc.mcmod convention plugin (0.5.0; `checkUi` fails a consumer's build on drift).
SlotPlan orders slots vanilla-style (containers, backpack, hotbar) for BOTH DetachedMenu and
the emitted base, so an index means the same thing on both sides. Tools: open_screen gained
`generated:true` (opens the mod's compiled screen through the integrated server's real menu;
GeneratedScreens is the registry), get_screen reads a generated widget's id/kind through the
duck-typed UiDeclared.of (a shipped mod cannot implement the toolkit's interface), and
reports document/generated/last_action on a generated screen like on an interpreted one.
DecorWidget's painter gained mouse + partial tick so the region hook can have them.
ui-kit/ is gone: QuickMove became the emitted quickMoveStack, EntityMenus/EntityMenuHost
wait in resources/mcptoolkit/ui/templates for the slice-7 subject, and the mcui publication
and the convention plugin's includeGroup for it are removed. Unit tests: 10 new (the
checked-in sample IS today's output, no toolkit import in generated code, vendored bodies ==
interpreter bodies, stubs kept / machine files rewritten / check reports drift). Probe:
probes/ui-emit.test.mjs - the first interpreted-vs-generated comparison (get_screen trees,
slots, an action through the real button channel), chunk b. No mcp-server version bump.

## 0.114.0

SCREEN AUTHORING, SLICE 1 (SCREEN_AUTHORING_DESIGN.md sections 4-6, status in section
17): the document format assets/<mod>/ui/<screen>.ui.json, the shared model both the
interpreter and slice 2's emitter parse into, and the DETACHED interpreter - a container
screen drawn from the document over a synthetic menu built from its own slot
declarations, placeholder stacks in the slots, bindings answered from preview values.
THE MODEL IMPORTS NO MINECRAFT (ui/doc/, section 7.1), and UiDocumentTest reads the
sources to say so: the emitter has to run from a Gradle task with no game on the
classpath, and a model that needs one would mean a second emitter and silent drift.
THE REGISTRY IS ONE ENUM (ui/doc/Kind, 16 kinds). The interpreter switches over the
sealed Element hierarchy exhaustively, so an unrendered kind is a compile error; the
parser carries a property table per kind and refuses unknown keys BY NAME, because a
misspelled key that is silently ignored is a property that does nothing. `list` is
deliberately NOT registered: its rows have no transport in section 8, and a registered
kind with an undecided meaning would be carried by the palette, the battery and both
emitters forever (section 15.6). A slot can never sit inside a layout node - its
geometry is the menu's on the server, where no layout runs (section 4.5).
ELEMENTS ARE REAL WIDGETS, decoration included and inactive, each tagged UiDeclared:
that is what lets get_screen name a bar or a region by id, check_layout box it, and
click press a declared button. Layout nodes (row/column/grid/stack over vanilla's
LinearLayout/GridLayout/FrameLayout) leave an inactive node widget over their arranged
bounds - every one, nested included, which the first live run found was not the case.
No new manifest entry: open_screen gained `ui`/`ui_file`, get_screen gained id/kind
per declared widget and document/detached/document_problem/last_action per screen.
check_layout's label_overflow rule assumed a padded button and flagged every widget
whose message IS its text; text widgets are exempt now, and decor widgets carry an
empty message (the id rides UiDeclared). ui-kit's Palette and Paint relocated in
(section 16); QuickMove and EntityMenus wait for the emitter.
Unit tests arrive with this: `gradlew test` (JUnit 5, wired here), 17 cases on the model
- every kind in the shipped example, parse->write->parse identical, the canonical text a
fixed point, the lints. Probe: probes/ui-doc.test.mjs, 8 cases, live-green on a client
IN A WORLD (a container screen cannot exist at the title screen - Inventory needs a
Player - so the preview needs one; it skips itself otherwise). No site. No mcp-server
version bump (probes only).

## 0.113.0

THE WHITE ROOM, AND THE OP THAT COULD NOT LIVE ON THE CAMERA
(RENDER_SEAM_DESIGN.md section 6's op:"canvas" - the last unbuilt line of that design,
and section 14 is its build record.)
A SUBJECT THAT STANDS IN NO WORLD CAN NOW BE PHOTOGRAPHED. `studio` stands a loaded
structure template - or a copy of blocks standing in the dimension the client is in -
in mcptoolkit:studio, puts THIS CLIENT in front of it, and answers with the box. Then
`render {look_at:<box>}` frames it and `frames:N` orbits it, all of that being the
camera that already existed: the staging half adds no picture-taking of its own.
`studio {leave:true}` sweeps the subject and puts the client back where it was.
IT IS NOT AN OP ON `render`, AND THE REASON IS THE ONE RULE THAT OUTRANKS THE MANIFEST
TAX. Section 6 put canvas/clear on render's `op` field to save an entry. But `render` is
mechanism:observe and it is on `inspect`'s keep-list - the read-only profile whose claim
is CHECKED PER NAME against the live manifest's mechanism. Staging writes blocks and
teleports a player. Behind an observe-tagged entry, the read-only inspector could edit
the world while the profile probe stayed green and the stamp went on saying `observe`:
a restriction deleted by an addition nobody would see. So the camera stays a read and
this is a world_edit beside it, exactly as section 6 itself kept `open_world` out.
THE THREE THINGS A CALLER CANNOT DO ALONE, and they are why this is a tool and not two
calls. renderLevel draws Minecraft.level, so a shot in the studio is a real player's
round trip - and a probe that once left the player there cost a whole battery run,
because every later read defaults to the dimension somebody is standing in. `settled`
is a fact about the renderer and says nothing about blocks still travelling from the
server (0.108.0, section 13.3), so the stage waits on the CLIENT's own copy of cells it
picked one per chunk column, and the probe asserts that by NOT SLEEPING before the
render. And the slot is allocated, never chosen, which is [[probe-site-ownership]].
THE STUDIO HAS NO FLOOR, which is a fact about a void dimension that only matters once
somebody has to STAND in it: a player left there falls at 78 blocks a second into void
damage. A stage lays a 3x3 pad of minecraft:barrier under the spot it moves the client
to - RenderShape.INVISIBLE, so the one block in the game that is a floor to stand on and
nothing to look at - and sweeps it with the slot.
A STAGE STAYS UNTIL IT IS SWEPT, one region per calling session, cleared before that
session reuses it. Sweeping it in the same finally that returns the player would make
the picture unreproducible and leave nobody able to walk in and look at the thing that
was photographed - which section 5 says is the whole point of a picture. `leave` clears
the CALLER's stage and nobody else's, the same rule /mcptk cancel follows.
Probe: probes/render-studio.test.mjs. Its own site at 9,300,000; it MOVES THE PLAYER,
so it belongs in the sequential battery. mcp-server 0.53.0 (studio in CLIENT_SURFACE and
in the modding/authoring keep-lists; out of `inspect` by the argument above).

## 0.112.0

MMCP, AND A REGISTRATION THAT IS ONE KEY IN SOMEBODY ELSE'S FILE
(RELEASE_1.md section B1, the last item of section B0's build order.)
THE MENU MOVES INTO OPTIONS. The title-screen "Claude" button was right for a personal
launcher and wrong for a mod other people install: it plants a vendor's name on the
first screen of somebody else's game, in the one spot every other mod also wants. There
is now an MMCP entry in the vanilla Options screen instead - reachable from the title
screen AND the pause menu, which is where a player looks for a mod's settings. It needs
no mixin: OptionsScreen builds a two-column grid of ELEVEN buttons, so the cell beside
Credits and Attribution is empty, and the hook fires after the layout has arranged
itself, making that cell a measured fact rather than a guess. The placement is still
checked against every widget on the screen and steps down a row if vanilla ever adds a
twelfth button - a button one row low is a small ugliness, one drawn on top of Credits
is a broken screen.
THE BRIDGE IS THE FIRST THING ON IT, which is what section B0 meant by "with the
bridge's real state, including a failed bind, as its first row". Everything else on that
screen is worthless if nothing bound: a lost bind used to be one warning in a log while
the game ran on happily and its sessions answered correctly about the WRONG WORLD.
Green `bridge :<port> serving` or a red NOT BOUND, then env/loader/folder, then the
configured agent client with its detect status - probed in the background, never on the
render thread, because detect() starts a process and waits up to fifteen seconds for it.
THE DEFECT THE SCOPE QUESTION UNCOVERED: BOTH ADAPTERS DELETED OTHER PEOPLE'S MCP
SERVERS. ClaudeCodeClient.registerServer and SpecAgentClient.registerServer each built a
fresh root object holding one entry and wrote it over whatever was in the workspace's
.mcp.json. In this workspace rocketeer/.mcp.json and nijntje/.mcp.json each hold the
toolkit's entry AND a `blockbench` one, and companion.workspace is a documented,
principal-supplied directory - so a launch pointed at such a repo silently deleted a
server the human depends on, and the generic CLI adapter did it on EVERY launch because
it had no staleness check at all. New McpServersFile owns exactly one key and writes
every other member, and every unknown top-level field, back as it found it. A file it
cannot parse is refused, never replaced.
IDENTITY IS THE ARGUMENTS, NOT THE KEY - and the key was wrong anyway. ServerSpec named
the server `mcp-toolkit` while every .mcp.json in this workspace, the docs and every
mcp__mcptoolkit__* tool name say `mcptoolkit`; merged rather than overwritten, that
would have produced a SECOND entry beside the hand-written one and two tool prefixes in
one session. The canonical name is now one constant. An entry is recognized as ours by
the index.mjs its arguments name, so a key WE wrote under the old alias is normalized in
place, a key the HUMAN chose is repointed but never renamed (renaming it re-namespaces
every tool call that workspace makes), and an entry running ANOTHER game's extract is
left alone - taking it over silently is the wrong-game class section B0 closed.
THE KEY HAD TWO SILENT DEPENDENTS, AND ONE OF THEM IS AN ALLOWLIST. Renaming the server
key is not a cosmetic change: ClaudeCodeClient wrote `mcp__mcp-toolkit__*` into every
workspace's .claude/settings.json permissions, and SURVIVAL_CHARTER.md told the player
its own tools were called `mcp__mcp-toolkit__<name>`. Left alone, a launched session
would have had an allowlist naming a prefix no tool carries - every call outside it, in
a HEADLESS companion with nobody there to approve the prompt - and a charter instructing
it to call tools that do not exist. Both now derive from or match the one constant, and
the settings-file staleness check gained the allow pattern, because an existing
workspace would otherwise keep the old allowlist while its registration was normalized
to the new key. Found by reading for dependents rather than by a probe: no probe launches
a Claude session, which is exactly why the launch path is three owed human tests.
SCOPE, DECIDED BEFORE CODE: the toolkit's own registrations, not the host's server list.
The wide reading needs four more methods on every AgentClient adapter, all file-shaped,
for servers that have nothing to do with Minecraft. The narrow one needed ONE default
method - serverConfigFile(workspace), null when a client's registrations are not files -
and listing and removal fall out of it. Writes still belong to registerServer.
NEW: Registrations (which directories this game is registered in, and whether each still
names the port it bound: current/stale/foreign/absent) and `/mcptk mcp
list|register|remove`. The sites are DERIVED from the kit registry and the game dir, so
they cannot go stale when a kit changes; only a directory a human typed is remembered,
one path per line in <gameDir>/mcptoolkit/registrations.txt. Registering works with NO
agent client configured, because that is the primary supported path: typing a repo
directory into the MMCP screen writes exactly the file ADAPTER.md asks a modder to
hand-write, with the port this game actually bound in it.
Arbiter: probes/mmcp-servers.test.mjs, 9 cases, chunk b. It drives the COMMAND, because
the screen is a client surface no headless probe can open, and the command is the same
Registrations code path. The assertion is the FILE, not the reply - a command that says
"registered" and wrote the wrong thing is precisely the failure being closed - and case
1 is the falsifier. TWO MUTANTS, RUN: the old whole-file write killed FIVE cases (1, 4,
5, 6, 7 - the other five stay green, which is why case 1 is written first); "always write
under the canonical key", i.e. ignoring the key already in the file, killed 4 and 5, the
pair that says the key is the human's and the tool prefix is theirs. 10/10 with both
reverted. The screen itself is three owed human tests in the review queue
(mmcp/options-entry, mmcp/bridge-first, mmcp/servers-screen).

## 0.111.0

THE LAUNCHER LEARNS WHICH PROJECT IT IS IN, AND THE CONFIG FILE STOPS HIDING FROM
DEVELOPERS (RELEASE_1.md section B0 steps 3 and 4, closing the section).
`launch_game` resolved its build root from where the SHIM IS INSTALLED - two levels up
from mcp-server/local/dev.mjs - and every repo in the workspace registers that same
mcmodding/mcp-server/index.mjs in its .mcp.json. So the answer was identical for all of
them: from menagerie's session the tool sat in the manifest looking like it belonged
there and cycled THE TOOLKIT's game. rebuild.ps1 could not have been told otherwise -
its -Project was an enum of two values dev.mjs never passed.
RESOLVED FROM THE PORT, BECAUSE THE PORT IS ALREADY THE PROJECT CONSTANT (0.110.0). A
session's frozen port names its project, so nothing new is declared and there is no
second fact to keep in step with the first. mcp-server/local/project.mjs searches, in
order: MCPTK_PROJECT_DIR; the session's own Gradle root and the roots nested one level
inside it (mcmodding is TWO games - villagejobs at the top on 25640, mcp-toolkit one
level down on 25599); then every launchable root beside this checkout; then, only as a
tiebreak, one inside the shim's own checkout, which is the old behaviour demoted from
the answer to a last resort. "Launchable" is `applies Loom and has a wrapper`, not `has
a settings.gradle` - gradle-conventions and spike-neoforge are roots in this very
checkout and are not games. Anything still undecidable is REFUSED, listing every
candidate root and the port it would bind, because a default here is exactly the silent
wrong-game launch the section exists to remove. The ambiguity is not hypothetical:
ArmorPieces and rocketeer-kami-int declare no `mcmod.port`, so they and mcp-toolkit all
take 25599.
rebuild.ps1 -Project now takes a DIRECTORY (`toolkit`/`villagejobs` kept as shorthands
for the two roots here), validated to a Gradle root with a wrapper BEFORE step 1 - whose
first act is to kill the game on -Port, so a bad path must fail while nothing has
happened yet rather than after a world has closed for nothing. New exit code 4.
THE CONFIG FILE IS NOW WRITTEN IN DEV TOO. It was production-only, on the reasoning that
a developer needs no discoverable toggle; that is backwards. Dev is where the port
matters most, config/mcptoolkit.properties was the only lever a consumer had, and its
name, its keys and its existence were invisible in exactly the environment modders work
in (section B0, defect 1). Two details make it correct rather than merely present: it is
written from BridgeServer.init() with the EFFECTIVE port, not from BridgeConfig.load()
with a guessed default - load() is never even reached when -Dmcptoolkit.port is set,
which is every Gradle dev run - so a game launched on 25641 writes `port=25641` and a
later hand-run without the JVM arg lands on the same port instead of colliding on the
default; and it is never written for a disabled bridge, so it cannot advertise
enabled=true for a bridge that is off. The header now names `mcmod.port` and MCPTK_URL.
LIVE, AND IT PAID 0.110.0'S DEBT TOO - that version's Java half had only been compiled.
A client boot reported `ping.port: 25599` and refreshed run/mcptoolkit/mcp-server from
0.85.0 to 0.111.0 with NO agent client configured, which is ADAPTER.md's primary inbound
path working for the first time. A server told to take a held 25599 logged the WARN once
at 10s and the NO BRIDGE ERROR once at 90s, 45 INFO retries between them. A server on
25620 wrote `port=25620` into a gameDir that had no config file - and THAT is the check
that mattered, because the contested run also wrote a file and the number in it was
25599, which is equally the dev default: it could not have told a correct substitution
from a hardcoded one. An interpreted number needs a case where the boring answer would
be wrong. Then the whole path end to end: the real shim, spawned over stdio, frozen on
25777, refused and printed the workspace's actual state (ArmorPieces, rocketeer-kami-int
and mcp-toolkit all take 25599 by declaring nothing); frozen on 25599 it spawned
`rebuild.ps1 -Project C:\\Users\\Matthijs\\mcmodding\\mcp-toolkit`.
Arbiter: probes/launch-project.test.mjs, 15 cases, chunk b, and the only chunk-b member
green with no game running - it builds synthetic Gradle roots in a temp dir for the rules
and reads this workspace's real ones for the regression. Two mutants (pick-the-first, and
"launchable" = "is a Gradle root") each killed 4 cases. attach-identity, tool-surface,
agent-client and arg-check green beside it (28 cases) against a live headless bridge.

## 0.110.0

A PORT PER PROJECT, AND A SESSION THAT SAYS WHICH GAME IT REACHED
(RELEASE_1.md section B0 steps 1-2). The workbench had five build roots and ONE bridge
port between them, and the way that failed is the reason this is not a config tweak.
THE THIRD CASE OF THE PORT'S DIRECTION. Two were known: game first, the game publishes
the port it bound; session first, the session pushes the port it froze. A project's own
dev loop is NEITHER END MOVING - menagerie's game and menagerie's session both want one
fixed number forever - and nothing declared it, so both ends fell back to
BridgeConfig.DEV_DEFAULT_PORT independently and happened to agree on 25599.
HOW IT FAILED: the SECOND game to boot lost the bind, retried for 90 seconds at INFO,
gave up with a single WARN and ran with NO BRIDGE - while its session, dialing the same
25599, connected to the FIRST game and answered every call correctly about the wrong
world. Nothing on either end checked, though `ping.gameDir` had the answer all along.
That is why rocketeer's documented playtest line is `-Pmcmod.toolkit=false`: the
workaround for the port problem was removing the toolkit.
THE FIX IS IN THE BUILD, NOT HERE: `mcmod.port` in each repo's gradle.properties, wired
by the com.mattmc.mcmod convention plugin (0.2.0) onto loom.runs.configureEach - every
run config Loom has, not the two a build file happens to name, which is what reaches
nijntje, whose build declares no runs block at all. `-Pport` stays the transient
override and outranks it. Allocation: 25640 villagejobs, 25641 menagerie, 25642
rocketeer, 25643 nijntje; the toolkit keeps 25599. The same plugin now also supplies
-Djdk.attach.allowAttachSelf, so hotswap_class stops being quietly unavailable in every
consumer's game.
WHAT CHANGED IN THE JAR, all of it about being audible:
- `ping` reports `port`. docs/guides/ADAPTER.md has told readers to get it from there
  since it was written and it never reported one. No new manifest line, one clause.
- boundPort() now means BOUND. It was assigned in init() before the socket existed, so
  a bind that lost the race left every reader - the workspace writer among them -
  reporting a port nothing was serving. requestedPort() keeps the asked-for number.
- A lost bind is an ERROR that names the cause and the fix, plus one WARN at the point
  the cause stops plausibly being the dev bootstrap JVM (5 attempts) and starts being a
  rival game. It was 45 INFO lines and one WARN.
- The Node server is extracted on a CLIENT too. BridgeServer did it for a dedicated
  server and AgentLauncher for a game-started session, and between them they missed the
  path docs/guides/ADAPTER.md calls the PRIMARY supported one: single-player client, no
  agent client, host registers <gameDir>/mcptoolkit/mcp-server/index.mjs by hand. That
  directory was never created, so the documented instruction named a file that did not
  exist - and precisely because the inbound path needs nothing from the toolkit's own
  configuration, nothing was extracting for it. Both of ADAPTER.md's false claims are
  true as of this version rather than rewritten around.
AND THE SHIM SAYS WHERE IT LANDED (mcp-server 0.51.0): one stderr line per session
naming the bridge, env, loader, gameDir and instance, plus a WARNING when that game is
outside the session's own tree. Read through `ping` rather than a new hello field ON
PURPOSE - gameDir/env/loader/instanceId have been in ping for many versions, so the
check works against every toolkit already deployed in this workspace, including the
0.101.0 rocketeer pins. It warns and never refuses; a cross-tree attachment is a real
workflow, and MCPTK_EXPECT_GAMEDIR overrides the expectation ("any" silences it).
Probe: probes/attach-identity.test.mjs, 4 cases, live-green, chunk b. It spawns the
REAL shim over stdio rather than re-implementing the handshake, because the thing under
test is a side effect on a stream a re-implementation would not have - and its
load-bearing case is the one where the warning FIRES, without which the other three are
equally green against a check wired to nothing.
OWED AT THE TIME, DISCHARGED AT 0.111.0 the same day: no game was rebuilt for this,
because another session held the dev client with the accumulated world open and
rebuild.ps1's first act is to kill whatever holds the port - the very failure this entry
is about. The shim and gradle halves were live-verified then (every run config of all
five roots printed through an init script, both precedence directions); the Java half
was only javac-clean. See 0.111.0 for what a game then actually did.

## 0.109.0

A TOP-N LIST THAT SAYS SO (RELEASE_1.md section F2, the full-battery run of
2026-08-28: 740 pass / 5 fail across 86 files, on a CLIENT with the accumulated
workspace world open).
get_perf's three ranked lists - entity_types, block_entity_types, hot_chunks - were
silently truncated at `top` (default 5). Each now carries its own `*_omitted` count,
always, and the description says an absence in a truncated list is not a zero.
THE FINDING IS THAT THE CENSUS WAS RIGHT AND THE READER COULD NOT KNOW. perf.test.mjs
took its hopper baseline at the default top and compared against a top:50 read; in an
established world minecraft:hopper ranked SIXTH, the probe's `?? 0` turned "below the
cutoff" into "there are none", and 131 hoppers already in that world reported as the
census miscounting the six it had just placed (77 !== 6). That is the succeeds-falsely
class ARCHITECTURE.md keeps purging, in a reply this toolkit ships: absence and zero
were the same value, so the honest fix is in the TOOL, not only in its probe.
THE PROBE'S SECOND RED WAS A DIFFERENT MISTAKE OF THE SAME FAMILY. "a chest is not a
ticker" was asserted as an IDENTITY on the world's total ticker count, and went red at
1212 !== 1213 - one ticker FEWER with a chest placed, a direction the chest could not
have caused. settle() narrows that window and cannot close it. The case now measures
the boring case instead of assuming it: two reads, same spacing, nothing placed
between them, and the identity is asserted only when that control says the world is
quiet - reported out loud when it is not, because a case that stops asserting has to
say so. The claim itself moved onto the type census, which is exact and drift-proof
now that a cutoff cannot masquerade as an absence.
NO NEW MANIFEST LINE: three fields on an entry that already exists, plus one clause of
description. Probes: perf.test.mjs 10/10; site-map.test.mjs gains a second case.
SITE-MAP'S TWO REDS, BOTH FIXED AND ONLY ONE OF THEM REAL. 1,000,000 was a FALSE
POSITIVE - loot-roll's `random value 1..1000000` is the RNG command's range, not a
place - so the guard gains the by-file exemption list its own header always said to
use instead of loosening the heuristic, and an exemption is `{file, value, why}` so it
can never spread to another file's real coordinate. It also gains the falsifier that
list needs: this guard's cheap way out is to add an EXEMPT line, so every exemption
must still find its literal in its file or it is deleted. Verified by breaking it.
5,400,000 was shared by conformance and preview-worldgen as a preview_worldgen CENTRE
- nothing is staged at either, so they could not really collide - and conformance took
its own coordinate anyway: a rule that starts making exceptions for the collisions it
judges harmless cannot catch the harmful one.
AND FIVE PROBES WERE IN NO BATTERY CHUNK (authoring-saving, blockbench-surface,
rocketeer-authoring, tool-list-changed, tool-surface) - the drift battery.ps1 warns
about and the SECOND time that warning has had to be acted on rather than read. All
five are shim surface; all five are now chunk b.
TWO FLAKES RECORDED, NOT CHASED: locate case 8 (78 of 81 chunks entity-searched) and
spatial-inversion case 7 (armor stand not seen), both green on a re-run of the pair
alone (36/0). The battery is SEQUENTIAL, so this is not the concurrency class - it is
a busy established world, and the mechanism is plausible rather than proved.
No mcp-server bump - probes and a battery script, no change to index.mjs. The shim
serves the bridge's manifest live (0.98.0), so get_perf's new clause reaches a session
without one.

## 0.108.0

THE CAMERA LEARNS TO FRAME (RENDER_SEAM_DESIGN.md phase 3, the last of the five).
`render` gains look_at / distance / frames, and framing a build stops being the
caller's trigonometry. Give it the box you built - BLOCK coordinates, inclusive at
both ends, the same box set_blocks and describe_box take - and the camera works out
where to stand; `frames:N` walks that placement round the subject and returns N stills.
THE ARITHMETIC IS ONLY POSSIBLE BECAUSE THE LENS IS PINNED. camera.enablePanoramicMode
fixes the FOV at 90 degrees (Camera.calculateFov, Camera.java:222), and Projection
feeds it to JOML as fovy - VERTICAL - so the half-angles are 45 and atan(w/h) and the
smaller one crops. A subject is framed by its BOUNDING SPHERE, whose angular radius at
distance d is asin(r/d); requiring tan(asin(r/d)) = 0.8*tan(theta) solves in closed
form. The sphere encloses the box, so a long thin subject seen end-on is over-framed
and nothing is ever under-framed - a generous margin and a decapitated subject are not
the same kind of wrong.
yaw/pitch NEVER CHANGE MEANING, which is a correction to the design's own section 6.
It sketched them as mutually exclusive with look_at; they are not, because a camera
standing at centre - dir(yaw,pitch)*d and looking along dir HAS exactly the yaw and
pitch it was given. look_at decides only where it stands. The single genuinely
over-determined case is `at` + `look_at` + an aim, and that one is refused by name.
No new manifest entry - three fields on the entry that already exists (section 6's own
instruction). MEASURED, which section 9 had been asking for since 0.105.0: `render` is
4,287 chars / ~1,071 tok per turn, of which phase 3 is ~303. The SCHEMA is 2,852 of
those chars against 1,319 of description - Finding 4-6 again, the schema is the bigger
half, and the two nested vec3i of a box are most of it.
THE BUG THIS FOUND IS WORTH MORE THAN THE FEATURE, and it was in 0.105.0's settle loop.
`settled` asked hasRenderedAllSections() - i.e. sectionRenderDispatcher.isQueueEmpty()
(LevelRenderer.java:885) - ONCE, and an empty queue means three different things:
finished, NOT YET SCHEDULED, or handed to a worker and being built right now.
LevelRenderer.render calls compileSections at its very END (:255) and that calls
compileAsync (:631), so the pass that first sees a changed section leaves the queue
clear behind it. Measured: `passes:2, settled:true` and a UNIFORMLY WHITE frame with an
11-block black cube standing 15 blocks in front of the camera. Three CONSECUTIVE clear
readings now, and the same shot comes back correct at `passes:4`.
AND WHAT settled STILL DOES NOT PROMISE, now said in the description: it is a fact
about this client's renderer only. A block written on the server 700-900 ms ago (dev
singleplayer, measured) may simply not have arrived, and no amount of rendering makes
it come sooner - from inside the camera an empty studio and an empty studio that is
about to have a house in it are the same picture.
Probes: probes/render-camera.test.mjs grows from 9 cases to 16, live-green, 0 skipped,
against a client driven in by open_world with nobody touching the mouse. The phase-3
arbiter is section 7's, verbatim: a subject of KNOWN BOUNDS, framed, with its pixel
bounding box read off the decoded PNG - margin, fill, centring - AT TWO SIZES. The
two-size case is the one that cannot be faked: the camera stands at centre + k*r*u for
a k that depends only on the aspect, so a 3-cube and an 11-cube are geometrically
SIMILAR and must come back the same size on screen. Any framing rule with an additive
term in it passes every other assertion in the file and dies there. The empty-studio
case gains `passes >= 4`, which is the settle fix's own falsifier. No mcp-server bump
from this item - probes only; 0.50.0 arrives with 0.107.0, which landed beside it.
NOT BUILT: op:"canvas" (put the subject in the studio and photograph it there) is
still two calls and a place_structure by hand. That is now the only unbuilt line in
RENDER_SEAM_DESIGN.md.

## 0.107.0

PROFILES, AUTHORED FROM THE ROLES THAT EXIST. (RELEASE_1.md section C, whole.)
THE DEFAULT MOVED, AND THAT WAS THE QUESTION - not "add the block reads back to
standard". `standard` is a BENCH artifact: its shape was chosen by a NAVIGATION bench,
which is exactly why it withholds describe_box/get_blocks_at/get_surface - those reads
had a measured 1:1 substitute for a rung that WALKS. A session authoring geometry writes
a box and reads it back, where nothing substitutes, so for three releases the default
profile could not perform the read half of 0.89.0's own authoring round trip. rocketeer
pinned `full` to work around it; menagerie, naming no profile, simply could not.
NEW DEFAULT `modding`: 52 tools / 98,523 chars / ~24.6k tok against `standard`'s 100 /
169,279 / ~42.3k - so the fix that ADDS the three block reads also takes ~17.7k tokens
off EVERY TURN of every session that never chose a profile. Almost all of that is the 28
embodied bot_* verbs, which a content-authoring session does not call and which come
back with one tool_surface call. The workbench COPILOT kit feels this: its prompt now
says so and names the widen. `standard` keeps its benched shape and its name, so no arm
moves.
A KEEP-LIST THAT DECLARES ITS COMPLEMENT, which is the mechanism section C5 owed. A
hide-list naming a missing tool is loud; a keep-list MISSING a present one is silent -
that is how query_class, get_perf, roll_loot and preview_worldgen all shipped with no
keep-list profile inheriting any of them, invisibly, for weeks. So the DEFAULT (only the
default - a narrow slice like `art` is DEFINED by what it leaves out) declares
MODDING_EXCLUDED beside MODDING_KEEP, and any live manifest name in neither warns on
stderr and reds a probe. A new tool can now enter the default silently no more than it
can be omitted from it silently: someone writes one line saying which.
TWO PROFILES THAT DID NOT EXIST. `screens` - CLIENT_SURFACE was a HIDE-set only, so
every role took the client tools away and no role KEPT them: the toolkit had a screens
capability and no screens session. It earned itself the same afternoon, clicking through
the experimental-settings BackupConfirmScreen that was silently holding this release's
own world load. And `inspect`, the read-only inspector - where "read-only" is CHECKED,
not promised: every ToolDef declares a `mechanism` and the bridge stamps it into
GET /tools, so the probe asserts per name that everything `inspect` serves is `observe`.
Without that check the profile would just be a smaller `modding` with a promising name.
THE EXPERIMENTAL MARK IS IN THE SOFTWARE (section C4). Before this, `grep -i
experimental` over the shim hit exactly one comment about env hides: a research profile
looked precisely as blessed as a dev one from inside a session. Now PROFILE_META is the
one site of record - kind (dev/bench/experimental) plus a one-line role - and the
start-up stderr line, `ping`'s new `profile` block and `tool_surface`'s report all read
it, so the label cannot be true in one place and stale in two. play/survey/survival get
their own warning line, because a label sharing a line with something else gets skimmed.
SECTION C4 SAID "the stderr line that already announces the profile". IT DID NOT EXIST.
Only the route layer announced itself; a session's tool surface - the single largest
fact about it - was identifiable only by counting the manifest. Worth carrying: a plan
item that describes an existing mechanism is a claim to check, not a premise.
RE-PRICED LIVE (section C6) against a fresh 94-tool capture from a dev client,
probes/fixtures/manifest-2026-08-28.json - the old one predates roll_loot,
preview_worldgen, render and open_world. full 104/179,503; standard 100/169,279;
entity 101/171,632; modding 52/98,523; authoring 34/51,379; art 17/21,225 (toolkit half,
Blockbench off); screens 38/45,160; inspect 29/75,536; rocketeer_authoring 35/56,165;
play 59/129,344; survey 28/65,798; survival 34/61,405. The AUTHORING_KEEP comment is
updated as the site of record and now carries its DATE and its baseline, because the
72%/~11.1k it held were not wrong - they were priced against a smaller toolkit, which is
the failure mode a measured number has and a mechanism does not.
CAVEAT ON THE CAPTURE: it was taken from a tree carrying ANOTHER SESSION'S uncommitted
RENDER_SEAM_DESIGN phase 3, which grows `render`'s schema. That whole entry is 3,973
chars, so every profile serving `render` is high by at most a few hundred. Stated rather
than corrected - a number whose context is recorded can be re-taken; one whose context
is not is simply wrong later, which is this section's own finding about the 72%.
Probe: probes/profiles.test.mjs, 16 -> 22 cases, 22/22 live-green on a loaded world
(case 21, the survival legal-locate one, RAN for the first time - it had been dark since
it was written). The three keep-list probes green beside it: authoring-saving 1/1
(repointed at the new capture), blockbench-surface 2/2, rocketeer-authoring 2/2. No new
site. mcp-server 0.50.0.
FOUND WHILE VERIFYING, AND FIXED: A REFUSAL THAT NAMED A DIFFERENT CAPABILITY EACH BOOT.
Kit's compact constructor used Set.copyOf for `requires`, whose iteration order
java.util.ImmutableCollections RANDOMISES PER JVM RUN (a salt, not a hash accident) -
and KitMaterializer refuses on the FIRST missing capability. `cli` lacks three of the
survival kit's four, so the same kit and the same client refused by naming `stop_hook`
on one boot and `tool_denylist` on the next. probes/agent-client.test.mjs case 11 pinned
the literal `stop_hook` and had therefore been passing on a coin flip since it was
written; it went red here with nothing about capabilities changed. Kit now preserves
DECLARATION order (unmodifiableSet over LinkedHashSet), so the message is stable, and the
probe asserts the CONTRACT instead of the implementation detail: whatever it names is a
capability this kit requires and this client lacks. Same family as
[[enum-hashcode-identity]] - an unordered collection of enums is a per-run instrument.
NOT DONE, deliberately: rocketeer/.mcp.json still pins `full` to work around a hole that
no longer exists, and menagerie/.mcp.json still names no profile (which is now correct).
Both are other repos; the pin is now merely redundant rather than load-bearing.

## 0.106.0

ONE REBUILD CYCLE PER PORT. The dev loop's launcher could shoot its own game.
tools/rebuild.ps1's FIRST ACT is to force-kill whatever holds the bridge port, and
nothing stopped two of them running at once: launch_game spawns a fresh PowerShell per
call, every Claude Code session in this checkout runs its own copy of mcp-server, and
all of them push the same basePort() down. The symptom was a world closing itself
mid-session, nearly filed as a render bug against 0.105.0's new camera; the cause was a
supervisor left over from an earlier launch arriving at its step 1.
THE LOCK IS A FILE HANDLE, NOT A PID FILE. %TEMP%/mcptk-rebuild-<port>.lock is held
open FileShare::Read for the cycle's life, so the OS drops it when the holder dies - a
crashed or force-killed supervisor leaves nothing stale behind and there is no liveness
check to get wrong - while a human, or dev-procs.ps1, can still read who is in there.
A second cycle on one port exits 3; -Takeover kills the holder and claims it, having
first verified the pid really is a rebuild.ps1 (pids are recycled) and killing the
SUPERVISOR ONLY, never its tree, because past step 3 the game is that supervisor's
CHILD and a tree kill would close the world this whole item exists to protect.
THE EXIT CODES WERE NEVER REAL. $ErrorActionPreference = 'Stop' makes Write-Error a
TERMINATING error, so every guard in the script died before reaching its `exit` and
PowerShell returned 1. launch_game has documented "exit 2 = refused production
instance" for as long as that guard has existed and the script has never once produced
a 2. Found by the new lock's own test asserting exit 3 and getting 1 - the guard whose
message was perfect and whose exit code was fiction.
launch_game gains the in-process half: a second call while our own supervisor is alive
is refused with that supervisor's pid and log, rather than spawning a rival that dies
on the lock and leaves the reason in a file nobody reads; and the supervisor is killed
if this server exits under it (single process, never the tree). Best-effort by
construction - a hard-killed MCP server runs no handler at all, which is exactly why
the port lock and not this is the load-bearing guard. takeover:true forwards -Takeover.
NEW: tools/dev-procs.ps1, because NONE OF THESE PROCESSES HAS AN OWNER WHO WILL REPORT
THEM - a supervisor outlives its caller, a Gradle daemon is designed to outlive its
build, a dev client is deliberately detached so it can outlive its launcher. Each is
correct alone; the sum is a machine carrying a gigabyte nobody remembers starting. It
lists cycle locks, bridge ports, supervisors, daemons and dev JVMs, and reaps on ask.
ITS FIRST DRAFT WOULD HAVE KILLED ANOTHER PROJECT. Matching dev JVMs on `net.fabricmc`
anywhere in a command line matched a rocketeer server AND a menagerie server, running
from other checkouts in other sessions on this same machine; and `gradlew --stop` is
user-wide, while both of those daemons were the PARENT of a running game. Scope is now
the repo path appearing in the command line and nothing looser, foreign JVMs are listed
and never touched, daemon stopping is a separate flag that refuses while any daemon
hosts a game, and -DryRun exists so a refusal can be checked before it is trusted.
Probes: tools/probes/rebuild-lock.test.ps1 (13 cases over the lock - refusal, its exit
CODE, per-port scoping, takeover, the OS-released handle) and
tools/probes/launch-guard.test.mjs (16 cases over launch_game's guard), both green and
both needing NO game: they run on spare ports with -NoRelaunch -SkipBuild and never
reach Gradle. New home tools/probes/, because mcp-server/probes/ is the live set
(`npm run test:live`) and these are the opposite of live. No battery chunk - none of
this is a bridge tool. mcp-server/ suite still 189/189. mcp-server 0.49.0.
NOTE: 0.105.0 has no entry here. That release's narrative went into its commit message
(4751cf2) only; this line records the gap rather than inventing the entry after it.

## 0.104.0

THE TOOLKIT STOPS BEING A CLAUDE CODE ACCESSORY. (RELEASE_1.md section A, the item the
rest of the release was blocked behind, designed in AGENT_CLIENT_ADAPTER_DESIGN.md.)
ADAPTER, NOT STRIP. Claude Code becomes ONE BUNDLED ADAPTER behind an AgentClient
interface, and its presence is the evidence the contract is real rather than speculative
- the same argument the extension seam won on. Nothing is deleted; what moves is
ownership. agent.client= is EMPTY by default and that is a supported state, not a
disabled one.
THE FINDING THAT RESHAPED THE ITEM: THERE ARE TWO DIRECTIONS AND ONE NEEDS NO CONFIG.
Section A5 called "bridge up, no client configured, server registered by hand" a
configuration that has never existed. Half wrong: INBOUND has worked since POST /hello -
a modder writing this server into their own host gets a registered, attributed,
chat-routable session with no toolkit configuration whatsoever. agent.client gates the
OUTBOUND launcher only, so the supported path is not a setting at all, it is the absence
of one. What inbound actually lacked was IDENTITY: hello carried only {label}.
THE SECOND FINDING: THE MEMORY RENDER WAS ALREADY A TOOL. Section A4 wanted it "made
reachable as a tool call"; mem_recent has returned it as an ordinary result all along and
the SessionStart hook is a 55-line shell that prints that field. The real gap was
narrower and different in kind - a non-Claude host has no REASON to call it at session
open - so the fix is the HELLO REPLY, which is the one moment the toolkit speaks first.
Building a second delivery path would have been work against a problem that did not
exist.
CONTINUITY IS A CAPABILITY, NOT A METHOD. An optional-method-that-may-throw is the shape
that produces half-working. So: nine Capability values named after what a KIT needs, a
kit REQUIRES or PREFERS them, and materialization arbitrates - a kit requiring a
capability the client lacks is refused BY NAME. The alternative it replaces is a launch
that succeeds and then silently does not loop, which is the failure class nobody watches
for because everything reported success.
THE KIT REPLACES A BOOLEAN. bootstrap(client, boolean survival) had its entire second
branch inside that flag. A Kit is workspace + profile + files + hooks + prompt + mode +
capabilities, registrable by extension mods, and the unit a refusal names. The three
write policies (machine-owned, write-if-absent, reconciled-against-markers) were already
per-file in the tree and are now DATA on the file, which is what makes a data-driven
adapter possible: SpecAgentClient materializes what a kit declares and needs no per-file
knowledge. Companions became a kit too - the only thing that makes a companion a
companion is no window and a prompt, and both are kit properties.
WHAT THE BUILD CORRECTED IN THE DESIGN - four things, recorded in the design's section 12.
Interactive/headless did collapse into one launch(kit) as designed; .mcp.json and
settings.json did NOT stay templates (they are generated, because the hooks are now the
kit's declaration and the two settings templates differed only by one hook); the launch
SCRIPT is the adapter's, not the kit's (run-loop.ps1 runs `claude`, so a kit cannot own
it - Continuity.RELAUNCH is the kit's half); and ClaudeButton/ClaudeMenuScreen did NOT
move into the adapter package as section 6 listed - they became client-AGNOSTIC launcher
UI driven by Kits.all(), which is what section B1 needs and would have had to undo.
Two default methods on McpToolkitEntrypoint (registerKits, registerAgentClients) - the
seam widens with no version break, and every extension that implements it as a lambda
still compiles.
Probe: probes/agent-client.test.mjs, battery chunk b, declared on the day it shipped. Its
falsifier needs two clients with DIFFERENT capabilities, and the tree ships two: the
bundled generic `cli` adapter declares no hooks, which is the honest default rather than
a test fixture. No site. mcp-server 0.47.0 (hello self-declaration).

## 0.103.0

WHAT WILL THE WORLDGEN MAKE HERE? (RELEASE_1.md section D4, phase 1 of three.)
The last open section D item, and the one that calls itself the hardest. The deliberate
scoping it asked for is WORLDGEN_ITERATION_DESIGN.md, written against the decompiled
source: worldgen is not one job, it is THREE DOORS, and they are not equally open.
THE LOOP IT ATTACKS. Worldgen registries are read ONCE, into the frozen RegistryAccess a
ServerLevel is built from - /reload never looks at worldgen/ - so an edit lands only on a
world restart, and then the ground under you is still the OLD ground because it is
already on disk. What is left is "fly ten thousand blocks and look at somewhere else",
which is slow and, worse, NOT COMPARABLE: every iteration is a different landscape in a
different place. (And not cheap: ReadSupport measured a virgin chunk at ~900ms against
~12-16ms to page an existing one, because one FULL chunk drags its neighbours through the
pyramid out to MAX_STRUCTURE_DISTANCE.)
`preview_worldgen` IS DOOR 1: ask the loaded generator and GENERATE NOTHING. getBaseHeight
/ getBaseColumn / getNoiseBiome are the same calls vanilla uses to place a structure and
find a spawn; microseconds, no chunk, no ticket, no disk. A point or a `radius` grid, the
noise column run-length encoded, the biome, possible_biomes - and the field that earns the
entry, THE NOISE-SETTINGS ID AND SEED ACTUALLY IN FORCE, which is the direct answer to
"did my push_data plus restart land". `compare:true` reads the world's own OCEAN_FLOOR
beside it, which is the staleness question.
`seed` IS THE THING A RESTART CANNOT DO. RandomState.create builds an independent
RandomState at ANY seed from registries already in memory, so "what does seed 12345 look
like here" is an argument rather than a world rebuild. Noise generators only - the canvas
dimensions (0.102.0) are minecraft:flat, so the probe refuses against a REAL non-noise
generator in the same server rather than a mock.
THE BOUNDARY IS DECLARED THREE TIMES - description, reply and javadoc - because it is half
the surface. iterateNoiseColumn is the density router and the aquifer and stops: before
surface rules, carvers, features and structures. A surface_rule edit is invisible here BY
CONSTRUCTION. Every field is named noise_*, never terrain, because a tool that answered
"the terrain" while meaning "the noise" is the succeeds-falsely class. The live column at
a virgin coordinate proves it in one line: stone from min_y to the surface and NO BEDROCK,
because bedrock is a surface rule.
ITS OWN ENTRY, and the cheaper build was refused. A source:"generator" flag on
get_region_summary takes the same arguments and returns the same shape for no new manifest
line. Refused for roll_loot's reason (section E6): this read is an ORACLE - it reports
ground that has never been generated, which is what is over the horizon - and inside a
perception tool that authority rides into every play, survey and survival turn. DEV_ONLY.
THE FIRST LIVE RUN WENT 9/9 GREEN AND THE TOOL WAS STILL WRONG. Reading the output rather
than the pass count found it: ChunkGenerator.getBaseHeight returns the first FREE y and
ChunkAccess.getHeight returns getFirstAvailable()-1, the topmost SOLID one. Subtracting one
from the other put a systematic -1 on every undisturbed column - identical:0 over a
49-column grid at spawn - which is EXACTLY the "large or one-directional shift" the reply
tells a caller to read as "your generator has changed". The headline feature was reporting
every world as stale, and no assertion in the file could see it. Both sides are now
first-free, and the probe gained the case that would have caught it.
Probe: probes/preview-worldgen.test.mjs, 9 cases, live-green. The load-bearing one is a
falsifier: preview a column five million blocks out, then ask the WORLD and require it to
STILL report an ungenerated chunk - a tool that quietly took a chunk to FULL would pass
everything else in the file. Owns no site (it writes nothing anywhere); battery chunk b.
NOT DONE, and the design says why each is where it is: phase 2 `regen_region` (door 2) -
the complete, destructive one, four sequencing traps deep - and phase 3, a fresh world at
a seed (door 3), which is the restart the modder already does.

## 0.102.1

THE WORKSHOP WAS PURE BLACK, AND THE FRAME HUNG OVER THE OVERWORLD.
Two defects from the FIRST HUMAN RUN of 0.102.0's hand - both invisible to every check
this repo owns, because both are properties of a RENDERED FRAME and the camera does not
exist yet.
 - `ambient_light` IS NOT THE 26.2 LIGHT KNOB. The lightmap is built by
   LightmapRenderStateExtractor out of environment attributes (block_light_tint,
   sky_light_factor, sky_light_color, ambient_light_color); DimensionType.ambientLight()
   survives only in Lightmap.getBrightness and LevelReader.getLightLevelDependentMagicValue
   - the HUD vignette and the gameplay magic value. visual/ambient_light_color's own
   default is opaque BLACK (-16777216), so "unset" is not "some sensible light", it is
   NONE: a skylight-less workshop with no torches in it was black with silhouettes. The
   workshop now sets #B4B4B4 - far above vanilla's night floors (0A0A0A overworld, 302821
   nether, 3F473F end) because with no skylight it IS the light. studio.json already set
   #FFFFFF and was correct by accident; its comment claimed `ambient_light` did the job.
 - A GIZMO CARRIES NO DIMENSION. LevelExtractor drains the collector into whatever level
   the viewer stands in, so CanvasFrame's unfiltered push drew every open session's frame
   in the OVERWORLD too - a white box over the spawn hills. There is no viewer to ask on
   the server side; the stand-in is to draw a frame only while somebody is in the level it
   belongs to, which on an integrated server (the only place a gizmo reaches a screen) IS
   the viewer.
Probe: canvas-edit.test.mjs gains a STATIC case - both canvases must declare
visual/ambient_light_color - which runs with the game down and is the only kind of check
that can catch an unlit dimension before phase 1 renders a pixel. 11 cases.

## 0.102.0

A PLACE TO BUILD IN, AND A FRAME THAT IS THE CONTRACT.
(RENDER_SEAM_DESIGN.md phase 2 + phase 5. Phases 1, 3 and 4 - the camera - are NOT built.)
Two shipped dimensions and the `nbt -> open -> edit -> close and save` loop a human drives
from in-game. `mcptoolkit:workshop` is where somebody works: sky to orient by, a sun that
never moves, no night, no weather. `mcptoolkit:studio` is the camera's backdrop that phase
1 will shoot against: skybox "none", white fog, flat full-bright. Two dimension types and
not one with a toggle, because `skybox` and the EnvironmentAttributeMap are static data
read at world load.
THE MOD-RESOURCE DATAPACK ROUTE DOES NOT WORK HERE, and the design assumed it did. A mod's
data/ is loaded as a datapack by fabric-resource-loader, which is fabric-api, which this
toolkit deliberately does not depend on (0.39.0, loader-only) - McpToolkitTags already
records that rule and answers it with a Java floor. A dimension HAS no Java floor. So the
same bytes take a second road: Canvas.install writes them into the live world datapack on
every server start, where vanilla itself discovers and auto-selects them. Shipped in the
jar AND installed into the world, from one source, so the two cannot disagree. Costs one
restart on a world that has never seen them - worldgen is read before the server exists -
and Canvas.absentMessage is the refusal that says exactly that. VERIFIED: both dimensions
appeared in this workspace's existing run-server world, with no fabric-api present, which
is the harder half of the design's unverified claim.
THE FRAME IS THE CONTRACT (section 10.3). capture_structure requires min+size and infers
neither, and that does not change; what is new is a SESSION that remembers them, so a save
is one word instead of six coordinates - and the remembered box is the frame, never the
template's own size. That is the July villagejobs editor's actual bug: a template-sized
capture eats the eave somebody added and the loss shows up later as a seam. `save` also
reports the non-air cells sitting OUTSIDE the frame, so "I built past the box" is
something the tool says rather than something the human discovers.
COMMANDS, NO MCP ENTRY. Section 6 puts the bridge side on `render`'s op field and `render`
does not exist yet; a tool entry now would be reshaped the moment it did. FakePlayerCommand
wrote the rule: a server command is reachable from a probe through run_command at ZERO
manifest cost, which is what a capability under verification should cost. /mcptk
edit|frame|save|cancel|canvas.
FOUR THINGS THE DESIGN HAD WRONG OR OPEN, settled against the decompiled source:
 - void darkness is NOT fixed by a flat generator. ServerLevel.isFlat() reads the SAVE's
   SpecialWorldProperty, not the dimension's, so a canvas in a normal world is never flat.
   min_y -64 with the working plane at y=64 clears the 32-block fade AND the y=63 horizon.
 - the canvas biome must provide NO attributes rather than set them: addBiomeLayer installs
   a positional layer for every attribute ANY loaded biome provides, and an empty map falls
   through to the dimension's constant layer.
 - the gizmo push seam is Gizmos.addGizmo from a server tick - but ONLY on an integrated
   server. IntegratedServer wraps its tick in a collector; MinecraftServer has none and
   LevelExtractor never reads a dedicated one. So the frame is DRAWN in singleplayer and
   reported as not drawn otherwise, which is the defined dedicated-server answer trap 3
   asks for, not a skipped case.
 - a save cannot reload and answer in the same command: a capture with reload:true
   completes a tick later, by which time the command's feedback collector has stopped
   listening, and run_command reported an EMPTY output for a save that had written the
   file. The write is synchronous, the reload follows and is reported when it lands.
Probe: probes/canvas-edit.test.mjs, 10 cases, live-green, 0 skipped - the two design
arbiters (the grown frame's cell survives the round trip; place_structure compare:true
names EXACTLY the one edited cell) plus both falsifiers (a block built past the frame is
named; cancel leaves the datapack byte-identical). Green beside data-validate, authoring
and place-structure (36 pass). Site 4.75M. Sessions persist per-world across a restart.
NOT DONE: the camera. No render, no open_world, no orbit; the studio has never been
photographed and its white backdrop is still a code-path inference, not a pixel.

## 0.101.0

WHAT DOES THE TABLE ACTUALLY DROP? (RELEASE_1.md section E6, the loot half.)
A modder could push a loot table (0.91.0), have the game's own codec accept the bytes
(0.100.0) and see that it LOADED - and still had no way to ask the only question that
matters: what comes out, how often. `roll_loot` asks the running game to roll it.
Subjects: `table` (an id), `block` (an id or id[state], rolls that block's own table),
`entity` (a type id, its death drops), or `at` ALONE (the block actually there, with its
real state and block entity). `tool` is vanilla item syntax, so Fortune/Silk Touch ride
through unchanged; `killer` fills the attacker slots; `count` aggregates a distribution
(per item share/avg/min/max, plus empty_rolls) and `seed` makes the run re-derivable.
A NEW ENTRY, and the fold question was asked first. query_registry's question is "what is
registered"; this one is "what does it produce under these conditions", and the engine
below the parse is a LootContext simulation, not a registry read - Finding 6b's test,
failed in the direction that says build the entry. It also has an AUTHORITY of its own:
given a container's lootTableSeed it reports the contents of a chest nobody has opened,
which is X-ray by a different door, so it is DEV_ONLY and a fold into query_registry
would have carried it into every profile that reads a registry.
THE PARAMETER SET IS THE MECHANISM, not a table in the file. Every loot table declares
its own ContextKeySet and ContextMap.Builder.create refuses a build missing a required
key, so the tool OFFERS every parameter it can construct, keeps the ones the table's own
set allows, and reports them. A table asked in the wrong context is refused BY NAME
("this_entity ... give `entity`") instead of rolled empty - the commonest way a roll
comes back empty for a reason that is not the table, and a diagnosis no vanilla route
gives (`/loot` fixes the context in its syntax).
IT MUST SUPPLY ITS OWN RANDOMNESS, and that is a correctness rule, not a convenience.
LootContext.Builder.create falls back to server.getRandomSequence(key) when no random is
given, which CREATES AND ADVANCES persistent saved data - so the obvious implementation
of a READ would consume the world's own loot randomness and dirty the save. Passing an
explicit RandomSource every roll is what makes Mechanism.OBSERVE true in fact. The probe
arbitrates it with vanilla's own /random reset + /random value around a table that
declares the sequence by name.
A MISSING TABLE IS REPORTED, NEVER ROLLED: reloadableRegistries().getLootTable() answers
LootTable.EMPTY for an id that does not exist, which would report a typo as "your table
drops nothing". The registry is asked first and a miss answers exists:false with NO roll
fields at all - 0.100.0's rule, that a field which would read as a look must be absent
when nothing was looked at.
AND query_registry NOW REACHES THE RELOADABLE LAYER, which is where this started: it
could not see a loot table at all. MinecraftServer.registries is the world stem's layers
and its RELOADABLE layer is EMPTY - the loaded loot_table/predicate/item_modifier live on
reloadableRegistries(), so registryAccess() misses all three, and "did my loot table
load?" had no answer. Listing, tags, tag filtering and entry+codec JSON all work there
unchanged (LootDataType supplies the three codecs). ZERO manifest cost: they are registry
ids, which is what the description already tells a caller to pass.
AND THE FIRST LIVE RUN FOUND THREE THINGS, one of them in this entry's own words.
(1) THE AGGREGATE WAS A LIE, and it is the finding worth carrying. The first draft seeded
each roll separately as RandomSource.create(seed + i) - a legacy LCG asked for its FIRST
draw from adjacent seeds, which are correlated. The probe's pool with random_chance 0.5
fired ZERO times in 200 rolls. Not a weak measurement, a WRONG one, and the whole point
of `count` is a number a modder tunes against. One source created from `seed` and carried
across the run is correct AND still reproducible, and roll 0 is byte-for-byte vanilla's
(LootContext.Builder.withOptionalRandomSeed IS RandomSource.create(seed)). Re-measured
after the fix: 0.504 over 2000 rolls. A generator that is deterministic is not therefore
a generator that is random, and the check is a distribution you already know.
(2) THE ENCHANTMENT EXAMPLE IN THIS TOOL'S OWN DESCRIPTION WAS WRONG - the same shape as
0.100.0's tags/blocks/ finding, one release later. It read
`minecraft:enchantments={levels:{'minecraft:fortune':3}}`; ItemEnchantments.CODEC in 26.2
is an unbounded map with NO `levels` wrapper. The probe pointed the game's own ItemParser
at the manifest's example and the game refused it. Write the example, then RUN it.
(3) The `at` form refuses an unloaded chunk rather than answering from nothing; the probe
asserts both halves so the refusal is proved to be about residency, not about the argument.
PRICED, THEN TRIMMED, per Finding 5. First draft 2382 chars = ~745 tok/turn against
Finding 4's ~589 floor; the waste was the four SUBJECT GLOSSES, written once in the
description and again in the schema. Shipped at 2081 = ~651 tok/turn (desc ~329, schema
~298), -94/turn, paid only by dev sessions. query_registry: 1767 chars BEFORE and AFTER.
Probe: probes/loot-roll.test.mjs, 11 cases, live-green from a cold start on an isolated
dev server (-Pport=25621 -PrunDir=../run-server-loot), with conformance (51), arg-check,
registry-detail (26), data-validate (15), log-channel, promote and profiles green beside
it - 141 pass, 0 fail. No site; one datapack namespace, cleaned up. Battery chunk b (it
reloads). mcp-server 0.43.0.

## 0.100.0

DOES THE GAME'S OWN LOADER ACCEPT THIS FILE? (RELEASE_1.md section E1, the codec half).
The running game is holding every datapack codec right now. push_data was writing bytes
into a pack and hoping; it now asks the loader's own codec the question first, on the
bytes, before the write - and reports `validation` {kind, id, checked_by, valid, error}.
NOT A NEW TOOL, and not for the usual reason. Finding 6b's test is whether two argument
shapes share the engine below the parse; here it is stronger than that - validation has
no arguments of its own at all. It is the same path and the same bytes, asked a second
question. So it rides push_data's entry - MEASURED +471 chars, ~147 tok/turn against
Finding 4's ~589 floor for a new entry, a 4x saving, and the counterfactual is worse than
the floor says because a separate validator would re-document path/base64/file too
(TOKEN_PER_TOOL_FINDINGS.md Finding 12). The only NEW argument is dry_run - 99 of the 471
chars - and that ratio is a property of the fold's KIND: a second question about an
existing argument list has no shape to declare, so it is nearly all prose.
WHAT IT CATCHES THAT A RELOAD CANNOT, which is the whole argument for building it beside
0.91.0's log channel rather than instead of it. (1) WORLDGEN IS NEVER RELOADED AT ALL -
biomes, features, noise settings, dimension types are read once at world load, so a
reload logs nothing about them because it never looked; the only previous way to find a
malformed biome was to RESTART THE WORLD. (2) A batched push (reload:false) has no
reload to report from, and that is the mode a typo survives longest in. (3) A directory
nothing scans logs nothing: data/ns/tags/blocks/ (plural) is scanned by no loader, and
it fails by being silently ignored.
AND THE THIRD ONE WAS IN THIS FILE'S OWN TOOL DESCRIPTION. push_data's example path has
read "data/minecraft/tags/blocks/mineable/pickaxe.json" since it was written. Tag
directories have been SINGULAR since 1.21 (Registries.tagsDirPath is "tags/" + the
registry key's path, and Registries.BLOCK is "block"), so the toolkit's own manifest was
pointing modders at a directory the game does not read. The first thing the new
path->kind resolution was pointed at was the tool's own documented example, and it came
back kind:null.
PATH -> LOADER IS ONE TABLE, because in 26.2 every server-side JSON loader is keyed by a
ResourceKey<Registry<...>> whose PATH IS ITS DIRECTORY. RegistryDataLoader's three lists
give the datapack registries (the same source query_registry's `json` reads, so a
registry becomes checkable here the moment the game can load it from a file);
LootDataType.values() gives predicate/item_modifier/loot_table without transcribing
them; Registries.RECIPE + Recipe.CODEC and Registries.ADVANCEMENT + Advancement.CODEC
are the last two. Longest directory first, so worldgen/biome cannot lose to a prefix.
A TAG NAMES A REGISTRY, NOT A LOADER, so tags/ resolves against the LIVE registry set
instead - tags/block and tags/entity_type are legal and neither is datapack-loadable.
And the codec alone would pass a typo'd member: TagFile.CODEC accepts any well-formed
id, and TagLoader logs-and-drops the miss at BIND time, leaving a tag silently one
element short. So members are resolved too, through TagEntry.verifyIfPresent - vanilla's
own public door, which short-circuits for `required:false` without calling the
predicate, so the author's declared intent is honoured rather than re-implemented.
A FUNCTION IS COMPILED, NOT DECODED: CommandFunction.fromLines with the server's own
dispatcher and its own getFunctionCompilationPermissions(), so the error text and the
LINE NUMBER are vanilla's and a command the datapack could not run does not pass here.
IT REPORTS, IT DOES NOT REFUSE. A batch legitimately pushes siblings in an order where
one cannot resolve the other yet; refusing the write would make that order illegal. So a
bad file is written and said to be bad. dry_run is the door for not writing.
checked_by NAMES THE MECHANISM (codec | command_dispatcher | nbt | none) and an
unrecognised path gets NO `valid` FIELD AT ALL - the tag_exists rule from 0.92.0 and the
mixins.detection rule from 0.96.0, applied to the case where the honest answer is "I did
not look". A validator that answers valid:true for a file nothing reads is worse than no
validator.
Probe: probes/data-validate.test.mjs, 15 cases, live-green from a cold start on an
isolated dev server (-Pport/-PrunDir). No site - it stages no geometry and every case
either writes into its own namespace with reload:false or writes nothing. Battery chunk
b. No mcp-server change: no new tool, so no manifest line and no DEV_ONLY entry.
THE ARBITER IS THE GAME, NOT A CONSTANT. The probe's key case pushes the same bad recipe
FOR REAL and asserts the pre-flight `error` is byte-identical to what the reload LOGS -
the dry-equals-live discipline place_shapes bought. It also showed vanilla losing
information there: the message is "List is too short: 0" and the offending id appears in
NEITHER answer, because a DFU list codec drops an element it cannot decode rather than
erroring on it. Reporting the game's message verbatim is correct; inventing a better one
would invent a message the log will never contain.
SECOND BUG, IN THE PROBE CORPUS: promote.test.mjs' two recipe fixtures used
ingredients:[{item:...}], which is that same empty-list case - so that file has been
pushing recipes the game REJECTS since 0.95.0, unnoticed because nothing ever asked
whether they loaded. Fixed here: a wrong example in a probe is one a reader copies.

## 0.99.0

TOOL_SURFACE, AND WHETHER WHAT GOT BUILT IS WHAT THE FILE SAYS. Two topics.
PLACE_STRUCTURE LEARNS TO COMPARE. rocketeer asked for a world-box <-> structure diff:
authoring a room means building it, capturing it, and then finding out whether what a
generator DREW matches what the piece SAYS - the one question a screenshot cannot answer,
and the question whose hand-rolled version found the mouth-erasure bug. It is an ARGUMENT,
not a tool: compare needs {id, at, rotation, mirror, dimension}, which is place_structure's
own argument set minus the write flags, so a separate tool would have re-documented all
five (~1,500 chars) to add ~250 - the write_box merge priced exactly this and saved 338
tok/turn.
READING A TEMPLATE'S CELLS IS THE HARD HALF, and this file already documented the trap:
StructureTemplate.filterBlocks filters TO a block, not away from it, because its caller is
jigsaw code hunting connectors - the first draft of place_structure used it and every count
came back 0. The real list is behind a private `palettes` field, and reaching it means an
access widener: Fabric-only, and this jar also ships NeoForge. So the cells are read back
out of the template's OWN SAVED TAG, the same idiom capture_structure uses for its census -
a fact taken from the bytes rather than asserted about them.
MIRROR THEN ROTATE, which is what placeInWorld does - and placeInWorld is what actually
drew the blocks being compared. filterBlocks rotates and does NOT mirror; copying it would
have made every mirrored comparison wrong, and wrong in the direction that reads as the
BUILD being at fault rather than the tool.
WHAT IT REFUSES IS PART OF THE ANSWER. A multi-palette template is refused rather than
compared against one arbitrary variant (which would report the other variants' cells as
differences). `not_specified` is reported SEPARATELY from `match`: a template stores no
cell where it has structure_void, so those positions carry no opinion, and reading one as
the other is how an unfinished room reports as a finished one. `outside_footprint` counts
cells whose transformed position lands outside the bounding box - it can only be non-zero
if this arithmetic disagrees with vanilla's, so it is the tool reporting ITSELF wrong
rather than the build.
AND IT GAVE DRY_RUN THE NUMBER IT SAID IT COULD NOT HAVE. place_structure's dry run carried
a paragraph explaining that it could not report how many cells a placement WOULD change,
because it had no access to the template's cell list, and that a number it cannot compute
is not a number it may guess. That list is exactly what compare needed, so dry_run now
reports `would_change`, from the SAME loop - the preview cannot drift from the run.
LIVE-VERIFIED, 12 arms, against a state that was CONSTRUCTED rather than found: build a
known 4x3x4 volume, capture it, compare untouched (identical, differ 0, template_cells
48/48, not_specified 0, outside_footprint 0), then break EXACTLY three cells and require
differ == 3 naming exactly those three. It did. dry_run's would_change agreed at 3, and a
re-compare still read 3, so neither mode wrote anything. An agreement between two things
I wrote would not have been evidence; a perturbation of known size is.
FOUND ON THE WAY, and it is a real defect: `launch_game target:"server"` CANNOT SUCCEED in
this workspace. rebuild.ps1 polls a hardcoded 25599 while run-server/config/
mcptoolkit.properties pins port=25610, so the launcher waits out its four minutes on a port
nothing will ever open while a perfectly healthy server runs beside it. The bridge was up
the whole time. Not fixed here - the static-vs-dynamic port question is its own change.

*(a second entry written under the same version, kept as written)*

TOOL_SURFACE: THE SESSION NARROWS ITSELF TO ITS JOB (built by mcmodding-3c on 0.98.0's
watcher). Once a tool list can be re-read mid-session, the profile stops having to be a
launch-time guess. One local tool, never proxied: no args reports the current profile and
what it costs, `{profile}` switches and the result says what the switch COST and what it
SAVES per turn - which is 0.98.0's hazard 1 answered where a caller will actually read
it, on the tool that spends the money.
A DELIBERATE NEW ENTRY, against the rule this repo has paid for twice (write_box folded
into set_blocks, 745 -> 407 tok/turn; query_registry's entry/tag at +181 against ~2,356
for four tools). The exception is argued at the constant rather than assumed: the entry
is ~918 chars (~230 tok/turn, measured as the delta between a 95-tool and a 96-tool
serialization of the same manifest) and one call removes ~28.5k. It must also be findable
WITHOUT already knowing which host tool would have hidden it, and un-hideable by any
profile - AN ARGUMENT ON A TOOL A PROFILE CAN HIDE IS A DOOR THAT LOCKS FROM THE INSIDE.
`authoring` IS A KEEP-LIST, NOT A HIDE-LIST, and that is the load-bearing choice. Every
hide-list in this file drifts - 0.98.0's second topic is what that costs. A keep-list
cannot drift the same way: an absent name is simply absent, and a NEW tool is excluded by
default instead of silently inherited. It fails toward TOO LITTLE surface, which the
agent can see and widen in one call, rather than too much, which nothing reports.
0.98.0's HAZARD 2 WAS REAL AND WORSE THAN EITHER SESSION SAID. The stale-list window is
inherent (a switch narrows the surface immediately; the client holds its old list until
it re-reads), so a dropped tool now refuses with `profile_hidden` naming the profile and
the way out instead of "Unknown tool" - which would send a caller hunting a toolkit bug
for something that is neither. But writing that probe found an ESCAPE: the never-hide
rule was `CAN_SWITCH_PROFILE && name === SURFACE_TOOL_NAME`, which under survival fell
through to the profile checks, where no list happens to name the verb. It was correctly
ABSENT from tools/list and STILL CALLABLE - a survival body that knew the name from prior
context could have switched profile and walked out of its own legality contract. Now
`name === SURFACE_TOOL_NAME ? CAN_SWITCH_PROFILE : ...`, plus a deliberately unreachable
second refusal at dispatch, on bot_profile's precedent. Legality stays a LAUNCH property:
every survival gate binds to PROFILE, never to servedProfile, so no switch can reach one.
Probes: probes/tool-surface.test.mjs, 3 cases, green - and the escape was caught by its
first run, which is the argument for having written it. Independently re-run here, and
the escape re-attempted end-to-end through the shim under MCPTK_PROFILE=survival: not
listed, refused, surface unchanged at 9 tools, no X-ray read returned.
PINNED, NOT OWED - and it started as owed, which is the better story. The 72% headline
was one session's live measurement that the other could NOT re-verify (the dev game had
quit, and a bridge-down shim serves 9 local tools, which prices nothing), so it went into
this entry as OWED rather than as a number taken on trust. It is now a probe:
probes/authoring-saving.test.mjs drives the REAL shim against probes/fixtures/
manifest-2026-08-26.json, the committed 90-tool capture the figure was taken from, and
reproduces 96/158,489/~39.6k -> 32/44,373/~11.1k with no game running.
IT ASSERTS SHAPE AND A FLOOR, NEVER THE FIGURE, because the obvious way to build this is
the same failure wearing a test's clothes - a golden number that quietly becomes the live
one. Exact membership (locate/get_events/bot_body/check_path/sense_entities gone;
set_blocks/capture_structure/push_data/describe_box/undo_edit kept; tool_surface always
served, since the way back out must survive the narrowing) plus reduction >= 65%. A
description edit moves the char count by a few hundred and must NOT redden a probe; a
keep-list quietly regrowing until the profile saves nothing MUST. The expected count is
DERIVED from the capture plus localTools() rather than written as 32 - a machine with no
dev checkout has no launch_game and should be a different number, not a red probe
(probe-environment-coupling, paid for before).
FALSIFIED, TWICE, INDEPENDENTLY: "locate" injected into the keep-list makes it fail with
`authoring must not serve "locate"`, and the tree restores byte-exactly afterwards
(git hash-object before == after). A probe that cannot fail proves nothing. The shipped
description also
still said "roughly 80% less", the figure from the sketch that was priced off a leaner
keep-list than the one that shipped; corrected to ~70%, and the real number recorded at
the constant. Re-measuring now means RE-CAPTURING, which the probe header says out loud.
AND THE NUMBER HAD A THIRD COPY, which is the finding rather than the footnote. "About
80% cheaper" survived at KEEP_PROFILES after being corrected in the description, because
the fix went to the place that had been NAMED instead of to every place the number lived.
Its author had updated the two places they were SPEAKING from - a message and a report -
and never the artifact, which is the worst split available, since the code is what the
model reads every turn and no human reader meets it again. Two careful sessions, the same
failure, one afternoon. WHEN A MEASURED NUMBER MOVES, GREP FOR IT. Better: give it ONE
SITE OF RECORD and cite it from everywhere else - the floor comment in 0.98.0 now carries
only the magnitude (~40k) and points at KEEP_PROFILES, because a figure maintained in
three places is maintained in one and stale in two. mcp-server 0.42.0.

## 0.98.0

THE TOOL LIST STOPS BEING A SNAPSHOT, AND A CHECK THAT ARGUED FOR DELETING A HIDE.
THE TOOL LIST STOPS BEING A SNAPSHOT TAKEN AT CONNECT. Launching the dev game from a
session left that session unable to see the game's tools: `ping`, `bot_status`, all ~95
of them were absent until Claude ITSELF was restarted with a game already up. Which is
backwards, because `launch_game` is a local tool that exists precisely so a session can
start the game it is going to drive - the toolkit shipped the door and then locked the
room behind it.
THE SHIM WAS ALREADY RIGHT AND IT DID NOT MATTER. tools/list re-fetches GET /tools on
every request, deliberately (a stale manifest would advertise tools the attached game
does not have). But tools/list is a request, and the client makes exactly one, at
connect. Fetching fresh is worthless when nobody asks twice.
THE CAUSE IS ONE MISSING FLAG. The protocol's answer is
notifications/tools/list_changed, and a client registers its handler for it ONLY if the
server declared the capability - Claude Code 2.1.246 gates that registration on exactly
`capabilities.tools.listChanged`. The shim declared `{ tools: {} }`, so no handler was
ever wired, and any notification it sent would have been shouted into an empty room.
Declaring `{ tools: { listChanged: true } }` is half the fix and the half nothing works
without.
THE OTHER HALF IS AN EYE. Something has to NOTICE the manifest changing, so the shim
polls it, at a deliberately asymmetric cadence: 3s while the bridge is DOWN (the poll is
a localhost ECONNREFUSED, free, and what it waits for is a game boot a human is sitting
through) and 15s while it is UP (the poll parses a manifest, and the transitions left -
the game quitting, a client attaching its screen tools - tolerate a lazier eye).
ONE CHANGE IS ONE NOTIFICATION, and that needs TWO signatures, not one. `servedSig` is
what the client actually HOLDS (only a real tools/list answer sets it); `notifiedSig` is
what was last announced. Announcing only when a fresh list differs from BOTH means a
client that IGNORES the notification gets silence rather than one every 3 seconds - the
degradation is toward quiet, not toward spam. The "bridge unreachable" stderr line moved
to transitions for the same reason: a per-poll line would bury the session's real log.
THE PRICE CHANGED SHAPE, AND THAT IS WORTH SAYING OUT LOUD. A notification the client
HONOURS rewrites the tool block at the very front of the prompt: the client re-reads the
whole list and the prompt cache is invalid from there on. MEASURED live on the SERVED
list, which is what the client actually holds: 95 tools, 157,571 chars, ~39.4k tokens
(59% descriptions, 38% schemas). That is the SERIALIZATION, which is what a client
re-reads; the entry payload alone - descriptions + schemas, no names, no wrapper - is
152,144, and any figure computed off that denominator is the same measurement, not a
disagreement (the wrapper and names are the remaining 5,427 chars, 3.4%).
Two counts appear in this entry and they are DIFFERENT
QUANTITIES, not two moments - the bridge manifest is 90 tools, and a session serves 95:
plus 9 local tools (the memory surface, bot_scan, launch_game), minus the 4 the default
`standard` profile hides (get_surface, get_blocks_at, describe_box, stage_entity). A
client was attached for both readings. Before this the manifest
was a CONNECT-TIME cost paid once; now it is a per-change cost, and the intended
transition - the game booting mid-session - spends it at exactly the moment the agent
starts working. That is the right trade against a session that could not see the game at
all, but it means anything that makes the list FLAP is priced at ~39.4k a flap.
So notifications have a FLOOR: NOTIFY_FLOOR_MS = 30s, set above WATCH_UP_MS so no flap
can outrun it. A change arriving inside the floor is HELD and notifiedSig is deliberately
NOT recorded, so the next poll re-decides against the live list - a flap that settles
back to what the client already holds ends up costing nothing, and one that sticks still
lands when the floor lifts. Holding it forever would be this bug wearing a different hat.
The steady-state measurement below is the GUARD on all of this: a future conditional tool
that toggles (a client attaching and detaching its screen surface) would break it, and
silently, since nothing else in the session reports a tool-block rewrite.
Probe: probes/tool-list-changed.test.mjs, and it NEEDS NO GAME - it stands up a stub
bridge on an ephemeral port whose /tools answer it controls, which is the only way to
make the down -> up transition happen on demand. Both halves are checked to be
load-bearing by removing each one: without the capability the initialize result fails
the assert, without the watcher the notification never arrives. The floor is checked in
both directions - held inside the window, delivered after it. Live against the real
bridge: 95 tools served (the same 95 priced above), capability declared, and ZERO
notifications across 40s of a steady game.
A CHECK THAT ARGUED FOR DELETING A HIDE (found by mcmodding-3c, and it is the more
dangerous of the two). profiles.test.mjs - "a no-op hide is not a profile" - flagged five
of six hidden names as absent from the live manifest, and absent was read as DEAD (the
sixth only became visible after the aggregation fix below). They are not
dead: import_building, edit_building, save_building, list_buildings, get_region and
place_blocks are villagejobs EXTENSION tools (VillageJobsTools.java; extension.test.mjs
asserts these exact six as source:"villagejobs" and skips itself when the mod is not
loaded), absent only because the attached game was mcp-toolkit's own standalone one,
which hosts no villagejobs.
ABSENT FROM A MANIFEST IS NOT THE SAME FACT AS GONE, against an extension seam this
toolkit ships on purpose. Cutting them to make the probe green would have removed five
dev-authority building verbs from `play` and place_blocks - A WORLD-WRITE VERB - from
`survival`, the profile whose entire job is keeping world-edit away from a player-legal
body. The prune was proposed off a live manifest and caught before it was cut.
THE DEFECT IS THE CHECK'S PREMISE, NOT THE LISTS, and index.mjs already knew the concept:
the same warning exempts CLIENT_SURFACE as conditionally present. Extension-owned names
were never added. Fix = EXTENSION_SURFACE beside CLIENT_SURFACE, unioned into
`conditional`, with the near-miss recorded at the constant so the next reader does not
re-derive it. profiles.test.mjs now collects its failures instead of dying on the first
profile, which is why the first report said five of six.
THE FALSIFIER IS THE POINT. An exemption that silenced everything would also go green, so
green was not trusted: MCPTK_HIDE_TOOLS="totally_bogus_tool,place_blocks" under `play`
warns about exactly one name, totally_bogus_tool, and stays silent on place_blocks. The
check still bites a genuinely dead name; it stopped biting a conditionally-absent one.
A CHECK WHOSE FAILURE MODE IS "DELETE A RESTRICTION TO GO GREEN" NEEDS A FALSIFIER EVERY
TIME - it fails in the unsafe direction, which is what makes it worse than the counting
bug sitting next to it. 16/16 green. mcp-server 0.41.0.

## 0.97.0

KEYBOARD, SCROLL AND DRAG (RELEASE_1.md section D6). The screen surface was click and
set_text, so a screen with a tab order, a scrolling list or a slider was HALF-drivable:
you could press its buttons and reach nothing the wheel, a drag or the keyboard owns.
THE SPLIT IS FINDING 6's TEST, RUN ONE ARGUMENT AT A TIME. A drag is a click that moves
before releasing - vanilla's own MouseHandler is press/move/release and
ContainerEventHandler.mouseDragged forwards ONLY while isDragging, which a consumed
mouseClicked sets - so it is click's engine plus motion and rides click's entry
(to_label/to_index/to_x+to_y, steps). The wheel shares click's TARGET RESOLUTION but not
its engine; it rides the same entry anyway, because a new manifest line costs ~589
tokens/turn (Finding 4) and the description can carry a name the tool outgrew.
The KEYBOARD does not ride it: no pointer, no coordinates, no target, its own vocabulary
- send_keys, one new entry.
BOTH NEW MECHANISMS HAVE A BOOLEAN THAT LIES, IN OPPOSITE DIRECTIONS, AND THE REPORTED
FIELDS ARE CHOSEN AGAINST THAT.
(1) AbstractScrollArea.mouseScrolled returns true whenever the widget is VISIBLE and
clamps inside setScrollAmount, so handled:true is exactly as true at the bottom of a
list as in the middle - a caller paging off it never stops. So a scroll reports
scrolled_from/scrolled_to/max_scroll/at_top/at_end off the scroll area's own amount,
found by walking the same child chain the event routes down.
(2) Screen.keyPressed returns FALSE for Tab and the four arrows EVEN WHEN FOCUS MOVED:
it builds a FocusNavigationEvent, changes focus, then falls out of the switch to
`return false`. handled is therefore the wrong instrument for precisely the keys this
tool exists to send, and focus_before/focus_after are the right one.
A THIRD, ALREADY IN CLICK AND NOW SAID OUT LOUD: ContainerEventHandler.mouseClicked
returns true whenever a CHILD WAS AT THE POINT, consumed or not (Screen does not
override it), so clicked:true was never quite "the event was consumed" - the occlusion
check is what makes it mean the right thing, and the description now says so.
FAITHFUL DISPATCH, NOT AN APPROXIMATION OF IT: setLastInputType(MOUSE) on a press and
KEYBOARD_TAB/KEYBOARD_ARROW on those keys (Screen.setInitialFocus reads it back, so a
synthetic click that skipped the stamp left the NEXT screen focused as if a key had been
pressed); afterMouseAction/afterMouseMove/afterKeyboardAction; mouseMoved before each
drag step; charTyped per codepoint for text. 26.2 reads modifiers off the EVENT
(InputWithModifiers) rather than the real keyboard, which is what makes a synthetic
ctrl+a work at all.
Key names are the suffix of a key.keyboard.* id (underscores accepted for dots) resolved
through InputConstants, and an unknown one is refused BY NAME with the spellings that
would have worked. A repeat STOPS when the screen changes under it - Escape and Enter
routinely close a screen, and sending the rest would be acting on a screen nobody asked
for. scroll + a drag destination in one call is refused, which is ArgCheck's rule one
level down where the schema walker cannot see the MODE.
Probe: probes/ui-input.test.mjs, 14 cases, against DebugOptionsScreen - the one vanilla
screen with all three shapes AND a no-arg constructor open_screen can reach (~46 debug
entries overflow any window, a search EditBox, a plain-button footer). The drag and the
ctrl+a are both proved by a SECOND act rather than by their own reply: one backspace
empties the box only if a selection existed. mcp-server 0.40.0.

## 0.96.0

QUERY_CLASS (RELEASE_1.md section D5, promoted out of TODO 4.4): what a class ACTUALLY
is in this JVM. Post-transform method table and field types (erased AND generic where
they differ), superclass/interface chain, class loader, THE FILE ON DISK it was loaded
from, the mixins with merged methods in it, and a hotswap precheck. OBSERVE, ANY
context, DEV_ONLY, 382 tokens/turn (1,222 chars; 439 before a Finding 5 trim).
THE POINT IS THAT SOURCE CANNOT ANSWER IT. A decompiled tree and an IDE both answer from
source, which says what a @Mixin INTENDS. This says what happened: the probe's first
case is that MinecraftServerMixin is visible ON net.minecraft.server.MinecraftServer,
which is proof the mixin took in THIS run.
DETECTION IS @MixinMerged ON THE METHOD TABLE, and the boundary is stated rather than
implied. The marker survives to runtime and carries the mixin's own class name, so the
applied set is read off the class instead of out of mixin's internals - no compile
dependency on them, and NeoForge's relocation of that package cannot break it. What it
sees is METHODS: an injector leaves a handler behind (visible), a mixin that only adds
an interface or widens access leaves none. mixins.detection NAMES the mechanism so an
empty `applied` reads as "no merged methods" rather than "no mixins" - the rule
tag_exists follows in 0.92.0.
THE HOTSWAP BLOCK IS A PRECHECK, NOT A DESCRIPTION. hotswap_class' classpath default
re-reads the bytes a class was loaded from, so on a jar-loaded class the redefine
succeeds and changes NOTHING - a trap that tool can only refuse after being called.
Whether you are in it is a property of the loaded class: classpath_default says whether
the default will work, `safe` says whether the class may be redefined at all (false for
a mixin target or a Minecraft class). Verified live on both sides - MinecraftServer
reports false/false and names the loom-cache jar; McpToolkit reports true/true from
build/classes/java/main/.
A READ MAY NOT BE THE REASON THE JVM CHANGED. Asking "is this class loaded" without
loading it needs the instrumentation agent's loaded-class list, and self-attaching an
agent to answer a read is a larger act than the read. So the lookup uses the agent ONLY
IF a hotswap_class in this session already attached one (HotswapTools.
instrumentationIfAttached, which deliberately does not attach), and otherwise falls back
to Class.forName(name, false, ...) - which LOADS a class that was not loaded, without
initialising it. `lookup` says which mechanism ran and lookup_note says what the
fallback costs.
Probe: probes/query-class.test.mjs, 10 cases, live-green from a cold start with
conformance (40), perf, promote and arg-check beside it. No site - it stages nothing.
mcp-server 0.39.0.

## 0.95.0

GET_PERF AND PROMOTION (RELEASE_1.md sections D7 and D9): where the tick goes, and the
documented foot-gun that should not have survived into a public release.
GET_PERF is mspt (mean/p50/p95/max over vanilla's own last-100-tick ring, FILLED SLOTS
ONLY - a mean over the empty half reports a booting server as impossibly fast), the
derived tps CAPPED at the tick rate (a 1 ms tick is a server running at 20 and sleeping,
not one at 1000), the tick-rate state, and per dimension a census: loaded and
force-loaded chunks, pending tasks, block/fluid ticks, entities and TICKING block
entities, their commonest types, and the chunks holding the most of each. A count with
no coordinates cannot be gone and looked at, which is why hot_chunks carries block
coordinates. OBSERVE, DEV_ONLY, 367 tokens/turn (1,174 chars) - under Finding 4's ~589
floor. Its own entry rather than a mode of get_world_info because get_world_info answers
WHICH WORLD IS THIS, is served in every profile including the budgeted survival one, and
would then tax every play turn for a read only a modder makes.
THE PROFILE MODE WAS BUILT AND CUT, and the fact is the finding. Vanilla's own tick
profiler - startTimeProfiler/stopTimeProfiler, what /debug start and /debug stop drive -
returns NO TREE in 26.2: MinecraftServer.TimeProfiler.stop() hands back a ProfileResults
whose getTimes is Collections.emptyList() unconditionally, because /debug measures
duration and tick count to report an average tps. The real tree is behind
startRecordingMetrics, which writes a debug report DIRECTORY to disk and blocks the
server thread doing it - PRIVILEGED surface, not an observe read. Cut rather than
shipped empty; the probe keeps a case that profile_ticks is REFUSED so a re-add is
deliberate. And even that follow-on could not answer section D7's own sentence:
tickNonPassenger pushes a profiler section per ENTITY TYPE, tickBlockEntities pushes
nothing per ticker (one blockEntities section for the whole list), so no profiler in
this version can name the expensive block entity type. The census can.
TWO FINDINGS, both caught by the probe on its first live run. (1)
TickRateManager.runsNormally() is a ONCE-PER-TICK CACHE (runGameElements, recomputed in
tick()), so the first draft answered frozen:true AND runs_normally:true in one reply - a
summary contradicting the fields it exists to qualify. Now computed from state:
!frozen && !sprinting && tickrate == 20. (2) A forceload keeps streaming chunks in for
seconds afterwards and one of them held a MOB SPAWNER, so the probe's "the total moves
by exactly the hoppers I placed" was wrong about the world, not about the tool: type
counts are asserted exactly, totals as deltas, and the region is settled first.
PROMOTION IS NOT A VERB, IT IS AN ARGUMENT OF THE CLEAR. clear_assets/clear_data take
`promote` (a mod's existing resources root); each named file is copied there at its
pack-relative path and only THEN is the override deleted. `path` now accepts a
directory, so a namespace promotes as a unit. The forgettable step in LIVE_MODDING's
three-step recipe is the CLEAR - an override left behind keeps winning over the copy you
just made, the hour that item exists to save - so riding the copy on the clear makes the
forgettable step the one you cannot skip. +170 tokens/turn on clear_data (547 -> 1,091
chars after a Finding 5 trim), against ~589 per new entry: about 1,000 tokens/turn saved
versus promote_asset + promote_data.
THREE REFUSALS ARE THE FEATURE. The destination is never defaulted and never created (a
missing directory, or one with no fabric.mod.json/META-INF/assets/data, is refused by
name - writeToSource will happily build an assets/ tree in a checkout nobody is looking
at); every file is COPIED BEFORE ANY IS DELETED, so a refused promotion clears nothing;
and `promote` requires `path`, because promoting the whole pack would put every
namespace in it - minecraft's own overrides included - into one mod's source tree.
`unchanged:true` says the source tree already had those bytes, and the reply ends by
saying the promoted file reaches the game on the NEXT BUILD.
Probes: probes/perf.test.mjs (10 cases) and probes/promote.test.mjs (8), both live-green
from a cold start on an isolated dev server (-Pport/-PrunDir, beside another session's
game), with conformance (40), arg-check, log-channel, registry-detail and site-map green
beside them. perf owns site 4.70M; both in battery chunk b. mcp-server 0.38.0.
Mixin: LevelTickersAccessor (Level.blockEntityTickers) - an @Accessor rather than an
access widener, because this jar ships NeoForge too.
OWED: the clear_assets arm. Same Promote mechanism through the CLIENT context, compiled
and unrun - it belongs with RELEASE_1 section F5's client-envelope runs, the same shape
as section D1's owed client arm.

## 0.94.0

PLACE_STRUCTURE (RELEASE_1.md section D3): the write half of capture_structure, and the
phantom in a user-facing error message. GoalRunner's refusal of bot_target action:"build"
told the caller to use `place_structure` instead, and NO SUCH TOOL EXISTED anywhere in the
repo. A refusal that points at a phantom costs the reader exactly the call it saved them,
so this is built rather than messaged around; the probe's first case is that the name in
that sentence resolves.
THE COMPARISON IS run_command "/place template", and it is not close. That route answers
ok:true for a command that FAILED - a recorded trap of run_command - so it cannot report
the most likely problem, which is the template not being loaded. It has no undo and no
dry run. Here a missing template refuses BY NAME and points at query_registry
{registry:"structure_template"} (0.92.0, an hour older); the footprint is snapshotted into
the same EditJournal set_blocks uses, so undo_edit reverts a placement with block entities
and their contents intact; an unloaded destination refuses the whole call rather than
leaving half a building; and `dry_run` reports the footprint and what stands in it.
A NEW ENTRY, AND THE CHECK SECTION D DEMANDS WAS RUN. Finding 6b asks whether two argument
shapes share the engine BELOW the parse. They do not: a template placement is vanilla's
placeInWorld, which owns block entities, waterlogging fixup, jigsaw handling and entity
spawning, and routing it through set_blocks' applier would re-implement all of it. What it
does share is shared for real - EditJournal, undo_id, region, dry_run. 601 tokens/turn
(1,923 chars; 664 before a Finding 5 trim pass), DEV_ONLY beside capture_structure, so no
play/survey/survival session pays for it.
TWO FINDINGS, both about a call that reads as its own opposite.
(1) StructureTemplate.filterBlocks(pos, settings, block) reads like "every cell except
that block" and is the exact reverse: Palette.blocks(Block) filters TO it, because its
caller is jigsaw code hunting connector blocks. The first draft enumerated a placement's
cells with it and every count came back 0. The template's real block list is behind a
private `palettes` field, so reaching it means an access widener - Fabric-only, and this
jar also ships NeoForge. The tool diffs the WORLD instead: snapshot the footprint, place,
diff. Which is why dry_run reports `occupied` (exactly computable) and deliberately does
NOT report `changed` - a number it cannot compute without writing is not one it may guess.
(2) A PROBE'S OWN /fill WIPE WAS A SILENT NO-OP. /fill caps at 32,768 blocks and refuses
past it, run_command reports success anyway, and this file's setup box was 40,656.
probes/authoring.test.mjs carried the same line and the same bug (50,512) since 0.89.0,
passing only because every test fully overwrites its own site. Both wipes are now sized to
their sites AND CHECKED - the trap this tool exists to close, met in the probes' setup.
Probes: probes/place-structure.test.mjs, 12 cases, LIVE-GREEN from a cold start and green
on a re-run (it cleans up after itself), with authoring/conformance/arg-check/place-shapes
/registry-detail/log-channel green beside it. Owns site 4.60M; battery chunk b.
mcp-server 0.37.0 (the DEV_ONLY list).

## 0.93.0

ENTITY AUTHORING, phase 4 (ENTITY_AUTHORING_DESIGN.md §9): authored ANIMATION. Format 2
adds one key - `animations` - and a format-1 file is a format-2 file without it, so
nothing pushed before this needs re-exporting. The loader parses clips into vanilla's
own public records and bakes them against the model it just built; `stage_entity` gains
`clip` and `clip_time` (play, or freeze at a second so a mid-clip pose can be
screenshotted); the reply lists the clips a model carries, because the server never
reads geometry and a misspelt clip name is otherwise a statue with no explanation.
THREE DECISIONS §9 LEFT OPEN, ALL SETTLED AGAINST THE ARBITER, TWO AGAINST THE DESIGN'S
OWN LEAN (§9.6). (1) Keyframes are stored in VANILLA's final units, not as authored:
`KeyframeAnimations` does only vanilla's half of the flip, so a loader written from it
alone implements exactly half and MIRRORS EVERY ANIMATION'S X TRANSLATION - the §7.1
trap in a second place, invisible on the symmetric subjects this workspace is full of.
The plugin does the whole conversion and the loader does no arithmetic at all, which is
§4.1's rule for geometry arriving where it was already needed. (2) `pre`/`post`, not
Blockbench's twin keyframe at t+0.001: the twin is the codec working around its own TEXT
TEMPLATE, which cannot spell `preTarget`, and copying it would invent a number that is
nowhere in the document. Both formats have the two-value concept natively, so the
projection is a field-for-field copy - and it is the only one of the two that expresses
`step` EXACTLY (hold the value in the next keyframe's `pre` and force that segment
linear; vanilla lerps held->held, a flat segment, where the twin ramps across the last
millisecond). (3) §9.3 REVERSED: `verify` samples animated poses by VANILLA's rules, not
through Blockbench's timeline evaluator. The game is the authority on the pose being
judged, so Blockbench's evaluator is the SECOND implementation, not the first - and an
arm that needs a live Blockbench is an arm the harness can never cover, which is exactly
the shape §7.2 caught pretending to be covered.
WHAT READING BOTH EVALUATORS FOUND, warned about rather than silently repaired because
the game is the judge: Blockbench smooths a segment when EITHER end is catmullrom while
vanilla asks only the later keyframe, so a catmullrom->linear segment is a curve in the
timeline and a straight line in the game; and Blockbench WRAPS the catmullrom control
points around a loop seam where vanilla CLAMPS them. Blockbench's own codec inherits
both, so these are facts modders live with, not defects in either tool.
THE ANIMATED CHECK (§9.3's actual point): intermediate keyframes are untested geometry,
so verify now samples every clip at each authored keyframe AND the midpoints between
them, running SAT at every sample. Overlap only - a pair sharing a plane for one frame
of an arc is not a z-fight worth reporting, and one that shares it all clip already
shows at rest - and the deepest sample per pair per clip, because a limb swinging
through a torso overlaps at every sample around the crossing. Findings are marked
`fresh` when they exist ONLY when animated. The one inexactness is named rather than
hidden: an ancestor's non-uniform scale reaching a ROTATED descendant is a shear, and a
sheared box is not an oriented box.
THE CORPUS WAS EMPTY (§9.4a): all seventeen .bbmodel sources carry zero animations, so
the first fixture was AUTHORED, not found - blockbench/fixtures/animated_rig.bbmodel,
made in a live Blockbench and saved through its own codec so it arbitrates the file
shape too. Its geometry is arranged so the REST POSE IS CLEAR AND A MID-SWING POSE IS
NOT, which is §9.3's premise turned into a subject that fails when the sampler is wrong.
The harness arbitrates the flip by INVERTING it (every emitted number must map back to
the number in the .bbmodel) and the sampler by a second independent transcription of
Mth.catmullrom and KeyframeAnimation.Entry.apply, with expected penetration depths
computed from first principles - never a golden number. All four mutations tried against
it are caught; the first attempt at one was caught only as a CRASH, which would have
hidden every section below it, so nearVec is null-safe now.

## 0.92.0

REGISTRY-ENTRY DETAIL (RELEASE_1.md section D2): query_registry stops being a list of ids.
It could tell you that minecraft:oak_stairs is registered and nothing else - not its
blockstate properties, not what tags it is in, not what is inside #c:ores, not what
components an item carries, and not whether the recipe you just pushed LOADED. TagKey
appeared in this repo only as a search filter in LocateTools; RecipeManager was untouched
by any read tool at all.
ALL OF IT RIDES INSIDE query_registry, which is Finding 6b's rule applied to four asks at
once. `entry` answers about ONE id: the tags it is in, plus block `properties` (every
legal value per property) and `default_state` IN set_blocks SYNTAX so a read round-trips
into a write; item max_stack_size + default components; entity size/category; or - for a
datapack registry - the entry's own `json` AS THE GAME DECODED IT, rendered by
RegistryDataLoader's own element codec, i.e. the one that read the file. `tag` filters a
listing to a tag's members (c:ores or #c:ores), `tags:true` lists the registry's tag ids,
and `recipe` joins structure_template as a pseudo-registry reaching the RecipeManager.
COST: +181 tokens/turn and NO NEW MANIFEST LINE (1,192 -> 1,773 chars, live /tools,
Finding 5's method). The same four capabilities as four separate tools would have been
~2,356/turn - an order of magnitude, because the structural half of an entry and the
shared registry/contains/namespace/limit block get paid once instead of four times.
TOKEN_PER_TOOL_FINDINGS.md Finding 9.
TWO HONESTY RULES, both succeeds-falsely. Registry.get(TagKey) is empty BOTH for a tag
that loaded and matched nothing AND for a tag whose file never loaded, so `tag_exists` is
reported beside the members - an empty list alone reads as the first when a modder is
nearly always in the second. And an argument the call's MODE cannot use (`contains`
beside `entry`, `tag` beside `tags:true`, either beside a pseudo-registry) is REFUSED,
not dropped: ArgCheck's rule one level down, where a schema walker cannot see it. An
unregistered `entry` answers exists:false rather than throwing - that is the question,
not a malformed call - while an unknown REGISTRY still throws, being a typo in the
question itself.
A NAMING TRAP FOUND ON THE FIRST LIVE RUN. A recipe FILE's `type:` is dispatched on
RECIPE_SERIALIZER (minecraft:crafting_shapeless); Recipe.getType() is the RECIPE_TYPE,
i.e. which STATION crafts it (minecraft:crafting). The draft called the second one `type`
and would have handed a caller back a word their own file uses for the other thing.
Shipped as `recipe_type`, with json.type carrying the serializer.
It also closes the last silent failure LIVE_MODDING.md listed: a push_data into a
namespace the game does not load succeeds, logs NOTHING (0.91.0 cannot catch it - the
directory is never scanned) and loads nothing. Asking what the game is HOLDING catches it.
Probes: probes/registry-detail.test.mjs, 26 cases, LIVE-GREEN from a cold start; battery
chunk b. mcp-server is unchanged (the manifest is served from Java), so it stays 0.36.0.

## 0.91.0

THE LOG/ERROR CHANNEL (RELEASE_1.md section D1): the toolkit's last succeeds-falsely hole.
Vanilla's data loaders are FORGIVING BY DESIGN. SimpleJsonResourceReloadListener logs a
recipe or loot table that fails its codec at ERROR and steps over it, and the reload
future completes normally - so push_data wrote the bytes, reload_data answered
`reloaded: true`, and the file had loaded NOTHING. The only evidence was in
logs/latest.log, which no tool read. That is the exact class ARCHITECTURE.md purges
everywhere else, and it survived here because the truth was never in a tool's reach.
THE FIX IS NOT A VALIDATOR. The game already validated the file, in the only place that
can; what was missing was READING WHAT IT SAID. LogCapture attaches a log4j appender to
the root logger at mod init and keeps TWO rings: everything (3000), and WARN-and-above
(1000) that INFO chatter cannot evict - a single buffer sized for problems is emptied by
one world load, and the ERROR from three seconds ago is gone before anybody asks.
Cursors are sequence numbers, same strictly-after contract as EventLog, and a cursor the
ring has rolled past returns `gap` instead of a short page that reads like a quiet log.
THREE SURFACES, ONE MECHANISM. `get_log {since, level, contains, logger, limit}` reads
it; ERROR/FATAL also emit an `error` EVENT (deduped per logger+message for 10s and
capped at 10 per 10s window, carrying `repeats`/`flood_suppressed` - an error channel
that floods the event log destroys the log it was added to); and reload_data /
reload_resources watermark the ring and hand back `ok` + `problems`, the WARN-or-worse
lines logged DURING their own reload. get_log is DEV_ONLY in the profiles and `error` is
withheld from player-legal sessions beside `audit` - a body perceives the world, not the
server's stderr.
IT FOUND A REAL BUG ON ITS FIRST LIVE RUN, which is the argument for it in one line.
Both live packs' pack.mcmeta declared only `pack_format`, and PackFormat requires
min_format/max_format above lastPreMinorVersion (81 for server data, 64 for client
resources) - so EVERY reload the toolkit has ever done logged "Error reading pack
metadata, attempting fallback type" and fell back to a codec reporting the pack as
Integer.MAX_VALUE. It kept working, which is why it survived; left in place it would
also have made `ok:false` permanent and therefore meaningless. An existing file is
REPAIRED, not skipped: the pack persists in the world folder, so write-if-missing would
never reach a world that already has one.
Also push_data now takes `file` (an absolute path, ~40 tokens) as well as `base64`, the
same two doors push_asset has had - the write half of the loop a modder repeats most.
Probes: probes/log-channel.test.mjs, 13 cases, LIVE-GREEN, plus the conformance and
profiles ratchets. Manifest cost of the new entry: measured, see below.

## 0.90.0

ENTITY AUTHORING, phase 1 (ENTITY_AUTHORING_DESIGN.md §7): the game becomes the preview
window for authored entity geometry. Until now the only entity art pipeline in this
workspace was per-session scratch scripting - every campaign (the corridor mobs, the
butterflies, the ghast, the narwhal) rebuilt the same transport, the same overlap tests
and the same look-at-it loop, and threw them away.
THE PREVIEW ENTITY. `mcptoolkit:preview`, registered beside the drone and walker in the
same bootstrap-freeze window, and a body only in the sense that it has a hitbox: no
goals, no gravity, no damage, no persistence. `setNoAi(true)` is the whole "stands where
staged" mechanism rather than a decoration - LivingEntity.aiStep gates BOTH serverAiStep
and travel on isEffectiveAi(), which Mob answers with !isNoAi() - which is what lets a
contact sheet be a grid of stages three blocks up in the air instead of a special mode.
Never saved (noSave + shouldBeSaved false), which also forecloses the landmine in the
record: a registered type in a save that later opens without its renderer is a client
crash that persists.
ONE INTERPRETER. client/PreviewModels reads assets/mcptoolkit/preview/<id>.json off the
RESOURCE MANAGER and bakes it - so a file pushed into the live pack and the same file
promoted into a mod jar load through identical code, and the format IS the file format.
Vanilla model space (y down, feet at 24, rotations in RADIANS) so every field maps 1:1
onto addOrReplaceChild: the y-flip, the x16 scale and the Euler-order change happen once,
in the exporter, and there is no second implementation here to drift. Flat part list with
`parent` by name resolved in FILE ORDER, which makes a cycle unrepresentable rather than
a stack overflow at bake time. Cache invalidation is a generation counter bumped by
AssetTools on any push/clear under preview/ and on any reload - an edit-push-look loop
whose "look" shows the previous edit is worse than one that shows nothing.
A PARSE FAILURE IS NEVER A CRASH AND NEVER SILENCE: bad geometry bakes the error model (a
unit cube in vanilla's own missing-texture checkerboard) and keeps the message, and
stage_entity ECHOES that message - so a headless author learns about broken geometry from
the tool reply instead of from noticing magenta in a screenshot. The server never parses
geometry at all; it knows a model id and a hitbox, both arguments, both synched, and asks
the client through a client-free holder (PreviewStatus, the same shape as
BridgeServer.setClientEnvelopeStamper). On a dedicated server the honest answer is
"no_client", and the probe asserts that arm rather than skipping it.
THE RENDERER points LivingEntityRenderer's protected, non-final `model` field at this
entity's cached bake before delegating - the menagerie-proven swap, legal because
submission is deferred per node - so one renderer serves many previews wearing different
models, and everything else (render type, layers, outline, shadow) stays vanilla. What
the author judges is the GAME's rendering, not a picture the tooling drew.
ONE MANIFEST ENTRY: stage_entity {op: stage|clear|list}, priced by finding 6's rule
before it was written (three ops sharing one field table cost one entry; three tools
would have cost three). `size` is a REAL hitbox, not an echo - the probe proves it with
raycast, which hits an entity only where the entity actually is. Every argument is parsed
BEFORE anything spawns, so a typo'd `size` does not leave a stray body standing.
THE `entity` PROFILE (index.mjs, mcp-server 0.35.0): stage_entity is hidden in every
profile but `entity` and `full`, `standard` included. An authoring verb is not something
a session reaches for incidentally, and an entry nobody calls is pure per-turn bill.
Probes: probes/entity-preview.test.mjs + the profiles.test.mjs extensions.

## 0.89.0

ROCKETEER'S AUTHORING ASK (rocketeer/TOOLKIT_AUTHORING_ASK.md), answered as ONE new tool
and one new ARGUMENT SHAPE - not the two tools it asked for. Finding 6 was written the
day before and this is the first change decided by it: a new manifest entry is ~600-950
tokens re-read every turn of every session, so the first question of any new verb is
"is there an existing tool whose question this already is?". For a dense little volume
of blocks that tool is set_blocks, and the answer is measured, not asserted: the grid
form costs +446 tok/turn inside set_blocks; the same capability as a standalone
`write_box` entry, written out and counted, is 777. The saving is the entry, not the
words.
set_blocks GRID FORM: `min` + `legend` + `layers` beside the existing `blocks`, parsed
to the SAME {x,y,z,block} entries so physics, dry_run, the undo record, per-entry errors
and the region keep one definition. layers[0] is the bottom course, rows[0] is z=min.z,
character i is x=min.x+i; a legend symbol may be "keep" ('.' defaults to air, ' ' to
keep). Ragged rows REFUSE and are never padded (padding is how a character offset
survives to become a valid-looking build), the whole call refuses having written
nothing, and the reply echoes `parsed.size` and `per_symbol` so the grid is confirmed by
COUNT and never by re-deriving a coordinate. That is the answer to the measured hazard
this form walks into (PATTERN_SEARCH_DESIGN.md: the same wrong cell from layers
character-arithmetic in three independent sessions): the failure is EXTRACTION, and this
direction has no extraction step - the model emits the grid, the TOOL does every index.
Falsifier on the record: a run that builds a chamber offset by one on any axis says the
hazard was never confined to extraction and this form should not have shipped.
THE READ VIEW WAS THE ONE THAT DID NOT ROUND-TRIP. get_blocks_at has emitted set_blocks
syntax since 0.21.0 precisely so a read can be written back; describe_box detail:layers
never did. Its legend was keyed by BLOCK ID, so a wall of stairs facing four ways drew
as four identical characters and a round trip straightened every one of them. Glyphs are
now per STATE and the legend speaks set_blocks syntax with defaults omitted
(minecraft:purpur_stairs[facing=west]). '?' cells - more distinct states than the 62
glyphs - were always possible and never mentioned; `legend_overflow` says so now.
AND ONE WART THE GRID MADE LOAD-BEARING: set_blocks reported a cell already in the
asked-for state as a FAILED write ("placement rejected"), because setBlock returns false
there. Rare when you enumerate cells; the normal case when you re-state a whole box to
change three characters of it - editing a 150-cell room came back as 147 errors. It is
`unchanged` now, the bucket place_shape has always had, counted before the dry-run
branch so preview and reality still agree. NBT-carrying entries always place: two chests
with different contents are the same BlockState.
capture_structure: a world box -> a single-palette vanilla .nbt -> data/<ns>/structure/
<path>.nbt in the live datapack, one call, returning a PATH and a census, never the
bytes. The census is read back out of the tag that was written rather than assumed:
fillFromWorld guarantees one palette, but `save` writes "palettes" (plural) and NO
"palette" above one, and a single-palette reader then resolves every block to AIR and
bakes a blank structure that passes every size check. Reported so the next consumer does
not have to find it in vanilla's source the way rocketeer's PieceBake did. Columns are
paged in first and an unreadable one REFUSES: fillFromWorld would have recorded air, and
air in the file is indistinguishable from a room with an open wall.
push_data's description was missing `structure/` from both of its lists. It is
RELOADABLE (MinecraftServer.reloadResources calls structureTemplateManager
.onResourceManagerReload, which clears the template cache) - the difference between a
/reload and a restart for anyone authoring NBT.
Probes: probes/authoring.test.mjs, 9 cases, LIVE-GREEN. The load-bearing one is THE
FIXPOINT - describe_box layers handed straight back to set_blocks changes nothing and
fails nothing - which is one test for four contracts at once. capture_structure's
arbiter is `/place template` putting the same blocks back, because "a file appeared" is
exactly what the multi-palette trap also looks like.
Also `-PrunDir=<n>` on runServer. -Pport was documented as enough to boot a second dev
game beside a live one and it is not: two servers on one run dir die on DirectoryLock,
because the conflict is the WORLD and not the socket.

## 0.88.0

TODO section 4, the two entries that were wrong about themselves - and one shape found
three times in one session: A CAPABILITY THAT EXISTS AND NOBODY CAN REACH OR SEE.
THE SPEAR'S WITNESS (clinic step 6, J1+J4). Entity.getKnownSpeed is realized
displacement, but ServerPlayer OVERRIDES it to return lastKnownClientMovement, written
only when a real client's movement packet lands. A connectionless body therefore
reported a speed of ZERO FOREVER while walking at 4.2 b/s - and that zero is what
KineticWeapon.getMotion, ProjectileUtil's reach extension, Projectile.shootFromRotation
and Player.isSweepAttack all read. Four behaviours wrong, nothing thrown, every probe
green. FakePlayerEntity now mirrors realized displacement into setKnownMovement from
computeSpeed() - vanilla's OWN site, inside baseTick, so the published value is the
previous tick's full displacement on the engine's clock - and drops its baseline on
snapTo/teleportSetPosition. Deliberately NOT on reapplyPosition, which Entity uses for
the same purpose but which also rides every POSE change: a real client keeps reporting
movement straight through a crouch, so zeroing there would invent a stationary tick.
J4 adds bot_status.speed_known/speed_delta, and probes/known-movement.test.mjs is
declared into battery chunk d - where the chunk map's comment had promised it since the
chunks were written and the file did not exist.
TWO CALIBRATION FACTS THE DESIGN HAD WRONG, both measured live. (1) COMBAT_CLINIC C6
expects "all four witnesses agree within 15%"; speed_delta cannot. getDeltaMovement is
read AFTER LivingEntity.travel multiplies by friction, so on ground it is the
post-friction residual: 2.31 b/s against a realized 4.23, ratio 0.546 = 0.6 x 0.91. A
C6 demanding agreement there would void every spear cell for the wrong reason. (2) A
3-D speed magnitude reads GRAVITY as motion - a body standing still on stone reported
1.57 b/s, which is 0.0784 b/tick, the gravity term a grounded entity carries forever.
Both keys are horizontal, as Entity.hasMovedHorizontallyRecently is.
THE STATIONS. TODO 4.3 said furnace-tier progression "has no route at all"; it has had
one since 0.40.0 (bot_container, exposed to the survival profile). What genuinely had
none were the MENU-ONLY stations, and two of those are recipes in the same recipe
manager: bot_craft now also runs SMITHING and STONECUTTING, matched and assembled by the
game's own matcher and gated on vanilla's own SmithingMenu/StonecutterMenu isValidBlock
rule. No new tool, so no new per-turn manifest tax. Netherite upgrades had no route at
all before this. Anvil/grindstone/loom/cartography stay unreachable ON PURPOSE - their
outputs are not recipes, so a verb would have to simulate a screen. Armour trims too,
for a reason about the VERB: a trim's result is the same item id as its base, so a
verb addressing its goal by item id cannot express "trim this one" without claiming to
have made something the caller did not ask for.
BREWING WAS ALREADY REACHABLE AND UNSAYABLE. Containers.containerAt resolves on
`be instanceof Container` and a brewing stand is one, so the body could load and empty
a stand it could not observe. The opposite shape to the pre-0.35.0 crafting hole: the
verb was there and the WORDS were missing, which is why nobody found it. Now named,
with slot roles and brew_progress/brew_ticks_left/brew_fuel, and "take everything"
means the bottles rather than the fuel still working.
AND THE DESCRIPTION HAD BEEN LYING SINCE THE TOOL SHIPPED: it promised cook_progress
and fuel_ticks, furnaceState emitted neither, and the class doc three screens above
explained why it never would. So the choice was never silence-or-invention, it was
delete-the-promise or keep-it - and `lit` cannot answer the question a body actually
has (will this fuel outlast this smelt?). Kept, read through typed @Accessor mixins.
THE GAME'S RULE ANSWERS "MAY THIS GO HERE", NOT "WHICH HERE DID YOU MEAN". Blaze
powder is BOTH a brewing ingredient (strength) and brewing fuel, so index-order slot
scanning put every powder in slot 3 and left the stand unfuelled AND unable to take the
nether wart that belonged there - a stand that could never brew, from two calls that
both reported success. One named tie, broken toward the narrower predicate.
AND ONE FALSE SUCCESS FOUND BY THE NEW PROBE, in a verb it merely depended on:
SimpleContainer.addItem claims an empty slot with the whole stack and clamps it
AFTERWARDS, so `bot_give {potion, count:3}` on the drone answered added:3, overflow:0
with ONE potion in the bag. The player body was right (Inventory.add splits by
max-stack), so the two bodies disagreed about what "give me three" means. Fixed in
BotBodyEntity.insert, because the lie belonged to the method and not to bot_give.
Also: tools/battery.ps1 -Port now sets MCPTK_URL for the probes. It had only ever
decided which game the script WAITED for and TAGGED; the probes still read 25599, so
`-Port 25610` tagged one server and fired 63 files at another.

## 0.87.0

TODO section 1 - the four things that needed only a keyboard. Three of them are one
sentence: A TABLE IS READ AT THE WRONG MOMENT.
Chat routing, layer 1 (Sessions): a session was auto-bound as chat responder when it was
MINTED - before the terminal it launches has connected to anything. A window opened and
closed without ever connecting, or one still sitting on the folder-trust prompt, held the
responder slot for the whole 10-minute NEVER_SEEN_GRACE_MS and ate the player's chat for
all of it. Auto-bind moved to the entry's FIRST BRIDGE CALL (Sessions.touch -> maybeAutoBind):
a session that has never spoken has no claim on chat. Sessions.abort keeps its unbind as
belt-and-braces, but a failed spawn can no longer have been holding the slot at all.
Chat routing, layer 2 (EventTools/EventLog): the responder was evaluated once, when a
long-poll STARTED, and a poll runs up to 60s. A rebind therefore took up to a minute to
take effect, and in that window the log double-delivered (the old responder was still
excluding nothing) or withheld (the new one was still excluding chat) exactly the events
the rebind was performed to redirect. queryWaiting now takes a SUPPLIER of exclusions and
re-derives them on every wake; EventTools' whole filter decision moved into one
exclusionsFor(ctx, type) used by both the immediate and the waiting path, so the chat-only
fail-fast fires mid-wait too rather than starving. And EventLog.wakePollers() nudges every
parked poll on each rebind - without it a poller asleep on a quiet stream would not learn
it had been handed the route until the next event happened to land.
Client observation envelope (ARCHITECTURE's "add it when those files are next touched",
deferred since 2026-07-19): the eight CLIENT-context observe tools carried a mechanism tag
and nothing else, so a screen tree read this tick and one read three minutes ago were the
same object in a transcript and memory capture had to refuse them rather than date them by
guess. client/ClientEnvelope stamps perception_mode/game_tick/dimension at the same
BridgeServer chokepoint as the mechanism tag, behind a BiConsumer the client entrypoint
installs so common code never names a client class. Two honest differences from the server
envelope: the clock is the CLIENT's level (not the server's - they differ in multiplayer),
and a title screen HAS no clock, so game_tick/dimension are written as explicit JSON null
there. Never omitted (a hole a consumer must guess about) and never faked as 0.
perception_mode is "rendered" for the two pixel readers, "authoritative" for client-state
queries - which is the perception-mode table's own row for "menus", finally labeled.
Probes (mcp-server, tests only - no server version bump): the conformance ratchet is keyed
by tool NAME, so it could only hold whichever ARGUMENT SHAPE was written first - which is
how check_path's `reach` (shipped 0.5.0, live-verified 16/16) went without a spec entry
for that long. A spec may now declare `variants`; `reach` has one, envelope and
null-verdict-over-ungenerated-space both. The client tier's "never called" rule was doing
two jobs - keeping the probe's hands off the human's screen, and by accident keeping the
whole client surface out of every contract check there is (TODO 1.5's "structurally
unswept"). The five read-only client tools are now called and held to the client envelope;
the eleven that click, type, capture pixels, push assets or quit stay untouched.
reach-goals.test.mjs asserted its own premise - that a goal satisfied by the first flight
is still satisfied when the second call lands. A reach arrival on the pillar chest is a
HOVER, the eye drifts, and a drift past the 4.5 touch radius makes stopped_short the
honest answer; the probe failed on its premise, only under the concurrent load that
widened the gap. It now re-establishes the premise (four attempts, each re-flying and
re-asking immediately) instead of loosening the assertion, and reports the answers it got
instead so a real regression cannot hide behind "it drifted". It also finally carries its
own X-MCPTK-Session, as does bot-target.test.mjs: the body and drone slots are
per-session and node --test runs files concurrently, so a file that sends no id shares the
anonymous slot with every other file that sends none.
ALL OF THIS IS OFFLINE-GREEN ONLY. The conformance and reach-goal changes are live probes
and have not met a running game; the client envelope has not met a running client.

## 0.86.0

place_shapes stops paying twice for the same words. The 2026-08-17 shapebatch measurement
priced carrying the tool at 954 prefix tokens re-read every turn, and named "trim the
description" as the owed item on the reasoning that halving it roughly doubles the
~24.5-turn break-even. Reconstructing the manifest entry offline says that reasoning was
wrong about WHERE the money is: the description was 1113 of 3052 chars - 36.5%, ~348
tokens - and the SCHEMA was the larger half, because ops.items repeated, field for field,
the descriptions place_shape already carries three lines above it in the same manifest.
Both tools are hidden and shown together (the shim's OPERATOR list names both), so those
words were never load-bearing twice. Description halved (1113 -> 560 chars) AND ops.items
de-described via the new Schemas.undescribe, types and the required/optional split kept.
Predicted 954 -> 589 tokens (-38%), break-even 24.5 -> ~39.6 turns (x1.62, NOT the x2 the
description alone was credited with - that arm is x1.22). The prediction is written down
here BEFORE the live re-measure, which is one run-shapebatch invocation and remains owed.
Also in 0.86.0, unrelated and long owed: ClaudeMenuScreen's two companion buttons called
CompanionSessions.spawn/stopAll straight from the button handler. Every mutating entry
point there is static synchronized on one class lock the SERVER thread also takes (for
statusLine(), whenever a player types claude status), and a launch inside that lock probes
the filesystem for the CLI with where.exe - seconds, on a cold or network-backed PATH.
That ran on the RENDER thread: the game froze with no frame drawn to say why, on the one
surface whose whole purpose is being the human's control panel. Both calls now run on a
daemon thread and hop back via Minecraft.execute for the widget rebuild, which is skipped
if the human closed the menu meanwhile (mc.gui.screen() != this).

## 0.85.0

the bodies get names, and vanilla's bootstrap check is taught to see them. Registering
during BuiltInRegistries.bootStrap() - what makes the toolkit loader-only - puts
mcptoolkit:drone and mcptoolkit:walker in the registry BEFORE Bootstrap.validate(), which
an ordinary mod's entrypoint registration lands after. So the bodies drew two permanent
"Missing translations" ERRORs on every dev boot of the toolkit AND of every consumer.
assets/mcptoolkit/lang/en_us.json is the fix for everything a player sees (ToolkitResourcePack
mounts it on Fabric; NeoForge exposes it itself), but it CANNOT silence that check:
Language.DEFAULT_INSTANCE is built from /assets/minecraft/lang/en_us.json out of the game's
own jar through a single-resource getResourceAsStream, so it is structurally blind to modded
strings - a mod that won that lookup would replace vanilla's whole map, not add to it.
BootstrapMixin therefore filters getMissingTranslations by the keys the shipped file really
provides, read from the file rather than listed twice. It narrows the check instead of
disabling it: an entity type with no string still reports. Dev-only either way - the whole
check sits inside if (SharedConstants.IS_RUNNING_IN_IDE).

## 0.84.0

human input capture works on NeoForge (CROSS_LOADER_DESIGN.md section 14). The frame was
already writable and readable there - the @ModifyArg into ServerboundCustomPayloadPacket's
<clinit> is vanilla's own seam and it applies on both loaders - but NeoForge validates
payloads ABOVE vanilla: NetworkRegistry.checkPacket refuses any non-`minecraft:` id without
a negotiated channel, and only a registration through RegisterPayloadHandlersEvent creates
one. So the client threw "Payload mcptoolkit:human_frame may not be sent to the server!"
once per tick and HumanCapture stood down. NeoForgePayloads registers the type there, which
leaves TWO paths that could deliver the frame: NeoForge calls the registrar's handler for
every modded payload, and the toolkit's own injection into handleCustomPayload was already
the delivery on Fabric. The one that must not run twice is the DELIVERY, not the codec, so
the injection stands down behind LoaderPlatform.dispatchesCustomPayloads() rather than the
mixin being split across a second, per-loader mixin config.

## 0.83.0

the extension seam goes cross-loader (CROSS_LOADER_DESIGN.md stage 3). An extension mod
now declares itself in META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint - one
file, both loaders - and Fabric's entrypoints block stays supported for jars built against
0.41.0-0.82.0. A jar declaring both is discovered ONCE, through the service file, which is
what lets one jar work on an old toolkit and a new one during the transition.
The file is read BY HAND, not by ServiceLoader, and the reason is containment: ServiceLoader
resolves each provider inside hasNext() and throws ServiceConfigurationError out of the
iterator, so one mod built against another toolkit version would cost every LATER extension
its tools. Here the scan reads text and loads NO class at all; the class name rides in the
Extension's supplier and is resolved inside Extensions.discover()'s existing per-mod try, so
a LinkageError costs exactly the mod that caused it - through the containment that was
already there rather than a second guard that has to be kept in step with it. (It also
sidesteps NeoForge's module-level `uses`/`provides` declarations, which a real ServiceLoader
lookup across mods would need.)
Attribution - ping's `extensions` array is keyed by mod id - comes from WHERE the file was
found, not from a modId() the modder declares a second time and can get wrong: Fabric walks
getAllMods() and NeoForge walks getModFiles(), each reading the file out of one mod's own
contents. NeoForge reads it through JarContents.containsFile/readFile rather than modRoots():
this asks EVERY loaded mod, and modRoots() mounts a zip filesystem per jar.

## 0.82.0

the unified jar (CROSS_LOADER_DESIGN.md stage 2). ONE artifact, two loaders: src/main/
stays loader-neutral, src/neoforge/ adds the two classes that name NeoForge
(NeoForgePlatform, NeoForgeEntry) beside the two that name Fabric, and both metadata
files ride in the same jar - fabric.mod.json + META-INF/neoforge.mods.toml, each loader
reading its own and ignoring the other's. Same mcptoolkit.mixins.json for both, no
refmap, because 26.x is unobfuscated; the accesswidener gets a two-line AT twin.
Compiled compileOnly against the FML coordinates rather than adding ModDevGradle, which
would fight Loom over the minecraft configuration and the run tasks for a two-class
surface. Also the 7th platform question, needsOwnAssetPack(): NeoForge already exposes a
mod's assets, so MinecraftPackRepositoryMixin must contribute nothing there or it
registers the same files twice - and no headless test can see that.
THE TOOLKIT NOW RUNS ON NEOFORGE, server and client, out of the same artifact that runs
on Fabric. Six boot cells green. Three things only a second loader could find:
  1. 0.81.0's probe was built on a FALSE premise. It assumed a platform naming an absent
     loader class must fail to load; FabricPlatform names FabricLoader only inside method
     BODIES, the JVM does not resolve those at class-load time, so it loaded fine on
     NeoForge, was selected, and died later in CompanionSessions. Detection is now an
     explicit question: each candidate names a MARKER class (the loader API class its
     implementation actually calls) and the probe resolves that first. The wrong design
     passed all four Fabric cells, because there the first candidate IS the right one.
  2. modRoots returned paths you cannot resolve against. NeoForge's getContentRoots()
     hands back the mod JAR FILE (its own resource API is stream-based and never needs a
     Path), so root.resolve("mcp-server-dist") pointed inside a file. NeoForgePlatform
     now opens a cached zip filesystem per jar and returns its root - normalised in the
     platform, not at the call site, because the raw path is a trap for the next caller.
  3. NeoForge validates payload DIRECTION above vanilla, so the @ModifyArg codec
     registration is not enough: HumanCapture threw 20x/second (contained by HookEvent,
     which is the containment design working, but unreadable). NAMED, NOT FIXED -
     canSendCustomPayloads() is false there and HumanCapture stands down with one line.
     The real fix moves payload registration behind the seam; the two registrations would
     collide if both ran. Owed - CROSS_LOADER_DESIGN.md section 12.
Trap: never put a section sign in a log message. MC's logger treats it as its formatting
prefix, so "...md §12)" printed as "...md 2)".

## 0.81.0

the loader seam (CROSS_LOADER_DESIGN.md stage 1). 15 of 173 files called
FabricLoader.getInstance() directly; that was the WHOLE behavioural coupling to Fabric,
because all 18 mixins target vanilla and hooks/ already replaced fabric-api. They now go
through platform.LoaderPlatform - six methods and an extension-discovery call - resolved
once by platform.Platform. No behaviour change on Fabric; the point is that the
dependency is now NAMED, so a NeoForge implementation is an added file rather than a
rewrite. Two structural consequences: McpToolkit and McpToolkitClient no longer implement
the loader's initializer interfaces (they hold MOD_ID/LOGGER and DRONE_LAYER, referenced
from 41 files and from rendering - implementing a Fabric interface there would make
loading them on another loader a NoClassDefFoundError that takes the toolkit down), so
fabric/FabricEntry + fabric/FabricClientEntry are thin shims calling init(); and
LoaderPlatform.Extension carries a SUPPLIER, keeping extension construction inside
Extensions.discover()'s containment where it already was. `ping` now reports `loader`.
Plus `-Pport=<n>` on runClient/runServer, so a boot matrix can run beside a live game
without editing a config file a human maintains.
AND a bug the matrix immediately found: every dev-CLIENT quit since 0.79.0 wrote a crash
report for a clean shutdown (61 of them in run/crash-reports). Removing fabric-api took
ClientLifecycleEvents.CLIENT_STOPPING with it and nothing re-homed it, so nothing ever
called BridgeServer.stop() on a client - and sun.net.httpserver's dispatcher is NON-DAEMON,
so the JVM could not exit and Minecraft's shutdown watchdog fired. ClientHooks.CLIENT_STOPPING
(Minecraft.close() HEAD) now closes the bridge. Verified: exit 0, no new crash report.

## 0.80.0

boot with fabric-api present, not just without it. 0.78.0/0.79.0 made the toolkit
loader-only and never once booted it alongside fabric-api again, so the coexistence
claim went stale: fabric-registry-sync's BootstrapMixin @Redirects Bootstrap.bootStrap()'s
call to BuiltInRegistries.bootStrap() down to createContents() alone, DELAYING the freeze
until after mod init (fabric's MainMixin / client MinecraftMixin call bootStrap()
themselves there). So BuiltInRegistriesMixin applies and never runs in time, and
onInitialize threw "body entity types are not registered" - the first line of the
entrypoint, so nothing after it ran, Review.register() included. The fix is to stop
assuming WHEN the freeze happens: DroneEntities.bootstrap() registers the types itself
if the mixin has not (with fabric-api the registry an entrypoint sees is still open -
that is the door every fabric mod uses), registerTypes() is idempotent for the mixin's
later visit, and ToolkitAttributes takes a SUPPLIER and builds on first use, because
building an AttributeSupplier dereferences holders that only freeze() binds. Both
registration windows are now tried, in the order that suits whichever world this is.
Plus `-Pfabricapi=true` on the toolkit's own runClient/runServer, so this repo can boot
the world its consumers actually run in.

## 0.79.0

loader-only on the CLIENT too, which is what actually finishes the claim 0.78.0 made.
Vanilla discovers packs only from its own jar and resourcepacks/; a mod's assets are
invisible to it, and registering them is fabric-resource-loader-v0's job. Without it
the bodies rendered PERFECTLY but untextured - magenta/black checkerboard and
`Missing resource mcptoolkit:textures/entity/drone.png`. No headless test can catch
that; only a real client boot showed it. ToolkitResourcePack + the client mixin
contribute the mod's own assets root as a built-in Pack, using FabricLoader (loader
API, not fabric-api) to find it. Verified: texture renders, zero missing resources.

## 0.78.0

loader-only on the SERVER (the client half landed in 0.79.0). Entity types now register from BuiltInRegistriesMixin during
vanilla's BuiltInRegistries.bootStrap(), at the freeze() call - because entrypoints run
AFTER the freeze, where Builder.build() throws "can't create intrusive holders" and
register() throws "Registry is already frozen". That door was the ONLY thing
fabric-api was still being loaded for. Attributes stay in onInitialize: building an
AttributeSupplier needs holders that freeze() binds, so the two halves want opposite
sides of it. Verified on a 5-mod server (no fabric-api): both bodies spawn and move.

## 0.77.0

THE REVIEW LAYER (review/): owed human tests become a queue a person can walk. The
mechanism existed three times in this workspace and none of the three was reusable —
menagerie enumerated subjects from its enums and staged them through Java, rocketeer
took hand-written asks from a JSON file and staged them with commands, and the toolkit's
own §15 human_task had the two things neither had (an on-screen card and a referee) but
could only ever present a move/destroy/place goal. This is the union, in the one place
both mods already depend on.
THE QUEUE IS ONE FILE, SHARED: <server dir>/review/asks.json plus an answers.md
rendering, with `source` carrying the attribution the separate files used to. A human
walking a review answers what is owed on this server, not what is owed by one mod.
STAGING IS A LIST OF COMMANDS AND NOTHING ELSE — the decision that let the walk leave
the mods. Commands cross the mod boundary; a Java staging callback never could. A mod
exposes one `stage` command and declares its subjects with Review.declare (re-declared
every boot; ReviewQueue.merge keeps the answers and drops subjects it stopped
declaring). What the stage command PRINTS is captured as the ask's `staged` note and
rides the verdict, which is how menagerie's seed survives the crossing — the walk runs
setup against a capturing CommandSource rather than withSuppressedOutput(), because
suppression is what would have thrown the seed away.
AN ASK WITH NO FAILURE MODE IS REFUSED — both ancestors' best rule, in the record's
constructor. AND A MACHINE-ANSWERABLE ASK NEVER REACHES A HUMAN: an ask may carry
`check`, a command whose success closes it as `checked` (never `ok` — a satisfied
predicate is not a person's opinion), swept at server start before anyone reads the
queue. A `checked` verdict is PROVISIONAL and re-opens when the world stops satisfying
it; a human verdict is never re-evaluated. A failing check is silent by design: it
cannot tell a broken feature from an unstaged world.
THE QUESTION IS ON SCREEN while you look at its subject (client/ReviewCard, the
HumanTaskClient pull pattern over GET /review), keeping FAILS IF in front of the
reviewer — which is the entire reason that field is required. Verdicts also ride the
event stream (review_posted/review_answered), so a session that is still running learns
the answer instead of only the next one. Tools: review_post (PRIVILEGED — staging runs
commands at console authority) and review_status, both dev-surface.

## 0.76.0

`place_shapes` — the batched shape op (mcp-toolkit/STRUCTURE_AUTHORING_DESIGN.md §4).
Came out of a comparison against BuilderGPT, which had nothing worth adopting as code
but did expose one real gap, and it is a CALL-COUNT gap rather than a capability one: it
emits N fills per response and we emitted one shape per tool call, so a forty-fill room
was forty turns — and by TOKEN_PER_TOOL_FINDINGS.md finding 1 every turn re-pays the
entire static tool prefix (92% of the bill on short sessions) to carry information the
model already had when it emitted the first shape.
One ordered `ops` array over the same engine: ops apply IN ARRAY ORDER and each sees the
blocks the ones before it left (lay the shell, carve the inside — the normal way anyone
authors a room), the 500k ceiling is a budget over the CALL with `truncated_at_op` +
per-op `partial`/`not_run` so all-zero counters can never mean two different things, and
the batch files ONE journal edit because the batch is what a person wants to revert.
Parse is now separated from execute, so a malformed op refuses the whole call naming its
index instead of leaving a half-authored structure whose remaining ops were written
against geometry that never appeared.
THE TRAP THE DESIGN DOC FLAGGED BEFORE IT WAS BUILT: a batch dry run must simulate the
ops against EACH OTHER. It now carries an overlay of pending writes, without which every
op reads the untouched world — an air carve into an earlier op's fill reads "already air"
and reports 0, and a second solid op over the same cells reports them twice. That also
fixed a discrepancy older than the batch: a thick `line` revisits its own cells, so the
live run bucketed the repeats as `unchanged` while the preview counted them `placed`.
Preview and reality now agree, and the probe asserts DRY == LIVE rather than a
hand-computed number.
Two accepted-and-ignored arguments closed on the way past: an op carrying the per-call
`dry_run`/`dimension` is refused, and `line` no longer swallows a `mode` it cannot honour
(its shell is `thickness`). Shape/mode validity now lives in ONE table, `MODES`.

## 0.72.0

THE COMBAT KIT, steps 1-2 (mcp-toolkit/COMBAT_KIT_PLAN.md §4.1-§4.3, §4.6). 0.71.0
fixed the mainhand; this fixes the two halves it could not reach. `CombatKit` is one
decision site above `WeaponGate`: it answers what KIND of fight this is and what
belongs in BOTH hands, and every attack verdict now carries `mode` and `why` — a body
that changes weapon class without saying why is what the 2026-08-11 audit had to
reconstruct from tick envelopes.
THE OFFHAND, which no path had ever filled (the `shield` reflex refused with "no shield
in the offhand" and nothing called bot_equip): a shield above 7 health, a totem at or
below 6, the gap between them a hysteresis band so natural regen cannot thrash a real
slot change. Read off DEATH_PROTECTION / BLOCKS_ATTACKS — the components vanilla itself
consumes and reads — so a modded totem or shield works on the same terms. Reported as
`offhand_switched` (reply + event), readable as `bot_status.offhand`, and a spent totem
now emits `totem_used`: a body that survived at 1 HP and does not say so is a lie by
omission, and the agent reads the health and concludes nothing happened.
THE FIGHT THE LEGS CANNOT REACH: in the 9h47m run of 2026-08-11 SEVEN attack goals died
`target_unreachable` against targets the body could see perfectly well, because nothing
asked whether the pack held a bow. Both unreachable exits — the stagnation counter and
the refused-leg budget — now consult the kit first and switch the hunt to shooting when
it can, emitting `attack_mode_changed`; when it cannot, the verdict's `why` names the
MISSING CAPABILITY instead of the symptom. Engagement stationing follows the same
decision, so where the body stands and what it fights with can no longer disagree, and
"ranged" finally means a weapon the body CARRIES AND CAN FEED rather than one that
happens to be in the hand the dig gate left it.

## 0.71.0

THE BODY ARMS ITSELF. The dig gate (0.57.0) auto-selects the fastest harvesting tool
and nothing ever selected back, so a mining body walked into every fight holding a
pickaxe — and the 0.70.0 profile trim removed `bot_select`, the only verb that could
fix it, leaving no way to hold a sword at all. Measured over the whole recorded corpus
on 2026-08-12: 123 of 1,798 fight-reflex ticks had a weapon in hand (6.8%), and 0 of
1,240 in the 9h47m survival run, whose body died 37 times while its agent crafted 29
swords it never once held. Vanilla prices the mistake exactly — stone sword 5 damage at
1.6/s = 8 DPS, stone pickaxe 3 at 1.2/s = 3.6 — so the fights were fought at under half
strength. `WeaponGate` now reaches for the best carried weapon before every swing and
the best carried bow before every shot, ranked by the ITEMS' OWN attack attributes (no
hardcoded weapon list, so modded blades rank on their numbers), switching only for a
strictly better one because an item change resets vanilla's attack-strength ticker.
`bot_attack {item}` is now honoured on a player body instead of silently ignored, and
the swing verdict reports `charge` — how much of the cooldown the blow actually had,
which no reply has ever said.

## 0.70.0

the survival player's continuity becomes the HARNESS's job. A relauncher owns the CLI
and wakes a fresh context whenever it stops without being told to, so the charter's
"a restart is a nap" is true instead of a bluff; `session_stop` writes a second,
PERSISTING marker so a deliberate end is distinguishable from an idling CLI. The Stop
hook and its settings become bundled resources (they were hand-installed and untracked,
so a fresh game dir ran with no loop enforcement at all) and its block message is now
live `bot_status` perception rather than a fixed lecture a small model learns to wait
out. Plus: `reaction_repeating` escalates to urgent when the hazard is still on the body
(a drown reflex fire-failed 13x in a sealed pocket and only said so in a routine row);
a dig that undoes this session's own placement says so (an outstanding tunnel ate the
crafting table the agent had just placed); the survival profile drops 7 measured-dead
tools; and `/claude survival` launches the player without a mouse.

## 0.69.1

`bench` joins the wm_session_tag purpose vocabulary (excluded, like battery: the
testbench is the measuring instrument, not the corpus). The bench never tagged, so a
bench run inside a server lifetime another driver had already tagged (taskgen,
survival) would ride into the corpus under that tag with NO purpose conflict fired —
only taggers conflict. testbench/bridge.mjs now stamps `bench` once per process before
its first bridge call; standalone bench sessions are excluded by name, and the
ride-along case trips the §4.4 conflict guard, which refuses the whole session.

## 0.69.0

F-block combat/dig honesty (V3_PLAN.md §2 — the expert stops cheating). F1: every
melee swing (bot_attack, attack goal, bot_run, reflex) passes the shared AttackGate —
COLLIDER line of sight (refuse `occluded`; nearestLiving is LOS-filtered) + facing
within ~10°, with the body TURNING at NavDriver's 90°/tick rot-lerp when it isn't
(bot_attack becomes a short act {started, action_id, eta_ticks} in that case); the
player body's entity reach is the vanilla entity_interaction_range attribute (3.0),
drone/walker keep the disclosed 4.0. F2: startMine refuses `occluded` via
ReachSolver.touch (raw bot_mine dug through an intact wall, audited), the goal loop's
post-arrival attempt re-runs touch. F3: ground-body reflex flee picks OPEN headings
[away, ±45°, ±90°] (sideOpen + safe-fall probes) and RE-PICKS on a rolling wall-press
instead of giving up. F4: engage stand range follows the HELD weapon (melee [1,3.5]
default 2.5 / bow-crossbow [6,20] default 10, explicit range clamps with a note —
kite_note retired), anchors are standable (Vantage.standAt column + ring fallback),
fight repositioning SPRINTS. F5: a ranged weapon stations via Vantage candidates with
elevation-weighted scoring (the archer's ledge).
Also in 0.69.0, the R-block riding the same rebuild (V3_PLAN.md §3): the session
manifest gains `world {name, seed_sha256}` — a 64-hex SHA-256 of the seed's DECIMAL
string, read once and dropped so the raw seed never touches disk while the identity
still keys the loader (world_id = "w-" + the first 8 hex; sessions recorded before the
field map to the legacy `w-dev`, true by construction — there has only ever been one
dev world), and E2's split group (world_id, dim, 256-cell) hangs off it. wm_session_tag
stamps the running session's PURPOSE (battery | curriculum | taskgen | survival | human
| eval) straight through to that manifest, so it survives a crash; drivers tag
themselves at start-up and ABSENCE is a value — untagged = adhoc = out of corpus, which
is why there is no `adhoc` to apply (62% of v2's steps were battery geometry admitted
by a silent data/raw sweep, EVAL_AUDIT_V2.md §10). The §13.3 actor vocabulary gains a
bare `perturb`, and wm_perturb hijacks NavDriver's steering for a few ticks of random
heading under that label (recorded in full, never supervised — the reflex treatment)
before handing the body back mid-goal, so the expert's RESUME is the §4.3 tier-1
recovery demonstration that pure BC structurally never produces. Two independent
expiries — the tick budget, spent only by a driver that actually steered, and an
absolute deadline swept every server tick — mean a hijack can never strand a body.

## 0.68.0

§15 obs-gap machinery (HUMAN_RIG_PLAN.md phase 5, DESIGN.md §15.3 mitigation 2):
WmObsGap per-session sighting window (N=40 ticks, fed by every entity pick of every
fan the session casts — gait/gaze/tool alike; per-session keying is the hermeticity
boundary); a client press edge naming a tgt_eid no fan sighted in the window gets
obs_gap:true on the press row + an obs_gap episodes row (loader excludes flagged
spans, phase 6); manifest human section gains tgt_presses/obs_gap_presses/
obs_gap_rate — the §8 recorder-quality column. wm_obsgap dev probe tool is the
headless seam for the creeper-behind-wall synthetic.

## 0.65.0

§15 task presenter (HUMAN_RIG_PLAN.md phase 4): human_task/human_task_cancel present a
§14 intent to the connected human as a client-rendered goal highlight (26.2 gizmos,
never a world entity — leak-proof by construction) + task card; /wmdemo self-serves
tasks in-game; the episode opens with goal_start (new optional `tags`) and every
captured human row carries the action id (WmHuman goal attribution). Delivery is a
client PULL of GET /humantask (goal-token JSON, never waypoints) — real S2C packets
land with the Phase-2 client-capture channel. No referee yet: tasks end by cancel/
supersede/disconnect/server-stop as action_failed outcome:stopped, never a synthetic
success.

## 0.63.0

world-model Phase 3, second slice — the frame is now the whole client input surface
(DESIGN.md §9): driveMove carries look PITCH (driver rot-lerps gaze like heading;
NavDriver aims it at the walk waypoint — "watch your feet" §13.2, actuated, so the
gaze fan sweeps footing instead of stale horizon); use/attack/hotbar record as
`press` action rows at the act sites (dig tick = attack-held, isUsingItem = use-held,
selections incl. the tool-gate auto-switch = number keys); the edge-care hold on
sneak-capable bodies CREEPS to the lip crouched (sneak-clip keeps the old guarantee,
the sneak channel finally has an author). Absent fields default so pre-0.63.0 rows
read identically; wmloader/wmnav widened in step (ACTION_FEATURES 20, head 15).
Also: bot_target destroy on an already-empty cell completes `already_clear` with a
nothing-was-mined note instead of a bare "achieved" — the survival false success
that validated an agent's hallucinated coordinates (live-caught 2026-08-09; all 4
destroy verdicts in that session were the fake).

## 0.62.0

wm intent grammar covers bot_container (the §14.3 coverage tripwire's first live
catch, fired 15× in the 2026-08-09 battery): read = scan at the container (§16.1),
put/take = closed-set additions on the eat/drink model, container identity in
shape {kind: container} (DESIGN.md §14.1 updated in step).

## 0.61.0

world-model Phase 3, the widened input frame (DESIGN.md §9): NavBody.driveMove
(analog forward/strafe in [-1,1], sneak, jump, sprint) with the player sink compiling
inputs exactly as LocalPlayer.applyInput/modifyInput does (×0.98, ×SNEAKING_SPEED
while crouching, square-movement stretch) — the fake player's zza is no longer
thresholded binary, so sub-1 goal speeds actually run slower; reflex backstep/strafe
dodge by INPUT on strafe-capable bodies (the 0.5 b/t Entity.move dodge was ~2.3×
sprint speed — physics no client could produce; longer blocked-probe window since the
honest gait ramps from standstill); Wm.actionMove records strafe/sneak (absent =
default, so pre-widening rows read identically).

## 0.60.0

exact fan geometry for the wm recorder: fan/gait rays cast with DOUBLE trig
(WorldPerceptionTools.exactDirection — vanilla's float sine table flipped
boundary-crossing order on grazing rays) and the frame geometry (origin/center/dy/dp)
serialized unrounded, so the Phase-1 loader re-derives traversed cells EXACTLY
(DESIGN.md §2.4; caught by wmloader's ray-exactness test on real frames).

## 0.59.0

check_path R2, the knowledge-masked solve (CHECK_PATH_AUDIT.md): WmSeen per-session
seen-cell set fed at the Sightlines tap (walk visitor overload — air cells are
knowledge) + body traversal; NavSolver.solveMasked reads unseen cells as bedrock,
cache-less; survival check_path answers tri-state over HELD knowledge with
knowledge_frontier as the go-look pointer; provenance held_knowledge.

## 0.58.0

world-model Phase 0 (world-model/DESIGN.md §17): the wm recorder — four tick-stamped
JSONL.gz streams (frames from the Sightlines.Walk fan tap, ticks from the body's own
tick, actions at the input-frame sinks with §13.3 actor labels, episodes off EventLog +
goal starts), gait+gaze fans (5x3, movement-heading, every 2 ticks while moving, all
actors), intent normalization at the bridge chokepoint (§14.3 step 1), the registry
side table (content-hashed into every manifest), and check_path R1 (survival refuses
load:true, forces load off, stamps provenance). Sightlines went public for the tap.

## 0.55.0

the w1_42257 vertical-navigation batch (W1_42257_FIXES.md F1-F6): a vertical transition
OWNS ITS CLEARANCE CELLS. bot_tunnel slope:down digs each landing's lip cell (a height-2
descending stair was geometrically impassable for the body that dug it) and sloped
budgets size at height+1 per step; refused walk legs end tunnels honestly (one retry,
then walk_refused with a diagnostic naming the refused target — an empty terminal
verdict is impossible for tunnels, and the 2-tick did_not_start flood is gone);
bot_goto with may_modify RUNS AS a move goal instead of silently stripping build rights
(check_path now predicts exactly what the call attempts; reach+rights refused with the
bot_target pointer; walk-only follow legs flag `walk_only` so no event advertises a
right the leg will not use); bot_place `obstructed` names the occupying block; hunts
default DRY (swim:false unless asked — a target across water ends target_unreachable
naming the fluid instead of wading in and spending the drown net), and attack verdicts
carry `stalled_legs` (approach legs that died in the follower's node timeout).

## 0.54.0

Start/Stop Recording button in the Claude menu (dev workspace only): ObsSupervisor
spawns/stops tools/obs/record-supervisor.mjs via a file protocol — STOP requests a
graceful shutdown (the OBS recording is FINALIZED, never orphaned mid-pause),
supervisor.pid answers liveness for hand-started supervisors too. obs.password /
obs.url read from config/mcptoolkit.properties.

## 0.53.0

the perception + navigation batch (PERCEPTION_NAV_FIXES.md), batches 1-4.
RETINA. Sightlines.java replaces level.clip for both raycast and raycast_fan: one cell
walk that decides `seen`, `occludes` and `counts-as-horizon` INDEPENDENTLY, so water and
lava are recorded (they were in 0 of 62 survival scans), a trunk inside a leaf canopy is
seen (0 of 28 taiga scans ever found a log), and grass/snow stop fabricating walls (40%
of sector horizons died under 2 blocks). Opacity budget keeps see-through from becoming
X-ray; cells seen across a fluid carry `wf` provenance. Horizon is now the first OPAQUE
hit, which fell out of the row format rather than needing its own change.
DENSITY. The fan queries entities once per FAN instead of once per ray, FAN_MAX_RAYS
64 -> 1024 (45 rays put trees 8.4 blocks apart at range 32 and lost 2 of every 3), and
every fan reports `rays_cast` + `ms` so density is measured, not argued. Measured: 45
rays 0.67ms, 1024 rays 5.37ms.
WATER IN NAVIGATION. NavSolver names fluids (`fluid_ahead`/`fluid_below` + which fluid +
a swim/route remedy) instead of reporting a lake as a bridgeable gap. `swim:false` now
actually keeps the body out of water: it never did — vanilla's malus-8 left water
passable and isAmphibious()=false diverted the route onto the SEABED, which for a body
that breathes is a drowning route dressed as a path.
HONEST OUTCOMES. bot_goto gained `did_not_start` — zero progress is not "short", and its
advice ("re-issue to continue") was exactly wrong for a body that never moved (328 of 489
stopped_short completions had traveled:0). obstructionOf() describes the cell that
actually stopped the goal, instead of one derived by stepping from it — the stop reason
and the block it named used to contradict each other.
DROWNING. The drown reflex fired on time and did NOTHING: the surface op set the jump
flag but never `yya`, the vertical input Player.travel reads, so a fake ServerPlayer held
jump and hung there while air ran out. It now uses NavBody.driveSwim, the definition
swimming navigation already uses. Plus bot_surface (the DELIBERATE form -- terminal, it
cancels the base intent and resumes nothing) and a drowning-route guard that ends a goal
after 3 drown preemptions instead of oscillating the body to death.

## 0.52.0

the video-watchability batch: acts read on screen. LookDriver smooth-turn servo
(bot_look sweep_ticks; scans sweep the head; digs face and gaze-lock their block —
combat aim and nav veto it), REAL dig drops (player hands: item entities pop and the
body's own vanilla pickup vacuums them over a settle phase; collected = inventory
delta, leftovers spilled honestly), ActCeremony (containers really openMenu — lid +
sounds — and crafts work at the bench), REAL eating/drinking (vanilla use-ticks, ~1.6s,
panic-eat reflex pays it too), Claude subtitle overlay (Hud mixin + transcript tailer,
claude.subtitles toggle), and GET /activity (the OBS record-supervisor's busy poll).

## 0.50.0

the w2-56123 batch (W2_56123_FIXES.md): the goal loop stops swallowing act warnings
(act_warning), bot_equip refuses `mainhand`, fluid digs are refused and long ones
announced, `busy` names its holder, bot_mine {action:"cancel"} + dig_starved, the drown
net answers its own trigger (no_surface_reachable), arm-time capability warnings,
food_low, the urgent lane reads (type + bearing + hysteresis), watches/at_goal ride the
acts, `reach` on bot_target move, place verifies it did not entomb the body, tool
enchantments disclosed, and bot_tunnel — the corridor/staircase verb.

## 0.42.0

the event stream tuned for a body that can die: EventTypes vocabulary registry (the
get_events contract is rendered from it), `urgent` preview so danger is never buried by
a page of chatter, filter-aware `missed`, audit withheld from player-legal sessions,
item drops out of the observer, and `hazard {cause}` reflex triggers.

## 0.41.0

extension seam ("mcptoolkit" entrypoint, ToolDef.source, ping.extensions) + modded-data
recognition (#mcptoolkit:contact_hazards / crafting_stations, BLOCKS_ATTACKS shields).

## 0.40.0

swimming nav + stall watchdog (§12.4), mined descent (§12.5), bot_container (§12.6).

## 0.39.0

fabric-api COMPILE dependency removed: own hooks layer (hooks/ + mixin/). The
"loader-only" claim it made was false at RUNTIME until 0.78.0 - see there.

## 0.2.0

+ world-perception layer, drone embodiment, and primitive build shapes.
