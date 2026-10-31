import { useEffect, useId, useRef, useState } from "react";
import {
  cancelGenerationJob,
  createGenerationJob,
  downloadGenerationModel,
  GenerationApiError,
  getGenerationJob,
  suggestionForGenerationError,
  type GenerationErrorInfo,
  type GenerationJob,
} from "../../services/generationApi";
import "./GenerationPanel.css";

export interface GenerationPanelProps {
  image: File | null;
  serviceAvailable: boolean;
  cudaAvailable: boolean;
  onBusyChange: (busy: boolean) => void;
  onModelReady: (result: { jobId: string; modelUrl: string }) => void;
}

interface GenerationProblem {
  code: string;
  message: string;
  suggestion: string;
  details: Record<string, unknown> | null;
}

interface ActiveGeneration {
  controller: AbortController;
  jobId: string | null;
}

const POLL_INTERVAL_MS = 1_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_IMAGE_EXTENSIONS: Record<string, true> = {
  ".png": true,
  ".jpg": true,
  ".jpeg": true,
  ".webp": true,
};

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  loading_model: "Loading generation model",
  preprocessing_image: "Preparing image",
  running_inference: "Generating 3D geometry",
  extracting_mesh: "Extracting mesh",
  exporting_model: "Exporting GLB model",
  finalizing: "Finalizing model",
  cancellation_requested: "Cancellation requested",
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
};

function imageProblem(image: File | null): string | null {
  if (!image) return "Import an image before starting generation.";
  if (image.size === 0) return "Choose an image file that contains data.";
  const extension = image.name.slice(image.name.lastIndexOf(".")).toLowerCase();
  if (!ACCEPTED_IMAGE_EXTENSIONS[extension]) {
    return "Choose a PNG, JPEG, or WebP image.";
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return "Choose an image no larger than 20 MiB.";
  }
  return null;
}

function problemFromError(error: unknown): GenerationProblem {
  if (error instanceof GenerationApiError) {
    return {
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      details: error.details,
    };
  }

  return {
    code: "generation_request_failed",
    message: error instanceof Error ? error.message : "Generation could not be completed.",
    suggestion: "Check the local generation service and GPU, then try again.",
    details: null,
  };
}

function problemFromJob(error: GenerationErrorInfo | null): GenerationProblem {
  if (!error) {
    return {
      code: "generation_failed",
      message: "The local service reported that generation failed without additional details.",
      suggestion: suggestionForGenerationError("generation_failed"),
      details: null,
    };
  }

  return {
    code: error.code,
    message: error.message,
    suggestion: suggestionForGenerationError(error.code, error.details ?? null),
    details: error.details ?? null,
  };
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = window.setTimeout(finish, POLL_INTERVAL_MS);
    const abort = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Generation polling was stopped.", "AbortError"));
    };

    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage.replaceAll("_", " ");
}

