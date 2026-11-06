#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backend;
mod commands;
mod desktop;

use backend::Backend;
use commands::{Host, local_document, native_method, paths};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU8, Ordering},
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

fn main() {
    let paths = paths().unwrap_or_else(|error| {
        eprintln!("{error}");
        rfd::MessageDialog::new()
            .set_title("画廊管理器")
            .set_description("无法打开配置文件，请使用配置好的画廊快捷方式启动。")
            .set_level(rfd::MessageLevel::Error)
            .show();
        std::process::exit(1)
    });
    let connection = paths.connection();
    let failure = connection.as_ref().err().cloned();
    let connection = connection.unwrap_or(Value::Null);
    let host = Arc::new(Host {
        backend: Arc::new(Mutex::new(None)),
        connection,
        paths,
        failure: Mutex::new(failure),
        quitting: Arc::new(AtomicU8::new(0)),
    });
    let setup_host = host.clone();
    let mut context = tauri::generate_context!();
    if let Some(instance) = host.connection["instanceId"].as_str() {
        context.config_mut().identifier.push('.');
        context.config_mut().identifier.push_str(instance);
    }
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol("gallery-font", desktop::font_resource)
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("manager")
                && let Err(error) = window.show().and_then(|_| window.set_focus())
            {
                eprintln!("{error}");
            }
        }))
        .manage(host.clone())
        .invoke_handler(tauri::generate_handler![commands::host_call])
        .setup(move |app| {
            // Plugins reject duplicate windows before any Go session is started.
            let can_start = setup_host
                .failure
                .lock()
                .map_err(|_| "HOST_SESSION_ENDED")?
                .is_none();
            if can_start {
                match Backend::start(&setup_host.paths, setup_host.connection.clone()) {
                    Ok(backend) => {
                        *setup_host
                            .backend
                            .lock()
                            .map_err(|_| "HOST_SESSION_ENDED")? = Some(backend)
                    }
                    Err(error) => {
                        *setup_host
                            .failure
                            .lock()
                            .map_err(|_| "HOST_SESSION_ENDED")? = Some(error)
                    }
                }
            }
            let mut builder =
                WebviewWindowBuilder::new(app, "manager", WebviewUrl::App("index.html".into()))
                    .title("画廊管理器")
                    .inner_size(1280., 800.)
                    .min_inner_size(960., 640.)
                    .visible(false)
                    .focused(!desktop::validation_no_activate())
                    .on_navigation(local_document);
            if let Some(data) = setup_host.connection["desktopDataRoot"].as_str() {
                builder = builder.data_directory(PathBuf::from(data).join("webview"));
            }
            let window = builder.build()?;
            desktop::tray(app)?;
            let ready = setup_host
                .backend
                .lock()
                .map_err(|_| "HOST_SESSION_ENDED")?
                .is_some();
            if ready && let Err(e) = native_method(&setup_host, "start", json!({})) {
                eprintln!("{e}");
            }
            if let Err(error) = desktop::refresh(app.handle()) {
                eprintln!("{error}");
            }
            desktop::present(&window)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(e) = window.hide() {
                    eprintln!("{e}");
                }
            }
        })
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("无法创建管理窗口：{error}");
            std::process::exit(1);
        }
    };
    app.run(move |app, event| {
        if let RunEvent::ExitRequested { api, .. } = event
            && host.quitting.load(Ordering::SeqCst) != 2
        {
            api.prevent_exit();
            if host
                .quitting
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return;
            }
            let host = host.clone();
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let result = host
                    .backend
                    .lock()
                    .map_err(|_| "HOST_SESSION_ENDED".to_string())
                    .and_then(|mut guard| guard.as_mut().map_or(Ok(()), |b| b.shutdown()));
                let code = if let Err(error) = result {
                    eprintln!("{error}");
                    1
                } else {
                    0
                };
                host.quitting.store(2, Ordering::SeqCst);
                app.exit(code);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_only_allows_manager_document() {
        for s in [
            "https://example.com/",
            "http://localhost:18277/",
            "http://tauri.localhost/other.html",
            "file:///index.html",
        ] {
            assert!(!local_document(&tauri::Url::parse(s).unwrap()));
        }
        assert!(local_document(
            &tauri::Url::parse("http://tauri.localhost/index.html#settings").unwrap()
        ));
    }
}
