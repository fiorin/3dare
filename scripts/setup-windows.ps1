param([string]$RuntimeDirectory, [string]$ModelCacheDirectory)

$ErrorActionPreference = "Stop"

$PackageRoot = $PSScriptRoot
$RuntimeParts = @(Get-ChildItem -LiteralPath $PackageRoot -Filter "generation-runtime-part-*.zip" | Sort-Object Name)
$ManifestPath = Join-Path $PackageRoot "generation-runtime.sha256"
$Installer = Get-ChildItem -LiteralPath $PackageRoot -Filter "FormForge_*_x64-setup.exe" | Select-Object -First 1

if ($RuntimeParts.Count -eq 0) { throw "No generation runtime archives were found beside this script." }
if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "The runtime checksum manifest is missing." }
if (-not $Installer) { throw "The FormForge Windows installer was not found beside this script." }

$ExpectedHashes = @{}
foreach ($Line in Get-Content -LiteralPath $ManifestPath) {
    $Parts = $Line -split "\|", 2
    if ($Parts.Count -ne 2) { throw "Invalid checksum manifest line: $Line" }
    $ExpectedHashes[$Parts[0]] = $Parts[1]
}
foreach ($Archive in $RuntimeParts) {
    $ExpectedHash = $ExpectedHashes[$Archive.Name]
    if (-not $ExpectedHash) { throw "No checksum is recorded for $($Archive.Name)." }
    $ActualHash = (Get-FileHash -LiteralPath $Archive.FullName -Algorithm SHA256).Hash
    if ($ActualHash -ne $ExpectedHash) { throw "Checksum mismatch for $($Archive.Name). Re-download the package." }
}

$AppDataRoot = Join-Path $env:LOCALAPPDATA "local.formforge.image-to-stl"
if ([string]::IsNullOrWhiteSpace($RuntimeDirectory)) {
    $RuntimeDirectory = Join-Path $AppDataRoot "runtime"
}
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeDirectory)
$RuntimeDriveRoot = [System.IO.Path]::GetPathRoot($RuntimeRoot)
if ($RuntimeDriveRoot -notmatch "^[A-Za-z]:\\$") { throw "RuntimeDirectory must be on a local drive." }
$RuntimeDrive = Get-PSDrive -Name $RuntimeDriveRoot.Substring(0, 1)
$RequiredFreeBytes = [long](4.5 * 1GB)
if (Test-Path -LiteralPath $RuntimeRoot) { $RequiredFreeBytes = [long](9 * 1GB) }
if ($RuntimeDrive.Free -lt $RequiredFreeBytes) {
    throw "The runtime needs $([math]::Round($RequiredFreeBytes / 1GB, 1)) GB free on $RuntimeDriveRoot. Re-run with -RuntimeDirectory pointing to a drive with more space."
}
$RuntimeParent = Split-Path -Parent $RuntimeRoot
$StagingRoot = "$RuntimeRoot.next"
$PreviousRoot = "$RuntimeRoot.previous"
New-Item -ItemType Directory -Path $AppDataRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $RuntimeParent)) { New-Item -ItemType Directory -Path $RuntimeParent -Force | Out-Null }
if (Test-Path -LiteralPath $StagingRoot) {
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null

try {
    foreach ($Archive in $RuntimeParts) {
        Expand-Archive -LiteralPath $Archive.FullName -DestinationPath $StagingRoot -Force
    }
    $ServiceExe = Join-Path $StagingRoot "generation-service\generation-service.exe"
    $TripoSRSystem = Join-Path $StagingRoot "third_party\TripoSR\tsr\system.py"
    if (-not (Test-Path -LiteralPath $ServiceExe)) { throw "The packaged generation service is incomplete." }
    if (-not (Test-Path -LiteralPath $TripoSRSystem)) { throw "The pinned TripoSR source is missing from the runtime package." }

    if (Test-Path -LiteralPath $PreviousRoot) {
        Remove-Item -LiteralPath $PreviousRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $RuntimeRoot) {
        Move-Item -LiteralPath $RuntimeRoot -Destination $PreviousRoot
    }
    try {
        Move-Item -LiteralPath $StagingRoot -Destination $RuntimeRoot
    }
    catch {
        if ((Test-Path -LiteralPath $PreviousRoot) -and -not (Test-Path -LiteralPath $RuntimeRoot)) {
            Move-Item -LiteralPath $PreviousRoot -Destination $RuntimeRoot
        }
        throw
    }
    if (Test-Path -LiteralPath $PreviousRoot) {
        Remove-Item -LiteralPath $PreviousRoot -Recurse -Force
    }
}
finally {
    if (Test-Path -LiteralPath $StagingRoot) {
        Remove-Item -LiteralPath $StagingRoot -Recurse -Force
    }
}

$Install = Start-Process -FilePath $Installer.FullName -ArgumentList "/S" -Wait -PassThru
if ($Install.ExitCode -ne 0) { throw "FormForge installer failed with exit code $($Install.ExitCode)." }

$RuntimePathFile = Join-Path $AppDataRoot "runtime-path.txt"
[System.IO.File]::WriteAllText($RuntimePathFile, $RuntimeRoot, [System.Text.UTF8Encoding]::new($false))

if (-not [string]::IsNullOrWhiteSpace($ModelCacheDirectory)) {
    $ModelCacheRoot = [System.IO.Path]::GetFullPath($ModelCacheDirectory)
    $ModelCacheDriveRoot = [System.IO.Path]::GetPathRoot($ModelCacheRoot)
    if ($ModelCacheDriveRoot -notmatch "^[A-Za-z]:\\$") { throw "ModelCacheDirectory must be on a local drive." }
    $ModelCacheDrive = Get-PSDrive -Name $ModelCacheDriveRoot.Substring(0, 1)
    if ($ModelCacheDrive.Free -lt [long](2.5 * 1GB)) {
        throw "The model cache needs at least 2.5 GB free on $ModelCacheDriveRoot. Choose another drive."
    }
    New-Item -ItemType Directory -Path $ModelCacheRoot -Force | Out-Null
    $ModelCachePathFile = Join-Path $AppDataRoot "model-cache-path.txt"
    [System.IO.File]::WriteAllText($ModelCachePathFile, $ModelCacheRoot, [System.Text.UTF8Encoding]::new($false))
}


Write-Host "FormForge and its local generation runtime are installed for the current user."
Write-Host "Launch FormForge from the Start menu. Model weights download on first generation and remain in local application data."
