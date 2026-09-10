<#
.SYNOPSIS
  Probe for tools/rebuild.ps1's per-port cycle lock. Needs no game and no bridge.

.DESCRIPTION
  The lock exists because rebuild.ps1's first act is to force-kill whatever holds the bridge port,
  so a second supervisor on one port is not a race - it is one of them shooting the other's game.
  These cases pin that: the refusal and its EXIT CODE, that the lock is scoped PER PORT, that
  -Takeover kills the holder and claims the cycle, and that a dead holder leaves nothing stale.

  The exit code is asserted and not just the message, because that is what caught the older bug:
  $ErrorActionPreference = 'Stop' makes Write-Error terminating, so every guard in the script died
  before reaching its `exit` and PowerShell returned 1 no matter what the guard meant to say.

  Runs on spare ports 25698/25699 and uses -NoRelaunch -SkipBuild throughout, so it never starts
  Gradle and never boots a game.

  THE HOLDER IS A STAND-IN, and it has to be: a real rebuild.ps1 exits in about a second once the
  tree is built, so it cannot hold the lock long enough to be raced. The stand-in acquires with the
  SAME File::Open call the script uses, and is named *rebuild.ps1 so -Takeover's identity guard
  (which refuses to kill a pid that is not a supervisor) treats it as one.

  Exits with the number of failing cases.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/probes/rebuild-lock.test.ps1
#>
$ErrorActionPreference = 'Continue'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$rebuild = Join-Path $repo 'tools\rebuild.ps1'
$lock = Join-Path $env:TEMP 'mcptk-rebuild-25698.lock'
$script:pass = 0; $script:fail = 0

function Check([string]$name, [bool]$cond, [string]$detail) {
    if ($cond) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "FAIL  $name -- $detail" -ForegroundColor Red; $script:fail++ }
}

function Invoke-Rebuild([int]$port, [switch]$Takeover) {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$rebuild,'-Port',"$port",'-NoRelaunch','-SkipBuild')
    if ($Takeover) { $a += '-Takeover' }
    $out = & powershell.exe @a 2>&1 | Out-String
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}

# A stand-in holder: acquires the lock with the SAME Open call rebuild.ps1 uses, and carries the
# literal text rebuild.ps1 in its command line so -Takeover's identity guard treats it as a
# supervisor. The real script exits in 1s here (the tree is already built), so it cannot hold.
$holderFile = Join-Path $env:TEMP 'fake-rebuild.ps1'   # the name puts "rebuild.ps1" on its command line
@'
$l = Join-Path $env:TEMP "mcptk-rebuild-25698.lock"
$fs = [System.IO.File]::Open($l, "Create", "Write", "Read")
$s = "pid=$PID project=toolkit target=client port=25698 started=" + (Get-Date).ToString("o")
$b = [System.Text.Encoding]::UTF8.GetBytes($s)
$fs.Write($b, 0, $b.Length)
$fs.Flush()
Start-Sleep -Seconds 120
'@ | Set-Content -Path $holderFile -Encoding ascii
$holder = Start-Process powershell.exe `
    -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$holderFile -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
Check 'holder is alive and took the lock' `
    (($null -ne (Get-Process -Id $holder.Id -ErrorAction SilentlyContinue)) -and (Test-Path $lock)) `
    "pid $($holder.Id)"

# 1. same port -> refused, exit 3
$r = Invoke-Rebuild 25698
Check 'second cycle on the SAME port exits 3' ($r.Code -eq 3) "got exit $($r.Code)"
Check 'refusal names the holder pid' ($r.Out -match "pid=$($holder.Id)") 'holder pid absent from message'
Check 'refusal names the lock file' ($r.Out -match 'mcptk-rebuild-25698\.lock') 'lock path absent'
Check 'refusal mentions -Takeover' ($r.Out -match '-Takeover') 'no escape hatch offered'

# 2. the lock is PER PORT: a different port is untouched
$r2 = Invoke-Rebuild 25699
Check 'a DIFFERENT port is not blocked' ($r2.Code -eq 0) "got exit $($r2.Code): $($r2.Out)"

# 3. dev-procs sees the held lock and the owner
$doc = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'tools\dev-procs.ps1') 2>&1 | Out-String
Check 'dev-procs reports the lock HELD' ($doc -match 'HELD\s+mcptk-rebuild-25698\.lock') 'no HELD line'
Check 'dev-procs credits the owner, not an orphan' ($doc -match "pid=$($holder.Id)\s+age=\S+\s+OWNS ITS PORT LOCK") 'owner not credited'

# 4. -Takeover kills the holder and claims the cycle
$r3 = Invoke-Rebuild 25698 -Takeover
Check '-Takeover exits 0' ($r3.Code -eq 0) "got exit $($r3.Code): $($r3.Out)"
Check '-Takeover killed the holder' ($null -eq (Get-Process -Id $holder.Id -ErrorAction SilentlyContinue)) 'holder survived'
Check '-Takeover reported the kill' ($r3.Out -match "killing rebuild supervisor PID $($holder.Id)") 'no kill line'

# 5. a dead holder leaves NOTHING stale: the OS dropped the handle
try { $fs = [System.IO.File]::Open($lock, 'Open', 'Write', 'Read'); $fs.Dispose(); $free = $true } catch { $free = $false }
Check 'lock is free once every holder has exited' $free 'lock still held with no owner'
$r4 = Invoke-Rebuild 25698
Check 'a later cycle takes the freed lock with no cleanup' ($r4.Code -eq 0) "got exit $($r4.Code)"

Write-Host ''
Write-Host "$script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail) { 'Red' } else { 'Green' })
Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue
Remove-Item $lock, (Join-Path $env:TEMP 'mcptk-rebuild-25699.lock') -ErrorAction SilentlyContinue
exit $script:fail
