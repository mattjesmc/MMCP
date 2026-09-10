<#
.SYNOPSIS
  Show - and optionally reap - every process this workspace leaves running: rebuild supervisors,
  Gradle daemons, dev Minecraft JVMs, and the port locks that say who owns which cycle.

.DESCRIPTION
  THE PROBLEM THIS ANSWERS IS THAT NONE OF THESE PROCESSES HAS AN OWNER WHO WILL REPORT THEM.
  A rebuild supervisor is spawned by an MCP server that may already have exited; a Gradle daemon is
  designed to outlive the build that started it; a dev client is deliberately detached so it can
  outlive the script that launched it. Each of those is correct on its own and the sum is a machine
  carrying a gigabyte of processes nobody remembers starting - and, before the port lock existed, a
  leftover supervisor that would eventually reach `Stop-Process` on a port somebody was playing on.

  Read-only by default. Nothing here kills anything unless you ask.

  EVERYTHING THAT KILLS HERE IS SCOPED TO THIS WORKSPACE, and that is not a detail. The first draft
  matched dev JVMs on `net.fabricmc` appearing anywhere in a command line, and the first machine it
  ran on had a rocketeer server up from a different checkout in another session - so -Games would
  have killed a project this script has no business touching. A JVM is ours only if its command
  line names THIS repo; anything else is listed as a foreign workspace and never stopped.

.PARAMETER Reap
  Kill ORPHANED rebuild supervisors: a rebuild.ps1 holding no cycle lock, which is what a leftover
  from a crashed or exited caller looks like, since a live cycle always holds its port's lock.
  Does not touch Gradle daemons (see -StopDaemons) or games (see -Games).

.PARAMETER StopDaemons
  Ask Gradle to stop its daemons gracefully. SEPARATE FROM -Reap ON PURPOSE: `gradlew --stop` is
  not scoped to a project, it stops every daemon of that Gradle version for this user - and a
  daemon is frequently the PARENT of a running game (a runClient/runServer task is its child), so
  the blast radius reaches other checkouts. Refused while any daemon is hosting a game, unless
  -Force.

.PARAMETER Games
  Stop THIS WORKSPACE's dev Minecraft JVMs. Each is pinged first and a non-development instance is
  refused by name unless -Force, the same guard rebuild.ps1 carries. JVMs belonging to another
  checkout are reported and always skipped, -Force included.

.PARAMETER Force
  Skip the production-instance guard, stop daemons even when one is hosting a game, and hard-kill
  daemons that ignored the graceful stop. Never widens scope beyond this workspace.

.PARAMETER DryRun
  Print every kill this run WOULD perform and perform none of them. The guards still evaluate, so
  this is how you check a refusal is going to fire before trusting it on a machine with other
  people's games up - which is the machine this was written on.

.EXAMPLE
  ./tools/dev-procs.ps1
.EXAMPLE
  ./tools/dev-procs.ps1 -Reap
.EXAMPLE
  ./tools/dev-procs.ps1 -Reap -Games -StopDaemons
