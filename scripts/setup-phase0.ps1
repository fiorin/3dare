$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ThirdParty = Join-Path $Root "third_party"
$TripoSRPath = Join-Path $ThirdParty "TripoSR"
$TorchMCubesPath = Join-Path $ThirdParty "torchmcubes"
$VenvPath = Join-Path $Root ".venv-phase0"
$Python = Join-Path $VenvPath "Scripts\python.exe"

$TripoSRCommit = "107cefdc244c39106fa830359024f6a2f1c78871"
$TorchMCubesCommit = "a9ac95aa329957ba646e7bb057f825f5dfa77f38"

function Sync-PinnedRepo([string]$Url, [string]$Path, [string]$Commit) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path ".git"))) {
        if (Test-Path -LiteralPath $Path) {
            throw "Refusing to replace existing non-git directory: $Path"
        }
        git clone --no-checkout $Url $Path
        if ($LASTEXITCODE -ne 0) { throw "git clone failed: $Url" }
    }

    git -C $Path fetch --depth 1 origin $Commit
    if ($LASTEXITCODE -ne 0) { throw "Could not fetch pinned commit $Commit from $Url" }
    git -C $Path checkout --detach $Commit
    if ($LASTEXITCODE -ne 0) { throw "Could not check out pinned commit $Commit in $Path" }
}

py -3.10 -c "import sys; assert sys.version_info[:2] == (3, 10), sys.version"
if ($LASTEXITCODE -ne 0) {
    throw "Install Python 3.10 x64 first (for example: winget install --id Python.Python.3.10 --exact --scope user)."
}

New-Item -ItemType Directory -Path $ThirdParty -Force | Out-Null
Sync-PinnedRepo "https://github.com/VAST-AI-Research/TripoSR.git" $TripoSRPath $TripoSRCommit
Sync-PinnedRepo "https://github.com/tatsy/torchmcubes.git" $TorchMCubesPath $TorchMCubesCommit

if (-not (Test-Path -LiteralPath $Python)) {
    py -3.10 -m venv $VenvPath
    if ($LASTEXITCODE -ne 0) { throw "Could not create the Phase 0 virtual environment." }
}

& $Python -m pip install -r (Join-Path $Root "requirements-phase0.txt")
if ($LASTEXITCODE -ne 0) { throw "Phase 0 Python dependencies failed to install." }

# torchmcubes must be built against the same PyTorch ABI. The CUDA wheel
# includes runtime libraries but not nvcc, so build its CPU fallback against
# the matching CPU wheel, then replace it with the CUDA wheel of the same 2.1.x
# release. The extension handles CUDA tensors by copying the marching-cubes
# volume to CPU, which is the upstream-supported fallback.
& $Python -m pip install --force-reinstall --no-deps torch==2.1.2 --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw "Could not install the temporary CPU PyTorch build." }

$TorchMCubesBuild = Join-Path $TorchMCubesPath "build"
if (Test-Path -LiteralPath $TorchMCubesBuild) {
    Remove-Item -LiteralPath $TorchMCubesBuild -Recurse -Force
}
& $Python -m pip install --no-build-isolation $TorchMCubesPath
if ($LASTEXITCODE -ne 0) {
    throw "torchmcubes build failed. Install Visual Studio Build Tools with the C++ workload and Windows SDK."
}

& $Python -m pip install --force-reinstall --no-deps torch==2.1.2+cu121 torchvision==0.16.2+cu121 --index-url https://download.pytorch.org/whl/cu121
if ($LASTEXITCODE -ne 0) { throw "Could not install the CUDA 12.1 PyTorch wheels." }

& $Python -m pip check
if ($LASTEXITCODE -ne 0) { throw "The Phase 0 Python environment has dependency conflicts." }
& $Python -c "import torch, torchmcubes; print('torch:', torch.__version__); print('CUDA:', torch.version.cuda, torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'unavailable'); print('torchmcubes CUDA extension:', torchmcubes.HAS_CUDA)"
if ($LASTEXITCODE -ne 0) { throw "Phase 0 environment validation failed." }

Write-Host "Phase 0 environment ready. Run scripts\phase0_infer.py to generate the sample STL."
