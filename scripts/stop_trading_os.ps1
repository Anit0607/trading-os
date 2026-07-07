param(
  [string]$BaseUrl = "http://127.0.0.1:8765"
)

$ErrorActionPreference = "Stop"

$port = [int](([uri]$BaseUrl).Port)
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $listener) {
  Write-Host "Trading OS is not running on port $port."
  return
}

Stop-Process -Id $listener.OwningProcess -Force
Write-Host "Stopped Trading OS process PID $($listener.OwningProcess) on port $port."
