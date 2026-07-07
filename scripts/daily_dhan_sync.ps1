param(
  [string]$BaseUrl = "http://127.0.0.1:8765",
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os"
)

$ErrorActionPreference = "Stop"

$logsDir = Join-Path $ProjectRoot "logs"
$dataDir = Join-Path $ProjectRoot "data\dhan"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$logPath = Join-Path $logsDir ("daily_dhan_sync_{0}.log" -f (Get-Date -Format "yyyyMMdd"))
$summaryPath = Join-Path $dataDir "last_daily_sync.json"

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

function Select-SafeTokenStatus {
  param($Status)
  [PSCustomObject]@{
    source = $Status.source
    client_id_present = $Status.client_id_present
    env_token_present = $Status.env_token_present
    managed_token_present = $Status.managed_token_present
    managed_token_expiry = $Status.managed_token_expiry
    renew_possible = $Status.renew_possible
    totp_generation_possible = $Status.totp_generation_possible
  }
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

Write-Log "Starting daily Dhan read-only sync."
Ensure-TradingOSServer

try {
  $holidaySync = Invoke-RestMethod -Uri "$BaseUrl/api/market/holidays/sync" -Method Post -TimeoutSec 60
  Write-Log ("NSE holiday sync OK: {0} CM holidays loaded from {1}." -f $holidaySync.holiday_count, $holidaySync.source)
} catch {
  Write-Log ("NSE holiday sync failed; existing local holiday cache will be used. {0}" -f $_.Exception.Message) "WARN"
}

$tokenBefore = Invoke-RestMethod -Uri "$BaseUrl/api/dhan/token/status" -Method Get -TimeoutSec 30
Write-Log ("Token source before refresh: {0}" -f $tokenBefore.source)

$refresh = Invoke-RestMethod -Uri "$BaseUrl/api/dhan/token/refresh" -Method Post -TimeoutSec 90
$tokenAfter = Invoke-RestMethod -Uri "$BaseUrl/api/dhan/token/status?validate=true" -Method Get -TimeoutSec 60
$tokenReady = [bool]$tokenAfter.profile_ok
if ($refresh.ok) {
  Write-Log ("Token refresh OK via {0}." -f $refresh.method)
} elseif ($tokenReady) {
  Write-Log "Token refresh did not issue a new token; existing token validated OK."
} else {
  Write-Log "Token refresh failed and token validation did not pass." "WARN"
}

$brokerSnapshot = Invoke-RestMethod -Uri "$BaseUrl/api/dhan/broker-snapshot/refresh" -Method Post -TimeoutSec 90
$reconciliation = Invoke-RestMethod -Uri "$BaseUrl/api/reconciliation" -Method Get -TimeoutSec 90

$tokenAction = if ($refresh.ok) {
  $refresh.method
} elseif ($tokenReady) {
  "existing_token_valid"
} else {
  "token_not_ready"
}

$summary = [PSCustomObject]@{
  generated_at = (Get-Date).ToString("s")
  base_url = $BaseUrl
  token_before = Select-SafeTokenStatus $tokenBefore
  token_after = Select-SafeTokenStatus $tokenAfter
  token_ready = $tokenReady
  token_action = $tokenAction
  token_profile_ok = $tokenAfter.profile_ok
  refresh_ok = $refresh.ok
  refresh_method = $refresh.method
  dhan_status_ok = $brokerSnapshot.ok
  order_placement = $brokerSnapshot.order_placement
  broker_snapshot_ok = $brokerSnapshot.ok
  broker_snapshot_cache_status = $brokerSnapshot.cache.status
  broker_snapshot_generated_at = $brokerSnapshot.cache.generated_at
  reconciliation_ok = $reconciliation.dhan.ok
  reconciliation_message = $reconciliation.dhan.message
  actual_holding_count = $reconciliation.summary.broker_holding_count
  paper_holding_count = $reconciliation.summary.paper_holding_count
  gap_count = $reconciliation.summary.gap_count
  pending_exit_count = $reconciliation.summary.pending_exit_count
  pending_entry_count = $reconciliation.summary.pending_entry_count
  available_cash = $reconciliation.summary.available_cash
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding UTF8

Write-Log ("Broker snapshot OK: {0}; cache: {1}; reconciliation: {2}" -f $brokerSnapshot.ok, $brokerSnapshot.cache.status, $reconciliation.dhan.message)
Write-Log ("Pending entries: {0}; exits: {1}; available cash: {2}" -f $reconciliation.summary.pending_entry_count, $reconciliation.summary.pending_exit_count, $reconciliation.summary.available_cash)

$notificationLevel = if ($tokenReady -and $brokerSnapshot.ok -and $reconciliation.dhan.ok) { "ok" } else { "warning" }
$notificationTitle = if ($notificationLevel -eq "ok") { "Dhan daily sync OK" } else { "Dhan daily sync needs attention" }
$notificationMessage = "Token={0}; Dhan={1}; Reconciliation={2}; Entries={3}; Exits={4}" -f `
  $tokenAction, `
  $brokerSnapshot.ok, `
  $reconciliation.dhan.message, `
  $reconciliation.summary.pending_entry_count, `
  $reconciliation.summary.pending_exit_count
Send-TradingOSNotification `
  -Level $notificationLevel `
  -EventType "daily_dhan_sync" `
  -Title $notificationTitle `
  -Message $notificationMessage `
  -Payload @{
    token_ready = $tokenReady
    token_action = $tokenAction
    dhan_status_ok = $brokerSnapshot.ok
    order_placement = $brokerSnapshot.order_placement
    broker_snapshot_ok = $brokerSnapshot.ok
    broker_snapshot_cache_status = $brokerSnapshot.cache.status
    reconciliation_ok = $reconciliation.dhan.ok
    gap_count = $reconciliation.summary.gap_count
    pending_entry_count = $reconciliation.summary.pending_entry_count
    pending_exit_count = $reconciliation.summary.pending_exit_count
  }

Write-Log "Daily Dhan read-only sync completed."

try {
  & "$ProjectRoot\scripts\sync_neon_mirror.ps1" -BaseUrl $BaseUrl -ProjectRoot $ProjectRoot -Reason "daily_dhan_sync" | Out-Null
  Write-Log "Neon mirror sync requested after daily Dhan sync."
} catch {
  Write-Log ("Neon mirror sync after daily Dhan sync failed: {0}" -f $_.Exception.Message) "WARN"
}

if (-not $tokenReady -or -not $brokerSnapshot.ok) {
  exit 2
}
