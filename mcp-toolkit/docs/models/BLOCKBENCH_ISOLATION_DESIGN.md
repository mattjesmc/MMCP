# Session isolation in Blockbench: the tab, the window, the process

**Status 2026-09-10: section 11 - THE MCP DOCK - is BUILT and RUN LIVE at toolkit 0.144.0 / plugin
0.8.0 / shim 0.72.0. Section 11 is the record: what a live scan found (six windows serving, every one
empty, not one with a death condition that could fire), why the last-window guard was innocent, the
five structural findings behind it, and the dock that answers them. 268 offline-green in the plugin
suite and 15 in `blockbench-surface`; the live arm is section 11.12, which also carries the one bug
only the live run could show - a cross-window pre-claim that had never worked. Everything below this
paragraph is the earlier history, unchanged.**

**Status 2026-09-09: step 1 SHIPPED and CONFIRMED live; step 2 (per-window ports and window claiming)
SHIPPED at 0.139.0 and then RUN, which is what section 10 is - the first live run found that windows
were created and never cleaned up, that the window a person was working in was still the first thing
a scanning shim took, and that an abandoned window went on looking taken for two minutes. Section 10
is the fix, built at toolkit 0.142.0 / plugin 0.7.0 / shim 0.69.0: a window is the person's unless it
was opened FOR an agent, an agent-born window closes itself when nothing needs it, and every window
says whose it is in its own title. Step 3 stays unbuilt, and section
8 names the hazard that would pull it forward: not the backup wipe (real - it destroys another
window's entry three times out of three - but DEFENDED by a ten-line plugin guard, demonstrated) and
not resources (a window costs ~220 MB, linear to eight, with no graphics-context ceiling anywhere
near), but settings and plugin permissions, which have no interception point at all.**
Everything below marked *verified* was read in
the vendored Blockbench 5.1.6 source at `<workbench>/ArmorPiecesBlockbench/vendor\blockbench`
(a real checkout with unminified `js/`, the Electron main process, and `types/`), which is the same
version the bridge runs against (`BLOCKBENCH_BRIDGE_DESIGN.md` section 3). The bridge itself is
`mcptoolkit_bridge.js` 0.3.0. `BLOCKBENCH_BRIDGE_DESIGN.md` remains the record for the plugin; this
is the record for what "one session's work is its own" can and cannot mean.

The one-line thesis: **the window is the smallest unit of real isolation, the tab is already better
isolated than we assumed, and no amount of plugin engineering can make two sessions share a window
safely.**

---

## 1. Why this was opened

ArmorPieces measured two part-authoring sessions running concurrently at 14.3 minutes and $5.15 a
piece against 5.2 minutes and $2.19 alone (`blockbench-plugins.md` in that repository). The cause
was recorded as an inherited session id: every child presented one identity, shared one binding,
and each session's unqualified calls landed in another session's piece.

Two things about that record are now wrong, and both were measured on 2026-09-07.

**The inheritance no longer happens.** Claude Code 2.1.263 mints a fresh `CLAUDE_CODE_SESSION_ID`
and `CLAUDE_PID` for a headless child. Measured directly: parent `55051b58` / 95164, child
`ac8e58ba` / 94936.

**The fix is now the bug.** `.mcp.json` was changed to read `${ARMORPIECES_SESSION:-armorpieces}`,
and nothing in that repository ever sets `ARMORPIECES_SESSION`. Every session therefore falls back
to the same literal string. Live on this machine while writing this: three concurrent sessions, each
parenting both its shim and the ArmorPieces proxy, and the plugin reporting a single session
`armorpieces` holding two connections.

## 2. A shared id disables every guard at once

Worth stating separately, because it is worse than a shared binding and it is the reason identity is
load-bearing rather than cosmetic.

`holderOf(project, except)` skips the calling session. Two processes carrying one id are the same
session object, so `held_by` can never fire between them. The binding is one field that the last
writer overwrites in silence. Presence expiry only releases when the *last* connection closes. The
only surviving signal is 0.2.0's note counting connections, which warns and does not refuse.

So a session id is not a label. It is the key every safety mechanism in the plugin is written
against, and it currently rests on a string a human has to remember to set.

## 3. What a tab already owns (verified)

Better than assumed. `ModelProject` carries per-instance state for almost everything:

- **Its own undo system.** The global `Undo` is a getter returning the active project's; each
  project constructs its own in `_static.properties`. Undo is per tab, not global, and not per
  window.
- **Its own camera per viewport** (position, target, projection, zoom, and the locked angle),
  written on unselect and read back on select, gated on `save_view_per_tab` (default on).
- Mode, view mode, active tool, element and group selections, textures, animations, timeline
  animators, UV viewport offset, reference images.

**A tab switch is cheap.** It swaps references. No geometry rebuild, no texture re-upload; meshes
live in a per-project store and are disposed only on close. The real per-switch work is rebuilding
the node id map, recomputing selection, one pass over every texture of every open project, and a
full canvas readback for the tab thumbnail.

**So "per session undo and per session camera" needs no code.** It is what you get when one session
owns one tab.

## 4. What a tab does not own, and cannot be made to

Two independent reasons, both verified.

**One project can be live at a time, by architecture.** There is exactly one active project slot and
exactly one graphics scene; switching tabs removes one model subtree from the scene and adds
another. Every consumer, selection, undo, raycasting and every panel Vue, reads through the active
project. A second live tab would be invisible to all of them.

The consequence is sharp and worth stating plainly: **an agent reading its own model in a shared
window must steal the active tab.** Not because the bridge is impolite, but because there is no
other way to read a project. Every tool except the `project` family resolves a project and selects
it, reads included.

**A list of state is global and no per-tab swap covers it.** The selected animation is a plain
static, manually nulled on switch. The selected keyframes array is never swapped at all. The
timeline playhead, play state and playback speed are never saved or restored per tab. The paint
selection, erase mode, alpha lock and mirror painting survive a switch untouched, as does most of
the UV editor's view state.

So even the ideal single-window arrangement, one session per tab, leaks between sessions in small
intermittent ways. That is the failure mode that keeps costing sessions rather than announcing
itself.

## 5. What a window owns (verified)

A second window is a fresh JavaScript realm. Its own project list, its own scene, its own graphics
context, its own copy of every global in section 4. Nothing runtime is shared. Multiple windows are
first class: there is a New Window action, and dragging a tab out of the tab bar serialises the
project *including its undo history* and moves it to another window, so handing work between windows
is an operation Blockbench already performs.

What windows do share is persistence, and three items bite.

- **Closing any window deletes every window's crash-recovery backups.** The close path clears the
  whole shared backup store while only checking its own projects for unsaved work. **Confirmed by
  trial and DEFENDED (section 8):** three for three, an unpatched close destroys another window's
  entry; the ten-line plugin guard preserved it two for two and still lets the start screen's
  Discard button do a real clear. What is destroyed is backups of projects nobody has open plus at
  most 30 seconds of another live window's active tab - only the ACTIVE project is ever backed up.
- **Settings, the plugin list and plugin permissions** are each read once at boot and written back
  whole. Last writer wins, with no cross-window invalidation. A grant made in one window can be
  erased by another.
- **Our own port.** The bridge listens on a fixed port read from storage every window shares, and a
  failed listen only sets an error field. A second window loads a second copy of the plugin, tries
  the same port, fails silently, and serves nothing.

A separate process, via the `--userData` flag that defeats the single-instance lock, removes the
first two at the cost of installing the plugin and granting its permission separately in each.

## 6. The design

### 6.1 Identity comes from the parent, not from a mint

**Rejected: a plugin-minted token.** The two processes of one session, the shim and the ArmorPieces
proxy, never talk to each other. Each would register separately and receive a different token, so a
mint splits one logical session into two identities that then fight over `held_by`. Identity must
come from something both already see.

**Chosen: the parent process id.** Verified in the live process table: every session's MCP servers
are direct children of that session's `claude.exe`, so the parent id is shared by the pair and
distinct across sessions. It is an operating-system fact, immune to environment inheritance, and
needs no launcher discipline and no configuration.

The change is the fallback, in two files, and **the prefix goes with it**. This paragraph first said
`shim-${process.pid}` becomes `shim-${process.ppid}`, which is wrong in exactly the way the section
above describes: `shim-4172` beside `armorpieces-4172` is still two identities for one session, so
the config deletion below would have made the pair refuse each other's edits the first time anything
relied on the fallback. Both sides must compute the SAME string. Built as `mcptk-${process.ppid}` in
both, with `client` left to say which of a session's servers is calling — which is what that field
was already for. An explicitly set `MCPTK_SESSION` still wins, for deliberate sharing. ArmorPieces'
`.mcp.json` then drops the variable entirely.

The falsifier is in `blockbench-surface.test.mjs`: the probe spawns the shim, so the probe IS the
parent, and it asserts the id is `mcptk-${process.pid}` — its own — rather than matching a shape. A
fallback that went back to the shim's own process id fails there.

**No new handshake.** `GET /presence` already is the registration: it declares the id, opens the
liveness socket, and returns the current binding. A sign-on step would add a round trip and buy
nothing.

### 6.2 Expiry releases, it never closes

**Rejected: closing the project when a session expires.** A dropped socket is not consent to destroy
unsaved work, and presence drops for reasons that have nothing to do with the session ending. The
current behaviour is correct and stays: expiry releases the binding, the project remains.

### 6.3 One window per session, and the port is the window's name

The window becomes the unit of ownership. A session claims a window and owns every tab in it. You
keep a window of your own that no agent ever claims.

This is what makes the earlier ideas unnecessary rather than merely deferred. Restore-on-drain and
locking the human out were both attempts to share one window safely, and section 4 says that cannot
be done. With a window each, the agent's active tab and yours are different objects in different
realms. There is nothing to restore and nothing to lock.

**Port discovery without any Electron access.** The plugin scans upward from 25801 for a free port;
the port it wins *is* that window's name. A shim scans the same range, asks each for `GET /hello`,
and claims the first window not already claimed, or rejoins the one already carrying its id. A
window can be marked reserved from the plugin's own menu, which is how you keep yours.

**BUILT at toolkit 0.139.0 / plugin 0.5.0 / shim 0.67.0**, exactly as described above plus the two
requirements below, with one thing the sketch did not say and the build had to decide: what a shim
does when it can get no window of its own. It falls back, in order - ask for a window, then SHARE an
unreserved one with a sentence on stderr, and only where every window is RESERVED does it serve no
Blockbench surface at all. Sharing is the pre-step-2 behaviour and `held_by` still guards it, so the
worst case is what today already is; a reserved window, though, is never taken, because a flag that
yields under pressure is not a flag. `BLOCKBENCH_BRIDGE_DESIGN.md` section 15 is the as-built record
of both halves, and the live arm - that a new window really does load a second copy of the plugin and
win the next port - is what no stub can reach and `TODO.md` 3.4 now asks for.

**BOTH SIDES, or neither.** A session is two processes (section 6.1), and the second one is a
consumer's own Blockbench server - in ArmorPieces, the one that actually authors the piece. It was
pinned to 25801 while the shim scanned, which would have made step 2 worse than useless: the second
session's shim would take a window of its own while its proxy went on calling into the first
session's window, to be refused there exactly as the A/B measured. Its half is now built too, and
needs no channel between the pair: same id from the parent pid, same port order, and a claim from an
id that already holds a window is a REJOIN, so whichever process arrives second is handed the first
one's window whether or not it saw the claim. A lowest-port tiebreak built for the case where neither
sees the other was deleted for failing its own falsifier - the rejoin had already done the work.
Anything else that speaks to the plugin directly needs the same treatment, arbiters included.

**A shim cannot make itself a window** (measured, section 8): launching `Blockbench.exe` again with
the same `--userData` forwards to the running instance and exits 0, leaving the window count
unchanged. Only the in-app action creates one (`BarItems.new_window.click()` ->
`ipcMain.on('new-window')`). So window creation belongs to the plugin, and the claiming protocol
needs the step the original sketch left out: a shim that finds no free window ASKS an existing one
to open another, and then claims the port that appears. That also keeps the human's reserved window
out of it, since the request goes to a window that is already ours.

**Two requirements the 2026-09-08 re-run adds (section 9).**

- **Keep the `held_by` refusal exactly as it is.** The goal of step 2 is to stop *needing* it, not
  to weaken it. Through the whole contended pair it did its job: nothing was corrupted, no session
  wrote into another's piece, and the loss was entirely waiting. A window each removes the occasion
  for the refusal; it must not remove the refusal.
- ~~**The active-tab fallback must not read another session's held project.**~~ **BUILT at 0.138.0 /
  plugin 0.4.0**, ahead of step 2 rather than inside it. In the contended run a
  refused session asked about *its own* project, had no binding to resolve, fell through to the
  active tab, and was handed a full description of the other session's piece - 23 cubes and its
  bones. Reads are unrefused by design (section 4: an agent reading its own model must be able to
  read), and that is right for a project a caller *names*. It is not right for the fallback: asking
  about your own work should never answer with someone else's. The rule is narrow - the active-tab
  fallback skips a project another live session holds, and says so - and it is worth having under
  step 2 as well, for the window that gets shared anyway. As shipped: `resolveProject` refuses at
  that one point with the `held_by` block and a hint naming all three ways out; a named project, an
  unheld active tab, and the unbound note are all unchanged.

### 6.4 Yes, a session may hold several tabs

It falls out of 6.3 rather than being designed for. A session owns its window, therefore every tab
in it, so a reference model open beside the piece costs nothing and needs no second binding. The
existing per-project binding stays for the case where a window is shared anyway, where it is the
only thing standing between two sessions.

### 6.5 The two older plugins, and what a binding does not reach (2026-09-08)

**This record named only the bridge plugin until now, and the silence was itself a finding**: a grep
for `mcptoolkit_entity` / `mcptoolkit_sync` / `mcptoolkitPush` / `mcptoolkitEntity` over this file
returned nothing, so nothing here said whether a second window has them loaded or which game they
would talk to once it did. `TODO.md` 1.9 is the owed item; this is the part that belongs to
isolation.

**A binding protects a call that passes through `resolveProject`. Theirs do not.** Both older
plugins are globals reached through `risky_eval`, they resolve a project BY NAME, and they then
`select()` it (`mcptoolkit_entity.js:208-213`, `mcptoolkit_sync.js:162-164`), falling back to the
global `Project` when handed no name. The selecting is not the defect - `ensureSelected` does the
same, because Blockbench forces a tab switch on anyone touching a non-active project (section 4).
The defect is that **the `held_by` refusal is the whole of the enforcement and it lives in a layer
these two never enter**. So the binding is not merely inapplicable to them: it is bypassable through
them, from inside the very eval whose `PROJECT` the bridge had just resolved and ownership-checked.

**Step 2 rescues this by geometry, not by contract.** One session, one window, one active tab, and
the question of whose piece the active tab holds stops arising. That is worth having and it is not
the same as being safe: nothing stops a second session sharing an unreserved window (the shim's
fallback, section 6.3, which says so on stderr), and in that window an older plugin's name lookup
walks straight into the other session's piece with no refusal on the way.

**The fix is the one `PROJECT` already demonstrates** and it is written up in `TODO.md` 1.9: the
plugins take the resolved project OBJECT and an explicit `bridge`, injected into the eval, rather
than reading a global and a hardcoded constant. Both halves are the same principle - *a call that
resolved wrongly cannot write silently* - and the second half is why they also point at the wrong
GAME (they hardcode 25599, which since B0 names the toolkit's own dev game and no consumer's).

## 7. Order of work

1. ~~**Identity from the parent id.**~~ **Built, shipped and confirmed, toolkit 0.136.0 / shim
   0.66.0.** Two one-line changes and one config deletion, and nothing in the plugin touched.
   0.136.0 is published to mavenLocal, ArmorPieces' `build.gradle` names it, and its
   `run/mcptoolkit/mcp-server` was re-extracted from that jar (stamp 0.136.0); a dev boot
   re-extracts unconditionally, so every later boot keeps it. **Confirmed live on 2026-09-08**:
   three part sessions on one machine, three distinct `mcptk-<ppid>` ids, no `SHARED` flag on any
   row, no shared-connections note in any reply. Contention is no longer an id collision.
   Corroborated again the same day from a third session that was not part of the measurement: a
   read probe against the live bridge came back `held_by: session mcptk-24016 (armorpieces) is
   bound to "wing_tatters", connected` - a distinct id, a live connection, and a refusal that named
   the holder rather than letting the probe walk into someone's piece.

   **What it did NOT settle: whether concurrency pays.** The A/B (`CONCURRENCY_AB.md` in
   ArmorPieces) ran its solo arm on 2026-09-08 and was stopped there. The solo runs came back at
   `risky_eval` 23 and `armorpieces_open` 5 — the two signals the brief pre-registers to judge step
   2 on — with zero contention, because of a consumer-side defect that the toolkit half of the
   mechanism enables: `project op:new` binds the session (correct for a piece), ArmorPieces' proxy
   creates its `armorpieces_scratch` from an error path, and its `dropScratch` closes that scratch
   only when it is not the active tab — so the session is left BOUND TO THE SCRATCH, and every
   unqualified call resolves there by binding rather than by active-tab fallback. `no piece is open`
   22/28/30 times across the three runs. The toolkit's half is SHIPPED at 0.137.0 (plugin 0.3.0):
   `op:new {bind:false}` creates and makes active without binding, and says which project the
   session kept - so a scratch cannot take an identity even where the consumer forgets to clean it
   up. Theirs is still owed: close through `project op:close` (which clears bindings; a raw
   `s.close(true)` eval does not) and re-bind to the piece by key instead of reading whichever tab
   is active.
2. ~~**Per-window ports and window claiming.**~~ **BUILT at 0.139.0 and RUN; section 10 is what the
   run found and what it forced (toolkit 0.142.0 / plugin 0.7.0 / shim 0.69.0). What follows was
   written before that run.** **BUILT, toolkit 0.139.0 / plugin 0.5.0 / shim
   0.67.0, and LIVE-UNRUN** (the harness cannot make a second realm; section 6.3's as-built note and
   `BLOCKBENCH_BRIDGE_DESIGN.md` section 15). Everything in section 6.3 — and **DECIDED: BUILD IT.**
   The re-run of both arms completed on 2026-09-08 under distinct identities and with the binding
   fix in (0.137.0 and the consumer's half), and it answers the question — on wall clock, not on
   damage or on money. Section 9 is the result and the reasoning; 6.3 now carries the two
   requirements the run adds to the build.
3. **Separate processes.** Only if the shared-persistence hazards in section 5 prove to matter, and
   section 8 now says which one would pull it forward: not the backup wipe, which turns out to be
   the cheapest of the three to defend, but settings and plugin permissions, which have no
   interception point at all.

## 8. Open

**Both questions are now MEASURED, not read, and neither argues for step 3.** The measurement ran on
an isolated Blockbench 5.1.6 (Electron 40.10.6 / Chromium 144) under its own `--userData`, driven
over CDP with empty projects, on an RTX 3050 Ti laptop; the scratch instance was removed afterwards
and the live app was never touched. Where a claim below still rests on reading rather than on a
trial, it says so.

- ~~Whether N windows cost N graphics contexts in practice, and what that means for how many
  sessions one machine can hold.~~ **Answered: 3N contexts, no ceiling in sight, and RAM is the only
  constraint.** Three WebGL contexts per window confirmed live in every window (`media` and
  `no_aa_media` offscreen, `main` connected).

  | windows | renderer procs | gpu-process MB | renderers MB | total MB |
  |---|---|---|---|---|
  | 1 | 1 | 190 | 162 | 563 |
  | 2 | 2 | 235 | 351 | 799 |
  | 3 | 3 | 269 | 539 | 1023 |
  | 4 | 4 | 305 | 711 | 1231 |
  | 6 | 6 | 374 | 988 | 1580 |
  | 8 | 8 | 430 | 1327 | 1977 |

  Dead linear through eight: about +180 MB of renderer, +35 MB in the shared gpu-process, ~220 MB
  total per window, one renderer process per window and one gpu-process for all of them. At eight
  windows that is 24 live contexts and `isContextLost()` was false on all 24 - no forced loss, no
  degradation. Blink's 16-context rule is per renderer process, so it never comes near biting. 220 MB
  a session is cheap, and windows are therefore not what limits how many sessions a machine holds.

  **The render-loop alarm two bullets up was overstated, and the measurement is the correction.** At
  eight stacked windows exactly one reported a frame rate (141 fps); the other seven reported
  `fps: 0` and `document.hidden: true`. Chromium's occlusion tracking already stops rAF for a covered
  window, and toggling `background_rendering` changed nothing measurable (renderers at 23% of one
  core either way). So `background_rendering: true` at 144 fps costs only for a window that is
  genuinely VISIBLE and unfocused - side by side with yours, or on a second monitor. An agent window
  buried behind your work is free in GPU time and costs only memory. That last half still rests on
  `animate()`'s guard rather than on a trial: two genuinely visible windows could not be arranged.

  **One incidental fact that changes 6.3.** Launching `Blockbench.exe` again with the same
  `--userData` does NOT add a window - it forwards to the running instance and exits 0, window count
  unchanged. Only the in-app action creates one (`BarItems.new_window.click()` ->
  `ipcMain.on('new-window')`). **So a shim cannot conjure itself a window by launching the exe;
  window creation has to come from inside the app, which means from our plugin.** Step 2's claiming
  protocol has to account for that: the plugin is what makes windows, and a shim that finds no free
  one has to ask an existing window for another rather than spawning a process.

- ~~Whether the backup-wipe on close (section 5) can be defended against from a plugin, or whether
  it argues for step 3 sooner.~~ **Answered: it is a REAL hazard, and the plugin defence works.
  Demonstrated, not reasoned.** Alternating trials, canary = another window's backup entry:

  ```
  UNPATCHED close -> canary PRESENT becomes GONE
  GUARDED   close -> canary PRESENT becomes PRESENT
  UNPATCHED close -> canary PRESENT becomes GONE
  GUARDED   close -> canary PRESENT becomes PRESENT
  UNPATCHED close -> canary PRESENT becomes GONE
  ```

  Three for three the wipe commits and destroys another window's entry; two for two the guard
  preserved it (a third guarded trial timed out on the READ, not on the guard). A separate check
  confirmed the guard still performs a genuine full clear when `removeAllBackups` is called outside
  the quit path, so the start screen's Discard button keeps working.

  **A correction to what this section said before.** It claimed the wipe was fire-and-forget and
  therefore raced renderer teardown, so it "cannot be reliably reproduced in order to test a fix".
  That was wrong. It came from a contaminated window in a crashed run; on clean alternating trials
  the wipe commits every time. The reading was right about the code and wrong about the consequence -
  which is the whole reason this bullet needed a trial and not a third read.

  **The guard is now IN THE PLUGIN, at 0.138.0 / plugin 0.4.0** (installed at `onload`, removed at
  `onunload`, four checks in the harness pinning both halves: quitting drops only this window's
  uuids, and a call off the quit path still clears everything).

  **The guard, as installed and verified live**, is the ten lines the source reading predicted: wrap
  `window.onbeforeunload` to set a quitting flag, and replace `AutoBackup.removeAllBackups` with one
  that deletes only `ModelProject.all`'s uuids while that flag is set. Everything it depends on was
  checked in the running renderer: `window.AutoBackup === AutoBackup` (the same object, so the patch
  reaches internal callers), `removeAllBackups` writable, `window.closeBlockbenchWindow` undefined
  (confirming it is not patchable), `onbeforeunload` a function. Also confirmed live in that window:
  3 contexts, `background_rendering: true`, `fps_limit: 144`, `recovery_save_interval: 30`.

**What is left as a step-3 argument** is the one hazard with no interception point: settings and
plugin permissions, read once at boot and written back whole, last writer wins. Not backups, and not
resources - and note against section 9 that step 2's problem is a BENEFIT problem, not a cost one.
Resources are not what would block step 2.

## 9. The A/B, both arms, and why the answer is wall clock (2026-09-08)

Their record is `ArmorPieces/docs/measurements/CONCURRENCY_AB.md`. Preconditions all held: distinct
`mcptk-<ppid>` per session, the binding fix in on both sides, matched briefs.

| | min | turns | bridge calls | $/piece |
|---|---|---|---|---|
| C alone (n=1) | 5.2 | 60 | 31 | $2.19 |
| C contended (n=2) | 14.3 | 123 | 59 | $5.15 |
| D alone (n=2) | 7.4 | 71 | 37 | $2.67 |
| D contended (n=2) | 11.6 | 90 | 39 | $3.01 |

**Read the money and you would defer step 2.** Contention costs 1.13x now where it cost 2.4x - the
guards did what they were built to do. **The money is the wrong column.** Two sessions started
together produced two pieces in 16.4 minutes; the same two built one after the other took 14.8.
Concurrency bought NEGATIVE wall clock. There is no version of "run two agents at once" that is
worth doing at a loss on the only axis it exists to improve.

**And it was serialisation, not slowdown.** The two processes started within two seconds of each
other. The second was refused ten times with `held_by: ... is bound to "dragon_scales"`, retried
`armorpieces_new` three times, and first held a piece of its own three and a quarter minutes AFTER
the first piece had finished. The 4.5-minute overlap of their bridge windows was spent entirely
being refused. It did not merely look serialised; it was.

**The mechanism is the gap 6.3 closes.** A session has no binding until it has a piece, so the call
that would give it one has nothing to name and resolves against the active tab - which, in one
window, belongs to whoever is currently working. Per-window ports and window claiming remove the
occasion: a session that owns a window has somewhere to put its first project.

**The case is stated at its weakest on purpose**, as the brief pre-registered. `risky_eval` was 0 in
both concurrent runs, `armorpieces_open` was 0, nothing was corrupted, no session wrote into
another's piece. Step 1 plus the binding fix turned a DAMAGING failure into a TOTAL one: the guards
hold, and what is lost is the whole point of running two at once. That is the case for step 2 -
built on wall clock, not on damage.

**Do not average the pair.** The mean hides that one run was ordinary and the other sat in a retry
loop; both records break the pair out per session instead.

**How much of era D's gain was the binding fix**, same piece and same brief: 14.5 min -> 5.6, 188
turns -> 65, `risky_eval` 23 -> 0, `no piece is open` 30 -> 0. Most of it. That is what makes this
re-run a clean read on concurrency rather than a second measurement of the scratch defect.

**One tooling note, and it is the falsifier's own column.** `measure_sessions.py` reads session ids
out of reply text, and a `held_by` refusal names the HOLDER, not the caller - so it filed the
refused session under the other session's id (`mcptk-13676` for what was really `mcptk-99264`).
Since the distinct-id column is what proves an A/B row is era D at all, it must prefer a session's
OWN stamp over any id quoted inside a refusal.

**FIXED 2026-09-08 in ArmorPieces (`tools/measure_sessions.py`), and the fix found something worse
than the mis-filing.** Two contexts are now read apart from the rest - what a session says about
ITSELF (`ping`'s `blockbench` block; the shared-id note, which quotes the caller's id because it is
the caller's id that is shared) and what it quotes about ANOTHER (`held_by`, in the plugin's
sentence and in `holderBlock`'s JSON) - an own stamp wins, and an id that appeared only inside
somebody else's refusal leaves the row with NO id rather than the wrong one. Re-run over the whole
69-transcript corpus, **every id in it turned out to be holder-quoted**: four rows carried one and
all four were the other session's, and no session in any era ever stamped its own. No era moved (the
mtime rule that `own_id` short-circuits still filed all seven D rows as D), so the A/B's numbers
stand - but the identity column was never evidence, and era D's distinct ids were confirmed
elsewhere: the shim's own stderr, and a third session's `held_by` reply naming a live holder.

**What that costs the contended re-run, and the one-line remedy.** The re-run's id column will read
`-` for every row unless each session puts its own id in its own transcript, and the cheap way to do
that is the one `TODO.md` 3.4 step 2 already names for a different reason: **each session calls
`ping` once**, whose `blockbench: {port, window, held, session}` block is exactly the own stamp the
reader now prefers. One call per session, at the start, and the falsifier's column is real evidence
for the first time.

---

## 10. What the live run found, and the flip it forced (2026-09-09)

Step 2 went in front of a person for the first time. It worked in the sense the harness could see -
windows appeared, sessions landed in windows of their own, nothing was corrupted - and it failed in
three ways no stub was ever going to show. Their common shape is worth naming before the fixes:
**every one of them is the difference between a window that exists and a window that is SOMEBODY'S.**
Step 2 built ownership of a window by a session and never asked who a window belonged to before a
session got there, or who it belonged to afterwards.

### 10.1 Nothing ever closed a window

`POST /window` had no counterpart anywhere: not a route, not a menu item, not a sweep. A session's
claim died with its presence socket, correctly, but the window it had been given stayed open, empty
and unclaimed, forever. In steady state the count is bounded by peak concurrency - the next session's
scan reclaims an empty one - and that is not what a person watching it sees, which is a row of
identical empty windows at ~220 MB each and a `PORT_SPAN` of 16 to fill.

**Fixed by giving a window a death condition, and hanging it on the CLAIM rather than on the tab.**
An agent-born window closes itself when it has no live claim, no open projects, and a grace period
has passed in which a shim whose presence dropped can come back. `project op:close` emptying a window
arms that clock rather than deciding it: a session that closes one piece and opens the next has not
finished, and the claim is the lease. The zero-projects clause is what makes this compatible with 6.2
- a dropped socket is not consent to destroy work, and a window with nothing open has no work to
destroy.

Two things it must never do. **Never close the last window**, because that quits Blockbench, and an
agent finishing its work is not a request to shut the app; a renderer can only count windows by
asking the range over http the way a shim does, and a window whose bridge is stopped answers nothing,
so the mistake this can make is always "stay open". And **never through `closeBlockbenchWindow`**,
which section 8 already established is module-scoped and unreachable - going around it with
`allow_closing` plus `window.close()` turns out to be the safer half of the bargain, because the
function we cannot call is the one that wipes every window's crash-recovery store. An automatic close
cannot destroy another window's backups even where the 0.4.0 guard is absent.

### 10.2 A window was takeable unless a person remembered to protect it

`takeable` was *not reserved and not claimed*, so the window somebody was working in was the first
thing a scanning shim claimed unless they had used `Reserve this window` first. A flag you have to
set to be safe is one you learn about by losing your tab, and it made the ordinary path - a person
with Blockbench open, an agent starting up - the dangerous one.

**Fixed by inverting the default: a window is the person's unless the plugin was ASKED to open it for
an agent.** `POST /window` leaves the asker's id in shared storage; the next window to win a port
consumes it, which is what makes that window agent-born, and only an agent-born window is claimable.
Nobody has to protect anything. The entry also PRE-CLAIMS the window for whoever asked, which closes
a real race: the port a new window will win is not knowable to the asker, so it has to go and scan,
and another session's scan could arrive first and take the window the first one had just paid two
seconds for.

`reserved` survives on `/hello` as a derived field (`!claimable()`) so that a shim from before the
flip - a consumer's stale extraction - goes on leaving a person's window alone, and the shim reads
`agent` where it is offered and falls back to `reserved` where it is not. Both sides again, or
neither.

### 10.3 An abandoned window looked taken for two minutes

`claimHolder()` asked `alive(s)`, which is *connected, or seen within `hold_ms`* - the same predicate
as a project binding. A session that died in the gap between claiming a window and its next
successful tool-list poll (that poll is what opens presence) therefore left a ghost claim standing
for two minutes, and a session starting inside that window saw a window that was taken and opened
another.

**Fixed by a distinction that should have been there from the start: the hold timer exists to protect
unsaved work in a BINDING. A window claim protects nothing, so it dies with the socket.** The only
grace left is the seconds a fresh claim needs before presence can possibly have arrived, which is
also exactly what a pre-claim needs.

### 10.4 A window that says whose it is

A row of Blockbench windows all look the same, and the only place the answer existed was `/hello`,
from outside the app. Two surfaces, because they answer different questions. The TITLE carries the
holding session in front of whatever Blockbench last wrote, so a taskbar is readable without focusing
anything - and since `setProjectTitle` is module-scoped like everything else interesting in this
record, it is a `MutationObserver` on the `<title>` node rather than a hook. The PANEL says what that
session is doing: the kind of window, the holder, the port, the bound project and tab count, the
countdown while it is emptying, and the last twelve calls with their cost.

### 10.5 Donation, and the thing that is NOT donation

Handing over the window you are sitting in stays possible and is now the only way a person's window
is ever claimed: `Let agents use this window`, stored by port for the same reason the reservation was.
It is honest about its cost - an agent in a donated window still steals the active tab whenever it
reads its own model, because one project is live at a time (section 4).

**Co-authoring is a different thing and is deliberately not built.** Working in a person's tab BESIDE
them - the agent as a second author on the project the person has open - is a separate route,
`connect`: an agent that INHERITS an open window rather than being given a fresh one, and therefore
needs what a fresh window never does, an account of the projects already open in it and a way to move
between them. It is not needed for release 1, which is LM-first: the ordinary case is an agent in a
window of its own. `TODO.md` carries it as designed-and-unbuilt.

---

## 11. The dock: why per-window self-government failed, and what replaces it (2026-09-10)

Section 10 shipped and went in front of a person a second time. What they reported is worth quoting
before it is diagnosed, because the diagnosis is only half right and the report is entirely right:

> The plugin is supposed to be preventing models from closing the last window. It actually is
> preventing many windows from being closed. Some windows are perceived by MCP as opened while they
> are hidden from Windows entirely. Sometimes 3 windows are open and I cant close any of them since
> they all think theyre the last window. Which means this wisn't build in the mcp bridge but on top
> of blockbench in general.

### 11.1 What the live scan found

Measured 2026-09-10 against the running app (plugin 0.7.0, Blockbench 5.1.6): **six windows, ports
25801-25806, every one of them serving, every one of them with ZERO projects open**, all maximised at
(0,0) 1920x1080 and therefore stacked exactly on top of each other. `EnumWindows` confirms all six
are real and visible; three carry the bare title `Blockbench` and nothing else.

| port | window | role as the plugin saw it | claim |
|---|---|---|---|
| 25801 | win-q0ttv574 | person's | - |
| 25802 | win-2q7zamud | agent, donated | mcptk-52888, connected |
| 25803 | win-gz3cyfya | agent | mcptk-62552, connected |
| 25804 | win-arlk28gv | **person's** | - |
| 25805 | win-r76k2ll4 | **person's** | - |
| 25806 | win-rsp7qxpv | agent | mcptk-32356, connected |

### 11.2 The last-window guard is not the mechanism, and the real one is worse

The guard was the obvious suspect and it is innocent. `otherWindowsAnswer()` fetches
`http://127.0.0.1:<port>/hello` from a renderer, and the fear was that Chromium's CORS would refuse
it - the origin is `file://` and `answer()` sends no `Access-Control-Allow-Origin`. **Tested live: it
succeeds.** Electron lets a `file://` origin through despite `webSecurity: true`. Every window can
see every other window. The guard runs correctly on the rare occasions it runs at all.

**What actually holds all six open is that none of them has a death condition that can fire.**

- 25801, 25804 and 25805 are `agent:false`, and `armEmptyCheck()` returns on its first line for a
  window that is not agent-born. `startSweep()` therefore never runs. **A window that is not
  agent-born has no death condition at all, ever** - not a timer, not a route, not a menu item.
- 25802, 25803 and 25806 are agent-born, but each still carries a live presence socket, so the claim
  never dies and the sweep never reaches its second condition.

So the report is exactly right about the symptom, and about the fault lying *above* the bridge, and
wrong only about which line does it. That distinction matters, because fixing the guard would have
changed nothing.

### 11.3 Five structural findings, each of which the dock answers

**(a) `agentBorn` is one in-memory boolean, set once, unrecoverable.** It is set only by
`adoptPending()` consuming a `localStorage` entry with a 120s TTL, inside the port-listen callback.
A slow boot, a plugin reload, a Blockbench restart, two windows racing the read-modify-write of
`mcptoolkit_bridge.pending`, or a person opening a window while an ask is outstanding, and the window
comes up as the person's forever. That is the measured state of 25804 and 25805. Nothing in the
system can correct it.

**(b) An empty window cannot be commanded.** Every tool including `risky_eval` resolves a project
first; a window with zero projects answers `no project is open`. Confirmed live while trying to close
25804 from outside. **The windows that most need cleaning up are precisely the ones nothing can
reach.**

**(c) There is no close route anywhere.** The routes are `GET /hello`, `/tools`, `/presence`,
`POST /cmd`, `/claim`, `/window`. `POST /window` creates; nothing destroys. The plugin's private 15s
sweep is the only path to a closed window in the entire system, and 11.2 is why it does not run.

**(d) The last-window check is check-then-act with no arbiter.** Three agent-born windows idling into
the same sweep each see the other two answer, and all three call `window.close()`. Nothing serialises
them. The failure this can produce is the one the guard exists to prevent: Blockbench quits.

**(e) `GET /hello` creates a session record.** `handle()` registers any request carrying
`X-MCPTK-Session`, scans included. Window 25804 had accumulated **eleven** session records from shims
that had only ever scanned past it. `hello().sessions` counts scanners, not users - misleading in
exactly the display a person would use to decide what is abandoned.

And the report's "hidden from Windows entirely" is, on this evidence, the stacking: six maximised
windows at identical geometry with identical titles, only the claimed ones carrying a `[session]`
prefix. A renderer cannot help here either - `document.visibilityState` reads `hidden` for every
covered window, so a window cannot truthfully report its own visibility.

### 11.4 The ceiling: a plugin cannot see or touch a window

Settled before designing, because it removes the obvious implementation. Blockbench's plugin sandbox
(`js/native_apis.ts`, `getModule`) allows exactly two lists:

```
SAFE_APIS        path crypto events zlib timers url string_decoder querystring constants buffer stream perf_hooks
REQUESTABLE_APIS fs process child_process https net tls util os v8 dialog clipboard shell
```

**`electron` and `@electron/remote` are on neither**, and `getModule` throws
`The module "electron" is not supported` for anything else. The `process` grant the bridge already
holds yields Node builtins through `getBuiltinModule` and nothing more. So:

- there is **no** `BrowserWindow.getAllWindows()`, and no roster of real OS windows;
- there is **no** way to focus, move or destroy another window from outside it;
- every cross-window act must be a **request the target window serves for itself**.

A corollary to state plainly rather than rediscover: **a window whose bridge is stopped, or whose
renderer is wedged, is unreachable by everything.** The dock can name it and say when it was last
alive; closing it stays a human clicking X.

Blockbench's own bookkeeping is no help either. `electron/main.js:171`:

```js
win.on('closed', () => { win = null; all_wins.splice(all_wins.indexOf(win), 1) })
```

`win = null` runs before `indexOf(win)`, so `indexOf` returns -1 and `splice(-1, 1)` removes the
**last** entry rather than the closed one. `all_wins` keeps destroyed windows and drops live ones.
Upstream bug; we cannot borrow that list even indirectly.

### 11.5 The thesis

Section 10's thesis was *a window is the person's unless it was opened for an agent*. It is right and
it is not enough, because it left every window to govern itself with nothing but its own memory. Each
of 11.3(a)-(e) has the same shape: **a window deciding something about itself, alone, from state that
does not survive.**

> **The window is the unit of ownership; it cannot also be the unit of government. What was missing
> is a place that outranks any single window.**

That place is the **MCP Dock**: one window, dedicated, that never holds a project, is never claimed,
never closes itself, and owns the roster.

### 11.6 Why a dedicated window and not a role

The alternative considered was the dock as a *role* the lowest-port window adopts, shown as a panel.
It is free, and it was rejected: a dock that is also somebody's working window is a dock that can be
the thing being cleaned up, and the never-the-last-window rule stays a distributed race. A dedicated
window costs ~220 MB (section 8: linear to eight, no ceiling anywhere near) and buys the rule
outright - **the dock is always present, so no other window is ever the last one, and 11.3(d) has
nothing left to race over.**

### 11.7 Roles, and how a window learns its own

Three roles: `dock`, `agent`, `person`. The change from 0.7.0 is not the vocabulary, it is *who
decides*. Today a window decides at boot and can never revise it; now **the dock assigns, and can
re-assign**, which is the whole of the answer to 11.3(a).

A window finds the dock through `dock_port` in shared settings - a single number, the same shape as
`shared_port`, which is the only shape that survives a store every window writes back whole
(section 5). On winning a port a window calls `POST /dock/hello {window, port}` and is told what it
is. **When no dock answers it falls back to 0.7.0's `localStorage` handoff**, so a Blockbench with no
dock behaves exactly as it does today and an older shim is never broken.

### 11.8 Two sources of truth, and their disagreement is the diagnostic

The dock learns the world twice, on purpose:

- **the scan** - the port range, which says what is *serving*;
- **the beat** - `POST /dock/beat`, pushed by each window: window id, port, role, holder session and
  liveness, projects with their dirty flags, and the last call's name, session and time.

The beat is a push rather than a poll so that "last session activity" is each window's own record
rather than something the dock infers. And the **difference** between the two lists is what names a
broken window, which is what was asked for:

| state | serving | beating | meaning |
|---|---|---|---|
| `live` | yes | yes | working |
| `silent` | yes | no | wedged renderer, or a plugin from before the dock |
| `ghost` | no | recently | bridge stopped, or the window is gone |
| `orphan` | yes | yes | role `agent`, no claim, no projects, idle past the grace - closeable |

### 11.9 The routes

On **every** window (new):

- `POST /close {force}` - refuses when a project is dirty unless forced, refuses outright when this
  is the dock, else `allow_closing` + `window.close()`, answering before it goes. This is the
  mechanism 11.3(c) has no substitute for, and per 11.4 it can only live here.
- `POST /focus` - the window raises itself.
- `POST /role {role}` - the dock re-labels this window. The cure for 11.3(a).
- `GET /hello` gains `role`, `dock_port`, `projects[]` and `last_call`.

On **the dock only**:

- `GET /dock` - the roster.
- `POST /dock/hello`, `POST /dock/beat` - registration and heartbeat.
- `POST /dock/window {session}` - **allocation, and the new front door.** Reuse a free `agent`
  window, else make one. Because the dock creates the window *and* receives its handshake, it learns
  the port directly and answers with it - which deletes the race 0.7.0 papered over with a pre-claim,
  where the asker could not know which port its window would win and had to go and scan for it.
- `POST /dock/close {port, force}` - the dock arbitrates, then calls `POST /close` on the target. One
  arbiter, so 11.3(d) cannot happen.

### 11.10 What the dock does not fix

Said here so it is not rediscovered. **Settings and plugin permissions remain last-writer-wins across
windows** - section 8 named them as the hazard with no interception point, and a dock adds none. A
**wedged or stopped window stays uncloseable** (11.4). And the dock is not `connect` (`TODO.md` 4.6):
it allocates windows, it does not put an agent beside a person in a tab they are already working in.

### 11.11 Order of work

1. **Plugin**: roles and the `dock_port` handshake; `POST /close`, `/focus`, `/role`; the dock's
   `/dock/*` routes; the roster; the dock panel and its per-row Focus / Adopt / Release / Close; the
   menu item that opens a dock.
2. **The five small fixes**, none of which needs the dock and all of which were found with it:
   `GET /hello` stops creating sessions (11.3e); every bridge window carries its port in the title so
   a stack of them is tellable apart; the backup guard's `quitting` flag stops latching true after a
   cancelled close; a non-agent window gains a recycle path (11.3a); a new window is offset rather
   than maximised onto the same pixels.
3. **Shim**: prefer the dock, fall back to the 0.7.0 scan.
4. Probes, `BLOCKBENCH_BRIDGE_DESIGN.md`, versions.

### 11.12 As built, and what the live run found (2026-09-10)

Built at toolkit 0.144.0 / plugin 0.8.0 / shim 0.72.0, and then run against the six-window Blockbench
that opened this section rather than against a stub.

**What ran.** A window opened from the menu path (`openDock` leaves a `dock` handoff; the window that
wins a port consumes it and calls `becomeDock`) came up on port 25809 answering `role: "dock"` and
wrote `dock_port: 25809` into shared settings. The next window read that hint and registered against
it. `GET /dock` then listed all eight windows in the range with their roles, holders, open projects
and last call. `POST /dock/close` closed a 0.8.0 window, refused the dock itself with the sentence
that says why, and refused a 0.7.0 window because that plugin has no `/close` route at all - which is
`silent` and a 404, exactly the two things section 11.8 predicted a pre-dock window would look like.
The seven windows running 0.7.0 all read `silent`: serving, never beating, roles read from their own
`/hello`. That is the compatibility case working, not a defect.

**And a bug no stub could show.** The window opened for a session came up `claimed_by: null`. The
pre-claim had never worked ACROSS WINDOWS and could not have: `claimHolder()` resolves the holder id
through `sessions`, the window that runs `session(sb)` is the one that was ASKED, and the window that
is BORN has never heard of that id. So since 0.7.0 every window opened for a session has been
answering "unclaimed" to the next scan, which is one more way the row of empties grew. The offline
test could not see it because one plugin instance plays both windows; the fix is `preClaim`, which
makes the record as well as the claim, and the test now deletes the record first so that it falsifies
rather than restates. Verified both ways: reverted, the new assertion goes red with `null`.

**One more thing the live run demonstrated by accident.** A window opened during this work sat empty
and unclaimed - because of that same pre-claim bug - and closed itself after its sixty-second grace,
having found the other windows answering. The sweep, `otherWindowsAnswer` and `closeThisWindow` all
work in the real app. What was wrong was never that machinery; it was that almost nothing in a real
afternoon ever satisfied its preconditions.

**Left for the person at the keyboard.** The six 0.7.0 windows cannot be closed from the dock,
because a plugin cannot reach into another window and the route they would have to serve does not
exist in their version (11.4). They close by hand, or by restarting Blockbench, after which every
window comes up on 0.8.0. The dock names them and says so; it does not pretend.

### 11.13 The line that was making the mess (2026-09-10, same day)

Section 11 built a dock to manage a mess of windows. It did not ask what was making them. A restart
answered that within seconds, and the report is the whole finding: *"I just started blockbench and 4
session windows instantly opened"*, and *"closing the windows still reopens them, still no control."*

**One line, and it predates every part of this record.** `fetchBlockbenchTools` runs on the tool-list
WATCHER - for every session, on a poll cadence, whether or not anybody ever touches Blockbench - and
it called `resolveWindow`, which claims or CREATES one. So:

- four live sessions and a Blockbench that starts is four windows instantly, none of which will ever
  be used;
- and a window a person closes makes that session's `/tools` fail, drop `windowState`, and ask for a
  replacement on the next poll, which is why closing one did nothing.

**The windows were never leaking. They were being demanded, by sessions with no work for them.**
Section 11.3's five findings are all real and all downstream of this: they are why the demanded
windows then could not be counted, labelled, recycled or closed.

**The fix is that a manifest is a property of the PLUGIN, not of a window.** Every window serves the
same `/tools`, so reading it needs no ownership: `peekBase` takes whatever answers and claims nothing,
and a window is allocated at the first CALL - the first moment a session has asked Blockbench to do
something. Presence had to move with it, and the reason is the same one: presence registers a session
IN A WINDOW, so a session that has none has nothing to register, and a socket opened at discovery
lands in whichever window happens to hold the first port of the range rather than the one the session
will work in.

One behaviour changed deliberately. A session that cannot have a window now SEES the Blockbench tools
and is refused when it calls, where before it was shown no surface at all. The refusal is unchanged;
only its timing moved, to where the ownership decision itself now lives.

**And the dock could be two.** Both windows answering `role: "dock"`, each having written its own port
into the shared settings every other window reads, so a window was told a different address depending
on which answered it and the roster split in two. **The lowest port wins** - the one fact both can
see, neither can argue with, and nothing needs to be exchanged to agree on, which is exactly why the
port is a window's name (6.3). The higher stands down into an ordinary window, drops its roster and
its panel, and goes looking for the winner. `openDock` refuses up front rather than leaving the scan
to clean up after it.

Built at toolkit 0.145.0 / plugin 0.9.0 / shim 0.73.0. 274 plugin-green (6 new), 16 in
`blockbench-surface` (1 new), and both new regressions were falsified against the old code: the
idle-session probe goes red under eager allocation, and the two-dock probe leaves two docks each
listing the other.
