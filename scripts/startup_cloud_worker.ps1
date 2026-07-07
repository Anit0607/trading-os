param(
  [string]$BaseUrl = "http://127.0.0.1:8765",
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os",
  [switch]$DisableLateMonthlyCatchup
)

$ErrorActionPreference = "Stop"

$logsDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$logPath = Join-Path $logsDir ("startup_cloud_worker_{0}.log" -f (Get-Date -Format "yyyyMMdd"))

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

function Send-StartupAlert {
  try {
    $body = @{
      level = "ok"
      event_type = "worker_startup"
      title = "Trading OS backend online"
      message = "Local D-drive backend worker started and is checking cloud mirror/catch-up rules."
      payload = @{
        mode = "paper"
        order_placement = "blocked"
      }
    } | ConvertTo-Json -Depth 6
    Invoke-RestMethod -Uri "$BaseUrl/api/notifications/emit" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 45 | Out-Null
    Write-Log "Startup notification emitted."
  } catch {
    Write-Log ("Startup notification failed: {0}" -f $_.Exception.Message) "WARN"
  }
}

function Is-Weekday {
  param([datetime]$Day)
  return $Day.DayOfWeek -notin @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)
}

Write-Log "Starting Trading OS startup cloud worker."
Ensure-TradingOSServer
Send-StartupAlert

try {
  & "$ProjectRoot\scripts\sync_neon_mirror.ps1" -BaseUrl $BaseUrl -ProjectRoot $ProjectRoot -Reason "startup_catchup" | Out-Null
} catch {
  Write-Log ("Startup cloud sync failed: {0}" -f $_.Exception.Message) "WARN"
}

try {
  $status = Invoke-RestMethod -Uri "$BaseUrl/api/paper/rebalance-status" -Method Get -TimeoutSec 45
  $today = [datetime]::Parse($status.today)
  $firstTradingDay = [datetime]::Parse($status.first_trading_day)
  $executionMonth = [string]$status.execution_month
  $lastCompletedMonth = [string]$status.last_completed_month
  $currentMonth = Get-Date -Format "yyyy-MM"
  $lateCatchupAllowed = (-not [bool]$DisableLateMonthlyCatchup) `
    -and ($currentMonth -eq $executionMonth) `
    -and ($lastCompletedMonth -ne $executionMonth) `
    -and ($today -ge $firstTradingDay) `
    -and (Is-Weekday $today)

  Write-Log ("Rebalance startup check: allowed={0}; late_catchup={1}; reason={2}" -f $status.allowed, $lateCatchupAllowed, $status.reason)

  if ($status.allowed -or $lateCatchupAllowed) {
    Write-Log "Running paper rebalance catch-up cycle."
    & "$ProjectRoot\scripts\run_paper_rebalance.ps1" -BaseUrl $BaseUrl -ProjectRoot $ProjectRoot -ForceRebalance | Out-Null
    & "$ProjectRoot\scripts\sync_neon_mirror.ps1" -BaseUrl $BaseUrl -ProjectRoot $ProjectRoot -Reason "startup_rebalance_catchup" | Out-Null
  }
} catch {
  Write-Log ("Startup rebalance catch-up check failed: {0}" -f $_.Exception.Message) "WARN"
}

Write-Log "Trading OS startup cloud worker completed."
