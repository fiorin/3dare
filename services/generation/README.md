# Local generation service

Phase 1 provides a loopback-only FastAPI service that manages one TripoSR job at a time. It reuses the pinned Phase 0 provider and stores uploads and outputs under `data/`.

## Install and run

Use the Phase 0 virtual environment, which includes PyTorch/TripoSR, then install the API dependencies:

```powershell
& ..\..\.venv-phase0\Scripts\python.exe -m pip install -r .\requirements.txt
```

From `services/generation`:

```powershell
..\..\.venv-phase0\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```

The API binds to localhost. Swagger docs are available at `http://127.0.0.1:8765/docs`.

To run a one-shot integration check through the actual TripoSR provider and API routes (takes about 20 seconds after the model checkpoint is cached):

```powershell
..\..\.venv-phase0\Scripts\python.exe ..\..\scripts\phase1_smoke.py
```

## API v1

- `GET /api/v1/health` — CUDA/GPU/VRAM and model-load status.
- `POST /api/v1/jobs` — multipart `image` plus JSON-string `options` form field; returns a queued job.
- `GET /api/v1/jobs/{job_id}` — status, stage, progress, errors, and local model path.
- `POST /api/v1/jobs/{job_id}/cancel` — cancel a queued job or request cancellation between generation stages.
- `GET /api/v1/jobs/{job_id}/model` — download a completed GLB.

Cross-origin access is limited to the Tauri desktop origin and the local Vite development origin. The service remains bound to `127.0.0.1`.

The default settings match the tested low-memory profile (`chunk_size=128`, `mc_resolution=128`, CUDA). CPU inference is only selected when the request explicitly sets `device=cpu`; CUDA errors do not silently switch devices. A running TripoSR kernel cannot be interrupted mid-stage, but the job is cancelled at the next progress boundary.

Job state is held in memory for the service lifetime. Input images and GLB files remain on disk under `data/projects/` and `data/generated/`. Only PNG, JPEG, and WebP images up to 20 MiB are accepted. Generation runs in a single worker to prevent simultaneous model instances on the 3 GB GPU.

The actual TripoSR provider completed a chair-image job through these API routes on the GTX 1060: the API returned `completed`, the downloaded GLB was 410,172 bytes, and `trimesh` reopened it as 10,257 vertices and 20,420 faces.

## Windows packaging

`scripts/package-windows.ps1` builds the one-folder generation service with PyInstaller, creates a per-user Tauri NSIS installer, and emits SHA-256-verified runtime ZIP parts beside it. Distribute the complete `dist/windows/` folder and run `powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1` from that folder. The setup script verifies and extracts the Python service/runtime, then installs the desktop app without requiring a system Python or manual Python commands. Runtime files default to `%LOCALAPPDATA%\local.formforge.image-to-stl\runtime`; pass `-RuntimeDirectory E:\FormForgeRuntime` when the system drive lacks space. Model weights/config are not bundled; first generation downloads the TripoSR checkpoint and DINO image-tokenizer config to Hugging Face's user cache. Pass `-ModelCacheDirectory E:\FormForgeModels` during setup to place cached assets on another drive. Run `scripts/diagnose-windows.ps1` for health, GPU, and service-log diagnostics.

## Tests

```powershell
..\..\.venv-phase0\Scripts\python.exe -m pip install -r .\requirements.txt
..\..\.venv-phase0\Scripts\python.exe -m pytest .\tests -q
```
