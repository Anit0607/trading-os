param(
  [string]$BaseUrl = "http://127.0.0.1:8765",
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os"
)

$ErrorActionPreference = "Stop"

$logsDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$logPath = Join-Path $logsDir ("nse_holidays_{0}.log" -f (Get-Date -Format "yyyyMMdd"))

function Write-Log {
  param([string]$Message, [string]$Level = "INFO")
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  Add-Content -Path $logPath -Value $line
  Write-Host $line
}

function Ensure-TradingOSServer {
  $uri = "$BaseUrl/api/health"
  try {
    Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 5 | Out-Null
    Write-Log "Trading OS server is already running."
    return
  } catch {
    Write-Log "Trading OS server is not responding; starting local server."
  }

  $bundledPython = "C:\Users\ANIT BOSE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
  $python = if (Test-Path $bundledPython) { $bundledPython } else { "python" }
  Start-Process -FilePath $python `
    -ArgumentList "-m","app.main" `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logsDir "server.log") `
    -RedirectStandardError (Join-Path $logsDir "server.err.log") | Out-Null

  Start-Sleep -Seconds 4
  Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 10 | Out-Null
  Write-Log "Trading OS server started."
}

Write-Log "Starting NSE holiday sync."
Ensure-TradingOSServer
$sync = Invoke-RestMethod -Uri "$BaseUrl/api/market/holidays/sync" -Method Post -TimeoutSec 90
Write-Log ("Holiday sync OK: {0} holidays, segment={1}, source={2}" -f $sync.holiday_count, $sync.segment, $sync.source)
Write-Log ("Holiday file: {0}" -f $sync.path)
