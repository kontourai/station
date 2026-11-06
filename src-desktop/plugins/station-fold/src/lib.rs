//! Hinge geometry for foldable iPhones (iOS 27.1+).
//!
//! There are no Rust command handlers. On iOS, Tauri forwards
//! `plugin:station-fold|state` to the Swift plugin after the ACL check, and the
//! plugin's `change` event is a nudge to read `state` again. Elsewhere the
//! plugin is not registered; the WebView falls back to the CSS Viewport
//! Segments API where the engine has one (`src-ui/src/platform/fold`).
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_station_fold);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("station-fold")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_station_fold)?;
            Ok(())
        })
        .build()
}
