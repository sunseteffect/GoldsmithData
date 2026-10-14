# Runs tools/fetch.js on this PC (testing, or the hourly scheduled task)
# with the Blizzard API credentials stored by -SetCredentials. Data files go
# into this addon folder; listings, snapshots and logs into
# %LOCALAPPDATA%\Goldsmith\data. On GitHub Actions the workflow passes the
# credentials from repository secrets instead.
#
#   .\run-local.ps1 -SetCredentials           # once: store client ID and secret
#   .\run-local.ps1                           # fetch every region
#   .\run-local.ps1 -Regions us -Out C:\tmp   # extra arguments go to fetch.js
#   .\run-local.ps1 -Install / -Uninstall     # hourly scheduled task, at :15

param(
    [switch]$SetCredentials,
    [switch]$Install,
    [switch]$Uninstall,
    [string]$Regions = 'us,eu,kr,tw',
    [string]$Out,
    [string]$State
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

# Stored with Windows DPAPI at machine scope, in this user's profile folder.
# The task runs logged off without a stored password (S4U), and that can't
# open user-scope DPAPI like the old Export-Clixml file (2026-10-14)
$credFile = Join-Path $env:LOCALAPPDATA 'Goldsmith\blizzard-api.bin'
$oldCredFile = Join-Path $env:LOCALAPPDATA 'Goldsmith\blizzard-api.xml'
$taskName = 'Goldsmith Price Data'

function Save-BlizzardCredential([pscredential]$cred) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($cred.UserName + "`n" + $cred.GetNetworkCredential().Password)
    New-Item -ItemType Directory -Force (Split-Path $credFile) | Out-Null
    [IO.File]::WriteAllBytes($credFile,
        [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'LocalMachine'))
}

if ($SetCredentials) {
    Save-BlizzardCredential (Get-Credential -Message 'Blizzard API: user name = Client ID, password = Client Secret')
    Write-Host "Saved to $credFile"
    return
}

if ($Install) {
    # Through run-hidden.vbs: -WindowStyle Hidden still flashed a window
    # and took focus every hour
    $launcher = Join-Path $PSScriptRoot 'run-hidden.vbs'
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //NoLogo `"$launcher`""
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(15)) `
        -RepetitionInterval (New-TimeSpan -Hours 1)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
    # S4U: runs whether you're logged in or not, so a Windows Update restart
    # overnight doesn't stop it until the next login; no password to store
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Force -ErrorAction Stop | Out-Null
    Write-Host "Installed scheduled task '$taskName' (hourly at :15, logged in or not)"
    return
}
if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'"
    return
}

if (-not (Test-Path $credFile) -and (Test-Path $oldCredFile)) {
    # One-time move from the old user-scope file; works only while logged in
    Save-BlizzardCredential (Import-Clixml $oldCredFile)
    Remove-Item $oldCredFile
}
if (-not (Test-Path $credFile)) { throw "No credentials. Run: .\run-local.ps1 -SetCredentials" }
$env:BLIZZARD_CLIENT_ID, $env:BLIZZARD_CLIENT_SECRET = [Text.Encoding]::UTF8.GetString(
    [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($credFile), $null, 'LocalMachine')) -split "`n", 2
try {
    $addonDir = Split-Path $PSScriptRoot -Parent
    $out = if ($Out) { $Out } else { $addonDir }
    $state = if ($State) { $State } else { Join-Path $env:LOCALAPPDATA 'Goldsmith\data' }
    $luac = 'C:\Program Files (x86)\Lua\5.1\luac.exe'
    if (Test-Path $luac) { $env:LUAC = $luac }
    # Raw US listings for 14 days (gzipped, ~840 MB), to tune the sales rules
    # against TSM offline (was 3 days; two weeks covers weekly patterns, 2026-10-12)
    & node (Join-Path $PSScriptRoot 'fetch.js') --regions $Regions --out $out --state $state --keep-listings us:336
    exit $LASTEXITCODE
}
finally {
    Remove-Item Env:BLIZZARD_CLIENT_ID, Env:BLIZZARD_CLIENT_SECRET -ErrorAction SilentlyContinue
}