function isTerminalStatus(status: GenerationJob["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function GenerationPanel({
  image,
  serviceAvailable,
  cudaAvailable,
  onBusyChange,
  onModelReady,
}: GenerationPanelProps) {
  const panelId = useId();
  const activeGenerationRef = useRef<ActiveGeneration | null>(null);
  const mountedRef = useRef(false);
  const onModelReadyRef = useRef(onModelReady);
  const onBusyChangeRef = useRef(onBusyChange);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [problem, setProblem] = useState<GenerationProblem | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelPending, setIsCancelPending] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [resolution, setResolution] = useState(128);
  const [removeBackground, setRemoveBackground] = useState(true);
  const [device, setDevice] = useState<"cuda" | "cpu">("cuda");
  const invalidImage = imageProblem(image);

  onModelReadyRef.current = onModelReady;
  onBusyChangeRef.current = onBusyChange;


  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeGenerationRef.current?.controller.abort();
      onBusyChangeRef.current(false);
    };
  }, []);

  const isCurrentGeneration = (generation: ActiveGeneration) =>
    mountedRef.current &&
    activeGenerationRef.current === generation &&
    !generation.controller.signal.aborted;

  const startGeneration = async () => {
    if (
      !image ||
      invalidImage ||
      !serviceAvailable ||
      (device === "cuda" && !cudaAvailable) ||
      activeGenerationRef.current
    ) return;

    const generation: ActiveGeneration = {
      controller: new AbortController(),
      jobId: null,
    };
    activeGenerationRef.current = generation;
    onBusyChangeRef.current(true);
    setIsRunning(true);
    setIsCancelPending(false);
    setJob(null);
    setProblem(null);
    setModelReady(false);

    try {
      let currentJob = await createGenerationJob(
        image,
        {
          mc_resolution: resolution,
          remove_background: removeBackground,
          device,
        },
        generation.controller.signal,
      );
      if (!isCurrentGeneration(generation)) return;
      generation.jobId = currentJob.job_id;
      setJob(currentJob);

      while (!isTerminalStatus(currentJob.status)) {
        await waitForNextPoll(generation.controller.signal);
        currentJob = await getGenerationJob(currentJob.job_id, generation.controller.signal);
        if (!isCurrentGeneration(generation)) return;
        setJob(currentJob);
      }

      if (currentJob.status === "failed") {
        setProblem(problemFromJob(currentJob.error));
        return;
      }
      if (currentJob.status === "cancelled") return;

      const model = await downloadGenerationModel(currentJob.job_id, generation.controller.signal);
      if (!isCurrentGeneration(generation)) return;

      const modelUrl = URL.createObjectURL(model);
      try {
        onModelReadyRef.current({ jobId: currentJob.job_id, modelUrl });
      } catch {
        URL.revokeObjectURL(modelUrl);
        throw new GenerationApiError(
          "model_handoff_failed",
          "The GLB was downloaded, but the preview could not receive the model.",
          { suggestion: "Try generation again. If the issue persists, restart the desktop app." },
        );
      }
      setModelReady(true);
    } catch (error) {
      if (generation.controller.signal.aborted || !isCurrentGeneration(generation)) return;
      setProblem(problemFromError(error));
    } finally {
      if (mountedRef.current && activeGenerationRef.current === generation) {
        activeGenerationRef.current = null;
        setIsRunning(false);
        setIsCancelPending(false);
        onBusyChangeRef.current(false);
      }
    }
  };

  const cancelGeneration = async () => {
    const generation = activeGenerationRef.current;
    if (
      !generation?.jobId ||
      !job ||
      isTerminalStatus(job.status) ||
      job.cancel_requested ||
      isCancelPending
    ) {
      return;
    }

    setIsCancelPending(true);
    setProblem(null);
    try {
      const updatedJob = await cancelGenerationJob(generation.jobId, generation.controller.signal);
      if (isCurrentGeneration(generation)) setJob(updatedJob);
    } catch (error) {
      if (!generation.controller.signal.aborted && isCurrentGeneration(generation)) {
        setProblem(problemFromError(error));
      }
    } finally {
      if (isCurrentGeneration(generation)) setIsCancelPending(false);
    }
  };

  const progressPercent = job ? Math.round(job.progress * 100) : 0;
  const cancellationRequested = job?.cancel_requested === true || job?.stage === "cancellation_requested";
  const canCancel =
    isRunning &&
    job !== null &&
    !isTerminalStatus(job.status) &&
    !cancellationRequested &&
    !isCancelPending;
  const canStart =
    !!image &&
    invalidImage === null &&
    serviceAvailable &&
    (device === "cpu" || cudaAvailable) &&
    !isRunning;


  let statusMessage = !serviceAvailable
    ? "The local generation service is unavailable."
    : device === "cuda" && !cudaAvailable
      ? "CUDA is unavailable. Select CPU explicitly to continue."
      : "Ready to generate a 3D model.";
  if (isRunning && !job) statusMessage = "Submitting image to the local generation service…";
  else if (isRunning && job?.status === "completed") statusMessage = "Generation complete. Retrieving the GLB model…";
  else if (isRunning && cancellationRequested) statusMessage = "Cancellation requested; waiting for the current generation stage to finish…";
  else if (job?.status === "queued") statusMessage = "Waiting for the local generation worker…";
  else if (job?.status === "running") statusMessage = "Generation is in progress.";
  else if (job?.status === "cancelled") statusMessage = "Generation was cancelled.";
  else if (job?.status === "failed") statusMessage = "Generation failed.";
  else if (modelReady) statusMessage = "Model ready. The GLB was handed to the preview.";
  else if (job?.status === "completed") statusMessage = "Generation completed, but model delivery did not finish.";

  return (
    <section className="generation-panel" aria-labelledby={`${panelId}-title`}>
      <div className="generation-panel__heading">
        <div>
          <p className="generation-panel__eyebrow">STEP 02</p>
          <h2 id={`${panelId}-title`}>Generate your model</h2>
          <p className="generation-panel__description">
            Process the imported image locally and prepare a GLB for the viewer.
          </p>
        </div>
        <span className="generation-panel__local-badge">LOCAL SERVICE</span>
      </div>

      <div className="generation-panel__settings">
        <label>
          <span>Quality</span>
          <select value={resolution} onChange={(event) => setResolution(Number(event.currentTarget.value))} disabled={isRunning}>
            <option value={96}>Fast mesh · 96</option>
            <option value={128}>Balanced mesh · 128</option>
            <option value={160}>Fine mesh · 160</option>
          </select>
        </label>
        <label className="generation-panel__toggle">
          <input type="checkbox" checked={removeBackground} onChange={(event) => setRemoveBackground(event.currentTarget.checked)} disabled={isRunning} />
          <span>Remove background</span>
        </label>
        <label>
          <span>Inference device</span>
          <select value={device} onChange={(event) => setDevice(event.currentTarget.value as "cuda" | "cpu")} disabled={isRunning}>
            <option value="cuda" disabled={!cudaAvailable}>NVIDIA CUDA</option>
            <option value="cpu">CPU (slower)</option>
          </select>
        </label>
      </div>

      <p className="generation-panel__help">
        For sharper resemblance, use a clear, high-resolution image with one centered subject and visible edges. The model encodes images at a fixed resolution; mesh quality changes surface sampling, not image detail.
      </p>

      <div className="generation-panel__status" role="status" aria-live="polite">
        <span className={`generation-panel__status-dot generation-panel__status-dot--${job?.status ?? (isRunning ? "running" : "ready")}`} />
        <span>{statusMessage}</span>
      </div>

      {job && (
        <div className="generation-panel__progress-area">
          <div className="generation-panel__progress-labels">
            <span>{stageLabel(job.stage)}</span>
            <span>{progressPercent}%</span>
          </div>
          <progress
            className="generation-panel__progress"
            max={100}
            value={progressPercent}
            aria-label={`Generation progress: ${progressPercent}%`}
          />
          <p className="generation-panel__job-id">Job <code>{job.job_id}</code></p>
        </div>
      )}

      {problem && (
        <div className="generation-panel__error" role="alert">
          <div className="generation-panel__error-heading">
            <strong>{problem.message}</strong>
            <code>{problem.code}</code>
          </div>
          <p>{problem.suggestion}</p>
          {problem.details && (
            <details>
              <summary>Technical details</summary>
              <pre>{JSON.stringify(problem.details, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      <div className="generation-panel__actions">
        <button
          className="generation-panel__button generation-panel__button--primary"
          type="button"
          onClick={() => void startGeneration()}
          disabled={!canStart}
          aria-describedby={`${panelId}-image-help`}
        >
          {isRunning ? "Generating…" : job?.status === "completed" ? "Generate again" : "Generate 3D model"}
        </button>
        <button
          className="generation-panel__button generation-panel__button--secondary"
          type="button"
          onClick={() => void cancelGeneration()}
          disabled={!canCancel}
        >
          {isCancelPending ? "Requesting cancellation…" : cancellationRequested ? "Cancellation requested" : "Cancel generation"}
        </button>
      </div>

      <p id={`${panelId}-image-help`} className={`generation-panel__help${invalidImage && image ? " generation-panel__help--error" : ""}`}>
        {image ? `${image.name} · ${(image.size / (1024 * 1024)).toFixed(1)} MiB` : "Import an image to enable generation."}
        {invalidImage && image ? ` ${invalidImage}` : ""}
      </p>
    </section>
  );
}
