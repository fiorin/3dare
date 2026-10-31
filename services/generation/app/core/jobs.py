import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from .errors import JobCancelled
from ..providers.base import ImageTo3DProvider, ProviderError
from ..schemas import ErrorInfo, GenerationOptions, JobResponse, JobState

logger = logging.getLogger(__name__)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class JobRecord:
    job_id: UUID
    image_path: Path
    output_dir: Path
    options: GenerationOptions
    status: JobState = JobState.QUEUED
    progress: float = 0.0
    stage: str = "queued"
    error: ErrorInfo | None = None
    model_path: Path | None = None
    device: str | None = None
    cancel_requested: bool = False
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


class JobManager:
    def __init__(
        self,
        provider: ImageTo3DProvider,
        data_root: Path,
        max_workers: int = 1,
    ) -> None:
        self.provider = provider
        self.data_root = data_root.resolve()
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="generation"
        )
        self._lock = threading.RLock()
        self._jobs: dict[UUID, JobRecord] = {}
        self._futures: dict[UUID, Future[None]] = {}

    def submit(
        self,
        job_id: UUID,
        image_path: Path,
        output_dir: Path,
        options: GenerationOptions,
    ) -> JobResponse:
        with self._lock:
            record = JobRecord(
                job_id=job_id,
                image_path=image_path.resolve(),
                output_dir=output_dir.resolve(),
                options=options,
            )
            self._jobs[job_id] = record
            future = self._executor.submit(self._run, job_id)
            self._futures[job_id] = future
            return self._to_response(record)

    def get(self, job_id: UUID) -> JobResponse | None:
        with self._lock:
            record = self._jobs.get(job_id)
            return self._to_response(record) if record else None

    def cancel(self, job_id: UUID) -> JobResponse | None:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                return None
            if record.status == JobState.QUEUED:
                record.cancel_requested = True
                record.status = JobState.CANCELLED
                record.stage = "cancelled"
                record.updated_at = utc_now()
                future = self._futures.get(job_id)
                if future is not None:
                    future.cancel()
            elif record.status == JobState.RUNNING:
                record.cancel_requested = True
                record.stage = "cancellation_requested"
                record.updated_at = utc_now()
            return self._to_response(record)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)

    def _run(self, job_id: UUID) -> None:
        with self._lock:
            record = self._jobs[job_id]
            if record.cancel_requested or record.status == JobState.CANCELLED:
                return
            record.status = JobState.RUNNING
            record.stage = "starting"
            record.device = record.options.device
            record.updated_at = utc_now()

        def report_progress(progress: float, stage: str) -> None:
            with self._lock:
                current = self._jobs[job_id]
                if current.cancel_requested:
                    raise JobCancelled()
                current.progress = max(0.0, min(1.0, progress))
                current.stage = stage
                current.updated_at = utc_now()

        try:
            output_path = self.provider.generate(
                record.image_path,
                record.output_dir,
                record.options,
                report_progress,
            )
            output_path = output_path.resolve()
            try:
                output_path.relative_to(record.output_dir)
            except ValueError as exc:
                raise ProviderError(
                    "invalid_output_path", "Provider returned a file outside the job output directory."
                ) from exc
            if not output_path.is_file():
                raise ProviderError(
                    "model_file_missing", "Provider completed without writing a model file."
                )
            with self._lock:
                current = self._jobs[job_id]
                if current.cancel_requested:
                    current.status = JobState.CANCELLED
                    current.stage = "cancelled"
                    output_path.unlink(missing_ok=True)
                else:
                    current.status = JobState.COMPLETED
                    current.progress = 1.0
                    current.stage = "completed"
                    current.model_path = output_path
                current.updated_at = utc_now()
        except JobCancelled:
            with self._lock:
                current = self._jobs[job_id]
                current.status = JobState.CANCELLED
                current.stage = "cancelled"
                current.updated_at = utc_now()
        except ProviderError as exc:
            with self._lock:
                current = self._jobs[job_id]
                current.status = JobState.FAILED
                current.stage = "failed"
                current.error = ErrorInfo(
                    code=exc.code, message=exc.message, details=exc.details
                )
                current.updated_at = utc_now()
        except Exception:
            logger.exception("Job %s failed", job_id)
            with self._lock:
                current = self._jobs[job_id]
                current.status = JobState.FAILED
                current.stage = "failed"
                current.error = ErrorInfo(
                    code="generation_failed",
                    message="Generation failed. See the local service log for details.",
                )
                current.updated_at = utc_now()

    def _to_response(self, record: JobRecord) -> JobResponse:
        relative_model_path = None
        if record.model_path is not None:
            relative_model_path = record.model_path.relative_to(self.data_root).as_posix()
        return JobResponse(
            job_id=record.job_id,
            status=record.status,
            progress=record.progress,
            stage=record.stage,
            error=record.error,
            model_path=relative_model_path,
            device=record.device,
            cancel_requested=record.cancel_requested,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )
