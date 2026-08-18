param(
  [string]$ApiKey,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
$restoreLocation = $true
$runtime = Join-Path $root 'runtime'
$nodeDir = Join-Path $runtime 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'
$npmCmd = Join-Path $nodeDir 'npm.cmd'
$envFile = Join-Path $root '.env'

function Write-Step([string]$message) { Write-Host "[Xiaoe Grader] $message" -ForegroundColor Cyan }
function Download-File([string]$url, [string]$path) {
  Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root 'dist') | Out-Null

if (-not (Test-Path -LiteralPath $nodeExe)) {
  Write-Step 'Downloading local Node runtime...'
  $zip = Join-Path $runtime 'node.zip'
  Download-File 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip' $zip
  $extract = Join-Path $runtime 'node-extract'
  Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $source = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
  Move-Item -LiteralPath $source.FullName -Destination $nodeDir -Force
  Remove-Item -LiteralPath $zip, $extract -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $envFile)) {
  if (-not $ApiKey) { $ApiKey = Read-Host 'Paste the organization API key for this computer' }
  if (-not $ApiKey) { throw 'An API key is required to run AI grading.' }
  @(
    'XIAOE_GRADER_MODEL_BASE_URL=https://api.anmoxuan.xyz/v1',
    'XIAOE_GRADER_MODEL_NAME=gpt-5.6-terra',
    "XIAOE_GRADER_MODEL_API_KEY=$ApiKey"
  ) | Set-Content -LiteralPath $envFile -Encoding ASCII
}

Write-Step 'Installing application dependencies...'
& $npmCmd 'install' '--omit=dev'
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
& $npmCmd 'run' 'package-extension'
if ($LASTEXITCODE -ne 0) { throw 'Extension package build failed.' }

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'Xiaoe Grader.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = Join-Path $root 'start-local.bat'
$link.WorkingDirectory = $root
$link.Description = 'Start Xiaoe homework grading workbench'
$link.Save()

Write-Host ''
Write-Host 'Installation complete.' -ForegroundColor Green
Write-Host 'You can now start grading from the desktop shortcut.' -ForegroundColor Green
Write-Host 'Optional: to use browser-internal execution later, load this extension folder in Chrome or Edge:' -ForegroundColor Yellow
Write-Host (Join-Path $root 'extension') -ForegroundColor Cyan
Write-Host ''

if (-not $NoBrowser) {
  Start-Process (Join-Path $root 'start-local.bat')
}

if ($restoreLocation) { Pop-Location }
