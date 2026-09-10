<#
.SYNOPSIS
  Run the live probe battery SEQUENTIALLY, one file at a time, and summarise.

.DESCRIPTION
  Probe files run concurrently against ONE world and own distinct sites (probes/site-map.test.mjs
  is the static guard). `npm run test:live` runs them all at once, which is a useful load test but
  a poor arbiter: the acts got slower in 0.52.0 (real dig settle, container ceremony, 1.6s meals),
  so every timing window widened and the concurrent run is flaky BY DESIGN. Sequential is the
  arbiter — see the video-watchability batch notes.

  Writes `<name> => # pass N # fail M` per file plus the failing assertion lines, so the log is
  greppable and diffable against previous runs (mcp-server/sequential-*.log).

.PARAMETER Out
  Log path. Defaults to mcp-server/sequential-<version>.log using mcp-server/package.json.

.PARAMETER Only
  Comma-separated probe names (no .test.mjs) to run instead of all. EXACT strings: `-Only
  clinic-conformance.test.mjs` or a typo matches nothing and the run reports "(0 files)" and exits 0.

.PARAMETER Chunk
  Chunk letters (a, b, c, d) to run instead of all -- the thematic quarters declared in $CHUNKS
  below. An unknown letter is refused; it never silently runs zero files. Cannot be combined with
  -Only. Takes `-Chunk a,d` AND `-Chunk 'a,d'`: it is [string[]] precisely because PowerShell reads
  an unquoted comma list as an ARRAY, which is what makes the documented `-Only a,b` form die with
  "Cannot convert value to type System.String" unless it is quoted.

.EXAMPLE
  ./tools/battery.ps1
.EXAMPLE
  ./tools/battery.ps1 -Only player-body,visible-acts
.EXAMPLE
  ./tools/battery.ps1 -Chunk a
.EXAMPLE
  ./tools/battery.ps1 -Chunk a,d      # COMBAT_CLINIC.md section 10 step 6, after J1
