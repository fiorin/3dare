import io
import logging
import shutil
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError

from ..core.jobs import JobManager
from ..schemas import GenerationOptions, HealthResponse, JobResponse
from .errors import APIError

logger = logging.getLogger(__name__)
router = APIRouter()
MAX_IMAGE_BYTES = 20 * 1024 * 1024
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def get_jobs(request: Request) -> JobManager:
    return request.app.state.jobs


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    state = request.app.state.provider.health()
    return HealthResponse(**state)


@router.post("/jobs", response_model=JobResponse, status_code=202)
async def create_job(
    request: Request,
    image: UploadFile = File(...),
    options: str = Form(default="{}"),
) -> JobResponse:
    try:
        generation_options = GenerationOptions.model_validate_json(options)
    except ValidationError as exc:
        raise APIError(
            422,
            "invalid_generation_options",
            "Generation options are invalid.",
            {"validation_errors": exc.errors()},
        ) from exc

    suffix = Path(image.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise APIError(
            415,
            "unsupported_image_type",
            "Upload a PNG, JPEG, or WebP image.",
            {"allowed_extensions": sorted(ALLOWED_EXTENSIONS)},
        )

    contents = await image.read(MAX_IMAGE_BYTES + 1)
    if len(contents) > MAX_IMAGE_BYTES:
        raise APIError(
            413,
            "image_too_large",
            "Image exceeds the 20 MiB upload limit.",
        )
    try:
        with Image.open(io.BytesIO(contents)) as decoded:
            decoded.verify()
    except (UnidentifiedImageError, OSError) as exc:
        raise APIError(400, "invalid_image", "The uploaded file is not a valid image.") from exc

    job_id = uuid4()
    data_root: Path = request.app.state.data_root
    input_dir = data_root / "projects" / str(job_id)
    output_dir = data_root / "generated" / str(job_id)
    image_path = input_dir / f"input{suffix}"
    try:
        input_dir.mkdir(parents=True, exist_ok=False)
        image_path.write_bytes(contents)
    except OSError as exc:
        logger.exception("Could not store uploaded image for job %s", job_id)
        shutil.rmtree(input_dir, ignore_errors=True)
        raise APIError(
            507,
            "storage_unavailable",
            "The local data directory could not store this image.",
        ) from exc

    try:
        return get_jobs(request).submit(
            job_id, image_path, output_dir, generation_options
        )
    except Exception:
        logger.exception("Could not queue generation job %s", job_id)
        shutil.rmtree(input_dir, ignore_errors=True)
        raise APIError(503, "job_queue_unavailable", "The local generation queue is unavailable.")


@router.get("/jobs/{job_id}", response_model=JobResponse)
def job_status(job_id: UUID, request: Request) -> JobResponse:
    result = get_jobs(request).get(job_id)
    if result is None:
        raise APIError(404, "job_not_found", "No job exists with that ID.")
    return result


@router.post("/jobs/{job_id}/cancel", response_model=JobResponse)
def cancel_job(job_id: UUID, request: Request) -> JobResponse:
    result = get_jobs(request).cancel(job_id)
    if result is None:
        raise APIError(404, "job_not_found", "No job exists with that ID.")
    return result


@router.get("/jobs/{job_id}/model")
def download_model(job_id: UUID, request: Request) -> FileResponse:
    result = get_jobs(request).get(job_id)
    if result is None:
        raise APIError(404, "job_not_found", "No job exists with that ID.")
    if result.status.value != "completed" or not result.model_path:
        raise APIError(409, "model_not_ready", "The job has no completed model to download.")

    data_root: Path = request.app.state.data_root
    model_path = (data_root / result.model_path).resolve()
    try:
        model_path.relative_to((data_root / "generated").resolve())
    except ValueError as exc:
        raise APIError(403, "invalid_model_path", "The model path is outside generated data.") from exc
    if not model_path.is_file():
        raise APIError(404, "model_file_missing", "The generated model file is missing.")
    return FileResponse(model_path, media_type="model/gltf-binary", filename="model.glb")
