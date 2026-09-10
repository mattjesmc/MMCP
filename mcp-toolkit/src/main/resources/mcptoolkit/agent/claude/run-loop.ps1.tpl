# Kit relauncher for Claude Code — machine-owned, rewritten by the Claude Code adapter on every
# launch. This file is the adapter's expression of Kit continuity RELAUNCH: the toolkit says "wake a
# fresh session in the same world whenever this one stops without being told to", and on this client
# that is a wrapper process plus a Stop hook.
# Edits here are lost; change the template in mcp-toolkit/src/main/resources/mcptoolkit/bootstrap/.
#
# WHY THIS EXISTS. The survival charter tells the player it is one continuous character and that a
# restart is a nap the harness handles. Until this script that was a bluff: the button started ONE
# `claude` process, and when it went idle — breaker release, crash, Ctrl-C — the mission was over
# until a human clicked again. The agent could smell it, which is half of why it kept writing
# handoff notes: it was the only actor who could carry anything across the gap.
#
# So the gap is the harness's job now. This wrapper owns the CLI process, watches three markers, and
# wakes a fresh context in the same world whenever the old one stops without being told to. Two
# effects that matter more than the plumbing:
#   * The circuit breaker stops being an escape hatch. Beating on the Stop hook used to end the
#     mission (sessions w1-85918, w2-59643, w3-59734 each burned all six blocks and were released);
#     now it just earns a nap, so there is nothing to win by negotiating.
#   * A recycle is BETTER than a compaction. A fresh context rebuilt from mem_recall beats a lossy,
#     report-shaped auto-summary — which was itself teaching the model to write reports.
#
# MCPTK_SESSION is deliberately NOT re-minted between wakes: attribution, chat routing and the
# world-model recorder's one-driver-per-server-lifetime rule all want the waking player to be the
# same player. A nap is not a new driver.

$ErrorActionPreference = 'Continue'

$claudeDir = Split-Path -Parent $PSCommandPath          # ...\survival\.claude
$workspace = Split-Path -Parent $claudeDir              # ...\survival
$charter   = '%%SYSTEM_PROMPT%%'          # the kit's SYSTEM_PROMPT file, resolved by the adapter
$stopOk    = Join-Path $claudeDir 'STOP_OK'
$recycle   = Join-Path $claudeDir 'RECYCLE'
$lastStop  = Join-Path $claudeDir 'LAST_STOP.json'
$bridge    = '%%BRIDGE_URL%%'

# Both prompts are single-quoted PowerShell strings: keep them free of apostrophes.
$firstPrompt = 'Begin playing now. Run your FIRST ACTIONS, then stay in the living loop and work your objective. Do not ask for gear, permission, or instructions - act, and say what happened.'
$wakePrompt  = 'You just woke from a nap in the same world - nothing was lost and nothing was handed over. Call mem_recall to remember where you were and bot_status to feel your body (if you have none, run FIRST ACTIONS again). Then continue the arc from your mem_task. Do not greet, recap, summarize, or report - take a world action and say what happened.'

# The kit's denylist, written in by the adapter. Kept in this file rather than on the launcher
# command line: a file is a file, so it never has to survive the cmd -> start -> powershell quoting
# gauntlet the old inline launch did.
$denied = '%%DENIED_TOOLS%%'

$MaxWakesPerHour = 6
$PollSeconds = 3

