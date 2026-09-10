# extract-vanilla-src.ps1 — unpack Loom's decompile cache into greppable .java files.
#
# Loom's incremental decompiler already holds the full decompiled Minecraft source in
# ~/.gradle/caches/fabric-loom/decompile/v1.zip, one content-addressed blob per outer class:
#   LOOM <BE32 len> | NAME <BE32 len> <class path> | SRC  <BE32 len> <java source> | <line map, ignored>
# Blobs are grouped by a top-level jar-hash directory (one group per decompiled jar). This script
# writes each group's classes as net/minecraft/.../Foo.java under the output dir so Grep/Read work
# on vanilla source directly. Re-run after a genSources on a new MC version picks up new groups.
#
# Usage: tools/extract-vanilla-src.ps1 [-OutDir vanilla-src] [-Force]

param(
    [string]$CacheZip = "$env:USERPROFILE\.gradle\caches\fabric-loom\decompile\v1.zip",
    [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'vanilla-src'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path $CacheZip)) {
    throw "Loom decompile cache not found at $CacheZip - run 'gradlew genSources' first."
}

function Read-BE32([byte[]]$b, [int]$off) {
    return ([int]$b[$off] -shl 24) -bor ([int]$b[$off+1] -shl 16) -bor ([int]$b[$off+2] -shl 8) -bor [int]$b[$off+3]
}

$zip = [System.IO.Compression.ZipFile]::OpenRead($CacheZip)
try {
    $blobs = $zip.Entries | Where-Object { $_.Length -gt 0 }
    $groups = @($blobs | Group-Object { $_.FullName.Split('/')[0] })
    Write-Host "cache: $CacheZip - $($blobs.Count) classes in $($groups.Count) jar group(s)"

    $written = 0; $skipped = 0; $failed = 0
    foreach ($group in $groups) {
        # Single group extracts to OutDir directly; multiple decompiled jars get hash-named subdirs.
        $groupOut = if ($groups.Count -eq 1) { $OutDir } else { Join-Path $OutDir $group.Name.Substring(0, 8) }
        Write-Host "group $($group.Name.Substring(0, 12))... -> $groupOut ($($group.Count) classes)"

        foreach ($entry in $group.Group) {
            $ms = New-Object System.IO.MemoryStream
            $s = $entry.Open(); $s.CopyTo($ms); $s.Dispose()
            $b = $ms.ToArray(); $ms.Dispose()

            if ($b.Length -lt 16 -or [System.Text.Encoding]::ASCII.GetString($b, 0, 4) -ne 'LOOM') {
                $failed++; continue
            }

            # Walk tagged sections: 4-byte tag + BE32 length + payload, until NAME and SRC are found.
            $name = $null; $src = $null; $off = 8
            while ($off + 8 -le $b.Length -and (-not $name -or -not $src)) {
                $tag = [System.Text.Encoding]::ASCII.GetString($b, $off, 4)
                $len = Read-BE32 $b ($off + 4)
                if ($len -lt 0 -or $off + 8 + $len -gt $b.Length) { break }
                if ($tag -eq 'NAME') { $name = [System.Text.Encoding]::UTF8.GetString($b, $off + 8, $len) }
                elseif ($tag -eq 'SRC ') { $src = [System.Text.Encoding]::UTF8.GetString($b, $off + 8, $len) }
                $off += 8 + $len
            }

            if (-not $name -or -not $src) { $failed++; continue }

            $file = Join-Path $groupOut ($name -replace '/', '\')
            $file += '.java'
            if ((Test-Path $file) -and -not $Force) { $skipped++; continue }

            $dir = Split-Path $file -Parent
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
            [System.IO.File]::WriteAllText($file, $src)
            $written++
            if (($written % 1000) -eq 0) { Write-Host "  $written written..." }
        }
    }
    Write-Host "done: $written written, $skipped already present, $failed unparseable -> $OutDir"
} finally {
    $zip.Dispose()
}
