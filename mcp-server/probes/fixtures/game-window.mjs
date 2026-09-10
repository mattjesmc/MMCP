// The game's OS window, from a probe: minimize it, restore it, ask whether it is iconic.
//
// Windows only (user32 through PowerShell's Add-Type; anywhere else `available` is false and the
// caller skips). The one reason a probe touches the window at all is the 2026-09-07 finding that
// an iconified client still renders — RENDER_SEAM_DESIGN.md trap 7, corrected — and a finding
// that only ever held with the window up is one a hand on the taskbar falsifies in the middle of a
// three-hour battery. Restoring ACTIVATES the window, so a case that minimizes puts it back in a
// finally and does it once.

import { execFileSync } from "node:child_process";

export const available = process.platform === "win32";

const SCRIPT = `
Add-Type -Namespace McpTkProbe -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
'@
$cmd = '__ACTION__'
$out = @()
foreach ($g in Get-Process | Where-Object { $_.MainWindowTitle -like 'Minecraft*' }) {
  $h = $g.MainWindowHandle
  if ($cmd -eq 'minimize') { [McpTkProbe.Win32]::ShowWindowAsync($h, 6) | Out-Null }
  if ($cmd -eq 'restore')  { [McpTkProbe.Win32]::ShowWindowAsync($h, 9) | Out-Null }
  if ($cmd -ne 'state') { Start-Sleep -Milliseconds 400 }
  $out += ('{0}:{1}' -f $g.Id, [McpTkProbe.Win32]::IsIconic($h))
}
$out -join ' '
`;

/** @returns {{found: boolean, iconic: boolean}} after `minimize` | `restore` | `state`. */
export function gameWindow(action) {
  if (!available) return { found: false, iconic: false };
  if (!["minimize", "restore", "state"].includes(action)) throw new Error(`gameWindow: ${action}`);
  const text = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT.replace("__ACTION__", action)],
    { encoding: "utf8", windowsHide: true }).trim();
  const rows = text ? text.split(/\s+/) : [];
  return { found: rows.length > 0, iconic: rows.some((r) => /:True$/.test(r)) };
}