#>
[CmdletBinding()]
param(
    [string]$Out,
    [string]$Only,
    [string[]]$Chunk,
    [int]$Port = 25599
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$server = Join-Path $repo 'mcp-server'

# CHUNK MEMBERSHIP, DECLARED NOT GUESSED (COMBAT_CLINIC.md section 9.2). The four chunks were real
# -- the last full battery ran as sequential-0.75.0-{a,b,c,d}.log -- but they lived NOWHERE except
# those four filenames, so "chunk a is sufficient after a Shots change" was folklore: reconstructable
# only by opening old logs, and unusable by anyone who had not. Two things depended on it and could
# not be typed: section 10 step 6 ("re-run battery chunks a AND d after J1", because J1 moves
# getKnownMovement and chunk d is nav/movement) and step 7 ("chunk a green with a non-zero delta").
# The list below IS those four logs, transcribed, plus the two clinic probes of step 2 declared into
# chunk a -- they are combat-theme instruments (the clinic measures the spear) and they are offline,
# so they cost the chunk nothing but a known non-zero pass count.
$CHUNKS = [ordered]@{
    # a -- combat: every file that exercises a weapon, a projectile or a reflex. `combat-fixes`,
    # `combat-kit`, `conformance` and `reflexes-ranged` all touch a projectile, which is what makes
    # a chunk-a re-run a sufficient check after a `Shots` change (COMBAT_KIT_PLAN.md section 11).
    a = @('act-honesty', 'attack-goal', 'attack-terrain', 'clinic-conformance', 'clinic-dry',
          'combat-fixes', 'combat-kit', 'conformance', 'event-stream', 'ranged-pressure',
          'reflexes', 'reflexes-combat', 'reflexes-engage', 'reflexes-equip', 'reflexes-flee',
          'reflexes-interrupt', 'reflexes-ranged')
    # b -- the body, the hands and the harness itself (argument gates, profiles, site ownership),
    # plus the world-edit tools and their transactional contract: `review-fixes` and `place-shapes`
    # both exercise place_shape/place_shapes/set_blocks and the shared EditJournal, so a chunk-b
    # re-run is the sufficient check after a ShapeTools or EditJournal change.
    # `review` sits here beside `human-task` and `extension`: all three are the agent-to-human
    # surface plus its extension seam, and none of them is about a body.
    # `authoring` (0.89.0) and `log-channel` (0.91.0) joined 2026-08-26. Both had been shipping in
    # NO chunk, which the warning below says out loud and nobody had acted on: a full run picked
    # them up and every `-Chunk` run silently skipped them. `authoring` drives set_blocks and
    # capture_structure, so it belongs beside `place-shapes`; `log-channel` drives push_data and the
    # reload contract, which is harness surface in the same sense `arg-check` and `profiles` are.
    # `registry-detail` (0.92.0) joins them for the same reason: it drives push_data and the reload
    # contract to ask whether a recipe LOADED, which is log-channel's question one step further on.
    # `place-structure` joins it beside `authoring`: it captures a chamber and puts it back, so it is
    # the same set_blocks/capture_structure/EditJournal surface from the other end.
    # `perf` and `promote` (0.95.0) join for the same reason: `perf` reads the SERVER's own tick and
    # freezes it for one assertion - harness surface, and a global one, which is why it belongs in a
    # sequential battery rather than a concurrent run - and `promote` drives push_data/clear_data,
    # which is log-channel's pack contract from the other end.
    # `ui-input` (0.97.0) joins here as harness surface too, with one caveat declared rather than
    # discovered: it is the first probe file that needs a CLIENT. It skips itself headless (bridge
    # up, clientPresent false), so a chunk-b run on runServer stays green and simply covers less.
    # `data-validate` (0.100.0) joins for log-channel's reason exactly one step earlier: it drives
    # push_data and asks whether a file would load BEFORE the reload that would have logged it.
    # `loot-roll` (0.101.0) is the step AFTER both: it pushes a table, reloads, asks query_registry
    # whether it loaded and then rolls it. Same shared reload, same global resource, same chunk.
    # `canvas-edit` (0.102.0) joins beside `authoring` and `place-structure`: its save IS
    # capture_structure driven through an edit session, and it reloads the shared pack afterwards.
    # `preview-worldgen` (0.103.0) joins beside `data-validate`: same modder, same loop one step on -
    # push_data validates the worldgen JSON, this asks what the generator that loaded it now makes.
    # It owns no site, forceloads nothing and freezes nothing, so it is a chunk-b citizen by theme
    # rather than by resource.
    # `agent-client` (0.104.0) joins as harness surface of the plainest kind: it asserts the §F3
    # configuration - bridge up, NO agent client configured, server registered by hand - plus the
    # hello handshake and the kit/capability arbitration matrix. It stages nothing, owns no site and
    # reloads nothing, so it is a chunk-b citizen by theme like `arg-check` and `profiles`.
    # Declared here on the day it shipped, because a probe in no chunk is one every -Chunk run skips.
    # `render-camera` (0.105.0) joins beside `canvas-edit` and `ui-input`: it is the phase-1 camera
    # and it carries the phase-2 arbiter canvas-edit could not run - "the studio is uniformly the
    # colour it declares" needs an instrument that can look at it, and until now there was none. It
    # is the SECOND probe file that needs a CLIENT and it skips itself headless the same way, so a
    # chunk-b run on runServer stays green and simply covers less. It stages a wall in the studio at
    # NEGATIVE coordinates, outside the canvas slot allocator's range, so it collides with no session.
    # The five that a full run on 2026-08-28 reported as being in NO chunk - the same drift this
    # script has warned about since 0.89.0, and the second time the warning has had to be acted on
    # rather than read. All five are SHIM surface, which is chunk b's theme exactly: `tool-surface`
    # and `tool-list-changed` are the served manifest and its mid-session refresh, `authoring-saving`
    # and `rocketeer-authoring` are what two keep-profiles actually remove, and `blockbench-surface`
    # is the upstream's 94 tools being scoped by profile. None of them stages geometry or owns a
    # site; they are chunk-b citizens the way `profiles` and `arg-check` are.
    # `attach-identity` (0.110.0) is shim surface like the five above: it spawns the shim over
    # stdio, calls `ping`, reads stderr, stages nothing and reloads nothing. Declared on the day it
    # shipped, because a probe in no chunk is one every -Chunk run skips.
    # `launch-project` (0.111.0) is its pair: which GAME a session reaches, and which PROJECT it
    # launches, are the same question asked of the two ends. It needs no bridge at all - it builds
    # synthetic Gradle roots in a temp dir and reads this workspace's real ones - so it is the one
    # chunk-b member that is green with no game running.
    # `mmcp-servers` (0.112.0) joins beside `agent-client`: same subsystem, one layer down. It drives
    # /mmcp server through run_command and reads the JSON back off disk, so it stages no geometry, owns
    # no site and reloads nothing - and its temp directories are its own. Declared on the day it
    # shipped, because a probe in no chunk is one every -Chunk run skips.
    # `mmcp-commands` (0.141.0) is `mmcp-servers`' sibling one level up: not what a subtree WRITES but
    # that the subtree is there at all, and that the three roots B2 replaced are gone rather than
    # aliased. It only reports - `/mmcp session` lists and never stops anything - so it owns no site
    # and touches no block. Declared on the day it shipped.
    # `render-studio` (0.113.0) joins beside `render-camera` and `canvas-edit`, and it is the THIRD
    # probe file that needs a client. It is also the first that moves the HUMAN'S OWN PLAYER to
    # another dimension and back, which is why it belongs in a sequential run and nowhere near a
    # concurrent one: a file that reads without naming a dimension while this one is mid-shot would
    # answer about a flat white void. It skips itself headless like the other two.
    # `ui-doc` (0.114.0) joins beside `ui-input`: the screen-authoring interpreter, driven through
    # open_screen/get_screen/click/check_layout on the client's own screen. It stages nothing, owns
    # no site and reloads nothing; it opens and closes a detached preview of the toolkit's own
    # example document. It needs a client IN A WORLD (the preview borrows the player's inventory)
    # and skips itself otherwise, so a headless chunk-b run stays green and covers less. Declared
    # on the day it shipped, because a probe in no chunk is one every -Chunk run skips.
    # `ui-emit` (0.115.0) joins beside `ui-doc`: the emitter's generated screen opened through the
    # integrated server and compared against the interpreted preview - the first interpreted-vs-
    # generated comparison. Same needs (a client IN A WORLD), same self-skip, no site.
    # `ui-conform` (0.116.0) is the conformance battery itself (SCREEN_AUTHORING_DESIGN.md section
    # 12): enumerated from the registry, pixels compared off the framebuffer, and the falsifier that
    # proves the comparison sees a corrupted generated screen. Same needs, same self-skip, no site.
    # `ui-edit` (0.117.0) is slice 4's in-game editor, driven entirely through click/send_keys/
    # set_text/get_screen - which is the editor's own acceptance test (section 9 claims the toolkit's
    # tools can drive it). Same needs (a client IN A WORLD), same self-skip. It edits a COPY of the
    # example document under the temp dir, never the repo's, and owns no site.
    # `ui-tool` (0.118.0) is slice 5's `ui_doc` (section 10). MOST of it needs no client at all -
    # reading, linting, editing and generating a document are files and the model - so it self-skips
    # only the preview and editor-conflict cases. It works on a COPY of the example inside a TEMP
    # CHECKOUT it builds itself (build.gradle, gradle.properties, src/main/java), which is what lets
    # `generate` be run end to end without writing into any repository. It owns no site.
    # `ui-attach` (0.119.0) is slice 6: the ATTACHED preview (the interpreter over a real screen's
    # LIVE menu) and regenerate-on-save. It opens the generated sample through the integrated server
    # and swaps in front of it, so it needs a client IN A WORLD and a non-spectator player, like
    # `ui-emit`; it owns no site. Its editor half writes Java into a TEMP CHECKOUT it builds itself,
    # never into a repository.
    # The loop kit's four (0.122.0-0.124.0: `image-budget`, `loop-hook`, `loop-profile`,
    # `paint-code`) are shim surface like `tool-surface` and `attach-identity`: they spawn the REAL
    # shim over a stub bridge and a stub Blockbench (probes/loop-harness.mjs), so they need no game,
    # stage nothing and own no site. Declared 2026-09-06 (RELEASE.md section 2.3), because the WARN
    # below had already gone unread twice and was not going to be the mechanism a third time.
    b = @('agent-client', 'arg-check', 'attach-identity', 'authoring', 'authoring-saving', 'bench-conformance',
          'mmcp-servers', 'mmcp-commands',
          'blockbench-surface', 'rocketeer-authoring', 'tool-list-changed', 'tool-surface',
          'bot-target', 'canvas-edit', 'launch-project',
          'render-camera', 'render-studio',
          'data-validate', 'dig-lock', 'entity-preview', 'loot-roll',
          'extension', 'fake-player', 'human-task', 'log-channel', 'crash-summary', 'perf', 'place-shapes',
          'place-structure', 'player-body', 'player-hands', 'predicates', 'preview-worldgen',
          'profiles', 'promote',
          'query-class', 'reach-goals', 'registry-detail', 'review', 'review-fixes', 'site-map',
          'ui-attach', 'ui-conform', 'ui-doc', 'ui-edit', 'ui-emit', 'ui-input', 'ui-tool', 'ui-world',
          'verdict-equivalence',
          # `loop-examples` (0.140.0, TODO.md 1.8) replaces `paint-code` here, which had named no
          # probe file since the loop kit's rename - so chunk b was carrying a dead name AND
          # skipping a live file, which is the two halves of this warning at once. It is shim
          # surface like its three neighbours: it resolves the SHIPPED examples against the live
          # manifest and runs them, needing no game and owning no site.
          'image-budget', 'loop-hook', 'loop-profile', 'loop-examples',
          # The dash's five (0.126.0-0.131.0), declared 2026-09-06 when the step-7 battery's WARN
          # named them - the third time the warning has had to be read. `crash-summary` is above;
          # `context-column` and `headless-surface` are shim/manifest surface like `tool-surface`;
          # `tooltip` and `studio-entity` drive the client's screen and studio like `render-studio`;
          # `create-world` is GATED (MCPTK_PROBE_CREATE_WORLD=1, title screen) and self-skips in
          # a battery, so listing it here changes nothing but the warning.
          'context-column', 'create-world', 'headless-surface', 'studio-entity', 'tooltip')
    # c -- perception: what the body can see, sense, locate and summarise about the world.
    c = @('attention-cost', 'block-watch', 'check-path-r1', 'drown-net', 'fan-density', 'hazards',
          'locate', 'pattern-search', 'perception', 'perception-coverage', 'perception-mode',
          'region-summary', 'retina', 'spatial-inversion', 'spatial-sense')
    # d -- nav and movement, plus the recording that rides on it. `known-movement.test.mjs` LANDED
    # here with J1 (section 9.3, build-order step 6) and is why a J1 change re-reads chunk d.
    d = @('descent', 'input-frame', 'known-movement', 'mine-up', 'nav-wedge', 'obs-gap-synthetic',
          'pit-escape', 'respawn-dry', 'swim', 'swim-rights', 'tunnel', 'tunnel-descend',
          'visible-acts', 'walker', 'walker-caps', 'walker-vert', 'wm-rblock')
}

# Resolved BEFORE the four-minute wait for a world, deliberately: a typo'd chunk letter must cost a
# second, not four minutes and then a green "(0 files)".
$chunkWant = $null
$chunkTag = ''
# `$PSBoundParameters` and not `if ($Chunk)`, because those are two different questions and the
# difference cost a real battery run: `-Chunk ''` binds as a one-element array whose single element
# is '', which PowerShell unwraps to '' and reads as FALSE -- so the flag fell straight past this
# whole block and escalated to the FULL 63-file battery against a live server, stamping
# purpose:"battery" on somebody else's session. An empty value is a typo or an unset variable
# (`-Chunk $letters` where $letters never got assigned); it is never a request to run everything.
# Asking whether the parameter was PASSED separates "no chunk given" from "a chunk given as blank".
if ($PSBoundParameters.ContainsKey('Chunk')) {
    if ($Only) {
        Write-Host "[battery] REFUSED: -Chunk and -Only are two different ways to name the same list."
        Write-Host "[battery] Pick one. (-Chunk a,d for a theme; -Only <names> for exact files.)"
        exit 2
    }
    # Joined THEN split, so `-Chunk a,d` (PowerShell binds it as an array) and `-Chunk 'a,d'` (one
    # string) are the same request. The array form is the one people type.
    $letters = @(($Chunk -join ',') -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } |
        Where-Object { $_ -ne '' })
    $unknown = $letters | Where-Object { -not $CHUNKS.Contains($_) }
    if ($unknown) {
        # section 9.2's second receipt, applied to this flag: `-Only` answers a typo with zero files
        # and exit 0, which reads exactly like a clean run. A chunk letter never gets to do that.
        Write-Host "[battery] REFUSED: unknown chunk $($unknown -join ', '). Known: $($CHUNKS.Keys -join ', ')."
        Write-Host "[battery] Refusing rather than running zero files: a battery that runs nothing and exits 0"
        Write-Host "[battery] is indistinguishable from a battery that passed, which is the whole point of the flag."
        exit 2
    }
    if (-not $letters) {
        Write-Host "[battery] REFUSED: -Chunk was empty. Known: $($CHUNKS.Keys -join ', ')."
        exit 2
    }
    $chunkWant = @($letters | ForEach-Object { $CHUNKS[$_] } | Sort-Object -Unique)
    $chunkTag = ($letters | Sort-Object) -join ''
    Write-Host "[battery] chunk(s) $($letters -join ',') => $($chunkWant.Count) declared probe name(s)"
}

