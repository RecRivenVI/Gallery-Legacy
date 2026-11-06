fn main() {
    println!("cargo:rerun-if-env-changed=GALLERY_ICON");
    println!("cargo:rerun-if-env-changed=GALLERY_TRAY_ICON");
    let icon = std::env::var("GALLERY_ICON")
        .expect("Set GALLERY_ICON to the generated external Windows icon");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new().window_icon_path(icon)),
    )
    .expect("Tauri resource build failed");
}
