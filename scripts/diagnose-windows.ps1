$ErrorActionPreference = "Continue"

$AppRoot = Join-Path $env:LOCALAPPDATA "local.formforge.image-to-stl"
$AppData = Join-Path $AppRoot "data"
$LogPath = Join-Path $AppData "logs\generation-service.log"
$HealthUrl = "http://127.0.0.1:8765/api/v1/health"
$Healthy = $false

Write-Host "FormForge local diagnostics"
Write-Host "Application data: $AppData"
$ModelCachePathFile = Join-Path $AppRoot "model-cache-path.txt"
$ModelCache = $env:HF_HOME
if (Test-Path -LiteralPath $ModelCachePathFile) { $ModelCache = Get-Content -LiteralPath $ModelCachePathFile -Raw }
if ([string]::IsNullOrWhiteSpace($ModelCache)) { $ModelCache = Join-Path $env:USERPROFILE ".cache\huggingface" }
Write-Host "Model weight cache: $ModelCache"

try {
    $Health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 4
    $Health | Format-List status, model_loaded, cuda_available, gpu_name, vram_total_mib, vram_free_mib
    $Healthy = $true
}
catch {
    Write-Warning "The local generation service did not respond at $HealthUrl. Open FormForge and retry."
}

$NvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($NvidiaSmi) {
    & $NvidiaSmi.Source --query-gpu=name,memory.total,driver_version --format=csv,noheader
}
else {
    Write-Host "nvidia-smi is not on PATH; GPU status above comes from the local service when available."
}

if (Test-Path -LiteralPath $LogPath) {
    Write-Host "Recent service log ($LogPath):"
    Get-Content -LiteralPath $LogPath -Tail 60
}
else {
    Write-Host "No service log exists yet: $LogPath"
}

if (-not $Healthy) { exit 1 }