# The bridge answering `ping` is NOT enough: on a dedicated server BridgeServer starts before the
# world does, and every probe then fails with "no server running - load a world first". Gate on
# serverRunning, which is the condition the probes actually need.
$body = @{ tool = 'ping'; args = @{} } | ConvertTo-Json -Compress
$deadline = (Get-Date).AddMinutes(4)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/cmd" -Method Post -Body $body `
            -ContentType 'application/json' -TimeoutSec 5 -DisableKeepAlive
        if ($r.ok -and $r.result.serverRunning) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 3
}
if (-not $ready) { Write-Error "[battery] no world loaded on port $Port after 4 min"; exit 1 }

# -Port DECIDES WHICH GAME THE PROBES TALK TO, not just which one this script waits for. Until
# 2026-08-24 it did the second only: the readiness poll and the purpose=battery tag went to $Port
# while every probe file read its own default (MCPTK_URL or 25599), so `-Port 25610` tagged the
# dedicated server and then fired 63 probe files at whatever was on 25599 -- another session's
# client, staging over its world with this run's geometry and reporting the results as if they were
# this server's. That is the probe-contamination class the site map already exists to prevent, one
# level up: same sites, wrong world. One line, and it makes the flag mean what it says.
$env:MCPTK_URL = "http://127.0.0.1:$Port"
Write-Host "[battery] probes will call $env:MCPTK_URL"


