param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $root 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = 'node.exe' }

$service = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $service) {
  Start-Process -FilePath $node -ArgumentList 'src/server.mjs' -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2 | Out-Null; break } catch {}
  }
}
Start-Process 'http://127.0.0.1:4317'