#>
[CmdletBinding()]
param(
    [switch]$Reap,
    [switch]$StopDaemons,
    [switch]$Games,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$tempDir = [System.IO.Path]::GetTempPath()
$now = Get-Date

function Write-Section([string]$title) {
    Write-Host ''
    Write-Host "== $title " -ForegroundColor Cyan -NoNewline
    Write-Host ('=' * [Math]::Max(4, 68 - $title.Length)) -ForegroundColor DarkCyan
}

function Get-Age([datetime]$since) {
    $span = $now - $since
    if ($span.TotalHours -ge 1) { return '{0:n1}h' -f $span.TotalHours }
    if ($span.TotalMinutes -ge 1) { return '{0:n0}m' -f $span.TotalMinutes }
    return '{0:n0}s' -f $span.TotalSeconds
}

# Every kill in this script goes through here, so -DryRun cannot be forgotten at one call site.
function Invoke-Kill([int]$procId, [string]$why) {
    if ($DryRun) {
        Write-Host ('  [dry-run] would kill pid={0} ({1})' -f $procId, $why) -ForegroundColor DarkYellow
        return
    }
    Write-Host ('  killing pid={0} ({1})' -f $procId, $why)
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}

function Test-Alive([int]$procId) {
    if ($procId -le 0) { return $false }
    return $null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

function Invoke-Ping([int]$port) {
    try {
        $body = '{"tool":"ping","args":{}}'
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/cmd" -Method Post -Body $body `
            -ContentType 'application/json' -TimeoutSec 3 -DisableKeepAlive
        if ($r.ok) { return $r.result }
    } catch { }
    return $null
}

# A lock file is HELD if opening it for WRITE fails - the same test the holder's own acquire does,
# run from the other side. No pid liveness check is needed or wanted: the OS already dropped the
# handle if the holder died, so "held" cannot go stale.
function Test-LockHeld([string]$path) {
    try {
        $fs = [System.IO.File]::Open($path, 'Open', 'Write', 'Read')
        $fs.Dispose()
        return $false
    } catch { return $true }
}

function Read-LockLine([string]$path) {
    try {
        $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
        try {
            $buf = New-Object byte[] 512
            $n = $fs.Read($buf, 0, $buf.Length)
            return [System.Text.Encoding]::UTF8.GetString($buf, 0, $n).Trim()
        } finally { $fs.Dispose() }
    } catch { return '' }
}

$allProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue

# --- cycle locks ---------------------------------------------------------------
# Read FIRST: the set of pids named by HELD locks is what separates a live cycle from a leftover,
# and the supervisor section below needs it.
Write-Section 'CYCLE LOCKS (tools/rebuild.ps1, one per port)'
$lockedPids = @{}
$locks = @(Get-ChildItem $tempDir -Filter 'mcptk-rebuild-*.lock' -ErrorAction SilentlyContinue)
if (-not $locks) {
    Write-Host '  (none - no rebuild cycle has run since temp was last cleared)'
}
foreach ($lock in $locks) {
    $held = Test-LockHeld $lock.FullName
    $line = Read-LockLine $lock.FullName
    if ($held) {
        if ($line -match 'pid=(\d+)') { $lockedPids[[int]$Matches[1]] = $true }
        Write-Host ('  HELD  {0}  {1}' -f $lock.Name, $line) -ForegroundColor Yellow
    } else {
        Write-Host ('  free  {0}  (last holder: {1})' -f $lock.Name, $line) -ForegroundColor DarkGray
    }
}

# --- bridge ports --------------------------------------------------------------
Write-Section 'BRIDGE PORTS'
$listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -ge 25500 -and $_.LocalPort -le 25700 } |
    Sort-Object LocalPort -Unique)
