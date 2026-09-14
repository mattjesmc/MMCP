# The bridge, read for defects — what a full pass over both front doors found

**Status: AUDITED 2026-09-13 at 0.147.0 / shim 0.74.0; ALL NINE BUILT the same day at 0.148.0 /
shim 0.75.0.** A reading pass over the whole bridge — `BridgeServer`, the `mcp/` package, `Sessions`,
`BridgeConfig`, and `mcp-server/index.mjs` with `bridge-base.mjs` — looking for defects rather than
for a feature. Nine findings, each with a recommendation and a severity. The findings are kept below
exactly as they were written, because a fix is only as good as the account of what it was fixing;
each now carries a **BUILT** line saying what landed and where.

> **§1 was not a bug in the new door.** It was the hole the new door was deliberately hardened
> against, still open on the old one — the door that carries the whole manifest with no surface
> slicing. That asymmetry, rather than the risk, is what made it a defect: one process cannot hold
> two positions on who may knock.

**What landed, in one table.** 198 unit tests green (`gradlew :mcp-toolkit:test`), of which 12 are new.

| | fix | where |
|---|---|---|
| §1 | `Origin` checked first in all seven private-door handlers | `BridgeOrigin` (new, root package), `BridgeServer`, `mcp/McpEndpoint` delegates to it |
| §2 | `stopped` flag; shutdown hook registered once in `init` | `BridgeServer.stop/start/init` |
| §3 | per-request `Sessions.touch`; the reap now aborts the session | `mcp/McpEndpoint.post`, `mcp/McpConn.reap` |
| §4 | surface names folded to lower case at `put`, and the rename logged | `mcp/Surfaces.readInto`, `load`, `declared` |
| §5 | `legal` is a declared surface flag; `execute` takes it beside the profile | `mcp/McpSurface`, `mcp/McpProtocol.Invoker`, `BridgeServer.execute`, `ToolContext`, `PredicateTools` |
| §6 | `getBytes(UTF_8).length` | `BridgeServer.warnOversized` |
| §7 | no base64 ⇒ no image part, and an `isError` refusal | `mcp/McpContent.fromEnvelope` |
| §8 | the survival pass builds new objects; `scan.mjs` returns a copy | `mcp-server/index.mjs`, `mcp-server/memory/scan.mjs` |
| §9 | `MECHANISM`/`DECLARES_FORCE` built fresh and swapped | `mcp-server/index.mjs` |

**Still owed: a live confirmation of §1, §2 and §3**, which is what the audit asked for and what
unit tests cannot give. §1: a cross-origin `fetch` at `/cmd` gets a 403 while `curl` and the shim
carry on. §2: hold the port, boot, quit inside the 90-second window, watch the JVM exit. §3: an MCP
client with a drone, idle five minutes, still has its body.

Every finding states how it was established. Where that is "by reading", it is said so: none of these
were reproduced against a running game, and §1 and §2 in particular deserve a live confirmation
before and after a fix. The audit found no defect in the dispatch chokepoint itself — argument
checking, the mechanism stamp, the audit record, the envelopes, the timeout and its
already-started disclosure are all where `IN_JAR_MCP_DESIGN.md` §3 says they are, and the second door
really does enter through them.

---

## 1. The private door has no `Origin` check, so a web page can drive the game

`McpEndpoint.originAllowed` refuses a non-loopback `Origin` (`mcp/McpEndpoint.java:293`), and
`IN_JAR_MCP_DESIGN.md` §5 states the reason in its own words:

> **`Origin` must be loopback or absent.** [...] Without the check, any page the human happens to
> have open could POST to this port and drive their game.

**That sentence is true of `POST /cmd` as well, and `/cmd` does not make the check.** `handleCmd`
(`BridgeServer.java:347`) reads `X-MCPTK-Session` and `X-MCPTK-Profile`, then reads the body bytes and
hands them to Gson. It never looks at `Origin`, and it never looks at `Content-Type` either — which is
the half that makes this reachable rather than theoretical. A cross-origin `fetch` declaring
`Content-Type: text/plain` is a CORS **simple request**: the browser sends it with no preflight, and
although the page cannot read the reply, the side effect has already landed in the game. Every tool on
the manifest is behind that, `run_command` and `hotswap_class` among them. The port is not a secret
either: it is 25599 in dev and 25600 in production by `BridgeConfig`, and a page may try both.

The same gap is on `/hello`, `/tools`, `/heartbeat`, `/activity`, `/humantask` and `/review`
(`BridgeServer.java:200-206`). `/hello` is the worse of the six: it mints a session.

