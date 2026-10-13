' Runs run-local.ps1 with no window at all, for the hourly scheduled task.
' powershell.exe -WindowStyle Hidden still flashes a console window for a
' moment and takes focus, every hour at :15 (2026-10-12); a window style of
' 0 here never shows one, for PowerShell or the node process it starts.
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WScript.Quit shell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & folder & "\run-local.ps1""", 0, True)
