param(
  [string]$BaseUrl = "http://127.0.0.1:8765",
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os",
  [string]$Reason = "manual"
)

$ErrorActionPreference = "Stop"

$logsDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$logPath = Join-Path $logsDir ("neon_sync_{0}.log" -f (Get-Date -Format "yyyyMMdd"))

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
  $serverOut = Join-Path $logsDir "server.log"
  $serverErr = Join-Path $logsDir "server.err.log"

  Start-Process -FilePath $python `
    -ArgumentList "-m","app.main" `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $serverOut `
    -RedirectStandardError $serverErr | Out-Null

  Start-Sleep -Seconds 4
  Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 10 | Out-Null
  Write-Log "Trading OS server started."
}

Ensure-TradingOSServer

$body = @{ reason = $Reason } | ConvertTo-Json -Depth 4
$result = Invoke-RestMethod -Uri "$BaseUrl/api/cloud/sync" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120

if ($result.ok) {
  Write-Log ("Neon sync completed. Reason={0}" -f $Reason)
} elseif ($result.skipped) {
  Write-Log ("Neon sync skipped: {0}" -f $result.reason) "WARN"
} else {
  $failureReason = if ($result.error) { $result.error } else { $result.reason }
  Write-Log ("Neon sync failed: {0}" -f $failureReason) "ERROR"
  exit 2
}

$result
