param(
  [string]$BaseUrl = "http://127.0.0.1:8765"
)

$ErrorActionPreference = "Stop"

$port = [int](([uri]$BaseUrl).Port)
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $listener) {
  [pscustomobject]@{
    Running = $false
    Url = $BaseUrl
    Message = "No process is listening on port $port."
  }
  return
}

try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/health" -TimeoutSec 3
  $readiness = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/readiness" -TimeoutSec 3
  $ready = $readiness.Content | ConvertFrom-Json
  [pscustomobject]@{
    Running = $true
    Url = $BaseUrl
    Pid = $listener.OwningProcess
    HealthStatus = $health.StatusCode
    Version = $ready.version
    Ready = $ready.ok
    PaperSafe = $ready.paper_safe
    Mode = $ready.mode
    AutoExecution = $ready.auto_execution_enabled
  }
  $ready.checks | Select-Object name, ok, detail | Format-Table -AutoSize
} catch {
  [pscustomobject]@{
    Running = $true
    Url = $BaseUrl
    Pid = $listener.OwningProcess
    Ready = $false
    Message = "Port is listening, but Trading OS health/readiness did not respond: $($_.Exception.Message)"
  }
}
