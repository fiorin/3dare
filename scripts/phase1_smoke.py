"""Exercise the real local API with the TripoSR sample image and GPU."""

from __future__ import annotations

import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "generation"))

from app.main import create_app  # noqa: E402


def main() -> int:
    image_path = ROOT / "third_party" / "TripoSR" / "examples" / "chair.png"
    app = create_app()
    with TestClient(app) as client, image_path.open("rb") as image_file:
        health = client.get("/api/v1/health")
        health.raise_for_status()
        print("health:", health.json())

        created = client.post(
            "/api/v1/jobs",
            files={"image": (image_path.name, image_file, "image/png")},
            data={"options": '{"chunk_size":128,"mc_resolution":128,"device":"cuda"}'},
        )
        created.raise_for_status()
        job_id = created.json()["job_id"]
        print("job:", created.json())

        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            response = client.get(f"/api/v1/jobs/{job_id}")
            response.raise_for_status()
            job = response.json()
            print(f"{job['status']} {job['progress']:.0%} {job['stage']}")
            if job["status"] == "completed":
                download = client.get(f"/api/v1/jobs/{job_id}/model")
                download.raise_for_status()
                print("model:", job["model_path"], "bytes:", len(download.content))
                return 0
            if job["status"] in {"failed", "cancelled"}:
                print("generation error:", job["error"])
                return 1
            time.sleep(1)

    raise TimeoutError("Generation API smoke test exceeded 15 minutes.")


if __name__ == "__main__":
    raise SystemExit(main())
