#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

struct LocalService(Mutex<Option<Child>>);

struct ServicePaths {
    executable: PathBuf,
    service_dir: PathBuf,
    triposr_root: PathBuf,
    arguments: &'static [&'static str],
}

#[cfg(debug_assertions)]
fn service_paths(_app: &tauri::AppHandle) -> Result<ServicePaths, String> {
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .map_err(|error| format!("Could not locate the project root: {error}"))?;
    let service_dir = std::env::var_os("IMAGE_TO_STL_SERVICE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| project_root.join("services/generation"));
    let executable = std::env::var_os("IMAGE_TO_STL_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| project_root.join(".venv-phase0/Scripts/python.exe"));
    let triposr_root = std::env::var_os("TRIPOSR_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| project_root.join("third_party/TripoSR"));
    Ok(ServicePaths {
        executable,
        service_dir,
        triposr_root,
        arguments: &["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8765"],
    })
}

#[cfg(not(debug_assertions))]
fn service_paths(app: &tauri::AppHandle) -> Result<ServicePaths, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve local application data directory: {error}"))?;
    let runtime_dir = fs::read_to_string(local_data.join("runtime-path.txt"))
        .ok()
        .map(|path| PathBuf::from(path.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| local_data.join("runtime"));
    let service_dir = runtime_dir.join("generation-service");
    Ok(ServicePaths {
        executable: service_dir.join("generation-service.exe"),
        service_dir,
        triposr_root: runtime_dir.join("third_party/TripoSR"),
        arguments: &[],
    })
}

fn launch_service(app: &tauri::AppHandle) -> Result<Child, String> {
    let local_app_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve local application data directory: {error}"))?;
    let app_data = local_app_data.join("data");
    let log_dir = app_data.join("logs");
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Could not create service log directory: {error}"))?;
    let log_path = log_dir.join("generation-service.log");
    let mut log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Could not open service log {}: {error}", log_path.display()))?;

    let paths = service_paths(app)?;
    if !paths.executable.is_file() {
        let message = format!("Generation service executable not found at {}", paths.executable.display());
        let _ = writeln!(log_file, "Startup failed: {message}");
        return Err(message);
    }
    if !paths.service_dir.is_dir() {
        let message = format!("Generation service directory not found at {}", paths.service_dir.display());
        let _ = writeln!(log_file, "Startup failed: {message}");
        return Err(message);
    }
    if !paths.triposr_root.is_dir() {
        let message = format!("Pinned TripoSR source not found at {}", paths.triposr_root.display());
        let _ = writeln!(log_file, "Startup failed: {message}");
        return Err(message);
    }

    let stdout = log_file
        .try_clone()
        .map_err(|error| format!("Could not attach service log output: {error}"))?;
    let stderr = log_file
        .try_clone()
        .map_err(|error| format!("Could not attach service error log: {error}"))?;
    writeln!(
        log_file,
        "Starting local generation service with {} in {}",
        paths.executable.display(),
        paths.service_dir.display()
    )
    .map_err(|error| format!("Could not write service startup log: {error}"))?;

    let mut command = Command::new(&paths.executable);
    command
        .args(paths.arguments)
        .current_dir(&paths.service_dir)
        .env("GENERATION_DATA_DIR", &app_data)
        .env("TRIPOSR_ROOT", &paths.triposr_root)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Ok(model_cache_path) = fs::read_to_string(local_app_data.join("model-cache-path.txt")) {
        let model_cache_path = model_cache_path.trim();
        if !model_cache_path.is_empty() {
            command.env("HF_HOME", model_cache_path);
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    command
        .spawn()
        .map_err(|error| format!("Could not start the local generation service: {error}"))
}

fn stop_service(app: &tauri::AppHandle) {
    let Some(service) = app.try_state::<LocalService>() else {
        return;
    };
    let Ok(mut child_slot) = service.0.lock() else {
        eprintln!("Could not lock local service process state during shutdown");
        return;
    };
    if let Some(mut child) = child_slot.take() {
        if let Err(error) = child.kill() {
            eprintln!("Could not stop local generation service: {error}");
        }
        if let Err(error) = child.wait() {
            eprintln!("Could not wait for local generation service to stop: {error}");
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let child = match launch_service(app.handle()) {
                Ok(child) => Some(child),
                Err(error) => {
                    eprintln!("Local generation service did not start: {error}");
                    None
                }
            };
            app.manage(LocalService(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build 3dare desktop application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            stop_service(app_handle);
        }
    });
}
