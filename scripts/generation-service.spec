# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, copy_metadata

SPEC_DIR = Path(SPECPATH).resolve()
PROJECT_ROOT = SPEC_DIR.parent
SERVICE_ROOT = PROJECT_ROOT / "services" / "generation"
TRIPOSR_ROOT = PROJECT_ROOT / "third_party" / "TripoSR"

sys.path.insert(0, str(SERVICE_ROOT))
sys.path.insert(0, str(TRIPOSR_ROOT))

hiddenimports = set(collect_submodules("tsr"))
hiddenimports.update(collect_submodules("rembg"))
hiddenimports.update(
    {
        "torchmcubes",
        "xatlas",
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    }
)

package_metadata = copy_metadata("pymatting", recursive=True) + copy_metadata("rembg")

a = Analysis(
    [str(SERVICE_ROOT / "entrypoint.py")],
    pathex=[str(SERVICE_ROOT), str(TRIPOSR_ROOT)],
    binaries=[],
    datas=package_metadata,
    hiddenimports=sorted(hiddenimports),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "tests", "tkinter", "notebook"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="generation-service",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="generation-service",
)
