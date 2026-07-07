param(
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os",
  [string]$TaskName = "TradingOS-Startup-Cloud-Worker"
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $ProjectRoot "scripts\startup_cloud_worker.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "Startup worker script not found: $scriptPath"
}

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -ProjectRoot `"$ProjectRoot`""
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$result = & schtasks.exe /Create /TN $TaskName /TR $taskCommand /SC ONLOGON /RL LIMITED /F 2>&1
$taskExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($taskExitCode -ne 0) {
  $startupFolder = [Environment]::GetFolderPath("Startup")
  if (-not $startupFolder) {
    throw "Unable to install scheduled task '$TaskName': $result"
  }
  $launcherPath = Join-Path $startupFolder "$TaskName.cmd"
  @(
    "@echo off",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -ProjectRoot `"$ProjectRoot`""
  ) | Set-Content -Path $launcherPath -Encoding ASCII
  Write-Warning "Scheduled Task install failed, so a Startup-folder launcher was created instead: $launcherPath"
  return
}

Write-Host "Installed scheduled task '$TaskName' at Windows login." -ForegroundColor Green
