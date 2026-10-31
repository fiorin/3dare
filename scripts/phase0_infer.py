"""Run one reduced-memory TripoSR inference and export a binary STL."""

from __future__ import annotations

import argparse
import gc
import json
import logging
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
TRIPOSR = ROOT / "third_party" / "TripoSR"
sys.path.insert(0, str(TRIPOSR))

from tsr.system import TSR  # noqa: E402
from tsr.utils import remove_background, resize_foreground  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--image", type=Path, default=TRIPOSR / "examples" / "chair.png"
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / "data" / "phase0" / "chair.stl"
    )
    parser.add_argument("--chunk-size", type=int, default=128)
    parser.add_argument("--mc-resolution", type=int, default=128)
    return parser.parse_args()


def prepare_image(image_path: Path) -> Image.Image:
    image = Image.open(image_path)
    has_alpha = image.mode == "RGBA" and image.getextrema()[3][0] < 255
    if not has_alpha:
        import rembg

        image = remove_background(image, rembg.new_session())
    image = resize_foreground(image, 0.85)
    pixels = np.asarray(image).astype(np.float32) / 255.0
    rgb = pixels[..., :3] * pixels[..., 3:4] + (1.0 - pixels[..., 3:4]) * 0.5
    return Image.fromarray((rgb * 255.0).astype(np.uint8))


def display_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not args.image.is_file():
        raise FileNotFoundError(args.image)
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; this Phase 0 run requires the GTX 1060.")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    device = "cuda:0"
    props = torch.cuda.get_device_properties(0)
    free_before, total = torch.cuda.mem_get_info(0)
    logging.info(
        "GPU=%s capability=%s VRAM total=%.0f MiB free-before=%.0f MiB",
        props.name,
        torch.cuda.get_device_capability(0),
        total / 2**20,
        free_before / 2**20,
    )

    timings: dict[str, float] = {}
    started = time.perf_counter()

    stage = time.perf_counter()
    model = TSR.from_pretrained(
        "stabilityai/TripoSR", config_name="config.yaml", weight_name="model.ckpt"
    )
    model.renderer.set_chunk_size(args.chunk_size)
    model.to(device)
    torch.cuda.synchronize()
    timings["model_load_seconds"] = time.perf_counter() - stage
    torch.cuda.reset_peak_memory_stats(0)
    logging.info("Model loaded in %.1f seconds; chunk-size=%d", timings["model_load_seconds"], args.chunk_size)

    stage = time.perf_counter()
    image = prepare_image(args.image)
    with torch.inference_mode():
        scene_codes = model([image], device=device)
    torch.cuda.synchronize()
    timings["inference_seconds"] = time.perf_counter() - stage
    logging.info("Image inference finished in %.1f seconds", timings["inference_seconds"])

    stage = time.perf_counter()
    with torch.inference_mode():
        mesh = model.extract_mesh(
            scene_codes, True, resolution=args.mc_resolution
        )[0]
    torch.cuda.synchronize()
    timings["mesh_extraction_seconds"] = time.perf_counter() - stage
    logging.info(
        "Extracted mesh at resolution %d: %d vertices, %d faces",
        args.mc_resolution,
        len(mesh.vertices),
        len(mesh.faces),
    )

    stage = time.perf_counter()
    mesh.export(args.output, file_type="stl")
    timings["stl_export_seconds"] = time.perf_counter() - stage
    timings["total_seconds"] = time.perf_counter() - started

    free_after, _ = torch.cuda.mem_get_info(0)
    metrics = {
        "implementation": "VAST-AI-Research/TripoSR",
        "device": props.name,
        "compute_capability": list(torch.cuda.get_device_capability(0)),
        "cuda_runtime": torch.version.cuda,
        "torch": torch.__version__,
        "input": display_path(args.image),
        "output": display_path(args.output),
        "chunk_size": args.chunk_size,
        "mc_resolution": args.mc_resolution,
        "vram_total_mib": round(total / 2**20),
        "vram_free_before_mib": round(free_before / 2**20),
        "vram_free_after_mib": round(free_after / 2**20),
        "torch_peak_allocated_mib": round(torch.cuda.max_memory_allocated(0) / 2**20),
        "torch_peak_reserved_mib": round(torch.cuda.max_memory_reserved(0) / 2**20),
        "vertices": len(mesh.vertices),
        "faces": len(mesh.faces),
        "watertight": bool(mesh.is_watertight),
        "timings": timings,
    }
    metrics_path = args.output.with_name("metrics.json")
    metrics_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    logging.info("Exported %s (%.1f KiB)", args.output, args.output.stat().st_size / 1024)
    logging.info("Metrics: %s", metrics_path)
    logging.info(
        "CUDA peak allocated=%.0f MiB reserved=%.0f MiB; free after=%.0f MiB",
        metrics["torch_peak_allocated_mib"],
        metrics["torch_peak_reserved_mib"],
        free_after / 2**20,
    )
    logging.info("Total elapsed %.1f seconds", timings["total_seconds"])

    del model, scene_codes, mesh
    gc.collect()
    torch.cuda.empty_cache()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except torch.cuda.OutOfMemoryError as exc:
        logging.exception("CUDA out of memory during Phase 0. Lower --chunk-size / --mc-resolution or free VRAM.")
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        raise SystemExit(2) from exc