**Established by reading**, and by the two doors disagreeing with each other in one process — which is
the part that makes it a defect rather than a policy. "The bridge is localhost-trusted" is a coherent
position, and it is the one `Sessions`' javadoc and `ToolContext#profile`'s take; but it cannot be the
position of a process whose newer door spends code refusing exactly this caller, and the asymmetry
means the hardening does not protect the game, only one way into it.

**Recommendation.** Lift the check, do not duplicate it. `McpEndpoint.isLoopbackOrigin` is already
`static` and package-visible and already has the test
(`McpEndpointTest.aPageOnTheInternetIsNotAllowedToDriveSomebodysGame`); promote it to a small
`BridgeOrigin` helper in the root package, call it first in each of the seven handlers, and answer
`403` with the same sentence. Then say in `ARCHITECTURE.md` — beside "the bridge stays
localhost-trusted" — what that phrase does and does not mean now, because the line is about
*authentication*, and this is not an authentication control. It is the one rule that is not advisory:
a `Origin` a browser sends is one it cannot forge, which is precisely why it is worth checking when
nothing else is.

Two things NOT to do. Do not reach for a token or an allow-list of clients: that breaks every
`.mcp.json` in the workspace and buys nothing against this caller. And do not refuse a request with no
`Origin` — `curl`, the shim, and every non-browser client send none, and refusing them is how a
localhost dev tool becomes unusable to be safe from a threat it already handled.

**Severity: highest here.** Not because it is likely, but because the blast radius is the whole
manifest against the player's live world, and the fix is a few lines with its test already written.

**BUILT 0.148.0**, as recommended and not one line further. `BridgeOrigin` in the root package holds
the rule, the reason and the refusal sentence; `BridgeOrigin.refused(ex)` is the first statement in
all seven handlers — before the `Sessions.touch` in `handleCmd`, so a page cannot keep somebody's
session alive either — and `McpEndpoint.originAllowed` now delegates to it. A refusal is logged at
INFO with the origin, because the only way anyone finds out it happened is that line. The two things
NOT to do were not done: no token, no client allow-list, and an absent `Origin` is still served.
`ARCHITECTURE.md` now carries the paragraph saying what "localhost-trusted" does and does not cover.

## 2. A bind retry that lands after shutdown pins the JVM

`start` retries a contested bind on a fresh daemon thread, 45 attempts two seconds apart
(`BridgeServer.java:240-262`). `stop` (`:294`) does something only when `http != null`, and **there is
no flag saying a shutdown has happened**, so nothing stops a retry from succeeding afterwards.

The window is 90 seconds and the trigger is the normal reaction to what the retry itself logs. A dev
game loses the bind, warns that another process holds the port, and the person quits it — well inside
90 seconds, because that warning is the reason they quit. `stop` runs against `http == null` and has
nothing to close. A later retry then binds a fresh `HttpServer` that nothing will ever stop, and
`stop`'s own javadoc names what that costs:

> `sun.net.httpserver`'s dispatcher is a non-daemon thread that only `HttpServer.stop` ends, so a JVM
> that never calls this does not exit: on a server it lingers holding the port and the jar's file
> lock, and on a client Minecraft's shutdown watchdog eventually fires and writes a crash report for
> a game that did not crash.

Both of those are failures this workspace has already paid for once — the second is the 0.79.0
fabric-api regression the same javadoc records. **The retry path can recreate either of them, and the
victim is the NEXT game, which inherits a held port and a locked jar from a process nobody can see.**

There is a second, nastier corner on the same path. `addShutdownHook` (`:225`) throws
`IllegalStateException` when shutdown is already in progress, and that is neither of the exception
types `start` catches. A retry that binds *during* the shutdown sequence therefore dies **after**
`http = h; boundPort = port`, leaving a live server with no hook at all and no log line — the failure
above, minus the one thing that could still have closed it.

**Established by reading.** The 90-second window makes it straightforward to reproduce deliberately:
hold the port, boot, quit inside the window, watch whether the JVM exits.

**Recommendation.** A `private static volatile boolean stopped`, set in `stop`, checked in the retry
runnable after the sleep and again before `addShutdownHook`; and register the hook **once in `init`**
rather than per successful bind, since it is idempotent and must exist whether or not the first bind
won. While there: the retry chain spawns one thread per attempt, which is harmless but means the
interrupt path (`:256`, which returns) is the only way to stop it. The flag is the honest stop.

