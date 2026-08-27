//! Compile-only proof of Tauri's unstable desktop child-webview API.
//! It is intentionally isolated: do not add the `unstable` feature to Station.

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let main = app
                .get_webview_window("main")
                .expect("main experiment window must exist");
            main.as_ref().window().add_child(
                tauri::WebviewBuilder::new(
                    "preview-child",
                    tauri::WebviewUrl::External("https://example.com".parse()?),
                ),
                tauri::LogicalPosition::new(24, 24),
                tauri::LogicalSize::new(480, 320),
            )?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Tauri child-webview experiment");
}
