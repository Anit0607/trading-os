param(
  [string]$BaseUrl = "http://127.0.0.1:8765",
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os",
  [switch]$OpenReport
)

$ErrorActionPreference = "Stop"

Set-Location $ProjectRoot

$outDir = Join-Path $ProjectRoot "logs\preflight"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Ensure-TradingOS {
  try {
    Invoke-RestMethod -Uri "$BaseUrl/api/readiness" -Method Get -TimeoutSec 4 | Out-Null
    return
  } catch {
    & "$ProjectRoot\scripts\start_trading_os.ps1" -BaseUrl $BaseUrl | Out-Null
  }
}

function Get-Endpoint {
  param([string]$Path, [int]$TimeoutSec = 45)
  try {
    return @{
      ok = $true
      data = Invoke-RestMethod -Uri "$BaseUrl$Path" -Method Get -TimeoutSec $TimeoutSec
      error = $null
    }
  } catch {
    return @{
      ok = $false
      data = $null
      error = $_.Exception.Message
    }
  }
}

function Add-Check {
  param(
    [System.Collections.Generic.List[object]]$Checks,
    [string]$Name,
    [string]$Severity,
    [bool]$Ok,
    [string]$Detail
  )
  $Checks.Add([pscustomobject]@{
    name = $Name
    severity = $Severity
    ok = $Ok
    detail = $Detail
  }) | Out-Null
}

function Safe-Value {
  param($Value, [string]$Fallback = "--")
  if ($null -eq $Value -or "$Value" -eq "") { return $Fallback }
  return "$Value"
}

Ensure-TradingOS

$readiness = Get-Endpoint "/api/readiness" 15
$token = Get-Endpoint "/api/dhan/token/status" 30
$broker = Get-Endpoint "/api/dhan/broker-snapshot" 30
$scanner = Get-Endpoint "/api/scanner/latest" 60
$orderPlan = Get-Endpoint "/api/paper/order-plan" 45
$dryRun = Get-Endpoint "/api/rebalance/dry-run" 90
$tasks = Get-Endpoint "/api/system/tasks" 30
$notifications = Get-Endpoint "/api/notifications/status" 30

$checks = [System.Collections.Generic.List[object]]::new()

$readyData = $readiness.data
$tokenData = $token.data
$brokerData = $broker.data
$scannerData = $scanner.data
$orderPlanData = $orderPlan.data
$dryRunData = $dryRun.data
$tasksData = $tasks.data
$notificationData = $notifications.data

$readinessOk = [bool]($readiness.ok -and $readyData.ok)
$readinessDetail = if ($readiness.ok) { "version=$(Safe-Value $readyData.version)" } else { Safe-Value $readiness.error }
Add-Check -Checks $checks -Name "Readiness endpoint" -Severity "critical" -Ok $readinessOk -Detail $readinessDetail

$paperSafeOk = [bool]($readyData.paper_safe)
$paperSafeDetail = "mode=$(Safe-Value $readyData.mode); auto_execution=$(Safe-Value $readyData.auto_execution_enabled)"
Add-Check -Checks $checks -Name "Paper-safe mode" -Severity "critical" -Ok $paperSafeOk -Detail $paperSafeDetail

$tokenOk = [bool]($token.ok -and ($tokenData.ok -or $tokenData.env_token_present -or $tokenData.managed_token_present))
$tokenDetail = "source=$(Safe-Value $tokenData.source); expiry=$(Safe-Value $tokenData.managed_token_expiry)"
Add-Check -Checks $checks -Name "Dhan token available" -Severity "critical" -Ok $tokenOk -Detail $tokenDetail

$brokerCacheOk = [bool]($broker.ok -and $brokerData.cache.available)
$brokerCacheDetail = "cache=$(Safe-Value $brokerData.cache.status); age=$(Safe-Value $brokerData.cache.age_seconds)s"
Add-Check -Checks $checks -Name "Broker cache available" -Severity "critical" -Ok $brokerCacheOk -Detail $brokerCacheDetail

$brokerFreshOk = [bool]($broker.ok -and $brokerData.cache.available -and -not $brokerData.cache.stale)
$brokerFreshDetail = "cache=$(Safe-Value $brokerData.cache.status); generated=$(Safe-Value $brokerData.cache.generated_at)"
Add-Check -Checks $checks -Name "Broker cache fresh" -Severity "warning" -Ok $brokerFreshOk -Detail $brokerFreshDetail

