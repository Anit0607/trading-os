param(
  [string]$BaseUrl = "http://127.0.0.1:8765",
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os",
  [string]$Symbols = "",
  [int]$Limit = 25,
  [int]$LookbackDays = 550,
  [string]$FromDate = "",
  [string]$ToDate = "",
  [string]$AsOfDate = "",
  [double]$SleepSeconds = 1.0,
  [int]$MaxRetries = 3,
  [switch]$ForceInstruments,
  [switch]$NoSync,
  [switch]$FullUniverse
)

$ErrorActionPreference = "Stop"

$logsDir = Join-Path $ProjectRoot "logs"
$dataDir = Join-Path $ProjectRoot "data\scanner"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$logPath = Join-Path $logsDir ("dhan_scanner_{0}.log" -f (Get-Date -Format "yyyyMMdd"))
$summaryPath = Join-Path $dataDir "last_scanner_run.json"

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

function Add-Optional {
  param([hashtable]$Body, [string]$Key, [string]$Value)
  if ($Value -and $Value.Trim()) {
    $Body[$Key] = $Value.Trim()
  }
}

Write-Log "Starting Dhan EOD scanner run."
Ensure-TradingOSServer

$effectiveLimit = if ($FullUniverse) { 0 } else { $Limit }
$body = @{
  limit = $effectiveLimit
  lookback_days = $LookbackDays
  sleep_seconds = $SleepSeconds
  max_retries = $MaxRetries
  force_instruments = [bool]$ForceInstruments
  sync = -not [bool]$NoSync
}

if ($Symbols -and $Symbols.Trim()) {
  $body["symbols"] = @($Symbols.Split(",") | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ })
}

Add-Optional -Body $body -Key "from_date" -Value $FromDate
Add-Optional -Body $body -Key "to_date" -Value $ToDate
Add-Optional -Body $body -Key "as_of_date" -Value $AsOfDate

Write-Log ("Scanner request: symbols='{0}', limit={1}, lookback_days={2}, sync={3}" -f $Symbols, $effectiveLimit, $LookbackDays, (-not [bool]$NoSync))

$jsonBody = $body | ConvertTo-Json -Depth 8
$result = Invoke-RestMethod -Uri "$BaseUrl/api/scanner/run" -Method Post -Body $jsonBody -ContentType "application/json" -TimeoutSec 7200

$summary = [PSCustomObject]@{
  generated_at = (Get-Date).ToString("s")
  run_id = $result.run_id
  status = $result.status
  ok = $result.ok
  as_of_date = $result.as_of_date
  as_of_month = $result.as_of_month
  execution_month = $result.execution_month
  universe_count = $result.universe_count
  requested_count = $result.sync.requested_count
  success_count = $result.sync.success_count
  failure_count = $result.sync.failure_count
  missing_symbols = $result.sync.missing_symbols
  saved_candle_count = $result.sync.saved_candle_count
  required_history_coverage = $result.ranking_diagnostics.required_history_coverage
  with_required_history = $result.ranking_diagnostics.with_required_history
  regime_state = $result.regime.state
  regime_reason = $result.regime.reason
  breadth_30w = $result.regime.breadth_30w
  niftybees_above_30w = $result.regime.niftybees_above_30w
  top_rankings = @($result.rankings | Select-Object -First 10 rank,symbol,company,close,roc_12,ret_1m,avg_turnover_3m)
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding UTF8

Write-Log ("Scanner completed: status={0}; run_id={1}; success={2}; failures={3}; saved_candles={4}" -f `
  $result.status, $result.run_id, $result.sync.success_count, $result.sync.failure_count, $result.sync.saved_candle_count)
Write-Log ("Coverage: {0}/{1} symbols have required monthly history ({2:P2})." -f `
  $result.ranking_diagnostics.with_required_history, `
  $result.ranking_diagnostics.total_strategy_universe, `
  $result.ranking_diagnostics.required_history_coverage)
if ($result.sync.missing_symbols -and $result.sync.missing_symbols.Count -gt 0) {
  Write-Log ("Missing symbols in Dhan master: {0}" -f (($result.sync.missing_symbols) -join ", ")) "WARN"
}
Write-Log ("Regime: {0}; {1}" -f $result.regime.state, $result.regime.reason)
if ($result.rankings.Count -gt 0) {
  $top = $result.rankings[0]
  Write-Log ("Top rank: #{0} {1}, ROC12={2:P2}" -f $top.rank, $top.symbol, $top.roc_12)
} else {
  Write-Log "No rankings produced yet. More historical data/universe coverage may be required." "WARN"
}
Write-Log "Dhan EOD scanner run completed."

try {
  & "$ProjectRoot\scripts\sync_neon_mirror.ps1" -BaseUrl $BaseUrl -ProjectRoot $ProjectRoot -Reason "scanner_run" | Out-Null
  Write-Log "Neon mirror sync requested after scanner run."
} catch {
  Write-Log ("Neon mirror sync after scanner run failed: {0}" -f $_.Exception.Message) "WARN"
}