**Severity: high.** Silent, self-inflicted, and it damages the next run rather than the one that
caused it — the expensive shape.

**BUILT 0.148.0.** `private static volatile boolean stopped`, set as the FIRST statement of `stop()`
(before its own null check, since what must not survive the call is a retry in flight and nothing
else holds that thread); checked in the retry runnable after the sleep, and again at the top of
`start`. The shutdown hook is registered **once in `init`**, wrapped in the `IllegalStateException`
catch that corner deserved, so a retry landing during the shutdown sequence can no longer leave a
live server with no hook. One case the finding did not name is covered too: `start` rechecks the flag
*after* `http = h`, and closes the server itself if `stop()` slipped past in between — that is the
last moment anyone can.

## 3. The in-jar door has no session keep-alive, so an idle client loses its body

`Sessions.EXTERNAL_STALE_MS` is three minutes (`Sessions.java:51`). A session past it is not `live()`,
and the consequences are real teardown: drones destroyed and possessions released with
`session_ended` (`drone/DroneTools.java:2363`), the `locate` anchor ledger dropped
(`LocateTools.java:390`), the chat-responder binding cleared (`Sessions.java:249`). The Node shim
exists in that world and keeps itself alive: `POST /heartbeat` every 30 seconds
(`mcp-server/index.mjs`, `HEARTBEAT_MS`).

**The `/mcp` door has no equivalent, and its session is refreshed only by an actual `tools/call`.**
`Sessions.touch` has exactly three call sites — `handleCmd`, `execute`, `handleHeartbeat` — and the
second door reaches only the one inside `execute`. `McpProtocol.handle` does call `conn.touch()`
(`mcp/McpProtocol.java:71`), but that feeds `McpConn`'s own idle clock and nothing else; a client that
JSON-RPC-`ping`s correctly, on the cadence its SDK chose, still goes stale. So an MCP-door session that
spends three minutes thinking, or waiting on a human, comes back to a destroyed body and a dropped
ledger — and `IN_JAR_MCP_DESIGN.md` §6 promises the opposite in as many words: *"this is what lets
every session-bound resource in the toolkit work for an MCP client without a single one of them
knowing MCP exists."*

The two clocks are inconsistent in both directions, which is the tell. `McpConn.IDLE_MS` is thirty
minutes (`mcp/McpConn.java:35`) and the identity it owns dies at three. And `McpConn.reap` (`:99`)
removes the connection without calling `Sessions.abort`, unlike `delete` (`McpEndpoint.java:247`) —
so the reap does not actually do the job §6 gives it ("a client that exits without a DELETE otherwise
leaves a session the reapers still believe in"). What achieves that is the three-minute staleness the
reap has nothing to do with. The code works; the stated mechanism is not the one running.

**Established by reading**, and corroborated from inside the codebase: `DroneTools.waiterParked`
(`drone/DroneTools.java:~3004`) is a guard written against the *same* three-minute reap firing under a
session whose single call was merely slow, found live "at ~3 minutes under full load". This is that
bug's idle twin on the newer door.

**Recommendation.** One line: `Sessions.touch(conn.toolkitSession)` per request in
`McpEndpoint.post`, beside the `McpConn` lookup. Put it in the endpoint rather than in
`McpProtocol.handle`, so the protocol layer stays free of `Sessions` and keeps its offline
testability — the whole reason that class boundary exists. Then make `McpConn.reap` call
`Sessions.abort` for each connection it drops, so §6's sentence describes the code; and add the test
this has no cover for, since none of the 65 `mcp/` tests touch session liveness. With the touch in
place the thirty-minute connection TTL becomes the real one, which is what §6 always said.

**Severity: high for anyone using the second door with a body.** Invisible until it bites, and it
presents as the body dying on its own.

**BUILT 0.148.0.** `Sessions.touch(conn.toolkitSession)` per request in `McpEndpoint.post`, beside
the `McpConn` lookup and not in `McpProtocol.handle` — the protocol layer still names no `Sessions`
and still tests offline. `McpConn.reap` now calls `Sessions.abort` for each connection it drops, so
§6's sentence describes the code. Two tests added (`McpConnTest`): the reap ends the toolkit session
it was acting as, and an anonymous connection has none to end. `IN_JAR_MCP_DESIGN.md` §6's correction
block is rewritten as what runs.

## 4. A declared surface with a capital letter is accepted and then unreachable

`Surfaces.isLegalName` permits `A-Z` (`mcp/Surfaces.java:249`) and `readInto` stores the key verbatim
(`:186`), but `resolve` lowercases the lookup (`:290`). So a surface declared `"Build"`:

- is logged as installed and appears in `names()`;
- is listed by the 404 body as a surface this game serves (`McpEndpoint.notFound`);
- **404s at `/mcp/Build` and at `/mcp/build` alike**;
- vanishes from `/mmcp mcp`, because `McpReport.lines` does `resolve(name)` and `continue`s on null
  (`mcp/McpReport.java:129-132`).

And if it is also `mcp.surface`, `load` accepts it — `containsKey` is case-sensitive (`:143`) — so it
is served at the bare `/mcp` while `/mcp/Build` still 404s. The failure is silent in the one place a
person would look to diagnose it.

**Established by reading.** `SurfacesTest.aNameThatIsNotAPathSegmentIsSkipped` does not cover it,
correctly: uppercase *is* a legal path segment. That is the gap.

**Recommendation.** Lowercase once, at `put`, and log when a declaration is renamed that way — the
file is the operator's and a surface quietly meaning something other than what they typed is the one
outcome `Surfaces`' own javadoc says it refuses to allow. (Tightening `isLegalName` to reject
uppercase is the other option and is worse: it turns a working default into a skipped surface for
anyone who already wrote one.) Add the case to `SurfacesTest` and the round trip to
`McpEndpointTest`.

