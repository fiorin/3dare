from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable

from ..schemas import GenerationOptions

ProgressCallback = Callable[[float, str], None]


class ProviderError(Exception):
    def __init__(
        self, code: str, message: str, details: dict[str, object] | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


class ImageTo3DProvider(ABC):
    @abstractmethod
    def generate(
        self,
        image_path: Path,
        output_dir: Path,
        options: GenerationOptions,
        progress_callback: ProgressCallback,
    ) -> Path:
        """Generate a mesh and return its path."""

    @abstractmethod
    def health(self) -> dict[str, object]:
        """Return local model and accelerator status."""
