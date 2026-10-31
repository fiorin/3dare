import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from .api.errors import APIError, api_error_handler
from .api.routes import router
from .core.jobs import JobManager
from .providers.base import ImageTo3DProvider
from .providers.triposr import TripoSRProvider
from .schemas import ErrorInfo

API_PREFIX = "/api/v1"
PROJECT_ROOT = Path(__file__).resolve().parents[3]


def request_validation_error_handler(
    _: Request, exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content=jsonable_encoder({
            "error": ErrorInfo(
                code="request_validation_error",
                message="The request is invalid.",
                details={"validation_errors": exc.errors()},
            ).model_dump()
        }),
    )


def create_app(
    provider: ImageTo3DProvider | None = None,
    data_root: Path | None = None,
    max_workers: int = 1,
) -> FastAPI:
    local_data_root = (data_root or Path(os.getenv("GENERATION_DATA_DIR", PROJECT_ROOT / "data"))).resolve()
    local_data_root.mkdir(parents=True, exist_ok=True)
    selected_provider = provider or TripoSRProvider(
        model_source=os.getenv("TRIPOSR_MODEL_PATH") or "stabilityai/TripoSR"
    )
    job_manager = JobManager(selected_provider, local_data_root, max_workers=max_workers)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        job_manager.shutdown()

    app = FastAPI(
        title="Local Image-to-3D Generation", version="1.0.0", lifespan=lifespan
    )
    app.state.data_root = local_data_root
    app.state.provider = selected_provider
    app.state.jobs = job_manager

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    app.add_exception_handler(APIError, api_error_handler)
    app.add_exception_handler(RequestValidationError, request_validation_error_handler)

    app.include_router(router, prefix=API_PREFIX)
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    import logging

    logging.basicConfig(level=logging.INFO)
    uvicorn.run("app.main:app", host="127.0.0.1", port=8765, reload=False)
