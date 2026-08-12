param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
$cloudflared = Join-Path $dist 'cloudflared-386.exe'
$node = Join-Path $root 'runtime\node\node.exe'
$log = Join-Path $dist 'cloudflared.err.log'
$urlFile = Join-Path $dist 'latest-url.txt'

if (-not (Test-Path -LiteralPath $cloudflared)) {
  throw "Cloudflared executable not found: $cloudflared"
}
if (-not (Test-Path -LiteralPath $node)) { $node = 'node.exe' }

Get-Process -Name 'cloudflared-386' -ErrorAction SilentlyContinue | Stop-Process -Force

$service = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $service) {
  Start-Process -FilePath $node -ArgumentList 'src/server.mjs' -WorkingDirectory $root -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch {}
  }
  if (-not $ready) { throw 'Workbench service did not start within 10 seconds.' }
}

Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $cloudflared -ArgumentList 'tunnel --url http://127.0.0.1:4317 --no-autoupdate' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError $log

$url = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $log) {
    $text = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
    $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($match.Success) { $url = $match.Value; break }
  }
}

if (-not $url) { throw 'Cloudflare tunnel did not create a URL within 30 seconds. Check dist\cloudflared.err.log.' }

Set-Content -LiteralPath $urlFile -Value $url -Encoding UTF8
Write-Host ''
Write-Host 'Temporary workbench is ready:' -ForegroundColor Green
Write-Host $url -ForegroundColor Cyan
Write-Host ''
Write-Host "URL saved to: $urlFile"
Start-Process $url