$rankingCount = if ($scannerData.rankings) { $scannerData.rankings.Count } else { 0 }
$scannerOk = [bool]($scanner.ok -and ($scannerData.run_id -or $rankingCount -gt 0))
$scannerDetail = "run_id=$(Safe-Value $scannerData.run_id); status=$(Safe-Value $scannerData.status); month=$(Safe-Value $scannerData.as_of_month)"
Add-Check -Checks $checks -Name "Scanner latest data" -Severity "critical" -Ok $scannerOk -Detail $scannerDetail

$orderPlanOk = [bool]($orderPlan.ok -and $orderPlanData.mode -eq "paper")
$orderPlanDetail = "mode=$(Safe-Value $orderPlanData.mode); orders=$(Safe-Value $orderPlanData.plan.summary.order_count)"
Add-Check -Checks $checks -Name "Paper order plan" -Severity "critical" -Ok $orderPlanOk -Detail $orderPlanDetail

$dryRunOk = [bool]($dryRun.ok -and $dryRunData.ok)
$dryRunDetail = "status=$(Safe-Value $dryRunData.summary.status); gate=$(Safe-Value $dryRunData.summary.rebalance_gate); planned_orders=$(Safe-Value $dryRunData.summary.planned_order_count)"
Add-Check -Checks $checks -Name "Dry-run report" -Severity "warning" -Ok $dryRunOk -Detail $dryRunDetail

$tasksOk = [bool]($tasks.ok -and ($tasksData.installed_count -ge $tasksData.expected_count))
$tasksDetail = "installed=$(Safe-Value $tasksData.installed_count)/$(Safe-Value $tasksData.expected_count)"
Add-Check -Checks $checks -Name "Scheduled tasks" -Severity "warning" -Ok $tasksOk -Detail $tasksDetail

$alertsOk = [bool]($notifications.ok -and $notificationData.app_enabled -and ((-not $notificationData.telegram_enabled) -or $notificationData.telegram_configured))
$alertsDetail = "app=$(Safe-Value $notificationData.app_enabled); telegram=$(Safe-Value $notificationData.telegram_enabled); configured=$(Safe-Value $notificationData.telegram_configured)"
Add-Check -Checks $checks -Name "Alert pipeline" -Severity "warning" -Ok $alertsOk -Detail $alertsDetail

$criticalFailures = @($checks | Where-Object { $_.severity -eq "critical" -and -not $_.ok })
$warningFailures = @($checks | Where-Object { $_.severity -eq "warning" -and -not $_.ok })
$status = if ($criticalFailures.Count -gt 0) { "BLOCKED" } elseif ($warningFailures.Count -gt 0) { "READY_WITH_WARNINGS" } else { "READY" }
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$jsonPath = Join-Path $outDir "paper_preflight_$stamp.json"
$mdPath = Join-Path $outDir "paper_preflight_$stamp.md"

$report = [pscustomobject]@{
  generated_at = (Get-Date).ToString("o")
  base_url = $BaseUrl
  status = $status
  critical_failure_count = $criticalFailures.Count
  warning_count = $warningFailures.Count
  app_version = $readyData.version
  paper_safe = $readyData.paper_safe
  scanner = [pscustomobject]@{
    run_id = $scannerData.run_id
    status = $scannerData.status
    as_of_month = $scannerData.as_of_month
    execution_month = $scannerData.execution_month
  }
  broker_cache = [pscustomobject]@{
    available = $brokerData.cache.available
    status = $brokerData.cache.status
    stale = $brokerData.cache.stale
    age_seconds = $brokerData.cache.age_seconds
  }
  dry_run = [pscustomobject]@{
    status = $dryRunData.summary.status
    gate = $dryRunData.summary.rebalance_gate
    planned_order_count = $dryRunData.summary.planned_order_count
  }
  checks = $checks
}

$report | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath -Encoding UTF8

$lines = @(
  "Trading OS Paper Preflight",
  "",
  "- Generated: $($report.generated_at)",
  "- Status: **$status**",
  "- Base URL: $BaseUrl",
  "- App version: $($report.app_version)",
  "",
  "| Check | Severity | Result | Detail |",
  "|---|---:|---:|---|"
)
foreach ($check in $checks) {
  $result = if ($check.ok) { "OK" } else { "FAIL" }
  $detail = ($check.detail -replace "\|", "/")
  $lines += "| $($check.name) | $($check.severity) | $result | $detail |"
}
$lines += ""
$lines += "JSON report: $jsonPath"
$lines | Set-Content -Path $mdPath -Encoding UTF8

Write-Host "Preflight status: $status"
Write-Host "Markdown: $mdPath"
Write-Host "JSON: $jsonPath"

if ($OpenReport) {
  Start-Process $mdPath
}

if ($criticalFailures.Count -gt 0) {
  exit 2
}
