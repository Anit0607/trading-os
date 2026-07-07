param(
  [string]$At = "08:30",
  [string]$TaskName = "TradingOS_Dhan_Daily_Readonly_Sync",
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os"
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $ProjectRoot "scripts\daily_dhan_sync.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "Daily sync script not found: $scriptPath"
}

$time = [datetime]::ParseExact($At, "HH:mm", $null)
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $scriptPath) `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -Daily -At $time
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal `
  -UserId $user `
  -LogonType Interactive `
  -RunLevel Limited

$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Trading OS read-only Dhan token refresh, broker check, and reconciliation before market open."

Register-ScheduledTask `
  -TaskName $TaskName `
  -InputObject $task `
  -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' for $At daily." -ForegroundColor Green
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State,TaskPath
