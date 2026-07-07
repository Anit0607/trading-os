param(
  [string]$BaseUrl = "http://127.0.0.1:8765"
)

$ErrorActionPreference = "Stop"

Write-Host "Trading OS Dhan read-only check" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl"

$health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -Method Get
$config = $health.config

[PSCustomObject]@{
  Mode = $config.mode
  AutoExecutionEnabled = $config.auto_execution_enabled
  DhanClientIdPresent = $config.dhan_client_id_present
  DhanAccessTokenPresent = $config.dhan_access_token_present
} | Format-List

$tokenStatus = Invoke-RestMethod -Uri "$BaseUrl/api/dhan/token/status" -Method Get

[PSCustomObject]@{
  TokenSource = $tokenStatus.source
  EnvTokenPresent = $tokenStatus.env_token_present
  ManagedTokenPresent = $tokenStatus.managed_token_present
  ManagedTokenExpiry = $tokenStatus.managed_token_expiry
  TotpGenerationPossible = $tokenStatus.totp_generation_possible
} | Format-List

$status = Invoke-RestMethod -Uri "$BaseUrl/api/dhan/status" -Method Get

Write-Host "Dhan status: $($status.ok)" -ForegroundColor ($(if ($status.ok) { "Green" } else { "Yellow" }))
Write-Host "Order placement: $($status.order_placement)"
Write-Host ""

$status.endpoints.PSObject.Properties | ForEach-Object {
  $name = $_.Name
  $value = $_.Value
  if ($value.ok) {
    $detail = if ($value.count -ne $null) { "count=$($value.count)" } else { "keys=$($value.keys -join ',')" }
    Write-Host "${name}: OK ($detail)" -ForegroundColor Green
  } else {
    Write-Host "${name}: FAILED $($value.status_code) $($value.payload.errorCode) - $($value.payload.errorMessage)" -ForegroundColor Yellow
  }
}
