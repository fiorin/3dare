# Repository Guidelines

## Project Structure & Module Organization

`apps/desktop/` contains the React, TypeScript, Vite, and Tauri desktop application. UI features live in `src/features/`, shared API calls in `src/services/`, and native Rust setup in `src-tauri/`. `services/generation/` is the localhost FastAPI service; its implementation is in `app/` and its tests are in `tests/`. Windows setup and packaging scripts are in `scripts/`; design notes are in `docs/`. `data/`, `models/`, `dist/`, and `third_party/` contain generated artifacts, model-related files, release outputs, and vendored dependencies. Avoid committing generated data, model weights, or build output.

## Build, Test, and Development Commands

Run desktop commands from `apps/desktop/`:

- `npm install` installs JavaScript dependencies.
- `npm run dev` starts the Vite development server at `127.0.0.1:1420`.
- `npm run build` runs TypeScript project checks and creates the production web build.
- `npm run tauri dev` launches the desktop shell during development.

Run the service commands from `services/generation/` using the root Phase 0 environment:

- `..\..\.venv-phase0\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8765` starts the local API.
- `..\..\.venv-phase0\Scripts\python.exe -m pytest .\tests -q` runs service tests.
- `..\..\.venv-phase0\Scripts\python.exe ..\..\scripts\phase1_smoke.py` exercises the real generation path.

## Coding Style & Naming Conventions

Follow existing conventions: TypeScript/React components use PascalCase filenames and component names; functions and variables use camelCase. Python modules and functions use `snake_case`; tests use `test_*.py`. Keep UI styles alongside their feature component. Use the existing TypeScript configuration and pinned Python requirements; no separate formatter or linter is configured in the desktop package.

## Testing Guidelines

Add or update focused tests under `services/generation/tests/` for API and job behavior. Run the pytest command above after service changes. For desktop changes, run `npm run build` to catch TypeScript and bundling errors. The provider smoke test invokes actual model inference and may require a configured GPU and cached model weights.

## Commits & Pull Requests

This checkout has no Git metadata, so repository commit message conventions cannot be verified. Use a concise imperative commit subject (for example, `Handle cancelled generation jobs`). Pull requests should describe user-visible changes, list validation commands and results, link related issues when available, and include screenshots for visual desktop changes.

## Security & Configuration

Keep the generation API bound to `127.0.0.1`; do not expose it on a network interface. Do not commit credentials, model weights, virtual environments, or generated user data. Follow the Windows setup documentation for local model and runtime configuration.
