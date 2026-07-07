param(
  [string]$BaseUrl = "http://127.0.0.1:8765"
)

$ErrorActionPreference = "Stop"

Write-Host "Trading OS Dhan token refresh" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl"
Write-Host ""

$before = Invoke-RestMethod -Uri "$BaseUrl/api/dhan/token/status" -Method Get

[PSCustomObject]@{
  Source = $before.source
  ClientIdPresent = $before.client_id_present
  EnvTokenPresent = $before.env_token_present
  ManagedTokenPresent = $before.managed_token_present
  ManagedTokenExpiry = $before.managed_token_expiry
  RenewPossible = $before.renew_possible
  TotpGenerationPossible = $before.totp_generation_possible
  ConsentFlowPossible = $before.consent_flow_possible
} | Format-List

$result = Invoke-RestMethod -Uri "$BaseUrl/api/dhan/token/refresh" -Method Post

if ($result.ok) {
  Write-Host "Refresh OK via $($result.method)" -ForegroundColor Green
  if ($result.token.expires_at) {
    Write-Host "Managed token expires at: $($result.token.expires_at)"
  }
} else {
  Write-Host "Refresh failed safely." -ForegroundColor Yellow
  Write-Host $result.message
  if ($result.errors) {
    $result.errors | ConvertTo-Json -Depth 8
  }
}

Write-Host ""
Write-Host "No token value was printed." -ForegroundColor DarkGray
