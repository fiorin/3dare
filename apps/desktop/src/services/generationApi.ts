const API_BASE_URL = "http://127.0.0.1:8765/api/v1";

export interface GenerationOptions {
  chunk_size: number;
  mc_resolution: number;
  remove_background: boolean;
  device: "cuda" | "cpu";
}

const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  chunk_size: 128,
  mc_resolution: 128,
  remove_background: true,
  device: "cuda",
};

export type GenerationJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface GenerationErrorInfo {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
}

export interface GenerationJob {
  job_id: string;
  status: GenerationJobStatus;
  progress: number;
  stage: string;
  error: GenerationErrorInfo | null;
  model_path?: string | null;
  device?: string | null;
  cancel_requested?: boolean;
  created_at?: string;
  updated_at?: string;
}

export class GenerationApiError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;
  readonly details: Record<string, unknown> | null;
  readonly suggestion: string;

  constructor(
    code: string,
    message: string,
    options: {
      httpStatus?: number | null;
      details?: Record<string, unknown> | null;
      suggestion?: string;
    } = {},
  ) {
    super(message);
    this.name = "GenerationApiError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.details = options.details ?? null;
    this.suggestion = options.suggestion ?? suggestionForGenerationError(code, this.details);
  }
}

export function suggestionForGenerationError(
  code: string,
  details: Record<string, unknown> | null = null,
): string {
  const detailSuggestion = details?.suggestion;
  if (typeof detailSuggestion === "string" && detailSuggestion.trim().length > 0) {
    return detailSuggestion;
  }
  switch (code) {
    case "service_unreachable":
      return "Start the local generation service and confirm it is listening on 127.0.0.1:8765, then try again.";
    case "unsupported_image_type":
      return "Choose a PNG, JPEG, or WebP image.";
    case "image_too_large":
      return "Choose an image no larger than 20 MiB.";
    case "invalid_image":
      return "Re-export the source as a valid PNG, JPEG, or WebP image and try again.";
    case "cuda_unavailable":
      return "Make a CUDA-capable NVIDIA GPU available to the local service, then retry generation.";
    case "cuda_out_of_memory":
      return "Close other GPU-intensive applications and retry with the local GPU available.";
    case "provider_not_installed":
      return "Install the local generation service prerequisites, then restart the service.";
    case "storage_unavailable":
      return "Check that the local application data directory is writable and has free disk space.";
    case "job_queue_unavailable":
      return "Restart the local generation service, then submit the image again.";
    case "job_not_found":
      return "The local service no longer has this job. Submit the image again.";
    case "model_file_missing":
      return "The completed model is missing from local storage. Run generation again.";
    case "invalid_generation_options":
      return "Restart the desktop app so it can send generation settings supported by the local service.";
    case "generation_failed":
      return "Check the local generation service log for the failure details, then retry.";
    case "invalid_output_path":
    case "invalid_model_path":
      return "Restart the local generation service and retry; its generated output path is invalid.";
    case "model_not_ready":
      return "Wait for generation to complete before requesting the model.";
    case "invalid_response":
      return "Restart the local generation service and retry; its response did not match the expected job format.";
    default:
      return "Check the local generation service and available GPU resources, then try again.";
  }
}

const JOB_STATUSES: Record<GenerationJobStatus, true> = {
  queued: true,
  running: true,
  completed: true,
  failed: true,
  cancelled: true,
};

function isGenerationJobStatus(value: unknown): value is GenerationJobStatus {
  return typeof value === "string" && Object.hasOwn(JOB_STATUSES, value);
}

function parseErrorInfo(value: unknown): GenerationErrorInfo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const candidate = value as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") return null;

  const details = candidate.details;
  return {
    code: candidate.code,
    message: candidate.message,
    details:
      typeof details === "object" && details !== null && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : null,
  };
}

function parseGenerationJob(value: unknown): GenerationJob | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const candidate = value as {
    job_id?: unknown;
    status?: unknown;
    progress?: unknown;
    stage?: unknown;
    error?: unknown;
    model_path?: unknown;
    device?: unknown;
    cancel_requested?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
  };
  if (
    typeof candidate.job_id !== "string" ||
    candidate.job_id.length === 0 ||
    !isGenerationJobStatus(candidate.status) ||
    typeof candidate.progress !== "number" ||
    !Number.isFinite(candidate.progress) ||
    candidate.progress < 0 ||
    candidate.progress > 1 ||
    typeof candidate.stage !== "string"
  ) {
    return null;
  }

  const error = candidate.error == null ? null : parseErrorInfo(candidate.error);
  if (candidate.error != null && error === null) return null;

  return {
    job_id: candidate.job_id,
    status: candidate.status,
    progress: candidate.progress,
    stage: candidate.stage,
    error,
    model_path:
      typeof candidate.model_path === "string" || candidate.model_path === null
        ? candidate.model_path
        : null,
    device:
      typeof candidate.device === "string" || candidate.device === null
        ? candidate.device
        : null,
    cancel_requested: candidate.cancel_requested === true,
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : undefined,
    updated_at: typeof candidate.updated_at === "string" ? candidate.updated_at : undefined,
  };
}

function parseApiErrorResponse(value: unknown): GenerationErrorInfo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("error" in value)) {
    return null;
  }
  return parseErrorInfo(value.error);
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function apiErrorFromResponse(response: Response, payload: unknown): GenerationApiError {
  const error = parseApiErrorResponse(payload);
  return new GenerationApiError(
    error?.code ?? `http_${response.status}`,
    error?.message ?? `The local generation service returned HTTP ${response.status}.`,
    {
      httpStatus: response.status,
      details: error?.details,
    },
  );
}

async function requestLocal(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    if (init.signal?.aborted) {
      throw new DOMException("The local service request was cancelled.", "AbortError");
    }
    throw new GenerationApiError(
      "service_unreachable",
      "Could not connect to the local generation service at 127.0.0.1:8765.",
    );
  }
}

async function requestJob(url: string, init: RequestInit = {}): Promise<GenerationJob> {
  const response = await requestLocal(url, init);
  const payload = await readResponseBody(response);
  if (!response.ok) throw apiErrorFromResponse(response, payload);
  const job = parseGenerationJob(payload);
  if (!job) {
    throw new GenerationApiError(
      "invalid_response",
      "The local generation service returned an invalid job response.",
      { httpStatus: response.status },
    );
  }

  return job;
}


export function createGenerationJob(
  image: File,
  options: Partial<GenerationOptions> = {},
  signal?: AbortSignal,
): Promise<GenerationJob> {
  const form = new FormData();
  form.append("image", image, image.name);
  form.append("options", JSON.stringify({ ...DEFAULT_GENERATION_OPTIONS, ...options }));

  return requestJob(`${API_BASE_URL}/jobs`, {
    method: "POST",
    body: form,
    signal,
  });
}

export function getGenerationJob(jobId: string, signal?: AbortSignal): Promise<GenerationJob> {
  return requestJob(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`, { signal });
}

export function cancelGenerationJob(jobId: string, signal?: AbortSignal): Promise<GenerationJob> {
  return requestJob(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    signal,
  });
}

export async function downloadGenerationModel(jobId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await requestLocal(
    `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/model`,
    { signal },
  );
  if (!response.ok) {
    throw apiErrorFromResponse(response, await readResponseBody(response));
  }

  const model = await response.blob();
  if (model.size === 0) {
    throw new GenerationApiError(
      "invalid_response",
      "The local generation service returned an empty model file.",
      { httpStatus: response.status },
    );
  }
  return model;
}
