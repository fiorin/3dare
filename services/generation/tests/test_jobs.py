import threading
import time
from pathlib import Path
from uuid import uuid4

from app.core.jobs import JobManager
from app.providers.base import ProviderError
from app.schemas import GenerationOptions, JobState


class BlockingProvider:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def health(self) -> dict[str, object]:
        return {"status": "ready", "model_loaded": False, "cuda_available": True}

    def generate(self, image_path, output_dir, options, progress_callback):
        progress_callback(0.1, "loading_model")
        self.started.set()
        self.release.wait(3)
        progress_callback(0.7, "extracting_mesh")
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / "model.glb"
        output_path.write_bytes(b"glb")
        return output_path


def wait_until(manager: JobManager, job_id, status: JobState) -> None:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = manager.get(job_id)
        if response and response.status == status:
            return
        time.sleep(0.01)
    raise AssertionError(f"Job {job_id} did not reach {status.value}")


def test_queued_and_running_cancellation(tmp_path: Path) -> None:
    provider = BlockingProvider()
    manager = JobManager(provider, tmp_path, max_workers=1)
    image_path = tmp_path / "input.png"
    image_path.write_bytes(b"input")
    options = GenerationOptions()
    first_id, queued_id = uuid4(), uuid4()

    manager.submit(first_id, image_path, tmp_path / "generated" / str(first_id), options)
    assert provider.started.wait(2)
    manager.submit(queued_id, image_path, tmp_path / "generated" / str(queued_id), options)
    assert manager.cancel(queued_id).status == JobState.CANCELLED

    provider.release.set()
    wait_until(manager, first_id, JobState.COMPLETED)

    provider.release.clear()
    provider.started.clear()
    running_id = uuid4()
    manager.submit(running_id, image_path, tmp_path / "generated" / str(running_id), options)
    assert provider.started.wait(2)
    requested = manager.cancel(running_id)
    assert requested.status == JobState.RUNNING
    assert requested.cancel_requested is True
    provider.release.set()
    wait_until(manager, running_id, JobState.CANCELLED)
    manager.shutdown()


def test_worker_records_structured_provider_failure(tmp_path: Path) -> None:
    class FailingProvider(BlockingProvider):
        def generate(self, image_path, output_dir, options, progress_callback):
            raise ProviderError("cuda_unavailable", "CUDA is unavailable")

    manager = JobManager(FailingProvider(), tmp_path)
    job_id = uuid4()
    image_path = tmp_path / "input.png"
    image_path.write_bytes(b"input")
    manager.submit(job_id, image_path, tmp_path / "generated" / str(job_id), GenerationOptions())
    wait_until(manager, job_id, JobState.FAILED)
    result = manager.get(job_id)
    assert result.error is not None
    assert result.error.code == "cuda_unavailable"
    manager.shutdown()
