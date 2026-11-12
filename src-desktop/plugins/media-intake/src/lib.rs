//! Images arriving from outside the WebView: the system clipboard (Android
//! and iOS) and, on Android, the `ACTION_SEND`/`ACTION_SEND_MULTIPLE` image
//! share target. Both hand the web layer the same untrusted payload,
//! `{ files: [{ name, mimeType, dataUrl }] }`, bounded by the chat-attachment
//! contract and validated again in `src-ui/src/platform/native/share-image.ts`.
//!
//! There are no Rust command handlers. On mobile, Tauri forwards an unhandled
//! `plugin:station-media-intake|<command>` invoke to the native plugin after
//! the ACL check, so the permissions generated from `build.rs` still gate
//! every call. On desktop the plugin is not registered.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_station_media_intake);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("station-media-intake")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("io.kontourai.station.mediaintake", "MediaIntakePlugin")?;
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_station_media_intake)?;
            Ok(())
        })
        .build()
}
