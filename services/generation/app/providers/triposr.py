import gc
import logging
import os
import sys
import threading
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

from ..core.errors import JobCancelled
from ..schemas import GenerationOptions
from .base import ImageTo3DProvider, ProgressCallback, ProviderError

logger = logging.getLogger(__name__)
TRIPOSR_ROOT = Path(
    os.environ.get(
        "TRIPOSR_ROOT",
        Path(__file__).resolve().parents[4] / "third_party" / "TripoSR",
    )
).resolve()


class TripoSRProvider(ImageTo3DProvider):
    def __init__(self, model_source: str | None = None) -> None:
        self.model_source = model_source or "stabilityai/TripoSR"
        self._model = None
        self._model_device: str | None = None
        self._lock = threading.RLock()

    def health(self) -> dict[str, object]:
        cuda_available = torch.cuda.is_available()
        gpu_name = None
        total_mib = None
        free_mib = None
        if cuda_available:
            gpu_name = torch.cuda.get_device_name(0)
            free_bytes, total_bytes = torch.cuda.mem_get_info(0)
            total_mib = round(total_bytes / 2**20)
            free_mib = round(free_bytes / 2**20)
        return {
            "status": "ready" if cuda_available else "degraded",
            "model_loaded": self._model is not None,
            "cuda_available": cuda_available,
            "gpu_name": gpu_name,
            "vram_total_mib": total_mib,
            "vram_free_mib": free_mib,
        }

    def _load_model(self, device: str, progress_callback: ProgressCallback):
        if not TRIPOSR_ROOT.is_dir():
            raise ProviderError(
                "provider_not_installed",
                "Pinned TripoSR source is missing. Run scripts/setup-phase0.ps1.",
            )
        progress_callback(0.03, "loading_model")
        if str(TRIPOSR_ROOT) not in sys.path:
            sys.path.insert(0, str(TRIPOSR_ROOT))
        from tsr.system import TSR

        try:
            model = TSR.from_pretrained(
                self.model_source,
                config_name="config.yaml",
                weight_name="model.ckpt",
            )
            model.to(device)
        except torch.cuda.OutOfMemoryError as exc:
            torch.cuda.empty_cache()
            raise ProviderError(
                "cuda_out_of_memory",
                "Not enough free VRAM to load TripoSR. Close GPU-intensive applications and retry.",
                {"suggestion": "Keep the 128 marching-cubes resolution and close other GPU applications."},
            ) from exc
        self._model = model
        self._model_device = device
        return model

    @staticmethod
    def _prepare_image(image_path: Path, remove_bg: bool) -> Image.Image:
        with Image.open(image_path) as opened:
            image = ImageOps.exif_transpose(opened).copy()
        if not remove_bg:
            return image.convert("RGB")

        has_transparency = image.mode == "RGBA" and image.getextrema()[3][0] < 255
        if has_transparency:
            foreground = image
        else:
            import rembg

            from tsr.utils import remove_background

            foreground = remove_background(image, rembg.new_session())

        from tsr.utils import resize_foreground

        foreground = resize_foreground(foreground, 0.85)
        pixels = np.asarray(foreground).astype(np.float32) / 255.0
        rgb = pixels[..., :3] * pixels[..., 3:4] + (1.0 - pixels[..., 3:4]) * 0.5
        return Image.fromarray((rgb * 255.0).astype(np.uint8))

    def generate(
        self,
        image_path: Path,
        output_dir: Path,
        options: GenerationOptions,
        progress_callback: ProgressCallback,
    ) -> Path:
        if options.device == "cuda" and not torch.cuda.is_available():
            raise ProviderError(
                "cuda_unavailable",
                "CUDA was requested but PyTorch cannot access an NVIDIA GPU. Select CPU explicitly or repair the CUDA setup.",
            )

        device = options.device
        with self._lock:
            try:
                if self._model is None:
                    model = self._load_model(device, progress_callback)
                else:
                    model = self._model
                    if self._model_device != device:
                        model.to(device)
                        self._model_device = device
                        if device == "cpu" and torch.cuda.is_available():
                            torch.cuda.empty_cache()

                model.renderer.set_chunk_size(options.chunk_size)
                progress_callback(0.12, "preprocessing_image")
                image = self._prepare_image(image_path, options.remove_background)

                progress_callback(0.25, "running_inference")
                with torch.inference_mode():
                    scene_codes = model([image], device=device)
                if device == "cuda":
                    torch.cuda.synchronize()

                progress_callback(0.72, "extracting_mesh")
                with torch.inference_mode():
                    mesh = model.extract_mesh(
                        scene_codes, True, resolution=options.mc_resolution
                    )[0]

                progress_callback(0.94, "exporting_model")
                output_dir.mkdir(parents=True, exist_ok=True)
                output_path = output_dir / "model.glb"
                mesh.export(output_path, file_type="glb")
                progress_callback(0.99, "finalizing")

                del scene_codes, mesh, image
                gc.collect()
                if device == "cuda":
                    torch.cuda.empty_cache()
                return output_path
            except JobCancelled:
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                raise
            except ProviderError:
                raise
            except torch.cuda.OutOfMemoryError as exc:
                gc.collect()
                torch.cuda.empty_cache()
                raise ProviderError(
                    "cuda_out_of_memory",
                    "CUDA ran out of memory during generation. Close other GPU applications, then retry with a smaller chunk size or marching-cubes resolution.",
                    {
                        "suggested_chunk_size": 64,
                        "suggested_mc_resolution": 96,
                    },
                ) from exc
            except Exception:
                logger.exception("TripoSR generation failed")
                raise