function Test-World {
    try {
        $r = Invoke-RestMethod -Uri "$bridge/cmd" -Method Post -ContentType 'application/json' `
            -Body '{"tool":"ping","args":{}}' -TimeoutSec 5
        if ($r.ok -eq $true -and $r.result.serverRunning -eq $true) { return $true }
        return $false
    } catch {
        return $false
    }
}

function Stop-Tree($proc) {
    if ($null -eq $proc) { return }
    if ($proc.HasExited) { return }
    # The CLI spawns node children (the MCP shim); killing only the parent leaves them holding the
    # bridge session open. /T takes the tree.
    try { & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null } catch {}
    try { $proc.WaitForExit(10000) | Out-Null } catch {}
}

function Clear-Markers {
    foreach ($m in @($stopOk, $recycle, $lastStop)) {
        if (Test-Path $m) { Remove-Item $m -Force -ErrorAction SilentlyContinue }
    }
}

$claudeExe = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claudeExe) { $claudeExe = 'claude' }

# PowerShell 5.1 does not quote -ArgumentList elements for you, and the prompt is one long argument
# full of spaces. Build the command line by hand.
function Quote-Arg($s) { '"' + ($s -replace '"', '\"') + '"' }

Clear-Markers
$wakeTimes = @()
$prompt = $firstPrompt
$wakeNumber = 0

while ($true) {

    $argv = @($prompt, '--system-prompt-file', $charter, '--disallowedTools', $denied)
    if ($env:MCPTK_CLAUDE_ARGS) {
        foreach ($extra in ($env:MCPTK_CLAUDE_ARGS -split "`n")) {
            if ($extra.Trim() -ne '') { $argv += $extra.Trim() }
        }
    }
    $argLine = ($argv | ForEach-Object { Quote-Arg $_ }) -join ' '

    if ($wakeNumber -gt 0) {
        Write-Host ''
        Write-Host "[survival] wake #$wakeNumber - same world, memory intact." -ForegroundColor DarkCyan
    }

    $proc = Start-Process -FilePath $claudeExe -ArgumentList $argLine -WorkingDirectory $workspace `
        -NoNewWindow -PassThru

    # Watch: the CLI does NOT exit when a Stop hook allows a stop - it idles waiting for input that
    # will never come. The markers are how we learn what happened; the process exiting is the
    # exceptional path (crash or Ctrl-C), not the normal one.
    $sawRecycle = $false
    $sawStop = $false
    $worldGone = $false
    $ticks = 0
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds $PollSeconds
        if (Test-Path $lastStop) { $sawStop = $true; break }
        if (Test-Path $recycle)  { $sawRecycle = $true; break }
        $ticks++
        if (($ticks % 20) -eq 0) {
            if (-not (Test-World)) { $worldGone = $true; break }
        }
    }

    if ($sawStop) {
        Stop-Tree $proc
        Write-Host ''
        Write-Host '[survival] the player ended its own session:' -ForegroundColor Yellow
        try { Get-Content $lastStop | Write-Host } catch {}
        Write-Host '[survival] not relaunching. Click the Survival button to play again.' -ForegroundColor Yellow
        break
    }

    if ($worldGone) {
        Stop-Tree $proc
        Write-Host '[survival] the game or world went away - stopping.' -ForegroundColor Yellow
        break
    }

    if ($sawRecycle) {
        Stop-Tree $proc
        Write-Host '[survival] recycling into a fresh context (breaker released).' -ForegroundColor DarkCyan
    } else {
        # Process exited on its own: crashed, or a human pressed Ctrl-C. Give the human a window to
        # stop the loop, then wake it again if the world is still there.
        if (-not (Test-World)) {
            Write-Host '[survival] CLI exited and the world is not running - stopping.' -ForegroundColor Yellow
            break
        }
        Write-Host ''
        Write-Host '[survival] CLI exited unexpectedly. Waking again in 10s - press Ctrl-C to stop.' -ForegroundColor Yellow
        Start-Sleep -Seconds 10
    }

    # Wrapper-level breaker: a genuinely broken setup (bad model config, MCP server that will not
    # start) fails within seconds every time, and without this it would fail forever.
    $cutoff = (Get-Date).AddHours(-1)
    $wakeTimes = @($wakeTimes | Where-Object { $_ -gt $cutoff })
    if ($wakeTimes.Count -ge $MaxWakesPerHour) {
        Write-Host "[survival] $($wakeTimes.Count) wakes in the last hour - something is wrong. Stopping." -ForegroundColor Red
        break
    }
    $wakeTimes += (Get-Date)

    Clear-Markers
    $wakeNumber++
    $prompt = $wakePrompt
}

Write-Host ''
Write-Host '[survival] run loop finished. This window can be closed.' -ForegroundColor DarkGray
