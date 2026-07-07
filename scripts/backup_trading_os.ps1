param(
  [string]$ProjectRoot = "D:\Codex_Scanner\trading_os",
  [string]$BackupDir = "D:\Codex_Scanner\trading_os\backups",
  [switch]$IncludeSecrets
)

$ErrorActionPreference = "Stop"

Set-Location $ProjectRoot
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "trading_os_backup_$stamp"
$payloadRoot = Join-Path $tempRoot "trading_os"
$zipPath = Join-Path $BackupDir "trading_os_backup_$stamp.zip"

if (Test-Path $tempRoot) {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null

foreach ($name in @("app", "config", "docs", "scripts", "tests")) {
  $source = Join-Path $ProjectRoot $name
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $payloadRoot $name) -Recurse -Force
  }
}

foreach ($name in @("README.md", ".env.example", ".gitignore")) {
  $source = Join-Path $ProjectRoot $name
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $payloadRoot $name) -Force
  }
}

$dataPayload = Join-Path $payloadRoot "data"
New-Item -ItemType Directory -Force -Path $dataPayload | Out-Null

$paperDb = Join-Path $ProjectRoot "data\trading_os.db"
if (Test-Path $paperDb) {
  Copy-Item -LiteralPath $paperDb -Destination (Join-Path $dataPayload "trading_os.db") -Force
}

foreach ($relativePath in @("data\paper", "data\scanner")) {
  $source = Join-Path $ProjectRoot $relativePath
  if (Test-Path $source) {
    $destination = Join-Path $payloadRoot $relativePath
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
  }
}

if ($IncludeSecrets) {
  foreach ($relativePath in @(".env", "data\dhan")) {
    $source = Join-Path $ProjectRoot $relativePath
    if (Test-Path $source) {
      $destination = Join-Path $payloadRoot $relativePath
      New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
      Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
  }
}

$manifest = [pscustomobject]@{
  generated_at = (Get-Date).ToString("o")
  project_root = $ProjectRoot
  include_secrets = [bool]$IncludeSecrets
  excluded_by_default = @(".env", "data\dhan\token_state.json", "data\dhan\latest_broker_snapshot.json", "data\dhan\api-scrip-master-detailed.csv")
  notes = @(
    "Default backup excludes secrets and Dhan broker cache.",
    "Use -IncludeSecrets only for an encrypted/private backup location."
  )
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $payloadRoot "backup_manifest.json") -Encoding UTF8

Compress-Archive -LiteralPath (Join-Path $tempRoot "trading_os") -DestinationPath $zipPath -Force
Remove-Item -LiteralPath $tempRoot -Recurse -Force

$item = Get-Item $zipPath
[pscustomobject]@{
  BackupPath = $item.FullName
  SizeMB = [math]::Round($item.Length / 1MB, 2)
  IncludeSecrets = [bool]$IncludeSecrets
}