**Severity: low.** Wrong-looking rather than dangerous, but it wastes the whole of someone's first
afternoon with declared surfaces.

**BUILT 0.148.0**, the recommended way: folded once at `put`, and the rename logged at INFO naming
the address it is actually served at. `isLegalName` is untouched. Two places the finding did not
mention fold too, or the fix would have been half of one: `mcp.surface=Build` (the default-surface
lookup in `load`) and `"base": "Observe"`. Three cases in `SurfacesTest`.

## 5. Surface names and shim profile names share one namespace, and one string carries behaviour

The second door passes the surface name where the shim passes its profile
(`mcp/McpProtocol.java:204` → `BridgeServer.execute(..., profile)`), and `ToolContext.legal()` is
literally `"survival".equals(profile())` (`ToolContext.java:46`). So declaring an MCP surface named
`survival` — a name an operator reaches for without a second thought, for a surface that has nothing
to do with the research profile — silently:

- flips `check_path` into knowledge-masked mode and refuses `load:true`
  (`PredicateTools.java:155-168`);
- suppresses `audit` rows from `get_events` (`EventTools.java:133`).

Nothing warns, and the reverse is true too: there is **no way to deliberately make a second-door
session player-legal** except by naming its surface that one string. `IN_JAR_MCP_DESIGN.md` §2 says
the shim's per-session policy does not come along, and this is the one clause where a fragment of it
came along by coincidence instead of by design.

**Recommendation.** Decide which it is, in one place. Either give `McpSurface` an explicit
`legal` boolean that `execute` reads, and stop deriving a role from a name; or, at minimum, refuse
`survival` as a declared surface name with a sentence saying why, the way `isLegalName` refuses a
path-hostile one. The first is right — `ToolContext.legal()` is a question about authority, and
answering it by string-matching a URL segment is the kind of coupling that is only ever discovered by
someone hitting it.

**Severity: low today, sharp when it lands.** Needs no fix to ship, but it is three lines of guard
against a confusing afternoon.

**BUILT 0.148.0**, the first of the two options — the right one. `McpSurface` has a `legal` boolean,
declared as `"legal": true` in the config file and inherited from `base`; `McpProtocol.Invoker` hands
the whole `McpSurface` to the dispatcher rather than its name (a surface has properties, so pass the
surface); `BridgeServer.execute` gained a five-argument form taking legality beside the profile, null
meaning "derive it", which is what the shim passes and what keeps its behaviour exactly as it was.
`ToolContext.legal()`'s name comparison is now documented as the shim's answer and only the shim's,
and `PredicateTools` asks `ctx.legal()` instead of comparing the profile string itself — it was the
one handler that had its own copy of the coincidence. Four tests in `SurfacesTest`, including the one
that matters: a surface called `survival` is not player-legal for being called that.

## 6. `warnOversized` measures characters and calls them bytes

`int size = GSON.toJson(result).length()` (`BridgeServer.java:635`) is UTF-16 code units, while the
message, the constant name and the comparison all say bytes. Every result carrying non-ASCII — a
translated block name, a player's chat — under-reports against the 8 KB budget, so the tripwire trips
late on exactly the results it was written to catch.

