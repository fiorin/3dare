$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Python = Join-Path $Root ".venv-phase0\Scripts\python.exe"
$ServiceSource = Join-Path $Root "third_party\TripoSR"
$ServiceDist = Join-Path $Root "services\generation\dist"
$BuildWork = Join-Path $Root "apps\desktop\src-tauri\target\pyinstaller-work"
$RuntimeStage = Join-Path $Root "apps\desktop\src-tauri\target\windows-runtime-stage"
$RuntimeRoot = Join-Path $RuntimeStage "runtime"
$PackageRoot = Join-Path $Root "dist\windows"
$MaxPartSize = [long](1.5 * 1GB)

if (-not (Test-Path -LiteralPath $Python)) {
    throw "The Phase 0 Python environment is missing. Run scripts\setup-phase0.ps1 first."
}
if (-not (Test-Path -LiteralPath (Join-Path $ServiceSource "tsr\system.py"))) {
    throw "Pinned TripoSR source is missing. Run scripts\setup-phase0.ps1 first."
}
$NsisRoot = Join-Path ${env:ProgramFiles(x86)} "NSIS"
if (-not (Get-Command makensis.exe -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath (Join-Path $NsisRoot "makensis.exe"))) {
    $env:Path = "$NsisRoot;$env:Path"
}
if (-not (Get-Command makensis.exe -ErrorAction SilentlyContinue)) {
    throw "NSIS is required. Install NSIS 3.13 and ensure makensis.exe is on PATH."
}

& $Python -m pip install -r (Join-Path $Root "requirements-packaging.txt")
if ($LASTEXITCODE -ne 0) { throw "Could not install the pinned packaging tools." }

