//! Compile-only proof that stable Tauri can create an independent preview window.
//! This has no Station command handler, plugin, capability grant, or production import.

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "preview-window",
                tauri::WebviewUrl::External("https://example.com".parse()?),
            )
            .title("Station browser-host experiment")
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Tauri separate-window experiment");
}
