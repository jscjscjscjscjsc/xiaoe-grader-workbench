$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'xiaoe-grader-extension'
$zip = Join-Path $dist 'xiaoe-grader-extension.zip'

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item -Path (Join-Path $root 'extension\*') -Destination $stage -Recurse -Force
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force

Write-Host "Extension package built: $zip"
$zipInfo = Get-Item $zip
Write-Host "Size: $($zipInfo.Length) bytes"