if (Test-Path -LiteralPath $ServiceDist) {
    Remove-Item -LiteralPath $ServiceDist -Recurse -Force
}
New-Item -ItemType Directory -Path $ServiceDist -Force | Out-Null
& $Python -m PyInstaller `
    --noconfirm `
    --clean `
    --distpath $ServiceDist `
    --workpath $BuildWork `
    (Join-Path $PSScriptRoot "generation-service.spec")
if ($LASTEXITCODE -ne 0) { throw "The local generation-service bundle failed to build." }

$BuiltService = Join-Path $ServiceDist "generation-service"
$ServiceExe = Join-Path $BuiltService "generation-service.exe"
if (-not (Test-Path -LiteralPath $ServiceExe)) {
    throw "PyInstaller completed without producing the expected service executable: $ServiceExe"
}

if (Test-Path -LiteralPath $RuntimeStage) {
    Remove-Item -LiteralPath $RuntimeStage -Recurse -Force
}
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
Copy-Item -LiteralPath $BuiltService -Destination (Join-Path $RuntimeRoot "generation-service") -Recurse
$TripoSRRuntime = Join-Path $RuntimeRoot "third_party\TripoSR"
New-Item -ItemType Directory -Path $TripoSRRuntime -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ServiceSource "tsr") -Destination $TripoSRRuntime -Recurse
Copy-Item -LiteralPath (Join-Path $ServiceSource "LICENSE") -Destination (Join-Path $TripoSRRuntime "LICENSE")
Get-ChildItem -LiteralPath $TripoSRRuntime -Directory -Filter "__pycache__" -Recurse | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $TripoSRRuntime -File -Filter "*.pyc" -Recurse | Remove-Item -Force

if (Test-Path -LiteralPath $PackageRoot) {
    Remove-Item -LiteralPath $PackageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $PackageRoot -Force | Out-Null

Push-Location (Join-Path $Root "apps\desktop")
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "The desktop frontend build failed." }
    npm run tauri -- build --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "The Windows NSIS installer build failed." }
}
finally {
    Pop-Location
}

$InstallerSource = Get-ChildItem -LiteralPath (Join-Path $Root "apps\desktop\src-tauri\target\release\bundle\nsis") -Filter "FormForge_*_x64-setup.exe" | Select-Object -First 1
if (-not $InstallerSource) { throw "The Tauri build did not produce a FormForge NSIS installer." }
Copy-Item -LiteralPath $InstallerSource.FullName -Destination $PackageRoot

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$RuntimeFiles = @(Get-ChildItem -LiteralPath $RuntimeRoot -File -Recurse | Sort-Object FullName)
$Groups = New-Object System.Collections.ArrayList
$CurrentGroup = New-Object System.Collections.Generic.List[System.IO.FileInfo]
$CurrentSize = [long]0
foreach ($File in $RuntimeFiles) {
    if ($File.Length -gt $MaxPartSize) {
        throw "Runtime file exceeds the archive part limit: $($File.FullName)"
    }
    if ($CurrentSize -gt 0 -and ($CurrentSize + $File.Length) -gt $MaxPartSize) {
        [void]$Groups.Add($CurrentGroup.ToArray())
        $CurrentGroup = New-Object System.Collections.Generic.List[System.IO.FileInfo]
        $CurrentSize = [long]0
    }
    $CurrentGroup.Add($File)
    $CurrentSize += $File.Length
}
if ($CurrentGroup.Count -gt 0) { [void]$Groups.Add($CurrentGroup.ToArray()) }

$ManifestPath = Join-Path $PackageRoot "generation-runtime.sha256"
Set-Content -LiteralPath $ManifestPath -Value @() -Encoding ascii
for ($Index = 0; $Index -lt $Groups.Count; $Index++) {
    $PartName = "generation-runtime-part-{0:D2}.zip" -f ($Index + 1)
    $PartPath = Join-Path $PackageRoot $PartName
    $Archive = [System.IO.Compression.ZipFile]::Open($PartPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($File in $Groups[$Index]) {
            $RelativePath = $File.FullName.Substring($RuntimeRoot.Length).TrimStart('\').Replace('\', '/')
            $Entry = $Archive.CreateEntry($RelativePath, [System.IO.Compression.CompressionLevel]::Fastest)
            $InputStream = $File.OpenRead()
            $OutputStream = $Entry.Open()
            try { $InputStream.CopyTo($OutputStream) }
            finally {
                $OutputStream.Dispose()
                $InputStream.Dispose()
            }
        }
    }
    finally {
        $Archive.Dispose()
    }
    $Hash = (Get-FileHash -LiteralPath $PartPath -Algorithm SHA256).Hash
    Add-Content -LiteralPath $ManifestPath -Value "$PartName|$Hash" -Encoding ascii
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot "setup-windows.ps1") -Destination $PackageRoot
Copy-Item -LiteralPath (Join-Path $Root "models\README.md") -Destination (Join-Path $PackageRoot "MODEL-WEIGHTS.txt")
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "diagnose-windows.ps1") -Destination $PackageRoot
@(
    "FormForge for Windows x64"
    ""
    "Keep this folder intact and run setup-windows.ps1 from PowerShell. It verifies the runtime ZIP checksums, installs the local service runtime, and installs the desktop app for the current user."
    ""
    "The runtime requires at least 4.5 GB free on its destination drive. If the system drive is short on space, run:"
    "powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1 -RuntimeDirectory E:\FormForgeRuntime"
    ""
    "The first generation requires an internet connection to download the approximately 1.68 GB TripoSR checkpoint. Inference remains local. Later generations can run offline from the cached weights. If C: lacks 2.5 GB free, pass -ModelCacheDirectory E:\FormForgeModels to setup-windows.ps1."
    ""
    "The checkpoint is not redistributed by this package. Review MODEL-WEIGHTS.txt and the Hugging Face model card for its license terms."
) | Set-Content -LiteralPath (Join-Path $PackageRoot "README.txt") -Encoding utf8
Write-Host "Windows package set created in $PackageRoot"
Write-Host "Run setup-windows.ps1 from this folder. The runtime is split into $($Groups.Count) ZIP parts to avoid the NSIS 2 GiB installer limit."
Write-Host "TripoSR weights are not bundled; first generation downloads them into the user's local application-data cache."
