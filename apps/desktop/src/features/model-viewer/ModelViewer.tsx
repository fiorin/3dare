import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import "./ModelViewer.css";

type LoadState = "loading" | "ready" | "error";

interface ModelDimensions {
  width: number;
  height: number;
  depth: number;
}

interface ViewerRuntime {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  grid: THREE.GridHelper;
  axes: THREE.AxesHelper;
  holder: THREE.Group | null;
  sourceRoot: THREE.Object3D | null;
  baseDimensions: THREE.Vector3 | null;
  baseCameraPosition: THREE.Vector3 | null;
  scale: number;
  animationFrame: number;
  resizeObserver: ResizeObserver | null;
  objectUrls: Set<string>;
  revocationTimers: Set<number>;
}

interface ModelViewerProps {
  modelUrl: string;
}

interface SaveFilePickerOptions {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}

interface SaveFileWritable {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface SaveFileHandle {
  createWritable(): Promise<SaveFileWritable>;
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: SaveFilePickerOptions) => Promise<SaveFileHandle>;
};

function collectMaterials(root: THREE.Object3D): Set<THREE.Material> {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => materials.add(material));
    } else {
      materials.add(mesh.material);
    }
  });
  return materials;
}

function disposeMaterials(root: THREE.Object3D): void {
  const materials = collectMaterials(root);
  const textures = new Set<THREE.Texture>();
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
  }
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    const image = texture.image;
    if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
    texture.dispose();
  }
}

function disposeModelResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) geometries.add(mesh.geometry);
  });
  for (const geometry of geometries) geometry.dispose();
  disposeMaterials(root);
}

function clearLoadedModel(runtime: ViewerRuntime): void {
  if (runtime.holder) {
    runtime.scene.remove(runtime.holder);
    if (runtime.sourceRoot) disposeModelResources(runtime.sourceRoot);
  }
  runtime.holder = null;
  runtime.sourceRoot = null;
  runtime.baseDimensions = null;
  runtime.baseCameraPosition = null;
  runtime.scale = 1;
  updateGroundHelpers(runtime, new THREE.Vector3(1, 1, 1), 1);
}

function updateGroundHelpers(
  runtime: ViewerRuntime,
  dimensions: THREE.Vector3,
  scale: number,
): void {
  const helperScale = Math.max(dimensions.x, dimensions.y, dimensions.z, 1e-5) * 0.25 * scale;
  const groundY = -dimensions.y * scale * 0.5;
  runtime.grid.scale.setScalar(helperScale);
  runtime.grid.position.y = groundY;
  runtime.axes.scale.setScalar(helperScale);
  runtime.axes.position.set(0, groundY, 0);
}

function setCameraRange(runtime: ViewerRuntime, dimensions: THREE.Vector3): void {
  const largestDimension = Math.max(dimensions.x, dimensions.y, dimensions.z);
  runtime.camera.near = Math.max(largestDimension / 10000, 1e-9);
  runtime.camera.far = Math.max(largestDimension * 100, 100);
  runtime.camera.updateProjectionMatrix();
  runtime.controls.minDistance = Math.max(largestDimension * 0.005, 1e-8);
  runtime.controls.maxDistance = Math.max(largestDimension * 1000, runtime.controls.minDistance * 10);
}

function resetCamera(runtime: ViewerRuntime): void {
  if (!runtime.baseCameraPosition) return;
  runtime.controls.target.set(0, 0, 0);
  runtime.camera.position.copy(runtime.baseCameraPosition).multiplyScalar(runtime.scale);
  runtime.camera.lookAt(runtime.controls.target);
  runtime.controls.update();
}

function formatMillimeters(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return value.toFixed(0);
  if (magnitude >= 10) return value.toFixed(1);
  if (magnitude >= 0.1) return value.toFixed(2);
  return value.toPrecision(3);
}

