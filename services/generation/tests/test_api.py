import io
import time
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app
from app.schemas import GenerationOptions


class FakeProvider:
    def health(self) -> dict[str, object]:
        return {
            "status": "ready",
            "model_loaded": False,
            "cuda_available": True,
            "gpu_name": "Test GPU",
            "vram_total_mib": 4096,
            "vram_free_mib": 3000,
        }

    def generate(self, image_path, output_dir, options, progress_callback):
        assert image_path.is_file()
        assert isinstance(options, GenerationOptions)
        progress_callback(0.5, "running_inference")
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / "model.glb"
        output_path.write_bytes(b"test glb payload")
        progress_callback(1.0, "completed")
        return output_path


def png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (120, 160, 200)).save(buffer, format="PNG")
    return buffer.getvalue()


def wait_for_status(client: TestClient, job_id: str, target: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/jobs/{job_id}")
        assert response.status_code == 200
        payload = response.json()
        if payload["status"] == target:
            return payload
        time.sleep(0.01)
    raise AssertionError(f"Job {job_id} did not reach {target}")


def test_health_reports_local_gpu(tmp_path: Path) -> None:
    app = create_app(provider=FakeProvider(), data_root=tmp_path)
    with TestClient(app) as client:
        response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["gpu_name"] == "Test GPU"
    assert response.json()["model_loaded"] is False


def test_cors_allows_desktop_origin_only(tmp_path: Path) -> None:
    app = create_app(provider=FakeProvider(), data_root=tmp_path)
    with TestClient(app) as client:
        allowed = client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://tauri.localhost",
                "Access-Control-Request-Method": "GET",
            },
        )
        denied = client.get(
            "/api/v1/health", headers={"Origin": "https://example.invalid"}
        )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://tauri.localhost"
    assert "access-control-allow-origin" not in denied.headers

def test_job_upload_status_and_model_download(tmp_path: Path) -> None:
    app = create_app(provider=FakeProvider(), data_root=tmp_path)
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/jobs",
            files={"image": ("input.png", png_bytes(), "image/png")},
            data={"options": '{"chunk_size": 64, "mc_resolution": 96}'},
        )
        assert created.status_code == 202
        job_id = created.json()["job_id"]

        completed = wait_for_status(client, job_id, "completed")
        assert completed["progress"] == 1.0
        assert completed["model_path"].startswith("generated/")

        download = client.get(f"/api/v1/jobs/{job_id}/model")
        assert download.status_code == 200
        assert download.content == b"test glb payload"


def test_invalid_options_and_image_return_structured_errors(tmp_path: Path) -> None:
    app = create_app(provider=FakeProvider(), data_root=tmp_path)
    with TestClient(app) as client:
        invalid_options = client.post(
            "/api/v1/jobs",
            files={"image": ("input.png", png_bytes(), "image/png")},
            data={"options": '{"chunk_size": 0}'},
        )
        assert invalid_options.status_code == 422
        assert invalid_options.json()["error"]["code"] == "invalid_generation_options"

        invalid_image = client.post(
            "/api/v1/jobs",
            files={"image": ("input.png", b"not an image", "image/png")},
            data={"options": "{}"},
        )
        assert invalid_image.status_code == 400
        assert invalid_image.json()["error"]["code"] == "invalid_image"
