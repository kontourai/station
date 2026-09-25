//! Native agent-activity notifications: an ongoing card, promoted to an
//! Android 16 Live Update chip while work is running, plus attention alerts.
//!
//! Rendering and push receipt live entirely in the Kotlin plugin
//! (`android/`). Push delivery wakes the process through a
//! `FirebaseMessagingService`, which must not depend on the WebView or on
//! Rust — see docs/design/notification-delivery.md for why every
//! keep-the-process-alive approach failed here.
//!
//! There are no Rust command handlers. On mobile, Tauri forwards an
//! unhandled `plugin:station-agent-activity|<command>` invoke to the native
//! plugin after the ACL check, so the permissions generated from `build.rs`
//! still gate every call. On desktop the plugin is not registered.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.kontourai.station.agentactivity";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("station-agent-activity")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(PLUGIN_IDENTIFIER, "AgentActivityPlugin")?;
            Ok(())
        })
        .build()
}
