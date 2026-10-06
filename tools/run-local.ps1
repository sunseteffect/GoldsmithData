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

# Stored with Windows DPAPI: only this Windows user on this PC can read it
$credFile = Join-Path $env:LOCALAPPDATA 'Goldsmith\blizzard-api.xml'
$taskName = 'Goldsmith Price Data'

if ($SetCredentials) {
    New-Item -ItemType Directory -Force (Split-Path $credFile) | Out-Null
    Get-Credential -Message 'Blizzard API: user name = Client ID, password = Client Secret' | Export-Clixml $credFile
    Write-Host "Saved to $credFile"
    return
}

if ($Install) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(15)) `
        -RepetitionInterval (New-TimeSpan -Hours 1)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "Installed scheduled task '$taskName' (hourly at :15, while you're logged in)"
    return
}
if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'"
    return
}

if (-not (Test-Path $credFile)) { throw "No credentials. Run: .\run-local.ps1 -SetCredentials" }
$cred = Import-Clixml $credFile
$env:BLIZZARD_CLIENT_ID = $cred.UserName
$env:BLIZZARD_CLIENT_SECRET = $cred.GetNetworkCredential().Password
try {
    $addonDir = Split-Path $PSScriptRoot -Parent
    $out = if ($Out) { $Out } else { $addonDir }
    $state = if ($State) { $State } else { Join-Path $env:LOCALAPPDATA 'Goldsmith\data' }
    $luac = 'C:\Program Files (x86)\Lua\5.1\luac.exe'
    if (Test-Path $luac) { $env:LUAC = $luac }
    & node (Join-Path $PSScriptRoot 'fetch.js') --regions $Regions --out $out --state $state
    exit $LASTEXITCODE
}
finally {
    Remove-Item Env:BLIZZARD_CLIENT_ID, Env:BLIZZARD_CLIENT_SECRET -ErrorAction SilentlyContinue
}