# Say out loud what this recording session is FOR (V3_PLAN.md section 3 R-b). The recorder is
# always on, so a battery run writes wm rows like any other session -- and section 4.4 names the
# consequence of letting those in silently: battery geometry became 62% of v2's training steps
# because the trainer swept everything under data/raw. The battery is the correctness GATE, not
# the corpus, so it stamps purpose=battery and corpus-v3.json excludes it by name. An untagged
# session would read as adhoc (also out of corpus), which is why this is best-effort: the tag
# tool ships with the R-block toolkit, and THIS script is the arbiter the whole rebuild is judged
# by -- it may never fail because a dev tool is missing from an older jar.
$tagBody = @{ tool = 'wm_session_tag'; args = @{ purpose = 'battery' } } | ConvertTo-Json -Compress
try {
    $tag = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/cmd" -Method Post -Body $tagBody `
        -ContentType 'application/json' -TimeoutSec 5 -DisableKeepAlive
    if ($tag.ok) {
        Write-Host "[battery] session tagged purpose=battery (excluded from corpus-v3)"
    } else {
        Write-Host "[battery] WARN wm_session_tag refused: $($tag.error | ConvertTo-Json -Compress) - session stays untagged (adhoc = out of corpus)"
    }
} catch {
    Write-Host "[battery] WARN wm_session_tag unavailable ($($_.Exception.Message)) - pre-R-block toolkit? session stays untagged (adhoc = out of corpus)"
}

