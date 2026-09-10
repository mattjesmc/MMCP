<#
.SYNOPSIS
  Resume a whole-battery run from its own logs: run only the probe files no log of this version has
  scored yet, into the next -partN log.

.DESCRIPTION
  A whole battery is two to three hours, and on 2026-09-06 three attempts in a row were killed
  from outside part-way through (RELEASE.md 2.6) - never by a probe, never by the game. Restarting
  from file one each time throws away hours of green. This script reads every
  mcp-server/sequential-<version>*.log, takes each `<name> => # pass N # fail M` line with N+M > 0
  as that file's verdict (a 0/0 line is a file whose node process died, not a verdict), and runs
  battery.ps1 -Only over what is left, into sequential-<version>-part<N>.log. When nothing is left
  it writes sequential-<version>.RESUME-DONE and exits 0, which is the marker an outer loop waits
  for:

    cmd /c "for /L %i in (1,1,30) do (if exist mcp-server\sequential-0.63.0.RESUME-DONE exit /b 0) ^
      & powershell -NoProfile -ExecutionPolicy Bypass -File tools\battery-resume.ps1 -Version 0.63.0 ^
      & timeout /t 30 /nobreak >nul"

  The logs together are the run; RELEASE.md cites them as a set. -Only is exact names, so a probe
  file added between parts is picked up by the next part, and one removed is simply absent.

.PARAMETER Version
  The shim version the logs are named by (mcp-server/package.json "version"). Default: read it.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [int]$Port = 25599
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$server = Join-Path $repo 'mcp-server'
if (-not $Version) {
    $Version = (Get-Content (Join-Path $server 'package.json') -Raw | ConvertFrom-Json).version
}

$logs = @(Get-ChildItem $server -Filter "sequential-$Version*.log" | Sort-Object Name)
$scored = @{}
$zero = @{}
foreach ($l in $logs) {
    foreach ($line in (Get-Content $l.FullName)) {
        if ($line -match '^([A-Za-z0-9_-]+) => # pass (\d+) # fail (\d+)') {
            if (([int]$Matches[2] + [int]$Matches[3]) -gt 0) { $scored[$Matches[1]] = $true }
            else { $zero[$Matches[1]] = 1 + [int]$zero[$Matches[1]] }
        }
    }
}
# A 0/0 line ONCE is a file whose node died; a 0/0 line TWICE is a file that skips itself (the gated
# create-world, or a client-only file on a server), and retrying it a third time would never end.
foreach ($k in @($zero.Keys)) { if ($zero[$k] -ge 2) { $scored[$k] = $true } }
$all = Get-ChildItem (Join-Path $server 'probes') -Filter '*.test.mjs' |
    ForEach-Object { $_.Name -replace '\.test\.mjs$', '' } | Sort-Object
$remaining = @($all | Where-Object { -not $scored.ContainsKey($_) })
Write-Host "[resume] $($logs.Count) log(s) for $Version score $($scored.Count) of $($all.Count) files; $($remaining.Count) remaining"
if ($remaining.Count -eq 0) {
    Set-Content -Path (Join-Path $server "sequential-$Version.RESUME-DONE") -Value (Get-Date -Format o)
    Write-Host "[resume] nothing left - marker written"
    exit 0
}
$part = $logs.Count + 1
$out = Join-Path $server "sequential-$Version-part$part.log"
Write-Host "[resume] part $part -> $out : $($remaining -join ', ')"
& (Join-Path $PSScriptRoot 'battery.ps1') -Port $Port -Only ($remaining -join ',') -Out $out
exit $LASTEXITCODE
