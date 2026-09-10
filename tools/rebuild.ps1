<#
.SYNOPSIS
  Close the running Minecraft dev instance, rebuild the mods, relaunch, and wait until the MCP bridge answers.

.DESCRIPTION
  The structural-change loop for mcp-toolkit development. Defaults to the TOOLKIT's own dev game:
  mcp-toolkit is its own Gradle root and hosts its own runClient/runServer, so toolkit work no
  longer boots an unrelated content mod. -Project takes any build root - the path of a sibling
  checkout (menagerie, rocketeer, nijntje, villagejobs), which is what an MCP session in that repo
  passes.

  Method-body edits hotswap via the `hotswap_class`
  tool; anything structural (new tools, new fields/classes, new registrations) needs a full restart, and the
  running client/server holds a lock on the built jar so it must be stopped before Gradle can rebuild.

  This script does the whole cycle in one command:
    0. Take the lock  — ONE CYCLE PER PORT. Refuses (exit 3) if another rebuild already owns -Port,
                        because step 1 would otherwise kill that cycle's game. -Takeover overrides.
    1. Stop the game  — graceful stop over the bridge (`quit_game` on a client, the `stop` command on a
                        dedicated server), then force-kills whatever still holds the port.
    2. Build          — `gradlew build` (surfaces compile errors before a window opens).
    3. Relaunch       — root-qualified `:runClient` or `:runServer`, detached, on -Port.
    4. Wait           — polls the bridge `ping` until it answers, so you know when tools are live again.

.PARAMETER Project
  Which build root to cycle - A DIRECTORY, or one of two shorthands for the roots in this checkout.
  It was an enum of two, which quietly made this script a mcmodding-only tool: every repo in the
  workspace registers the same MCP shim, so `launch_game` from menagerie's session reached this
  script and cycled THE TOOLKIT's game. Any Gradle root with a wrapper works now, sibling checkouts
  included; launch_game passes the one it resolved from the session's own port.

  Shorthand: 'toolkit' (the default) is mcp-toolkit/ - loader + Minecraft + the bridge and nothing
  else, the leanest environment the bridge can be exercised in. Its game directory is the workspace
  root's run/, the accumulated dev instance - saves, run/mcptoolkit/survival, review/. A sibling
  checkout brings its own run/, so cycling it does not touch this one. (Until 2026-09-06 the root was
  also the Village Jobs build, reachable as -Project villagejobs; it is a sibling checkout now.)

.PARAMETER Target
  'client' (default) launches runClient; 'server' launches the headless runServer (faster; SERVER-context
  tools only — no screenshots/UI/quit_game).

.PARAMETER Port
  The bridge port. DICTATED to the game, not read from it: this value is both what the relaunched
  game is told to bind (-Pport, which build.gradle turns into -Dmcptoolkit.port, first in
  BridgeServer's precedence and so above the target gameDir's config/mcptoolkit.properties) AND
  what this script stops, polls and reports. One number by construction, so the four-minute
  "bridge never came up" that is really "the bridge came up somewhere else" cannot happen -
  which is exactly how -Target server used to fail against a perfectly healthy server on 25610.
  A caller whose own port is fixed and unrenegotiable - an MCP session, whose bridge URL is frozen
  for its whole life - passes it here; launch_game does precisely that.

.PARAMETER Takeover
  Kill the rebuild supervisor that already holds -Port's cycle lock and claim it. Without this, a
  second cycle on one port exits 3 rather than force-killing the first one's game. Use `-Takeover`
  when you mean "abandon that cycle and start over"; use tools/dev-procs.ps1 to see who holds it.

.PARAMETER FabricApi
  Launch the game with fabric-api on its RUNTIME classpath (`-Pfabricapi=true`, build.gradle's
  `localRuntime` block). THE OTHER ARM. This project ships and runs loader-only by construction,
  which is what keeps the loader-only claim honest and is also why nothing in this repo ever booted
  the toolkit the way its consumers boot it. 0.80.0 is the precedent for what that hides: the
  toolkit ran fine without fabric-api and had silently stopped running WITH it. The flag rides the
  LAUNCH and not the build, because fabric-api is `localRuntime` and never reaches the jar - the
  artifact is byte-identical on both arms, so a battery on this arm answers the runtime and only the
  runtime.

.EXAMPLE
  ./tools/rebuild.ps1
.EXAMPLE
  ./tools/rebuild.ps1 -Target server
.EXAMPLE
  ./tools/rebuild.ps1 -Project ..\menagerie -Port 25641   # a sibling checkout's game