**Recommendation.** `getBytes(StandardCharsets.UTF_8).length`, which is what the wire carries and what
`respond` already counts two methods away.

**Severity: trivial, one line.**

**BUILT 0.148.0.** One line, as advertised.

## 7. A malformed image result reaches the model as an empty picture

`McpContent.fromEnvelope` (`mcp/McpContent.java:60`) emits an image part with `"data": ""` when
`_image` has no `base64`, rather than falling back to the text part. The model is handed a blank
picture with nothing saying it is blank — which is the uncapturable-observation failure the client
envelope elsewhere exists to prevent.

**Recommendation.** No base64 means no image part: fall through to the compact text part and append a
sentence naming what was missing. The `isError` channel is right here too — a picture that is not
there is a refusal the model must read.

**Severity: trivial.** Unreachable from today's tools; a tripwire for tomorrow's.

**BUILT 0.148.0.** No base64 (absent, null or empty) means no image part at all: the whole result
becomes an `isError` refusal saying a picture was promised and none arrived, with the rest of the
result appended — and with the sentence the model actually needs, *do not read this as an empty
scene*. Two tests in `McpContentTest`.

## 8. The shim's survival override mutates a shared tool object

`buildToolList`'s survival pass assigns `t.description` / `t.inputSchema` in place
(`mcp-server/index.mjs`, the `PROFILE === "survival"` loop), while `decorate` right below it goes out
of its way to clone before the first change precisely so no upstream object is mutated. And
`memory/scan.mjs:401` returns the module-level `SCAN_TOOL` singleton rather than a copy, so that loop
writes through to shared state.

Harmless today: the profile is fixed for the process, the override is idempotent, and the
mutation re-applies the same value on every build. It is the one path that breaks `decorate`'s stated
invariant, which is what makes it worth a line.

**Recommendation.** Have the survival pass build new objects the way `decorate` does, or have
`scan.mjs` return a copy like `tools.mjs:354` and `local/dev.mjs:122` already do. The second is one
line and fixes the class.

**Severity: latent.**

**BUILT 0.148.0 / shim 0.75.0**, both halves rather than the cheaper one. `scan.mjs`'s `localTools`
returns a copy like `tools.mjs` and `local/dev.mjs` already did, which fixes the class; the survival
pass builds new objects the way `decorate` does, which fixes the path. Either alone would have left
the invariant stated but unenforced.

## 9. `MECHANISM.clear()` leaves a window where a loop check sees no mechanism

`buildToolList` clears and refills `MECHANISM` in place, and `finishReply` reads it to choose which
loop check a call triggers. The watcher rebuilds the list every 3–15 seconds, so a tool call
overlapping a rebuild can read an empty map, get a null mechanism, and skip its check. A check that
silently does not fire is the exact failure the loop file exists to prevent — `LOOP_KIT_DESIGN.md`
§11's finding 4 is the same shape arrived at from the gate side.

**Recommendation.** Build a fresh `Map` and swap the reference at the end, for `MECHANISM` and
`DECLARES_FORCE` both. Single-assignment is atomic in Node and the window closes entirely.

**Severity: low and intermittent** — which is the worst kind to diagnose later and the cheapest to
close now.

**BUILT shim 0.75.0.** Both maps are built into fresh locals and assigned at the end; `const` became
`let` for exactly that. The window is gone rather than narrowed.

---

## The order they were closed in

The order the audit proposed, and it held:

1. **§1 and §2** — before anything else ships. Both are small, both have their test or their repro
   already implied, and both are about damage done outside the session that caused it.
2. **§3** — one line plus a test, and the only finding here that a user of the second door will
   actually hit in ordinary work.
3. **§6, §7, §9** — one line each, no design decision in any of them.
4. **§4, §5, §8** — each wants a small decision first, stated above.

The decisions §4, §5 and §8 wanted were taken as the finding recommended in each case: fold rather
than reject, a declared flag rather than a refused name, and both halves of the copy rather than the
cheaper one. Nothing was deferred and nothing was widened.

Nothing here argues against the architecture. §1 and §3 are both the same shape — **a contract the
newer door states and the older one does not, or the reverse** — and that is the thing to watch as the
two doors go on living beside each other: `BridgeServer.execute` is a genuine chokepoint and the
dispatch contracts really are all inside it, but the *transport* contracts (who may call, and what
keeps a caller alive) are still written twice.
