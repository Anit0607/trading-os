param(
  [string]$At = "08:40",
  [string]$TaskName = "TradingOS_Dhan_EOD_Scanner",
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os"
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $ProjectRoot "scripts\run_dhan_scanner.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "Dhan scanner script not found: $scriptPath"
}

$time = [datetime]::ParseExact($At, "HH:mm", $null)
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -FullUniverse' -f $scriptPath) `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger `
  -Weekly `
  -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
  -At $time

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3)

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
  -Description "Trading OS read-only Dhan EOD scanner refresh. Updates candles, ROC ranks, and regime; places no orders."

Register-ScheduledTask `
  -TaskName $TaskName `
  -InputObject $task `
  -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' for weekdays at $At." -ForegroundColor Green
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State,TaskPath
