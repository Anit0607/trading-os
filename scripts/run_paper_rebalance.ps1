param(
  [string]$BaseUrl = "http://127.0.0.1:8765",
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os",
  [switch]$ForceRebalance
)

$ErrorActionPreference = "Stop"

$logsDir = Join-Path $ProjectRoot "logs"
$dataDir = Join-Path $ProjectRoot "data\paper"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$logPath = Join-Path $logsDir ("paper_rebalance_{0}.log" -f (Get-Date -Format "yyyyMMdd"))
$summaryPath = Join-Path $dataDir "last_paper_rebalance.json"

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

function Send-TradingOSNotification {
  param(
    [string]$Level,
    [string]$EventType,
    [string]$Title,
    [string]$Message,
    [hashtable]$Payload
  )
  try {
    $body = @{
      level = $Level
      event_type = $EventType
      title = $Title
      message = $Message
      payload = $Payload
    } | ConvertTo-Json -Depth 8
    Invoke-RestMethod -Uri "$BaseUrl/api/notifications/emit" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 45 | Out-Null
    Write-Log ("Notification emitted: {0}" -f $Title)
  } catch {
    Write-Log ("Notification emit failed: {0}" -f $_.Exception.Message) "WARN"
  }
}

Write-Log "Starting paper rebalance cycle."
Ensure-TradingOSServer

$before = Invoke-RestMethod -Uri "$BaseUrl/api/paper/order-plan" -Method Get -TimeoutSec 60
$rebalanceStatus = Invoke-RestMethod -Uri "$BaseUrl/api/paper/rebalance-status" -Method Get -TimeoutSec 60
Write-Log ("Plan before execution: sells={0}; buys={1}; skipped={2}; equity={3}; cash={4}" -f `
  $before.plan.summary.sell_count, `
  $before.plan.summary.buy_count, `
  $before.plan.summary.skipped_buy_count, `
  $before.portfolio.equity, `
  $before.portfolio.cash)
Write-Log ("Rebalance guard: allowed={0}; today={1}; execution_month={2}; first_trading_day={3}; reason={4}" -f `
  $rebalanceStatus.allowed, `
  $rebalanceStatus.today, `
  $rebalanceStatus.execution_month, `
  $rebalanceStatus.first_trading_day, `
  $rebalanceStatus.reason)

if (-not $rebalanceStatus.allowed -and -not $ForceRebalance) {
  $summary = [PSCustomObject]@{
    generated_at = (Get-Date).ToString("s")
    base_url = $BaseUrl
    mode = $before.mode
    skipped = $true
    skip_reason = $rebalanceStatus.reason
    force = $false
    filled_count = 0
    before_sell_count = $before.plan.summary.sell_count
    before_buy_count = $before.plan.summary.buy_count
    after_sell_count = $before.plan.summary.sell_count
    after_buy_count = $before.plan.summary.buy_count
    equity = $before.portfolio.equity
    cash = $before.portfolio.cash
    current_drawdown = $before.portfolio.current_drawdown
    holding_count = $before.portfolio.holding_count
    rebalance_status = $rebalanceStatus
  }
  $summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding UTF8
  Write-Log ("Paper rebalance skipped: {0}" -f $rebalanceStatus.reason)
  Send-TradingOSNotification `
    -Level "info" `
    -EventType "paper_rebalance" `
    -Title "Paper rebalance skipped" `
    -Message $rebalanceStatus.reason `
    -Payload @{
      mode = $before.mode
      skipped = $true
      filled_count = 0
      next_rebalance = $rebalanceStatus.first_trading_day
    }
  try {
    & "$ProjectRoot\scripts\sync_neon_mirror.ps1" -BaseUrl $BaseUrl -ProjectRoot $ProjectRoot -Reason "paper_rebalance_skipped" | Out-Null
    Write-Log "Neon mirror sync requested after skipped paper rebalance."
  } catch {
    Write-Log ("Neon mirror sync after skipped paper rebalance failed: {0}" -f $_.Exception.Message) "WARN"
  }
  Write-Log "Paper rebalance cycle completed."
  exit 0
}

$body = @{ force = [bool]$ForceRebalance } | ConvertTo-Json -Depth 4
$result = Invoke-RestMethod -Uri "$BaseUrl/api/paper/rebalance" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120
$after = Invoke-RestMethod -Uri "$BaseUrl/api/paper/order-plan" -Method Get -TimeoutSec 60

$summary = [PSCustomObject]@{
  generated_at = (Get-Date).ToString("s")
  base_url = $BaseUrl
  mode = $after.mode
  skipped = [bool]$result.skipped
  skip_reason = $result.skip_reason
  force = [bool]$ForceRebalance
  filled_count = $result.paper_rebalance.filled_count
  before_sell_count = $before.plan.summary.sell_count
  before_buy_count = $before.plan.summary.buy_count
  after_sell_count = $after.plan.summary.sell_count
  after_buy_count = $after.plan.summary.buy_count
  equity = $after.portfolio.equity
  cash = $after.portfolio.cash
  current_drawdown = $after.portfolio.current_drawdown
  holding_count = $after.portfolio.holding_count
  rebalance_status = $result.rebalance_status
}

$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $summaryPath -Encoding UTF8

Write-Log ("Paper rebalance filled {0} orders." -f $result.paper_rebalance.filled_count)
Write-Log ("After execution: sells={0}; buys={1}; equity={2}; cash={3}" -f `
  $after.plan.summary.sell_count, `
  $after.plan.summary.buy_count, `
  $after.portfolio.equity, `
  $after.portfolio.cash)
try {
  & "$ProjectRoot\scripts\sync_neon_mirror.ps1" -BaseUrl $BaseUrl -ProjectRoot $ProjectRoot -Reason "paper_rebalance" | Out-Null
  Write-Log "Neon mirror sync requested after paper rebalance."
} catch {
  Write-Log ("Neon mirror sync after paper rebalance failed: {0}" -f $_.Exception.Message) "WARN"
}
Write-Log "Paper rebalance cycle completed."
