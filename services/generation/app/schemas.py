from datetime import datetime
from enum import Enum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class JobState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class GenerationOptions(BaseModel):
    chunk_size: int = Field(default=128, ge=1, le=8192)
    mc_resolution: int = Field(default=128, ge=32, le=256)
    remove_background: bool = True
    device: Literal["cuda", "cpu"] = "cuda"


class ErrorInfo(BaseModel):
    code: str
    message: str
    details: dict[str, object] | None = None


class HealthResponse(BaseModel):
    status: Literal["ready", "degraded"]
    model_loaded: bool
    cuda_available: bool
    gpu_name: str | None = None
    vram_total_mib: int | None = None
    vram_free_mib: int | None = None


class JobResponse(BaseModel):
    job_id: UUID
    status: JobState
    progress: float = Field(ge=0.0, le=1.0)
    stage: str
    error: ErrorInfo | None = None
    model_path: str | None = None
    device: str | None = None
    cancel_requested: bool = False
    created_at: datetime
    updated_at: datetime


class APIErrorResponse(BaseModel):
    error: ErrorInfo