if (-not $listening) { Write-Host '  (nothing listening in 25500-25700 - no bridge is up)' }
$bridgeByPid = @{}
foreach ($conn in $listening) {
    $result = Invoke-Ping $conn.LocalPort
    $bridgeByPid[[int]$conn.OwningProcess] = $result
    if ($result) {
        $envName = if ($result.env) { $result.env } else { 'unknown' }
        $colour = if ($envName -eq 'development') { 'Green' } else { 'Red' }
        Write-Host ('  {0}  pid={1}  env={2}  serverRunning={3}  {4}' -f `
            $conn.LocalPort, $conn.OwningProcess, $envName, $result.serverRunning, $result.gameDir) `
            -ForegroundColor $colour
    } else {
        Write-Host ('  {0}  pid={1}  (listening, but the bridge did not answer ping)' -f `
            $conn.LocalPort, $conn.OwningProcess) -ForegroundColor DarkYellow
    }
}

# --- rebuild supervisors -------------------------------------------------------
Write-Section 'REBUILD SUPERVISORS (powershell running rebuild.ps1)'
$supervisors = @($allProcs | Where-Object {
    $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -like '*rebuild.ps1*' -and
    $_.ProcessId -ne $PID
})
if (-not $supervisors) { Write-Host '  (none)' }
$orphanSupervisors = @()
foreach ($proc in $supervisors) {
    $age = Get-Age $proc.CreationDate
    $owns = $lockedPids.ContainsKey([int]$proc.ProcessId)
    # A cycle that owns a lock is the one legitimately running. One that owns none is a leftover:
    # either it predates the lock, or its caller died in the gap before acquire. The 60s floor keeps
    # a just-spawned supervisor from being reaped inside that gap.
    $young = ($now - $proc.CreationDate).TotalSeconds -lt 60
    if ($owns) {
        Write-Host ('  pid={0}  age={1}  OWNS ITS PORT LOCK - live cycle' -f $proc.ProcessId, $age) -ForegroundColor Green
    } elseif ($young) {
        Write-Host ('  pid={0}  age={1}  starting up (no lock yet)' -f $proc.ProcessId, $age) -ForegroundColor DarkGray
    } else {
        Write-Host ('  pid={0}  age={1}  ORPHAN - holds no cycle lock' -f $proc.ProcessId, $age) -ForegroundColor Red
        $orphanSupervisors += $proc
    }
    $parentAlive = Test-Alive ([int]$proc.ParentProcessId)
    Write-Host ('          parent={0} {1}' -f $proc.ParentProcessId,
        $(if ($parentAlive) { '(alive)' } else { '(GONE)' })) -ForegroundColor DarkGray
}

# --- dev game JVMs -------------------------------------------------------------
# Classified BEFORE the daemon section, which needs to know whether a daemon is hosting one.
# "Ours" is decided by the repo path appearing in the command line and by nothing else: a Loom
# launch names its own checkout (loom-cache, argFiles, gameDir) many times over, so the test is
# reliable, and every looser test - the loader package, the Minecraft package - matches every
# Fabric dev launch on the machine including other people's projects.
function Get-Workspace([string]$commandLine) {
    if (-not $commandLine) { return $null }
    if ($commandLine -like "*$repo*") { return $repo }
    if ($commandLine -match '([A-Za-z]:\\[^"\s]*?)\\(?:\.gradle|build|run)\\') { return $Matches[1] }
    return 'unknown checkout'
}

Write-Section 'DEV MINECRAFT JVMs'
$allGameProcs = @($allProcs | Where-Object {
    $_.Name -match '^javaw?\.exe$' -and $_.CommandLine -notlike '*GradleDaemon*' -and
    ($_.CommandLine -like '*fabric.dli*' -or $_.CommandLine -like '*mcptoolkit.port*' -or
     $_.CommandLine -like '*knot.Knot*' -or $_.CommandLine -like '*net.minecraft*' -or
     $_.CommandLine -like '*neoforged*')
})
$gameProcs = @()     # ours - the only ones -Games will stop
$foreignGames = @()
foreach ($proc in $allGameProcs) {
    $ws = Get-Workspace $proc.CommandLine
    $ping = $bridgeByPid[[int]$proc.ProcessId]
    $envText = if ($ping) { "bridge env=$($ping.env)" } else { 'no bridge answers on this pid' }
    if ($ws -eq $repo) {
        $gameProcs += $proc
        Write-Host ('  pid={0}  age={1}  rss={2}MB  THIS workspace  {3}' -f `
            $proc.ProcessId, (Get-Age $proc.CreationDate), [int]($proc.WorkingSetSize / 1MB), $envText)
    } else {
        $foreignGames += $proc
        Write-Host ('  pid={0}  age={1}  rss={2}MB  OTHER workspace ({3}) - never touched here' -f `
            $proc.ProcessId, (Get-Age $proc.CreationDate), [int]($proc.WorkingSetSize / 1MB), $ws) -ForegroundColor DarkGray
    }
}
if (-not $allGameProcs) { Write-Host '  (none)' }

# --- gradle daemons ------------------------------------------------------------
Write-Section 'GRADLE DAEMONS'
$daemons = @($allProcs | Where-Object { $_.Name -match '^javaw?\.exe$' -and $_.CommandLine -like '*GradleDaemon*' })
if (-not $daemons) { Write-Host '  (none)' }
$hostingDaemons = @()
foreach ($proc in $daemons) {
    $parentAlive = Test-Alive ([int]$proc.ParentProcessId)
    # A daemon running a runClient/runServer task is the GAME'S PARENT. Stopping it is not a
    # memory reclaim, it is closing somebody's world - possibly in another checkout entirely.
    $hosted = @($allGameProcs | Where-Object { [int]$_.ParentProcessId -eq [int]$proc.ProcessId })
    if ($hosted) { $hostingDaemons += $proc }
    $line = '  pid={0}  age={1}  rss={2}MB  parent={3} {4}' -f `
        $proc.ProcessId, (Get-Age $proc.CreationDate), [int]($proc.WorkingSetSize / 1MB),
        $proc.ParentProcessId, $(if ($parentAlive) { '(alive)' } else { '(GONE)' })
    if ($hosted) {
        Write-Host ($line + ('  HOSTING GAME pid={0}' -f ($hosted[0].ProcessId))) -ForegroundColor Yellow
    } else {
        Write-Host $line
    }
}
if ($daemons) {
    $totalMb = [int](($daemons | Measure-Object WorkingSetSize -Sum).Sum / 1MB)
    Write-Host ('  -> {0} daemon(s), {1}MB resident. A daemon outliving its build is NORMAL - that is' -f `
        $daemons.Count, $totalMb) -ForegroundColor DarkGray
    Write-Host '     what a daemon is for. It is only waste once you are done. -StopDaemons stops them,' -ForegroundColor DarkGray
    Write-Host '     user-wide (not per project), which is why it is a separate flag from -Reap.' -ForegroundColor DarkGray
}

# --- reap ----------------------------------------------------------------------
if (-not $Reap -and -not $Games -and -not $StopDaemons) {
    Write-Host ''
    Write-Host 'Read-only. -Reap clears orphan rebuild supervisors; -Games stops THIS workspace''s dev' -ForegroundColor DarkGray
    Write-Host 'Minecraft instances; -StopDaemons stops Gradle daemons (user-wide, so it is separate).' -ForegroundColor DarkGray
    exit 0
}

if ($Reap) {
    Write-Section 'REAP ORPHAN SUPERVISORS'
    foreach ($proc in $orphanSupervisors) {
        # The supervisor ONLY, never its process tree: past step 3 the game it launched is its
        # CHILD, so a /T kill would close the world - the exact failure the port lock exists to stop.
        Invoke-Kill ([int]$proc.ProcessId) 'orphan rebuild supervisor'
    }
    if (-not $orphanSupervisors) { Write-Host '  no orphan supervisors' }
}

if ($Games) {
    Write-Section 'STOP GAMES (this workspace only)'
    if ($foreignGames) {
        Write-Host ('  skipping {0} JVM(s) from other checkouts - not this script''s to stop' -f $foreignGames.Count) -ForegroundColor DarkGray
    }
    if (-not $gameProcs) { Write-Host '  no dev Minecraft JVMs belonging to this workspace' }
    foreach ($proc in $gameProcs) {
        $ping = $bridgeByPid[[int]$proc.ProcessId]
        if ($ping -and $ping.env -and $ping.env -ne 'development' -and -not $Force) {
            Write-Host ('  REFUSING pid={0}: env={1} gameDir={2} is a PRODUCTION instance. -Force to override.' -f `
                $proc.ProcessId, $ping.env, $ping.gameDir) -ForegroundColor Red
            continue
        }
        Invoke-Kill ([int]$proc.ProcessId) 'dev Minecraft JVM in this workspace'
    }
}

if ($StopDaemons) {
    Write-Section 'STOP GRADLE DAEMONS (user-wide)'
    # Re-read: -Games above may have just orphaned a daemon that was hosting one of our games,
    # which makes it stoppable when it was not a moment ago.
    $stillHosting = @()
    foreach ($proc in $hostingDaemons) {
        if (Test-Alive ([int]$proc.ProcessId)) {
            $hosted = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.ProcessId)" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^javaw?\.exe$' })
            if ($hosted) { $stillHosting += $proc }
        }
    }
    if ($stillHosting -and -not $Force) {
        foreach ($proc in $stillHosting) {
            Write-Host ('  REFUSING: daemon pid={0} is still hosting a running game as its child.' -f $proc.ProcessId) -ForegroundColor Red
        }
        Write-Host '  `gradlew --stop` is user-wide, so stopping now could close a world in another' -ForegroundColor Red
        Write-Host '  checkout. Stop that game first, or pass -Force.' -ForegroundColor Red
    } else {
        foreach ($root in @((Join-Path $repo 'mcp-toolkit'), $repo)) {
            $gradlew = Join-Path $root 'gradlew.bat'
            if (-not (Test-Path $gradlew)) { continue }
            if ($DryRun) { Write-Host "  [dry-run] would run gradlew --stop from $root" -ForegroundColor DarkYellow; continue }
            Write-Host "  gradlew --stop from $root"
            # Graceful: a BUSY daemon finishes its work and then exits, so this cannot corrupt a
            # compile that is mid-flight. --stop does not build, so it does not fight the jar lock
            # a running game holds (see the dev-loop-jar-lock rule).
            & $gradlew '--project-dir' $root '--stop' 2>&1 | ForEach-Object { Write-Host "    $_" }
        }
        if ($Force) {
            $left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^javaw?\.exe$' -and $_.CommandLine -like '*GradleDaemon*' })
            foreach ($proc in $left) {
                Invoke-Kill ([int]$proc.ProcessId) '-Force: daemon survived --stop'
            }
        }
    }
}

Write-Host ''
Write-Host 'Done. Re-run without flags to confirm what is left.' -ForegroundColor DarkGray
