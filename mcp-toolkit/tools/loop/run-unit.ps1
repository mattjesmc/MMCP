<#
.SYNOPSIS
  One headless session per unit (LOOP_KIT_DESIGN.md §5.5): claude -p with an agent definition and a
  brief, stream-json to a log, the log analysed at the end, the project's loop checks run once more.

.DESCRIPTION
  ArmorPieces authored 91 parts this way - a fresh session per part, sequential, the brief in and
  its Lessons section out - and every cost number in LOOP_KIT_DESIGN.md §1 came off the jsonl this
  writes. The shape:

    tools\loop\run-unit.ps1 -Agent part-author -Brief docs\briefs\antennae.md [-Model claude-sonnet-5]
                            [-Cwd <workspace>] [-LogDir <dir>] [-MaxTurns 200]

  - The brief file's CONTENT is the prompt; the agent definition (.claude/agents/<Agent>.md in the
    workspace) carries the tool allowlist and the rules. See agent-template.md. Its `tools:` line
    is ALSO passed as --allowedTools: a headless session grants nothing by itself, and the first
    live run (2026-09-06) had every MCP call refused with "haven't granted it yet" while the
    frontmatter listed each one. The agent file is the allowlist, in both senses.
  - Runs with `--output-format stream-json --verbose`, which is what tools\loop\analyse.mjs reads.
    The child is started detached from this shell's job so a killed wrapper does not kill the
    session; the log is tailed with -Raw reads because base64 pictures make the file "binary" to
    line tools (grep -a if you look by hand).
  - API 5xx / overloaded lines pause the tail and print a notice rather than retrying blindly: the
    session's own retry handles the request, and a run that hammers a struggling API is how a
    whole evening's batch fails at once (the pause-on-api-errors lesson).
  - Before: `unit.start` in .mcptoolkit/loop.json (a command; `${unit}` = the brief's stem) runs
    once and its output leads the brief - the scaffold's file list for a block unit (unit-start.mjs).
  - Afterwards: analyse.mjs prints the cost table, and each `run` check in .mcptoolkit/loop.json is
    executed once with its output printed, so the unit's final state is judged by the same checker
    the session was judged by, outside the session.
  - MCPTK_UNIT = the brief's file stem is in the environment of the session (so of the shim, so of
    every check it runs) AND of that after-the-fact check. A well-behaved session closes its tab as
    its last act, so a checker addressed at "whatever is open" has nothing to check afterwards -
    ArmorPieces' falsifier ended on exactly that warning (LOOP_KIT_DESIGN.md section 11, finding 7).
    A run check that reads editor state should fall back to MCPTK_UNIT when nothing is open; name
    the brief file after the unit and the runner has told the checker which one.

.NOTES
  Sequential by construction: run the next unit after this returns. Two sessions on one editor race
  on its active tab, and the SECOND one's edits land in the FIRST one's unit.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Agent,
    [Parameter(Mandatory = $true)] [string] $Brief,
    [string] $Model = "",
    [string] $Cwd = (Get-Location).Path,
    [string] $LogDir = "",
    [int] $MaxTurns = 0,
    [string] $Claude = "claude",
    [switch] $NoAnalyse
)

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cwd = (Resolve-Path $Cwd).Path
$Brief = (Resolve-Path $Brief).Path
if (-not (Test-Path (Join-Path $Cwd ".claude\agents\$Agent.md"))) {
    Write-Warning "no .claude\agents\$Agent.md under $Cwd - claude will refuse the --agent; copy tools\loop\agent-template.md there first"
}
if (-not $LogDir) { $LogDir = Join-Path $Cwd ".mcptoolkit\runs" }
New-Item -ItemType Directory -Force $LogDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$unit = [IO.Path]::GetFileNameWithoutExtension($Brief)
# The unit's name, for every checker this run executes - inside the session (the shim inherits
# this environment and passes it to each `run`) and after it (below). See the header.
$env:MCPTK_UNIT = $unit
$log = Join-Path $LogDir "$Agent-$unit-$stamp.jsonl"
$err = Join-Path $LogDir "$Agent-$unit-$stamp.stderr.log"

