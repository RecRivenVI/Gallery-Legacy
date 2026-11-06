use crate::backend::{self, Backend, Paths};
use base64::Engine;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, atomic::AtomicU8};
use tauri::Manager;

const OPERATIONS: &[&str] = &[
    "config.read",
    "config.validate",
    "config.save",
    "config.backups",
    "config.backup.read",
    "logs.list",
    "logs.read",
    "logs.clear",
    "reports.list",
    "reports.read",
    "storage.read",
    "cache.clear",
    "generations.list",
    "generation.validate",
    "generation.publish",
    "generation.rollback",
    "retention.plan",
    "retention.apply",
    "diagnostics.run",
    "scope.check",
    "scan.start",
    "scan.status",
    "scan.issues",
    "scan.cancel",
    "access.read",
    "access.clear",
    "access.block",
    "live.reset",
    "scope.authors",
    "validation.checks",
    "validation.start",
    "validation.status",
    "validation.cancel",
    "validation.findings",
    "validation.export",
    "validation.purge",
    "validation.location",
    "cache.orphans",
    "cache.orphans.clear",
    "access.configure",
    "access.autoban",
    "thumbnails.status",
    "thumbnails.pause",
    "thumbnails.start",
    "thumbnails.cancel",
    "accounts.list",
    "accounts.reset",
    "accounts.delete",
];

pub(crate) struct Host {
    pub(crate) backend: Arc<Mutex<Option<Backend>>>,
    pub(crate) connection: Value,
    pub(crate) paths: Paths,
    pub(crate) failure: Mutex<Option<String>>,
    pub(crate) quitting: Arc<AtomicU8>,
}

pub(crate) fn native_method(host: &Host, method: &str, input: Value) -> Result<Value, String> {
    if method == "resource" || method == "resourceText" {
        let name = input["path"].as_str().ok_or("RESOURCE_FORBIDDEN")?;
        if method == "resourceText" && name != "misans/manifest.json" {
            return Err("RESOURCE_FORBIDDEN".into());
        }
        let bytes = backend::resource(&host.paths.assets, name)?;
        return Ok(Value::String(if method == "resourceText" {
            String::from_utf8(bytes).map_err(|_| "RESOURCE_INVALID")?
        } else {
            base64::engine::general_purpose::STANDARD.encode(bytes)
        }));
    }
    let mut guard = host.backend.lock().map_err(|_| "HOST_SESSION_ENDED")?;
    let backend = match guard.as_mut() {
        Some(value) => value,
        None if method == "status" => {
            let failure = host
                .failure
                .lock()
                .map_err(|_| "HOST_SESSION_ENDED")?
                .clone();
            return Ok(
                json!({"state":"STOPPED", "localControl":false, "hostFailure":failure, "scan":{"state":"IDLE","running":false}}),
            );
        }
        None => {
            return Err(host
                .failure
                .lock()
                .map_err(|_| "HOST_SESSION_ENDED")?
                .clone()
                .unwrap_or("RUNTIME_OFFLINE".into()));
        }
    };
    match method {
        "resourceBase" | "openGallery" => {
            let current = backend.call("connection", "", json!({}))?;
            let url = current["url"].as_str().ok_or("RUNTIME_OFFLINE")?;
            if method == "resourceBase" {
                Ok(Value::String(url.into()))
            } else {
                open::that(url).map_err(|_| "OPEN_FAILED")?;
                Ok(json!({"opened":true}))
            }
        }
        "start" | "stop" | "restart" => backend.call(method, "", json!({})),
        "status" => {
            let mut value = backend.call("status", "", json!({}))?;
            value["localControl"] = true.into();
            value["hostBusy"] = false.into();
            Ok(value)
        }
        "admin" => {
            let op = input["operation"]
                .as_str()
                .ok_or("MANAGEMENT_OPERATION_INVALID")?;
            if !OPERATIONS.contains(&op) {
                return Err("MANAGEMENT_OPERATION_INVALID".into());
            }
            backend.call(
                "manage",
                op,
                input.get("input").cloned().unwrap_or(json!({})),
            )
        }
        "openDirectory" => {
            let kind = input["kind"].as_str().ok_or("LOCATION_FORBIDDEN")?;
            if !["instance", "config", "logs", "reports", "cache"].contains(&kind) {
                return Err("LOCATION_FORBIDDEN".into());
            }
            let locations = backend.call("manage", "locations", json!({}))?;
            open::that(locations[kind].as_str().ok_or("LOCATION_FORBIDDEN")?)
                .map_err(|_| "OPEN_FAILED")?;
            Ok(json!({"opened":true}))
        }
        "openFinding" => {
            let result = backend.call("manage", "validation.location", input)?;
            let path = result["path"].as_str().ok_or("LOCATION_FORBIDDEN")?;
            #[cfg(windows)]
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{path}"))
                .spawn()
                .map_err(|_| "OPEN_FAILED")?;
            Ok(json!({"opened":true}))
        }
        _ => Err("MANAGEMENT_OPERATION_INVALID".into()),
    }
}

#[tauri::command]
pub(crate) async fn host_call(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Host>>,
    method: String,
    input: Value,
) -> Result<Value, String> {
    let url = window.url().map_err(|_| "HOST_CALL_FORBIDDEN")?;
    if window.label() != "manager" || !local_document(&url) {
        return Err("HOST_CALL_FORBIDDEN".into());
    }
    if method == "quit" {
        window.app_handle().exit(0);
        return Ok(Value::Null);
    }
    if method == "pickDirectory" {
        return Ok(rfd::AsyncFileDialog::new()
            .set_parent(&window)
            .pick_folder()
            .await
            .map(|p| Value::String(p.path().to_string_lossy().into_owned()))
            .unwrap_or(Value::Null));
    }
    let host = state.inner().clone();
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let refresh = matches!(method.as_str(), "start" | "stop" | "restart");
        let result = native_method(&host, &method, input);
        if refresh && let Err(error) = crate::desktop::refresh(&app) {
            eprintln!("{error}");
        }
        result
    })
    .await
    .map_err(|_| "HOST_REQUEST_FAILED")?
}

pub(crate) fn local_document(url: &tauri::Url) -> bool {
    ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
        && url.port().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

pub(crate) fn paths() -> Result<Paths, String> {
    let args: Vec<String> = std::env::args().collect();
    let option = |key: &str| {
        args.iter()
            .position(|v| v == key)
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from)
    };
    let directory = std::env::current_exe()
        .map_err(|_| "HOST_PATH_FAILED")?
        .parent()
        .ok_or("HOST_PATH_FAILED")?
        .to_owned();
    let config = if let Some(path) = option("--config") {
        path
    } else {
        let value: Value = serde_json::from_slice(
            &std::fs::read(directory.join("gallery.instance.json"))
                .map_err(|_| "CONFIG_REQUIRED")?,
        )
        .map_err(|_| "CONFIG_REQUIRED")?;
        let path = PathBuf::from(value["configPath"].as_str().ok_or("CONFIG_REQUIRED")?);
        if path.is_absolute() {
            path
        } else {
            directory.join(path)
        }
    };
    Ok(Paths {
        config,
        executable: option("--runtime").unwrap_or(directory.join("gallery-runtime.exe")),
        assets: option("--assets").unwrap_or(directory.join("resources")),
    })
}
