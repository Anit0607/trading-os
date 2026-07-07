param(
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os",
  [string]$TaskName = "TradingOS-Startup-Cloud-Worker"
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $ProjectRoot "scripts\startup_cloud_worker.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "Startup worker script not found: $scriptPath"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -ProjectRoot `"$ProjectRoot`""

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Starts Trading OS backend worker and syncs Neon mirror at Windows login." `
  -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' at Windows login." -ForegroundColor Green