.EXAMPLE
  ./tools/rebuild.ps1 -Takeover      # a previous cycle is stuck; kill its supervisor and restart
.EXAMPLE
  ./tools/rebuild.ps1 -FabricApi     # the compatibility arm: same jar, fabric-api on the runtime
.EXAMPLE
  ./tools/rebuild.ps1 -Ui 'mcptoolkit:example' -UiEdit   # boot into the authoring world, editing that screen
#>
[CmdletBinding()]
param(
    # NOTE: not -Host. $Host is an automatic PowerShell variable and a parameter of that name
    # shadows it.
    # A build-root DIRECTORY, or 'toolkit' for the one launchable root in this checkout.
    [string]$Project = 'toolkit',
    [ValidateSet('client', 'server')]
    [string]$Target = 'client',
    [int]$Port = 25599,
    [switch]$SkipBuild,
    [switch]$NoRelaunch,
    # Kill the rebuild supervisor that already owns -Port and take the cycle over. Without this a
    # second cycle on one port is REFUSED (exit 3) rather than allowed to shoot the first one's game.
    [switch]$Takeover,
    # Skip the production-instance guard. Only for deliberately replacing a normal (non-dev) game.
    [switch]$Force,
    # Put fabric-api on the RUNTIME classpath of the relaunched game (-Pfabricapi=true). The other
    # arm; see the parameter doc above. Launch only - it does not change the jar.
    [switch]$FabricApi,
    # Boot the relaunched CLIENT straight into the authoring world with this screen-authoring
    # document open - '<mod>:<screen>' or a path (SCREEN_AUTHORING_DESIGN.md 23). Client only.
    [string]$Ui,
    # With -Ui: open it in the in-game editor rather than as a read-only preview.
    [switch]$UiEdit
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

# -Project is a DIRECTORY with one shorthand, not an enum. Resolve it here, and REFUSE anything
# that is not a Gradle root with a wrapper - a bad path must not reach step 1, whose first act is to
# kill the game on -Port. Failing before the stop is the difference between "nothing happened" and
# "your world closed and nothing was rebuilt".
switch ($Project) {
    'toolkit'     { $projectDir = Join-Path $repo 'mcp-toolkit' }
    default       { $projectDir = $Project }
}
$projectDir = try { (Resolve-Path -LiteralPath $projectDir -ErrorAction Stop).Path } catch { $null }
if (-not $projectDir) {
    Write-Error "[rebuild] -Project '$Project' is neither 'toolkit' nor an existing directory." -ErrorAction Continue
    exit 4
}
# A screen is a client's. Refused here rather than at the launch, because everything between the
# two lines KILLS THE RUNNING GAME: an argument error must cost a second, not somebody's world.
if ($Ui -and $Target -eq 'server') {
    Write-Error "[rebuild] -Ui needs -Target client: a dedicated server has no screens to open." -ErrorAction Continue
    exit 2
}

$gradlew = Join-Path $projectDir 'gradlew.bat'
if (-not (Test-Path -LiteralPath $gradlew)) {
    Write-Error "[rebuild] -Project '$Project' resolved to $projectDir, which has no gradlew.bat - not a build root." -ErrorAction Continue
    exit 4
}
# Reported and written into the lock file, so dev-procs.ps1 names a project a human recognises
# rather than an absolute path that may be somebody else's checkout.
$projectName = Split-Path $projectDir -Leaf
$bridge = "http://127.0.0.1:$Port/cmd"

function Invoke-Bridge([string]$tool, [int]$timeoutSec = 5, [hashtable]$toolArgs = @{}) {
    $body = @{ tool = $tool; args = $toolArgs } | ConvertTo-Json -Compress
    # -DisableKeepAlive: a reused socket whose server dies mid-connection (exactly what quit_game
    # causes) can hang Invoke-RestMethod past its TimeoutSec in PowerShell 5.1.
    return Invoke-RestMethod -Uri $bridge -Method Post -Body $body -ContentType 'application/json' `
        -TimeoutSec $timeoutSec -DisableKeepAlive
}

function Test-Bridge() {
    try { $r = Invoke-Bridge 'ping' 3; return [bool]$r.ok } catch { return $false }
}

# BridgeServer answers `ping` before the world finishes loading, so "the bridge is up" is NOT the
# same as "tools will work": on a dedicated server every probe in that window fails with
# "no server running - load a world first" (cost a full player-body run 2026-08-06). For -Target
# server the honest readiness gate is serverRunning; a client legitimately sits at the title screen
# with no world, so it keeps the weaker gate.
function Test-Ready() {
    try {
        $r = Invoke-Bridge 'ping' 3
        if (-not $r.ok) { return $false }
        if ($Target -eq 'server') { return [bool]$r.result.serverRunning }
        return $true
    } catch { return $false }
}

function Get-PortPid() {
    try {
        return (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -First 1 -ExpandProperty OwningProcess)
    } catch { return $null }
}

# --- 0. one cycle per port -----------------------------------------------------
# THIS SCRIPT'S FIRST ACT IS TO KILL WHATEVER HOLDS THE PORT, so two of them running at once is not
# a race to lose a build to - it is one of them shooting the other's game. That is exactly what it
# looked like from the outside: a world closing itself mid-session, filed for an hour as a render
# bug, when the cause was a supervisor left over from an earlier launch arriving at step 1.
#
# Nothing prevented it. launch_game spawns a FRESH PowerShell per call; every Claude Code session
# in this checkout gets its own MCP server; and all of them push the same basePort() down here. So
# the port gets a lock, and the lock belongs to the PORT rather than to any one caller - which is
# the only scope that can see a rival in a different session's process tree.
#
# The lock is a FILE HANDLE, not a pid written to a file: the OS drops it when the holder dies, so
# a crashed or force-killed supervisor leaves nothing stale behind and there is no liveness check
# to get wrong. It is opened FileShare::Read, so a rival's write-open fails while a human - or
# tools/dev-procs.ps1 - can still read who is in there.
$lockPath = Join-Path ([System.IO.Path]::GetTempPath()) "mcptk-rebuild-$Port.lock"
$script:lockHandle = $null

function Read-LockHolder() {
    try {
        $fs = [System.IO.File]::Open($lockPath, 'Open', 'Read', 'ReadWrite')
        try {
            $buf = New-Object byte[] 512
            $n = $fs.Read($buf, 0, $buf.Length)
            return [System.Text.Encoding]::UTF8.GetString($buf, 0, $n).Trim()
        } finally { $fs.Dispose() }
    } catch { return '(holder recorded nothing readable)' }
}

function Enter-PortLock() {
    try {
        $script:lockHandle = [System.IO.File]::Open($lockPath, 'Create', 'Write', 'Read')
    } catch { return $false }
    $stamp = (Get-Date).ToString('o')
    $line = "pid=$PID project=$projectName dir=$projectDir target=$Target port=$Port started=$stamp"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
    $script:lockHandle.Write($bytes, 0, $bytes.Length)
    $script:lockHandle.Flush()
    return $true
}

if (-not (Enter-PortLock)) {
    $holder = Read-LockHolder
    if (-not $Takeover) {
        Write-Error ("[rebuild] another rebuild cycle already owns port $Port - refusing to start a " +
            "second one, because step 1 of this script force-kills whatever holds that port and " +
            "that would be the first cycle's game. Holder: $holder. Lock file: $lockPath. " +
            "Either wait for it (poll the bridge on $Port), or re-run with -Takeover to kill the " +
            "holder and claim the cycle.") -ErrorAction Continue
        exit 3
    }
    $holderPid = 0
    if ($holder -match 'pid=(\d+)') { $holderPid = [int]$Matches[1] }
    # Verify before killing: pids are recycled, and the number in a lock file is only as fresh as
    # the last process that wrote it. Kill a supervisor, never whatever inherited its number.
    $holderProc = $null
    if ($holderPid -gt 0) {
        $holderProc = Get-CimInstance Win32_Process -Filter "ProcessId=$holderPid" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*rebuild.ps1*' }
    }
    if ($holderProc) {
        Write-Host "[rebuild] -Takeover: killing rebuild supervisor PID $holderPid ($holder)."
        # The SUPERVISOR ONLY, never its process tree. Past step 3 the game is that supervisor's
        # CHILD, so a /T kill would take the world down with the script that was waiting on it -
        # the very failure this whole section exists to stop.
        Stop-Process -Id $holderPid -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "[rebuild] -Takeover: lock is held but no rebuild.ps1 answers to PID $holderPid ($holder)."
    }
    $lockDeadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $lockDeadline -and -not (Enter-PortLock)) { Start-Sleep -Milliseconds 500 }
    if (-not $script:lockHandle) {
        Write-Error "[rebuild] -Takeover could not free $lockPath - the holder is still alive. Aborting." -ErrorAction Continue
        exit 3
    }
}
Write-Host "[rebuild] holding the port-$Port cycle lock (pid $PID)."

# --- 1. stop the running game --------------------------------------------------
if (Test-Bridge) {
    # Guard: never silently kill a normal (production) game. A production install on this port is
    # someone's real session, not the dev instance this script exists to cycle.
    $pingResult = $null
    try { $pingResult = (Invoke-Bridge 'ping' 3).result } catch {
        # Ping shape predates the env field, or transient failure - treat as dev and proceed.
    }
    if ($pingResult -and $pingResult.env -and $pingResult.env -ne 'development' -and -not $Force) {
        Write-Error ("[rebuild] the game on port $Port is a PRODUCTION instance " +
            "(env=$($pingResult.env), gameDir=$($pingResult.gameDir)) - refusing to stop it. " +
            "Use -Force only if you really mean to replace it with a dev instance.") -ErrorAction Continue
        exit 2
    }
    Write-Host "[rebuild] bridge is up; asking the game to quit gracefully..."
    # quit_game exists only on a client; a dedicated server answers ok:false ("unknown tool") over
    # HTTP 200, which does NOT throw — check `ok` explicitly and fall back to the `stop` command
    # (clean save + exit; BridgeServer's SERVER_STOPPED hook releases the port). Only wait for the
    # port when a graceful request was actually accepted; otherwise go straight to force-kill.
    $graceful = $false
    try { $graceful = [bool](Invoke-Bridge 'quit_game' 5).ok } catch {}
    if (-not $graceful) {
        try { $graceful = [bool](Invoke-Bridge 'run_command' 10 @{ command = 'stop' }).ok } catch {}
    }
    if (-not $graceful) {
        Write-Host "[rebuild] no graceful stop available (quit_game and run_command both refused); will force-stop."
    }

    $deadline = (Get-Date).AddSeconds($(if ($graceful) { 25 } else { 0 }))
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 750
        if (-not (Get-PortPid)) { break }
    }
    $procId = Get-PortPid
    if ($procId) {
        Write-Host "[rebuild] port still held by PID $procId; force-killing."
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    Write-Host "[rebuild] game stopped."
} else {
    $procId = Get-PortPid
    if ($procId) {
        Write-Host "[rebuild] bridge unresponsive but port held by PID $procId; force-killing."
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } else {
        Write-Host "[rebuild] no running game detected."
    }
}

# --- 2. build ------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host "[rebuild] building $projectName ($projectDir, gradlew build)..."
    # --project-dir, not just the wrapper's path: gradlew.bat locates the DISTRIBUTION relative to
    # itself but Gradle takes the PROJECT from the working directory, so running this script from the
    # workspace root built villagejobs and said BUILD SUCCESSFUL while -Project said toolkit. The only
    # visible symptom was `:compileJava UP-TO-DATE` on a tree that had just changed.
    & $gradlew '--project-dir' $projectDir 'build' '-x' 'test'
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[rebuild] build FAILED (exit $LASTEXITCODE) — not relaunching." -ErrorAction Continue
        exit $LASTEXITCODE
    }
    Write-Host "[rebuild] build OK."
}

# --- 3. relaunch ---------------------------------------------------------------
if ($NoRelaunch) {
    Write-Host "[rebuild] -NoRelaunch set; done."
    exit 0
}

$task = if ($Target -eq 'server') { ':runServer' } else { ':runClient' }
Write-Host "[rebuild] launching $projectName $task (detached)..."
# -Pport is what makes step 4's poll and step 1's stop name the SAME game. It is a PUSH: the game
# has not booted yet and will bind whatever it is told, while the caller's port may be frozen, so
# the caller dictates. The target gameDir's config file therefore cannot redirect a run we
# launched - it still governs a hand-run `gradlew :runServer`, which is why run-server keeps its
# own port: that is how a hand-started server avoids fighting a hand-started client.
# -Ui rides the same push as -Pport: the game has not booted, so the caller says what it opens.
$gradleArgs = @($task, "-Pport=$Port")
# The arm is ANNOUNCED, not inferred. A battery log gets read months later to answer "which world
# was this run on", and the launch line is the only place that can say so before a game exists.
if ($FabricApi) {
    $gradleArgs += '-Pfabricapi=true'
    Write-Host "[rebuild] fabric-api arm: fabric-api goes on the game's runtime classpath (the jar is unchanged)."
} else {
    Write-Host "[rebuild] loader-only arm (no fabric-api). Pass -FabricApi for the compatibility arm."
}
if ($Ui) {
    $gradleArgs += "-PuiDoc=$Ui"
    if ($UiEdit) { $gradleArgs += '-PuiEdit' }
    Write-Host "[rebuild] the client will open $Ui in the authoring world$(if ($UiEdit) { ' (editor)' })."
}
$launchedAt = Get-Date
Start-Process -FilePath $gradlew -ArgumentList $gradleArgs -WorkingDirectory $projectDir -WindowStyle Minimized | Out-Null

# --- 4. wait for the bridge ----------------------------------------------------
Write-Host "[rebuild] waiting for the bridge on port $Port (up to ~4 min)..."
$deadline = (Get-Date).AddMinutes(4)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (Test-Ready) {
        Write-Host "[rebuild] bridge is up. Tools are live."
        if ($Target -eq 'client') {
            # The Gradle window above is started MINIMIZED and the game window it spawns inherits
            # that (SW_SHOWMINIMIZED rides STARTUPINFO into LWJGL's first window). Until toolkit
            # 0.134.0 `render` refused an iconic window, which is how the 0.124.0 battery lost
            # render-camera 0/16 and render-studio 2 cases to one (2026-09-06); measured 2026-09-07,
            # an iconic client renders fine and the refusal was the whole loss (CHANGELOG.md
            # 0.134.0). Restore it here anyway, once, the moment the bridge answers: a game nobody
            # can see is a surprise for the human, not a problem for the tools.
            Add-Type -Namespace McpTk -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
'@ -ErrorAction SilentlyContinue
            $deadlineWin = (Get-Date).AddSeconds(30)
            $restored = $false
            while ((Get-Date) -lt $deadlineWin -and -not $restored) {
                $game = Get-Process java -ErrorAction SilentlyContinue |
                    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like 'Minecraft*' }
                foreach ($g in $game) {
                    if ([McpTk.Win32]::IsIconic($g.MainWindowHandle)) {
                        [McpTk.Win32]::ShowWindowAsync($g.MainWindowHandle, 9) | Out-Null  # SW_RESTORE
                        Write-Host "[rebuild] restored the minimized game window (pid $($g.Id)) so the client renders."
                    }
                    $restored = $true
                }
                if (-not $restored) { Start-Sleep -Seconds 2 }
            }
            if (-not $restored) { Write-Host "[rebuild] note: no 'Minecraft*' window found to restore; if it is minimized, render will refuse until it is not." }
            Write-Host "[rebuild] note: client is at the title screen — drive into a world for SERVER-context tools."
        }
        exit 0
    }
}
# --- the failed boot (RELEASE_1.md section J3) ----------------------------------
# The higher-value crash is the one that never reaches the bridge: a bad mixin, a missing
# dependency, a registry that throws at init. Nothing in-process can report it, and until 0.126.0
# this exit said only "timed out". So say what the dead game left behind: the newest crash report
# written SINCE THIS LAUNCH (an older one is somebody else's story) and the tail of latest.log,
# which is where the loader's own phase - mod resolution, mixin apply - lands before any tool exists.
Write-Error "[rebuild] timed out waiting for the bridge. Check the game window / Gradle output." -ErrorAction Continue
$runDirs = Get-ChildItem -LiteralPath $projectDir -Directory -Filter 'run*' -ErrorAction SilentlyContinue
foreach ($rd in $runDirs) {
    $reportDir = Join-Path $rd.FullName 'crash-reports'
    if (Test-Path -LiteralPath $reportDir) {
        $report = Get-ChildItem -LiteralPath $reportDir -Filter 'crash-*.txt' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $launchedAt } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($report) {
            Write-Host "[rebuild] the game wrote a crash report during this launch: $($report.FullName)"
            Get-Content -LiteralPath $report.FullName -TotalCount 14 | ForEach-Object { Write-Host "    $_" }
            Write-Host "[rebuild] the whole report is in that file; once a game is up, get_log {crash: `"latest`"} summarises and attributes it."
        }
    }
    $latest = Join-Path $rd.FullName 'logs\latest.log'
    if ((Test-Path -LiteralPath $latest) -and ((Get-Item -LiteralPath $latest).LastWriteTime -gt $launchedAt)) {
        Write-Host "[rebuild] tail of $latest (the loader's phase lives here, before any tool exists):"
        Get-Content -LiteralPath $latest -Tail 40 | ForEach-Object { Write-Host "    $_" }
    }
}
exit 1
