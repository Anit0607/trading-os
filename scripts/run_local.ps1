$ErrorActionPreference = "Stop"
Set-Location "D:\Codex_Scanner\trading_os"

$bundledPython = "C:\Users\ANIT BOSE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if (Test-Path $bundledPython) {
  & $bundledPython -m app.main
} else {
  python -m app.main
}