if (-not $Out) {
    $version = (Get-Content (Join-Path $server 'package.json') -Raw | ConvertFrom-Json).version
    # The -a/-b/-c/-d suffix is the convention the chunk logs already use (sequential-0.75.0-a.log),
    # and without it a chunk run would overwrite the full battery's log with a quarter of it.
    if ($chunkTag) { $Out = Join-Path $server "sequential-$version-$chunkTag.log" }
    else { $Out = Join-Path $server "sequential-$version.log" }
}

$files = Get-ChildItem (Join-Path $server 'probes') -Filter '*.test.mjs' | Sort-Object Name

# Said out loud whatever is being run: a probe in no chunk is invisible to every `-Chunk` invocation,
# so the map above has drifted from probes/ and somebody has to put the new file in a quarter.
$allNames = $files | ForEach-Object { $_.Name -replace '\.test\.mjs$', '' }
$declared = @($CHUNKS.Values | ForEach-Object { $_ })
$unlisted = @($allNames | Where-Object { $declared -notcontains $_ })
if ($unlisted.Count) {
    Write-Host ("[battery] WARN probes in NO chunk: $($unlisted -join ', ') - a -Chunk run skips " +
        'them silently. Declare them in $CHUNKS at the top of this script.')
}
$orphaned = @($declared | Where-Object { $allNames -notcontains $_ })
if ($orphaned.Count) {
    Write-Host "[battery] WARN chunk names with no probe file: $($orphaned -join ', ') - renamed or deleted."
}