export function ModelViewer({ modelUrl }: ModelViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [exportError, setExportError] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  const [targetHeight, setTargetHeight] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [dimensions, setDimensions] = useState<ModelDimensions | null>(null);
  const targetHeightValue = Number(targetHeight);
  const baseDimensions = runtimeRef.current?.baseDimensions;
  const targetScale = baseDimensions ? targetHeightValue / baseDimensions.y : Number.NaN;
  const targetDimensions = baseDimensions?.clone().multiplyScalar(targetScale);
  const validTargetHeight =
    Number.isFinite(targetHeightValue) &&
    targetHeightValue > 0 &&
    Number.isFinite(targetScale) &&
    !!targetDimensions &&
    Number.isFinite(targetDimensions.x) &&
    Number.isFinite(targetDimensions.y) &&
    Number.isFinite(targetDimensions.z);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let fallbackResize: (() => void) | null = null;

    let runtime: ViewerRuntime;
    try {
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.setClearColor(0xe8ebef, 1);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xe8ebef);
      const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = true;
      controls.screenSpacePanning = true;
      controls.zoomSpeed = 0.9;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x747985, 2.1));
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
      keyLight.position.set(5, 8, 6);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0xdce4ff, 0.75);
      fillLight.position.set(-5, 2, -4);
      scene.add(fillLight);

      const grid = new THREE.GridHelper(10, 20, 0x8a9695, 0xc5ccca);
      grid.material.transparent = true;
      grid.material.opacity = 0.65;
      const axes = new THREE.AxesHelper(1);
      scene.add(grid, axes);

      runtime = {
        scene,
        camera,
        renderer,
        controls,
        grid,
        axes,
        holder: null,
        sourceRoot: null,
        baseDimensions: null,
        baseCameraPosition: null,
        scale: 1,
        animationFrame: 0,
        resizeObserver: null,
        objectUrls: new Set(),
        revocationTimers: new Set(),
      };
      runtimeRef.current = runtime;

      const resize = () => {
        const bounds = canvas.getBoundingClientRect();
        const width = Math.max(1, bounds.width);
        const height = Math.max(1, bounds.height);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      if (typeof ResizeObserver !== "undefined") {
        runtime.resizeObserver = new ResizeObserver(resize);
        runtime.resizeObserver.observe(canvas);
      }
      fallbackResize = resize;
      window.addEventListener("resize", fallbackResize);
      resize();

      const render = () => {
        runtime.animationFrame = window.requestAnimationFrame(render);
        controls.update();
        renderer.render(scene, camera);
      };
      runtime.animationFrame = window.requestAnimationFrame(render);
    } catch (error) {
      setLoadState("error");
      const detail = error instanceof Error ? error.message : String(error);
      setLoadError(`The 3D viewer could not be initialized: ${detail}`);
      console.error("Could not initialize the 3D viewer.", error);
      return;
    }

    return () => {
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      window.cancelAnimationFrame(runtime.animationFrame);
      runtime.resizeObserver?.disconnect();
      if (fallbackResize) window.removeEventListener("resize", fallbackResize);
      runtime.controls.dispose();
      clearLoadedModel(runtime);
      runtime.grid.geometry.dispose();
      runtime.grid.material.dispose();
      runtime.axes.geometry.dispose();
      runtime.axes.material.dispose();
      for (const timer of runtime.revocationTimers) window.clearTimeout(timer);
      for (const url of runtime.objectUrls) URL.revokeObjectURL(url);
      runtime.revocationTimers.clear();
      runtime.objectUrls.clear();
      runtime.renderer.dispose();
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    let cancelled = false;
    setLoadState("loading");
    setLoadError("");
    setExportError("");
    setDimensions(null);
    clearLoadedModel(runtime);

    if (!modelUrl) {
      setLoadState("error");
      setLoadError("No model URL was provided.");
      return;
    }

    const loader = new GLTFLoader();
    loader.load(
      modelUrl,
      (gltf) => {
        if (cancelled) {
          disposeModelResources(gltf.scene);
          return;
        }

        const sourceRoot = gltf.scene;
        try {
          const bounds = new THREE.Box3().setFromObject(sourceRoot);
          const baseDimensions = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          let meshCount = 0;
          sourceRoot.traverse((object) => {
            if ((object as THREE.Mesh).isMesh) meshCount += 1;
          });
          if (
            meshCount === 0 ||
            bounds.isEmpty() ||
            !Number.isFinite(baseDimensions.x) ||
            !Number.isFinite(baseDimensions.y) ||
            !Number.isFinite(baseDimensions.z) ||
            baseDimensions.y <= 0
          ) {
            throw new Error("The model has no measurable geometry.");
          }

          disposeMaterials(sourceRoot);
          const clayMaterial = new THREE.MeshStandardMaterial({
            color: 0xc3c5c1,
            roughness: 0.88,
            metalness: 0,
            emissive: 0x111312,
            emissiveIntensity: 0.18,
            side: THREE.DoubleSide,
          });
          sourceRoot.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) return;
            if (!mesh.geometry.getAttribute("normal")) mesh.geometry.computeVertexNormals();
            mesh.material = clayMaterial;
          });

          const holder = new THREE.Group();
          holder.position.copy(center).negate();
          holder.add(sourceRoot);
          runtime.scene.add(holder);
          runtime.holder = holder;
          runtime.sourceRoot = sourceRoot;
          runtime.baseDimensions = baseDimensions;
          runtime.scale = 1;
          updateGroundHelpers(runtime, baseDimensions, runtime.scale);

          const radius = baseDimensions.length() * 0.5;
          const cameraDistance = radius / Math.sin(THREE.MathUtils.degToRad(runtime.camera.fov * 0.5)) * 1.2;
          runtime.baseCameraPosition = new THREE.Vector3(1, 0.75, 1)
            .normalize()
            .multiplyScalar(cameraDistance);
          setCameraRange(runtime, baseDimensions);
          resetCamera(runtime);

          setDimensions({
            width: baseDimensions.x,
            height: baseDimensions.y,
            depth: baseDimensions.z,
          });
          setTargetHeight("50");
          setLoadState("ready");
        } catch {
          disposeModelResources(sourceRoot);
          setLoadState("error");
          setLoadError("Unable to display this model. Make sure the URL points to a valid GLB file.");
        }
      },
      undefined,
      () => {
        if (cancelled) return;
        setLoadState("error");
        setLoadError("Unable to load this model. Make sure the URL points to a valid GLB file.");
      },
    );

    return () => {
      cancelled = true;
      clearLoadedModel(runtime);
    };
  }, [modelUrl]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const requestedHeight = Number(targetHeight);
    const baseDimensions = runtime?.baseDimensions;
    if (
      !runtime?.holder ||
      !baseDimensions ||
      !Number.isFinite(requestedHeight) ||
      requestedHeight <= 0
    ) {
      return;
    }

    const nextScale = requestedHeight / baseDimensions.y;
    const nextDimensions = baseDimensions.clone().multiplyScalar(nextScale);
    if (
      !Number.isFinite(nextScale) ||
      !Number.isFinite(nextDimensions.x) ||
      !Number.isFinite(nextDimensions.y) ||
      !Number.isFinite(nextDimensions.z)
    ) {
      return;
    }

    const scaleRatio = nextScale / runtime.scale;
    runtime.holder.scale.setScalar(nextScale);
    runtime.camera.position.multiplyScalar(scaleRatio);
    runtime.controls.target.multiplyScalar(scaleRatio);
    runtime.scale = nextScale;
    updateGroundHelpers(runtime, baseDimensions, nextScale);
    setCameraRange(runtime, nextDimensions);
    runtime.controls.update();
    setDimensions({
      width: nextDimensions.x,
      height: nextDimensions.y,
      depth: nextDimensions.z,
    });
  }, [targetHeight]);

  const handleResetCamera = () => {
    const runtime = runtimeRef.current;
    if (runtime) resetCamera(runtime);
  };

  const handleExport = async () => {
    const runtime = runtimeRef.current;
    if (!runtime?.holder || !validTargetHeight || isExporting) return;

    setExportError("");
    setExportMessage("");
    setIsExporting(true);
    try {
      const exported = new STLExporter().parse(runtime.holder, { binary: true });
      if (typeof exported === "string") throw new Error("Binary STL export failed.");
      const binary = exported.buffer.slice(
        exported.byteOffset,
        exported.byteOffset + exported.byteLength,
      ) as ArrayBuffer;
      const pickerWindow = window as SaveFilePickerWindow;

      if (pickerWindow.showSaveFilePicker) {
        let handle: SaveFileHandle;
        try {
          handle = await pickerWindow.showSaveFilePicker({
            suggestedName: "model.stl",
            types: [{ description: "Binary STL model", accept: { "model/stl": [".stl"] } }],
          });
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          throw error;
        }

        const writable = await handle.createWritable();
        try {
          await writable.write(binary);
          await writable.close();
        } catch (error) {
          await writable.abort?.(error);
          throw error;
        }
        setExportMessage("Binary STL saved to the selected location.");
        return;
      }

      const objectUrl = URL.createObjectURL(new Blob([binary], { type: "model/stl" }));
      runtime.objectUrls.add(objectUrl);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = "model.stl";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        runtime.objectUrls.delete(objectUrl);
        runtime.revocationTimers.delete(timer);
      }, 1000);
      runtime.revocationTimers.add(timer);
      setExportMessage("Binary STL download started.");
    } catch {
      setExportError("STL export failed. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <section className="model-viewer" aria-label="3D model viewer">
      <div className="model-viewer__toolbar">
        <label className="model-viewer__height-control">
          <span>Target height <span className="model-viewer__unit">(mm)</span></span>
          <input
            aria-label="Target model height in millimeters"
            type="number"
            min="0.001"
            step="any"
            value={targetHeight}
            onChange={(event) => setTargetHeight(event.currentTarget.value)}
            disabled={loadState !== "ready"}
            aria-invalid={loadState === "ready" && !validTargetHeight}
          />
          {loadState === "ready" && !validTargetHeight && (
            <span className="model-viewer__validation-error" role="alert">Enter a finite target height greater than zero.</span>
          )}
        </label>
        <div className="model-viewer__actions">
          <button
            className="model-viewer__button model-viewer__button--secondary"
            type="button"
            onClick={handleResetCamera}
            disabled={loadState !== "ready"}
          >
            Reset camera
          </button>
          <button
            className="model-viewer__button model-viewer__button--primary"
            type="button"
            onClick={handleExport}
            disabled={loadState !== "ready" || !validTargetHeight || isExporting}
          >
            {isExporting ? "Savingâ€¦" : "Export STL"}
          </button>
        </div>
      </div>

      <div className="model-viewer__stage">
        <canvas ref={canvasRef} className="model-viewer__canvas" aria-label="Interactive 3D model" />
        {loadState === "loading" && (
          <div className="model-viewer__message" role="status">Loading modelâ€¦</div>
        )}
        {loadState === "error" && (
          <div className="model-viewer__message model-viewer__message--error" role="alert">
            {loadError}
          </div>
        )}
        {loadState === "ready" && dimensions && (
          <div className="model-viewer__dimensions" aria-live="polite">
            <span>W {formatMillimeters(dimensions.width)} mm</span>
            <span>H {formatMillimeters(dimensions.height)} mm</span>
            <span>D {formatMillimeters(dimensions.depth)} mm</span>
          </div>
        )}
      </div>

      <div className="model-viewer__footer">
        <span>Drag to orbit Â· right-drag to pan Â· scroll to zoom</span>
        {exportMessage && <span className="model-viewer__export-success" role="status">{exportMessage}</span>}
        {exportError && <span className="model-viewer__export-error" role="alert">{exportError}</span>}
      </div>
    </section>
  );
}

