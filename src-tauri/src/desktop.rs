use crate::commands::{Host, native_method};
use serde_json::json;
use std::sync::Arc;
use tauri::Manager;

pub(crate) fn font_resource(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let relative = request.uri().path().trim_start_matches('/');
    let host = context.app_handle().state::<Arc<Host>>();
    font_response(&host.paths.assets, relative)
}

fn font_response(root: &std::path::Path, relative: &str) -> tauri::http::Response<Vec<u8>> {
    let result = if relative.starts_with("misans-cdn/") {
        crate::backend::resource(root, relative)
    } else {
        Err("RESOURCE_FORBIDDEN".into())
    };
    let (bytes, status) = match result {
        Ok(bytes) => (bytes, tauri::http::StatusCode::OK),
        Err(error) => {
            eprintln!("font resource {relative}: {error}");
            (Vec::new(), tauri::http::StatusCode::NOT_FOUND)
        }
    };
    let mut response = tauri::http::Response::new(bytes);
    *response.status_mut() = status;
    let mime = if relative.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        "font/woff2"
    };
    response
        .headers_mut()
        .insert("Content-Type", tauri::http::HeaderValue::from_static(mime));
    response.headers_mut().insert(
        "Access-Control-Allow-Origin",
        tauri::http::HeaderValue::from_static("*"),
    );
    response.headers_mut().insert(
        "Cross-Origin-Resource-Policy",
        tauri::http::HeaderValue::from_static("cross-origin"),
    );
    response
}
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

pub(crate) fn validation_no_activate() -> bool {
    cfg!(debug_assertions)
        && std::env::var_os("GALLERY_VALIDATION_NO_ACTIVATE").as_deref()
            == Some(std::ffi::OsStr::new("1"))
}

pub(crate) fn present(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    #[cfg(windows)]
    if validation_no_activate() {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn ShowWindow(hwnd: isize, command: i32) -> i32;
        }
        // SW_SHOWNOACTIVATE: CDP verification must not take the user's foreground.
        unsafe {
            ShowWindow(window.hwnd()?.0 as isize, 4);
        }
        return Ok(());
    }
    window.show()
}

pub(crate) fn tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    for (id, label) in [
        ("show", "管理器"),
        ("gallery", "打开画廊"),
        ("start", "启动画廊"),
        ("stop", "停止画廊"),
        ("restart", "重启画廊"),
    ] {
        menu.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, label) in [
        ("config", "配置目录"),
        ("instance", "程序数据目录"),
        ("logs", "日志目录"),
        ("reports", "报告目录"),
        ("cache", "缓存目录"),
        ("about", "关于画廊"),
        ("quit", "退出"),
    ] {
        menu.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
    }
    let icon = tauri::image::Image::from_bytes(include_bytes!(env!("GALLERY_TRAY_ICON")))?;
    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("画廊")
        .menu(&menu)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                tauri::tray::TrayIconEvent::DoubleClick {
                    button: tauri::tray::MouseButton::Left,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "show" => show(app),
                "quit" => app.exit(0),
                "about" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let version = app.package_info().version.to_string();
                        rfd::MessageDialog::new()
                            .set_title("关于画廊")
                            .set_description(format!(
                                "画廊 {version}\n字体：MiSans\nAGPL-3.0-or-later"
                            ))
                            .show();
                    });
                }
                _ => {
                    let (method, input) = match id {
                        "gallery" => ("openGallery".to_owned(), json!({})),
                        "start" | "stop" | "restart" => (id.to_owned(), json!({})),
                        "config" | "instance" | "logs" | "reports" | "cache" => {
                            ("openDirectory".to_owned(), json!({"kind":id}))
                        }
                        _ => return,
                    };
                    let host = app.state::<Arc<Host>>().inner().clone();
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(error) = native_method(&host, &method, input) {
                            eprintln!("{error}");
                        }
                        if let Err(error) = refresh(&app) {
                            eprintln!("{error}");
                        }
                    });
                }
            }
        })
        .build(app)?;
    // Handles are retained by Tauri's resource table and shared with command updates.
    app.manage(menu);
    Ok(())
}

pub(crate) fn refresh(app: &tauri::AppHandle) -> Result<(), String> {
    let host = app.state::<Arc<Host>>();
    let status = native_method(&host, "status", json!({}))?;
    let active = matches!(
        status["state"].as_str(),
        Some("READY" | "READY_LIVE" | "STARTING")
    );
    let available = status["hostFailure"].as_str().is_none();
    if let Some(menu) = app.try_state::<Menu<tauri::Wry>>() {
        for (id, enabled) in [
            ("start", !active && available),
            ("stop", active),
            ("restart", active),
            ("gallery", active),
        ] {
            if let Some(tauri::menu::MenuItemKind::MenuItem(item)) = menu.get(&id.to_owned()) {
                item.set_enabled(enabled)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("manager")
        && let Err(error) = window.show().and_then(|_| window.set_focus())
    {
        eprintln!("{error}");
    }
}
