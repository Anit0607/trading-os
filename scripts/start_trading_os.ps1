param(
  [string]$BaseUrl = "http://127.0.0.1:8765",
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

Set-Location "D:\Codex_Scanner\trading_os"

$logsDir = Join-Path (Get-Location) "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

function Test-TradingOS {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/readiness" -TimeoutSec 3
    return @{
      Ok = $response.StatusCode -eq 200
      Body = $response.Content | ConvertFrom-Json
    }
  } catch {
    return @{
      Ok = $false
      Body = $null
    }
  }
}

$existing = Test-TradingOS
if ($existing.Ok) {
  Write-Host "Trading OS is already running at $BaseUrl"
  Write-Host "Readiness: $($existing.Body.ok)"
  if ($OpenBrowser) {
    Start-Process $BaseUrl
  }
  return
}

$port = [int](([uri]$BaseUrl).Port)
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Write-Warning "Port $port is already occupied by PID $($listener.OwningProcess), but Trading OS readiness did not respond."
  Write-Warning "Stop that process first, or run scripts\status_trading_os.ps1 for details."
  exit 1
}

$python = "C:\Users\ANIT BOSE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if (-not (Test-Path $python)) {
  $python = "python"
}

$env:PYTHONDONTWRITEBYTECODE = "1"
$serverOut = Join-Path $logsDir "server.log"
$serverErr = Join-Path $logsDir "server.err.log"

Start-Process -FilePath $python `
  -ArgumentList @("-B", "-m", "app.main") `
  -WorkingDirectory "D:\Codex_Scanner\trading_os" `
  -WindowStyle Hidden `
  -RedirectStandardOutput $serverOut `
  -RedirectStandardError $serverErr | Out-Null

$deadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Milliseconds 500
  $status = Test-TradingOS
  if ($status.Ok) {
    Write-Host "Trading OS started at $BaseUrl"
    Write-Host "Readiness: $($status.Body.ok)"
    Write-Host "Mode: $($status.Body.mode) | Auto execution: $($status.Body.auto_execution_enabled)"
    Write-Host "Logs: $logsDir"
    if ($OpenBrowser) {
      Start-Process $BaseUrl
    }
    return
  }
} while ((Get-Date) -lt $deadline)

Write-Error "Trading OS did not become ready within 20 seconds. Check $serverErr"