$prompt = Get-Content -Raw -Encoding UTF8 $Brief
# unit.start (RELEASE_1.md section J5): a command the loop file runs BEFORE the session, whose
# output leads the brief - the scaffold's file list and four-call recipe, for a block loop. The
# command's failure is a warning, not a refusal: the commonest non-zero is a scaffold refusing to
# run twice on a unit being re-attempted, and that line is what the session should read first.
$startOut = & node (Join-Path $here "unit-start.mjs") $Cwd $unit 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Write-Warning "[run-unit] unit.start exited $LASTEXITCODE - the session starts anyway, with its output in the brief" }
if ($startOut.Trim()) {
    $prompt = $startOut.TrimEnd() + "`n`n" + $prompt
    Write-Host "[run-unit] unit.start: $($startOut.Trim().Split("`n")[0])  (+$($startOut.Length) chars into the brief)"
}
# Not $args: that is PowerShell's own automatic variable.
$claudeArgs = @("-p", "--agent", $Agent, "--output-format", "stream-json", "--verbose")
if ($Model) { $claudeArgs += @("--model", $Model) }
if ($MaxTurns -gt 0) { $claudeArgs += @("--max-turns", "$MaxTurns") }
# The agent's `tools:` line, granted. Without this every tool call comes back "Claude requested
# permissions to use X, but you haven't granted it yet" and the session burns its turns asking.
$agentFile = Join-Path $Cwd ".claude\agents\$Agent.md"
$allowed = @()
if (Test-Path $agentFile) {
    $m = [regex]::Match((Get-Content -Raw -Encoding UTF8 $agentFile), '(?m)^tools:\s*(.+)$')
    if ($m.Success) { $allowed = @($m.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
}
if ($allowed.Count -gt 0) {
    $claudeArgs += @("--allowedTools", ($allowed -join ","))
    Write-Host "[run-unit] allowed: $($allowed.Count) tool(s) from $Agent.md"
} else {
    Write-Warning "[run-unit] no tools: line in $agentFile - every tool call will be refused in a headless session"
}

Write-Host "[run-unit] $Agent <- $unit  (model: $(if ($Model) { $Model } else { 'default' }))"
Write-Host "[run-unit] log: $log"

# The prompt goes in on stdin: a brief is long, and a command line has a length limit that a brief
# with a Lessons section will meet. Redirect stdout to the log ourselves so the process is plain.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Claude
$psi.Arguments = ($claudeArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join " "
$psi.WorkingDirectory = $Cwd
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [Text.Encoding]::UTF8
$psi.EnvironmentVariables["MCPTK_UNIT"] = $unit
$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$null = $proc.Start()
$proc.StandardInput.Write($prompt)
$proc.StandardInput.Close()

$out = [IO.StreamWriter]::new($log, $false, [Text.UTF8Encoding]::new($false))
$errW = [IO.StreamWriter]::new($err, $false, [Text.UTF8Encoding]::new($false))
$turns = 0
$pictures = 0
$paused = $false
$started = Get-Date
# One API call is one turn, however many `assistant` lines the stream splits it into (one per
# content block, all with the same message id). Count ids, not lines.
$seenIds = New-Object 'System.Collections.Generic.HashSet[string]'
try {
    while (-not $proc.StandardOutput.EndOfStream) {
        $line = $proc.StandardOutput.ReadLine()
        $out.WriteLine($line)
        $out.Flush()
        if ($line -match '^\{"type":"assistant"') {
            $id = if ($line -match '"id":"(msg_[^"]+)"') { $Matches[1] } else { "line-$turns-$($line.GetHashCode())" }
            if ($seenIds.Add($id)) { $turns++ }
            if ($line -match '"name":"([^"]+)"') {
                Write-Host ("[run-unit] turn {0,4}  {1}" -f $turns, $Matches[1])
            }
        } elseif ($line -match '"type":"image"') {
            $pictures++
            Write-Host ("[run-unit] picture #{0} after turn {1}" -f $pictures, $turns)
        }
        # A permission refusal is a configuration error, not API trouble: say which tool, once.
        if ($line -match "requested permissions to use ([^,]+), but you haven't granted it yet") {
            Write-Warning "[run-unit] permission refused for $($Matches[1]) - add it to the agent's tools: line (that line is the --allowedTools)"
        }
        # The pause rule: an API that is failing gets time, not a hammer. The session retries on
        # its own; we only stop narrating and say why. Named error types only - a bare 5\d\d
        # matched digits inside a message id on the first live run and paused on a permission error.
        if ($line -match '"is_error":true' -and $line -match '(overloaded_error|rate_limit_error|api_error|"status":\s*5\d\d|HTTP 5\d\d|Internal server error)') {
            if (-not $paused) { Write-Warning "[run-unit] API trouble at turn ${turns}: $($line.Substring(0, [Math]::Min(200, $line.Length)))" }
            $paused = $true
            Start-Sleep -Seconds 20
        } else {
            $paused = $false
        }
        if ($line -match '^\{"type":"result"') {
            if ($line -match '"total_cost_usd":([0-9.]+)') { Write-Host ("[run-unit] harness cost: `${0}" -f $Matches[1]) }
        }
    }
    $proc.WaitForExit()
    $errW.Write($proc.StandardError.ReadToEnd())
} finally {
    $out.Close(); $errW.Close()
}
$elapsed = [int]((Get-Date) - $started).TotalMinutes
Write-Host "[run-unit] exit $($proc.ExitCode) after $elapsed min, $turns turns, $pictures pictures"

if (-not $NoAnalyse) {
    & node (Join-Path $here "analyse.mjs") $log
}

# The project's own checks, once more, outside the session. A check nobody executes is not a guard.
# MCPTK_UNIT is still set: a checker that reads the editor's active tab finds it closed by now and
# has the unit's name to fall back on.
$loopFile = Join-Path $Cwd ".mcptoolkit\loop.json"
if (Test-Path $loopFile) {
    $loop = Get-Content -Raw -Encoding UTF8 $loopFile | ConvertFrom-Json
    foreach ($check in @($loop.checks)) {
        if (-not $check.run) { continue }
        $cwd = if ($check.cwd) { Join-Path $Cwd $check.cwd } else { $Cwd }
        Write-Host "[run-unit] check '$($check.name)': $($check.run -join ' ')"
        Push-Location $cwd
        try {
            $lines = & $check.run[0] @($check.run[1..($check.run.Count - 1)]) 2>&1
            $last = ($lines | Select-Object -Last 1)
            try {
                $r = $last | ConvertFrom-Json
                Write-Host $r.text
                if ($r.problems -gt 0) { Write-Warning "[run-unit] $($r.problems) problem(s) stand after the session" }
            } catch {
                Write-Warning "[run-unit] check '$($check.name)' gave no JSON on its last line: $last"
                Write-Warning "[run-unit] (the session has closed its tab by now; a checker that reads the active editor state should fall back to MCPTK_UNIT=$unit)"
            }
        } finally { Pop-Location }
    }
}
exit $proc.ExitCode