if ($Only) {
    $want = $Only -split ',' | ForEach-Object { $_.Trim() }
    $files = $files | Where-Object { $want -contains ($_.Name -replace '\.test\.mjs$', '') }
}
if ($chunkWant) {
    # The SAME exact-string path -Only takes. A chunk is a name list; it is not a prefix, a pattern
    # or a directory, so a file it names and does not find is the $orphaned warning above, not a
    # silent miss here.
    $files = $files | Where-Object { $chunkWant -contains ($_.Name -replace '\.test\.mjs$', '') }
}

"" | Set-Content -Path $Out -Encoding utf8
$totalPass = 0; $totalFail = 0; $failed = @()
foreach ($f in $files) {
    $name = $f.Name -replace '\.test\.mjs$', ''
    Push-Location $server
    $output = & node --test "probes/$($f.Name)" 2>&1 | Out-String
    Pop-Location
    $pass = 0; $fail = 0
    if ($output -match '(?m)^# pass (\d+)') { $pass = [int]$Matches[1] }
    if ($output -match '(?m)^# fail (\d+)') { $fail = [int]$Matches[1] }
    $totalPass += $pass; $totalFail += $fail
    $line = "$name => # pass $pass # fail $fail"
    Write-Host $line
    Add-Content -Path $Out -Value $line -Encoding utf8
    if ($fail -gt 0) {
        $failed += $name
        # The failing assertion names go in the summary; the FULL TAP output of a failing file goes
        # beside it. `error: |-` is a YAML block scalar - the message is on the indented lines that
        # follow, so a line filter captures the header and drops the very thing you need (cost a
        # 13-minute battery run 2026-08-06). Keep the whole thing and grep it afterwards.
        ($output -split "`r?`n" | Where-Object { $_ -match "^\s*not ok \d+ - " }) |
            ForEach-Object {
                $l = $_.TrimEnd()
                Add-Content -Path $Out -Value $l -Encoding utf8
                Write-Host $l
            }
        $dump = [IO.Path]::ChangeExtension($Out, $null) + "$name.tap.txt"
        Set-Content -Path $dump -Value $output -Encoding utf8
        Write-Host "    full TAP -> $dump"
    }
}

$summary = "TOTAL => # pass $totalPass # fail $totalFail  ($($files.Count) files)"
Write-Host ""; Write-Host $summary
Add-Content -Path $Out -Value "" -Encoding utf8
Add-Content -Path $Out -Value $summary -Encoding utf8
if ($failed.Count) {
    $l = "FAILING FILES: $($failed -join ', ')"
    Write-Host $l; Add-Content -Path $Out -Value $l -Encoding utf8
}
Add-Content -Path $Out -Value "DONE" -Encoding utf8
Write-Host "log: $Out"
if ($totalFail -gt 0) { exit 1 }
