# FormForge

FormForge is a Windows desktop application for turning a single image into a 3D model locally. It uses TripoSR for image-to-3D generation, previews the resulting GLB, lets you set a target model height in millimeters, and exports binary STL.

> FormForge creates geometry for further editing. It does not automatically repair meshes or prepare a print-ready project.

## Features

- Local image generation through a loopback-only service; no cloud inference or user account.
- PNG, JPEG, and WebP input (up to 20 MiB).
- CUDA inference with an explicit CPU option.
- Interactive 3D preview with orbit, pan, zoom, and camera reset.
- Proportional millimeter scaling and binary STL export.
- Windows installer and separately managed generation runtime.

## Windows installation

Use the complete release folder from `dist/windows/` (installer, all runtime ZIP parts, checksum manifest, and setup scripts). In PowerShell, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
```

The runtime needs at least 4.5 GB free on its destination drive. To choose separate runtime and model-cache locations:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1 `
  -RuntimeDirectory E:\FormForgeRuntime `
  -ModelCacheDirectory E:\FormForgeModels
```

The first generation downloads the approximately 1.68 GB TripoSR checkpoint and DINO image-tokenizer configuration to the local Hugging Face cache. This download is required once; inference runs locally and cached models can be reused offline. Use `scripts/diagnose-windows.ps1` for local service and GPU diagnostics.

## Development

### Requirements

- Windows 10/11 x64
- Node.js and npm
- Rust toolchain required by Tauri
- Python 3.10 x64 and the Phase 0 environment for local generation
- NVIDIA GPU recommended; the tested target is a GTX 1060 3 GB, with limited VRAM headroom

Set up the Python/model environment from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-phase0.ps1
```

Start the desktop app from `apps/desktop/`:

```powershell
npm install
npm run tauri dev
```

Build the frontend from `apps/desktop/`:

```powershell
npm run build
```

Run service tests from the repository root:

```powershell
.\.venv-phase0\Scripts\python.exe -m pytest .\services\generation\tests -q
```

Build the Windows release package from the root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1
```

## Architecture

```text
apps/desktop/           Tauri 2 + React/TypeScript interface and Three.js viewer
services/generation/    Local FastAPI job API and TripoSR provider
scripts/                Windows setup, packaging, smoke, and diagnostics tools
third_party/            Pinned upstream model/runtime source where applicable
data/                   Local uploads and generated models
```

The desktop shell manages the generation service on `127.0.0.1:8765`. The service accepts one generation job at a time, reports progress, and stores uploaded images and generated GLBs locally.

## Known limitations

- Image encoding uses TripoSR’s fixed input representation. Higher mesh sampling resolution does not restore image details the model did not capture; clear, centered images with visible subject boundaries generally give the model better input.
- The tested GTX 1060 has 3 GB VRAM and little spare capacity. Close GPU-heavy applications before generation.
- Neural inference runs on CUDA, while marching-cubes mesh extraction uses the CPU fallback in the current setup.
- Generated meshes may be non-watertight. STL export scales geometry but does not repair it, add supports or a base, hollow it, or assess printability.
- A running model kernel cannot be interrupted immediately; cancellation takes effect at a pipeline boundary.
- Clean-machine installer validation and interactive OS save-dialog verification remain outstanding.

## Models and licensing

Model weights are not included in the installer or repository. The first-run download is subject to the terms shown on the upstream [TripoSR model page](https://huggingface.co/stabilityai/TripoSR). Review the upstream model and dependency licenses before redistribution. The project does not commit model weights; see `models/README.md` for cache behavior.

## Status

The implementation and current validation notes are maintained in `docs/progress.md` (that directory is excluded by this repository’s `.gitignore`).
