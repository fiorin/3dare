import { lazy, Suspense, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { GenerationPanel } from "./features/generation/GenerationPanel";
const ModelViewer = lazy(() =>
  import("./features/model-viewer/ModelViewer").then(({ ModelViewer: Component }) => ({ default: Component })),
);

type HealthResponse = {
  status: "ready" | "degraded";
  model_loaded: boolean;
  cuda_available: boolean;
  gpu_name: string | null;
  vram_total_mib: number | null;
  vram_free_mib: number | null;
};

type ServiceState =
  | { status: "checking" }
  | { status: "offline" }
  | { status: "online" | "degraded"; health: HealthResponse };

type GeneratedModel = { jobId: string; modelUrl: string };

const HEALTH_URL = "http://127.0.0.1:8765/api/v1/health";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE = /\.(png|jpe?g|webp)$/i;

function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const health = value as Partial<HealthResponse>;
  return (
    (health.status === "ready" || health.status === "degraded") &&
    typeof health.model_loaded === "boolean" &&
    typeof health.cuda_available === "boolean"
  );
}

function App() {
  const [image, setImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [service, setService] = useState<ServiceState>({ status: "checking" });
  const importAttempt = useRef(0);
  const [generationBusy, setGenerationBusy] = useState(false);
  const [generatedModel, setGeneratedModel] = useState<GeneratedModel | null>(null);

  useEffect(() => {
    if (!image) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    if (!generatedModel) return;
    return () => URL.revokeObjectURL(generatedModel.modelUrl);
  }, [generatedModel]);

  useEffect(() => {
    let disposed = false;
    const checkHealth = async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(HEALTH_URL, { signal: controller.signal });
        if (!response.ok) throw new Error(`Health endpoint returned ${response.status}`);
        const result: unknown = await response.json();
        if (!isHealthResponse(result)) throw new Error("Invalid health response");
        if (!disposed) {
          setService({
            status: result.status === "ready" ? "online" : "degraded",
            health: result,
          });
        }
      } catch {
        if (!disposed) setService({ status: "offline" });
      } finally {
        window.clearTimeout(timeout);
      }
    };

    void checkHealth();
    const interval = window.setInterval(() => void checkHealth(), 2500);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const importImage = async (selected: File | null) => {
    if (!selected) return;
    const attempt = ++importAttempt.current;
    if (!SUPPORTED_IMAGE.test(selected.name)) {
      setNotice("Choose a PNG, JPEG, or WebP image.");
      return;
    }
    if (selected.size > MAX_IMAGE_BYTES) {
      setNotice("The image must be 20 MiB or smaller.");
      return;
    }

    try {
      const header = new Uint8Array(await selected.slice(0, 12).arrayBuffer());
      const extension = selected.name.toLowerCase().split(".").pop();
      const isPng = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
      const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
      const isWebp =
        header.length >= 12 &&
        String.fromCharCode(...header.slice(0, 4)) === "RIFF" &&
        String.fromCharCode(...header.slice(8, 12)) === "WEBP";
      const formatMatches =
        (extension === "png" && isPng) ||
        ((extension === "jpg" || extension === "jpeg") && isJpeg) ||
        (extension === "webp" && isWebp);
      if (!formatMatches) {
        throw new Error("The file contents do not match a PNG, JPEG, or WebP image.");
      }

      const bitmap = await createImageBitmap(selected);
      bitmap.close();
      if (attempt !== importAttempt.current) return;
      setNotice(null);
      setImage(selected);
      setGeneratedModel(null);
    } catch (error) {
      if (attempt === importAttempt.current) {
        setNotice(error instanceof Error ? error.message : "The selected image could not be decoded.");
      }
    }
  };

  const handleImageSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    void importImage(selected);
  };

  const handleImageDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    void importImage(event.dataTransfer.files[0] ?? null);
  };



  const statusText = {
    checking: "Connecting to local service",
    online: "Local service ready",
    degraded: "Service ready · CUDA unavailable",
    offline: "Local service unavailable",
  }[service.status];

  const serviceAvailable = service.status === "online" || service.status === "degraded";
  const cudaAvailable = serviceAvailable && service.health.cuda_available;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="FormForge home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <path d="m16 3 11 6.5v13L16 29 5 22.5v-13L16 3Z" />
              <path d="m5.5 9.7 10.5 6.2 10.5-6.2M16 16v12.5" />
            </svg>
          </span>
          <span>FORMFORGE</span>
          <span className="brand-divider" />
          <span className="brand-context">IMAGE TO 3D</span>
        </a>
        <div className={`service-pill service-${service.status}`} role="status" aria-live="polite">
          <span className="status-dot" />
          {statusText}
        </div>
      </header>

      <main id="home" className="main-content">
        <section className="intro">
          <p className="eyebrow">LOCAL WORKSPACE <span>·</span> PRIVATE BY DESIGN</p>
          <h1>Turn an image into <span>something real.</span></h1>
          <p className="intro-copy">
            Generation, preview, and model processing stay on this machine.
          </p>
        </section>

        <div className="workspace-grid">
          <section className={`import-card ${image ? "has-image" : ""}`} aria-labelledby="import-heading">
            <div className="card-heading">
              <div>
                <p className="step-label"><span>01</span> / IMAGE</p>
                <h2 id="import-heading">Choose your starting point</h2>
              </div>
              {image && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => { setImage(null); setGeneratedModel(null); setNotice(null); }}
                  disabled={generationBusy}
                >
                  Remove image
                </button>
              )}
            </div>

            <input
              id="image-upload"
              className="visually-hidden"
              type="file"
              disabled={generationBusy}
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              onChange={handleImageSelection}
            />

            {image && previewUrl ? (
              <div className="image-preview" data-testid="image-preview">
                <img src={previewUrl} alt={`Preview of ${image.name}`} />
                <div className="image-details">
                  <span className="file-type-mark">IMG</span>
                  <div className="file-info">
                    <strong title={image.name}>{image.name}</strong>
                    <span>{(image.size / (1024 * 1024)).toFixed(2)} MiB</span>
                  </div>
                  <span className="file-ready" aria-label="Image imported">✓</span>
                </div>
              </div>
            ) : (
              <label
                className="dropzone"
                htmlFor="image-upload"
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleImageDrop}
              >
                <span className="upload-icon" aria-hidden="true">
                  <svg viewBox="0 0 32 32" fill="none">
                    <path d="M16 21V6m0 0-5.5 5.5M16 6l5.5 5.5" />
                    <path d="M6 19v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6" />
                  </svg>
                </span>
                <strong>Drop an image here</strong>
                <span className="dropzone-subtitle">or <span className="browse-link">browse files</span></span>
                <span className="format-note">PNG, JPG, or WebP <i>·</i> up to 20 MiB</span>
              </label>
            )}
            {notice && <p className="input-notice" role="alert">{notice}</p>}
            <p className="privacy-note"><span aria-hidden="true">⌑</span> Images stay on your device. Nothing is uploaded to a server.</p>
          </section>

          <aside className="side-column">
            <section className="service-card" aria-labelledby="service-heading">
              <div className="card-heading compact-heading">
                <div>
                  <p className="step-label"><span>LOCAL</span> / ENGINE</p>
                  <h2 id="service-heading">Generation service</h2>
                </div>
                <span className={`engine-icon engine-${service.status}`} aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42m-9.88 9.88-1.42 1.42" /><circle cx="12" cy="12" r="5" /></svg>
                </span>
              </div>
              {service.status === "online" || service.status === "degraded" ? (
                <div className="engine-details">
                  <div className="detail-row"><span>Connection</span><strong className="connected-value">Connected</strong></div>
                  <div className="detail-row"><span>Compute</span><strong>{service.health.cuda_available ? "CUDA enabled" : "CPU only"}</strong></div>
                  <div className="detail-row"><span>Device</span><strong>{service.health.gpu_name ?? "No GPU detected"}</strong></div>
                  {service.health.vram_total_mib !== null && (
                    <div className="detail-row"><span>Video memory</span><strong>{service.health.vram_free_mib ?? "—"} / {service.health.vram_total_mib} MiB free</strong></div>
                  )}
                  <div className="detail-row"><span>Model weights</span><strong>{service.health.model_loaded ? "Loaded" : "Load on first run"}</strong></div>
                </div>
              ) : (
                <div className="service-message">
                  <p>{service.status === "checking" ? "Checking the local engine…" : "The local engine is not responding."}</p>
                  <span>{service.status === "offline" ? "Keep this app open and check the local Python environment." : "This can take a moment after launch."}</span>
                </div>
              )}
              <div className="local-badge"><span className="local-lock" aria-hidden="true">⌑</span> LOCAL PROCESS ONLY</div>
            </section>

            {image ? (
              <GenerationPanel
                image={image}
                serviceAvailable={serviceAvailable}
                cudaAvailable={cudaAvailable}
                onBusyChange={setGenerationBusy}
                onModelReady={setGeneratedModel}
              />
            ) : (
              <section className="next-card" aria-label="Next step">
                <span className="next-number">02</span>
                <div>
                  <strong>Start with an image</strong>
                  <p>Import a PNG, JPEG, or WebP image to configure local generation.</p>
                </div>
                <span className="next-arrow" aria-hidden="true">↗</span>
              </section>
            )}
          </aside>
        </div>

        {generatedModel && (
          <section className="model-workspace" aria-labelledby="model-workspace-title">
            <div className="model-workspace__heading">
              <div>
                <p className="step-label"><span>03</span> / MODEL</p>
                <h2 id="model-workspace-title">Generated model</h2>
              </div>
              <span className="model-workspace__job">Job {generatedModel.jobId}</span>
            </div>
            <Suspense fallback={<div className="viewer-loading" role="status">Loading 3D viewer…</div>}>
              <ModelViewer modelUrl={generatedModel.modelUrl} />
            </Suspense>
          </section>
        )}

        <footer className="workspace-footer">
          <span>FORMFORGE <span className="footer-separator">/</span> BUILT TO RUN LOCALLY</span>
          <span>LOCAL WORKSPACE <span className="footer-separator">·</span> GENERATE, PREVIEW, EXPORT</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
